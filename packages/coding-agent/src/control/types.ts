/**
 * Wire types for the live control socket (issue #171).
 *
 * A control connection speaks the stdio RPC protocol (`RpcCommand`, the six
 * side-channel frames, every outbound frame family) plus the control-only
 * commands declared here. Correlation uses `requestId`; the RPC `id` field is
 * honored as an alias for the 53 RPC commands so unmodified RPC clients work.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { RpcCommand, RpcHostToolDefinition, RpcHostUriSchemeDefinition, RpcSessionState } from "../modes/rpc/rpc-types";

/** Control protocol version announced in the `challenge` frame. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** Role of the process/session that published an endpoint. */
export type ControlRole = "tui" | "rpc" | "acp" | "print";

/** Monotonic counters used as optimistic-concurrency preconditions (plan §3.5). */
export interface Revisions {
	/** Bumps on every session change (new/switch/branch/resume). */
	generation: number;
	/** Bumps on every byte the human typed into the terminal. */
	human: number;
	/** Bumps on focus change, overlay push/pop, and every human input the focused component consumed. */
	focus: number;
	/** Bumps on every human-editor content/image/cursor change. */
	draft: number;
	/** Bumps when a dialog opens, closes, or settles. */
	dialogs: number;
	/** Bumps per completed paint. */
	paint: number;
	/** `provider/id` of the current model. */
	model: string | null;
	/** Active role, when the model was selected through one. */
	role: string | null;
}

/** Revision fields a client may pass as a precondition. */
export type RevisionExpectation = Partial<Pick<Revisions, "generation" | "human" | "focus" | "draft" | "dialogs">> & {
	/** Required by the `dialog` class: the dialog the client observed. */
	dialogId?: string;
};

/** Precondition class a command belongs to (plan §3.5). */
export type PreconditionClass = "none" | "commit" | "surface" | "draft" | "dialog" | "mount";

/** Stable error codes a control response may carry beyond the RPC codes. */
export type ControlErrorCode =
	| "unauthorized"
	| "self_target"
	| "nested_target"
	| "cycle"
	| "conflict"
	| "precondition_required"
	| "generation_changed"
	| "no_tui"
	| "not_focused"
	| "unknown_action"
	| "unknown_dialog"
	| "dialog_settled"
	| "approval_owner_only"
	| "approval_settled"
	| "secret_input_disabled"
	| "exempt_job_control"
	| "exempt_external_program"
	| "exempt_double_press"
	| "key_unencodable"
	| "keys_too_large"
	| "rate_limited"
	| "startup_in_progress"
	| "tool_name_taken"
	| "scheme_taken"
	| "unknown_request"
	| "repl_mode"
	| "timeout"
	| "cancelled"
	| "probe_only"
	| "unknown_setting"
	| "invalid_value"
	| "unknown_agent"
	| "cross_root"
	| "unknown_inbox"
	| "gone";

/** A control-origin marker carried on prompts, notices, approvals, and entries. */
export interface ControlOrigin {
	kind: "control";
	/** Server-assigned connection id (`c3`). */
	connectionId: string;
	/** Display label (client-chosen, 1–64 printable characters). */
	label: string;
	/** Peer process id from SO_PEERCRED. */
	peerPid: number;
	/** Validated caller session publication, when the caller is an npi session. */
	callerInstanceId?: string;
	/** Request handle of the request that produced this effect. */
	requestHandle?: string;
	/** Instance ids controlling the caller (oldest first) plus the caller itself. */
	controlChain?: string[];
}

/** Where an input came from, for provenance and approval policy. */
export type InputOrigin = { kind: "keyboard" } | { kind: "owner-host"; host: string } | ControlOrigin | { kind: "extension" };

/** Delivery outcome of a submission (plan §3.4). */
export type ControlDelivery = "started" | "steered" | "followUp" | "compactionQueued" | "chained" | "local" | "refused";

/** One dialog currently mounted on the session (plan §4.F). */
export interface DialogSummary {
	dialogId: string;
	family: DialogFamily;
	kind: string;
	title: string;
	/** Whether this connection may settle it (approvals: only under `control.approvals`). */
	answerable: boolean;
	/** Who opened it. */
	openedBy: "keyboard" | "control" | "agent" | "extension" | "system";
	/** Family-specific structured description (options, questions, fields). */
	schema?: unknown;
	/** Revision of the `dialogs` counter when it opened. */
	openedAt: number;
}

