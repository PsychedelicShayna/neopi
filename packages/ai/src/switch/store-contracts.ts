import type { Usage } from "../types";
import type { SwitchConfig } from "./config/types";
import type { AccountingPrincipal, AttemptRecord, CredentialBinding, JobRecord, ResolvedPlan, VideoStatus } from "./internal";
import type { ConsumptionView, EstimateView, FailoverCause, Gate, Scope } from "./wire";

export interface StoreOptions {
	config: SwitchConfig;
	generation: string;
	plans: ResolvedPlan[];
	/** Checked against the active prepared catalog without doing IO. */
	modelReferenceKnown(reference: string): boolean;
	/** The one post-commit broker observer. Routes and MoA callbacks must not repeat it. */
	observeUsage(attempt: AttemptRecord, consumption: ConsumptionView): void;
	/** Shared process clock; tests may provide a deterministic clock without changing globals. */
	now?: () => number;
}

export interface AdmissionInput {
	id: string;
	decisionId: string;
	principal: AccountingPrincipal;
	provider: string;
	model: string;
	usageProvider: string;
	preparedFingerprint: string;
	generation: string;
	plan?: ResolvedPlan;
	binding?: CredentialBinding;
	estimate: EstimateView;
	parentCallId?: string;
	purpose?: string;
	unpriced: boolean;
	/** Active request endpoint's declared anonymous Gates, never client-supplied. */
	anonymousGates?: Gate[];
	/** The request owner repeats final live scope/dial checks inside admission. */
	checkAuthority(scope: Scope | undefined): void;
}

export interface AdmissionDenial {
	code: string;
	status: number;
	constraint: { kind: "key" | "plan" | "gate" | "budget"; id: string; key?: string; plan?: string; meter?: string };
	used: number;
	limit: number;
	unit: "requests" | "tokens" | "usd" | "plan_pct";
	resetsAt?: number;
	retryAfterS?: number;
}

export interface AdmissionResult {
	admitted: boolean;
	denial?: AdmissionDenial;
	stale: boolean;
}

export type AttemptOutcome =
	| { kind: "accepted-job"; jobId: string; status: VideoStatus; httpStatus: number }
	| { kind: "terminal"; status: number; usage?: Usage; costUsd?: number; committed: boolean; cause?: FailoverCause }
	| { kind: "job-terminal"; jobId: string; status: "completed" | "failed" | "cancelled" | "expired"; usage?: Usage; costUsd?: number }
	| { kind: "forced"; reason: "drain" | "timeout" | "client-abort" | "shutdown" | "recovery" | "job-expired"; status: number };

export interface SettlementResult {
	finalized: boolean;
	accepted: boolean;
	attempt: AttemptRecord;
}

export interface JobIdentityInput {
	upstreamId: string;
	pollingUrl?: string;
	generationId?: string;
	status: VideoStatus;
}

export interface OpenJobResult {
	job: JobRecord;
	attempt: AttemptRecord;
}

export interface MeterObservation {
	plan: string;
	meter: string;
	binding?: CredentialBinding;
	providerUsedPct: number;
	fetchedAt: number;
	observationCutoff: number;
	durationMs?: number;
	resetsAt?: number;
	providerInstance?: string;
	source: "fresh" | "cache";
}
