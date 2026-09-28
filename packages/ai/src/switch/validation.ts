import { BlockList, isIP } from "node:net";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { invalid, SwitchError } from "./error";
import { roundOperatorAmount } from "./windows";
import type { Adjustment, AdjustmentPreviewRequest, Budget, Gate, ImportApplyRequest, ImportRequest, Issue, MintKeyRequest, PatchKeyRequest, Scope } from "./wire";

export const KEY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DIAL_NAMES = ["effort", "temp", "top_p", "top_k", "min_p", "max_tokens", "budget", "verbosity", "tier"] as const;
const UNITS = ["requests", "tokens", "usd", "plan_pct"];
const POLICIES = ["hard", "soft", "burst"];

export class Fields {
	readonly issues: Issue[] = [];

	issue(path: string, message: string, code = "validation"): void {
		this.issues.push({ code, path, message });
	}

	object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			this.issue(path, "Expected an object");
			return {};
		}
		const row = value as Record<string, unknown>;
		for (const field of Object.keys(row).sort()) {
			if (!allowed.includes(field)) this.issue(`${path}.${field}`, "Unknown field");
		}
		return row;
	}

	string(value: unknown, path: string, optional = false): value is string {
		if (value === undefined && optional) return false;
		if (typeof value !== "string" || value.length === 0) {
			this.issue(path, "Expected a non-empty string");
			return false;
		}
		return true;
	}

	number(value: unknown, path: string, options: { optional?: boolean; min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean } = {}): value is number {
		if (value === undefined && options.optional) return false;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			this.issue(path, "Expected a finite number");
			return false;
		}
		if (options.integer && !Number.isInteger(value)) this.issue(path, "Expected an integer");
		if (options.min !== undefined && (options.exclusiveMin ? value <= options.min : value < options.min)) this.issue(path, "Number is below the permitted range");
		if (options.max !== undefined && value > options.max) this.issue(path, "Number is above the permitted range");
		return true;
	}

	boolean(value: unknown, path: string, optional = false): void {
		if (value === undefined && optional) return;
		if (typeof value !== "boolean") this.issue(path, "Expected a boolean");
	}

	oneOf(value: unknown, path: string, values: readonly string[], optional = false): void {
		if (value === undefined && optional) return;
		if (typeof value !== "string" || !values.includes(value)) this.issue(path, "Value is not in the supported set");
	}

	array(value: unknown, path: string, optional = false): unknown[] {
		if (value === undefined && optional) return [];
		if (!Array.isArray(value)) {
			this.issue(path, "Expected an array");
			return [];
		}
		return value;
	}

	strings(value: unknown, path: string, optional = false): string[] {
		const rows = this.array(value, path, optional);
		const result: string[] = [];
		for (const [i, item] of rows.entries()) {
			if (this.string(item, `${path}[${i}]`)) result.push(item);
		}
		if (new Set(result).size !== result.length) this.issue(path, "Duplicate entries are not allowed");
		return result;
	}

	name(value: unknown, path: string): void {
		if (this.string(value, path) && !KEY_NAME.test(value)) this.issue(path, "Expected a lowercase domain identifier of at most 64 characters");
	}

	thresholds(value: unknown, path: string, optional = false): void {
		for (const [i, item] of this.array(value, path, optional).entries()) this.number(item, `${path}[${i}]`, { min: 0, max: 100 });
	}

	reason(value: unknown, path: string): void {
		if (value === undefined) return;
		if (typeof value !== "string" || [...value].length > 512) this.issue(path, "Expected plain text of at most 512 code points");
	}

	finish(): void {
		if (this.issues.length) invalid(this.issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
	}
}

export function validateCidr(value: string): boolean {
	const [address, bits, extra] = value.split("/");
	const family = isIP(address);
	if (!family || extra !== undefined || bits === undefined || !/^\d+$/.test(bits)) return false;
	const width = Number(bits);
	if (width > (family === 4 ? 32 : 128)) return false;
	try {
		new BlockList().addSubnet(address, width, family === 4 ? "ipv4" : "ipv6");
		return true;
	} catch {
		return false;
	}
}

export function checkScope(fields: Fields, value: unknown, path: string): void {
	const row = fields.object(value, path, ["network", "endpoints", "models", "dials"]);
	for (const [i, cidr] of fields.strings(row.network, `${path}.network`).entries()) {
		if (!validateCidr(cidr)) fields.issue(`${path}.network[${i}]`, "Expected an IPv4 or IPv6 CIDR");
	}
	fields.strings(row.endpoints, `${path}.endpoints`);
	fields.strings(row.models, `${path}.models`);
	const dials = fields.object(row.dials, `${path}.dials`, ["effort_max", "allow"]);
	fields.oneOf(dials.effort_max, `${path}.dials.effort_max`, THINKING_EFFORTS, true);
	for (const [i, dial] of fields.strings(dials.allow, `${path}.dials.allow`, true).entries()) fields.oneOf(dial, `${path}.dials.allow[${i}]`, DIAL_NAMES);
}

