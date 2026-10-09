import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { evaluateGate, matchesBudget } from "./accounting";
import { SwitchError } from "./error";
import type { SwitchConfig } from "./config/types";
import type { SwitchDatabase } from "./database";
import type { AttemptRecord, DebitRecord, KeyRecord, MeterRecord, ResolvedPlan } from "./internal";
import { type AllocationState, computeAllocations } from "./policy";
import { budgetKey, calendarWindow, gateLimit, parseDuration, rollingStart } from "./windows";
import type {
	AllocationView,
	AttributionAmounts,
	AttributionMode,
	Budget,
	BudgetView,
	Gate,
	GateView,
	GrantView,
	KeyView,
	MeterView,
	PlanView,
	UsageView,
	WindowInstanceView,
} from "./wire";

export interface ReadModelContext {
	now: number;
	generation: string;
	accountingVersion: number;
	allocationVersion: number;
	config: SwitchConfig;
	keys: ReadonlyMap<string, KeyRecord>;
	plans: ReadonlyMap<string, ResolvedPlan>;
	meters: ReadonlyMap<string, MeterRecord>;
	instances: ReadonlyMap<string, WindowInstanceView>;
	holds: ReadonlyMap<string, AttemptRecord>;
	database: SwitchDatabase;
	uncertainBindings: ReadonlySet<string>;
	modelReferenceKnown(reference: string): boolean;
}

export function sameBinding(a: MeterRecord["binding"], b: MeterRecord["binding"]): boolean {
	return a === undefined
		? b === undefined
		: b !== undefined &&
				a.provider === b.provider &&
				a.credentialId === b.credentialId &&
				a.fingerprint === b.fingerprint;
}

export function planBindingKey(generation: string, plan: ResolvedPlan): string {
	return JSON.stringify([
		generation,
		plan.config.id,
		plan.binding?.provider ?? null,
		plan.binding?.credentialId ?? null,
		plan.binding?.fingerprint ?? null,
	]);
}

/** Calculations are server-only and use one captured instant and committed state. */
export class ReadModels {
	readonly #context: ReadModelContext;
	readonly #allocations: AllocationState;

	constructor(context: ReadModelContext) {
		this.#context = context;
		this.#allocations = computeAllocations(context.keys, context.plans, context.allocationVersion);
	}

	allocations(): AllocationView[] {
		return this.#allocations.allocations;
	}

	meter(planId: string, meterId: string, owner = this.#context.plans.get(planId)): MeterRecord | undefined {
		if (!owner) return undefined;
		return [...this.#context.meters.values()].find(
			row => row.plan === planId && row.meter === meterId && sameBinding(row.binding, owner.binding),
		);
	}

