import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { cfgLanguage } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
	type TuiSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getLocale, setLocale, t } from "@oh-my-pi/pi-utils/i18n";

function setup(settings: Settings) {
	const previousLocale = getLocale();
	const release = bindEffects(settings);
	const statuses: string[] = [];
	const errors: string[] = [];
	const runtime = {
		draftDetached: true,
		ctx: {
			settings,
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => errors.push(message),
		},
	} as unknown as TuiSlashCommandRuntime;
	const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd());
	return {
		statuses,
		errors,
		provider,
		run: (text: string) => executeBuiltinSlashCommand(text, runtime),
		suggest: (text: string) => provider.getSuggestions([text], 0, text.length),
		dispose() {
			release();
			setLocale(previousLocale);
		},
	};
}

describe("/language and /idioma", () => {
	it("executes either spelling in either language and changes the UI and picker immediately", async () => {
		const harness = setup(Settings.isolated());
		try {
			for (const [visible, hidden, change, changeBack] of [
				["idioma", "language", "/language eSPaNoL", "/idioma INGLÉS"],
				["idioma", "language", "/idioma SpAnIsH", "/language en"],
			]) {
				expect((await harness.suggest("/"))?.items.map(item => item.value)).toContain(visible);
				expect((await harness.suggest("/"))?.items.map(item => item.value)).not.toContain(hidden);
				expect(
					harness.provider
						.trySyncSlashCompletion(`/${hidden}`)
						?.items.every(item => item.value !== hidden && item.preserveInputOnSubmit) ?? true,
				).toBe(true);
				expect(await harness.run(change)).toBe(true);
				expect(t("composer.placeholder")).toBe("Escribe un mensaje…");
				expect((await harness.suggest("/"))?.items.map(item => item.value)).toContain(hidden);
				expect((await harness.suggest("/"))?.items.map(item => item.value)).not.toContain(visible);
				expect(
					harness.provider
						.trySyncSlashCompletion(`/${visible}`)
						?.items.every(item => item.value !== visible && item.preserveInputOnSubmit) ?? true,
				).toBe(true);
				expect(await harness.run(changeBack)).toBe(true);
				expect(t("composer.placeholder")).toBe("Write a message…");
			}
		} finally {
			harness.dispose();
		}
	});

	it("completes language arguments for visible and hidden spellings in both modes", async () => {
		const harness = setup(Settings.isolated());
		try {
			for (const locale of ["en", "es"] as const) {
				setLocale(locale);
				for (const alias of ["language", "idioma"]) {
					const available = await harness.suggest(`/${alias} `);
					expect(available?.items.map(item => [item.value, item.label])).toEqual([
						["en", "English"],
						["es", "Español"],
					]);
					expect((await harness.suggest(`/${alias} INGLE`))?.items.map(item => item.value)).toEqual(["en"]);
					expect((await harness.suggest(`/${alias} espAñ`))?.items.map(item => item.value)).toEqual(["es"]);
				}
			}
		} finally {
			harness.dispose();
		}
	});

	it("uses the same persisted language setting as Settings", async () => {
		using temp = TempDir.createSync("@npi-language-");
		const options = { cwd: temp.path(), agentDir: temp.join("agent") };
		const harness = setup(await Settings.loadIsolated(options));
		try {
			await harness.run("/idioma es");
			expect(getLocale()).toBe("es");
			expect(cfgLanguage.get(await Settings.loadReadOnly(options))).toBe("es");
			await harness.run("/language English");
			expect(getLocale()).toBe("en");
			expect(cfgLanguage.get(await Settings.loadReadOnly(options))).toBe("en");
		} finally {
			harness.dispose();
		}
	});

	it("persists a session override instead of rewriting a project's language", async () => {
		using temp = TempDir.createSync("@npi-language-");
		const options = { cwd: temp.path(), agentDir: temp.join("agent") };
		const settings = await Settings.loadIsolated(options);
		settings.writeScopeValue(cfgLanguage, "es", "project");
		await settings.flush();
		const sessionFile = temp.join("session.jsonl");
		await settings.attachSessionFile(sessionFile);
		const harness = setup(settings);
		try {
			expect(getLocale()).toBe("es");
			await harness.run("/language en");
			expect(getLocale()).toBe("en");
			const reloaded = await Settings.loadIsolated(options);
			expect(cfgLanguage.get(reloaded)).toBe("es");
			await reloaded.attachSessionFile(sessionFile);
			expect(cfgLanguage.get(reloaded)).toBe("en");
		} finally {
			harness.dispose();
		}
	});
	it("reports the current language or an unknown language with the valid choices without writing", async () => {
		const settings = Settings.isolated();
		const harness = setup(settings);
		try {
			expect(await harness.run("/language")).toBe(true);
			expect(harness.statuses).toEqual([
				"Current language: English. Choices: English / Inglés (en), Español / Spanish (es).",
			]);
			expect(await harness.run("/idioma Klingon")).toBe(true);
			expect(harness.errors).toEqual([
				"Unknown language: Klingon. Choose from: English / Inglés (en), Español / Spanish (es).",
			]);
			expect(cfgLanguage.provenance(settings)).toBe("default");
			expect(getLocale()).toBe("en");
		} finally {
			harness.dispose();
		}
	});
});
