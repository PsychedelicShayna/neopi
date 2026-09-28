import type { PlanConfig, SwitchConfig } from "./config/types";
import type {
	AttributionMode, AttemptView, Budget, ConsumptionView, Decision, EstimateView, GrantExpiry,
	GrantView, PlanEntry, Scope, WindowInstanceView,
} from "./wire";

export type AccountingPrincipal = { kind: "key"; id: string } | { kind: "anonymous"; id: string };
export interface CredentialBinding {
	readonly provider: string;
	readonly credentialId: number;
	readonly fingerprint: string;
}
export interface ResolvedPlan {
	config: PlanConfig;
	binding?: CredentialBinding;
	identity?: { email?: string; account_id?: string; project_id?: string; org_id?: string };
	accountLabel: string;
	resolution: "resolved" | "unresolved";
	reason?: string;
}
export interface StoredGrant extends GrantView {
	createdAt: number;
}
export interface Suspension {
	expiry: GrantExpiry;
	previousPolicy: Budget["policy"];
	reason?: string;
}
export interface KeyRecord {
	name: string;
	rev: number;
	enabled: boolean;
	revoked: boolean;
	expiresAt?: number;
	note?: string;
	sealed: boolean;
	createdAt: number;
	updatedAt: number;
	scope: Scope;
	planOrder: "priority" | "headroom";
	plans: PlanEntry[];
	budgets: Budget[];
	grants: StoredGrant[];
	suspensions: Record<string, Suspension>;
	rotationGraceUntil?: number;
}
export interface KeyTokenRecord {
	key: string;
	digest: string;
	plaintext?: string;
	validUntil?: number;
	current: boolean;
}
export interface MeterRecord {
	plan: string;
	meter: string;
	binding?: CredentialBinding;
	instance: WindowInstanceView;
	providerUsedPct: number;
	accountingBasePct: number;
	fetchedAt: number;
	/** Provider identity for observed reset detection, never a public credential identity. */
	providerInstance?: string;
	observationCutoff: number;
	durationMs?: number;
	resetsAt?: number;
	source: "fresh" | "cache" | "failed";
	version: number;
	externalPct: number;
	burnRateEma: number;
	pointsPerWeight?: number;
	pointsPerToken?: number;
	calibrationIntervals: { at: number; delta: number; weight: number; tokens: number }[];
}
export interface BudgetHold {
	key: string;
	budget: string;
	unit: Budget["unit"];
	amount: number;
	instance?: string;
	window: Budget["window"];
	scope: Budget["scope"];
}
export interface MeterHold {
	plan: string;
	meter: string;
	instance: string;
	amount: number;
}
export interface Reservation {
	budgets: BudgetHold[];
	meters: MeterHold[];
}
export interface FrozenMeter {
	meter: string;
	instance: string;
	mode: AttributionMode;
	pointsPerWeight?: number;
	pointsPerToken?: number;
	size?: { usd: number } | { tokens: number } | { requests: number };
}
export interface AttemptRecord {
	id: string;
	decisionId: string;
	parentCallId?: string;
	purpose?: string;
	principal: AccountingPrincipal;
	provider: string;
	model: string;
	usageProvider: string;
	preparedFingerprint: string;
	generation: string;
	plan?: string;
	binding?: CredentialBinding;
	estimate: EstimateView;
	frozenMeters: FrozenMeter[];
	reservation: Reservation;
	upstreamCalled: boolean;
	launchAt?: number;
	committed: boolean;
	requestCounted: boolean;
	requestCountedAt?: number;
	transportSettled: boolean;
	transportSettledAt?: number;
	pendingJobHold?: Reservation & { deadline: number };
	settled: boolean;
	settledAt?: number;
	settlementInstances?: Record<string, string>;
	actual?: ConsumptionView;
	actualSource?: AttemptView["actualSource"];
	billed: boolean;
	cause?: AttemptView["cause"];
	status: number;
	startedAt: number;
	stale: boolean;
	unpriced: boolean;
}
export type VideoStatus = "queued" | "processing" | "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
export interface JobRecord {
	id: string;
	originAttemptId: string;
	principal: AccountingPrincipal;
	provider: string;
	model: string;
	plan?: string;
	binding?: CredentialBinding;
	upstreamId: string;
	pollingUrl?: string;
	generationId?: string;
	createdAt: number;
	lastStatus: VideoStatus;
	observedConsumption?: ConsumptionView;
}
export interface DebitRecord {
	attemptId: string;
	principal: AccountingPrincipal;
	plan: string;
	meter: string;
	instance: string;
	mode: AttributionMode;
	weight: number;
	tokens: number;
	points: number;
	remainingUnobserved: number;
	confirmedPct: number;
	provisionalRemainingPct: number;
	declaredPct?: number;
	settledAt: number;
	/** Marks work used by an earlier calibration interval without discarding residual debt. */
	calibratedAt?: number;
}
export interface UsageRecord {
	id: string;
	attemptId: string;
	principal: AccountingPrincipal;
	provider: string;
	model: string;
	plan?: string;
	at: number;
	minute: number;
	instances: Record<string, string>;
	consumption: ConsumptionView;
	source: "reported" | "estimate" | "interrupted-estimate";
	unpriced: boolean;
}
export interface StoreState {
	keys: Map<string, KeyRecord>;
	meters: Map<string, MeterRecord>;
	instances: Map<string, WindowInstanceView>;
	plans: Map<string, ResolvedPlan>;
	config: SwitchConfig;
	generation: string;
	policyVersion: number;
	accountingVersion: number;
	allocationVersion: number;
}
export interface PendingDecision {
	record: Decision;
	attempts: Set<string>;
}
