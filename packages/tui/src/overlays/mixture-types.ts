/**
 * Mixture of Agents: document types for `MIXTURES.toml` and the trace payload
 * shared by the engine's events, the persisted `mixture_trace` cards, and any
 * later side panel. A mixture is a directed graph of members (a model plus a
 * role prompt) registered as the keyless model `mixture/<name>`. The TOML file
 * uses snake_case keys; these types are camelCase and the loader maps between
 * them.
 */
import type { Usage } from "@oh-my-pi/pi-ai";
import type { Answer, ChoiceQuestion, NoulQuestion, ScoreQuestion } from "@oh-my-pi/pi-ai/judgment";

/** One `MIXTURES.toml` document. */
export interface MixturesConfigDoc {
	/** Shared envelope presets (Handlebars templates), by name. */
	envelopes?: Record<string, string>;
	/** Shared role (system prompt) presets, by name. */
	roles?: Record<string, string>;
	mixtures: MixtureDefinition[];
	/** Parse warnings: malformed entries are skipped, never fatal. */
	warnings?: string[];
}

/** Which level a `MIXTURES.toml` is saved at: the project root or the user agent dir. */
export type MixtureConfigScope = "project" | "user";

export interface MixtureDefinition {
	/** `[a-z0-9][a-z0-9._-]*`, unique in the merged roster; the model id is `mixture/<name>`. */
	name: string;
	description?: string;
	/** Id of the model member that receives the operator's prompt. */
	entry: string;
	/** Gateway opt-in; default false. */
	serve?: boolean;
	members: MixtureMember[];
	edges: MixtureEdge[];
	limits?: MixtureLimits;
	steering?: { target: string };
	/** Mixture-local presets shadow document presets. */
	envelopes?: Record<string, string>;
	roles?: Record<string, string>;
}

export type MixtureMember = ModelMember | VerdictMember;

export type MixtureShow = "always" | "never" | "final";

interface MemberBase {
	/** `[a-z0-9][a-z0-9_-]*`, unique per mixture. */
	id: string;
	description?: string;
	show?: MixtureShow;
}

export interface ModelMember extends MemberBase {
	kind?: "model";
	/** `provider/id[:effort]` or `@role[:effort]`. */
	model: string;
	/** Role preset name. */
	role?: string;
	/** Inline role prompt; wins over `role`. */
	systemPrompt?: string;
	/** Prepend the outer system prompt; default = effective tools !== false. */
	inherit?: boolean;
	/** false | true (all caller tools) | allow-list. */
	tools?: boolean | string[];
	maxTokens?: number;
	route?: RouteCondition;
	terminate?: TerminateCondition;
}

export interface VerdictMember extends MemberBase {
	kind: "verdict";
	question: ChoiceQuestion | NoulQuestion | ScoreQuestion;
	state?: TransitPartName[];
	render?: string;
}

export type MixtureEdge = SequentialEdge | FanoutEdge;

interface EdgeBase {
	/** Default `${from}->${to}` (or `${from}->[a,b]`); unique. */
	id?: string;
	from: string;
	/** Mandatory, non-empty: what the source member's hop hands on. */
	x: TransitSpec;
	/** Preset name or inline template; default the bundled `handoff`. */
	envelope?: string;
	when?: string;
	/** Overrides the source member's `show` when this edge is taken. */
	show?: "always" | "never";
	maxTraversals?: number;
}

export interface SequentialEdge extends EdgeBase {
	to: string;
}

export interface FanoutEdge extends EdgeBase {
	to: string[];
	join: string;
	slices?: "same" | "auto" | string[];
	joinX?: TransitSpec;
	joinEnvelope?: string;
	quorum?: number;
	graceMs?: number;
	anonymize?: boolean;
}

export type TransitPartName = "output" | "input" | "reasoning" | "toolTrace" | "transcript";

export const TRANSIT_PART_NAMES: readonly TransitPartName[] = [
	"output",
	"input",
	"reasoning",
	"toolTrace",
	"transcript",
];

export interface TranscriptSpec {
	optimize?: "verbatim" | "compact" | "snapcompact";
	budgetTokens?: number;
}

export interface TransitSpec {
	output?: true;
	input?: true;
	reasoning?: true;
	toolTrace?: true;
	transcript?: true | TranscriptSpec;
}

