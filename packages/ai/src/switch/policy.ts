import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { valueHash } from "./crypto";
import { notFound, SwitchError } from "./error";
import type { KeyRecord, MeterRecord, ResolvedPlan, StoredGrant } from "./internal";
import { parseBudget } from "./validation";
import { budgetKey, expiryDue, gateLimit, resolveExpiry, roundOperatorAmount } from "./windows";
import type { Adjustment, AllocationView, Budget, BudgetView, GrantExpiry, JsonValue, WindowInstanceView } from "./wire";

export interface PolicyContext {
	now: number;
	actor: string;
	generation: string;
	allocationVersion: number;
	keys: ReadonlyMap<string, KeyRecord>;
	plans: ReadonlyMap<string, ResolvedPlan>;
	budgetView(key: KeyRecord, budget: Budget, keys: ReadonlyMap<string, KeyRecord>): BudgetView;
	window(key: KeyRecord, budget: Budget): WindowInstanceView | undefined;
	meter(plan: string, meter: string): MeterRecord | undefined;
	validateKey(key: KeyRecord): void;
}

export interface AllocationState {
	allocations: AllocationView[];
	caps: Map<string, { norm: number; grants: number; capEff: number }>;
}

export interface PolicyEffect {
	keys: Map<string, KeyRecord>;
	changed: string[];
	adjustment: Adjustment;
	allocations: AllocationView[];
	effect: JsonValue;
	lifetime: { kind: "permanent" | "instant" | "instance"; expiresAt?: number; instanceId?: string };
	warnings: string[];
	dependencies: Record<string, string | number>;
}

function shareIdentity(budget: Budget, plans: ReadonlyMap<string, ResolvedPlan>): { plan: ResolvedPlan; meter: string } | undefined {
	if (budget.window.kind !== "plan" || !budget.scope.plan) return undefined;
	const plan = plans.get(budget.scope.plan);
	if (!plan) return undefined;
	if (budget.unit !== (plan.config.attribution === "tokens" ? "tokens" : "plan_pct")) return undefined;
	return { plan, meter: budget.window.meter };
}

export function computeAllocations(keys: ReadonlyMap<string, KeyRecord>, plans: ReadonlyMap<string, ResolvedPlan>, version: number): AllocationState {
	const caps: AllocationState["caps"] = new Map();
	const groups = new Map<string, { plan: ResolvedPlan; meter: string; entries: { key: KeyRecord; budget: Budget; grants: number }[] }>();
	for (const key of keys.values()) {
		for (const budget of key.budgets) {
			const grants = key.grants.filter(grant => grant.budget === budget.id).reduce((sum, grant) => sum + grant.amount, 0);
			caps.set(budgetKey(key.name, budget.id), { norm: 1, grants, capEff: budget.cap + grants });
			const identity = shareIdentity(budget, plans);
			if (!identity) continue;
			const id = JSON.stringify([identity.plan.config.id, identity.meter, budget.unit]);
			let group = groups.get(id);
			if (!group) {
				group = { ...identity, entries: [] };
				groups.set(id, group);
			}
			group.entries.push({ key, budget, grants });
		}
	}
	const allocations: AllocationView[] = [];
	for (const group of groups.values()) {
		const config = group.plan.config;
		const unit = config.attribution === "tokens" ? "tokens" : "plan_pct";
		const capacity = unit === "plan_pct" ? 100 : config.shareCapacity?.[group.meter];
		if (capacity === undefined && config.overcommit !== "allow") throw new SwitchError(422, "attribution_tokens", "Token normalization and denial require a declared sharing capacity");
		const baseSum = group.entries.reduce((sum, entry) => sum + entry.budget.cap, 0);
		const norm = config.overcommit === "normalize" && capacity !== undefined && baseSum > 0 ? Math.min(1, capacity / baseSum) : 1;
		const byKey = new Map<string, AllocationView["keys"][number]>();
		let effectiveSum = 0;
		for (const entry of group.entries) {
			const capEff = entry.budget.cap * norm + entry.grants;
			caps.set(budgetKey(entry.key.name, entry.budget.id), { norm, grants: entry.grants, capEff });
			effectiveSum += capEff;
			const row = byKey.get(entry.key.name) ?? { key: entry.key.name, baseCap: 0, norm, grants: 0, capEff: 0 };
			row.baseCap += entry.budget.cap;
			row.grants += entry.grants;
			row.capEff += capEff;
			byKey.set(row.key, row);
		}
		allocations.push({
			plan: config.id, meter: group.meter, unit, ...(capacity !== undefined ? { capacity } : {}),
			baseSum, effectiveSum, overcommit: capacity !== undefined && effectiveSum > capacity,
			mode: config.overcommit, version, keys: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
		});
	}
	allocations.sort((a, b) => a.plan.localeCompare(b.plan) || a.meter.localeCompare(b.meter));
	return { allocations, caps };
}

