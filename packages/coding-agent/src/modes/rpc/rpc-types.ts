/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode, ToolTier } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Effort,
	ImageContent,
	Model,
	TextContent,
	ThinkingContent,
	ToolExample,
} from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { BashResult } from "../../exec/bash-executor";
import type { ChatModeSetting, ChatModeState } from "../../chat/chat-mode";
import type { ChroniclerHealth } from "../../chronicler/session-chronicler";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import type { CacheWarmingMode } from "../../session/cache-warmer";
import type { MessageEntryIdentity } from "../../session/message-entry-ids";
import type { FileEntry, SessionEntry, SessionTreeNode } from "../../session/session-entries";
import type { UsageLimitState } from "../../session/usage-limit";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { SubagentEventPayload, SubagentLifecyclePayload, SubagentProgressPayload } from "../../task";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ApprovalMode } from "../../tools/approval";
import type { MixtureConfigScope, MixtureDefinition } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import type { LivePhase } from "../../live/controller";
import type { RpcMessagesPage } from "./rpc-messages";
import type {
	RpcNavigateTreeOptions,
	RpcNavigateTreeResult,
	RpcResumeTreeOptions,
	RpcResumeTreeResult,
} from "./rpc-tree";
import type { RpcJournalPage, RpcJournalPageOptions } from "./rpc-journal";
import type { RpcModel } from "./rpc-model";
import type { RpcRolesResult, RpcSetRoleResult } from "./rpc-roles";
import type { RpcModelSelectorResult } from "./rpc-model-selector";
import type {
	RpcModelsConfiguration,
	RpcSetModelRoleConfiguration,
	RpcSetEffortRules,
	RpcSetModelRoleFallbacks,
	RpcSetModelRoleDescription,
	RpcDeleteModelRole,
} from "./rpc-models-configuration";
import type { RpcUsageResult } from "./rpc-usage";
import type { GoalModeState } from "../../goals/state";
import type { RpcGoalOp, RpcGoalResult } from "./rpc-goal";
import type { BtwHistoryRecord } from "../../session/btw-history";
import type { SessionJournalEvent, SessionJournalIdentity } from "../../session/session-journal-events";
import type { RpcThemePalette, RpcThemesCommand, RpcThemesConfiguration } from "./rpc-themes-configuration";
import type { UsageStatistics } from "../../session/session-entries";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

/**
 * `set_event_filter` projection: `"full"` keeps both accumulated snapshots in `message_update`, `"delta"` replaces them
 * with the block a start event opens or an end event closes (see {@link RpcDeltaAssistantMessageEvent}).
 */
