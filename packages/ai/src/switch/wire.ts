/** Browser-safe, type-only switch admin v1 contract. No Store or credential types. */
import type { Effort } from "@oh-my-pi/pi-catalog/effort";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AdminRole = "read" | "write";
/** Capability presence describes an implemented operation, never an operator role grant. */
export type AdminCapability =
	| "keys.read" | "keys.write" | "keys.adjust.preview" | "keys.adjust"
	| "plans.read" | "plans.refresh" | "plans.check" | "usage.read"
	| "decisions.read" | "events.read" | "events.stream" | "audit.read"
	| "config.read" | "config.reload" | "explain" | "models.read"
	| "keys.export" | "keys.import" | "backup" | "glue.read" | "glue.restart";
export type Unit = "requests" | "tokens" | "usd" | "plan_pct";
export type AttributionMode = "proportional" | "declared" | "tokens";
export type OvercommitMode = "allow" | "normalize" | "deny";
export type DialName = "effort" | "temp" | "top_p" | "top_k" | "min_p" | "max_tokens" | "budget" | "verbosity" | "tier";
export type ConstraintState = "ok" | "warn" | "exhausted" | "disabled";
export type Freshness = "fresh" | "stale" | "unavailable";
export type Precision = "measured" | "estimated" | "declared";
export type Until = "window" | string;
export type MeaningId =
	| "permanent-points"
	| "permanent-percent"
	| "window-points"
	| "plan-remaining-percent"
	| "restore-free-percent"
	| "gate-points"
	| "duration-points"
	| "transfer-points"
	| "suspend-enforcement"
	| "new-window";

export interface Issue {
	code: string;
	path: string;
	message: string;
}

export interface ReadEnvelope<T> {
	apiVersion: 1;
	serviceId: string;
	bootEpoch: string;
	generation: string;
	observedAt: number;
	cursor: string;
	policyVersion: number;
	data: T;
}

export interface ApiError {
	error: {
		code: string;
		message: string;
		detail?: {
			issues?: Issue[];
			current?: unknown;
			requiredMilestone?: string;
			changed?: string[];
			affected?: { key: string; budget: string; proposedCapEff: number; transferGroups: string[] }[];
			allocationVersion?: number;
		};
	};
}

export interface MutationResult<T> {
	applied: boolean;
	current: T;
	policyVersion: number;
	auditIds: string[];
	eventIds: string[];
}

export interface Page<T> {
	items: T[];
	nextCursor?: string;
}

export interface Scope {
	network: string[];
	endpoints: string[];
	models: string[];
	dials: { effort_max?: Effort; allow?: DialName[] };
}

export type WindowSpec =
	| { kind: "plan"; meter: string }
	| { kind: "rolling"; ms: number }
	| { kind: "anchored"; ms: number }
	| { kind: "calendar"; period: "day" | "week" | "month" };

export interface BudgetScope {
	plan?: string;
	meter?: string;
	provider?: string;
	models?: string[];
}

export interface Budget {
	id: string;
	unit: Unit;
	cap: number;
	window: WindowSpec;
	scope: BudgetScope;
	policy: "hard" | "soft" | "burst";
	burstBelow?: number;
	warnAt: number[];
}

export interface Gate {
	meter: string;
	ceiling?: number;
	reserve?: number;
	warnAt?: number[];
}

export interface PlanEntry {
	plan: string;
	gates: Gate[];
}

export interface WindowInstanceView {
	id: string;
	startedAt: number;
	resetsAt?: number;
	endSource: "authoritative" | "inferred" | "unknown";
}

export interface GrantExpiry {
	kind: "instant" | "instance";
	expiresAt?: number;
	instanceId?: string;
}

export interface GrantView {
	id: string;
	key: string;
	budget: string;
	amount: number;
	reason?: string;
	actor: string;
	expiry: GrantExpiry;
	transferGroup?: string;
}