function invalidCaps(keys: ReadonlyMap<string, KeyRecord>, state: AllocationState): { key: string; budget: string; proposedCapEff: number; transferGroups: string[] }[] {
	const affected: { key: string; budget: string; proposedCapEff: number; transferGroups: string[] }[] = [];
	for (const key of keys.values()) {
		for (const budget of key.budgets) {
			const capEff = state.caps.get(budgetKey(key.name, budget.id))?.capEff ?? budget.cap;
			if (capEff < 0) affected.push({ key: key.name, budget: budget.id, proposedCapEff: capEff, transferGroups: key.grants.filter(grant => grant.budget === budget.id && grant.amount < 0 && grant.transferGroup).map(grant => grant.transferGroup!) });
		}
	}
	return affected.sort((a, b) => a.key.localeCompare(b.key) || a.budget.localeCompare(b.budget));
}

export function validateAllocations(keys: ReadonlyMap<string, KeyRecord>, plans: ReadonlyMap<string, ResolvedPlan>, version: number): AllocationState {
	const state = computeAllocations(keys, plans, version);
	const affected = invalidCaps(keys, state);
	if (affected.length) throw new SwitchError(409, "active_transfer_conflict", "The proposed allocation would leave an unsupported transfer debit", { affected, allocationVersion: version });
	for (const allocation of state.allocations) {
		if (allocation.mode === "deny" && allocation.capacity !== undefined && allocation.baseSum > allocation.capacity) throw new SwitchError(409, "overcommit", "Share base caps exceed the configured allocation capacity");
	}
	const groups = new Map<string, StoredGrant[]>();
	for (const key of keys.values()) {
		for (const grant of key.grants) {
			if (grant.transferGroup) {
				const group = groups.get(grant.transferGroup) ?? [];
				group.push(grant);
				groups.set(grant.transferGroup, group);
			} else if (grant.amount <= 0) throw new SwitchError(409, "active_transfer_conflict", "A negative Grant must belong to a complete transfer group");
		}
	}
	for (const grants of groups.values()) {
		if (grants.length !== 2 || grants[0].amount + grants[1].amount !== 0 || grants[0].key === grants[1].key || stableStringifyJson(grants[0].expiry) !== stableStringifyJson(grants[1].expiry)) throw new SwitchError(409, "active_transfer_conflict", "A transfer must retain both matching Grants and their common expiry");
	}
	return state;
}

function removeGroup(keys: Map<string, KeyRecord>, group: string): void {
	for (const key of keys.values()) key.grants = key.grants.filter(grant => grant.transferGroup !== group);
}

/** Whole-pair removal terminates because each pass removes an existing group. */
export function unwindUnsupportedTransfers(keys: Map<string, KeyRecord>, plans: ReadonlyMap<string, ResolvedPlan>, version: number): string[] {
	const removed: string[] = [];
	while (true) {
		const negative = invalidCaps(keys, computeAllocations(keys, plans, version));
		if (!negative.length) return removed;
		const candidates = negative.flatMap(row => keys.get(row.key)!.grants.filter(grant => grant.budget === row.budget && grant.amount < 0 && grant.transferGroup));
		candidates.sort((a, b) => a.createdAt - b.createdAt || a.transferGroup!.localeCompare(b.transferGroup!));
		const group = candidates[0]?.transferGroup;
		if (!group) throw new SwitchError(409, "active_transfer_conflict", "A negative effective cap has no removable transfer owner");
		removeGroup(keys, group);
		removed.push(group);
	}
}

