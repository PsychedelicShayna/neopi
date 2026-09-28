/**
 * Optional features advertised in the RPC `ready` frame's `capabilities` array.
 *
 * Hosts (T3 Code, OMP Deck) gate optional features on these exact strings, never
 * on NeoPi version numbers. Add a string only in the change that ships its
 * commands/frames, and never rename one: a renamed string silently turns the
 * feature off for every host that gates on the old name.
 *
 * One string per line (formatter-pinned) keeps concurrent additions merge-friendly.
 */
// prettier-ignore
export const RPC_CAPABILITIES: readonly string[] = [
	"set_chat_mode",
];
