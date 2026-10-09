import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { consumptionFromUsage, evaluateGate, matchesBudget, meterPoints } from "./accounting";
import { createBackup } from "./backup";
import type { SwitchConfig } from "./config/types";
import { digestMatches, mintToken, type PreviewBasis, SwitchSignatures, tokenDigest, valueHash } from "./crypto";
import { type RecordFilter, type StoredChange, SwitchDatabase } from "./database";
import { notFound, SwitchError } from "./error";
import { exportPolicy, type ImportEffect, prepareImport } from "./imports";
import { serializeKeyDocument } from "./keys-toml";
import type {
	AccountingPrincipal,
	AttemptRecord,
	DebitRecord,
	JobRecord,
	KeyRecord,
	KeyTokenRecord,
	MeterRecord,
	Reservation,
	ResolvedPlan,
	UsageRecord,
} from "./internal";
import {
	applyAdjustmentDraft,
	computeAllocations,
	expirePolicies,
	keyPolicy,
	type PolicyContext,
	type PolicyEffect,
	validateAllocations,
} from "./policy";
import { planBindingKey, ReadModels, sameBinding } from "./read-models";
import type {
	AdmissionInput,
	AdmissionResult,
	AttemptOutcome,
	HistoryQuery,
	JobIdentityInput,
	MeterObservation,
	OpenJobResult,
	SettlementResult,
	StoreOptions,
} from "./store-contracts";
import {
	parseAdjustment,
	parseBudget,
	parseImportRequest,
	parseMintRequest,
	parsePatchRequest,
	parsePreviewRequest,
} from "./validation";
import { budgetKey, calendarWindow, gateLimit, meterKey } from "./windows";
import type {
	AttemptView,
	BackupResult,
	ConfigView,
	Decision,
	ExportView,
	HealthView,
	ImportApplyRequest,
	ImportChange,
	ImportPreview,
	ImportRequest,
	ImportResult,
	Issue,
	Overview,
	Page,
	PendingRestart,
	SnapshotView,
	UsageView,
} from "./wire";
import type {
	AdjustRequest,
	AdjustResult,
	Adjustment,
	AdjustmentPreviewRequest,
	AllocationView,
	ApiError,
	AuditView,
	Budget,
	ChangeEventName,
	ConsumptionView,
	EventDetails,
	EventKind,
	GrantView,
	JsonValue,
	KeyTokenResult,
	KeyView,
	MeaningId,
	MintKeyRequest,
	MutationResult,
	PatchKeyRequest,
	PlanView,
	Preview,
	PreviewChoice,
	ReadEnvelope,
	ResourceInvalidation,
	SwitchEvent,
	WindowInstanceView,
} from "./wire";

interface TransactionState {
	now: number;
	config: SwitchConfig;
	generation: string;
	plans: ReadonlyMap<string, ResolvedPlan>;
	uncertainBindings: ReadonlySet<string>;
	keys: Map<string, KeyRecord>;
	tokens: Map<string, KeyTokenRecord>;
	meters: Map<string, MeterRecord>;
	instances: Map<string, WindowInstanceView>;
	holds: Map<string, AttemptRecord>;
	policyVersion: number;
	accountingVersion: number;
	allocationVersion: number;
	changes: StoredChange[];
	observations: { attempt: AttemptRecord; consumption: ConsumptionView }[];
}

type ChangeListener = (change: StoredChange) => void;

export interface ChangeSubscription {
	after: number;
	highWater: number;
	replay(after: number, limit: number): StoredChange[];
	close(): void;
}

/** The serving process owns this Store, its admission critical section and every financial writer. */
export class SwitchStore {
	readonly #database: SwitchDatabase;
	readonly #options: StoreOptions;
	readonly #clock: () => number;
	readonly #signatures: SwitchSignatures;
	readonly #listeners = new Set<ChangeListener>();
	readonly serviceId: string;
	readonly bootEpoch = crypto.randomUUID();
	readonly #bootStartSequence: number;
	#config: SwitchConfig;
	#generation: string;
	#plans: ReadonlyMap<string, ResolvedPlan>;
	#uncertainBindings: ReadonlySet<string> = new Set();
	#keys = new Map<string, KeyRecord>();
	#tokens = new Map<string, KeyTokenRecord>();
	#meters = new Map<string, MeterRecord>();
	#instances = new Map<string, WindowInstanceView>();
	#holds = new Map<string, AttemptRecord>();
	#policyVersion: number;
	#accountingVersion: number;
	#allocationVersion: number;
	#ready = false;
	#accepting = false;
	#closed = false;
	#maintaining = false;
	#readAt?: number;

	constructor(database: SwitchDatabase, options: StoreOptions) {
		this.#database = database;
		this.#options = options;
		this.#bootStartSequence = database.changeSequence();
		const clock = options.now ?? Date.now;
		this.#clock = () => this.#readAt ?? clock();
		this.#config = options.config;
		this.#generation = options.generation;
		this.#plans = new Map(options.plans.map(plan => [plan.config.id, plan]));
		this.serviceId = database.meta<string>("serviceId") ?? crypto.randomUUID();
		const rootKey =
			database.meta<string>("signatureRoot") ??
			Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		this.#signatures = new SwitchSignatures(rootKey);
		this.#policyVersion = database.meta<number>("policyVersion") ?? 0;
		this.#accountingVersion = database.meta<number>("accountingVersion") ?? 0;
		this.#allocationVersion = database.meta<number>("allocationVersion") ?? 0;
		database.transaction(() => {
			database.setMeta("serviceId", this.serviceId);
			database.setMeta("signatureRoot", rootKey);
			database.setMeta("bootEpoch", this.bootEpoch);
		});
		for (const key of database.all("keys")) this.#keys.set(key.name, key);
		for (const token of database.all("key_tokens")) this.#tokens.set(token.digest, token);
		for (const meter of database.currentMeters()) this.#meters.set(this.#meterStorageId(meter), meter);
		for (const [id, instance] of database.budgetInstances()) this.#instances.set(id, instance);
		for (const attempt of database.unfinished()) this.#holds.set(attempt.id, attempt);
		// No public read/admission readiness exists until every unfinished owner is recovered.
		for (const attempt of [...this.#holds.values()])
			this.#settle(attempt.id, { kind: "forced", reason: "recovery", status: 499 });
		for (const decision of database.runningDecisions()) {
			this.recordDecision({
				...decision,
				state: "interrupted",
				outcome: "failed",
				status: 499,
				error: "interrupted",
				elapsedMs: Math.max(0, this.#clock() - decision.at),
			});
		}
		this.#maintain();
		validateAllocations(this.#keys, this.#plans, this.#allocationVersion);
	}

	static async open(options: StoreOptions): Promise<SwitchStore> {
		const database = await SwitchDatabase.open(options.config.switch.stateDir);
		try {
			return new SwitchStore(database, options);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	get generation(): string {
		return this.#generation;
	}
	get policyVersion(): number {
		return this.#policyVersion;
	}
	get policyEtag(): string {
		return `"policy:${this.#policyVersion}"`;
	}
	get accountingVersion(): number {
		return this.#accountingVersion;
	}
	get allocationVersion(): number {
		return this.#allocationVersion;
	}
	get ready(): boolean {
		return this.#ready && !this.#closed;
	}

	/** Called only after the Generation and actual listeners' prerequisites have prepared. */
	markReady(): void {
		if (this.#closed) throw new Error("Store is closed");
		if (this.#database.unfinished().length) throw new Error("Cannot expose an unrecovered Store");
		this.#maintain();
		this.#ready = true;
		this.#accepting = true;
	}

	stopAdmissions(): void {
		this.#accepting = false;
	}

	publishGeneration(
		actor: string,
		config: SwitchConfig,
		generation: string,
		plans: readonly ResolvedPlan[],
		issues: Issue[],
		pendingRestart: PendingRestart[],
	): void {
		this.#assertReady();
		const nextPlans = new Map(plans.map(plan => [plan.config.id, plan]));
		this.#transaction(stage => {
			for (const key of stage.keys.values())
				for (const budget of key.budgets) {
					if (
						budget.unit === "plan_pct" &&
						budget.scope.plan &&
						nextPlans.get(budget.scope.plan)?.config.attribution === "tokens"
					)
						throw new SwitchError(
							422,
							"attribution_tokens",
							"A token-attribution Plan cannot retain percentage-point Budgets",
						);
				}
			// Revalidate the complete allocation set in the publication transaction.
			validateAllocations(stage.keys, nextPlans, stage.allocationVersion + 1);
			const previous = stage.generation;
			stage.config = config;
			stage.generation = generation;
			stage.plans = nextPlans;
			stage.policyVersion++;
			stage.allocationVersion++;
			this.#database.setMeta("generation", generation);
			const auditId = this.#audit(stage, actor, "config.reload", [], { generation: previous }, { generation });
			this.#event(stage, "config_applied", { generation, issues, pendingRestart }, [
				...this.#policyResources(stage, [...stage.keys.keys()]),
				{ kind: "config", version: generation },
				{ kind: "health", version: generation },
				{ kind: "plan", version: generation },
				{ kind: "audit", version: auditId },
			]);
		});
		this.#maintain();
	}

	rejectConfiguration(actor: string, issues: Issue[], pendingRestart: PendingRestart[]): void {
		this.#transaction(stage => {
			const auditId = this.#audit(
				stage,
				actor,
				"config.reload",
				[],
				{ generation: stage.generation },
				{ generation: stage.generation },
				"failed",
			);
			this.#event(
				stage,
				"config_rejected",
				{ generation: stage.generation, issues, pendingRestart },
				[
					{ kind: "config", version: auditId },
					{ kind: "health", version: auditId },
					{ kind: "audit", version: auditId },
				],
				{},
				"warn",
			);
		});
	}

	#assertReady(): void {
		if (!this.ready) throw new SwitchError(503, "unavailable", "Switch startup or shutdown is in progress");
		if (this.#readAt === undefined) this.#maintain();
	}