export function keyPolicy(key: KeyRecord): JsonValue {
	return {
		name: key.name, enabled: key.enabled, revoked: key.revoked,
		expiresAt: key.expiresAt ?? null, note: key.note ?? null, sealed: key.sealed,
		scope: JSON.parse(stableStringifyJson(key.scope)) as JsonValue,
		planOrder: key.planOrder,
		plans: JSON.parse(stableStringifyJson(key.plans)) as JsonValue,
		budgets: JSON.parse(stableStringifyJson(key.budgets)) as JsonValue,
		grants: key.grants.map(({ createdAt: _createdAt, ...grant }) => JSON.parse(stableStringifyJson(grant)) as JsonValue),
		suspensions: JSON.parse(stableStringifyJson(key.suspensions)) as JsonValue,
	};
}

export function expirePolicies(context: PolicyContext): { keys: Map<string, KeyRecord>; changed: string[]; removedGroups: string[] } {
	const keys = new Map([...context.keys].map(([name, key]) => [name, structuredClone(key)]));
	const groups = new Set<string>();
	for (const key of keys.values()) {
		key.grants = key.grants.filter(grant => {
			const budget = key.budgets.find(candidate => candidate.id === grant.budget);
			const due = !budget || expiryDue(grant.expiry, context.now, context.window(key, budget));
			if (due && grant.transferGroup) groups.add(grant.transferGroup);
			return !due;
		});
		for (const [id, suspension] of Object.entries(key.suspensions)) {
			const budget = key.budgets.find(candidate => candidate.id === id);
			if (!budget || expiryDue(suspension.expiry, context.now, context.window(key, budget))) delete key.suspensions[id];
		}
	}
	for (const group of groups) removeGroup(keys, group);
	const unwound = unwindUnsupportedTransfers(keys, context.plans, context.allocationVersion);
	const changed = [...keys.values()].filter(key => valueHash(keyPolicy(key)) !== valueHash(keyPolicy(context.keys.get(key.name)!))).map(key => key.name).sort();
	return { keys, changed, removedGroups: [...groups, ...unwound] };
}

