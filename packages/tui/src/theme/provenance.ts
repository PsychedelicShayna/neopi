import { theme } from "./theme";

export type EntryProvenance = "fork" | "newUpstream";

/** Display-only suffix; keep the registry identifier and completion value untouched. */
export function provenanceSuffix(provenance: EntryProvenance | undefined): string {
	if (!provenance) return "";
	return ` ${theme.fg(provenance === "fork" ? "accent" : "success", theme.symbol(`provenance.${provenance}`))}`;
}