	#meterStorageId(meter: Pick<MeterRecord, "plan" | "meter" | "binding">): string {
		return JSON.stringify([
			meter.plan,
			meter.meter,
			meter.binding?.provider ?? "http",
			meter.binding?.credentialId ?? null,
			meter.binding?.fingerprint ?? null,
		]);
	}

	#models(
		now: number,
		keys: ReadonlyMap<string, KeyRecord> = this.#keys,
		stage?: TransactionState,
		plans: ReadonlyMap<string, ResolvedPlan> = stage?.plans ?? this.#plans,
	): ReadModels {
		return new ReadModels({
			now,
			keys,
			plans,
			config: stage?.config ?? this.#config,
			generation: stage?.generation ?? this.#generation,
			accountingVersion: stage?.accountingVersion ?? this.#accountingVersion,
			allocationVersion: stage?.allocationVersion ?? this.#allocationVersion,
			meters: stage?.meters ?? this.#meters,
			instances: stage?.instances ?? this.#instances,
			holds: stage?.holds ?? this.#holds,
			uncertainBindings: stage?.uncertainBindings ?? this.#uncertainBindings,
			database: this.#database,
			modelReferenceKnown: this.#options.modelReferenceKnown,
		});
	}

	#transaction<T>(work: (stage: TransactionState) => T): T {
		if (this.#closed) throw new Error("Store is closed");
		const stage: TransactionState = {
			now: this.#clock(),
			keys: new Map(this.#keys),
			tokens: new Map(this.#tokens),
			meters: new Map(this.#meters),
			instances: new Map(this.#instances),
			holds: new Map(this.#holds),
			config: this.#config,
			generation: this.#generation,
			plans: this.#plans,
			uncertainBindings: this.#uncertainBindings,
			policyVersion: this.#policyVersion,
			accountingVersion: this.#accountingVersion,
			allocationVersion: this.#allocationVersion,
			changes: [],
			observations: [],
		};
		const result = this.#database.transaction(() => {
			const value = work(stage);
			if (value instanceof Promise) throw new Error("A switch transaction may not yield");
			this.#database.setMeta("policyVersion", stage.policyVersion);
			this.#database.setMeta("accountingVersion", stage.accountingVersion);
			this.#database.setMeta("allocationVersion", stage.allocationVersion);
			return value;
		});
		this.#keys = stage.keys;
		this.#tokens = stage.tokens;
		this.#meters = stage.meters;
		this.#instances = stage.instances;
		this.#holds = stage.holds;
		this.#policyVersion = stage.policyVersion;
		this.#accountingVersion = stage.accountingVersion;
		this.#allocationVersion = stage.allocationVersion;
		this.#config = stage.config;
		this.#generation = stage.generation;
		this.#plans = stage.plans;
		this.#uncertainBindings = stage.uncertainBindings;
		for (const change of stage.changes) {
			for (const listener of this.#listeners) {
				try {
					listener(change);
				} catch {
					this.#listeners.delete(listener);
				}
			}
		}
		for (const observation of stage.observations) {
			try {
				this.#options.observeUsage(observation.attempt, observation.consumption);
			} catch {
				logger.warn("Switch broker observation delivery failed", { attemptId: observation.attempt.id });
			}
		}
		return result;
	}

	#invalidate(
		stage: TransactionState,
		kind: ChangeEventName,
		resources: ResourceInvalidation[],
		event?: SwitchEvent,
	): void {
		stage.changes.push(
			this.#database.appendChange(kind, {
				cursor: `${this.bootEpoch}:0`,
				at: stage.now,
				generation: stage.generation,
				resources,
				...(event ? { event } : {}),
			}),
		);
	}

	#audit(
		stage: TransactionState,
		actor: string,
		operation: string,
		targets: string[],
		before: JsonValue,
		after: JsonValue,
		result: "ok" | "failed" = "ok",
	): string {
		const id = crypto.randomUUID();
		const record: AuditView = {
			id,
			at: stage.now,
			actor,
			operation,
			targets,
			before,
			after,
			result,
			correlationId: crypto.randomUUID(),
		};
		this.#database.put("audit", id, record);
		return id;
	}

	#event<K extends EventKind>(
		stage: TransactionState,
		kind: K,
		detail: EventDetails[K],
		resources: ResourceInvalidation[],
		subject: { key?: string; plan?: string; meter?: string } = {},
		severity: "info" | "warn" | "error" = "info",
	): string {
		const event = { id: crypto.randomUUID(), at: stage.now, kind, detail, severity, ...subject } as SwitchEvent;
		this.#database.put("events", event.id, event);
		this.#invalidate(stage, "event", resources, event);
		return event.id;
	}

	#policyResources(stage: TransactionState, names: string[]): ResourceInvalidation[] {
		const plans = new Set(
			names.flatMap(name =>
				[...(this.#keys.get(name)?.plans ?? []), ...(stage.keys.get(name)?.plans ?? [])].map(plan => plan.plan),
			),
		);
		const affected = new Set(names);
		for (const key of stage.keys.values()) if (key.plans.some(plan => plans.has(plan.plan))) affected.add(key.name);
		return [
			...[...affected].map(name => ({
				kind: "key" as const,
				id: name,
				version: `${stage.keys.get(name)!.rev}:${stage.allocationVersion}`,
			})),
			...[...plans].map(id => ({
				kind: "plan" as const,
				id,
				version: `${stage.generation}:${stage.allocationVersion}`,
			})),
			...names.map(id => ({ kind: "usage" as const, id, version: String(stage.allocationVersion) })),
			{ kind: "overview", version: String(stage.policyVersion) },
			{ kind: "allocation", version: String(stage.allocationVersion) },
			{ kind: "events", version: String(stage.policyVersion) },
			{ kind: "audit", version: String(stage.policyVersion) },
			{ kind: "health", version: String(stage.policyVersion) },
		];
	}

	#commitKeys(stage: TransactionState, keys: Map<string, KeyRecord>, names: string[]): void {
		if (!names.length) return;
		stage.policyVersion++;
		stage.allocationVersion++;
		for (const name of names) {
			const row = keys.get(name)!;
			const old = stage.keys.get(name);
			row.rev = (old?.rev ?? 0) + 1;
			row.updatedAt = stage.now;
			this.#database.put("keys", name, row);
			stage.keys.set(name, row);
		}
	}

	#context(now: number, actor: string, keys: ReadonlyMap<string, KeyRecord> = this.#keys): PolicyContext {
		return {
			now,
			actor,
			generation: this.#generation,
			allocationVersion: this.#allocationVersion,
			keys,
			plans: this.#plans,
			budgetView: (key, budget, draft) => this.#models(now, draft).budget(key, budget),
			window: (key, budget) => this.#models(now, keys).window(key, budget),
			meter: (plan, meter) => this.#models(now, keys).meter(plan, meter),
			validateKey: key => this.#validateKey(key, keys.get(key.name)),
		};
	}

	#validateKey(key: KeyRecord, previous?: KeyRecord): void {
		const issues: NonNullable<NonNullable<ApiError["error"]["detail"]>["issues"]> = [];
		for (const reference of key.scope.models)
			if (!this.#options.modelReferenceKnown(reference) && !previous?.scope.models.includes(reference))
				issues.push({
					code: "unknown_model_ref",
					path: "scope.models",
					message: "Model reference is not declared by this Generation",
				});
		for (const endpoint of key.scope.endpoints)
			if (
				endpoint !== "*" &&
				!this.#config.endpoints.some(row => row.id === endpoint) &&
				!previous?.scope.endpoints.includes(endpoint)
			)
				issues.push({
					code: "validation",
					path: "scope.endpoints",
					message: "Endpoint is not declared by this Generation",
				});
		if (new Set(key.plans.map(row => row.plan)).size !== key.plans.length)
			issues.push({ code: "validation", path: "plans", message: "Duplicate Plan entries" });
		if (new Set(key.budgets.map(row => row.id)).size !== key.budgets.length)
			issues.push({ code: "validation", path: "budgets", message: "Duplicate Budget ids" });
		for (const entry of key.plans) {
			if (!this.#plans.has(entry.plan) && !previous?.plans.some(row => row.plan === entry.plan))
				issues.push({ code: "unknown_plan", path: "plans", message: "Plan is not configured" });
			if (new Set(entry.gates.map(row => row.meter)).size !== entry.gates.length)
				issues.push({ code: "validation", path: "plans.gates", message: "Duplicate Gates for one Meter" });
		}
		for (const budget of key.budgets) {
			parseBudget(budget);
			if (!budget.scope.plan) continue;
			const plan = this.#plans.get(budget.scope.plan);
			if (!key.plans.some(row => row.plan === budget.scope.plan))
				issues.push({
					code: "budget_scope",
					path: `budgets.${budget.id}.scope`,
					message: "Budget Plan must remain in the Key Plan List",
				});
			if (
				!plan &&
				!previous?.budgets.some(
					row => row.id === budget.id && stableStringifyJson(row.scope) === stableStringifyJson(budget.scope),
				)
			)
				issues.push({
					code: "budget_scope",
					path: `budgets.${budget.id}.scope`,
					message: "Budget Plan is not configured",
				});
			if (plan?.config.attribution === "tokens" && budget.unit === "plan_pct")
				issues.push({
					code: "attribution_tokens",
					path: `budgets.${budget.id}.unit`,
					message: "Token-attribution Plans use token Shares, not percentage points",
				});
		}
		if (issues.length)
			throw new SwitchError(422, "validation", "Key policy contains unresolved references", { issues });
	}

	#maintain(): void {
		if (this.#maintaining || this.#closed) return;
		this.#maintaining = true;
		try {
			const now = this.#clock();
			for (const attempt of [...this.#holds.values()])
				if (attempt.pendingJobHold && attempt.pendingJobHold.deadline <= now)
					this.#settle(attempt.id, { kind: "forced", reason: "job-expired", status: 410 });
			const expiry = expirePolicies(this.#context(now, "system"));
			const changed = new Set(expiry.changed);
			for (const key of expiry.keys.values()) {
				if (key.expiresAt !== undefined && key.expiresAt <= now && key.updatedAt < key.expiresAt)
					changed.add(key.name);
				if (key.rotationGraceUntil !== undefined && key.rotationGraceUntil <= now) {
					delete key.rotationGraceUntil;
					changed.add(key.name);
				}
			}
			const expiredTokens = [...this.#tokens.values()].filter(
				token => token.validUntil !== undefined && token.validUntil <= now,
			);
			if (changed.size || expiredTokens.length)
				this.#transaction(stage => {
					for (const token of expiredTokens) {
						stage.tokens.delete(token.digest);
						this.#database.remove("key_tokens", token.digest);
					}
					const names = [...changed].sort();
					const before = names.map(name => keyPolicy(this.#keys.get(name)!));
					this.#commitKeys(stage, expiry.keys, names);
					if (names.length) {
						const auditId = this.#audit(
							stage,
							"system",
							"support_expired",
							names.map(name => `key:${name}`),
							before,
							names.map(name => keyPolicy(stage.keys.get(name)!)),
						);
						this.#event(
							stage,
							"allotment_changed",
							{
								operation: "support_expired",
								affectedKeys: names,
								policyVersion: stage.policyVersion,
								auditId,
								system: true,
							},
							this.#policyResources(stage, names),
						);
					}
				});
		} finally {
			this.#maintaining = false;
		}
	}

	maintenance(): void {
		this.#assertReady();
	}

	envelope<T>(read: () => T): ReadEnvelope<T> {
		const previous = this.#readAt;
		const observedAt = this.#clock();
		this.#readAt = observedAt;
		try {
			this.#assertReady();
			if (previous === undefined) this.#maintain();
			const data = read();
			if (data instanceof Promise) throw new Error("A read envelope may not yield");
			return {
				apiVersion: 1,
				serviceId: this.serviceId,
				bootEpoch: this.bootEpoch,
				generation: this.#generation,
				observedAt,
				cursor: `${this.bootEpoch}:${this.#database.changeSequence()}`,
				policyVersion: this.#policyVersion,
				data,
			};
		} finally {
			this.#readAt = previous;
		}
	}

	key(name: string): KeyView {
		this.#assertReady();
		return this.#models(this.#clock()).key(this.#keys.get(name) ?? notFound("Key"));
	}

	keys(): KeyView[] {
		this.#assertReady();
		const views = this.#models(this.#clock());
		return [...this.#keys.values()].sort((a, b) => a.name.localeCompare(b.name)).map(key => views.key(key));
	}

	plans(identity = false): PlanView[] {
		this.#assertReady();
		const views = this.#models(this.#clock());
		return [...this.#plans.values()].map(plan => views.plan(plan, identity));
	}

	usage(name: string, window: string): UsageView {
		this.#assertReady();
		return this.#models(this.#clock()).usage(this.#keys.get(name) ?? notFound("Key"), window);
	}

	overview(config: ConfigView, health: HealthView): Overview {
		this.#assertReady();
		const day = calendarWindow(this.#clock(), "day", this.#config.switch.timezone);
		return {
			plans: this.plans(),
			keys: this.keys().map(({ name, state, reasons }) => ({ name, state, reasons })),
			denialsToday: {
				count: this.#database.denials(day.startedAt, day.resetsAt!),
				timezone: this.#config.switch.timezone,
				from: day.startedAt,
				to: day.resetsAt!,
			},
			config,
			health,
		};
	}

	snapshot(config: ConfigView, health: HealthView): SnapshotView {
		const overview = this.overview(config, health);
		return { overview, keys: this.keys(), plans: overview.plans, config, health };
	}

	#attemptView(attempt: AttemptRecord): AttemptView {
		const meter = attempt.frozenMeters.length === 1 ? attempt.frozenMeters[0] : undefined;
		return {
			id: attempt.id,
			...(attempt.parentCallId ? { parentCallId: attempt.parentCallId } : {}),
			...(attempt.purpose ? { purpose: attempt.purpose } : {}),
			...(attempt.plan ? { plan: attempt.plan } : {}),
			provider: attempt.provider,
			model: attempt.model,
			estimate: attempt.estimate,
			...(attempt.actual ? { actual: attempt.actual } : {}),
			...(attempt.actualSource ? { actualSource: attempt.actualSource } : {}),
			billed: attempt.billed,
			...(attempt.cause ? { cause: attempt.cause } : {}),
			status: attempt.status,
			elapsedMs: Math.max(0, (attempt.settledAt ?? attempt.transportSettledAt ?? this.#clock()) - attempt.startedAt),
			committed: attempt.committed,
			...(meter
				? {
						admissionInstance: meter.instance,
						...(attempt.settlementInstances?.[meterKey(attempt.plan!, meter.meter)]
							? { settlementInstance: attempt.settlementInstances[meterKey(attempt.plan!, meter.meter)] }
							: {}),
					}
				: {}),
			stale: attempt.stale,
		};
	}

	recordDecision(decision: Decision): void {
		this.#transaction(stage => {
			const attempts = this.#database.attemptsForDecision(decision.id).map(attempt => this.#attemptView(attempt));
			this.#database.put("decisions", decision.id, { ...decision, attempts });
			this.#invalidate(stage, "state", [
				{ kind: "decisions", id: decision.id, version: `${decision.state}:${stage.now}` },
				{ kind: "overview", version: String(stage.now) },
			]);
		});
	}

	history(table: "decisions", query: HistoryQuery): Page<Decision>;
	history(table: "events", query: HistoryQuery): Page<SwitchEvent>;
	history(table: "audit", query: HistoryQuery): Page<AuditView>;
	history(table: "decisions" | "events" | "audit", query: HistoryQuery): Page<Decision | SwitchEvent | AuditView> {
		this.#assertReady();
		const limit = query.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 500)
			throw new SwitchError(422, "validation", "Page limit must be between 1 and 500");
		const filters: RecordFilter[] = [];
		if (query.since !== undefined) filters.push({ field: "at", value: query.since, comparison: ">=" });
		if (query.key !== undefined) filters.push({ field: "key", value: query.key });
		if (query.plan !== undefined) filters.push({ field: "plan", value: query.plan });
		if (query.status !== undefined) filters.push({ field: "status", value: query.status });
		if (query.kind !== undefined) filters.push({ field: "kind", value: query.kind });
		const filtersHash = valueHash(filters);
		const boundary = query.cursor ? this.#signatures.readPage(query.cursor) : undefined;
		if (
			boundary &&
			(boundary.schema !== 1 ||
				boundary.table !== table ||
				boundary.filtersHash !== filtersHash ||
				!Number.isFinite(boundary.at) ||
				typeof boundary.id !== "string")
		)
			throw new SwitchError(400, "invalid_cursor", "History cursor does not match these filters");
		const rows = this.#database.page(table, filters, limit + 1, boundary);
		const items = rows
			.slice(0, limit)
			.map(row =>
				table === "decisions"
					? {
							...(row as Decision),
							attempts: this.#database.attemptsForDecision(row.id).map(attempt => this.#attemptView(attempt)),
						}
					: row,
			);
		const last = items.at(-1);
		return {
			items,
			...(rows.length > limit && last
				? { nextCursor: this.#signatures.page({ schema: 1, table, filtersHash, at: last.at, id: last.id }) }
				: {}),
		};
	}

	emit<K extends EventKind>(
		kind: K,
		detail: EventDetails[K],
		subject: { key?: string; plan?: string; meter?: string } = {},
		severity: "info" | "warn" | "error" = "info",
	): void {
		this.#transaction(stage => {
			this.#event(stage, kind, detail, [{ kind: "events", version: String(stage.now) }], subject, severity);
		});
	}

	subscribe(cursor: string, listener: ChangeListener): ChangeSubscription {
		this.#assertReady();
		const match = /^([^:]+):(0|[1-9]\d*)$/.exec(cursor);
		const after = match ? Number(match[2]) : Number.NaN;
		const highWater = this.#database.changeSequence();
		const oldest = this.#database.oldestChange();
		if (
			!match ||
			match[1] !== this.bootEpoch ||
			!Number.isSafeInteger(after) ||
			after < this.#bootStartSequence ||
			after > highWater ||
			(oldest > 0 && after < oldest - 1)
		)
			throw new SwitchError(409, "resync_required", "Obtain a new snapshot before subscribing");
		this.#listeners.add(listener);
		return {
			after,
			highWater,
			replay: (position, limit) => {
				if (position < this.#database.oldestChange() - 1)
					throw new SwitchError(409, "resync_required", "Replay fell behind retained history");
				return this.#database.changes(position, highWater, limit);
			},
			close: () => {
				this.#listeners.delete(listener);
			},
		};
	}

	plan(id: string, identity = false): PlanView {
		this.#assertReady();
		return this.#models(this.#clock()).plan(this.#plans.get(id) ?? notFound("Plan"), identity);
	}

	#freshToken(stage: TransactionState): { token: string; digest: string } {
		const token = mintToken();
		const digest = tokenDigest(token);
		if (stage.tokens.has(digest) || this.#tokens.has(digest))
			throw new SwitchError(503, "token_generation_failed", "Could not generate a distinct credential");
		return { token, digest };
	}

	#checkKeyMatch(name: string, etag: string | null): KeyRecord {
		if (etag === null) throw new SwitchError(428, "precondition_required", "If-Match is required");
		if (!/^"key:[a-z0-9][a-z0-9._-]{0,63}:\d+"$/.test(etag))
			throw new SwitchError(400, "invalid_precondition", "If-Match must be a copied Key ETag");
		const key = this.#keys.get(name) ?? notFound("Key");
		if (etag !== `"key:${name}:${key.rev}"`)
			throw new SwitchError(409, "stale_rev", "Key policy changed", {
				current: this.#models(this.#clock()).key(key),
			});
		return key;
	}

	checkPolicyMatch(etag: string | null): void {
		this.#assertReady();
		if (etag === null) throw new SwitchError(428, "precondition_required", "If-Match is required");
		if (!/^"policy:\d+"$/.test(etag))
			throw new SwitchError(400, "invalid_precondition", "If-Match must be a copied policy ETag");
		if (etag !== this.policyEtag)
			throw new SwitchError(409, "stale_resource", "Key policy changed", {
				current: { policyEtag: this.policyEtag },
			});
	}

	authenticate(token: string): KeyRecord | undefined {
		this.#assertReady();
		const digest = tokenDigest(token);
		const now = this.#clock();
		let match: KeyRecord | undefined;
		for (const row of this.#tokens.values()) {
			const equal = digestMatches(digest, row.digest);
			const key = this.#keys.get(row.key);
			if (
				equal &&
				key &&
				key.enabled &&
				!key.revoked &&
				(key.expiresAt === undefined || now < key.expiresAt) &&
				(row.validUntil === undefined || now < row.validUntil)
			)
				match = key;
		}
		return match;
	}

	mint(actor: string, input: MintKeyRequest, ifNoneMatch: string | null): MutationResult<KeyTokenResult> {
		this.#assertReady();
		const request = parseMintRequest(input);
		if (ifNoneMatch === null) throw new SwitchError(428, "precondition_required", "If-None-Match:* is required");
		if (ifNoneMatch !== "*") throw new SwitchError(400, "invalid_precondition", "Mint requires If-None-Match:*");
		if (this.#keys.has(request.name)) throw new SwitchError(409, "name_taken", "Key name has already been used");
		return this.#transaction(stage => {
			const source = request.from_key
				? this.#checkKeyMatch(request.from_key, request.sourceEtag ?? null)
				: undefined;
			const key: KeyRecord = {
				name: request.name,
				rev: 0,
				enabled: true,
				revoked: false,
				sealed: request.sealed ?? false,
				createdAt: stage.now,
				updatedAt: stage.now,
				...(request.expires_at !== undefined ? { expiresAt: request.expires_at } : {}),
				...(request.note !== undefined ? { note: request.note } : {}),
				scope: structuredClone(source?.scope ?? request.scope),
				planOrder: source?.planOrder ?? "priority",
				plans: structuredClone(source?.plans ?? request.plans ?? []),
				budgets: structuredClone(source?.budgets ?? (request.budgets ?? []).map(parseBudget)),
				grants: [],
				suspensions: {},
			};
			this.#validateKey(key);
			const draft = new Map(stage.keys);
			draft.set(key.name, key);
			validateAllocations(draft, this.#plans, stage.allocationVersion);
			this.#commitKeys(stage, draft, [key.name]);
			const { token, digest } = this.#freshToken(stage);
			const row: KeyTokenRecord = {
				key: key.name,
				digest,
				current: true,
				...(!key.sealed ? { plaintext: token } : {}),
			};
			stage.tokens.set(row.digest, row);
			this.#database.put("key_tokens", row.digest, row);
			const auditId = this.#audit(stage, actor, "key.mint", [`key:${key.name}`], null, keyPolicy(key));
			const eventId = this.#event(
				stage,
				"key_minted",
				{ key: key.name, rev: key.rev, policyVersion: stage.policyVersion, auditId },
				this.#policyResources(stage, [key.name]),
				{ key: key.name },
			);
			return {
				applied: true,
				current: { key: this.#models(stage.now, stage.keys, stage).key(key), token },
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	patch(actor: string, name: string, input: PatchKeyRequest, etag: string | null): MutationResult<KeyView> {
		this.#assertReady();
		const request = parsePatchRequest(input);
		const original = this.#checkKeyMatch(name, etag);
		if (original.revoked) throw new SwitchError(409, "name_taken", "A revoked Key cannot be restored");
		const key = structuredClone(original);
		if (request.enabled !== undefined) key.enabled = request.enabled;
		if (request.note === null) delete key.note;
		else if (request.note !== undefined) key.note = request.note;
		if (request.expires_at === null) delete key.expiresAt;
		else if (request.expires_at !== undefined) key.expiresAt = request.expires_at;
		if (request.scope !== undefined) key.scope = request.scope;
		if (request.plan_order !== undefined) key.planOrder = request.plan_order;
		this.#validateKey(key, original);
		if (valueHash(keyPolicy(key)) === valueHash(keyPolicy(original)))
			return {
				applied: false,
				current: this.key(name),
				policyVersion: this.#policyVersion,
				auditIds: [],
				eventIds: [],
			};
		return this.#transaction(stage => {
			const draft = new Map(stage.keys);
			draft.set(name, key);
			validateAllocations(draft, this.#plans, stage.allocationVersion);
			this.#commitKeys(stage, draft, [name]);
			const auditId = this.#audit(stage, actor, "key.patch", [`key:${name}`], keyPolicy(original), keyPolicy(key));
			const eventId = this.#event(
				stage,
				"key_changed",
				{ key: name, rev: key.rev, policyVersion: stage.policyVersion, auditId },
				this.#policyResources(stage, [name]),
				{ key: name },
			);
			return {
				applied: true,
				current: this.#models(stage.now, stage.keys, stage).key(key),
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	revoke(actor: string, name: string, etag: string | null): MutationResult<KeyView> {
		this.#assertReady();
		const original = this.#checkKeyMatch(name, etag);
		if (original.revoked)
			return {
				applied: false,
				current: this.key(name),
				policyVersion: this.#policyVersion,
				auditIds: [],
				eventIds: [],
			};
		return this.#transaction(stage => {
			const key = { ...structuredClone(original), enabled: false, revoked: true };
			delete key.rotationGraceUntil;
			for (const row of stage.tokens.values())
				if (row.key === name) {
					stage.tokens.delete(row.digest);
					this.#database.remove("key_tokens", row.digest);
				}
			const draft = new Map(stage.keys);
			draft.set(name, key);
			this.#commitKeys(stage, draft, [name]);
			const auditId = this.#audit(stage, actor, "key.revoke", [`key:${name}`], keyPolicy(original), keyPolicy(key));
			const eventId = this.#event(
				stage,
				"key_revoked",
				{ key: name, rev: key.rev, policyVersion: stage.policyVersion, auditId },
				this.#policyResources(stage, [name]),
				{ key: name },
			);
			return {
				applied: true,
				current: this.#models(stage.now, stage.keys, stage).key(key),
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	rotate(actor: string, name: string, graceS: number, etag: string | null): MutationResult<KeyTokenResult> {
		this.#assertReady();
		const original = this.#checkKeyMatch(name, etag);
		if (!Number.isInteger(graceS) || graceS < 0 || graceS > 3600)
			throw new SwitchError(422, "validation", "Rotation grace must be between 0 and 3600 seconds");
		if (original.revoked) throw new SwitchError(409, "name_taken", "A revoked Key cannot be rotated");
		return this.#transaction(stage => {
			const key = structuredClone(original);
			const graceUntil = graceS > 0 ? stage.now + graceS * 1000 : undefined;
			if (graceUntil !== undefined) key.rotationGraceUntil = graceUntil;
			else delete key.rotationGraceUntil;
			for (const row of [...stage.tokens.values()])
				if (row.key === name) {
					if (row.current && graceUntil !== undefined) {
						const prior: KeyTokenRecord = {
							key: name,
							digest: row.digest,
							current: false,
							validUntil: graceUntil,
						};
						stage.tokens.set(row.digest, prior);
						this.#database.put("key_tokens", row.digest, prior);
					} else {
						stage.tokens.delete(row.digest);
						this.#database.remove("key_tokens", row.digest);
					}
				}
			const { token, digest } = this.#freshToken(stage);
			const row: KeyTokenRecord = { key: name, digest, current: true, ...(!key.sealed ? { plaintext: token } : {}) };
			stage.tokens.set(row.digest, row);
			this.#database.put("key_tokens", row.digest, row);
			const draft = new Map(stage.keys);
			draft.set(name, key);
			this.#commitKeys(stage, draft, [name]);
			const auditId = this.#audit(
				stage,
				actor,
				"key.rotate",
				[`key:${name}`],
				{ rev: original.rev },
				{ rev: key.rev, graceUntil: graceUntil ?? null },
			);
			const eventId = this.#event(
				stage,
				"key_rotated",
				{
					key: name,
					rev: key.rev,
					policyVersion: stage.policyVersion,
					auditId,
					...(graceUntil !== undefined ? { graceUntil } : {}),
				},
				this.#policyResources(stage, [name]),
				{ key: name },
			);
			return {
				applied: true,
				current: { key: this.#models(stage.now, stage.keys, stage).key(key), token },
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	async backup(
		actor: string,
		requested: string,
		etag: string | null,
		authorize: () => void,
	): Promise<ReadEnvelope<MutationResult<BackupResult>>> {
		this.#assertReady();
		this.checkPolicyMatch(etag);
		const root = this.#config.admin?.backupDir;
		if (!root) throw new SwitchError(503, "unavailable", "Admin backup storage is not configured");
		const capturedPolicyVersion = this.#policyVersion;
		const snapshot = await createBackup(this.#database, root, requested, () => {
			authorize();
			this.checkPolicyMatch(etag);
		});
		return this.envelope(() =>
			this.#transaction(stage => {
				const backupId = crypto.randomUUID();
				const auditId = this.#audit(stage, actor, "backup", [], null, {
					backupId,
					bytes: snapshot.bytes,
					snapshotPolicyVersion: capturedPolicyVersion,
				});
				const eventId = this.#event(stage, "backup_created", { backupId, auditId }, [
					{ kind: "audit", version: auditId },
					{ kind: "events", version: auditId },
				]);
				return {
					applied: true,
					current: { backupId, ...snapshot },
					policyVersion: stage.policyVersion,
					auditIds: [auditId],
					eventIds: [eventId],
				};
			}),
		);
	}

	exportKeys(actor: string, includeTokens: boolean): ExportView {
		this.#assertReady();
		const keys = [...this.#keys.values()]
			.filter(key => !key.revoked)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(key => {
				const policy = exportPolicy(key);
				if (includeTokens) {
					const token = [...this.#tokens.values()].find(row => row.key === key.name && row.current);
					if (!token) throw new SwitchError(409, "sealed", "The Key has no exportable current credential");
					if (key.sealed) policy.digest = token.digest;
					else if (token.plaintext !== undefined) policy.token = token.plaintext;
					else
						throw new SwitchError(
							409,
							"sealed",
							"The Key plaintext is unavailable; explicitly rotate before token export",
						);
				}
				return policy;
			});
		const content = serializeKeyDocument(keys);
		if (includeTokens)
			this.#transaction(stage => {
				const auditId = this.#audit(
					stage,
					actor,
					"keys.export",
					keys.map(key => `key:${key.name}`),
					null,
					{ secretsIncluded: true, keys: keys.map(key => key.name) },
				);
				this.#event(stage, "admin_action", { action: "export", auditId, result: "ok" }, [
					{ kind: "audit", version: auditId },
					{ kind: "events", version: auditId },
				]);
			});
		return { format: "toml", content, policyEtag: this.policyEtag, secretsIncluded: includeTokens };
	}

	#importChanges(effect: ImportEffect, now: number, stage?: TransactionState): ImportChange[] {
		const before = this.#models(now);
		const after = this.#models(now, effect.keys, stage);
		return effect.changes.map(change => ({
			...change,
			...(this.#keys.has(change.name) ? { before: before.key(this.#keys.get(change.name)!) } : {}),
			after: after.key(effect.keys.get(change.name)!),
		}));
	}

	importPreview(actor: string, input: ImportRequest): ImportPreview {
		this.#assertReady();
		const request = parseImportRequest(input);
		const now = this.#clock();
		const effect = prepareImport(this.#context(now, actor), this.#tokens, request);
		if (effect.issues.length) return { changes: [], issues: effect.issues, policyEtag: this.policyEtag };
		return {
			changes: this.#importChanges(effect, now),
			issues: [],
			policyEtag: this.policyEtag,
			preview: this.#signatures.import({
				schema: 1,
				bootEpoch: this.bootEpoch,
				actor,
				generation: this.#generation,
				policyVersion: this.#policyVersion,
				contentHash: effect.contentHash,
				mode: request.mode,
				effectHash: valueHash(effect.effect),
				issuedAt: now,
				expiresAt: now + 300_000,
			}),
		};
	}

	importKeys(actor: string, input: ImportApplyRequest, etag: string | null): MutationResult<ImportResult> {
		this.#assertReady();
		this.checkPolicyMatch(etag);
		const request = parseImportRequest(input, true);
		const basis = this.#signatures.readImport(request.preview);
		if (
			basis.schema !== 1 ||
			basis.bootEpoch !== this.bootEpoch ||
			basis.actor !== actor ||
			basis.generation !== this.#generation ||
			basis.policyVersion !== this.#policyVersion ||
			basis.mode !== request.mode ||
			basis.expiresAt <= this.#clock()
		)
			throw new SwitchError(409, "stale_preview", "Import preview no longer matches current policy");
		return this.#transaction(stage => {
			const effect = prepareImport(this.#context(stage.now, actor), stage.tokens, request);
			if (effect.issues.length)
				throw new SwitchError(422, "validation", "Import policy is invalid", {
					issues: effect.issues,
					current: { policyEtag: this.policyEtag },
				});
			if (basis.contentHash !== effect.contentHash || basis.effectHash !== valueHash(effect.effect))
				throw new SwitchError(409, "stale_preview", "Import no longer has the reviewed effect", {
					current: { policyEtag: this.policyEtag },
				});
			if (!effect.changes.length)
				return {
					applied: false,
					current: { keys: [], createdTokens: [], changes: [] },
					policyVersion: stage.policyVersion,
					auditIds: [],
					eventIds: [],
				};
			const replacing = new Set(effect.credentials.map(row => row.name));
			for (const change of effect.changes) if (change.operation === "revoke") replacing.add(change.name);
			for (const row of [...stage.tokens.values()])
				if (replacing.has(row.key)) {
					stage.tokens.delete(row.digest);
					this.#database.remove("key_tokens", row.digest);
				}
			const createdTokens: ImportResult["createdTokens"] = [];
			for (const credential of effect.credentials) {
				const key = effect.keys.get(credential.name)!;
				const material = credential.generate
					? this.#freshToken(stage)
					: {
							token: credential.token,
							digest: credential.token !== undefined ? tokenDigest(credential.token) : credential.digest!,
						};
				if (stage.tokens.has(material.digest))
					throw new SwitchError(422, "validation", "Import contains a duplicate credential");
				const row: KeyTokenRecord = {
					key: key.name,
					digest: material.digest,
					current: true,
					...(!key.sealed && material.token !== undefined ? { plaintext: material.token } : {}),
				};
				stage.tokens.set(row.digest, row);
				this.#database.put("key_tokens", row.digest, row);
				if (credential.generate) createdTokens.push({ name: key.name, token: material.token! });
			}
			for (const row of stage.tokens.values())
				if (effect.keys.get(row.key)?.sealed && row.plaintext !== undefined) {
					const { plaintext: _plaintext, ...sealed } = row;
					stage.tokens.set(row.digest, sealed);
					this.#database.put("key_tokens", row.digest, sealed);
				}
			const names = effect.changes.map(change => change.name);
			this.#commitKeys(stage, effect.keys, names);
			const changes = this.#importChanges(effect, stage.now, stage);
			const auditId = this.#audit(
				stage,
				actor,
				"keys.import",
				names.map(name => `key:${name}`),
				names.map(name => (this.#keys.has(name) ? keyPolicy(this.#keys.get(name)!) : null)),
				effect.changes.map(change => ({
					policy: keyPolicy(effect.keys.get(change.name)!),
					credentialChanged: change.credentialChanged,
					operation: change.operation,
				})),
			);
			const eventId = this.#event(
				stage,
				"import_applied",
				{
					mode: request.mode,
					created: effect.changes.filter(change => change.operation === "create").map(change => change.name),
					updated: effect.changes.filter(change => change.operation === "update").map(change => change.name),
					revoked: effect.changes.filter(change => change.operation === "revoke").map(change => change.name),
					policyVersion: stage.policyVersion,
					auditId,
				},
				this.#policyResources(stage, names),
			);
			const views = this.#models(stage.now, stage.keys, stage);
			const affected = [
				...new Set([...names, ...views.allocations().flatMap(allocation => allocation.keys.map(key => key.key))]),
			].sort();
			return {
				applied: true,
				current: { keys: affected.map(name => views.key(stage.keys.get(name)!)), createdTokens, changes },
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	reveal(actor: string, name: string, etag: string | null): MutationResult<KeyTokenResult> {
		this.#assertReady();
		const key = this.#checkKeyMatch(name, etag);
		const token = [...this.#tokens.values()].find(row => row.key === name && row.current)?.plaintext;
		if (key.sealed || token === undefined)
			throw new SwitchError(409, "sealed", "This Key has no revealable token; rotate it instead");
		return this.#transaction(stage => {
			const auditId = this.#audit(stage, actor, "key.reveal", [`key:${name}`], null, { key: name });
			const eventId = this.#event(
				stage,
				"key_revealed",
				{ key: name, auditId },
				[
					{ kind: "audit", version: auditId },
					{ kind: "events", version: auditId },
				],
				{ key: name },
			);
			return {
				applied: true,
				current: { key: this.#models(stage.now).key(key), token },
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	#previewChoice(
		actor: string,
		name: string,
		adjustment: Adjustment,
		meaningId: PreviewChoice["meaningId"],
		label: string,
		now: number,
	): PreviewChoice {
		try {
			const effect = applyAdjustmentDraft(this.#context(now, actor), name, parseAdjustment(adjustment));
			const keyRevs: Record<string, number> = { [name]: this.#keys.get(name)!.rev };
			for (const key of effect.changed) keyRevs[key] = this.#keys.get(key)!.rev;
			if (adjustment.op === "transfer") keyRevs[adjustment.from] = this.#keys.get(adjustment.from)!.rev;
			const expiresAt = now + 300_000;
			const basis: PreviewBasis = {
				schema: 1,
				bootEpoch: this.bootEpoch,
				actor,
				target: name,
				operationHash: valueHash(effect.adjustment),
				keyRevs,
				generation: this.#generation,
				dependencies: effect.dependencies,
				effectHash: valueHash(effect.effect),
				issuedAt: now,
				expiresAt,
			};
			const names = [
				...new Set([name, ...effect.changed, ...effect.allocations.flatMap(row => row.keys.map(key => key.key))]),
			].sort();
			const before = this.#models(now);
			const after = this.#models(now, effect.keys);
			return {
				meaningId,
				status: "ready",
				label,
				adjustment: effect.adjustment,
				issues: [],
				before: names.map(id => before.key(this.#keys.get(id)!)),
				after: names.map(id => after.key(effect.keys.get(id)!)),
				allocationEffects: effect.allocations,
				lifetime: effect.lifetime,
				warnings: effect.warnings,
				preview: this.#signatures.preview(basis),
				expiresAt,
			};
		} catch (error) {
			if (!(error instanceof SwitchError)) throw error;
			return {
				meaningId,
				status: "invalid",
				label,
				issues: error.detail?.issues ?? [{ code: error.code, path: "adjustment", message: error.message }],
				warnings: [],
			};
		}
	}

	preview(actor: string, name: string, input: AdjustmentPreviewRequest): Preview {
		this.#assertReady();
		const key = this.#keys.get(name) ?? notFound("Key");
		const request = parsePreviewRequest(input);
		const now = this.#clock();
		if (request.mode === "operation")
			return {
				subject: { key: name },
				observedAt: now,
				generation: this.#generation,
				choices: [
					this.#previewChoice(actor, name, request.adjustment, request.adjustment.op, request.adjustment.op, now),
				],
			};
		const subject = request.subject;
		const candidates =
			"budget" in subject
				? key.budgets.filter(row => row.id === subject.budget)
				: key.budgets.filter(
						row =>
							row.scope.plan === subject.plan &&
							(row.scope.meter ?? (row.window.kind === "plan" ? row.window.meter : undefined)) === subject.meter,
					);
		const budget = candidates.length === 1 ? candidates[0] : undefined;
		const planId = "plan" in subject ? subject.plan : budget?.scope.plan;
		const meterId =
			"meter" in subject
				? subject.meter
				: (budget?.scope.meter ?? (budget?.window.kind === "plan" ? budget.window.meter : undefined));
		const definitions: {
			id: MeaningId;
			label: string;
			adjustment?: Adjustment;
			required?: string[];
			incompatible?: string;
		}[] = [
			{
				id: "permanent-points",
				label: "Change the base cap by this amount",
				...(budget
					? { adjustment: { op: "budget.raise", budget: budget.id, by: request.number } as Adjustment }
					: { required: ["budget"] }),
			},
			{
				id: "permanent-percent",
				label: "Change the base cap by this percentage",
				...(budget
					? { adjustment: { op: "budget.scale", budget: budget.id, percent: request.number } as Adjustment }
					: { required: ["budget"] }),
			},
			{
				id: "window-points",
				label: "Add this amount until the current window ends",
				...(budget
					? {
							adjustment: {
								op: "grant.add",
								budget: budget.id,
								amount: request.number,
								until: "window",
							} as Adjustment,
						}
					: { required: ["budget"] }),
			},
			{
				id: "plan-remaining-percent",
				label: "Add this percentage of the shared Plan remainder",
				...(budget
					? budget.unit === "plan_pct"
						? {
								adjustment: {
									op: "grant.add",
									budget: budget.id,
									percent_of_plan_remaining: request.number,
									until: "window",
								} as Adjustment,
							}
						: { incompatible: "This meaning requires a percentage-point Budget" }
					: { required: ["budget"] }),
			},
			{
				id: "restore-free-percent",
				label: "Restore unspent balance to this percentage of base cap",
				...(budget
					? {
							adjustment: {
								op: "grant.add",
								budget: budget.id,
								to_remaining_percent: request.number,
								until: "window",
							} as Adjustment,
						}
					: { required: ["budget"] }),
			},
			{
				id: "gate-points",
				label: "Change the shared Meter Gate by this many points",
				...(planId && meterId
					? { adjustment: { op: "gate.raise", plan: planId, meter: meterId, by: request.number } as Adjustment }
					: { incompatible: "This Budget has no associated Plan Meter" }),
			},
			{
				id: "duration-points",
				label: "Add this amount for the selected duration",
				...(budget && request.duration
					? {
							adjustment: {
								op: "grant.add",
								budget: budget.id,
								amount: request.number,
								until: request.duration,
							} as Adjustment,
						}
					: { required: [...(!budget ? ["budget"] : []), ...(!request.duration ? ["duration"] : [])] }),
			},
			{
				id: "transfer-points",
				label: "Transfer this allowance from the selected donor",
				...(budget && request.donor
					? {
							adjustment: {
								op: "transfer",
								from: request.donor,
								to: name,
								budget: budget.id,
								amount: request.number,
								until: request.duration ?? "window",
							} as Adjustment,
						}
					: { required: [...(!budget ? ["budget"] : []), ...(!request.donor ? ["donor"] : [])] }),
			},
			{
				id: "suspend-enforcement",
				label: "Temporarily use soft Budget enforcement; continue counting",
				...(budget && request.duration
					? { adjustment: { op: "budget.suspend", budget: budget.id, until: request.duration } as Adjustment }
					: { required: [...(!budget ? ["budget"] : []), ...(!request.duration ? ["duration"] : [])] }),
			},
			{
				id: "new-window",
				label: "Add another Budget with this cap and a selected window",
				...(request.newBudget
					? {
							adjustment: {
								op: "budget.add",
								budget: { ...request.newBudget, cap: request.number },
							} as Adjustment,
						}
					: { required: ["newBudget"] }),
			},
		];
		const choices = definitions.map(row =>
			row.adjustment
				? this.#previewChoice(actor, name, row.adjustment, row.id, row.label, now)
				: {
						meaningId: row.id,
						label: row.label,
						status: row.incompatible ? ("not_applicable" as const) : ("needs_input" as const),
						issues: row.incompatible
							? [{ code: "not_applicable", path: "subject", message: row.incompatible }]
							: [],
						warnings: [],
						...(row.required ? { requiredFields: row.required } : {}),
					},
		);
		return {
			subject: { key: name, ...subject },
			number: request.number,
			observedAt: now,
			generation: this.#generation,
			choices,
		};
	}

	adjust(actor: string, name: string, request: AdjustRequest, etag: string | null): MutationResult<AdjustResult> {
		this.#assertReady();
		this.#checkKeyMatch(name, etag);
		const adjustment = parseAdjustment(request.adjustment);
		const basis = this.#signatures.readPreview(request.preview);
		const now = this.#clock();
		if (
			basis.schema !== 1 ||
			basis.bootEpoch !== this.bootEpoch ||
			basis.actor !== actor ||
			basis.target !== name ||
			basis.generation !== this.#generation ||
			basis.expiresAt <= now ||
			basis.operationHash !== valueHash(adjustment)
		)
			throw new SwitchError(409, "stale_preview", "Preview no longer applies to this operation and session");
		for (const [id, rev] of Object.entries(basis.keyRevs))
			if (this.#keys.get(id)?.rev !== rev)
				throw new SwitchError(409, "stale_rev", "A reviewed Key policy changed", {
					current: this.#keys.has(id) ? this.key(id) : null,
					changed: [id],
				});
		const effect = applyAdjustmentDraft(this.#context(now, actor), name, adjustment);
		for (const [dependency, value] of Object.entries(basis.dependencies))
			if (dependency.startsWith("instance:") && effect.dependencies[dependency] !== value)
				throw new SwitchError(409, "stale_preview", "A reviewed window changed", { changed: [dependency] });
		if (valueHash(effect.effect) !== basis.effectHash)
			throw new SwitchError(409, "stale_preview", "The reviewed effect or eligibility changed", {
				current: this.key(name),
				changed: ["effect"],
			});
		if (!effect.changed.length)
			return {
				applied: false,
				current: { keys: [this.key(name)], allocations: effect.allocations },
				policyVersion: this.#policyVersion,
				auditIds: [],
				eventIds: [],
			};
		return this.#transaction(stage => {
			const before = effect.changed.map(id => keyPolicy(stage.keys.get(id)!));
			this.#commitKeys(stage, effect.keys, effect.changed);
			const auditId = this.#audit(
				stage,
				actor,
				adjustment.op,
				effect.changed.map(id => `key:${id}`),
				before,
				effect.changed.map(id => keyPolicy(stage.keys.get(id)!)),
			);
			const resources = this.#policyResources(stage, effect.changed);
			const names = [
				...new Set([name, ...effect.changed, ...effect.allocations.flatMap(row => row.keys.map(key => key.key))]),
			].sort();
			for (const id of names)
				if (!effect.changed.includes(id))
					resources.push({ kind: "key", id, version: `${stage.keys.get(id)!.rev}:${stage.allocationVersion}` });
			const eventId = this.#event(
				stage,
				"allotment_changed",
				{
					operation: adjustment.op,
					affectedKeys: names,
					policyVersion: stage.policyVersion,
					auditId,
					system: false,
				},
				resources,
				{ key: name },
			);
			const views = this.#models(stage.now, stage.keys, stage);
			return {
				applied: true,
				current: { keys: names.map(id => views.key(stage.keys.get(id)!)), allocations: views.allocations() },
				policyVersion: stage.policyVersion,
				auditIds: [auditId],
				eventIds: [eventId],
			};
		});
	}

	#evaluate(input: AdmissionInput, now: number): { result: AdmissionResult; attempt?: AttemptRecord } {
		const key = input.principal.kind === "key" ? this.#keys.get(input.principal.id) : undefined;
		if (
			input.principal.kind === "key" &&
			(!key || !key.enabled || key.revoked || (key.expiresAt !== undefined && now >= key.expiresAt))
		) {
			throw new SwitchError(403, "permission_error", "The Key is disabled, revoked, expired or absent");
		}
		input.checkAuthority(key?.scope);
		const plans = input.plan ? new Map(this.#plans).set(input.plan.config.id, input.plan) : this.#plans;
		const views = this.#models(now, this.#keys, undefined, plans);
		const estimate = structuredClone(input.estimate);
		estimate.planPct = {};
		if (!/^[a-f0-9]{64}$/.test(input.preparedFingerprint))
			throw new Error("Admission requires the prepared request fingerprint");
		if (
			![estimate.tokens, estimate.usd, estimate.weight, ...Object.values(estimate.planPct)].every(
				value => Number.isFinite(value) && value >= 0,
			) ||
			estimate.requests !== 1
		) {
			throw new SwitchError(422, "validation", "The prepared estimate is invalid");
		}
		const reservation: Reservation = { budgets: [], meters: [] };
		const frozenMeters: AttemptRecord["frozenMeters"] = [];
		const projections = new Map<string, number>();
		let stale = false;
		const denied = (
			status: number,
			code: string,
			kind: "plan" | "gate" | "budget",
			id: string,
			used?: number,
			limit?: number,
			unit?: Budget["unit"],
			plan?: string,
			meter?: string,
			resetsAt?: number,
		) => ({
			result: {
				admitted: false,
				stale,
				denial: {
					status,
					code,
					constraint: {
						kind,
						id,
						...(key ? { key: key.name } : {}),
						...(plan ? { plan } : {}),
						...(meter ? { meter } : {}),
					},
					...(used !== undefined ? { used } : {}),
					...(limit !== undefined ? { limit } : {}),
					...(unit ? { unit } : {}),
					...(resetsAt !== undefined
						? { resetsAt, retryAfterS: Math.max(0, Math.ceil((resetsAt - now) / 1000)) }
						: {}),
				},
			},
		});
		if (input.plan) {
			const plan = input.plan;
			if (plan.resolution !== "resolved" || this.#uncertainBindings.has(planBindingKey(input.generation, plan)))
				return denied(
					503,
					"plan_unresolved",
					"plan",
					plan.config.id,
					undefined,
					undefined,
					undefined,
					plan.config.id,
				);
			if (!sameBinding(plan.binding, input.binding))
				throw new Error("Prepared credential does not match the Plan binding");
			const entry = key?.plans.find(row => row.plan === plan.config.id);
			if (key && !entry)
				return denied(
					403,
					"plan_not_allotted",
					"plan",
					plan.config.id,
					undefined,
					undefined,
					undefined,
					plan.config.id,
				);
			const meters = views.meters(plan);
			const gates = key ? entry!.gates : (input.anonymousGates ?? []);
			if (
				(!meters.length && (plan.binding || gates.length)) ||
				plan.config.meters?.some(id => !meters.some(meter => meter.meter === id))
			)
				return denied(
					503,
					"meter_unavailable",
					"plan",
					plan.config.id,
					undefined,
					undefined,
					undefined,
					plan.config.id,
				);
			for (const meter of meters) {
				const gate = gates.find(row => row.meter === meter.meter) ?? gates.find(row => row.meter === "*");
				if (!key && !gate)
					return denied(
						403,
						"anonymous_gate_required",
						"gate",
						meter.meter,
						undefined,
						undefined,
						undefined,
						plan.config.id,
						meter.meter,
					);
				const frozen = {
					meter: meter.meter,
					instance: meter.instance.id,
					mode: plan.config.attribution,
					...(meter.pointsPerWeight !== undefined ? { pointsPerWeight: meter.pointsPerWeight } : {}),
					...(meter.pointsPerToken !== undefined ? { pointsPerToken: meter.pointsPerToken } : {}),
					...(plan.config.size?.[meter.meter] ? { size: plan.config.size[meter.meter] } : {}),
				};
				const points = meterPoints(estimate, frozen);
				estimate.planPct[meter.meter] = points;
				const projection = evaluateGate(
					plan.config,
					meter,
					gate,
					views.debt(meter).total,
					views.inflight(meter),
					points,
					now,
				);
				if (projection.denial)
					return denied(
						projection.denial === "meter_unavailable" ? 503 : 429,
						projection.denial,
						gate ? "gate" : "plan",
						meter.meter,
						projection.projected,
						projection.limit,
						"plan_pct",
						plan.config.id,
						meter.meter,
						meter.resetsAt,
					);
				stale ||= projection.stale;
				projections.set(meter.meter, projection.projected);
				frozenMeters.push(frozen);
				reservation.meters.push({
					plan: plan.config.id,
					meter: meter.meter,
					instance: meter.instance.id,
					amount: points,
				});
			}
		}
		if (key) {
			for (const budget of key.budgets) {
				if (!matchesBudget(budget, { provider: input.provider, model: input.model, plan: input.plan?.config.id }))
					continue;
				const view = views.budget(key, budget);
				if (budget.window.kind === "plan" && !view.instance)
					return denied(
						503,
						"meter_unavailable",
						"budget",
						budget.id,
						view.used,
						view.capEff,
						budget.unit,
						budget.scope.plan,
						budget.window.meter,
					);
				const meter = budget.scope.meter ?? (budget.window.kind === "plan" ? budget.window.meter : undefined);
				const amount = budget.unit === "plan_pct" ? estimate.planPct[meter!] : estimate[budget.unit];
				if (amount === undefined || !Number.isFinite(amount))
					return denied(
						503,
						"meter_unavailable",
						"budget",
						budget.id,
						view.used,
						view.capEff,
						budget.unit,
						budget.scope.plan,
						meter,
					);
				const full =
					budget.unit === "requests"
						? view.used + view.reserved + amount > view.capEff
						: view.used + view.reserved >= view.capEff;
				if (full && view.policyEffective === "hard")
					return denied(
						429,
						"allotment_exhausted",
						"budget",
						budget.id,
						view.used + view.reserved,
						view.capEff,
						budget.unit,
						budget.scope.plan,
						meter,
						view.instance?.resetsAt,
					);
				if (
					full &&
					view.policyEffective === "burst" &&
					(meter === undefined || !projections.has(meter) || projections.get(meter)! >= budget.burstBelow!)
				)
					return denied(
						429,
						"allotment_exhausted",
						"budget",
						budget.id,
						view.used + view.reserved,
						view.capEff,
						budget.unit,
						budget.scope.plan,
						meter,
						view.instance?.resetsAt,
					);
				reservation.budgets.push({
					key: key.name,
					budget: budget.id,
					unit: budget.unit,
					amount: budget.unit !== "requests" && !full ? Math.min(amount, view.remaining) : amount,
					...(view.instance ? { instance: view.instance.id } : {}),
					window: structuredClone(budget.window),
					scope: structuredClone(budget.scope),
				});
			}
		}
		const attempt: AttemptRecord = {
			id: input.id,
			decisionId: input.decisionId,
			principal: { ...input.principal },
			provider: input.provider,
			model: input.model,
			usageProvider: input.usageProvider,
			preparedFingerprint: input.preparedFingerprint,
			generation: input.generation,
			...(input.plan ? { plan: input.plan.config.id } : {}),
			...(input.binding ? { binding: { ...input.binding } } : {}),
			...(input.parentCallId ? { parentCallId: input.parentCallId } : {}),
			...(input.purpose ? { purpose: input.purpose } : {}),
			estimate,
			frozenMeters,
			reservation,
			upstreamCalled: false,
			committed: false,
			requestCounted: false,
			transportSettled: false,
			settled: false,
			billed: false,
			status: 0,
			startedAt: now,
			stale,
			unpriced: input.unpriced,
		};
		return { result: { admitted: true, stale }, attempt };
	}

	admit(input: AdmissionInput, dry = false): AdmissionResult {
		this.#assertReady();
		if (!dry && !this.#accepting) throw new SwitchError(503, "draining", "Switch is not accepting new Attempts");
		if (dry) return this.#evaluate(input, this.#clock()).result;
		return this.#transaction(stage => {
			const evaluated = this.#evaluate(input, stage.now);
			if (!evaluated.attempt) return evaluated.result;
			if (this.#database.get("attempts", input.id)) throw new Error("Attempt id was reused");
			this.#database.put("attempts", input.id, evaluated.attempt);
			stage.holds.set(input.id, evaluated.attempt);
			stage.accountingVersion++;
			this.#invalidate(stage, "state", this.#accountingResources(stage, evaluated.attempt));
			return evaluated.result;
		});
	}

	/** Commit launch evidence and immediately invoke the runner without an intervening await. */
	launch<T>(attemptId: string, preparedFingerprint: string, runner: () => T, signal?: AbortSignal): T {
		this.#assertReady();
		if (!this.#accepting) throw new SwitchError(503, "draining", "Switch is not accepting new Attempts");
		if (signal?.aborted) throw new SwitchError(499, "request_aborted", "Request was cancelled before launch");
		this.#transaction(stage => {
			const attempt = this.#database.get("attempts", attemptId) ?? notFound("Attempt");
			if (attempt.settled || attempt.upstreamCalled)
				throw new Error("Attempt cannot launch twice or after settlement");
			if (attempt.preparedFingerprint !== preparedFingerprint)
				throw new Error("Prepared request changed after admission");
			attempt.upstreamCalled = true;
			attempt.launchAt = stage.now;
			this.#database.put("attempts", attempt.id, attempt);
			stage.holds.set(attempt.id, attempt);
		});
		return runner();
	}

	markCommitted(attemptId: string): void {
		this.#assertReady();
		this.#transaction(stage => {
			const attempt = this.#database.get("attempts", attemptId) ?? notFound("Attempt");
			if (attempt.settled || attempt.committed) return;
			attempt.committed = true;
			this.#database.put("attempts", attempt.id, attempt);
			stage.holds.set(attempt.id, attempt);
		});
	}

	attempt(id: string): AttemptRecord {
		this.#assertReady();
		return this.#database.get("attempts", id) ?? notFound("Attempt");
	}

	#chargeInstances(
		stage: TransactionState,
		attempt: AttemptRecord,
		phase: "request" | "final",
		consumption: ConsumptionView,
	): Record<string, string> {
		const refs: Record<string, string> = {};
		for (const frozen of attempt.frozenMeters) {
			const meter = [...stage.meters.values()].find(
				row => row.plan === attempt.plan && row.meter === frozen.meter && sameBinding(row.binding, attempt.binding),
			);
			refs[meterKey(attempt.plan!, frozen.meter)] = meter?.instance.id ?? frozen.instance;
		}
		if (attempt.principal.kind !== "key") return refs;
		const key = stage.keys.get(attempt.principal.id);
		if (!key) return refs;
		for (const budget of key.budgets) {
			if (!matchesBudget(budget, attempt) || budget.window.kind === "rolling" || budget.window.kind === "plan")
				continue;
			const frozen = attempt.frozenMeters.find(row => row.meter === budget.scope.meter);
			const amount =
				budget.unit === "plan_pct"
					? phase === "request" || !frozen
						? 0
						: meterPoints({ ...consumption, requests: 1 }, frozen)
					: consumption[budget.unit];
			if (budget.window.kind === "calendar") {
				refs[budgetKey(key.name, budget.id)] = calendarWindow(
					stage.now,
					budget.window.period,
					this.#config.switch.timezone,
				).id;
				continue;
			}
			const id = budgetKey(key.name, budget.id);
			let instance = stage.instances.get(id);
			if (
				instance &&
				(!instance.id.startsWith(`anchored:${budget.window.ms}:`) ||
					(instance.resetsAt !== undefined && stage.now >= instance.resetsAt))
			)
				instance = undefined;
			if (!instance && amount > 0) {
				instance = {
					id: `anchored:${budget.window.ms}:${stage.now}`,
					startedAt: stage.now,
					resetsAt: stage.now + budget.window.ms,
					endSource: "authoritative",
				};
				stage.instances.set(id, instance);
				this.#database.put("instances", id, instance);
				for (const held of stage.holds.values()) {
					const next = structuredClone(held);
					let changed = false;
					for (const hold of (next.pendingJobHold ?? next.reservation).budgets)
						if (
							hold.key === key.name &&
							hold.budget === budget.id &&
							hold.window.kind === "anchored" &&
							hold.window.ms === budget.window.ms
						) {
							hold.instance = instance.id;
							changed = true;
						}
					if (changed) {
						stage.holds.set(next.id, next);
						this.#database.put("attempts", next.id, next);
					}
				}
			}
			if (instance) refs[id] = instance.id;
		}
		return refs;
	}

	#accountingResources(stage: TransactionState, attempt: AttemptRecord): ResourceInvalidation[] {
		const resources: ResourceInvalidation[] = [
			{ kind: "overview", version: String(stage.accountingVersion) },
			{
				kind: "usage",
				...(attempt.principal.kind === "key" ? { id: attempt.principal.id } : {}),
				version: String(stage.accountingVersion),
			},
			{ kind: "decisions", id: attempt.decisionId, version: String(stage.accountingVersion) },
		];
		if (attempt.plan) resources.push({ kind: "plan", id: attempt.plan, version: String(stage.accountingVersion) });
		for (const key of stage.keys.values()) {
			if (
				(attempt.principal.kind === "key" && key.name === attempt.principal.id) ||
				key.plans.some(plan => plan.plan === attempt.plan)
			) {
				resources.push({ kind: "key", id: key.name, version: `${key.rev}:${stage.accountingVersion}` });
			}
		}
		return resources;
	}

	#bookUsage(
		stage: TransactionState,
		attempt: AttemptRecord,
		phase: "request" | "final",
		consumption: ConsumptionView,
		source: UsageRecord["source"],
	): void {
		const record: UsageRecord = {
			id: `${attempt.id}:${phase}`,
			phase,
			attemptId: attempt.id,
			principal: attempt.principal,
			provider: attempt.provider,
			model: attempt.model,
			...(attempt.plan ? { plan: attempt.plan } : {}),
			at: stage.now,
			minute: Math.floor(stage.now / 60_000) * 60_000,
			instances: this.#chargeInstances(stage, attempt, phase, consumption),
			consumption,
			source,
			unpriced: attempt.unpriced,
		};
		this.#database.put("usage_buckets", record.id, record);
		if (phase === "final") attempt.settlementInstances = record.instances;
	}

	#settle(attemptId: string, outcome: AttemptOutcome): SettlementResult {
		return this.#transaction(stage => {
			const attempt = this.#database.get("attempts", attemptId) ?? notFound("Attempt");
			if (attempt.settled) return { finalized: false, accepted: false, attempt };
			if (
				outcome.kind === "accepted-job" &&
				!["completed", "failed", "cancelled", "expired"].includes(outcome.status)
			) {
				const job = this.#database.get("jobs", outcome.jobId) ?? notFound("Job");
				if (!attempt.upstreamCalled || job.originAttemptId !== attempt.id)
					throw new Error("Job handoff has no matching launched Attempt");
				if (attempt.pendingJobHold) return { finalized: false, accepted: false, attempt };
				if (!attempt.requestCounted) {
					this.#bookUsage(stage, attempt, "request", { requests: 1, tokens: 0, usd: 0, weight: 0 }, "reported");
					attempt.requestCounted = true;
					attempt.requestCountedAt = stage.now;
				}
				attempt.pendingJobHold = {
					budgets: attempt.reservation.budgets.filter(hold => hold.unit !== "requests"),
					meters: attempt.reservation.meters,
					deadline: job.createdAt + 86_400_000,
				};
				attempt.reservation = { budgets: [], meters: [] };
				attempt.billed = true;
				attempt.transportSettled = true;
				attempt.transportSettledAt = stage.now;
				attempt.status = outcome.httpStatus;
				this.#database.put("attempts", attempt.id, attempt);
				stage.holds.set(attempt.id, attempt);
				stage.accountingVersion++;
				this.#invalidate(stage, "state", this.#accountingResources(stage, attempt));
				return { finalized: false, accepted: true, attempt };
			}
			let reported: ConsumptionView | undefined;
			if (
				(outcome.kind === "terminal" || outcome.kind === "job-terminal") &&
				(outcome.usage !== undefined || outcome.costUsd !== undefined)
			) {
				reported = outcome.usage
					? consumptionFromUsage(outcome.usage, 1, outcome.costUsd ?? outcome.usage.cost.total)
					: { requests: 1, tokens: 0, usd: outcome.costUsd!, weight: outcome.costUsd! };
				if (![reported.tokens, reported.usd, reported.weight].every(value => Number.isFinite(value) && value >= 0))
					throw new SwitchError(502, "invalid_usage", "Provider returned invalid consumption values");
			}
			const status =
				outcome.kind === "terminal" || outcome.kind === "forced"
					? outcome.status
					: outcome.kind === "accepted-job"
						? outcome.httpStatus
						: outcome.status === "completed"
							? 200
							: 502;
			const committed = attempt.committed || (outcome.kind === "terminal" && outcome.committed);
			const billed =
				attempt.upstreamCalled &&
				(attempt.requestCounted ||
					outcome.kind !== "terminal" ||
					committed ||
					(status >= 200 && status < 300) ||
					(reported !== undefined && (reported.tokens > 0 || reported.usd > 0)));
			const source: UsageRecord["source"] = reported
				? "reported"
				: outcome.kind === "forced"
					? "interrupted-estimate"
					: "estimate";
			const consumption: ConsumptionView = billed
				? (reported ?? {
						requests: 1,
						tokens: attempt.estimate.tokens,
						usd: attempt.estimate.usd,
						weight: attempt.estimate.weight,
					})
				: { requests: 0, tokens: 0, usd: 0, weight: 0 };
			if (
				reported &&
				(reported.usd > 0 ||
					((outcome.kind === "terminal" || outcome.kind === "job-terminal") && outcome.costUsd !== undefined))
			)
				attempt.unpriced = false;
			if (billed) {
				const requestDelta = attempt.requestCounted ? 0 : 1;
				this.#bookUsage(stage, attempt, "final", { ...consumption, requests: requestDelta }, source);
				if (!attempt.requestCounted) {
					attempt.requestCounted = true;
					attempt.requestCountedAt = stage.now;
				}
				for (const frozen of attempt.frozenMeters) {
					const meter = [...stage.meters.values()].find(
						row =>
							row.plan === attempt.plan &&
							row.meter === frozen.meter &&
							sameBinding(row.binding, attempt.binding),
					);
					const points = meterPoints({ ...consumption, requests: 1 }, frozen);
					const debit: DebitRecord = {
						attemptId: attempt.id,
						principal: attempt.principal,
						plan: attempt.plan!,
						meter: frozen.meter,
						instance: meter?.instance.id ?? frozen.instance,
						mode: frozen.mode,
						weight: consumption.weight,
						tokens: consumption.tokens,
						points,
						remainingUnobserved: points,
						precision:
							source !== "reported" ||
							frozen.mode === "proportional" ||
							(frozen.mode === "declared" &&
								frozen.size !== undefined &&
								"usd" in frozen.size &&
								attempt.unpriced)
								? "estimated"
								: frozen.mode === "declared"
									? "declared"
									: "measured",
						confirmedPct: 0,
						provisionalRemainingPct: frozen.mode === "proportional" ? points : 0,
						...(frozen.mode === "declared" ? { declaredPct: points } : {}),
						settledAt: stage.now,
					};
					this.#database.put(
						"meter_debits",
						JSON.stringify([attempt.id, debit.plan, debit.meter, debit.instance]),
						debit,
					);
				}
			}
			attempt.settled = true;
			attempt.settledAt = stage.now;
			attempt.transportSettled = true;
			attempt.transportSettledAt ??= stage.now;
			attempt.billed = billed;
			attempt.committed = committed;
			attempt.actual = consumption;
			attempt.actualSource = source;
			attempt.status = status;
			if (outcome.kind === "terminal" && outcome.cause) attempt.cause = outcome.cause;
			if (outcome.kind === "forced") attempt.cause = outcome.reason === "timeout" ? "timeout" : "draining";
			delete attempt.pendingJobHold;
			attempt.reservation = { budgets: [], meters: [] };
			this.#database.put("attempts", attempt.id, attempt);
			stage.holds.delete(attempt.id);
			stage.accountingVersion++;
			this.#invalidate(stage, "state", this.#accountingResources(stage, attempt));
			if (billed) stage.observations.push({ attempt, consumption });
			return { finalized: true, accepted: false, attempt };
		});
	}

	settle(attemptId: string, outcome: AttemptOutcome): SettlementResult {
		if (this.#closed) throw new Error("Store is closed");
		this.#maintain();
		return this.#settle(attemptId, outcome);
	}

	sealJob(attemptId: string, identity: JobIdentityInput): string {
		this.#assertReady();
		const job = this.#transaction(stage => {
			const attempt = this.#database.get("attempts", attemptId) ?? notFound("Attempt");
			if (!attempt.upstreamCalled) throw new Error("A Job cannot bind to an unlaunched Attempt");
			const existing = this.#database.jobForAttempt(attemptId);
			if (existing) {
				if (existing.upstreamId !== identity.upstreamId) throw new Error("One Attempt cannot acquire another Job");
				return existing;
			}
			const record: JobRecord = {
				id: crypto.randomUUID(),
				originAttemptId: attempt.id,
				principal: attempt.principal,
				provider: attempt.provider,
				model: attempt.model,
				...(attempt.plan ? { plan: attempt.plan } : {}),
				...(attempt.binding ? { binding: attempt.binding } : {}),
				upstreamId: identity.upstreamId,
				...(identity.pollingUrl ? { pollingUrl: identity.pollingUrl } : {}),
				...(identity.generationId ? { generationId: identity.generationId } : {}),
				createdAt: stage.now,
				lastStatus: identity.status,
			};
			this.#database.put("jobs", record.id, record);
			return record;
		});
		return this.#signatures.job(job.id);
	}

	openJob(token: string, principal: AccountingPrincipal, checkAuthority: (job: JobRecord) => void): OpenJobResult {
		this.#assertReady();
		const id = this.#signatures.readJob(token);
		const job = this.#database.get("jobs", id) ?? notFound("Job");
		if (job.principal.kind !== principal.kind || job.principal.id !== principal.id) notFound("Job");
		checkAuthority(job);
		if (this.#clock() - job.createdAt >= 86_400_000) {
			const attempt = this.#database.get("attempts", job.originAttemptId) ?? notFound("Attempt");
			if (!attempt.settled) this.#settle(attempt.id, { kind: "forced", reason: "job-expired", status: 410 });
			throw new SwitchError(410, "job_expired", "Job id expired");
		}
		return { job, attempt: this.#database.get("attempts", job.originAttemptId) ?? notFound("Attempt") };
	}

	completeJob(jobId: string, outcome: Extract<AttemptOutcome, { kind: "job-terminal" }>): boolean {
		this.#assertReady();
		const job = this.#database.get("jobs", jobId) ?? notFound("Job");
		const result = this.#settle(job.originAttemptId, { ...outcome, jobId });
		this.#transaction(() => {
			const observed = {
				...job,
				lastStatus: outcome.status,
				...(outcome.usage
					? {
							observedConsumption: consumptionFromUsage(
								outcome.usage,
								1,
								outcome.costUsd ?? outcome.usage.cost.total,
							),
						}
					: {}),
			};
			this.#database.put("jobs", job.id, observed);
		});
		return result.finalized;
	}

	shutdown(): void {
		if (this.#closed) return;
		this.#ready = false;
		this.#accepting = false;
		// The request controller has quiesced/forced live transports; detached Jobs still have financial owners.
		for (const attempt of this.#database.unfinished())
			this.#settle(attempt.id, { kind: "forced", reason: "shutdown", status: 503 });
		this.#listeners.clear();
		this.#closed = true;
		this.#database.close();
	}

	#failMeters(stage: TransactionState, owner: ResolvedPlan): void {
		for (const [id, previous] of stage.meters) {
			if (
				previous.plan !== owner.config.id ||
				!sameBinding(previous.binding, owner.binding) ||
				previous.source === "failed"
			)
				continue;
			const meter: MeterRecord = { ...previous, source: "failed", version: previous.version + 1 };
			stage.meters.set(id, meter);
			this.#database.put("meter_snapshots", JSON.stringify([id, meter.fetchedAt]), meter);
		}
	}

	markMetersFailed(owner: ResolvedPlan): void {
		this.#transaction(stage => {
			this.#failMeters(stage, owner);
			stage.accountingVersion++;
			this.#event(
				stage,
				"meter_unavailable",
				{ reason: "Provider usage refresh failed; any last successful observation is retained" },
				[
					{ kind: "plan", id: owner.config.id, version: String(stage.accountingVersion) },
					{ kind: "key", version: String(stage.accountingVersion) },
					{ kind: "overview", version: String(stage.accountingVersion) },
				],
				{ plan: owner.config.id },
				"warn",
			);
		});
	}

	markBindingUncertain(generation: string, owner: ResolvedPlan): void {
		const id = planBindingKey(generation, owner);
		if (this.#uncertainBindings.has(id)) return;
		this.#transaction(stage => {
			stage.uncertainBindings = new Set(stage.uncertainBindings).add(id);
			this.#failMeters(stage, owner);
			stage.accountingVersion++;
			this.#event(
				stage,
				"plan_unresolved",
				{ reason: "The retained credential binding requires a new Generation" },
				[
					{ kind: "plan", id: owner.config.id, version: String(stage.accountingVersion) },
					{ kind: "key", version: String(stage.accountingVersion) },
					{ kind: "health", version: String(stage.accountingVersion) },
				],
				{ plan: owner.config.id },
				"warn",
			);
		});
	}

	/** Only identity-bound samples enter this synchronous reconciliation owner. */
	observeMeter(
		observation: MeterObservation,
		owner = this.#plans.get(observation.plan),
		generation = this.#generation,
	): boolean {
		if (this.#closed) throw new Error("Store is closed");
		if (!owner || owner.config.id !== observation.plan || !sameBinding(owner.binding, observation.binding))
			throw new SwitchError(409, "plan_unresolved", "Meter observation does not match its retained Plan binding");
		if (this.#uncertainBindings.has(planBindingKey(generation, owner))) return false;
		if (
			![observation.providerUsedPct, observation.fetchedAt, observation.observationCutoff].every(
				value => Number.isFinite(value) && value >= 0,
			) ||
			observation.observationCutoff > observation.fetchedAt
		)
			throw new SwitchError(502, "invalid_meter", "Meter observation has invalid values");
		const id = this.#meterStorageId(observation);
		const previous = this.#meters.get(id);
		if (previous && observation.fetchedAt <= previous.fetchedAt) return false;
		const providerReset =
			previous?.providerInstance !== undefined &&
			observation.providerInstance !== undefined &&
			previous.providerInstance !== observation.providerInstance;
		const boundaryReset =
			previous?.resetsAt !== undefined &&
			observation.fetchedAt >= previous.resetsAt &&
			observation.resetsAt !== undefined &&
			observation.resetsAt > previous.resetsAt;
		const inferredReset = previous !== undefined && previous.providerUsedPct - observation.providerUsedPct > 5;
		const reset = !previous || providerReset || boundaryReset || inferredReset;
		const result = this.#transaction(stage => {
			const instance: WindowInstanceView = reset
				? {
						id: crypto.randomUUID(),
						startedAt: observation.fetchedAt,
						...(observation.resetsAt !== undefined
							? { resetsAt: observation.resetsAt }
							: observation.durationMs !== undefined
								? { resetsAt: observation.fetchedAt + observation.durationMs }
								: {}),
						endSource:
							inferredReset && !providerReset && !boundaryReset
								? "inferred"
								: observation.resetsAt !== undefined
									? "authoritative"
									: observation.durationMs !== undefined
										? "inferred"
										: "unknown",
					}
				: {
						...previous!.instance,
						...(observation.resetsAt !== undefined
							? { resetsAt: observation.resetsAt, endSource: "authoritative" as const }
							: {}),
					};
			const meter: MeterRecord = {
				plan: observation.plan,
				meter: observation.meter,
				...(observation.binding ? { binding: { ...observation.binding } } : {}),
				instance,
				providerUsedPct: observation.providerUsedPct,
				accountingBasePct: reset
					? observation.providerUsedPct
					: Math.max(previous!.accountingBasePct, observation.providerUsedPct),
				fetchedAt: observation.fetchedAt,
				observationCutoff: observation.observationCutoff,
				source: observation.source,
				...(observation.providerInstance !== undefined
					? { providerInstance: observation.providerInstance }
					: previous?.providerInstance !== undefined && !reset
						? { providerInstance: previous.providerInstance }
						: {}),
				...(observation.durationMs !== undefined
					? { durationMs: observation.durationMs }
					: previous?.durationMs !== undefined && !reset
						? { durationMs: previous.durationMs }
						: {}),
				...(observation.resetsAt !== undefined
					? { resetsAt: observation.resetsAt }
					: previous?.resetsAt !== undefined && !reset
						? { resetsAt: previous.resetsAt }
						: {}),
				version: (previous?.version ?? 0) + 1,
				externalPct: reset ? observation.providerUsedPct : previous!.externalPct,
				burnRateEma: reset ? 0 : previous!.burnRateEma,
				calibrationIntervals: reset ? [] : [...previous!.calibrationIntervals],
				...(!reset && previous!.pointsPerWeight !== undefined
					? { pointsPerWeight: previous!.pointsPerWeight }
					: {}),
				...(!reset && previous!.pointsPerToken !== undefined ? { pointsPerToken: previous!.pointsPerToken } : {}),
			};
			if (!reset) {
				const delta = Math.max(0, meter.accountingBasePct - previous!.accountingBasePct);
				const eligible = this.#database
					.debits(meter.plan, meter.meter, instance.id)
					.filter(row => row.remainingUnobserved > 0 && row.settledAt <= observation.observationCutoff)
					.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
				if (delta > 0 && eligible.length) {
					const weights = eligible.map(row => (row.mode === "tokens" ? row.tokens : row.weight));
					const totalWeight = weights.reduce((sum, value) => sum + value, 0);
					let allocated = 0;
					for (let index = 0; index < eligible.length; index++) {
						const row = eligible[index];
						const amount =
							index === eligible.length - 1
								? Math.max(0, delta - allocated)
								: delta * (totalWeight > 0 ? weights[index] / totalWeight : 1 / eligible.length);
						allocated += amount;
						row.remainingUnobserved = Math.max(0, row.remainingUnobserved - amount);
						if (row.mode === "proportional") {
							row.confirmedPct += amount;
							row.provisionalRemainingPct = Math.max(0, row.provisionalRemainingPct - amount);
						}
					}
					const newlyEligible = eligible.filter(row => row.calibratedAt === undefined);
					const weight = newlyEligible.reduce((sum, row) => sum + row.weight, 0);
					const tokens = newlyEligible.reduce((sum, row) => sum + row.tokens, 0);
					if (weight > 0 || tokens > 0) {
						meter.calibrationIntervals.push({ at: observation.fetchedAt, delta, weight, tokens });
						meter.calibrationIntervals = meter.calibrationIntervals.slice(-5);
						let weightRatio: number | undefined;
						let tokenRatio: number | undefined;
						for (const interval of meter.calibrationIntervals) {
							if (interval.weight > 0)
								weightRatio =
									weightRatio === undefined
										? interval.delta / interval.weight
										: (0.3 * interval.delta) / interval.weight + 0.7 * weightRatio;
							if (interval.tokens > 0)
								tokenRatio =
									tokenRatio === undefined
										? interval.delta / interval.tokens
										: (0.3 * interval.delta) / interval.tokens + 0.7 * tokenRatio;
						}
						if (weightRatio !== undefined) meter.pointsPerWeight = weightRatio;
						if (tokenRatio !== undefined) meter.pointsPerToken = tokenRatio;
						for (const row of newlyEligible) row.calibratedAt = observation.fetchedAt;
					}
					for (const row of eligible)
						this.#database.put(
							"meter_debits",
							JSON.stringify([row.attemptId, row.plan, row.meter, row.instance]),
							row,
						);
				} else if (delta > 0) meter.externalPct += delta;
				const elapsed = observation.fetchedAt - previous!.fetchedAt;
				if (delta > 0 && elapsed >= 60_000) {
					const sample = (delta * 3_600_000) / elapsed;
					meter.burnRateEma = previous!.burnRateEma > 0 ? 0.3 * sample + 0.7 * previous!.burnRateEma : sample;
				}
			}
			if (reset) {
				for (const held of stage.holds.values()) {
					if (held.plan !== meter.plan || !sameBinding(held.binding, meter.binding)) continue;
					const next = structuredClone(held);
					const hold = next.pendingJobHold ?? next.reservation;
					for (const row of hold.meters) if (row.meter === meter.meter) row.instance = instance.id;
					for (const row of hold.budgets)
						if (row.scope.plan === meter.plan && row.window.kind === "plan" && row.window.meter === meter.meter)
							row.instance = instance.id;
					stage.holds.set(next.id, next);
					this.#database.put("attempts", next.id, next);
				}
			}
			stage.meters.set(id, meter);
			this.#database.put("meter_snapshots", JSON.stringify([id, meter.fetchedAt]), meter);
			this.#database.put("instances", `meter:${instance.id}`, { ...instance, plan: meter.plan, meter: meter.meter });
			if (reset && previous)
				this.#database.put("instances", `meter:${previous.instance.id}`, {
					...previous.instance,
					plan: previous.plan,
					meter: previous.meter,
					closedAt: observation.fetchedAt,
				});
			stage.accountingVersion++;
			this.#invalidate(stage, "meter", [
				{ kind: "plan", id: meter.plan, version: String(meter.version) },
				{ kind: "usage", version: String(stage.accountingVersion) },
				{ kind: "overview", version: String(stage.accountingVersion) },
				...[...stage.keys.values()]
					.filter(key => key.plans.some(plan => plan.plan === meter.plan))
					.map(key => ({ kind: "key" as const, id: key.name, version: `${key.rev}:${stage.accountingVersion}` })),
			]);
			return true;
		});
		this.#maintain();
		return result;
	}
}
