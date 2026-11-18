/**
 * Optional features advertised in the RPC `ready` frame's `capabilities` array.
 *
 * Hosts (T3 Code, OMP Deck) gate optional features on these exact strings, never
 * on NeoPi version numbers. Add a string only in the change that ships its
 * commands/frames, and never rename one: a renamed string silently turns the
 * feature off for every host that gates on the old name.
 *
 * One string per line, each tagged with its issue, keeps concurrent additions
 * merge-friendly (the trailing comments also stop the formatter folding it).
 */
export const RPC_CAPABILITIES: readonly string[] = [
	"get_usage", // #105
	"get_roles", // #104
	"themes_configuration", // #526
	"theme_palette", // Read a named native palette without selecting it.
	"model_selector", // Read-only native /switch query and row facts.
	"models_configuration", // Native model hub configuration and scoped role writes.
	"cancellable_login", // Native auth prompts and request-scoped cancellation.
	"set_chat_mode", // #109
	"tool_approval_request", // #102
	"set_mode", // #103
	"new_session", // #107
	"session_lease", // #106
	"plan_proposal_cancel", // #118
	"prompt_entry_ids", // #117
	"session_catalog", // #355
	"session_history_identity", // Native selected-branch transcript identities.
	"session_journal_events", // Confirmed journal entries, native leaf and session identity notifications.
	"session_tree_navigation", // Guarded same-file tree navigation and explicit ask re-answer resume.
	"session_journal", // Canonical journal paging over RPC, control and the read-only CLI.
	"control_pipe", // #355
	"connection_owned_host_tools", // #593; set_host_tools is scoped to its registering connection (#592).
	"set_subagent_model", // #492; set_subagent_model switches an owned running subagent's model for its next request.
	"cycle_role", // #666; cycle_role is Ctrl+P role cycling, and get_roles reports cycleOrder.
	"status_facts", // #667; get_state.hostname, activeTimeMs and runningJobCount.
	"background_jobs", // #665; get_jobs, get_job_output, cancel_job, and stdio job_lifecycle frames.
	"command_catalog", // Every slash command with its availability; TUI-only commands refused, not sent to the model.
	"command_completions", // get_command_completions: argument completions for hosts without a terminal.
	"abort_and_restore_queue", // Atomic Esc: withdraw queued user input and abort in one command, also over control.
	"exit_with_parent", // --exit-with-parent: an RPC host's death or stdin EOF aborts and exits within seconds.
	"subagent_history", // get_subagent_history: the full persisted roster; get_subagent_messages reads persisted children.
];

/**
 * Capabilities only the stdio transport serves. The control socket answers its `hello` from
 * {@link RPC_CAPABILITIES} alone, so a feature the socket cannot serve never appears there.
 */
const RPC_STDIO_CAPABILITIES: readonly string[] = [
	"dictation", // #668; dictation_start/dictation_stop and their frames, and get_state.dictationEnabled.
];

/** What the stdio `ready` frame advertises. */
export function stdioCapabilities(): string[] {
	return [...RPC_CAPABILITIES, ...RPC_STDIO_CAPABILITIES];
}
