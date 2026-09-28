import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { tokenDigest, valueHash } from "./crypto";
import { SwitchError } from "./error";
import type { KeyRecord, KeyTokenRecord } from "./internal";
import { parseKeyDocument, type PolicyKey } from "./keys-toml";
import { keyPolicy, type PolicyContext, removeGroup, unwindUnsupportedTransfers, validateAllocations } from "./policy";
import type { ImportChange, ImportRequest, Issue, JsonValue } from "./wire";

export interface ImportCredential {
	name: string;
	generate: boolean;
	token?: string;
	digest?: string;
}
export interface ImportEffect {
	keys: Map<string, KeyRecord>;
	credentials: ImportCredential[];
	changes: Omit<ImportChange, "before" | "after">[];
	issues: Issue[];
	contentHash: string;
	effect: JsonValue;
}

function tokenShape(rows: readonly KeyTokenRecord[]): string {
	return valueHash(rows.map(row => ({ digest: row.digest, current: row.current, validUntil: row.validUntil ?? null, revealable: row.plaintext !== undefined })).sort((a, b) => a.digest.localeCompare(b.digest)));
}

/** The entire removal closure is computed before any requested addition/cap change. */
export function prepareImport(context: PolicyContext, tokens: ReadonlyMap<string, KeyTokenRecord>, request: ImportRequest): ImportEffect {
	const parsed = parseKeyDocument(request.content);
	const keys = new Map([...context.keys].map(([name, key]) => [name, structuredClone(key)]));
	const credentials: ImportCredential[] = [];
	const changes: ImportEffect["changes"] = [];
	const issues = parsed.issues;
	const contentHash = valueHash(parsed.keys);
	const failed = (): ImportEffect => ({ keys, credentials, changes, issues, contentHash, effect: null });
	if (issues.length) return failed();
	const source = new Map(parsed.keys.map(key => [key.name, key]));
	const removedGroups = new Set<string>();
	for (const incoming of parsed.keys) {
		const current = keys.get(incoming.name);
		if (!current) continue;
		if (current.revoked) { issues.push({ code: "name_taken", path: `key.${incoming.name}`, message: "A revoked Key name cannot be reused" }); continue; }
		const removed = new Set(current.budgets.filter(budget => {
			const replacement = incoming.budgets.find(row => row.id === budget.id);
			return !replacement || stableStringifyJson([budget.unit, budget.window, budget.scope]) !== stableStringifyJson([replacement.unit, replacement.window, replacement.scope]);
		}).map(budget => budget.id));
		for (const grant of current.grants) if (removed.has(grant.budget) && grant.transferGroup) removedGroups.add(grant.transferGroup);
		current.budgets = current.budgets.filter(budget => !removed.has(budget.id));
		current.grants = current.grants.filter(grant => !removed.has(grant.budget));
		for (const id of removed) delete current.suspensions[id];
	}
	if (issues.length) return failed();
	for (const group of removedGroups) removeGroup(keys, group);
	for (const group of unwindUnsupportedTransfers(keys, context.plans, context.allocationVersion)) removedGroups.add(group);

	const proposedTokens = new Map<string, KeyTokenRecord[]>();
	for (const name of keys.keys()) proposedTokens.set(name, [...tokens.values()].filter(token => token.key === name));
	for (const incoming of parsed.keys) {
		const current = keys.get(incoming.name);
		const key: KeyRecord = current ?? {
			name: incoming.name, rev: 0, enabled: true, revoked: false, sealed: incoming.sealed, createdAt: context.now, updatedAt: context.now,
			scope: incoming.scope, planOrder: incoming.planOrder, plans: [], budgets: [], grants: [], suspensions: {},
		};
		key.enabled = incoming.enabled; key.sealed = incoming.sealed; key.scope = incoming.scope;
		key.planOrder = incoming.planOrder; key.plans = incoming.plans; key.budgets = incoming.budgets;
		if (incoming.note !== undefined) key.note = incoming.note; else delete key.note;
		if (incoming.expiresAt !== undefined) key.expiresAt = incoming.expiresAt; else delete key.expiresAt;
		for (const budget of key.budgets) if (key.suspensions[budget.id]) key.suspensions[budget.id].previousPolicy = budget.policy;
		keys.set(key.name, key);
		const oldTokens = proposedTokens.get(key.name) ?? [];
		if (incoming.token !== undefined || incoming.digest !== undefined) {
			const replacement: KeyTokenRecord = {
				key: key.name, current: true, digest: incoming.token !== undefined ? tokenDigest(incoming.token) : incoming.digest!,
				...(!key.sealed && incoming.token !== undefined ? { plaintext: incoming.token } : {}),
			};
			if (tokenShape(oldTokens) !== tokenShape([replacement])) {
				credentials.push({ name: key.name, generate: false, ...(incoming.token !== undefined ? { token: incoming.token } : {}), ...(incoming.digest !== undefined ? { digest: incoming.digest } : {}) });
				delete key.rotationGraceUntil;
			}
			proposedTokens.set(key.name, [replacement]);
		} else if (!current) {
			credentials.push({ name: key.name, generate: true });
			proposedTokens.set(key.name, []);
		} else if (!key.sealed && !oldTokens.find(row => row.current)?.plaintext) {
			issues.push({ code: "sealed", path: `key.${key.name}.sealed`, message: "Unsealing requires an explicit replacement token; the old plaintext is unavailable" });
		}
		try { context.validateKey(key); }
		catch (error) {
			if (!(error instanceof SwitchError)) throw error;
			issues.push(...(error.detail?.issues ?? [{ code: error.code, path: `key.${key.name}`, message: error.message }]));
		}
	}
	if (request.mode === "replace") {
		for (const key of keys.values()) if (!source.has(key.name) && !key.revoked) {
			key.enabled = false; key.revoked = true; delete key.rotationGraceUntil;
			proposedTokens.set(key.name, []);
		}
	}
	const owners = new Map<string, string>();
	for (const [name, rows] of proposedTokens) for (const row of rows) {
		const existing = owners.get(row.digest);
		if (existing && existing !== name) issues.push({ code: "validation", path: `key.${name}.token`, message: `Credential is already assigned to Key ${existing}` });
		owners.set(row.digest, name);
	}
	if (issues.length) return failed();
	// No unwind is allowed to rescue the following operator-requested capacity/addition changes.
	const allocations = validateAllocations(keys, context.plans, context.allocationVersion);
	for (const key of keys.values()) {
		const old = context.keys.get(key.name);
		const credentialChanged = credentials.some(row => row.name === key.name);
		if (!old || credentialChanged || valueHash(keyPolicy(old)) !== valueHash(keyPolicy(key))) changes.push({ name: key.name, operation: !old ? "create" : !old.revoked && key.revoked ? "revoke" : "update", credentialChanged });
	}
	changes.sort((a, b) => a.name.localeCompare(b.name));
	const effect: JsonValue = {
		keys: changes.map(change => ({ policy: keyPolicy(keys.get(change.name)!), credentialChanged: change.credentialChanged, operation: change.operation })),
		allocations: JSON.parse(stableStringifyJson(allocations.allocations.map(({ version: _version, ...row }) => row))) as JsonValue,
		removedGroups: [...removedGroups].sort(),
	};
	return { keys, credentials, changes, issues, contentHash, effect };
}

export function exportPolicy(key: KeyRecord): PolicyKey {
	return {
		name: key.name, enabled: key.enabled, sealed: key.sealed, scope: key.scope, planOrder: key.planOrder, plans: key.plans, budgets: key.budgets,
		...(key.note !== undefined ? { note: key.note } : {}), ...(key.expiresAt !== undefined ? { expiresAt: key.expiresAt } : {}),
	};
}
