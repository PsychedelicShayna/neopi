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
	"set_chat_mode", // #109
	"tool_approval_request", // #102
	"set_mode", // #103
	"new_session", // #107
	"session_lease", // #106
];