	meters(plan: ResolvedPlan): MeterRecord[] {
		return [...this.#context.meters.values()]
			.filter(
				row =>
					row.plan === plan.config.id &&
					sameBinding(row.binding, plan.binding) &&
					(!plan.config.meters || plan.config.meters.includes(row.meter)),
			)
			.sort((a, b) => a.meter.localeCompare(b.meter));
	}

	window(key: KeyRecord, budget: Budget): WindowInstanceView | undefined {
		if (budget.window.kind === "plan") return this.meter(budget.scope.plan!, budget.window.meter)?.instance;
		if (budget.window.kind === "calendar")
			return calendarWindow(this.#context.now, budget.window.period, this.#context.config.switch.timezone);
		if (budget.window.kind === "rolling") return undefined;
		const instance = this.#context.instances.get(budgetKey(key.name, budget.id));
		return instance &&
			instance.id.startsWith(`anchored:${budget.window.ms}:`) &&
			(instance.resetsAt === undefined || this.#context.now < instance.resetsAt)
			? instance
			: undefined;
	}

	budget(key: KeyRecord, budget: Budget): BudgetView {
		const context = this.#context;
		const instance = this.window(key, budget);
		const cap = this.#allocations.caps.get(budgetKey(key.name, budget.id)) ?? {
			norm: 1,
			grants: 0,
			capEff: budget.cap,
		};
		const from =
			budget.window.kind === "rolling"
				? rollingStart(context.now, budget.window.ms)
				: (instance?.startedAt ?? context.now);
		let used = 0;
		let unpriced = false;
		if (budget.unit === "plan_pct") {
			const meter = budget.scope.meter ?? (budget.window.kind === "plan" ? budget.window.meter : undefined);
			if (meter && budget.scope.plan && (budget.window.kind !== "plan" || instance !== undefined)) {
				const records = context.database.debitUsage(
					key.name,
					budget.scope.plan,
					meter,
					from,
					context.now + 1,
					budget.window.kind === "plan" ? instance?.id : undefined,
				);
				for (const row of records) {
					if (matchesBudget(budget, { provider: row.provider, model: row.model, plan: row.debit.plan })) {
						used +=
							row.debit.mode === "declared"
								? (row.debit.declaredPct ?? 0)
								: row.debit.confirmedPct + row.debit.provisionalRemainingPct;
					}
				}
			}
		} else {
			for (const row of context.database.usage("key", key.name, from, context.now + 1)) {
				if (!matchesBudget(budget, row)) continue;
				if (
					budget.window.kind === "plan" &&
					row.instances[JSON.stringify([budget.scope.plan, budget.window.meter])] !== instance?.id
				)
					continue;
				if (budget.window.kind === "anchored" && row.instances[budgetKey(key.name, budget.id)] !== instance?.id)
					continue;
				used += row.consumption[budget.unit];
				unpriced ||= row.unpriced;
			}
		}
		let reserved = 0;
		const definition = stableStringifyJson([budget.unit, budget.scope, budget.window]);
		for (const attempt of context.holds.values()) {
			for (const hold of (attempt.pendingJobHold ?? attempt.reservation).budgets) {
				if (budget.window.kind === "plan" && hold.instance !== instance?.id) continue;
				if (
					hold.key === key.name &&
					hold.budget === budget.id &&
					stableStringifyJson([hold.unit, hold.scope, hold.window]) === definition
				) {
					reserved += hold.amount;
					unpriced ||= attempt.unpriced;
				}
			}
		}
		const suspension = key.suspensions[budget.id];
		const policyEffective = suspension ? "soft" : budget.policy;
		const full = used + reserved >= cap.capEff;
		const warn = budget.warnAt.some(threshold => cap.capEff > 0 && (used / cap.capEff) * 100 >= threshold);
		return {
			...budget,
			...cap,
			used,
			reserved,
			unpriced,
			remaining: Math.max(0, cap.capEff - used - reserved),
			unspent: Math.max(0, cap.capEff - used),
			overage: Math.max(0, used - cap.capEff),
			policyEffective,
			...(suspension?.expiry.expiresAt !== undefined ? { suspendedUntil: suspension.expiry.expiresAt } : {}),
			...(instance ? { instance } : {}),
			state: suspension
				? "suspended"
				: full && policyEffective === "hard"
					? "exhausted"
					: warn || full
						? "warn"
						: "ok",
			accountingVersion: context.accountingVersion,
		};
	}

	debt(meter: MeterRecord): { total: number; records: DebitRecord[] } {
		const records = this.#context.database.debits(meter.plan, meter.meter, meter.instance.id);
		return { records, total: records.reduce((sum, row) => sum + row.remainingUnobserved, 0) };
	}

	inflight(meter: MeterRecord): number {
		let sum = 0;
		for (const attempt of this.#context.holds.values()) {
			for (const hold of (attempt.pendingJobHold ?? attempt.reservation).meters)
				if (hold.plan === meter.plan && hold.meter === meter.meter && hold.instance === meter.instance.id)
					sum += hold.amount;
		}
		return sum;
	}

	gate(plan: ResolvedPlan | undefined, gate: Gate, meter?: MeterRecord): GateView {
		const warnAt = gate.warnAt ?? plan?.config.warnAt ?? this.#context.config.switch.warnAt;
		if (!plan || !meter)
			return {
				...gate,
				warnAt,
				gateLimit: gateLimit(gate),
				debt: 0,
				inflight: 0,
				remaining: 0,
				state: "unavailable",
				dataVersion: this.#context.accountingVersion,
			};
		const debt = this.debt(meter).total;
		const inflight = this.inflight(meter);
		const projection = evaluateGate(plan.config, meter, gate, debt, inflight, 0, this.#context.now);
		const warn = warnAt.some(threshold => (projection.projected / projection.limit) * 100 >= threshold);
		return {
			...gate,
			warnAt,
			gateLimit: projection.limit,
			providerUsedPct: meter.providerUsedPct,
			accountingBasePct: meter.accountingBasePct,
			debt,
			inflight,
			remaining: Math.max(0, projection.limit - projection.projected),
			projectedWithoutCandidate: projection.projected,
			state:
				projection.denial === "meter_unavailable"
					? "unavailable"
					: projection.denial
						? "exhausted"
						: warn || projection.stale
							? "warn"
							: "ok",
			fetchedAt: meter.fetchedAt,
			...(meter.resetsAt !== undefined ? { resetsAt: meter.resetsAt } : {}),
			staleAllowedS: projection.allowedS,
			dataVersion: meter.version,
		};
	}

	key(key: KeyRecord): KeyView {
		const context = this.#context;
		const budgets = key.budgets.map(budget => this.budget(key, budget));
		const dangling: string[] = [];
		for (const reference of key.scope.models)
			if (!context.modelReferenceKnown(reference)) dangling.push(`model:${reference}`);
		for (const endpoint of key.scope.endpoints)
			if (endpoint !== "*" && !context.config.endpoints.some(row => row.id === endpoint))
				dangling.push(`endpoint:${endpoint}`);
		const plans = key.plans.map(entry => {
			const plan = context.plans.get(entry.plan);
			if (!plan) dangling.push(`plan:${entry.plan}`);
			const meters = plan ? this.meters(plan) : [];
			return {
				plan: entry.plan,
				gates: entry.gates.map(gate => {
					if (gate.meter !== "*")
						return this.gate(
							plan,
							gate,
							meters.find(meter => meter.meter === gate.meter),
						);
					const candidates = meters.map(meter => this.gate(plan, gate, meter));
					// A wildcard summary is its most restrictive covered window; per-window detail is in PlanView.
					return candidates.sort((a, b) => a.remaining - b.remaining)[0] ?? this.gate(plan, gate);
				}),
			};
		});
		const reasons: KeyView["reasons"] = [];
		for (const budget of budgets) {
			if (budget.state !== "ok")
				reasons.push({
					constraint: `budget:${budget.id}`,
					condition: budget.state,
					scope: budget.scope,
					unit: budget.unit,
					used: budget.used,
					limit: budget.capEff,
					...(budget.instance?.resetsAt !== undefined ? { resetsAt: budget.instance.resetsAt } : {}),
				});
		}
		for (const plan of plans)
			for (const gate of plan.gates)
				if (gate.state !== "ok")
					reasons.push({
						constraint: `gate:${plan.plan}:${gate.meter}`,
						condition: gate.state,
						scope: { plan: plan.plan, meter: gate.meter },
						unit: "plan_pct",
						...(gate.projectedWithoutCandidate !== undefined ? { used: gate.projectedWithoutCandidate } : {}),
						limit: gate.gateLimit,
						...(gate.resetsAt !== undefined ? { resetsAt: gate.resetsAt } : {}),
					});
		for (const reference of dangling) reasons.push({ constraint: reference, condition: "dangling", scope: {} });
		const disabled = !key.enabled || key.revoked || (key.expiresAt !== undefined && key.expiresAt <= context.now);
		if (disabled)
			reasons.push({
				constraint: "key",
				condition: key.revoked ? "revoked" : !key.enabled ? "disabled" : "expired",
				scope: {},
			});
		for (const entry of key.plans) {
			const plan = context.plans.get(entry.plan);
			if (!plan) continue;
			if (
				plan.resolution === "unresolved" ||
				context.uncertainBindings.has(planBindingKey(context.generation, plan))
			) {
				reasons.push({ constraint: `plan:${entry.plan}`, condition: "unresolved", scope: { plan: entry.plan } });
				continue;
			}
			const meters = this.meters(plan);
			if (!meters.length)
				reasons.push({ constraint: `plan:${entry.plan}`, condition: "unavailable", scope: { plan: entry.plan } });
			for (const id of plan.config.meters ?? [])
				if (!meters.some(meter => meter.meter === id))
					reasons.push({
						constraint: `meter:${entry.plan}:${id}`,
						condition: "unavailable",
						scope: { plan: entry.plan, meter: id },
					});
			for (const meter of meters) {
				const projection = evaluateGate(
					plan.config,
					meter,
					undefined,
					this.debt(meter).total,
					this.inflight(meter),
					0,
					context.now,
				);
				const warned = plan.config.warnAt.some(threshold => projection.projected >= threshold);
				if (projection.denial || projection.stale || warned)
					reasons.push({
						constraint: `meter:${entry.plan}:${meter.meter}`,
						condition: projection.denial ?? (projection.stale ? "stale" : "warn"),
						scope: { plan: entry.plan, meter: meter.meter },
						unit: "plan_pct",
						used: projection.projected,
						limit: 100,
						...(meter.resetsAt !== undefined ? { resetsAt: meter.resetsAt } : {}),
					});
			}
		}
		const state = disabled
			? "disabled"
			: budgets.some(row => row.state === "exhausted") ||
				  plans.some(row => row.gates.some(gate => gate.state === "exhausted"))
				? "exhausted"
				: reasons.length
					? "warn"
					: "ok";
		const grants: GrantView[] = key.grants.map(({ createdAt: _createdAt, ...grant }) => grant);
		return {
			name: key.name,
			rev: key.rev,
			etag: `"key:${key.name}:${key.rev}"`,
			enabled: key.enabled,
			revoked: key.revoked,
			...(key.expiresAt !== undefined ? { expiresAt: key.expiresAt } : {}),
			...(key.note !== undefined ? { note: key.note } : {}),
			sealed: key.sealed,
			createdAt: key.createdAt,
			updatedAt: key.updatedAt,
			scope: key.scope,
			planOrder: key.planOrder,
			plans,
			budgets,
			grants,
			...(key.rotationGraceUntil !== undefined ? { rotationGraceUntil: key.rotationGraceUntil } : {}),
			dangling,
			state,
			reasons,
		};
	}

	meterView(plan: ResolvedPlan, meter: MeterRecord): MeterView {
		const context = this.#context;
		const debt = this.debt(meter);
		const keyed = new Map<
			string,
			{ key: string; confirmedPct: number; provisionalPct: number; declaredPct: number; tokens: number }
		>();
		const anonymous = new Map<
			string,
			{ endpoint: string; confirmedPct: number; provisionalPct: number; declaredPct: number; tokens: number }
		>();
		for (const record of debt.records) {
			if (record.principal.kind === "key") {
				const row = keyed.get(record.principal.id) ?? {
					key: record.principal.id,
					confirmedPct: 0,
					provisionalPct: 0,
					declaredPct: 0,
					tokens: 0,
				};
				row.confirmedPct += record.confirmedPct;
				row.provisionalPct += record.provisionalRemainingPct;
				row.declaredPct += record.declaredPct ?? 0;
				row.tokens += record.tokens;
				keyed.set(row.key, row);
			} else {
				const row = anonymous.get(record.principal.id) ?? {
					endpoint: record.principal.id,
					confirmedPct: 0,
					provisionalPct: 0,
					declaredPct: 0,
					tokens: 0,
				};
				row.confirmedPct += record.confirmedPct;
				row.provisionalPct += record.provisionalRemainingPct;
				row.declaredPct += record.declaredPct ?? 0;
				row.tokens += record.tokens;
				anonymous.set(row.endpoint, row);
			}
		}
		const gates: MeterView["gates"] = [];
		const shares: MeterView["shares"] = [];
		for (const key of context.keys.values()) {
			const entry = key.plans.find(row => row.plan === plan.config.id);
			const gate =
				entry?.gates.find(row => row.meter === meter.meter) ?? entry?.gates.find(row => row.meter === "*");
			if (gate) gates.push({ key: key.name, gate: this.gate(plan, gate, meter) });
			for (const budget of key.budgets)
				if (
					budget.scope.plan === plan.config.id &&
					budget.window.kind === "plan" &&
					budget.window.meter === meter.meter &&
					budget.unit === (plan.config.attribution === "tokens" ? "tokens" : "plan_pct")
				)
					shares.push({ key: key.name, budget: this.budget(key, budget) });
		}
		const allocation = this.#allocations.allocations.find(
			row => row.plan === plan.config.id && row.meter === meter.meter,
		) ?? {
			plan: plan.config.id,
			meter: meter.meter,
			unit: plan.config.attribution === "tokens" ? ("tokens" as const) : ("plan_pct" as const),
			...(plan.config.attribution !== "tokens"
				? { capacity: 100 }
				: plan.config.shareCapacity?.[meter.meter] !== undefined
					? { capacity: plan.config.shareCapacity[meter.meter] }
					: {}),
			baseSum: 0,
			effectiveSum: 0,
			overcommit: false,
			mode: plan.config.overcommit,
			version: context.allocationVersion,
			keys: [],
		};
		const declaredPct = [...keyed.values(), ...anonymous.values()].reduce((sum, row) => sum + row.declaredPct, 0);
		return {
			plan: meter.plan,
			meter: meter.meter,
			instance: meter.instance,
			providerUsedPct: meter.providerUsedPct,
			accountingBasePct: meter.accountingBasePct,
			fetchedAt: meter.fetchedAt,
			observationCutoff: meter.observationCutoff,
			...(meter.durationMs !== undefined ? { durationMs: meter.durationMs } : {}),
			...(meter.resetsAt !== undefined ? { resetsAt: meter.resetsAt } : {}),
			source: meter.source,
			version: meter.version,
			freshness: context.now - meter.fetchedAt <= plan.config.meterGraceS * 1000 ? "fresh" : "stale",
			debt: debt.total,
			inflight: this.inflight(meter),
			attribution: {
				keys: [...keyed.values()].map(row => ({
					key: row.key,
					...attributionAmounts(row, plan.config.attribution),
				})),
				anonymous: [...anonymous.values()].map(row => ({
					endpoint: row.endpoint,
					...attributionAmounts(row, plan.config.attribution),
				})),
				externalPct: meter.externalPct,
				precision:
					plan.config.attribution === "proportional" || debt.records.some(row => row.precision === "estimated")
						? "estimated"
						: plan.config.attribution === "declared"
							? "declared"
							: "measured",
			},
			...(plan.config.attribution === "declared"
				? { declaredPct, providerPct: meter.providerUsedPct, drift: declaredPct - meter.providerUsedPct }
				: {}),
			calibration: {
				state:
					plan.config.attribution === "declared" ||
					(plan.config.attribution === "tokens"
						? meter.pointsPerToken !== undefined
						: meter.pointsPerWeight !== undefined)
						? "calibrated"
						: "cold",
				...(meter.pointsPerWeight !== undefined ? { pointsPerWeight: meter.pointsPerWeight } : {}),
				...(meter.pointsPerToken !== undefined ? { pointsPerToken: meter.pointsPerToken } : {}),
			},
			gates,
			shares,
			allocation,
		};
	}

	plan(plan: ResolvedPlan, identity = false): PlanView {
		const meters = this.meters(plan);
		const uncertain = this.#context.uncertainBindings.has(planBindingKey(this.#context.generation, plan));
		const reason = uncertain ? "The retained credential binding requires a new Generation" : plan.reason;
		const warnings = reason ? [reason] : [];
		if (!meters.length) warnings.push("No provider Meter observation is available");
		for (const id of plan.config.meters ?? [])
			if (!meters.some(meter => meter.meter === id)) warnings.push(`Meter ${id} is unavailable`);
		for (const meter of meters)
			if (meter.source === "failed")
				warnings.push(`Meter ${meter.meter} refresh failed; its last observation is retained`);
		return {
			id: plan.config.id,
			provider: plan.config.provider,
			name: plan.config.name,
			accountLabel: plan.accountLabel,
			resolution: uncertain ? "unresolved" : plan.resolution,
			...(reason !== undefined ? { reason } : {}),
			...(identity && plan.identity ? { identity: plan.identity } : {}),
			etag: `"plan:${plan.config.id}:${this.#context.generation}"`,
			attributionMode: plan.config.attribution,
			meters: meters.map(meter => this.meterView(plan, meter)),
			allocationVersion: this.#context.allocationVersion,
			warnings,
		};
	}

	usage(key: KeyRecord, window: string): UsageView {
		const ms = parseDuration(window);
		if (ms === undefined)
			throw new SwitchError(422, "validation", "Usage window must be a positive m/h/d/w duration");
		const context = this.#context;
		const from = rollingStart(context.now, ms);
		const to = context.now;
		const usage = context.database.usage("key", key.name, from, to + 1);
		const debits = context.database.keyDebits(key.name, from, to + 1);
		let precision: UsageView["precision"] =
			usage.some(row => row.source !== "reported") || debits.some(row => row.precision === "estimated")
				? "estimated"
				: "measured";
		const unitSeries = key.budgets.map(budget => {
			const points = new Map<number, UsageView["unitSeries"][number]["points"][number]>();
			const add = (at: number, used: number, source: string) => {
				const minute = Math.floor(at / 60_000) * 60_000;
				const row = points.get(minute);
				if (row) {
					row.used += used;
					if (row.source !== source) row.source = "mixed";
				} else points.set(minute, { from: minute, to: Math.min(minute + 60_000, to), used, source });
			};
			if (budget.unit === "plan_pct") {
				const meter = budget.scope.meter ?? (budget.window.kind === "plan" ? budget.window.meter : undefined);
				if (budget.scope.plan && meter)
					for (const row of context.database.debitUsage(key.name, budget.scope.plan, meter, from, to + 1)) {
						if (matchesBudget(budget, { provider: row.provider, model: row.model, plan: row.debit.plan }))
							add(
								row.debit.settledAt,
								row.debit.mode === "declared"
									? (row.debit.declaredPct ?? 0)
									: row.debit.confirmedPct + row.debit.provisionalRemainingPct,
								row.debit.precision,
							);
					}
			} else {
				for (const row of usage) {
					if (
						!matchesBudget(budget, row) ||
						(row.phase === "request" && budget.unit !== "requests") ||
						(budget.unit === "requests" && row.consumption.requests === 0)
					)
						continue;
					const source = budget.unit === "usd" && row.unpriced ? "unpriced" : row.source;
					if (source === "unpriced") precision = "estimated";
					add(row.at, row.consumption[budget.unit], source);
				}
			}
			const reserved = this.budget(key, budget).reserved;
			if (reserved > 0) {
				const minute = Math.floor(to / 60_000) * 60_000;
				const point = points.get(minute);
				if (point) point.reserved = reserved;
				else points.set(minute, { from: minute, to, used: 0, reserved, source: "reservation" });
			}
			return { budget: budget.id, unit: budget.unit, points: [...points.values()].sort((a, b) => a.from - b.from) };
		});
		const attribution = new Map<string, UsageView["attributionSeries"][number]>();
		for (const debit of debits) {
			const id = JSON.stringify([debit.instance, debit.mode]);
			const row: UsageView["attributionSeries"][number] = attribution.get(id) ?? {
				instance: debit.instance,
				principal: { kind: "key", id: key.name },
				confirmed: 0,
				provisional: 0,
				mode: debit.mode,
				precision: debit.precision,
			};
			row.confirmed +=
				debit.mode === "declared"
					? (debit.declaredPct ?? 0)
					: debit.mode === "tokens"
						? debit.tokens
						: debit.confirmedPct;
			row.provisional += debit.mode === "proportional" ? debit.provisionalRemainingPct : 0;
			if (debit.precision === "estimated") row.precision = "estimated";
			attribution.set(id, row);
		}
		return { window, unitSeries, attributionSeries: [...attribution.values()], precision, from, to };
	}
}

function attributionAmounts(
	row: { confirmedPct: number; provisionalPct: number; declaredPct: number; tokens: number },
	mode: AttributionMode,
): AttributionAmounts {
	if (mode === "tokens") return { tokens: row.tokens };
	if (mode === "declared") return { declaredPct: row.declaredPct };
	return { confirmedPct: row.confirmedPct, provisionalPct: row.provisionalPct };
}
