import { beforeAll, expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete";
import { createProvenanceLookup, provenanceSuffix, type EntryProvenance } from "../src/theme/provenance";
import { initTheme, theme } from "../src/theme/theme";
import { SettingsSelectorComponent } from "../src/overlays/settings-selector";

beforeAll(async () => {
	await initTheme();
});

test("provenance leaves command names, aliases and type icons usable", () => {
	const commands = [{ name: "persona", aliases: ["identity"], icon: "P", provenance: "stable" as const }];
	const provider = new CombinedAutocompleteProvider(commands, process.cwd());
	const item = provider.trySyncSlashCompletion("/persona")!.items[0]!;
	expect(item.label).toBe(`persona${provenanceSuffix("stable")}`);
	expect(item.value).toBe("persona");
	expect(item.icon).toBe("P");
	const alias = provider.trySyncSlashCompletion("/identity")!.items[0]!;
	expect(alias.label).toBe(`identity${provenanceSuffix("stable")}`);
	expect(alias.value).toBe("identity");
	const completion = provider.applyCompletion(["/identity"], 0, 9, alias, "/identity");
	expect(completion.lines).toEqual(["/identity "]);
});

test("synced ranges age gold through silver and retain every older cohort as bronze", () => {
	const first = { entries: { commands: ["old"] } };
	const second = { entries: { commands: ["new"] } };
	const third = { entries: { commands: ["newest"] } };
	const fourth = { entries: { commands: ["future"] } };
	const fork = { stable: { commands: ["released"] }, nightly: { commands: ["nightly"] } };
	const initial = createProvenanceLookup({ fork, upstream: [first] });
	expect(initial("commands", "old")).toBe("gold");
	const next = createProvenanceLookup({ fork, upstream: [second, first] });
	expect(next("commands", "old")).toBe("silver");
	expect(next("commands", "new")).toBe("gold");
	const later = createProvenanceLookup({ fork, upstream: [third, second, first] });
	expect(later("commands", "old")).toBe("bronze");
	expect(later("commands", "new")).toBe("silver");
	expect(later("commands", "released")).toBe("stable");
	expect(later("commands", "nightly")).toBe("nightly");
	expect(later("commands", "unknown")).toBeUndefined();
	const oldest = createProvenanceLookup({ fork, upstream: [fourth, third, second, first] });
	expect(oldest("commands", "future")).toBe("gold");
	expect(oldest("commands", "newest")).toBe("silver");
	expect(oldest("commands", "new")).toBe("bronze");
	expect(oldest("commands", "old")).toBe("bronze");
});

test("upstream adoption supersedes historical fork origin and newest range wins overlaps", () => {
	const lookup = createProvenanceLookup({
		fork: { stable: { commands: ["adopted"] }, nightly: { commands: [] } },
		upstream: [{ entries: { commands: ["adopted"] } }, { entries: { commands: ["adopted"] } }],
	});
	expect(lookup("commands", "adopted")).toBe("gold");
});

test("Settings selection styling preserves each marker's independent tier color", () => {
	const tiers: EntryProvenance[] = ["nightly", "stable", "gold", "silver", "bronze"];
	const colors = {
		nightly: "provenancePurple",
		stable: "success",
		gold: "provenanceGold",
		silver: "provenanceSilver",
		bronze: "provenanceBronze",
	} as const;
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: [],
			providers: [],
			plugins: {
				manager: {
					list: async () => [],
					getPlugin: async () => undefined,
					getPluginSettings: async () => ({}),
					setEnabled: async () => {},
					getEnabledFeatures: async () => null,
					setEnabledFeatures: async () => {},
					setPluginSetting: async () => {},
				},
				createMarketplaceManager: async () => ({
					listInstalledPlugins: async () => [],
					setPluginEnabled: async () => {},
				}),
				parsePluginId: id => ({ name: id }),
			},
			settings: {
				entries: tiers.map(tier => ({
					path: tier,
					type: "boolean",
					defaultValue: false,
					ui: { tab: "appearance", label: tier, description: "", provenance: tier },
				})),
				get: () => false,
				set: () => {},
				unset: () => {},
				normalizeProviderLimits: () => ({}),
				validateProviderLimits: () => ({}),
			},
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	const rows = selector.render(160);
	for (const tier of tiers) {
		const row = rows.find(line => Bun.stripANSI(line).includes(tier))!;
		const glyph = theme.symbol(tier === "nightly" || tier === "stable" ? "provenance.moon" : "provenance.star");
		expect(row).toContain(theme.fg(colors[tier], glyph));
	}
});
