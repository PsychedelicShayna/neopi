/**
 * Optional features advertised in the RPC `ready` frame's `capabilities` array.
 *
 * Hosts (T3 Code, OMP Deck) gate optional features on these exact strings, never
 * on NeoPi version numbers. Add a string only in the change that ships its
 * commands/frames, and never rename one: a renamed string silently turns the
 * feature off for every host that gates on the old name.
 */
// oxfmt-ignore
export const RPC_CAPABILITIES: readonly string[] = [
	"tool_approval_request",
];
