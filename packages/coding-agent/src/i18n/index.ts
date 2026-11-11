import englishSource from "./catalogs/en.toml" with { type: "text" };
import spanishSource from "./catalogs/es.toml" with { type: "text" };

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

const catalogs: Readonly<Record<Locale, Catalog>> = {
	en: flattenCatalog(Bun.TOML.parse(englishSource)),
	es: flattenCatalog(Bun.TOML.parse(spanishSource)),
};

const effectiveCatalogs: Readonly<Record<Locale, Catalog>> = {
	en: catalogs.en,
	es: { ...catalogs.en, ...catalogs.es },
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