export type RpcMessageUpdates = "full" | "delta";

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| RpcThemesCommand

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "remove_queued_message"; message: string; queue: "steering" | "followUp" }
	| { id?: string; type: "promote_queued_message"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort_and_restore_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "open_session"; sessionDir: string; provider?: string; modelId?: string }

	// State
	| { id?: string; type: "get_state"; includeDump?: boolean }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| RpcSetChatModeCommand
	| { id?: string; type: "set_mode"; mode: RpcMode; planFilePath?: string }
	| { id?: string; type: "set_slow_mode"; enabled: boolean }
	| {
			id?: string;
			type: "goal";
			op: RpcGoalOp;
			objective?: string;
			token_budget?: number;
	  }
	| { id?: string; type: "set_ask_dialog"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "snapshot_session_journal" }
	| ({ id?: string; type: "get_entries_page" } & RpcJournalPageOptions)
	| { id?: string; type: "get_tree" }
	| ({ id?: string; type: "navigate_tree" } & RpcNavigateTreeOptions)
	| ({ id?: string; type: "resume_tree" } & RpcResumeTreeOptions)
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "set_event_filter"; events: string[] | null; messageUpdates?: RpcMessageUpdates }
	| { id?: string; type: "set_approval_handler"; handler: RpcApprovalHandler }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "cancel_subagent"; subagentId: string }
	| { id?: string; type: "steer_subagent"; subagentId: string; message: string }
	| { id?: string; type: "set_subagent_thinking_level"; subagentId: string; level: ThinkingLevel }
	| { id?: string; type: "set_subagent_fast"; subagentId: string; enabled: boolean }
	// Live voice (GPT live bound to this session)
	| { id?: string; type: "live_start"; voice?: string }
	| { id?: string; type: "live_connect"; sdpOffer: string; voice?: string }
	| { id?: string; type: "live_stop" }
	| { id?: string; type: "live_mute"; muted?: boolean }

	// Draft-only speech-to-text
	| { id?: string; type: "dictation_start"; captureId: string }
	| { id?: string; type: "dictation_stop" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "create_mixture"; scope: MixtureConfigScope; definition: MixtureDefinition }
	| { id?: string; type: "list_mixtures" }
	| { id?: string; type: "select_mixture"; name: string }
	| { id?: string; type: "get_roles" }
	| { id?: string; type: "query_model_selector"; query: string }
	| { id?: string; type: "set_role"; role: string }
	| { id?: string; type: "get_models_configuration" }
	| ({ id?: string; type: "set_model_role_configuration" } & RpcSetModelRoleConfiguration)
	| ({ id?: string; type: "set_model_role_fallbacks" } & RpcSetModelRoleFallbacks)
	| ({ id?: string; type: "set_model_role_description" } & RpcSetModelRoleDescription)
	| ({ id?: string; type: "delete_model_role" } & RpcDeleteModelRole)
	| ({ id?: string; type: "set_effort_rules" } & RpcSetEffortRules)
	| { id?: string; type: "set_model_role_storage"; value: "global" | "project"; expected: "global" | "project" }
	| { id?: string; type: "set_provider_api_key"; providerId: string; apiKey: string }
	| { id?: string; type: "cancel_login"; loginId: string }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Cache warming
	| { id?: string; type: "set_cache_warming"; mode: CacheWarmingMode }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "get_usage"; provider?: string; refresh?: boolean; redact?: boolean }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string; provider?: string; modelId?: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "fork"; entryId?: string }
	| { id?: string; type: "abort_branch_summary" }
	| { id?: string; type: "set_label"; entryId: string; label?: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "get_logout_accounts"; providerId: string }
	| { id?: string; type: "logout"; providerId: string; credentialId: number }
	| { id?: string; type: "activate_account"; providerId: string; credentialId: number }

	// Word prediction (composer ghost text); `cursor` is a UTF-16 offset into `text`
	| { id?: string; type: "predict_word"; text: string; cursor: number }
	| {
			id?: string;
			type: "predict_word_feedback";
			text: string;
			cursor: number;
			suggestion: string;
			accepted: boolean;
	  }

	// Side questions (/btw); answers stream as `btw_delta` / `btw_record` frames
	| { id?: string; type: "btw"; question: string; recordId?: string }
	| { id?: string; type: "btw_cancel"; recordId?: string }
	| { id?: string; type: "get_btw_history" };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: RpcModel;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	/** Effective tool policy, including the process-local auto-approve override. */
	approvalMode?: ApprovalMode;
	/** All journal branches, including compacted history and completed task spend. */
	sessionUsage?: UsageStatistics & {
		advisorCost: number;
		advisorCostState: "ready" | "restoring" | "unavailable";
	};
	/** Capture ownership, last committed progress, and automatic recovery diagnostics. */
	chronicler: ChroniclerHealth;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	/** `/slow` applies to the active model (flex tier on OpenAI/Google, low priority on Claude subscriptions). */
	slowModeSupported: boolean;
	/** `/slow` is on for the active model; always `false` when `slowModeSupported` is `false`. */
	slowModeEnabled: boolean;
	/**
	 * Where the active model's `/slow` lives: `global` (persisted config shared by every
	 * session, e.g. Claude low priority) or `session` (this session's flex tier). Absent when unsupported.
	 */
	slowModeScope?: "session" | "global";
	/** Usage-limit stage of the active model's account; absent outside wrap-up and low priority. */
	usageLimit?: UsageLimitState;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	/** Background jobs or deliveries can still inject a follow-up and wake the session. */
	hasPendingAsyncWork: boolean;
	/** Same predicate as `session_settled`: idle with nothing queued or pending. */
	isSettled: boolean;
	/** Displayable queue-chip text for pending user-authored messages, mirroring
	 *  `AgentSession.getQueuedMessages()`. Render the queue from this snapshot
	 *  (and the `queue_update` event) instead of tracking chips independently.
	 *  `liveSteered` counts the leading `steering` entries already sent into the
	 *  streaming response; `remove_queued_message` cannot reach them. */
	queuedMessages: { steering: readonly string[]; followUp: readonly string[]; liveSteered: number };
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	/** Role the current model was selected through (`set_role`, `--model @<role>`); absent after a direct model choice. */
	activeRole?: string;
	/** Live chat mode; `off` for an ordinary coding session. */
	chatMode: ChatModeSetting;
	/** Session mode; `plan` while plan mode is active, whichever path entered it. */
	mode: RpcMode;
	/** Active plan-mode details; present only while `mode` is `plan`. */
	planMode?: RpcPlanModeInfo;
	/** Current goal-mode state; `null` when the session has no goal. */
	goal: GoalModeState | null;
}

