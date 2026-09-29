/**
 * Runtime types of the Mixture of Agents engine: resolved definitions, run
 * state, the host seam, and events. Document types and the trace payload live
 * in `@oh-my-pi/pi-tui/overlays/mixture-types` so the TUI can import them.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKey,
	AssistantMessage,
	Context,
	Effort,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	Usage,
} from "@oh-my-pi/pi-ai";
import type { Question } from "@oh-my-pi/pi-ai/judgment";
import type {
	MixtureCheckpointReason,
	MixtureDecision,
	MixtureDefinition,
	MixtureEndReason,
	MixtureHopStatus,
	MixtureRunStatus,
	MixtureShow,
	MixtureTraceDetails,
	TransitPartName,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { RoleChainCandidate } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { MixtureRunStore } from "./run-store";
import type { PreparedDocumentPresets } from "./validate";

/** A validation or resolution finding. */
export interface MixtureIssue {
	code: string;
	path: string;
	message: string;
}

/** Effective tool policy of a model member: none, all caller tools, or an allow-list. */
export type ToolPolicy = false | true | readonly string[];

export type ResolvedMember =
	| {
			kind: "model";
			id: string;
			description?: string;
			model: Model<Api>;
			/** Member `:effort` selector; undefined inherits the caller's. */
			effort?: Effort;
			/** The selector asked for `:off`. */
			reasoningOff?: boolean;
			maxTokens?: number;
			rolePrompt: string;
			toolPolicy: ToolPolicy;
			inherit: boolean;
			show: MixtureShow;
	  }
	| {
			kind: "verdict";
			id: string;
			description?: string;
			question: Question;
			state?: TransitPartName[];
			render: string;
			show: MixtureShow;
	  };

export type ResolvedModelMember = Extract<ResolvedMember, { kind: "model" }>;

/** A definition with every executable dependency pinned; the engine never runs a raw definition. */
export interface ResolvedMixture {
	/** Frozen copy. */
	definition: MixtureDefinition;
	/** Members that resolved; one that did not is absent and named in `issues`. */
	members: Record<string, ResolvedMember>;
	/** Every preset the mixture references, inlined, keyed by preset name. */
	envelopes: Record<string, string>;
	/** Document-level presets the definition was resolved against; run start re-resolves with them. */
	presets: PreparedDocumentPresets;
	/** What the graph can actually reach. */
	uses: { judge: boolean; summary: boolean; slicer: boolean };
	judgePlan?: RoleChainCandidate[];
	readOnlyTools: ReadonlySet<string>;
	/** Resolution failures (unresolved models, roles, presets, helpers); `validateMixture` reports them. */
	issues: MixtureIssue[];
	/** Hash of everything above, models as `provider/id:effort`. */
	revision: string;
}

export interface MixtureRunKey {
	/** `MixtureHost.id`: a session id, or a gateway instance id. */
	host: string;
	mixture: string;
	/** `[]` in v1; reserved for nested mixtures. */
	lineage: string[];
	conversation: string;
}

export interface HopRecord {
	/** 1-based, lifetime. */
	index: number;
	memberId: string;
	branchOf?: string;
	/** Undefined for the entry hop. */
	edgeInId?: string;
	/** Rendered envelope text. */
	input: string;
	/** The member's own hop context after the envelope. */
	messages: Message[];
	output: string;
	reasoning: string;
	toolTrace: string;
	truncated?: boolean;
	decisions: MixtureDecision[];
	status: MixtureHopStatus;
	pendingToolCalls?: { outerId: string; memberId: string; name: string }[];
	error?: { message: string; status?: number; errorId?: number };
	visible?: boolean;
	startedAt: number;
	elapsedMs?: number;
	/** Usage settled for this hop. */
	usage?: Usage;
}

export interface Settlement {
	/** Unique per billed attempt. */
	attempt: string;
	kind: "member" | "judge" | "summary" | "slicer";
	hop?: number;
	/** The transport that served the attempt. */
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	/** The attempt's own terminal. */
	stopReason: StopReason;
	errorMessage?: string;
	/** `stopReason` is `error` or `aborted`. */
	failed?: boolean;
	/**
	 * Settled after the request's outer response was already finished (a caller
	 * abort finalized it). Never inside a report range; journaled through
	 * `onLateSettlement` instead. Still counted in `run.lifetime` / `run.window`.
	 */
	late?: true;
}

export type ToolRequirement =
	| { kind: "none" }
	| { kind: "optional" }
	| { kind: "any" }
	| { kind: "named"; name: string };

export type RunPhase =
	| { kind: "hop_ready"; memberId: string; edgeInId?: string }
	| { kind: "generating"; hop: number }
	| { kind: "resume_hop"; hop: number }
	| { kind: "decision_pending"; hop: number }
	| { kind: "awaiting_tools"; hop: number }
	| { kind: "group_barrier"; invocationId: string }
	| { kind: "closing"; hop: number }
	| { kind: "finalizing" }
	| { kind: "ended" };

/** The immutable outer response the writer produced for one request, replayable from a checkpoint. */
export interface PendingResponse {
	responseId: string;
	content: AssistantMessage["content"];
	stopReason: StopReason;
	errorMessage?: string;
	errorStatus?: number;
	errorId?: number;
}

/** Messages `[0, count)` of a request hash to `hash`. */
export interface ConsumptionBoundary {
	count: number;
	hash: string;
}

