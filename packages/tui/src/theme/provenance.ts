import { activeThemeSymbol } from "./active-symbols";
import uiData from "./ui-entry-provenance.json" with { type: "json" };
import { theme } from "./theme";

export type EntryProvenance = "fork" | "newUpstream";

/** Display-only suffix; keep the registry identifier and completion value untouched. */
export function provenanceSuffix(provenance: EntryProvenance | undefined): string {
	if (!provenance) return "";
	return ` ${theme.fg(provenance === "fork" ? "accent" : "success", theme.symbol(`provenance.${provenance}`))}`;
}

export type UiRegistryKind = keyof typeof uiData.fork;
const uiFork = {
	keybindings: new Set(uiData.fork.keybindings),
	statusSegments: new Set(uiData.fork.statusSegments),
	roles: new Set(uiData.fork.roles),
	composerShapes: new Set(uiData.fork.composerShapes),
};
const uiUpstream = {
	keybindings: new Set(uiData.newUpstream.keybindings),
	statusSegments: new Set(uiData.newUpstream.statusSegments),
	roles: new Set(uiData.newUpstream.roles),
	composerShapes: new Set(uiData.newUpstream.composerShapes),
};

/** Plain suffix for Markdown, native spans, and labels styled by their owning renderer. */
export function uiProvenanceSuffix(kind: UiRegistryKind, id: string): string {
	const provenance = uiFork[kind].has(id) ? "fork" : uiUpstream[kind].has(id) ? "newUpstream" : undefined;
	return provenance ? ` ${activeThemeSymbol(`provenance.${provenance}`)}` : "";
}
