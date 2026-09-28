import type { AuthStorage } from "../auth-storage";
import type { UsageLimit, UsageReport } from "../usage";
import { resolveUsedFraction } from "../usage";
import type { ResolvedPlan } from "./internal";
import type { SwitchStore } from "./store";
import type { MeterObservation } from "./store-contracts";

function identity(report: UsageReport, limit: UsageLimit, plan: ResolvedPlan): boolean {
	if (!plan.binding || !plan.identity || limit.scope.provider !== plan.binding.provider) return false;
	const source = report.metadata ?? {};
	if (typeof source.accountId === "string" && limit.scope.accountId && source.accountId !== limit.scope.accountId) return false;
	const expected = plan.identity;
	const names = [
		["accountId", expected.account_id], ["email", expected.email], ["projectId", expected.project_id],
	] as const;
	let common = 0;
	for (const [name, value] of names) {
		const observed = name === "accountId" ? limit.scope.accountId ?? source[name] : name === "projectId" ? limit.scope.projectId ?? source[name] : source[name];
		if (typeof observed !== "string" || !value) continue;
		if ((name === "email" ? observed.toLowerCase() : observed) !== (name === "email" ? value.toLowerCase() : value)) return false;
		common++;
	}
	const org = limit.scope.orgId ?? source.orgId;
	if (typeof org === "string" && expected.org_id && org !== expected.org_id) return false;
	return common > 0;
}

function observation(report: UsageReport, limit: UsageLimit, plan: ResolvedPlan, fetchStartedAt: number): MeterObservation | undefined {
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined || !Number.isFinite(fraction) || fraction < 0 || !Number.isFinite(report.fetchedAt) || report.fetchedAt <= 0) return undefined;
	return {
		plan: plan.config.id, meter: limit.id, binding: plan.binding,
		providerUsedPct: fraction * 100,
		fetchedAt: report.fetchedAt, observationCutoff: Math.min(fetchStartedAt, report.fetchedAt),
		...(limit.window?.durationMs !== undefined ? { durationMs: limit.window.durationMs } : {}),
		...(limit.window?.resetsAt !== undefined ? { resetsAt: limit.window.resetsAt } : {}),
		source: report.fetchedAt >= fetchStartedAt ? "fresh" : "cache",
	};
}

/**
 * Advisory usage polling is outside the accounting transaction. Only reports
 * with an unambiguous stored account identity can enter the Store's Meter owner.
 */
export class SwitchMeterCache {
	readonly #store: SwitchStore;
	readonly #storage: AuthStorage;
	readonly #plans: () => readonly ResolvedPlan[];
	readonly #generation: () => string;
	readonly #ttlMs: number;
	readonly #minMs: number;
	#timer?: ReturnType<typeof setTimeout>;
	readonly #inFlight = new Map<string, Promise<Map<string, "updated" | "unchanged" | "failed">>>();
	#stopped = false;

	constructor(store: SwitchStore, storage: AuthStorage, plans: () => readonly ResolvedPlan[], generation: () => string, ttlS: number, minS: number) {
		this.#store = store;
		this.#storage = storage;
		this.#plans = plans;
		this.#generation = generation;
		this.#ttlMs = ttlS * 1000;
		this.#minMs = minS * 1000;
	}

	start(): void {
		if (!this.#timer && !this.#stopped) this.#schedule(this.#ttlMs);
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(delay: number): void {
		if (this.#stopped) return;
		const jitter = delay * (Math.random() * 0.2 - 0.1);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.refresh().catch(() => new Map()).finally(() => this.#schedule(this.#ttlMs));
		}, Math.max(this.#minMs, delay + jitter));
	}

	/** Coalesce equivalent probes without letting a background poll swallow a targeted write refresh. */
	refresh(planId?: string, invalidate = false): Promise<Map<string, "updated" | "unchanged" | "failed">> {
		if (this.#stopped) return Promise.resolve(new Map());
		const key = `${planId ?? "*"}:${invalidate}`;
		const existing = this.#inFlight.get(key);
		if (existing) return existing;
		const pending = this.#poll(planId, invalidate);
		this.#inFlight.set(key, pending);
		void pending.finally(() => { if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key); }).catch(() => {});
		return pending;
	}

	async #poll(planId: string | undefined, invalidate: boolean): Promise<Map<string, "updated" | "unchanged" | "failed">> {
		const allPlans = this.#plans().filter(plan => plan.resolution === "resolved" && plan.binding);
		const plans = allPlans.filter(plan => !planId || plan.config.id === planId);
		const results = new Map<string, "updated" | "unchanged" | "failed">();
		if (!plans.length) return results;
		const generation = this.#generation();
		const providerIds = [...new Set(plans.map(plan => plan.binding!.provider))];
		const invalidationFailed = new Set<string>();
		if (invalidate) for (const provider of providerIds) {
			try { await this.#storage.usage.invalidate(provider); }
			catch { invalidationFailed.add(provider); }
		}
		const startedAt = Date.now();
		let reports: UsageReport[] | null;
		try { reports = await this.#storage.usage.reports(); }
		catch { reports = null; }
		if (this.#stopped || this.#generation() !== generation) return results;
		const ambiguousOwners = new Set<string>();
		for (const report of reports ?? []) for (const limit of report.limits) {
			const owners = allPlans.filter(plan => report.provider === plan.binding!.provider && (!plan.config.meters || plan.config.meters.includes(limit.id)) && identity(report, limit, plan));
			if (owners.length > 1) for (const owner of owners) ambiguousOwners.add(owner.config.id);
		}
		for (const plan of plans) {
			let fingerprint: string | undefined;
			try { fingerprint = await this.#storage.keys.fingerprintPinned(plan.binding!.credentialId, plan.binding!.provider); }
			catch {
				this.#store.markMetersFailed(plan);
				results.set(plan.config.id, "failed");
				continue;
			}
			if (this.#stopped || this.#generation() !== generation) return results;
			if (invalidationFailed.has(plan.binding!.provider)) {
				this.#store.markMetersFailed(plan);
				results.set(plan.config.id, "failed");
				continue;
			}
			if (fingerprint !== plan.binding!.fingerprint) {
				this.#store.markBindingUncertain(generation, plan);
				results.set(plan.config.id, "failed");
				continue;
			}
			const observations = new Map<string, MeterObservation>();
			let ambiguous = false;
			for (const report of reports ?? []) {
				if (report.provider !== plan.binding!.provider) continue;
				for (const limit of report.limits) {
					if (plan.config.meters && !plan.config.meters.includes(limit.id)) continue;
					if (!identity(report, limit, plan)) continue;
					const item = observation(report, limit, plan, startedAt);
					if (!item) continue;
					if (observations.has(limit.id)) { ambiguous = true; break; }
					observations.set(limit.id, item);
				}
				if (ambiguous) break;
			}
			if (ambiguous || ambiguousOwners.has(plan.config.id) || observations.size === 0 || plan.config.meters?.some(meter => !observations.has(meter))) {
				this.#store.markMetersFailed(plan);
				results.set(plan.config.id, "failed");
				continue;
			}
			try {
				let updated = false;
				for (const item of observations.values()) updated = this.#store.observeMeter(item, plan, generation) || updated;
				results.set(plan.config.id, updated ? "updated" : "unchanged");
			} catch {
				this.#store.markMetersFailed(plan);
				results.set(plan.config.id, "failed");
			}
		}
		return results;
	}
}