export function checkGate(fields: Fields, value: unknown, path: string): void {
	const row = fields.object(value, path, ["meter", "ceiling", "reserve", "warnAt"]);
	fields.string(row.meter, `${path}.meter`);
	if (row.ceiling === undefined && row.reserve === undefined) fields.issue(path, "A Gate requires a ceiling or reserve");
	fields.number(row.ceiling, `${path}.ceiling`, { optional: true, min: 0, exclusiveMin: true, max: 100 });
	fields.number(row.reserve, `${path}.reserve`, { optional: true, min: 0, max: 100 });
	if (row.reserve === 100) fields.issue(`${path}.reserve`, "Reserve must be less than 100");
	fields.thresholds(row.warnAt, `${path}.warnAt`, true);
}

export function checkBudget(fields: Fields, value: unknown, path: string): void {
	const row = fields.object(value, path, ["id", "unit", "cap", "window", "scope", "policy", "burstBelow", "warnAt"]);
	fields.name(row.id, `${path}.id`);
	fields.oneOf(row.unit, `${path}.unit`, UNITS);
	fields.number(row.cap, `${path}.cap`, { min: 0, exclusiveMin: true });
	fields.oneOf(row.policy, `${path}.policy`, POLICIES);
	fields.number(row.burstBelow, `${path}.burstBelow`, { optional: row.policy !== "burst", min: 0, exclusiveMin: true, max: 100 });
	fields.thresholds(row.warnAt, `${path}.warnAt`);
	const scope = fields.object(row.scope, `${path}.scope`, ["plan", "meter", "provider", "models"]);
	fields.string(scope.plan, `${path}.scope.plan`, true);
	fields.string(scope.meter, `${path}.scope.meter`, true);
	fields.string(scope.provider, `${path}.scope.provider`, true);
	fields.strings(scope.models, `${path}.scope.models`, true);
	if (scope.meter !== undefined && scope.plan === undefined) fields.issue(`${path}.scope.meter`, "A Meter scope requires a Plan", "budget_scope");
	const windowRecord = value && typeof value === "object" ? (value as Record<string, unknown>).window : undefined;
	const kind = windowRecord && typeof windowRecord === "object" ? (windowRecord as Record<string, unknown>).kind : undefined;
	const window = fields.object(windowRecord, `${path}.window`, kind === "plan" ? ["kind", "meter"] : kind === "calendar" ? ["kind", "period"] : ["kind", "ms"]);
	fields.oneOf(window.kind, `${path}.window.kind`, ["plan", "rolling", "anchored", "calendar"]);
	if (window.kind === "plan") {
		fields.string(window.meter, `${path}.window.meter`);
		if (scope.plan === undefined) fields.issue(`${path}.scope.plan`, "A plan window requires a Plan", "budget_scope");
		if (scope.meter !== undefined && scope.meter !== window.meter) fields.issue(`${path}.scope.meter`, "Scope and window Meters must agree", "budget_scope");
	} else if (window.kind === "calendar") {
		fields.oneOf(window.period, `${path}.window.period`, ["day", "week", "month"]);
	} else if (window.kind === "rolling" || window.kind === "anchored") {
		fields.number(window.ms, `${path}.window.ms`, { min: 0, exclusiveMin: true, integer: true });
		if (typeof window.ms === "number" && window.ms % 60_000 !== 0) fields.issue(`${path}.window.ms`, "Window duration must be a whole number of minutes");
	}
	if (row.unit === "plan_pct" && (scope.plan === undefined || (scope.meter === undefined && window.kind !== "plan"))) fields.issue(`${path}.scope`, "Percentage points require a Plan and Meter", "budget_scope");
	if (row.policy === "burst" && (scope.plan === undefined || (scope.meter === undefined && window.kind !== "plan"))) fields.issue(`${path}.policy`, "Burst requires a Plan and a Meter", "budget_scope");
}