export interface BudgetView extends Budget {
	norm: number;
	grants: number;
	capEff: number;
	used: number;
	/** Includes accepted asynchronous jobs' retained durable consumption holds. */
	reserved: number;
	remaining: number;
	unspent: number;
	overage: number;
	unpriced: boolean;
	policyEffective: Budget["policy"];
	suspendedUntil?: number;
	instance?: WindowInstanceView;
	state: "ok" | "warn" | "exhausted" | "suspended";
	accountingVersion: number;
}

export interface GateView extends Gate {
	warnAt: number[];
	gateLimit: number;
	providerUsedPct?: number;
	accountingBasePct?: number;
	debt: number;
	inflight: number;
	remaining: number;
	projectedWithoutCandidate?: number;
	state: "ok" | "warn" | "exhausted" | "unavailable";
	fetchedAt?: number;
	resetsAt?: number;
	staleAllowedS?: number;
	dataVersion: number;
}

export interface ConstraintReason {
	constraint: string;
	condition: string;
	scope: BudgetScope;
	unit?: Unit;
	used?: number;
	limit?: number;
	resetsAt?: number;
}

export interface KeyView {
	name: string;
	rev: number;
	etag: string;
	enabled: boolean;
	revoked: boolean;
	expiresAt?: number;
	note?: string;
	sealed: boolean;
	createdAt: number;
	updatedAt: number;
	scope: Scope;
	planOrder: "priority" | "headroom";
	plans: { plan: string; gates: GateView[] }[];
	budgets: BudgetView[];
	grants: GrantView[];
	rotationGraceUntil?: number;
	dangling: string[];
	state: ConstraintState;
	reasons: ConstraintReason[];
}

export interface AllocationView {
	plan: string;
	meter: string;
	unit: "plan_pct" | "tokens";
	capacity?: number;
	baseSum: number;
	effectiveSum: number;
	overcommit: boolean;
	mode: OvercommitMode;
	version: number;
	keys: { key: string; baseCap: number; norm: number; grants: number; capEff: number }[];
}

export interface AttributionAmounts {
	confirmedPct?: number;
	provisionalPct?: number;
	declaredPct?: number;
	tokens?: number;
}

export interface MeterView {
	plan: string;
	meter: string;
	instance?: WindowInstanceView;
	providerUsedPct?: number;
	accountingBasePct?: number;
	fetchedAt?: number;
	observationCutoff?: number;
	durationMs?: number;
	resetsAt?: number;
	source: "fresh" | "cache" | "failed";
	version: number;
	freshness: Freshness;
	debt: number;
	inflight: number;
	attribution: {
		keys: (AttributionAmounts & { key: string })[];
		anonymous: (AttributionAmounts & { endpoint: string })[];
		externalPct: number;
		precision: Precision;
	};
	declaredPct?: number;
	providerPct?: number;
	drift?: number;
	calibration: { state: "cold" | "calibrated"; pointsPerWeight?: number; pointsPerToken?: number };
	gates: { key: string; gate: GateView }[];
	shares: { key: string; budget: BudgetView }[];
	allocation: AllocationView;
}

export interface PlanView {
	id: string;
	provider: string;
	name: string;
	resolution: "resolved" | "unresolved";
	reason?: string;
	accountLabel: string;
	/** Only present on explicitly write-authorized identity=1 reads. */
	identity?: { email?: string; account_id?: string; project_id?: string; org_id?: string };
	etag: string;
	attributionMode: AttributionMode;
	meters: MeterView[];
	allocationVersion: number;
	warnings: string[];
}

export interface PendingRestart {
	field: string;
	active: JsonValue;
	requested: JsonValue;
}

export interface ConfigView {
	generation: string;
	etag: string;
	sources: { label: string; sha256: string }[];
	issues: Issue[];
	pendingRestart: PendingRestart[];
	plans: { id: string; state: "resolved" | "unresolved"; reason?: string }[];
	capabilities: string[];
}

export interface GlueView {
	id: string;
	state: "starting" | "ready" | "stopping" | "stopped" | "failed";
	generation: string;
	lastError?: string;
}

export interface TargetHealthView {
	target: string;
	state: "healthy" | "cooldown" | "unavailable";
	until?: number;
	reason?: string;
}

