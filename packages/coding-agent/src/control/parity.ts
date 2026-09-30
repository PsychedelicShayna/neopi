/**
 * Compile-time inventory of every RPC command the control socket must serve.
 * A missing member fails the build: `Missing` would not be `never`.
 */
import type { RpcCommand } from "../modes/rpc/rpc-types";

export const RPC_COMMAND_TYPES = [
	"negotiate_protocol",
	"prompt",
	"steer",
	"remove_queued_message",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"new_session",
	"open_session",
	"get_state",
	"set_fast_mode",
	"set_chat_mode",
	"set_mode",
	"get_available_commands",
	"get_entries",
	"get_tree",
	"set_todos",
	"set_host_tools",
	"set_host_uri_schemes",
	"set_subagent_subscription",
	"set_event_filter",
	"set_approval_handler",
	"get_subagents",
	"get_subagent_messages",
	"set_model",
	"cycle_model",
	"get_available_models",
	"list_mixtures",
	"create_mixture",
	"select_mixture",
	"get_roles",
	"set_role",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_cache_warming",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"get_usage",
	"export_html",
	"switch_session",
	"branch",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"handoff",
	"get_messages",
	"get_messages_page",
	"get_login_providers",
	"login",
] as const satisfies readonly RpcCommand["type"][];

type MissingRpcCommand = Exclude<RpcCommand["type"], (typeof RPC_COMMAND_TYPES)[number]>;
type ExtraRpcCommand = Exclude<(typeof RPC_COMMAND_TYPES)[number], RpcCommand["type"]>;
type _RpcInventoryComplete = MissingRpcCommand extends never ? (ExtraRpcCommand extends never ? true : never) : never;
const _rpcInventoryComplete: _RpcInventoryComplete = true;
void _rpcInventoryComplete;