export interface OuterResponseRecord {
	responseId: string;
	textHash: string;
	report: { from: number; to: number };
	committed: boolean;
	pending: PendingResponse;
	/** The request's full input; `commit` advances the cursor to it. */
	consumed: ConsumptionBoundary;
}

export interface MixtureRun {
	id: string;
	key: MixtureRunKey;
	/** Pinned at run start. */
	resolved: ResolvedMixture;
	topic: string;
	lastRequest: {
		fingerprint: string;
		consumedCount: number;
		consumedHash: string;
		outcome: "in_progress" | "responded" | "failed";
		responseId?: string;
	};
	/** Committed input-consumption boundary; advances only on commit. */
	cursor?: ConsumptionBoundary;
	status: MixtureRunStatus;
	phase: RunPhase;
	hops: HopRecord[];
	activeMemberId?: string;
	traversals: Record<string, number>;
	settlements: Settlement[];
	/** `settlements[0, reportedThrough)` were reported on a committed outer response. */
	reportedThrough: number;
	appliedToolResultIds: string[];
	window: { hops: number; usd: number; startedAt: number };
	lifetime: { hops: number; usd: number; startedAt: number };
	outerResponses: OuterResponseRecord[];
	final?: { text: string; hop: number };
	toolRequirement?: ToolRequirement;
	endReason?: MixtureEndReason;
	/** Monotonic trace sequence. */
	seq: number;
}

/** A run as persisted in a checkpoint: the resolution is reduced to what identifies it. */
export type SerializedMixtureRun = Omit<MixtureRun, "resolved"> & {
	resolved: { revision: string; definition: MixtureDefinition };
};

export interface MixtureCheckpoint {
	v: 1;
	reason: MixtureCheckpointReason;
	/** `run.phase` is the continuation. */
	run: SerializedMixtureRun;
	/** `run.reportedThrough` when written. */
	committedThrough: number;
	outerResponseId?: string;
	report?: { from: number; to: number };
}

/** Lifecycle records sharing the checkpoint entry type; they carry no card. */
export type MixtureLifecycleRecord =
	| { kind: "run_end"; runId: string; endReason: MixtureEndReason; at: number; responseId: string }
	| { kind: "run_reset"; runId: string; at: number };

/** Custom entry type of checkpoints and lifecycle records. */
export const MIXTURE_RUN_ENTRY_TYPE = "mixture_run";

/** `model_usage` purpose of a late mixture settlement: a member attempt no outer response reports. */
export const MIXTURE_USAGE_PURPOSE = "moa";

export type MixtureEvent =
	| { type: "run_start"; run: MixtureRun; trace: Extract<MixtureTraceDetails, { kind: "run_start" }> }
	| {
			type: "hop_start";
			run: MixtureRun;
			hop: HopRecord;
			model: Model<Api>;
			trace: Extract<MixtureTraceDetails, { kind: "hop" | "branch" }>;
	  }
	| {
			type: "hop_end";
			run: MixtureRun;
			hop: HopRecord;
			trace: Extract<MixtureTraceDetails, { kind: "hop" | "branch" }>;
	  }
	| { type: "decision"; run: MixtureRun; hop: HopRecord; trace: Extract<MixtureTraceDetails, { kind: "decision" }> }
	| { type: "steering"; run: MixtureRun; trace: Extract<MixtureTraceDetails, { kind: "steering" }> }
	| { type: "limit"; run: MixtureRun; trace: Extract<MixtureTraceDetails, { kind: "limit" }> }
	| {
			type: "checkpoint";
			run: MixtureRun;
			reason: MixtureCheckpointReason;
			checkpoint: MixtureCheckpoint;
			report?: { from: number; to: number };
			outerResponseId?: string;
			trace?: Extract<MixtureTraceDetails, { kind: "checkpoint" }>;
	  }
	| { type: "run_end"; run: MixtureRun; trace: Extract<MixtureTraceDetails, { kind: "run_end" }> };

/** Options the caller's loop passes to a stream function beyond `SimpleStreamOptions` (the loop spreads its config). */
export interface OuterStreamOptions extends SimpleStreamOptions {
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

/** Everything a mixture run needs from where it executes. */
export interface MixtureHost {
	/** `MixtureRunKey.host`. */
	id: string;
	runs: MixtureRunStore;
	/**
	 * Resolve a registered mixture afresh for a new run (role reassignments and
	 * credential changes since registration apply). A mixture that is not
	 * registered, or no longer validates, yields the reason as a string.
	 */
	resolveRun(name: string): ResolvedMixture | string;
	settings: Settings;
	/** Member calls. Session: the settings-aware stream function. */
	stream: StreamFn;
	/** Rotation-capable credential for a member model; `onAccount` fires when rotation switches accounts. */
	resolver(model: Model<Api>, sessionId: string, onAccount: () => void): ApiKey | undefined;
	/** Provider-specific context preparation for a member model. */
	prepareContext(context: Context, model: Model<Api>): Promise<Context>;
	conversationKey(context: Context, options: SimpleStreamOptions): string;
	/** Upstream billed-attempt accounting, once per settlement, when it settles; late settlements too. */
	onSettlement?(run: MixtureRun, settlement: Settlement): void;
	/**
	 * Client-facing accounting for a settlement no outer response will report
	 * (`settlement.late`). The session host journals it as one `model_usage`
	 * entry while the run still belongs to its conversation.
	 */
	onLateSettlement?(run: MixtureRun, settlement: Settlement): void;
	onEvent?(event: MixtureEvent): void;
}