export interface HealthView {
	status: "ready" | "degraded" | "draining";
	uptimeMs: number;
	glue: GlueView[];
	targets: TargetHealthView[];
	repairs: Record<string, number>;
	reloadIssues: Issue[];
	capabilities: string[];
}

export interface Overview {
	plans: PlanView[];
	keys: { name: string; state: ConstraintState; reasons: ConstraintReason[] }[];
	denialsToday: { count: number; timezone: string; from: number; to: number };
	health: HealthView;
	config: ConfigView;
}

export interface SnapshotView {
	overview: Overview;
	keys: KeyView[];
	plans: PlanView[];
	config: ConfigView;
	health: HealthView;
}

export interface SessionView {
	actor: string;
	role: AdminRole;
	capabilities: string[];
	serviceLabel: string;
	metersTtlS: number;
}

export interface UsageView {
	window: string;
	unitSeries: { budget: string; unit: Unit; points: { from: number; to: number; used: number; reserved?: number; source: string }[] }[];
	attributionSeries: {
		instance: string;
		principal: { kind: "key"; id: string };
		confirmed: number;
		provisional: number;
		mode: AttributionMode;
		precision: Precision;
	}[];
	precision: Precision;
	from: number;
	to: number;
}

export type Adjustment =
	| { op: "plan.add"; plan: string; gates: Gate[]; position?: number }
	| { op: "plan.remove"; plan: string }
	| { op: "plan.reorder"; plans: string[] }
	| { op: "gate.set"; plan: string; meter: string; ceiling?: number; reserve?: number; warnAt?: number[] }
	| { op: "gate.raise"; plan: string; meter: string; by: number }
	| { op: "gate.remove"; plan: string; meter: string }
	| { op: "budget.add"; budget: Budget }
	| { op: "budget.remove"; budget: string }
	| { op: "budget.set"; budget: string; cap?: number; policy?: Budget["policy"]; burstBelow?: number; warnAt?: number[] }
	| { op: "budget.raise"; budget: string; by: number }
	| { op: "budget.scale"; budget: string; percent: number }
	| { op: "budget.suspend"; budget: string; until: Until; reason?: string }
	| { op: "grant.add"; budget: string; until: Until; reason?: string; amount?: number; percent_of_cap?: number; percent_of_plan_remaining?: number; to_remaining_percent?: number }
	| { op: "grant.revoke"; grant: string }
	| { op: "transfer"; from: string; to: string; budget: string; amount: number; until: Until; reason?: string };

export type AdjustmentPreviewRequest =
	| { mode: "operation"; adjustment: Adjustment }
	| { mode: "number"; subject: { budget: string } | { plan: string; meter: string }; number: number; duration?: string; donor?: string; newBudget?: Budget };

export interface PreviewChoice {
	meaningId: MeaningId | Adjustment["op"];
	status: "ready" | "needs_input" | "invalid" | "not_applicable";
	label: string;
	adjustment?: Adjustment;
	requiredFields?: string[];
	issues: Issue[];
	before?: KeyView[];
	after?: KeyView[];
	allocationEffects?: AllocationView[];
	lifetime?: { kind: "permanent" | "instant" | "instance"; expiresAt?: number; instanceId?: string };
	warnings: string[];
	preview?: string;
	expiresAt?: number;
}

export interface Preview {
	subject: { key: string; budget?: string; plan?: string; meter?: string };
	number?: number;
	observedAt: number;
	generation: string;
	choices: PreviewChoice[];
}

export interface AdjustRequest {
	adjustment: Adjustment;
	preview: string;
}

export interface AdjustResult {
	keys: KeyView[];
	allocations: AllocationView[];
}

export interface MintKeyRequest {
	name: string;
	note?: string;
	expires_at?: number;
	sealed?: boolean;
	from_key?: string;
	scope: Scope;
	plans?: PlanEntry[];
	budgets?: Budget[];
	sourceEtag?: string;
}

export interface PatchKeyRequest {
	enabled?: boolean;
	note?: string | null;
	expires_at?: number | null;
	scope?: Scope;
	plan_order?: "priority" | "headroom";
}

