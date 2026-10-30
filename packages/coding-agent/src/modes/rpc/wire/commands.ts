/**
 * The RPC command table: every `RpcCommand` with its parameters, its success
 * `data`, and the client-library metadata generators need.
 *
 * Inline `params`/`result` object definitions are registered in the scope as
 * `<Command>Params` / `<Command>Result`; a string names a shared definition.
 */
import { doc } from "./dsl";

/** One RPC command as described to generators. */
export interface RpcCommandSpec {
	/** Wire `type` of the command. */
	name: string;
	/** One-line description emitted on generated client methods. */
	doc: string;
	/** Command fields besides `id`/`type`: an object definition, or the name of one. */
	params?: Record<string, unknown> | string;
	/** `data` of a successful response; absent when the response carries none. */
	result?: Record<string, unknown> | string;
	/** `data` may be `null` (e.g. nothing to cycle to, no handoff produced). */
	nullable?: boolean;
	/** The result is a one-field envelope; client libraries return this field. */
	unwrap?: string;
	/** Response deadline that overrides the client default, in milliseconds. */
	timeoutMs?: number;
	/** The command's work ends with a `prompt_result` frame carrying the request id. */
	completion?: "prompt_result";
	/** Parameters client libraries intentionally leave to raw-protocol callers. */
	clientOmit?: string[];
}

const IMAGES = doc("ImageContent[]", "Images attached to the message.");