/** Session modes `set_mode` switches between. */
export type RpcMode = "default" | "plan";

/** Plan-mode details reported by `get_state`. */
export interface RpcPlanModeInfo {
	planFilePath: string;
	workflow: string;
}

/** `set_mode` response data. */
export interface RpcSetModeResult {
	mode: RpcMode;
	/** The plan file plan mode targets; present only for `plan`. */
	planFilePath?: string;
}

/** Emitted whenever the session mode or the active plan file changes, whichever path caused it. */
export interface RpcModeChangedFrame {
	type: "mode_changed";
	mode: RpcMode;
	planFilePath?: string;
}

/** Emitted when the agent submits a plan via `xd://propose` after the host entered plan mode with `set_mode`. */
export interface RpcPlanProposalRequest {
	type: "plan_proposal_request";
	id: string;
	title: string;
	planFilePath: string;
	planMarkdown: string;
}

/** Host decision for a `plan_proposal_request` (stdin control frame). */
export interface RpcPlanProposalResponse {
	type: "plan_proposal_response";
	id: string;
	decision: "approve" | "refine";
	/** Reviewer note for `refine`; included in the tool result the agent sees. */
	feedback?: string;
}

/** Why a pending plan proposal resolved without a host answer. */
export type RpcPlanProposalCancelReason = "abort" | "mode_change" | "agent_end" | "shutdown";

/**
 * Emitted when a pending {@link RpcPlanProposalRequest} resolves as `refine`
 * without a host answer; `id` is the request's id. A later
 * `plan_proposal_response` for that id fails with `code: "proposal_cancelled"`.
 */
export interface RpcPlanProposalCancel {
	type: "plan_proposal_cancel";
	id: string;
	reason: RpcPlanProposalCancelReason;
}

/**
 * Switch chat mode live. `include` lists the re-enabled context categories,
 * comma-separated (`"date,cwd"`) or as an array; omitted keeps the current or
 * last-used set. Responds with the resulting {@link ChatModeState}.
 */
export interface RpcSetChatModeCommand {
	id?: string;
	type: "set_chat_mode";
	mode: ChatModeSetting;
	include?: string | string[];
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

/** How a prompt's work ended, as reported by its {@link RpcPromptResultFrame}. */
export type RpcPromptStatus = "completed" | "aborted" | "error";

/**
 * Failure detail for a `prompt_result` with `status: "error"`. `message` is the
 * provider's error text without OMP-local diagnostics (e.g. request dump paths).
 */
export interface RpcPromptError {
	message: string;
	provider?: string;
	model?: string;
	/** HTTP status reported by the provider, when the failure came from a request. */
	httpStatus?: number;
	/** The failure is classified transient: resubmitting later may succeed. OMP's own retries are already exhausted. */
	retryable: boolean;
	/** `cost_cap`: the session reached `session.maxCost` (`--max-cost`) and omp did not send the next request. */
	code?: "cost_cap";
}

/** `prompt` success-response data. */
export interface RpcPromptResponseData {
	/**
	 * Set only by a slash command that was consumed on the spot. `false` is the
	 * completion signal (no `prompt_result` follows); `true` means the command
	 * scheduled an agent turn of its own (e.g. `/retry`).
	 */
	agentInvoked?: boolean;
	/**
	 * Id of the session entry the prompt's message is written as (a `message`
	 * entry, or a `custom_message` entry for a `/skill:` prompt). Allocated when
	 * the prompt is accepted, so it is known before the turn persists anything;
	 * it matches `get_entries`/`get_messages_page` ids once the message reaches
	 * the session. Absent when the prompt writes no entry of its own.
	 */
	userEntryId?: string;
}

/**
 * Terminal frame emitted exactly once per accepted `prompt`/`abort_and_prompt`,
 * after all work the prompt caused has settled. Correlate on `id`.
 */
export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	/** False when the prompt completed locally (slash command) or failed before reaching the agent. */
	agentInvoked: boolean;
	status: RpcPromptStatus;
	error?: RpcPromptError;
	/**
	 * The agent yielded and nothing will wake the session again: no run is live and no
	 * queued message or background job (async bash/task/eval) will inject a follow-up.
	 * When false, a {@link RpcSessionSettledFrame} follows once that work is done.
	 */
	sessionSettled: boolean;
	/** Control-socket request handle the receipt belongs to (#171); absent on stdio. */
	requestHandle?: string;
	/** Why an `aborted` prompt ended without its own run (`skipped:<reason>`), when known. */
	reason?: string;
}