export function applyAdjustmentDraft(context: PolicyContext, target: string, input: Adjustment): PolicyEffect {
	const original = context.keys.get(target);
	if (!original) notFound("Key");
	const keys = new Map([...context.keys].map(([name, key]) => [name, structuredClone(key)]));
	const key = keys.get(target)!;
	const adjustment = structuredClone(input);
	let canonicalAdjustment = adjustment;
	let lifetime: PolicyEffect["lifetime"] = { kind: "permanent" };
	const dependencies: PolicyEffect["dependencies"] = {};
	const warnings: string[] = [];
	const budget = (id: string, owner = key): Budget => owner.budgets.find(candidate => candidate.id === id) ?? notFound("Budget");
	const entry = (id: string) => key.plans.find(candidate => candidate.plan === id) ?? notFound("Key Plan");
	const plan = (id: string) => context.plans.get(id) ?? (() => { throw new SwitchError(422, "unknown_plan", "Plan is not configured"); })();
	const grantId = (suffix: string) => `g_${valueHash([context.actor, target, original.rev, canonicalAdjustment, suffix])}`;
	const expiry = (until: string, row: Budget, owner = key): GrantExpiry => {
		const instance = context.window(owner, row);
		const result = resolveExpiry(until, context.now, instance, row);
		if ("until" in adjustment) canonicalAdjustment = { ...adjustment, until: result.canonical };
		lifetime = result.expiry;
		if (result.expiry.kind === "instance") dependencies[`instance:${owner.name}:${row.id}`] = result.expiry.instanceId!;
		return result.expiry;
	};
	const newGrant = (owner: KeyRecord, row: Budget, amount: number, until: GrantExpiry, group?: string): void => {
		owner.grants.push({ id: grantId(owner.name), key: owner.name, budget: row.id, amount, actor: context.actor, createdAt: context.now, expiry: until, ...(group ? { transferGroup: group } : {}), ...("reason" in adjustment && adjustment.reason !== undefined ? { reason: adjustment.reason } : {}) });
	};
	let withdrawal = false;
	switch (adjustment.op) {
		case "plan.add": {
			plan(adjustment.plan);
			if (key.plans.some(row => row.plan === adjustment.plan)) throw new SwitchError(422, "validation", "Plan is already on this Key");
			const position = adjustment.position ?? key.plans.length;
			if (position > key.plans.length) throw new SwitchError(422, "validation", "Plan position is outside the current list");
			key.plans.splice(position, 0, { plan: adjustment.plan, gates: adjustment.gates });
			break;
		}
		case "plan.remove":
			entry(adjustment.plan);
			if (key.budgets.some(row => row.scope.plan === adjustment.plan)) throw new SwitchError(409, "plan_in_use", "Remove dependent Budgets before removing this Plan");
			key.plans = key.plans.filter(row => row.plan !== adjustment.plan);
			break;
		case "plan.reorder":
			if (adjustment.plans.length !== key.plans.length || adjustment.plans.some(id => !key.plans.some(row => row.plan === id))) throw new SwitchError(422, "validation", "Reorder must name each current Plan exactly once");
			key.plans = adjustment.plans.map(id => entry(id));
			break;
		case "gate.set": {
			const owner = entry(adjustment.plan);
			const { op: _op, plan: _plan, ...gate } = adjustment;
			const index = owner.gates.findIndex(row => row.meter === gate.meter);
			if (index < 0) owner.gates.push(gate); else owner.gates[index] = gate;
			break;
		}
		case "gate.raise": {
			const owner = entry(adjustment.plan);
			const index = owner.gates.findIndex(row => row.meter === adjustment.meter);
			if (index < 0) notFound("Gate");
			const old = owner.gates[index];
			const ceiling = Math.min(100, roundOperatorAmount(gateLimit(old) + adjustment.by, "plan_pct"));
			if (ceiling <= 0) throw new SwitchError(422, "gate_limit", "Gate limit must remain positive");
			owner.gates[index] = { meter: old.meter, ceiling, ...(old.warnAt ? { warnAt: old.warnAt } : {}) };
			break;
		}
		case "gate.remove": {
			const owner = entry(adjustment.plan);
			if (!owner.gates.some(row => row.meter === adjustment.meter)) notFound("Gate");
			owner.gates = owner.gates.filter(row => row.meter !== adjustment.meter);
			break;
		}
		case "budget.add":
			if (key.budgets.some(row => row.id === adjustment.budget.id)) throw new SwitchError(422, "validation", "Budget id already exists");
			key.budgets.push(parseBudget({ ...adjustment.budget, cap: roundOperatorAmount(adjustment.budget.cap, adjustment.budget.unit) }));
			break;
		case "budget.remove": {
			budget(adjustment.budget);
			const removed = key.grants.filter(grant => grant.budget === adjustment.budget);
			key.budgets = key.budgets.filter(row => row.id !== adjustment.budget);
			key.grants = key.grants.filter(grant => grant.budget !== adjustment.budget);
			delete key.suspensions[adjustment.budget];
			for (const grant of removed) if (grant.transferGroup) removeGroup(keys, grant.transferGroup);
			withdrawal = true;
			break;
		}
		case "budget.set": {
			const row = budget(adjustment.budget);
			const { op: _op, budget: _budget, ...patch } = adjustment;
			Object.assign(row, patch);
			if (patch.cap !== undefined) row.cap = roundOperatorAmount(patch.cap, row.unit);
			if (key.suspensions[row.id] && patch.policy) key.suspensions[row.id].previousPolicy = patch.policy;
			parseBudget(row);
			break;
		}
		case "budget.raise": {
			const row = budget(adjustment.budget);
			row.cap = roundOperatorAmount(row.cap + adjustment.by, row.unit);
			parseBudget(row);
			break;
		}
		case "budget.scale": {
			const row = budget(adjustment.budget);
			row.cap = roundOperatorAmount(row.cap * (1 + adjustment.percent / 100), row.unit);
			parseBudget(row);
			break;
		}
		case "budget.suspend": {
			const row = budget(adjustment.budget);
			const until = expiry(adjustment.until, row);
			key.suspensions[row.id] = { expiry: until, previousPolicy: row.policy, ...(adjustment.reason ? { reason: adjustment.reason } : {}) };
			break;
		}
		case "grant.add": {
			const row = budget(adjustment.budget);
			const view = context.budgetView(key, row, keys);
			const until = expiry(adjustment.until, row);
			let amount = adjustment.amount ?? 0;
			if (adjustment.percent_of_cap !== undefined) amount = row.cap * adjustment.percent_of_cap / 100;
			if (adjustment.to_remaining_percent !== undefined) {
				amount = Math.max(0, view.used + row.cap * adjustment.to_remaining_percent / 100 - view.capEff);
				dependencies[`accounting:${key.name}:${row.id}`] = view.accountingVersion;
			}
			if (adjustment.percent_of_plan_remaining !== undefined) {
				const meterId = row.scope.meter ?? (row.window.kind === "plan" ? row.window.meter : undefined);
				if (row.unit !== "plan_pct" || !row.scope.plan || !meterId) throw new SwitchError(422, "budget_scope", "Plan-remaining percentage requires a percentage-point Plan Budget");
				const owner = plan(row.scope.plan);
				const meter = context.meter(row.scope.plan, meterId);
				if (!meter || context.now - meter.fetchedAt > owner.config.meterGraceS * 1000 || meter.source === "failed") throw new SwitchError(503, "meter_unavailable", "A fresh provider Meter is required for this Grant");
				amount = Math.max(0, 100 - meter.providerUsedPct) * adjustment.percent_of_plan_remaining / 100;
				dependencies[`meter:${row.scope.plan}:${meterId}`] = meter.version;
			}
			amount = roundOperatorAmount(amount, row.unit);
			if (amount > 0) newGrant(key, row, amount, until);
			break;
		}
		case "grant.revoke": {
			const grant = key.grants.find(row => row.id === adjustment.grant);
			if (!grant) notFound("Grant");
			if (grant.transferGroup) removeGroup(keys, grant.transferGroup); else key.grants = key.grants.filter(row => row.id !== adjustment.grant);
			withdrawal = true;
			break;
		}
		case "transfer": {
			if (adjustment.to !== target || adjustment.from === adjustment.to) throw new SwitchError(422, "validation", "Transfer path must name its distinct recipient");
			const donor = keys.get(adjustment.from);
			if (!donor) notFound("Donor Key");
			for (const owner of [donor, key]) if (!owner.enabled || owner.revoked || (owner.expiresAt !== undefined && owner.expiresAt <= context.now)) throw new SwitchError(409, "transfer_unavailable", "Both transfer keys must be live");
			const from = budget(adjustment.budget, donor);
			const to = budget(adjustment.budget);
			if (from.unit !== to.unit || stableStringifyJson(from.scope) !== stableStringifyJson(to.scope) || stableStringifyJson(from.window) !== stableStringifyJson(to.window)) throw new SwitchError(409, "transfer_unavailable", "Transfer Budgets must have the same unit, scope and window");
			const fromInstance = context.window(donor, from);
			const toInstance = context.window(key, to);
			if (to.window.kind !== "rolling" && (!fromInstance || !toInstance || fromInstance.id !== toInstance.id || fromInstance.startedAt !== toInstance.startedAt || fromInstance.resetsAt !== toInstance.resetsAt)) throw new SwitchError(409, "transfer_unavailable", "Transfer windows must have the same current boundaries");
			const view = context.budgetView(donor, from, keys);
			const amount = roundOperatorAmount(adjustment.amount, to.unit);
			if (amount <= 0 || amount > view.remaining || view.capEff - amount < 0) throw new SwitchError(409, "transfer_unavailable", "Donor does not have this much unreserved allowance");
			const until = expiry(adjustment.until, to);
			dependencies[`accounting:${donor.name}:${from.id}`] = view.accountingVersion;
			if (fromInstance) dependencies[`instance:${donor.name}:${from.id}`] = fromInstance.id;
			const group = `t_${valueHash([context.actor, target, original.rev, donor.rev, canonicalAdjustment])}`;
			newGrant(donor, from, -amount, until, group);
			newGrant(key, to, amount, until, group);
			break;
		}
	}
	if (withdrawal) {
		const removed = unwindUnsupportedTransfers(keys, context.plans, context.allocationVersion);
		if (removed.length) warnings.push(`support_removed: ${removed.join(", ")}`);
	}
	for (const candidate of keys.values()) context.validateKey(candidate);
	const allocation = validateAllocations(keys, context.plans, context.allocationVersion);
	const changed = [...keys.values()].filter(candidate => valueHash(keyPolicy(candidate)) !== valueHash(keyPolicy(context.keys.get(candidate.name)!))).map(candidate => candidate.name).sort();
	const effect: JsonValue = {
		keys: changed.map(name => keyPolicy(keys.get(name)!)),
		allocations: allocation.allocations.map(({ version: _version, ...row }) => JSON.parse(stableStringifyJson(row)) as JsonValue),
		lifetime: JSON.parse(stableStringifyJson(lifetime)) as JsonValue,
	};
	return { keys, changed, adjustment: canonicalAdjustment, allocations: allocation.allocations, effect, lifetime, warnings, dependencies };
}
