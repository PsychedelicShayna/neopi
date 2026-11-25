import { getLocale, getLocaleNames, LOCALES, t } from "@oh-my-pi/pi-utils/i18n";
import { cfgLanguage } from "../modes/settings";
import { clearSubmittedText } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

function normalizeLanguageName(value: string): string {
	return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

const languages = LOCALES.map(code => {
	const { name, alternateName } = getLocaleNames(code);
	return {
		code,
		name,
		spellings: [code, normalizeLanguageName(name), normalizeLanguageName(alternateName)],
		description: `${name} / ${alternateName} (${code})`,
	};
});
const choices = languages.map(language => language.description).join(", ");

export const LANGUAGE_SLASH_COMMAND: SlashCommandSpec = {
	name: "language",
	hiddenAliases: ["idioma"],
	getAutocompleteName: () => (getLocale() === "en" ? "idioma" : "language"),
	get description() {
		return t("commands.language.description");
	},
	icon: "settings",
	allowArgs: true,
	getTuiArgumentCompletions(prefix) {
		const query = normalizeLanguageName(prefix.trim());
		return languages
			.filter(language => language.spellings.some(spelling => spelling.startsWith(query)))
			.map(({ code, name, description }) => ({ value: code, label: name, description }));
	},
	async handleTui({ args }, runtime) {
		clearSubmittedText(runtime);
		const { ctx } = runtime;
		if (!args) {
			ctx.showStatus(t("slash.language.current", { language: getLocaleNames(getLocale()).name, choices }));
			return;
		}
		const query = normalizeLanguageName(args);
		const language = languages.find(candidate => candidate.spellings.includes(query));
		if (!language) {
			ctx.showError(t("slash.language.unknown", { input: args, choices }));
			return;
		}

		const origin = cfgLanguage.provenance(ctx.settings);
		// Keep project configuration untouched while still overriding its language for this UI.
		if (origin === "project" || origin === "overlay" || origin === "session") {
			ctx.settings.writeScopeValue(cfgLanguage, language.code, "session");
			await ctx.settings.saveSessionSettings();
		} else {
			ctx.settings.writeScopeValue(cfgLanguage, language.code, "global");
			await ctx.settings.flush();
		}
		ctx.showStatus(t("slash.language.changed", { language: language.name }));
	},
};