/**
 * Emitted when the session goes quiet after agent activity: the last run yielded
 * and no background work remains that could inject messages and wake it again.
 * Distinct from a terminal `agent_end`, which only means one run yielded.
 */
export interface RpcSessionSettledFrame {
	type: "session_settled";
}

// ============================================================================
// Live Voice Frames (stdout, unsolicited; not session events, so `set_event_filter` never drops them)
// ============================================================================

/** Live session phase change. */
export interface RpcLivePhaseFrame {
	type: "live_phase";
	phase: LivePhase;
}

/** Microphone/speaker RMS in [0, 1], at most one frame per 100 ms carrying the latest values. */
export interface RpcLiveLevelsFrame {
	type: "live_levels";
	input: number;
	output: number;
}

/** Incremental (`final: false`) or final transcript of one realtime turn; coalesce on `role` + `turn`. */
export interface RpcLiveTranscriptFrame {
	type: "live_transcript";
	role: "user" | "assistant";
	turn: number;
	text: string;
	final: boolean;
}

/** Emitted exactly once per live session when it has ended; `error` carries the failure cause. */
export interface RpcLiveEndFrame {
	type: "live_end";
	error?: string;
}

export type RpcLiveFrame = RpcLivePhaseFrame | RpcLiveLevelsFrame | RpcLiveTranscriptFrame | RpcLiveEndFrame;

/** Draft-only dictation frames bypass the session event filter. */
export interface RpcDictationStateFrame {
	type: "dictation_state";
	captureId: string;
	state: "starting" | "recording" | "transcribing";
}

/** Full accumulated preview, replacing the previous preview for this capture. */
export interface RpcDictationTranscriptFrame {
	type: "dictation_transcript";
	captureId: string;
	text: string;
}

/** Exactly one terminal frame per capture, including any failure. */
export interface RpcDictationEndFrame {
	type: "dictation_end";
	captureId: string;
	text: string;
	error?: string;
}

export type RpcDictationFrame = RpcDictationStateFrame | RpcDictationTranscriptFrame | RpcDictationEndFrame;

/** `open_session` result: `resumed` is false when a fresh session was started in the directory. */
export interface RpcOpenSessionResult {
	cancelled: boolean;
	resumed: boolean;
	sessionId: string;
	sessionFile?: string;
}

/** `remove_queued_message` result. */
export interface RpcRemoveQueuedMessageResult {
	removed: boolean;
	/** The removed message's images, so the client can restore them with its text. */
	images?: ImageContent[];
	/** Set when the images exceeded the transport limit and were omitted; the removal still happened. */
	imagesDropped?: true;
}

/** `abort_and_restore_queue` result: the user-authored queued input withdrawn before the abort, oldest first. */
export interface RpcAbortAndRestoreQueueResult {
	steering: RestoredQueuedMessage[];
	followUp: RestoredQueuedMessage[];
	/** Set when the full result exceeded the transport limit and every entry's `images` was omitted. */
	imagesDropped?: true;
	/** Set when even the text-only result exceeded the limit: only an oldest-first prefix is listed. */
	truncated?: true;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	/** Optional features this process supports; hosts gate on exact strings (see `rpc-capabilities.ts`). */
	capabilities: string[];
}

/**
 * One JSON line written to **stderr** (not stdout) when startup fails before
 * any `ready` frame; the process then exits non-zero.
 */