export type DialogFamily =
	| "extension"
	| "ask"
	| "approval"
	| "plan_review"
	| "login"
	| "session_in_use"
	| "confirm"
	| "selector"
	| "app"
	| "panel"
	| "custom";

/** A key input token for `keys`. */
export type KeyToken = { key: string } | { text: string };

/** Snapshot served by `hello`, `get_status`, and `state` (plan §3.4). */
export interface ControlSnapshot {
	version: 1;
	instanceId: string;
	imageId: string;
	role: ControlRole;
	pid: number;
	ready: boolean;
	build: { version: string; gitSha: string | null; dirty: boolean | null; execPath: string };
	tmux: { pane: string | null; session: string | null; window: string | null };
	cwd: string;
	title: string | null;
	/** Root session state, or the viewed session's when `target:"view"`. */
	session: RpcSessionState | null;
	root?: { sessionId: string; generation: number };
	busy: { streaming: boolean; compacting: boolean; queued: number; pendingAsyncWork: boolean; settled: boolean };
	revisions: Revisions;
	/** Focused-surface view: null for headless roles. */
	view: {
		focus: string | null;
		overlays: number;
		focusedAgent: string | null;
		liveDestination: string | null;
		replMode: string | null;
		draftLength: number;
	} | null;
	/** Mode flags. */
	modes: { plan: boolean; chat: string; goal: boolean; vibe: boolean; live: boolean; repl: boolean };
	dialogs: DialogSummary[];
	connections: number;
	requests: { open: number; retained: number };
	hosts: Array<{ kind: string; canPresent: boolean; canApprove: boolean }>;
	approvals: { controlAllowed: boolean; pending: number };
	exemptions: string[];
}

/** Explicit exceptions served in `snapshot.exemptions` (plan §4.J). */
export const CONTROL_EXEMPTIONS: readonly string[] = [
	"app.suspend: OS job control; a stopped process cannot serve its socket (exempt_job_control)",
	"app.editor.external, /todo edit, dialog external-editor shortcuts: external $EDITOR/child programs (exempt_external_program); twins draft_get/draft_set, set_todos, dialog_answer",
	"app.clear double-press shutdown (exempt_double_press); use /exit",
	"tool approvals from control connections only under control.approvals",
];

// ============================================================================
// Control-only commands (plan §3.3)
// ============================================================================

interface ControlBase {
	/** Correlation id echoed on the response. */
	requestId?: string;
	/** Optimistic-concurrency preconditions. */
	if?: RevisionExpectation;
}

