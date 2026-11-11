import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { isHostedDashboard, statsFetch } from "./host-transport";

type Locale = "en" | "es";

const spanish: Record<string, string> = {
	"nav.usage": "Uso",
	"nav.activity": "Actividad",
	"nav.insights": "Análisis",
	"nav.overview": "Resumen",
	"nav.costs": "Costos",
	"nav.requests": "Solicitudes",
	"nav.errors": "Errores",
	"nav.projects": "Proyectos",
	"shell.open_navigation": "Abrir navegación",
	"shell.time_range": "Período",
	"shell.pages": "Páginas",
	"shell.range": "período",
	"shell.jump": "y luego una letra para ir a la página",
	"theme.system": "Tema del sistema",
	"theme.light": "Tema claro",
	"theme.dark": "Tema oscuro",
	"theme.switch": "haz clic para cambiar",
};

const LocaleContext = createContext<Locale>("en");

/** A launch URL can select a locale independently of a reused dashboard server. */
export function LocaleProvider({ children }: { children: ReactNode }) {
	const explicit = isHostedDashboard() ? null : new URLSearchParams(window.location.search).get("lang");
	const [locale, setLocale] = useState<Locale>(explicit === "es" ? "es" : "en");
	useEffect(() => {
		if (explicit === "en" || explicit === "es") return;
		const controller = new AbortController();
		statsFetch("/api/locale", { signal: controller.signal })
			.then(response => (response.ok ? response.json() : null))
			.then((value: unknown) => {
				if (
					!controller.signal.aborted &&
					typeof value === "object" &&
					value !== null &&
					"locale" in value &&
					value.locale === "es"
				)
					setLocale("es");
			})
			.catch(() => {});
		return () => controller.abort();
	}, [explicit]);
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);
	return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** English stays the source and fallback for untranslated or review-pending copy. */
export function useTranslation(): (key: string, english: string) => string {
	const locale = useContext(LocaleContext);
	return (key, english) => (locale === "es" ? (spanish[key] ?? english) : english);
}