export interface KeyTokenResult {
	key: KeyView;
	token: string;
}

export interface RotateKeyRequest {
	grace_s?: number;
}

export interface EstimateView {
	requests: 1;
	tokens: number;
	usd: number;
	weight: number;
	planPct: Record<string, number>;
	source: "estimate";
}

export interface ConsumptionView {
	requests: number;
	tokens: number;
	usd: number;
	weight: number;
}

export type FailoverCause = "429" | "5xx" | "connect" | "timeout" | "reauth" | "model-missing" | "plan-exhausted" | "draining";

export interface AttemptView {
	id: string;
	parentCallId?: string;
	purpose?: string;
	plan?: string;
	provider: string;
	model: string;
	estimate: EstimateView;
	actual?: ConsumptionView;
	actualSource?: "reported" | "estimate" | "interrupted-estimate";
	billed: boolean;
	cause?: FailoverCause;
	status: number;
	elapsedMs: number;
	committed: boolean;
	admissionInstance?: string;
	settlementInstance?: string;
	stale: boolean;
}

export interface Dials {
	effort?: Effort | "off";
	temp?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	maxTokens?: number;
	budget?: number;
	verbosity?: "low" | "medium" | "high";
	tier?: "auto" | "default" | "flex" | "priority" | "fast";
}

export interface Decision {
	id: string;
	at: number;
	endpoint: string;
	key?: string;
	peer: string;
	route: string;
	requested: string;
	target?: string;
	repairs: { id: string; detail?: string }[];
	dials: Dials;
	plans: { plan?: string; target: string; outcome: "admitted" | "denied" | "failed" | "skipped"; reason?: string }[];
	attempts: AttemptView[];
	status: number;
	error?: string;
	elapsedMs: number;
	generation: string;
	state: "running" | "completed" | "interrupted";
	outcome: "running" | "succeeded" | "denied" | "failed";
}

export interface EventDetails {
	threshold_crossed: { constraint: string; threshold: number; used: number; limit: number; unit: Unit; instanceId?: string; resetsAt?: number };
	denied: { decisionId: string; code: string; constraint: string; used?: number; limit?: number; unit?: Unit; resetsAt?: number };
	plan_fallback: { decisionId: string; from: string; to: string; cause: FailoverCause };
	plan_exhausted: { decisionId?: string; usedPct: number; instanceId: string };
	meter_unavailable: { ageS?: number; fetchedAt?: number; reason: string; instanceId?: string };
	meter_stale: { ageS?: number; fetchedAt?: number; reason: string; instanceId?: string };
	plan_unresolved: { reason: string };
	unplanned_account: { provider: string; count: number };
	gate_overshoot: { instanceId: string; limit: number; observedPct: number; attemptIds: string[]; keyIds: string[] };
	over_budget_soft: { attemptId: string; budget: string; used: number; reserved: number; capEff: number; unit: Unit; instanceId?: string };
	burst_used: { attemptId: string; budget: string; used: number; reserved: number; capEff: number; unit: Unit; instanceId?: string };
	stale_admitted: { ageS: number; allowedS: number; headroom: number; attemptIds: string[]; suppressed: number };
	allotment_changed: { operation: string; affectedKeys: string[]; policyVersion: number; auditId: string; system: boolean };
	key_minted: { key: string; rev: number; policyVersion: number; auditId: string; graceUntil?: number };
	key_rotated: { key: string; rev: number; policyVersion: number; auditId: string; graceUntil?: number };
	key_revoked: { key: string; rev: number; policyVersion: number; auditId: string; graceUntil?: number };
	key_changed: { key: string; rev: number; policyVersion: number; auditId: string; graceUntil?: number };
	key_revealed: { key: string; auditId: string };
	config_applied: { generation: string; issues: Issue[]; pendingRestart: PendingRestart[] };
	config_rejected: { generation: string; issues: Issue[]; pendingRestart: PendingRestart[] };
	glue_crashed: { provider: string; generation: string; reason?: string; auditId?: string };
	glue_unready: { provider: string; generation: string; reason?: string; auditId?: string };
	glue_restarted: { provider: string; generation: string; reason?: string; auditId?: string };
	discovery_failed: { provider: string; keptPrevious: boolean; reason: string };
	auth_failed: { peer: string; count: number; intervalS: number };
	notify_failed: { sinkId: string; eventId: string; reason: string };
	import_applied: { mode: "merge" | "replace"; created: string[]; updated: string[]; revoked: string[]; policyVersion: number; auditId: string };
	backup_created: { backupId: string; auditId: string };
	admin_action: { action: "plan_refresh" | "plan_check" | "export"; resourceId?: string; auditId: string; result: "ok" | "failed" };
}

