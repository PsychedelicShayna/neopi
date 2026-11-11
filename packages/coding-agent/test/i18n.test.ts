import { afterEach, describe, expect, test } from "bun:test";
import { getCatalog, getLocale, setLocale, t } from "@oh-my-pi/pi-utils/i18n";
import { getSettingDef, type SettingsDisplayEntry } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { cfgLanguage } from "../src/modes/settings";

afterEach(() => setLocale("en"));

describe("localization catalogs", () => {
	test("defaults to English and resolves bundled catalogs", () => {
		expect(getLocale()).toBe("en");
		expect(cfgLanguage.default).toBe("en");
		expect(cfgLanguage.enumValues).toEqual(["en", "es"]);
		expect(t("composer.placeholder")).toBe("Write a message…");
		expect(t("es", "composer.placeholder")).toBe("Escribe un mensaje…");
	});

	test("falls back to English and preserves unknown keys", () => {
		expect(getCatalog("es")["composer.placeholder"]).toBe("Escribe un mensaje…");
		expect(t("es", "settings.language.description")).toBe("Language used for translated interface text");
		expect(t("es", "composer.missing")).toBe("composer.missing");
	});

	test("interpolates provided values and leaves missing placeholders intact", () => {
		expect(t("unknown {name} {missing}", { name: "Ada" })).toBe("unknown Ada {missing}");
	});

	test("changes the active catalog for interface consumers", () => {
		setLocale("es");
		expect(getLocale()).toBe("es");
		expect(t("composer.placeholder")).toBe("Escribe un mensaje…");
	});

	test("updates cached setting labels when the language changes without changing the setting path", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "language",
				type: "enum",
				defaultValue: "en",
				ui: { tab: "interaction", label: "Language", description: "Language used for translated interface text" },
			},
		];
		expect(getSettingDef(entries, "language")?.label).toBe("Language");
		setLocale("es");
		expect(getSettingDef(entries, "language")?.label).toBe("Idioma");
		setLocale("en");
		expect(getSettingDef(entries, "language")?.label).toBe("Language");
	});

	test("preserves the host's current English copy when a setting has no Spanish translation", () => {
		const entries: SettingsDisplayEntry[] = [
			{
				path: "git.enabled",
				type: "boolean",
				defaultValue: true,
				ui: { tab: "interaction", label: "Git integration", description: "Current host description" },
			},
		];
		setLocale("es");
		expect(getSettingDef(entries, "git.enabled")).toMatchObject({
			label: "Git integration",
			description: "Current host description",
		});
	});
});
