import baseEn from "./i18n-catalogs/base.en.toml" with { type: "text" };
import baseEs from "./i18n-catalogs/base.es.toml" with { type: "text" };
import settingsEn from "./i18n-catalogs/settings.en.toml" with { type: "text" };
import settingsEs from "./i18n-catalogs/settings.es.toml" with { type: "text" };
import statusEn from "./i18n-catalogs/status.en.toml" with { type: "text" };
import statusEs from "./i18n-catalogs/status.es.toml" with { type: "text" };
import tuiEn from "./i18n-catalogs/tui.en.toml" with { type: "text" };
import tuiEs from "./i18n-catalogs/tui.es.toml" with { type: "text" };
import cliEn from "./i18n-catalogs/cli.en.toml" with { type: "text" };
import cliEs from "./i18n-catalogs/cli.es.toml" with { type: "text" };
import cliCommandsEn from "./i18n-catalogs/cli-commands.en.toml" with { type: "text" };
import cliCommandsEs from "./i18n-catalogs/cli-commands.es.toml" with { type: "text" };
import commandsEn from "./i18n-catalogs/commands.en.toml" with { type: "text" };
import commandsEs from "./i18n-catalogs/commands.es.toml" with { type: "text" };
import overlaysModelEn from "./i18n-catalogs/overlays-model.en.toml" with { type: "text" };
import overlaysModelEs from "./i18n-catalogs/overlays-model.es.toml" with { type: "text" };
import overlaysEn from "./i18n-catalogs/overlays.en.toml" with { type: "text" };
import overlaysEs from "./i18n-catalogs/overlays.es.toml" with { type: "text" };
import toolsEn from "./i18n-catalogs/tools.en.toml" with { type: "text" };
import toolsEs from "./i18n-catalogs/tools.es.toml" with { type: "text" };

export type TranslationValues = Readonly<Record<string, string | number>>;
export type Catalog = Readonly<Record<string, string>>;

function flattenCatalog(value: unknown, prefix = "", catalog: Record<string, string> = {}): Catalog {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid localization catalog: expected TOML tables");
	}
	for (const [key, entry] of Object.entries(value)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (typeof entry === "string") catalog[fullKey] = entry;
		else flattenCatalog(entry, fullKey, catalog);
	}
	return catalog;
}

function loadCatalog(sources: readonly string[]): Catalog {
	const catalog: Record<string, string> = {};
	for (const source of sources) Object.assign(catalog, flattenCatalog(Bun.TOML.parse(source)));
	return catalog;
}

const english = loadCatalog([
	baseEn,
	settingsEn,
	statusEn,
	tuiEn,
	cliEn,
	cliCommandsEn,
	commandsEn,
	overlaysModelEn,
	overlaysEn,
	toolsEn,
]);
const spanish = Object.fromEntries(
	Object.entries(
		loadCatalog([
			baseEs,
			settingsEs,
			statusEs,
			tuiEs,
			cliEs,
			cliCommandsEs,
			commandsEs,
			overlaysModelEs,
			overlaysEs,
			toolsEs,
		]),
	).filter(([, value]) => value !== ""),
);
const localeRegistry = {
	en: { name: "English", alternateName: "Inglés", catalog: english, overrides: english },
	es: { name: "Español", alternateName: "Spanish", catalog: { ...english, ...spanish }, overrides: spanish },
};

export type Locale = keyof typeof localeRegistry;
export const LOCALES = Object.keys(localeRegistry) as readonly Locale[];

export function getLocaleNames(locale: Locale): { readonly name: string; readonly alternateName: string } {
	return localeRegistry[locale];
}

function isLocale(value: string): value is Locale {
	return Object.hasOwn(localeRegistry, value);
}

let activeLocale: Locale = "en";

/** Select the active UI language; unsupported runtime values fail closed to English. */
export function setLocale(locale: Locale): void {
	activeLocale = isLocale(locale) ? locale : "en";
}

export function getLocale(): Locale {
	return activeLocale;
}

/** Return the selected catalog, with English entries available for incomplete translations. */
export function getCatalog(locale: Locale = activeLocale): Catalog {
	return localeRegistry[locale].catalog;
}

/** Return only messages authored for a locale, without English fallback. */
export function getCatalogOverrides(locale: Locale = activeLocale): Catalog {
	return localeRegistry[locale].overrides;
}

export function t(key: string, values?: TranslationValues): string;
export function t(locale: Locale, key: string, values?: TranslationValues): string;
export function t(
	localeOrKey: Locale | string,
	keyOrValues?: string | TranslationValues,
	values?: TranslationValues,
): string {
	const explicitLocale = typeof keyOrValues === "string" && isLocale(localeOrKey);
	const locale = explicitLocale ? localeOrKey : activeLocale;
	const key = explicitLocale ? (keyOrValues as string) : localeOrKey;
	const substitutions = explicitLocale ? values : (keyOrValues as TranslationValues | undefined);
	const message = getCatalog(locale)[key] ?? key;
	if (!substitutions) return message;
	return message.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(substitutions, name) ? String(substitutions[name]) : placeholder,
	);
}