export type EventKind = keyof EventDetails;
export type SwitchEvent = {
	[K in EventKind]: {
		id: string;
		at: number;
		kind: K;
		severity: "info" | "warn" | "error";
		key?: string;
		plan?: string;
		meter?: string;
		detail: EventDetails[K];
	};
}[EventKind];

export interface AuditView {
	id: string;
	at: number;
	actor: string;
	operation: string;
	targets: string[];
	before: JsonValue;
	after: JsonValue;
	result: "ok" | "failed";
	correlationId: string;
}

export type ResourceKind = "overview" | "key" | "plan" | "usage" | "decisions" | "events" | "audit" | "config" | "health" | "allocation";
export interface ResourceInvalidation {
	kind: ResourceKind;
	id?: string;
	version: string;
}

export interface ChangeFrame {
	cursor: string;
	at: number;
	generation: string;
	resources: ResourceInvalidation[];
	event?: SwitchEvent;
}
export type ChangeEventName = "state" | "meter" | "reload" | "event";
export interface ResyncFrame { reason: string }

export interface ExplainRequest {
	model: string;
	key?: string;
	anonymous?: boolean;
	endpoint: string;
	peer?: string;
	route?: string;
	tokens?: number;
}

export interface ExplainCandidate {
	target: string;
	plan?: string;
	admitted: boolean;
	reasons: Issue[];
	estimate: EstimateView;
	budgets: BudgetView[];
	meters: MeterView[];
	optionRestrictions: { field: string; requested?: JsonValue; effective?: JsonValue; reason: string }[];
}

export interface ExplainView {
	model: string;
	endpoint: string;
	generation: string;
	keyRev?: number;
	dataVersion: number;
	candidates: ExplainCandidate[];
	reasons: Issue[];
	promptTokens: number;
	imageTokens: number;
}

export interface ExportView {
	format: "toml";
	content: string;
	policyEtag: string;
	secretsIncluded: boolean;
}

export interface ImportRequest {
	format: "toml";
	content: string;
	mode: "merge" | "replace";
}

export interface ImportChange {
	name: string;
	operation: "create" | "update" | "revoke";
	before?: KeyView;
	after?: KeyView;
	credentialChanged: boolean;
}

export interface ImportPreview {
	changes: ImportChange[];
	issues: Issue[];
	policyEtag: string;
	preview?: string;
}

export interface ImportApplyRequest extends ImportRequest { preview: string }
export interface ImportResult {
	keys: KeyView[];
	createdTokens: { name: string; token: string }[];
	changes: ImportChange[];
}

export interface PlanRefreshResult {
	plan: PlanView;
	refresh: "updated" | "unchanged" | "failed";
	issues: Issue[];
}
export interface PlanCheckResult {
	planId: string;
	results: { status: string; reason?: string }[];
}
export interface ReloadResult { config: ConfigView; applied: boolean; issues: Issue[] }
export interface BackupResult { backupId: string; path: string; bytes: number }
export interface GlueListView { providers: GlueView[] }

export interface AnnouncedModel {
	id: string;
	object: "model";
	owned_by: string;
	api: string;
	kind?: string;
	display_name: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities: ("text" | "image")[];
	supports_tools?: boolean;
}
export interface ModelsView {
	models: AnnouncedModel[];
	generation: string;
	keyRev?: number;
}
