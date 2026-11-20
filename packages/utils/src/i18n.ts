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

export type Locale = "en" | "es";
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

const english = loadCatalog([baseEn, settingsEn, statusEn, tuiEn, cliEn]);
const spanish = Object.fromEntries(
	Object.entries(loadCatalog([baseEs, settingsEs, statusEs, tuiEs, cliEs])).filter(([, value]) => value !== ""),
);
const effectiveCatalogs: Readonly<Record<Locale, Catalog>> = {
	en: english,
	es: { ...english, ...spanish },
};

let activeLocale: Locale = "en";

/** Select the active UI language; unsupported runtime values fail closed to English. */
export function setLocale(locale: Locale): void {
	activeLocale = locale === "es" ? "es" : "en";
}

export function getLocale(): Locale {
	return activeLocale;
}

/** Return the selected catalog, with English entries available for incomplete translations. */
export function getCatalog(locale: Locale = activeLocale): Catalog {
	return effectiveCatalogs[locale];
}

/** Return only messages authored for a locale, without English fallback. */
export function getCatalogOverrides(locale: Locale = activeLocale): Catalog {
	return locale === "es" ? spanish : english;
}

export function t(key: string, values?: TranslationValues): string;
export function t(locale: Locale, key: string, values?: TranslationValues): string;
export function t(
	localeOrKey: Locale | string,
	keyOrValues?: string | TranslationValues,
	values?: TranslationValues,
): string {
	const explicitLocale = localeOrKey === "en" || localeOrKey === "es";
	const locale = explicitLocale ? localeOrKey : activeLocale;
	const key = explicitLocale ? (keyOrValues as string) : localeOrKey;
	const substitutions = explicitLocale ? values : (keyOrValues as TranslationValues | undefined);
	const message = effectiveCatalogs[locale][key] ?? key;
	if (!substitutions) return message;
	return message.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(substitutions, name) ? String(substitutions[name]) : placeholder,
	);
}