export interface RouteCondition {
	instructions: string;
	state?: ("output" | "input" | "toolTrace")[];
	minConfidence?: number;
	/** Outgoing edge id, or `pause`. */
	fallback?: string;
}

export interface TerminateCondition {
	instructions: string;
	criteria?: { true?: string; false?: string };
	state?: ("output" | "input" | "toolTrace")[];
	threshold?: number;
}

export interface MixtureLimits {
	maxHops?: number;
	budgetUsd?: number;
	wallClockMinutes?: number;
	onLimit?: "stop" | "pause" | "judge";
	limitTarget?: string;
}

/** Whether an edge fans out to several branches. */
export function isFanoutEdge(edge: MixtureEdge): edge is FanoutEdge {
	return Array.isArray(edge.to);
}

/** An edge's explicit id, or the id derived from its endpoints. */
export function mixtureEdgeId(edge: MixtureEdge): string {
	if (edge.id) return edge.id;
	return isFanoutEdge(edge) ? `${edge.from}->[${edge.to.join(",")}]` : `${edge.from}->${edge.to}`;
}

// ---------------------------------------------------------------------------
// Run shape shared with trace consumers
// ---------------------------------------------------------------------------

export type MixtureRunStatus = "running" | "awaiting_tools" | "checkpoint" | "paused" | "done" | "error";

export type MixtureRunPhaseKind =
	| "hop_ready"
	| "generating"
	| "resume_hop"
	| "decision_pending"
	| "awaiting_tools"
	| "group_barrier"
	| "closing"
	| "finalizing"
	| "ended";

export type MixtureEndReason =
	| "terminal"
	| "terminate"
	| "verdict"
	| "limit:hops"
	| "limit:budget"
	| "limit:wall_clock"
	| "hard_cap"
	| "aborted"
	| "error";

export type MixtureHopStatus = "running" | "awaiting_tools" | "done" | "failed" | "aborted";

export type MixtureCheckpointReason = "hop" | "decision" | "steering" | "abort" | "pause" | "tools" | "error" | "done";

export interface MixtureDecision {
	kind: "route" | "terminate" | "steering" | "verdict";
	answer: Answer;
	confidence?: number;
	/** `${provider}/${model}` of the judge that answered. */
	judge: string;
	judgeKind: "native" | "local" | "online";
}

/** Run header every trace variant carries, so a consumer can restore run state from traces alone. */
export interface MixtureTraceHeader {
	v: 1;
	runId: string;
	mixture: string;
	/** Monotonic per run; a card with the same (runId, seq) updates, never duplicates. */
	seq: number;
	at: number;
	/** Run state after this event. */
	run: {
		status: MixtureRunStatus;
		phase: MixtureRunPhaseKind;
		activeMemberId?: string;
		/** Lifetime hop count. */
		hops: number;
		/** Lifetime settled cost; authoritative total, never summed across cards. */
		usd: number;
		window: { hops: number; usd: number };
		endReason?: MixtureEndReason;
	};
}

export type MixtureTraceDetails =
	| (MixtureTraceHeader & {
			kind: "run_start";
			topic: string;
			members: { id: string; model?: string; description?: string }[];
	  })
	| (MixtureTraceHeader & {
			kind: "hop" | "branch";
			hop: number;
			memberId: string;
			model: string;
			edgeInId?: string;
			edgeOutId?: string;
			output?: string;
			reasoning?: string;
			toolTrace?: string;
			usage: Usage;
			elapsedMs: number;
			status: MixtureHopStatus;
			visible: boolean;
			branchOf?: string;
	  })
	| (MixtureTraceHeader & { kind: "decision"; hop: number; memberId: string; decision: MixtureDecision })
	| (MixtureTraceHeader & { kind: "steering"; hop: number; targetMemberId: string; text: string })
	| (MixtureTraceHeader & {
			kind: "limit";
			limit: "hops" | "budget" | "wall_clock" | "hard_cap";
			action: "stop" | "pause" | "judge";
			value: string;
	  })
	| (MixtureTraceHeader & {
			kind: "checkpoint";
			reason: Exclude<MixtureCheckpointReason, "done">;
			note?: string;
	  })
	| (MixtureTraceHeader & { kind: "run_end"; endReason: MixtureEndReason; usage: Usage });

/** Custom message type of the display-only trace cards; never part of the LLM context. */
export const MIXTURE_TRACE_MESSAGE_TYPE = "mixture_trace";