export function parseScope(value: unknown): Scope {
	const fields = new Fields();
	checkScope(fields, value, "scope");
	fields.finish();
	return value as Scope;
}
export function parseBudget(value: unknown): Budget {
	const fields = new Fields();
	checkBudget(fields, value, "budget");
	fields.finish();
	const budget = value as Budget;
	const cap = roundOperatorAmount(budget.cap, budget.unit);
	if (!Number.isFinite(cap) || cap <= 0) invalid([{ code: "validation", path: "budget.cap", message: "Rounded cap must be finite and positive" }]);
	return cap === budget.cap ? budget : { ...budget, cap };
}
export function parseGate(value: unknown): Gate {
	const fields = new Fields();
	checkGate(fields, value, "gate");
	fields.finish();
	return value as Gate;
}

const OP_FIELDS: Record<Adjustment["op"], string[]> = {
	"plan.add": ["plan", "gates", "position"],
	"plan.remove": ["plan"],
	"plan.reorder": ["plans"],
	"gate.set": ["plan", "meter", "ceiling", "reserve", "warnAt"],
	"gate.raise": ["plan", "meter", "by"],
	"gate.remove": ["plan", "meter"],
	"budget.add": ["budget"],
	"budget.remove": ["budget"],
	"budget.set": ["budget", "cap", "policy", "burstBelow", "warnAt"],
	"budget.raise": ["budget", "by"],
	"budget.scale": ["budget", "percent"],
	"budget.suspend": ["budget", "until", "reason"],
	"grant.add": ["budget", "until", "reason", "amount", "percent_of_cap", "percent_of_plan_remaining", "to_remaining_percent"],
	"grant.revoke": ["grant"],
	transfer: ["from", "to", "budget", "amount", "until", "reason"],
};

function checkAdjustment(fields: Fields, value: unknown, path: string): void {
	const op = value && typeof value === "object" ? (value as Record<string, unknown>).op : undefined;
	if (typeof op !== "string" || !Object.hasOwn(OP_FIELDS, op)) {
		fields.issue(`${path}.op`, "Unknown adjustment operation");
		return;
	}
	const row = fields.object(value, path, ["op", ...OP_FIELDS[op as Adjustment["op"]]]);
	for (const name of ["plan", "meter", "budget", "grant", "from", "to", "until"]) {
		if (OP_FIELDS[op as Adjustment["op"]].includes(name) && !(op === "budget.add" && name === "budget")) fields.string(row[name], `${path}.${name}`);
	}
	fields.reason(row.reason, `${path}.reason`);
	if (op === "budget.add") checkBudget(fields, row.budget, `${path}.budget`);
	if (op === "plan.add") {
		fields.number(row.position, `${path}.position`, { optional: true, min: 0, integer: true });
		for (const [i, gate] of fields.array(row.gates, `${path}.gates`).entries()) checkGate(fields, gate, `${path}.gates[${i}]`);
	}
	if (op === "plan.reorder") fields.strings(row.plans, `${path}.plans`);
	if (op === "gate.set") checkGate(fields, { meter: row.meter, ceiling: row.ceiling, reserve: row.reserve, warnAt: row.warnAt }, path);
	if (op === "budget.set") {
		if (row.cap === undefined && row.policy === undefined && row.burstBelow === undefined && row.warnAt === undefined) fields.issue(path, "Budget edit must change a supported field");
		fields.number(row.cap, `${path}.cap`, { optional: true, min: 0, exclusiveMin: true });
		fields.number(row.burstBelow, `${path}.burstBelow`, { optional: true, min: 0, exclusiveMin: true, max: 100 });
		fields.oneOf(row.policy, `${path}.policy`, POLICIES, true);
		fields.thresholds(row.warnAt, `${path}.warnAt`, true);
	}
	if (op === "budget.raise" || op === "gate.raise") fields.number(row.by, `${path}.by`);
	if (op === "budget.scale") fields.number(row.percent, `${path}.percent`);
	if (op === "grant.add") {
		const selectors = ["amount", "percent_of_cap", "percent_of_plan_remaining", "to_remaining_percent"].filter(field => row[field] !== undefined);
		if (selectors.length !== 1) fields.issue(path, "Grant requires exactly one amount selector");
		for (const field of selectors) fields.number(row[field], `${path}.${field}`, { min: 0, exclusiveMin: true });
	}
	if (op === "transfer") fields.number(row.amount, `${path}.amount`, { min: 0, exclusiveMin: true });
}

export function parseAdjustment(value: unknown): Adjustment {
	const fields = new Fields();
	checkAdjustment(fields, value, "adjustment");
	fields.finish();
	return value as Adjustment;
}

