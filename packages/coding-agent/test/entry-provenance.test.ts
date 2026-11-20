import { expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { ensureThemeSync, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme/theme";
import { Settings } from "../src/config/settings";
import { createSettingsHost } from "../src/config/settings-ui";
import { createPluginSettingsHost } from "../src/extensibility/plugins/settings-host";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../src/slash-commands/builtin-registry";

test("amethyst Nerd Settings and builtin completions retain upstream stars and distinct NeoPi crescents", () => {
	ensureThemeSync();
	const previousTheme = theme;
	const amethyst = createTheme(getBuiltinThemes().amethyst!, { mode: "truecolor", symbolPresetOverride: "nerd" });
	setThemeInstance(amethyst);
	try {
		// Omitted optional tokens must inherit real, distinct hues, not default foreground.
		const palette = ["provenanceGold", "provenanceSilver", "success", "provenancePurple"] as const;
		for (const [index, color] of palette.entries()) {
			expect(amethyst.getColorHex(color)).toMatch(/^#[\da-f]{6}$/i);
			for (const other of palette.slice(index + 1)) {
				expect(amethyst.getColorHex(color)).not.toBe(amethyst.getColorHex(other));
			}
		}
		const host = createSettingsHost(Settings.isolated());
		for (const [path, color, glyph] of [
			["tui.motion", "provenanceGold", "provenance.star"],
			["computer.backgroundFallback", "provenanceSilver", "provenance.star"],
			["symbolBrandGlyph", "success", "provenance.moon"],
			["settings.defaultScope", "provenancePurple", "provenance.moon"],
		] as const) {
			const entry = host.entries.find(item => item.path === path)!;
			const label = entry.ui!.label;
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: [],
					providers: [],
					settings: host,
					plugins: createPluginSettingsHost(process.cwd()),
				},
				{ onChange: () => {}, onCancel: () => {} },
			);
			selector.handleInput("/");
			for (const character of label) selector.handleInput(character);
			selector.handleInput("\r");
			const rows = selector.render(160).filter(line => Bun.stripANSI(line).includes(label));
			expect(rows.join("\n")).toContain(amethyst.fg(color, amethyst.symbol(glyph)));
		}

		const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMAND_DEFS], process.cwd());
		for (const [name, color, glyph] of [
			["unpin", "provenanceGold", "provenance.star"],
			["local", "provenanceSilver", "provenance.star"],
			["persona", "success", "provenance.moon"],
			["personality", "provenancePurple", "provenance.moon"],
		] as const) {
			const item = provider.trySyncSlashCompletion(`/${name}`)!.items.find(candidate => candidate.value === name)!;
			expect(item.label).toBe(`${name} ${amethyst.fg(color, amethyst.symbol(glyph))}`);
			expect(provider.applyCompletion([`/${name}`], 0, name.length + 1, item, `/${name}`).lines).toEqual([
				`/${name} `,
			]);
		}
	} finally {
		setThemeInstance(previousTheme);
	}
});