export interface RpcStartupError {
	type: "startup_error";
	/** `--session` names a file another live process holds (see the `session_lease` capability). */
	code: "session_in_use";
	/** Process id of the holder; 0 when it had not yet recorded itself. */
	pid: number;
	sessionFile: string;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export interface RpcLoginProvider extends OAuthProviderInfo {
	authenticated: boolean;
	/** The native set_provider_api_key command accepts this credential provider. */
	acceptsKeys: boolean;
}

export type RpcResponse =
	| { id?: string; type: "response"; command: "get_themes_configuration"; success: true; data: RpcThemesConfiguration }
	| { id?: string; type: "response"; command: "get_theme"; success: true; data: RpcThemePalette }
	| { id?: string; type: "response"; command: "update_theme"; success: true; data: RpcThemesConfiguration }
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: RpcPromptResponseData }
	| { id?: string; type: "response"; command: "steer"; success: true; data: { userEntryId: string } }
	| { id?: string; type: "response"; command: "follow_up"; success: true; data: { userEntryId: string } }
	| {
			id?: string;
			type: "response";
			command: "remove_queued_message";
			success: true;
			data: RpcRemoveQueuedMessageResult;
	  }
	| { id?: string; type: "response"; command: "promote_queued_message"; success: true; data: { promoted: boolean } }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true; data?: { userEntryId: string } }
	| {
			id?: string;
			type: "response";
			command: "abort_and_restore_queue";
			success: true;
			data: RpcAbortAndRestoreQueueResult;
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "open_session"; success: true; data: RpcOpenSessionResult }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| { id?: string; type: "response"; command: "set_chat_mode"; success: true; data: ChatModeState }
	| { id?: string; type: "response"; command: "set_mode"; success: true; data: RpcSetModeResult }
	| { id?: string; type: "response"; command: "set_slow_mode"; success: true; data: { enabled: boolean } }
	| { id?: string; type: "response"; command: "goal"; success: true; data: RpcGoalResult }
	| { id?: string; type: "response"; command: "set_ask_dialog"; success: true; data: { enabled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| { id?: string; type: "response"; command: "snapshot_session_journal"; success: true; data: SessionJournalIdentity }
	| { id?: string; type: "response"; command: "get_entries_page"; success: true; data: RpcJournalPage }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| { id?: string; type: "response"; command: "navigate_tree"; success: true; data: RpcNavigateTreeResult }
	| { id?: string; type: "response"; command: "resume_tree"; success: true; data: RpcResumeTreeResult }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_event_filter";
			success: true;
			data: { events: string[] | null; messageUpdates: RpcMessageUpdates };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_approval_handler";
			success: true;
			data: { handler: RpcApprovalHandler };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "cancel_subagent";
			success: true;
			data: { cancelled: boolean };
	  }
	| { id?: string; type: "response"; command: "steer_subagent"; success: true }
	| { id?: string; type: "response"; command: "set_subagent_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_fast";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: RpcModel[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "create_mixture";
			success: true;
			data: { name: string; path: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_mixtures";
			success: true;
			data: {
				mixtures: Array<{
					name: string;
					path: string;
					registered: boolean;
					errors: Array<{ code: string; path: string; message: string }>;
				}>;
				warnings: string[];
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "select_mixture";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_roles";
			success: true;
			data: RpcRolesResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "query_model_selector";
			success: true;
			data: RpcModelSelectorResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_role";
			success: true;
			data: RpcSetRoleResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_models_configuration";
			success: true;
			data: Awaited<ReturnType<RpcModelsConfiguration["read"]>>;
	  }
	| { id?: string; type: "response"; command: "set_model_role_configuration"; success: true }
	| { id?: string; type: "response"; command: "set_model_role_fallbacks"; success: true }
	| { id?: string; type: "response"; command: "set_model_role_description"; success: true }
	| { id?: string; type: "response"; command: "delete_model_role"; success: true }
	| { id?: string; type: "response"; command: "set_model_role_storage"; success: true }
	| { id?: string; type: "response"; command: "set_effort_rules"; success: true }
	| { id?: string; type: "response"; command: "set_provider_api_key"; success: true }
	| { id?: string; type: "response"; command: "cancel_login"; success: true }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Cache warming
	| { id?: string; type: "response"; command: "set_cache_warming"; success: true; data: { mode: CacheWarmingMode } }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "get_usage"; success: true; data: RpcUsageResult }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "abort_branch_summary"; success: true }
	| { id?: string; type: "response"; command: "set_label"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	// Live voice
	| { id?: string; type: "response"; command: "live_start"; success: true; data: { voice: string } }
	| {
			id?: string;
			type: "response";
			command: "live_connect";
			success: true;
			data: { voice: string; sdpAnswer: string };
	  }
	| { id?: string; type: "response"; command: "live_stop"; success: true }
	| { id?: string; type: "response"; command: "live_mute"; success: true; data: { muted: boolean } }
	// Draft-only speech-to-text
	| { id?: string; type: "response"; command: "dictation_start"; success: true }
	| { id?: string; type: "response"; command: "dictation_stop"; success: true; data: { text: string } }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: RpcLoginProvider[] };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }
	| {
			id?: string;
			type: "response";
			command: "get_logout_accounts";
			success: true;
			data: { accounts: LogoutAccount[] };
	  }
	| { id?: string; type: "response"; command: "logout"; success: true; data: { remainingSource?: string } }
	| { id?: string; type: "response"; command: "activate_account"; success: true }

	// Word prediction
	| { id?: string; type: "response"; command: "predict_word"; success: true; data: { suffix: string | null } }
	| { id?: string; type: "response"; command: "predict_word_feedback"; success: true }

	// Side questions (/btw)
	| { id?: string; type: "response"; command: "btw"; success: true; data: { record: RpcBtwHistoryRecord } }
	| { id?: string; type: "response"; command: "btw_cancel"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_btw_history";
			success: true;
			data: { records: readonly RpcBtwHistoryRecord[] };
	  }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ============================================================================
// Side question (/btw) frames (stdout)
// ============================================================================

/**
 * A BTW topic as sent to RPC hosts. The TUI-only `title` heading is never on the wire,
 * which keeps the released record shape: hosts show the topic's opening question.
 */
export type RpcBtwHistoryRecord = Omit<BtwHistoryRecord, "title">;

/** Text appended to the running side question's latest answer. */
export interface RpcBtwDeltaFrame {
	type: "btw_delta";
	recordId: string;
	delta: string;
}

/** Full record snapshot on every lifecycle change: started, complete, cancelled, error. */
export interface RpcBtwRecordFrame {
	type: "btw_record";
	record: RpcBtwHistoryRecord;
}

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

/** Message lifecycle event kinds that RPC mode stamps with a `messageId`. */
export type RpcMessageEventType = "message_start" | "message_update" | "message_end";

/**
 * Message lifecycle frame as written by RPC mode. `messageId` is shared by the
 * `message_start`, every `message_update`, and the `message_end` of one message;
 * native-owner IDs are opaque and remain distinct across owner incarnations.
 */
export type RpcMessageEventFrame = Extract<AgentSessionEvent, { type: RpcMessageEventType }> & { messageId: string };

/** Current native unsaved assistant, sent at an ordered subscription/snapshot boundary. */
export type RpcMessageSnapshotFrame = Extract<RpcMessageEventFrame, { type: "message_start" }> &
	SessionJournalIdentity & { snapshot: true };

type WithoutPartial<T> = T extends unknown ? Omit<T, "partial"> : never;
type DeltaOf<Type extends AssistantMessageEvent["type"]> = WithoutPartial<
	Extract<AssistantMessageEvent, { type: Type }>
>;

/**
 * `assistantMessageEvent` of a delta `message_update`: `*_delta` carries only the increment; a `*_start` carries the
 * shell of the block it opened (`partial.content[contentIndex]` with its text, thinking, or tool arguments emptied, so
 * the deltas that follow apply cleanly); `text_end`/`thinking_end` carry the rest of the block (everything but the text
 * their `content` already holds); `image_end` and `toolcall_end` carry the whole block as `content` / `toolCall`. A
 * re-`start` carries the whole message it restarts from; that snapshot may already be ahead of the stream, so each
 * block's `*_end` is authoritative. `block` is absent only if the provider's `contentIndex` points at no block.
 */
export type RpcDeltaAssistantMessageEvent =
	| DeltaOf<"text_delta" | "thinking_delta" | "toolcall_delta" | "image_end" | "toolcall_end">
	| (DeltaOf<"text_start" | "thinking_start" | "toolcall_start"> & { block?: AssistantMessage["content"][number] })
	| (DeltaOf<"text_end"> & { block?: Omit<TextContent, "text"> })
	| (DeltaOf<"thinking_end"> & { block?: Omit<ThinkingContent, "thinking"> })
	| (DeltaOf<"start"> & { message: AssistantMessage })
	| Extract<AssistantMessageEvent, { type: "done" | "error" }>;

/** Opt-in projection (`messageUpdates: "delta"`): enough to rebuild the message client-side; terminal subtypes pass through. */
export type RpcDeltaMessageUpdateFrame = Omit<
	Extract<RpcMessageEventFrame, { type: "message_update" }>,
	"message" | "assistantMessageEvent"
> & {
	message: Pick<AgentMessage, "role">;
	assistantMessageEvent: RpcDeltaAssistantMessageEvent;
};

/** Links live output to its canonical journal entry only after successful persistence. */
export type RpcMessagePersistedFrame = SessionJournalIdentity & {
	type: "message_persisted";
	messageId: string;
	entryId: string;
};
/** Snapshot-only recovery identities; absent on older producers and non-snapshot state changes. */
export type RpcJournalStateFrame = Extract<SessionJournalEvent, { type: "journal_state" }> & {
	messageEntryIds?: MessageEntryIdentity[];
};
export type RpcJournalEventFrame =
	| Exclude<SessionJournalEvent, { type: "journal_state" }>
	| RpcJournalStateFrame
	| RpcMessagePersistedFrame
	| RpcMessageSnapshotFrame;

/** Session event as written to stdout by default: message lifecycle events carry a `messageId`. */
export type RpcAgentSessionEventFrame =
	| Exclude<AgentSessionEvent, { type: RpcMessageEventType }>
	| RpcMessageEventFrame;

/** Every session event shape RPC mode can write, including the opt-in `messageUpdates: "delta"` projection. */
export type RpcProjectedSessionEventFrame =
	| RpcAgentSessionEventFrame
	| RpcDeltaMessageUpdateFrame
	| RpcJournalEventFrame;

export type RpcSessionEventFrame = RpcAgentSessionEventFrame | RpcSubagentFrame | RpcJournalEventFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================
/** Positional presentation metadata for an RPC select option. */
export interface RpcExtensionUISelectOptionDetail {
	description?: string;
}

/** One question of an RPC `ask` dialog. Options never include "Other"; hosts always offer free text. */
export interface RpcAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string; preview?: string }>;
	multi?: boolean;
	/** Index of the recommended option. */
	recommended?: number;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			optionDetails?: RpcExtensionUISelectOptionDetail[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			secret?: boolean;
			loginId?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	/** Emitted only after the host opts in with `set_ask_dialog`. */
	| {
			type: "extension_ui_request";
			id: string;
			method: "ask";
			questions: RpcAskDialogQuestion[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
			/** User-facing device verification code; never the private polling device_code. */
			userCode?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
	/** Whether this host tool can read `skill://` instruction content. */
	readsSkillUris?: boolean;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Tool Approval Frames (bidirectional)
// ============================================================================

/** Who answers tool approvals: the `extension_ui_request` select dialog (`ui`) or typed frames (`host`). */
export type RpcApprovalHandler = "host" | "ui";

/** A host's answer to one {@link RpcToolApprovalRequest}. */
export type RpcToolApprovalDecision = "allow_once" | "allow_session" | "deny";

/** A pending provider safety check attached to a computer-use tool call. */
export interface RpcToolApprovalSafetyCheck {
	id: string;
	code?: string;
	message?: string;
}

/** Emitted (with `set_approval_handler: host`) when a tool call needs approval. */
export interface RpcToolApprovalRequest {
	type: "tool_approval_request";
	id: string;
	toolCallId: string;
	toolName: string;
	/** The exact input that runs when approved (after any `tool_call` handler revision). */
	args: unknown;
	tier: ToolTier;
	approvalMode: ApprovalMode;
	reason?: string;
	details: string[];
	/** Present only when provider safety checks are pending. */
	safetyChecks?: RpcToolApprovalSafetyCheck[];
	/** Milliseconds until the request resolves as `deny`. */
	timeout: number;
}

/** Emitted when a pending approval request is abandoned because the tool call was aborted. */
export interface RpcToolApprovalCancel {
	type: "tool_approval_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to answer a pending {@link RpcToolApprovalRequest}. */
export type RpcToolApprovalResponse =
	| { type: "tool_approval_response"; id: string; decision: RpcToolApprovalDecision; reason?: string }
	| { type: "tool_approval_response"; id: string; cancelled: true };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }
	/** Answers to an `ask` request, one per question in request order. */
	| {
			type: "extension_ui_response";
			id: string;
			answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
	  };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
