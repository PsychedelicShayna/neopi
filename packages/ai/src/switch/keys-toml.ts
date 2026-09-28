import { SwitchError } from "./error";
import { checkBudget, checkGate, checkScope, Fields, parseBudget } from "./validation";
import type { Budget, Gate, Issue, PlanEntry, Scope } from "./wire";

export interface PolicyKey {
	name: string;
	enabled: boolean;
	note?: string;
	expiresAt?: number;
	sealed: boolean;
	scope: Scope;
	planOrder: "priority" | "headroom";
	plans: PlanEntry[];
	budgets: Budget[];
	token?: string;
	digest?: string;
}

function gateFromToml(fields: Fields, value: unknown, location: string): Gate {
	const row = fields.object(value, location, ["meter", "ceiling", "reserve", "warn_at"]);
	const gate = { meter: row.meter, ...(row.ceiling !== undefined ? { ceiling: row.ceiling } : {}), ...(row.reserve !== undefined ? { reserve: row.reserve } : {}), ...(row.warn_at !== undefined ? { warnAt: row.warn_at } : {}) };
	checkGate(fields, gate, location);
	return gate as Gate;
}

function budgetFromToml(fields: Fields, value: unknown, location: string): Budget {
	const row = fields.object(value, location, ["id", "unit", "cap", "window", "scope", "policy", "burst_below", "warn_at"]);
	const budget = {
		id: row.id, unit: row.unit, cap: row.cap, window: row.window, scope: row.scope, policy: row.policy,
		...(row.burst_below !== undefined ? { burstBelow: row.burst_below } : {}), warnAt: row.warn_at,
	};
	checkBudget(fields, budget, location);
	return budget as Budget;
}

export function validMintedToken(value: string): boolean {
	if (!/^mrn_[A-Za-z0-9_-]{43}$/.test(value)) return false;
	const bytes = Buffer.from(value.slice(4), "base64url");
	return bytes.length === 32 && bytes.toString("base64url") === value.slice(4);
}

/** Parsing never executes a reference, command or path from the imported document. */
export function parseKeyDocument(content: string): { keys: PolicyKey[]; issues: Issue[] } {
	let parsed: unknown;
	try { parsed = Bun.TOML.parse(content); }
	catch { return { keys: [], issues: [{ code: "validation", path: "content", message: "Malformed key policy TOML" }] }; }
	const fields = new Fields();
	const root = fields.object(parsed, "document", ["schema", "key"]);
	fields.number(root.schema, "schema", { min: 1, max: 1, integer: true });
	const names = new Set<string>();
	const keys: PolicyKey[] = [];
	for (const [index, value] of fields.array(root.key, "key", true).entries()) {
		const location = `key[${index}]`;
		const row = fields.object(value, location, ["name", "enabled", "note", "expires_at", "sealed", "scope", "plan_order", "plans", "budgets", "token", "digest"]);
		fields.name(row.name, `${location}.name`);
		if (typeof row.name === "string") {
			if (names.has(row.name)) fields.issue(`${location}.name`, "Duplicate Key name");
			names.add(row.name);
		}
		fields.boolean(row.enabled, `${location}.enabled`);
		fields.boolean(row.sealed, `${location}.sealed`);
		if (row.note !== undefined && typeof row.note !== "string") fields.issue(`${location}.note`, "Expected text");
		fields.number(row.expires_at, `${location}.expires_at`, { optional: true, min: 0 });
		fields.oneOf(row.plan_order, `${location}.plan_order`, ["priority", "headroom"]);
		checkScope(fields, row.scope, `${location}.scope`);
		const plans = fields.array(row.plans, `${location}.plans`).map((value, position) => {
			const planLocation = `${location}.plans[${position}]`;
			const plan = fields.object(value, planLocation, ["plan", "gates"]);
			fields.string(plan.plan, `${planLocation}.plan`);
			return { plan: plan.plan as string, gates: fields.array(plan.gates, `${planLocation}.gates`).map((gate, gateIndex) => gateFromToml(fields, gate, `${planLocation}.gates[${gateIndex}]`)) };
		});
		const budgets = fields.array(row.budgets, `${location}.budgets`).map((budget, position) => budgetFromToml(fields, budget, `${location}.budgets[${position}]`));
		if (row.token !== undefined && (typeof row.token !== "string" || !validMintedToken(row.token))) fields.issue(`${location}.token`, "Expected a minted-token shape");
		if (row.digest !== undefined && (typeof row.digest !== "string" || !/^sha256:[a-fA-F0-9]{64}$/.test(row.digest))) fields.issue(`${location}.digest`, "Expected a sha256 digest");
		if (row.token !== undefined && row.digest !== undefined) fields.issue(location, "Supply token or digest, not both");
		if (row.digest !== undefined && row.sealed === false) fields.issue(`${location}.sealed`, "A digest-only credential must be sealed");
		keys.push({
			name: row.name as string, enabled: row.enabled as boolean, sealed: row.sealed as boolean, scope: row.scope as Scope,
			planOrder: row.plan_order as PolicyKey["planOrder"], plans, budgets,
			...(row.note !== undefined ? { note: row.note as string } : {}), ...(row.expires_at !== undefined ? { expiresAt: row.expires_at as number } : {}),
			...(row.token !== undefined ? { token: row.token as string } : {}), ...(typeof row.digest === "string" ? { digest: row.digest.toLowerCase() } : {}),
		});
	}
	try { fields.finish(); }
	catch (error) {
		if (!(error instanceof SwitchError)) throw error;
		return { keys: [], issues: error.detail?.issues ?? [] };
	}
	for (const [index, key] of keys.entries()) {
		for (const [position, budget] of key.budgets.entries()) {
			try { key.budgets[position] = parseBudget(budget); }
			catch (error) {
				if (!(error instanceof SwitchError)) throw error;
				for (const issue of error.detail?.issues ?? []) fields.issue(`key[${index}].budgets[${position}].${issue.path}`, issue.message, issue.code);
			}
		}
	}
	return { keys: fields.issues.length ? [] : keys, issues: fields.issues };
}

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue | undefined };