export const rpcCommands: readonly RpcCommandSpec[] = [
	{
		name: "negotiate_protocol",
		doc: "Switch the connection to a protocol version advertised by `ready`.",
		params: { protocolVersion: "number.integer" },
		result: { protocolVersion: "number.integer" },
	},
	{
		name: "prompt",
		doc: "Submit a prompt; acknowledged once admitted, completed by its `prompt_result`.",
		params: { message: "string", "images?": IMAGES, "streamingBehavior?": "StreamingBehavior" },
		result: "PromptAck",
		completion: "prompt_result",
	},
	{
		name: "steer",
		doc: "Queue a steering message.",
		params: { message: "string", "images?": IMAGES },
		result: { userEntryId: "string" },
	},
	{
		name: "follow_up",
		doc: "Queue a follow-up message.",
		params: { message: "string", "images?": IMAGES },
		result: { userEntryId: "string" },
	},
	{
		name: "remove_queued_message",
		doc: "Remove one pending queued message by its queue-chip text.",
		params: { message: "string", queue: "QueuedMessageQueue" },
		result: "RemoveQueuedMessageResult",
	},
	{
		name: "promote_queued_message",
		doc: "Move one queued follow-up to the end of the steering queue.",
		params: { message: "string" },
		result: "PromoteQueuedMessageResult",
	},
	{ name: "abort", doc: "Abort the current run." },
	{
		name: "abort_and_prompt",
		doc: "Abort the current run and submit a prompt; completed by its `prompt_result`.",
		params: { message: "string", "images?": IMAGES },
		result: { userEntryId: "string" },
		completion: "prompt_result",
	},
	{
		name: "abort_and_restore_queue",
		doc: "Withdraw queued user input, then abort the current run; returns the withdrawn input.",
		result: "AbortAndRestoreQueueResult",
	},
	{
		name: "new_session",
		doc: "Start a new session.",
		params: { "parentSession?": "string" },
		result: "CancellationResult",
	},
	{
		name: "open_session",
		doc: "Continue the newest non-empty session in a directory, or start a fresh one there. Give provider and modelId together to override the saved model; otherwise an unavailable saved model fails the request.",
		params: { sessionDir: "string", "provider?": "string", "modelId?": "string" },
		result: "OpenSessionResult",
	},

	{
		name: "get_state",
		doc: "Snapshot the session state.",
		params: { "includeDump?": "boolean" },
		result: "SessionState",
	},
	{
		name: "create_mixture",
		doc: "Save and register a mixture.",
		params: { scope: "MixtureConfigScope", definition: "MixtureDefinition" },
		result: { name: "string", path: "string" },
	},
	{
		name: "list_mixtures",
		doc: "List discovered mixtures.",
		result: { mixtures: "MixtureCatalogItem[]", warnings: "string[]" },
	},
	{ name: "select_mixture", doc: "Select a registered mixture.", params: { name: "string" }, result: "ModelInfo" },
	{ name: "get_roles", doc: "List model roles.", result: "RolesResult" },
	{
		name: "get_themes_configuration",
		doc: "Read native theme discovery and scoped selections.",
		result: "ThemesConfiguration",
	},
	{
		name: "get_theme",
		doc: "Read the resolved colors of one installed native theme without selecting it.",
		params: { name: "string" },
		result: "ThemePalette",
	},
	{
		name: "update_theme",
		doc: "Set or inherit one native theme slot with an expected scoped value.",
		params: {
			appearance: "'dark' | 'light'",
			scope: "'global' | 'project'",
			name: "string | null",
			expected: "string | null",
		},
		result: "ThemesConfiguration",
	},
	{
		name: "query_model_selector",
		doc: "Query native /switch ordering, scoped candidates, role aliases and model facts without selecting.",
		params: { query: "string" },
		result: "ModelSelectorResult",
	},
	{
		name: "set_role",
		doc: "Select a model role.",
		params: { role: "string" },
		result: { role: "string", model: "ModelInfo", "thinkingLevel?": "ThinkingLevel" },
	},
	{
		name: "get_models_configuration",
		doc: "Read the native provider catalog, scoped model roles, and effort rules.",
		result: {
			providers: "Record<string, unknown>[]",
			models: "Record<string, unknown>[]",
			roles: "Record<string, unknown>[]",
			roleStorage: "'global' | 'project'",
			effortMode: "'replacement' | 'legacy'",
			effortRules: "ModelEffortRule[]",
			effortRulesProvenance: "string",
			effortRuleScopes: "ModelEffortRuleScopes",
			effortChoices: "string[]",
		},
	},
	{
		name: "set_model_role_configuration",
		doc: "Save or clear a role selector and effort in the explicit scope, independently of the default role-storage preference.",
		params: {
			role: "string",
			scope: "'global' | 'project'",
			"selector?": "string",
			"effort?": "ModelEffortSelection",
			expected: "ModelRoleConfigurationValue",
		},
	},
	{
		name: "set_model_role_fallbacks",
		doc: "Save one role's native global fallback chain and per-entry efforts, rejecting stale values.",
		params: {
			role: "string",
			scope: "'global' | 'project'",
			chain: "string[]",
			efforts: "Record<string, ModelEffortSelection>",
			expected: "ModelRoleFallbacks",
		},
	},
	{
		name: "set_model_role_description",
		doc: "Save one known role's global description without replacing its other metadata.",
		params: { role: "string", scope: "'global' | 'project'", description: "string", expected: "string | null" },
	},
	{
		name: "delete_model_role",
		doc: "Delete a custom role definition in one scope; refuse built-ins and preserve inherited definitions.",
		params: { role: "string", scope: "'global' | 'project'", expected: "ModelRoleConfigurationValue" },
	},
	{
		name: "set_model_role_storage",
		doc: "Choose native global or project role storage, rejecting a stale preference.",
		params: { value: "'global' | 'project'", expected: "'global' | 'project'" },
	},
	{
		name: "set_effort_rules",
		doc: "Save or clear native implicit effort rules in one scope, rejecting a stale expected value.",
		params: { scope: "'global' | 'project'", "rules?": "ModelEffortRule[]", expected: "ModelEffortRule[] | null" },
	},
	{
		name: "set_provider_api_key",
		doc: "Upsert a key in the native credential store without replacing other accounts.",
		params: { providerId: "string", apiKey: "string" },
	},
	{
		name: "cancel_login",
		doc: "Cancel this connection's active login request.",
		params: { loginId: "string" },
	},
	{
		name: "get_usage",
		doc: "Read provider usage reports.",
		params: { "provider?": "string", "refresh?": "boolean", "redact?": "boolean" },
		result: { generatedAt: "number.integer", reports: "ProviderUsageReport[]" },
	},
	{
		name: "set_approval_handler",
		doc: "Select who answers tool approvals.",
		params: { handler: "ApprovalHandler" },
		result: { handler: "ApprovalHandler" },
	},
	{
		name: "set_chat_mode",
		doc: "Switch live chat mode.",
		params: { mode: "ChatModeSetting", "include?": "string | string[]" },
		result: "ChatModeState",
	},
	{
		name: "set_mode",
		doc: "Switch session mode.",
		params: { mode: "SessionMode", "planFilePath?": "string" },
		result: { mode: "SessionMode", "planFilePath?": "string" },
	},
	{
		name: "set_fast_mode",
		doc: "Enable or disable fast mode for the session.",
		params: { enabled: "boolean" },
		result: "FastModeResult",
	},
	{
		name: "set_slow_mode",
		doc: "Turn `/slow` on or off for the active model; returns whether it is now on.",
		params: { enabled: "boolean" },
		result: { enabled: "boolean" },
		unwrap: "enabled",
	},
	{
		name: "goal",
		doc: "Read or change goal mode with the lifecycle of the interactive `/goal` command.",
		params: { op: "GoalOp", "objective?": "string", "token_budget?": "number.integer" },
		result: "GoalResult",
	},
	{
		name: "set_ask_dialog",
		doc: "Opt in to `ask` UI requests; returns the applied setting.",
		params: { enabled: "boolean" },
		result: { enabled: "boolean" },
		unwrap: "enabled",
	},
	{
		name: "get_available_commands",
		doc: "List the slash-command catalog.",
		result: { commands: "AvailableSlashCommand[]" },
		unwrap: "commands",
	},
	{
		name: "get_entries",
		doc: "Read the append-history; with `since`, only entries strictly after that durable entry id.",
		params: { "since?": "string" },
		result: "SessionEntries",
	},
	{
		name: "snapshot_session_journal",
		doc: "Emit native journal identity, retained durable message associations and current unsaved assistant before responding, without replacing subscriptions.",
		result: "JournalIdentity",
	},
	{
		name: "get_entries_page",
		doc: "Read one canonical native journal or selected-branch page.",
		params: {
			"scope?": "'journal' | 'branch'",
			"direction?": "'forward' | 'backward'",
			"cursor?": "string",
			"limit?": "number.integer",
		},
		result: "JournalPage",
	},
	{ name: "get_tree", doc: "Read the raw session tree.", result: "SessionTree" },
	{
		name: "navigate_tree",
		doc: "Navigate the native tree in the same session file, optionally summarizing the abandoned branch; refused while busy. Rebuild the transcript before acknowledging a returned resumeToken.",
		params: {
			targetId: "string",
			expectedSessionId: "string",
			expectedSessionFile: "string | null",
			expectedLeafId: "string | null",
			"summarize?": doc("boolean", "Summarize the abandoned branch at the target."),
			"customInstructions?": doc("string", "Instructions for the summarizer."),
			"allowAskReopen?": "boolean",
			"reanswerAskResult?": "TreeAskReanswer",
		},
		result: "NavigateTreeResult",
		timeoutMs: 600_000,
	},
	{
		name: "resume_tree",
		doc: "Acknowledge a committed ask re-answer after consuming its navigation result and rebuilding the transcript.",
		params: {
			resumeToken: "string",
			expectedSessionId: "string",
			expectedSessionFile: "string | null",
			expectedLeafId: "string | null",
		},
		result: { resumed: "true" },
	},
	{
		name: "set_todos",
		doc: "Replace the session's todo phases.",
		params: { phases: "TodoPhase[]" },
		result: { todoPhases: "TodoPhase[]" },
		unwrap: "todoPhases",
	},
	{
		name: "set_host_tools",
		doc: "Replace the host-owned tools the server may call back into.",
		params: { tools: "HostToolDefinition[]" },
		result: { toolNames: "string[]" },
		unwrap: "toolNames",
	},
	{
		name: "set_host_uri_schemes",
		doc: "Replace the host-owned URI schemes.",
		params: { schemes: "HostUriSchemeDefinition[]" },
		result: { schemes: "string[]" },
		unwrap: "schemes",
	},
	{
		name: "set_subagent_subscription",
		doc: "Select which subagent frames are forwarded.",
		params: { level: "SubagentSubscriptionLevel" },
		result: { level: "SubagentSubscriptionLevel" },
		unwrap: "level",
	},
	{
		name: "set_event_filter",
		doc: "Forward only the listed session event types; null forwards all.",
		params: { events: "string[] | null", "messageUpdates?": "MessageUpdates" },
		result: { events: "string[] | null", "messageUpdates?": "MessageUpdates" },
		unwrap: "events",
		clientOmit: ["messageUpdates"],
	},
	{
		name: "get_subagents",
		doc: "List running subagents.",
		result: { subagents: "SubagentSnapshot[]" },
		unwrap: "subagents",
	},
	{
		name: "get_subagent_messages",
		doc: "Read a subagent transcript by id or registered session file (`subagentId` wins).",
		params: { "subagentId?": "string", "sessionFile?": "string", "fromByte?": "number.integer" },
		result: "SubagentMessages",
	},
	{
		name: "cancel_subagent",
		doc: "Hard-kill one running subagent; false when it is not running.",
		params: { subagentId: "string" },
		result: { cancelled: "boolean" },
		unwrap: "cancelled",
	},
	{
		name: "steer_subagent",
		doc: "Send a message to a running subagent as its user.",
		params: { subagentId: "string", message: "string" },
	},
	{
		name: "set_subagent_thinking_level",
		doc: "Set a running subagent's thinking level from its next request, preserving it across restore.",
		params: { subagentId: "string", level: "ThinkingLevel" },
	},
	{
		name: "set_subagent_fast",
		doc: "Enable or disable fast mode only for a running subagent, from its next request.",
		params: { subagentId: "string", enabled: "boolean" },
		result: "FastModeResult",
	},
	{
		name: "live_start",
		doc: "Start a live voice session bound to this session; returns the voice in use.",
		params: { "voice?": "string", "instructions?": "string" },
		result: { voice: "string" },
		unwrap: "voice",
	},
	{
		name: "live_connect",
		doc: "Start a live voice session whose audio runs on a caller-owned WebRTC peer: send its SDP offer, apply the returned answer.",
		params: { sdpOffer: "string", "voice?": "string", "instructions?": "string" },
		result: { voice: "string", sdpAnswer: "string" },
	},
	{ name: "live_stop", doc: "Stop the live voice session, if any." },
	{
		name: "live_mute",
		doc: "Set microphone mute, or toggle it when `muted` is omitted; returns the new state.",
		params: { "muted?": "boolean" },
		result: { muted: "boolean" },
		unwrap: "muted",
	},
	{
		name: "dictation_start",
		doc: "Start draft-only speech-to-text; resolves once the microphone is recording.",
		params: { captureId: "string" },
		timeoutMs: 600_000,
	},
	{
		name: "dictation_stop",
		doc: "Stop and flush draft-only dictation, returning the accumulated text.",
		result: { text: "string" },
		unwrap: "text",
		timeoutMs: 600_000,
	},

	{
		name: "set_model",
		doc: "Select a model by provider and id.",
		params: { provider: "string", modelId: "string" },
		result: "ModelInfo",
	},
	{ name: "cycle_model", doc: "Cycle to the next model.", result: "ModelCycleResult", nullable: true },
	{
		name: "get_available_models",
		doc: "List available models.",
		result: { models: "ModelInfo[]" },
		unwrap: "models",
	},
	{ name: "set_thinking_level", doc: "Set the thinking level.", params: { level: "ThinkingLevel" } },
	{
		name: "cycle_thinking_level",
		doc: "Cycle to the next thinking level.",
		result: "ThinkingLevelCycleResult",
		nullable: true,
	},
	{
		name: "get_available_thinking_levels",
		doc: 'Selectable thinking levels for the live model, `"off"` first.',
		result: { levels: "ThinkingLevel[]" },
		unwrap: "levels",
	},
	{ name: "set_steering_mode", doc: "Set how queued steering is delivered.", params: { mode: "QueueMode" } },
	{ name: "set_follow_up_mode", doc: "Set how queued follow-ups are delivered.", params: { mode: "QueueMode" } },
	{ name: "set_interrupt_mode", doc: "Set how steering interrupts tools.", params: { mode: "InterruptMode" } },
	{
		name: "compact",
		doc: "Compact the conversation.",
		params: { "customInstructions?": "string" },
		result: "CompactionResult",
	},
	{ name: "set_auto_compaction", doc: "Enable or disable auto-compaction.", params: { enabled: "boolean" } },
	{
		name: "set_cache_warming",
		doc: "Override cache warming for this session only; returns the effective mode.",
		params: { mode: "CacheWarmingMode" },
		result: { mode: "CacheWarmingMode" },
		unwrap: "mode",
	},
	{ name: "set_auto_retry", doc: "Enable or disable auto-retry.", params: { enabled: "boolean" } },
	{ name: "abort_retry", doc: "Abort a pending auto-retry." },
	{ name: "bash", doc: "Run a shell command.", params: { command: "string" }, result: "BashResult" },
	{ name: "abort_bash", doc: "Abort the running shell command." },

	{ name: "get_session_stats", doc: "Session statistics.", result: "SessionStats" },
	{
		name: "export_html",
		doc: "Export the session as HTML; returns the written path.",
		params: { "outputPath?": "string" },
		result: { path: "string" },
		unwrap: "path",
	},
	{
		name: "switch_session",
		doc: "Switch to another session file. Give provider and modelId together to override the saved model; otherwise an unavailable saved model fails the request and keeps the current session.",
		params: { sessionPath: "string", "provider?": "string", "modelId?": "string" },
		result: "CancellationResult",
	},
	{
		name: "branch",
		doc: "Branch the session at an entry.",
		params: { entryId: "string" },
		result: "BranchResult",
	},
	{
		name: "fork",
		doc: "Fork into a new session file: history through `entryId`, or the whole session.",
		params: { "entryId?": "string" },
		result: "CancellationResult",
	},
	{ name: "abort_branch_summary", doc: "Stop a running `navigate_tree` branch summary; the navigation is cancelled." },
	{
		name: "set_label",
		doc: "Set or clear (omit `label`) an entry's label.",
		params: { entryId: "string", "label?": "string" },
	},
	{
		name: "get_branch_messages",
		doc: "List user messages that can be branched from.",
		result: { messages: "BranchMessage[]" },
		unwrap: "messages",
	},
	{
		name: "get_last_assistant_text",
		doc: "Text of the last assistant message, if any.",
		result: { text: "string | null" },
		unwrap: "text",
	},
	{ name: "set_session_name", doc: "Rename the session.", params: { name: "string" } },
	{
		name: "handoff",
		doc: "Hand the conversation off to a fresh session; null when no handoff was produced.",
		params: { "customInstructions?": "string" },
		result: "HandoffResult",
		nullable: true,
	},

	{
		name: "get_messages",
		doc: "Every message of the session in one response.",
		result: { messages: "AgentMessage[]" },
		unwrap: "messages",
	},
	{
		name: "get_messages_page",
		doc: "One stable page of messages.",
		params: { "cursor?": "string", "limit?": "number.integer" },
		result: "MessagesPage",
	},

	{
		name: "get_login_providers",
		doc: "List OAuth providers and their authentication status.",
		result: { providers: "LoginProvider[]" },
		unwrap: "providers",
	},
	{
		name: "login",
		doc: "Run OAuth login; the flow arrives as `open_url` and `input` UI requests.",
		params: { providerId: "string" },
		result: { providerId: "string" },
		unwrap: "providerId",
		timeoutMs: 600_000,
	},
	{
		name: "get_logout_accounts",
		doc: "List the stored credentials `logout` can remove for a provider, active first.",
		params: { providerId: "string" },
		result: { accounts: "LogoutAccount[]" },
		unwrap: "accounts",
	},
	{
		name: "activate_account",
		doc: "Activate a stored OAuth account for this session through native credential affinity and journal pins.",
		params: { providerId: "string", credentialId: "number.integer" },
	},
	{
		name: "logout",
		doc: "Remove one stored credential; fails when it is no longer stored. `remainingSource` names auth that still applies.",
		params: { providerId: "string", credentialId: "number.integer" },
		result: { "remainingSource?": "string" },
	},

	{
		name: "predict_word",
		doc: "Ghost-text suffix for the prose word ending at `cursor` (a UTF-16 offset); null when none applies.",
		params: { text: "string", cursor: "number.integer" },
		result: { suffix: "string | null" },
		unwrap: "suffix",
		// One prediction runs per session with one more held behind it: a request may wait
		// out a cold daemon start (~150 s) before its own completion.
		timeoutMs: 155_000,
	},
	{
		name: "predict_word_feedback",
		doc: "Report a shown suggestion as accepted or typed past.",
		params: { text: "string", cursor: "number.integer", suggestion: "string", accepted: "boolean" },
	},
	{
		name: "btw",
		doc: "Ask a side question, or a follow-up in topic `recordId`; returns the record once it is running.",
		params: { question: "string", "recordId?": "string" },
		result: { record: "BtwHistoryRecord" },
		unwrap: "record",
	},
	{
		name: "btw_cancel",
		doc: "Cancel the running side question (only topic `recordId` when given); false when none matches.",
		params: { "recordId?": "string" },
		result: { cancelled: "boolean" },
		unwrap: "cancelled",
	},
	{
		name: "get_btw_history",
		doc: "List the session's side-question records, newest first.",
		result: { records: "BtwHistoryRecord[]" },
		unwrap: "records",
	},
];