export type ControlOnlyCommand =
	| (ControlBase & {
			type: "hello";
			token: string;
			client: {
				label: string;
				kind: "tool" | "cli" | "other";
				callerInstanceId?: string | null;
				callerConnectionToken?: string | null;
				controlChain?: string[];
			};
			override?: { allowSelf?: boolean; allowNested?: boolean };
			protocolVersion?: number;
			/** Read-only probe used by `list`: only `get_status`/`bye` are served. */
			probe?: boolean;
	  })
	| (ControlBase & { type: "bye" })
	| (ControlBase & { type: "get_status"; target?: "root" | "view" })
	| (ControlBase & { type: "state"; target?: "root" | "view" })
	| (ControlBase & {
			type: "subscribe";
			events?: "all" | "lifecycle" | "none";
			filter?: string[];
			subagents?: "off" | "progress" | "events";
			ui?: boolean;
			approvals?: boolean;
			screen?: boolean;
			status?: boolean;
			requests?: boolean;
	  })
	| (ControlBase & {
			type: "input";
			text: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			chain?: boolean;
			target?: "context" | "root";
	  })
	| (ControlBase & { type: "slash"; text: string })
	| (ControlBase & { type: "action"; actionId: string; args?: Record<string, unknown> })
	| (ControlBase & { type: "keys"; keys: KeyToken[] })
	| (ControlBase & { type: "paste"; text: string })
	| (ControlBase & { type: "mouse"; x: number; y: number; action?: "click" | "press" | "release" | "scrollUp" | "scrollDown" | "move" })
	| (ControlBase & { type: "screen"; mode?: "text" | "tree" | "info" | "values" | "frame" })
	| (ControlBase & { type: "dialogs" })
	| (ControlBase & { type: "dialog_answer"; dialogId: string; answer: unknown })
	| (ControlBase & { type: "esc" })
	| (ControlBase & { type: "rewind"; entryId: string; prefillDraft?: boolean })
	| (ControlBase & { type: "cycle_role_model"; direction?: "forward" | "backward" })
	| (ControlBase & { type: "switch_model"; selector: string; thinkingLevel?: string })
	| (ControlBase & { type: "repl_execute"; code: string; target?: string })
	| (ControlBase & { type: "draft_get" })
	| (ControlBase & { type: "draft_set"; text: string; images?: ImageContent[] })
	| (ControlBase & { type: "draft_insert"; text: string })
	| (ControlBase & { type: "draft_clear" })
	| (ControlBase & { type: "dequeue"; restoreToDraft?: boolean })
	| (ControlBase & {
			type: "wait";
			for: "request" | "yield" | "settled" | "dialog" | "approval" | "transition" | "paint" | "idle_ui";
			requestHandle?: string;
			after?: number;
			timeoutMs?: number;
	  })
	| (ControlBase & { type: "requests"; requestHandle?: string })
	| (ControlBase & {
			type: "settings_get";
			path?: string;
			member?: string;
			read?: "effective" | "layered";
	  })
	| (ControlBase & {
			type: "settings_set";
			path: string;
			value: unknown;
			member?: string;
			scope?: "persist" | "runtime";
			layer?: "user" | "project";
	  })
	| (ControlBase & { type: "settings_unset"; path: string; member?: string; scope?: "persist" | "runtime" })
	| (ControlBase & { type: "keybindings_get"; actionId?: string })
	| (ControlBase & { type: "keybindings_set"; actionId: string; keys: string[] })
	| (ControlBase & { type: "keybindings_reload" })
	| (ControlBase & {
			type: "agents";
			op: "list" | "send" | "wait" | "inbox" | "kill" | "revive" | "describe" | "focus" | "unfocus";
			agentId?: string;
			to?: string;
			message?: string;
			replyTo?: string;
			inboxHandle?: string;
			from?: string;
			peek?: boolean;
			timeoutMs?: number;
	  })
	| (ControlBase & { type: "commands" })
	| (ControlBase & {
			type: "serve";
			tools?: RpcHostToolDefinition[];
			schemes?: RpcHostUriSchemeDefinition[];
			serviceId?: string;
	  })
	| (ControlBase & { type: "unserve"; serviceId: string })
	| (ControlBase & { type: "todo_set"; phases: TodoPhase[] });

export type ControlOnlyCommandType = ControlOnlyCommand["type"];

/** Every command a control connection accepts. */
export type ControlCommand = (RpcCommand & { requestId?: string; if?: RevisionExpectation }) | ControlOnlyCommand;
export type ControlCommandType = ControlCommand["type"];

/** Reply class of a command (plan §3.2). */
export type ReplyClass = "admission" | "completion" | "immediate";

/** Response frame for a control command. */
export interface ControlResponse {
	type: "response";
	command: string;
	requestId?: string;
	id?: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

/** `challenge` frame sent by the server before authentication. */
export interface ControlChallengeFrame {
	type: "challenge";
	instanceId: string;
	protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
	supportedProtocolVersions: [1, 2];
}

/** Terminal record of an admitted request (plan §3.8). */
export interface RequestCompletion {
	status: "completed" | "aborted" | "error" | "conflict";
	error?: string;
	reason?: string;
	sessionSettled: boolean;
	agentInvoked: boolean;
	at: number;
}

export interface RequestLedgerRecord {
	requestHandle: string;
	kind: string;
	origin: ControlOrigin;
	generation: number;
	admittedAt: number;
	replyClass: ReplyClass;
	completion: RequestCompletion | null;
	runRange: { agentStart: number; agentEnd: number | null } | null;
	userEntryId?: string;
	assistantEntryIds: string[];
	/** Assistant text of the run's own messages, in order (for `send --wait`). */
	assistantText: string[];
}

/** Thrown by guarded commits; surfaced as `code:"conflict"`. */
export class ControlConflictError extends Error {
	readonly code = "conflict";
	constructor(
		message: string,
		readonly field?: string,
	) {
		super(message);
		this.name = "ControlConflictError";
	}
}

/** Structured control error carrying a stable code. */
export class ControlError extends Error {
	constructor(
		readonly code: ControlErrorCode | string,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "ControlError";
	}
}
