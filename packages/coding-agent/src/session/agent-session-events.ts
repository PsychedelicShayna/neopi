import type { AgentEvent, AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ThinkingEffort } from "@oh-my-pi/pi-catalog/effort";
import type { Rule } from "../capability/rule";
import type { ChatModeSetting } from "../chat/chat-mode";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeState } from "../goals/state";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { TodoItem } from "@oh-my-pi/pi-tui/tools/todo";
import type { MixtureSessionEvent } from "../moa/host";
import type { CustomMessage } from "./messages";
import type { CacheWarmingRefreshEnd, CacheWarmingRefreshStart } from "./cache-warmer";

/**
 * Session-specific events that extend the core AgentEvent.
 *
 * Run lifecycle: a *run* opens at the first `agent_start` and closes at exactly one
 * `agent_end`, emitted once nothing can resume it — no model loop is live, nothing
 * the session scheduled is pending, and no background job, child agent or peer
 * message can wake it ({@link AgentSession.wakeSources}). Every model loop that stops
 * while the run goes on emits `agent_pause` instead, followed by the next loop's
 * `agent_start` or by the run's `agent_end`. A session transition (`/new`, a switch,
 * dispose) abandons an open run without either. The RPC, JSON print and collab wires and
 * the extension `agent_end` keep their per-loop `agent_end` shape (see `loop-end-wire.ts`).
 */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_start" }>
	| (Extract<AgentEvent, { type: "agent_start" }> & {
			/**
			 * Request handles whose work launched or scheduled this run (#171).
			 * Absent on runs nobody owns (keyboard prompts, autonomous turns).
			 */
			runOwners?: string[];
			/** 1-based count of runs this session has started, this one included. */
			agentStarts?: number;
	  })
	| {
			type: "agent_pause";
			/** Messages of the model loop that stopped, as its `agent_end` would carry them. */
			messages: AgentMessage[];
			/**
			 * True when the model finished its turn and something outside it resumes the run:
			 * queued input, a peer message, a background-job result or a child agent. False
			 * while the session continues the model's own work (retry, compaction continuation,
			 * stop-time reminders, hook continuations).
			 */
			yielded: boolean;
			/**
			 * True when this pause carries the turn's final assistant answer although the run
			 * continues (a pending delivery will wake the session). Consumers that relay the answer
			 * outward (the live voice relay) key off this.
			 */
			hasFinalResponse?: boolean;
			/**
			 * True when nothing the session scheduled resumes the run: it waits only on outside
			 * work (a background job, child agent or peer message; see {@link WakeSources}).
			 */
			awaiting: boolean;
	  }
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason. */
			skipped?: boolean;
	  }
	// One pair per manual compaction (RPC `compact`, `/compact`, extension
	// `ctx.compact()`), emitted once the live turn is aborted; fallback passes to
	// the next configured method stay inside the same pair.
	| {
			type: "manual_compaction_start";
			/** The `/compact <mode>` subcommand, when one was given. */
			mode?: string;
	  }
	| {
			type: "manual_compaction_end";
			/** Present when the compaction committed. */
			result?: CompactionResult;
			/** True when the compaction was cancelled (abort, or a `session_before_compact` hook). */
			aborted: boolean;
			/** True when there was nothing to compact; `errorMessage` says why. */
			skipped?: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| ({ type: "cache_warming_start" } & CacheWarmingRefreshStart)
	| ({ type: "cache_warming_end" } & CacheWarmingRefreshEnd)
	| { type: "retry_fallback_applied"; from: string; to: string; role: string; reason?: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "model_changed" }
	| { type: "themes_configuration_changed" }
	| { type: "models_configuration_changed" }
	| { type: "config_warnings_changed" }
	| { type: "approval_mode_changed" }
	| { type: "advisor_cost_changed" }
	| { type: "advisor_yielded" }
	/** A finalized advisor-agent message (the same data the advisor transcript records). Fork seam for live ingest. */
	| { type: "advisor_message"; advisor: string; slug: string; message: AgentMessage }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	/** Owners joined a run already streaming (a coalesced continuation) (#171). */
	| { type: "run_owners_joined"; owners: string[]; agentStarts: number }
	/** Scheduled work for these owners ended before any run consumed it (#171). */
	| { type: "run_owners_skipped"; owners: string[]; reason: string }
	| MixtureSessionEvent
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level. */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: ThinkingEffort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	/** Live chat-mode change: `mode` is `off` outside chat mode; `include` is comma-joined. */
	| { type: "chat_mode_changed"; mode: ChatModeSetting; include: string }
	// Coalesced snapshot of the displayable steering/follow-up queue: emitted
	// whenever it differs from the last `queue_update` (enqueue, dequeue on
	// delivery, remove, clear/restore, live-steering adoption/withdrawal, or
	// session switch), never on a no-op mutation. Mirrors
	// `AgentSession.getQueuedMessages()`; `liveSteered` counts the leading
	// `steering` entries already sent into the streaming response, which
	// `remove_queued_message` cannot reach.
	| { type: "queue_update"; steering: string[]; followUp: string[]; liveSteered: number };

/**
 * What can still resume a session's run without user input once its model loop
 * stops; see {@link AgentSession.wakeSources}.
 */
export interface WakeSources {
	/** Owned background jobs whose result will be delivered into the run. */
	readonly jobs: readonly string[];
	/** Child agents whose run is still open; a message from one wakes the run. */
	readonly agents: readonly string[];
	/** Job results, launch completions or peer messages already queued for a wake turn. */
	readonly queued: boolean;
}

/** Listener function for agent session events. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