function tomlValue(value: TomlValue): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Non-finite policy value cannot be exported");
		return String(value);
	}
	if (typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
	const fields: string[] = [];
	for (const [key, item] of Object.entries(value)) if (item !== undefined) fields.push(`${JSON.stringify(key)} = ${tomlValue(item)}`);
	return `{ ${fields.join(", ")} }`;
}

function gateToToml(gate: Gate): TomlValue {
	return { meter: gate.meter, ...(gate.ceiling !== undefined ? { ceiling: gate.ceiling } : {}), ...(gate.reserve !== undefined ? { reserve: gate.reserve } : {}), ...(gate.warnAt !== undefined ? { warn_at: gate.warnAt } : {}) };
}

/** Only this explicit projection is exported; grants, counters, grace and history never enter it. */
export function serializeKeyDocument(keys: readonly PolicyKey[]): string {
	const lines = ["schema = 1"];
	if (!keys.length) lines.push("key = []");
	for (const key of keys) {
		lines.push("", "[[key]]", `name = ${tomlValue(key.name)}`, `enabled = ${key.enabled}`, `sealed = ${key.sealed}`, `plan_order = ${tomlValue(key.planOrder)}`);
		if (key.note !== undefined) lines.push(`note = ${tomlValue(key.note)}`);
		if (key.expiresAt !== undefined) lines.push(`expires_at = ${tomlValue(key.expiresAt)}`);
		lines.push(`scope = ${tomlValue({ network: key.scope.network, endpoints: key.scope.endpoints, models: key.scope.models, dials: { ...key.scope.dials } })}`);
		lines.push(`plans = ${tomlValue(key.plans.map(plan => ({ plan: plan.plan, gates: plan.gates.map(gateToToml) })))}`);
		lines.push(`budgets = ${tomlValue(key.budgets.map(budget => ({
			id: budget.id, unit: budget.unit, cap: budget.cap, window: { ...budget.window }, scope: { ...budget.scope }, policy: budget.policy,
			...(budget.burstBelow !== undefined ? { burst_below: budget.burstBelow } : {}), warn_at: budget.warnAt,
		})))}`);
		if (key.token !== undefined) lines.push(`token = ${tomlValue(key.token)}`);
		if (key.digest !== undefined) lines.push(`digest = ${tomlValue(key.digest)}`);
	}
	return `${lines.join("\n")}\n`;
}
