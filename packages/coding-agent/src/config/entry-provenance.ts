import type { EntryProvenance } from "@oh-my-pi/pi-tui/theme/provenance";
import data from "./entry-provenance.json" with { type: "json" };

const fork = { settings: new Set(data.fork.settings), commands: new Set(data.fork.commands) };
const newUpstream = { settings: new Set(data.newUpstream.settings), commands: new Set(data.newUpstream.commands) };

export function entryProvenance(kind: "settings" | "commands", id: string): EntryProvenance | undefined {
	if (fork[kind].has(id)) return "fork";
	if (newUpstream[kind].has(id)) return "newUpstream";
	return undefined;
}
