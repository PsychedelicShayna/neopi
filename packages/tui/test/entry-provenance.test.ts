import { beforeAll, expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete";
import { initTheme, theme } from "../src/theme/theme";
import { provenanceSuffix } from "../src/theme/provenance";
import { SettingsSelectorComponent } from "../src/overlays/settings-selector";

beforeAll(async () => {
	await initTheme();
});

test("command provenance is displayed without changing completion values or original icons", () => {
	const commands = [{ name: "persona", aliases: ["personality"], icon: "P", provenance: "fork" as const }];
	const provider = new CombinedAutocompleteProvider(commands, process.cwd());
	const item = provider.trySyncSlashCompletion("/persona")!.items[0]!;
	expect(item.label).toBe(`persona${provenanceSuffix("fork")}`);
	expect(item.value).toBe("persona");
	expect(item.icon).toBe("P");
	const alias = provider.trySyncSlashCompletion("/personality")!.items[0]!;
	expect(alias.label).toBe(`personality${provenanceSuffix("fork")}`);
	expect(alias.value).toBe("personality");
});

test("settings rows render both provenance kinds through the normal selector", () => {
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: [],
			providers: [],
			settings: {
				entries: [
					{
						path: "fork",
						type: "boolean",
						defaultValue: false,
						ui: { tab: "appearance", label: "Fork setting", description: "", provenance: "fork" },
					},
					{
						path: "upstream",
						type: "boolean",
						defaultValue: false,
						ui: { tab: "appearance", label: "Upstream setting", description: "", provenance: "newUpstream" },
					},
				],
				get: () => false,
				set: () => {},
				unset: () => {},
				normalizeProviderLimits: () => ({}),
				validateProviderLimits: () => ({}),
			},
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	const rendered = Bun.stripANSI(selector.render(160).join("\n"));
	expect(rendered).toContain(`Fork setting${Bun.stripANSI(provenanceSuffix("fork"))}`);
	expect(rendered).toContain(`Upstream setting${Bun.stripANSI(provenanceSuffix("newUpstream"))}`);
	expect(theme.symbol("provenance.fork")).not.toBe(theme.symbol("provenance.newUpstream"));
});
