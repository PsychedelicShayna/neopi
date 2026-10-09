import type { Usage } from "../types";
import type { PlanConfig } from "./config/types";
import { SwitchError } from "./error";
import type { FrozenMeter, MeterRecord } from "./internal";
import type { Budget, ConsumptionView, Gate } from "./wire";
import { gateLimit } from "./windows";

export function consumptionFromUsage(usage: Usage, requests = 1, costUsd = usage.cost.total): ConsumptionView {
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (![tokens, costUsd, requests].every(value => Number.isFinite(value) && value >= 0))
		throw new SwitchError(502, "invalid_usage", "Provider returned invalid consumption values");
	return { requests, tokens, usd: costUsd, weight: costUsd > 0 ? costUsd : tokens / 1_000_000 };
}

export function meterPoints(consumption: ConsumptionView, meter: FrozenMeter): number {
	if (meter.mode === "declared") {
		const size = meter.size;
		if (!size) throw new SwitchError(503, "meter_unavailable", "Declared Meter capacity is unavailable");
		if ("usd" in size) return (100 * consumption.usd) / size.usd;
		if ("tokens" in size) return (100 * consumption.tokens) / size.tokens;
		return (100 * consumption.requests) / size.requests;
	}
	const points =
		meter.mode === "tokens"
			? meter.pointsPerToken === undefined
				? 0
				: consumption.tokens * meter.pointsPerToken
			: meter.pointsPerWeight === undefined
				? 0
				: consumption.weight * meter.pointsPerWeight;
	return points > 0 ? points : 1;
}

export interface GateEvaluation {
	limit: number;
	ageS: number;
	stale: boolean;
	allowedS: number;
	headroom: number;
	burnRate: number;
	projected: number;
	denial?: "meter_unavailable" | "plan_exhausted" | "plan_ceiling";
}

export function evaluateGate(
	plan: PlanConfig,
	meter: MeterRecord,
	gate: Gate | undefined,
	debt: number,
	inflight: number,
	estimate: number,
	now: number,
): GateEvaluation {
	const limit = gate ? gateLimit(gate) : 100;
	const ageS = Math.max(0, now - meter.fetchedAt) / 1000;
	const stale = ageS > plan.meterGraceS;
	const base = meter.accountingBasePct + debt + inflight + estimate;
	const headroom = limit - base;
	const hours =
		meter.durationMs !== undefined && meter.durationMs > 0
			? meter.durationMs / 3_600_000
			: meter.instance.endSource === "authoritative" &&
				  meter.instance.resetsAt !== undefined &&
				  meter.instance.resetsAt > meter.instance.startedAt
				? (meter.instance.resetsAt - meter.instance.startedAt) / 3_600_000
				: 168;
	const burnRate = Math.max(meter.burnRateEma, (plan.staleBurnFloor * 100) / hours);
	const allowedS = Math.min(plan.staleMaxS, burnRate > 0 ? Math.max(0, (headroom / burnRate) * 3600) : plan.staleMaxS);
	const excess = Math.max(0, ageS - plan.meterGraceS);
	const projected = base + (stale ? (burnRate * excess) / 3600 : 0);
	let denial: GateEvaluation["denial"];
	if (stale && (plan.staleMaxS === 0 || excess > allowedS || projected >= limit)) denial = "meter_unavailable";
	else if (projected >= 100) denial = "plan_exhausted";
	else if (gate && projected >= limit) denial = "plan_ceiling";
	return { limit, ageS, stale, allowedS, headroom, burnRate, projected, ...(denial ? { denial } : {}) };
}

export function matchesBudget(budget: Budget, target: { plan?: string; provider: string; model: string }): boolean {
	if (budget.scope.plan !== undefined && budget.scope.plan !== target.plan) return false;
	if (budget.scope.provider !== undefined && budget.scope.provider !== target.provider) return false;
	return (
		budget.scope.models === undefined ||
		budget.scope.models.some(pattern => new Bun.Glob(pattern).match(`${target.provider}/${target.model}`))
	);
}
