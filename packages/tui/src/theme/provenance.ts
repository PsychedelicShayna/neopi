import { activeThemeSymbol } from "./active-symbols";
import uiData from "./ui-entry-provenance.json" with { type: "json" };
import type { ThemeColor } from "./schema";
import { theme } from "./theme";

export type EntryProvenance = "nightly" | "stable" | "gold" | "silver" | "bronze";

const PROVENANCE_COLORS = {
	nightly: "provenancePurple",
	stable: "success",
	gold: "provenanceGold",
	silver: "provenanceSilver",
	bronze: "provenanceBronze",
} satisfies Record<EntryProvenance, ThemeColor>;

/** Semantic color for native spans as well as terminal suffixes. */
export function provenanceColor(provenance: EntryProvenance | undefined): ThemeColor | undefined {
	return provenance ? PROVENANCE_COLORS[provenance] : undefined;
}

export interface ProvenanceEntries<Kind extends string> {
	fork: {
		stable: Record<Kind, readonly string[]>;
		nightly: Record<Kind, readonly string[]>;
	};
	/** Newest synced range first; prepending a range ages all existing tiers. */
	upstream: readonly { entries: Record<Kind, readonly string[]> }[];
}

/** Build once per registry; rendering and completion only perform map lookups. */
export function createProvenanceLookup<Kind extends string>(data: ProvenanceEntries<Kind>) {
	const kinds = Object.keys(data.fork.nightly) as Kind[];
	const lookup = new Map<Kind, Map<string, EntryProvenance>>();
	const tiers = ["gold", "silver", "bronze"] as const;
	for (const kind of kinds) {
		const entries = new Map<string, EntryProvenance>();
		for (const id of data.fork.stable[kind]) entries.set(id, "stable");
		for (const id of data.fork.nightly[kind]) entries.set(id, "nightly");
		// Upstream adoption supersedes a historical fork classification.
		for (let index = data.upstream.length - 1; index >= 0; index--) {
			for (const id of data.upstream[index]!.entries[kind])
				entries.set(id, tiers[Math.min(index, tiers.length - 1)]!);
		}
		lookup.set(kind, entries);
	}
	return (kind: Kind, id: string): EntryProvenance | undefined => lookup.get(kind)?.get(id);
}

/** Display-only suffix; keep the registry identifier and completion value untouched. */
export function provenanceSuffix(provenance: EntryProvenance | undefined): string {
	if (!provenance) return "";
	return ` ${theme.fg(PROVENANCE_COLORS[provenance], theme.symbol(provenance === "nightly" || provenance === "stable" ? "provenance.moon" : "provenance.star"))}`;
}

export type UiRegistryKind = keyof typeof uiData.fork.nightly;
export const uiProvenance = createProvenanceLookup(uiData);

/** Plain transports keep glyphs ANSI-free; terminal renderers request the shared color. */
export function uiProvenanceSuffix(kind: UiRegistryKind, id: string, colored = false): string {
	const provenance = uiProvenance(kind, id);
	if (colored) return provenanceSuffix(provenance);
	return provenance
		? ` ${activeThemeSymbol(provenance === "nightly" || provenance === "stable" ? "provenance.moon" : "provenance.star")}`
		: "";
}