export function parsePreviewRequest(value: unknown): AdjustmentPreviewRequest {
	const fields = new Fields();
	const mode = value && typeof value === "object" ? (value as Record<string, unknown>).mode : undefined;
	const row = fields.object(value, "preview", mode === "operation" ? ["mode", "adjustment"] : ["mode", "subject", "number", "duration", "donor", "newBudget"]);
	fields.oneOf(mode, "preview.mode", ["operation", "number"]);
	if (mode === "operation") checkAdjustment(fields, row.adjustment, "preview.adjustment");
	if (mode === "number") {
		fields.number(row.number, "preview.number");
		const subject = fields.object(row.subject, "preview.subject", ["budget", "plan", "meter"]);
		if (subject.budget !== undefined) {
			fields.string(subject.budget, "preview.subject.budget");
			if (subject.plan !== undefined || subject.meter !== undefined) fields.issue("preview.subject", "Choose a Budget or a Plan/Meter, not both");
		} else {
			fields.string(subject.plan, "preview.subject.plan");
			fields.string(subject.meter, "preview.subject.meter");
		}
		fields.string(row.duration, "preview.duration", true);
		fields.string(row.donor, "preview.donor", true);
		if (row.newBudget !== undefined) checkBudget(fields, row.newBudget, "preview.newBudget");
	}
	fields.finish();
	return value as AdjustmentPreviewRequest;
}

export function parseMintRequest(value: unknown): MintKeyRequest {
	const fields = new Fields();
	const row = fields.object(value, "key", ["name", "note", "expires_at", "sealed", "from_key", "scope", "plans", "budgets", "sourceEtag"]);
	fields.name(row.name, "key.name");
	if (row.note !== undefined && typeof row.note !== "string") fields.issue("key.note", "Expected text");
	fields.number(row.expires_at, "key.expires_at", { optional: true, min: 0 });
	fields.boolean(row.sealed, "key.sealed", true);
	fields.string(row.from_key, "key.from_key", true);
	fields.string(row.sourceEtag, "key.sourceEtag", true);
	const scope = row.scope && typeof row.scope === "object" && !Array.isArray(row.scope)
		? { network: ["0.0.0.0/0", "::/0"], endpoints: ["*"], dials: {}, ...row.scope } : row.scope;
	checkScope(fields, scope, "key.scope");
	for (const [i, item] of fields.array(row.plans, "key.plans", true).entries()) {
		const entry = fields.object(item, `key.plans[${i}]`, ["plan", "gates"]);
		fields.string(entry.plan, `key.plans[${i}].plan`);
		for (const [j, gate] of fields.array(entry.gates, `key.plans[${i}].gates`).entries()) checkGate(fields, gate, `key.plans[${i}].gates[${j}]`);
	}
	for (const [i, budget] of fields.array(row.budgets, "key.budgets", true).entries()) checkBudget(fields, budget, `key.budgets[${i}]`);
	fields.finish();
	return { ...value as MintKeyRequest, scope: scope as Scope };
}

export function parsePatchRequest(value: unknown): PatchKeyRequest {
	const fields = new Fields();
	const row = fields.object(value, "key", ["enabled", "note", "expires_at", "scope", "plan_order"]);
	if (Object.keys(row).length === 0) fields.issue("key", "An empty patch is not an operation");
	fields.boolean(row.enabled, "key.enabled", true);
	if (row.note !== undefined && row.note !== null && typeof row.note !== "string") fields.issue("key.note", "Expected text or null");
	if (row.expires_at !== null) fields.number(row.expires_at, "key.expires_at", { optional: true, min: 0 });
	if (row.scope !== undefined) checkScope(fields, row.scope, "key.scope");
	fields.oneOf(row.plan_order, "key.plan_order", ["priority", "headroom"], true);
	fields.finish();
	return value as PatchKeyRequest;
}

export function parseImportRequest(value: unknown, apply: true): ImportApplyRequest;
export function parseImportRequest(value: unknown, apply?: false): ImportRequest;
export function parseImportRequest(value: unknown, apply = false): ImportRequest | ImportApplyRequest {
	const fields = new Fields();
	const row = fields.object(value, "import", apply ? ["format", "content", "mode", "preview"] : ["format", "content", "mode"]);
	fields.oneOf(row.format, "import.format", ["toml"]);
	if (typeof row.content !== "string") fields.issue("import.content", "Expected TOML text");
	fields.oneOf(row.mode, "import.mode", ["merge", "replace"]);
	if (apply) fields.string(row.preview, "import.preview");
	fields.finish();
	return value as ImportRequest | ImportApplyRequest;
}

export async function readJsonBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") {
		throw new SwitchError(415, "unsupported_media_type", "Content-Type must be application/json");
	}
	try {
		return await request.json();
	} catch {
		invalid([{ code: "validation", path: "body", message: "Malformed JSON" }]);
	}
}
