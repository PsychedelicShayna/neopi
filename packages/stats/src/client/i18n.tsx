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
	"common.empty": "Todavía no hay nada aquí",
	"common.retry": "Reintentar",
	"common.filter": "Filtrar",
	"common.filter_placeholder": "Filtrar…",
	"common.cancel": "Cancelar",
	"common.close": "Cerrar",
	"common.copy": "Copiar",
	"common.copied": "Copiado",
	"common.copy_raw_json": "Copiar JSON sin procesar",
	"table.count": "{visible} de {total}",
	"table.more": "Mostrar más",
	"table.fewer": "Mostrar menos",
	"costs.title": "Costos",
	"costs.empty": "No hay uso en este período",
	"costs.empty_hint": "Elige un período más amplio en la barra superior.",
	"costs.daily": "Estimación diaria",
	"costs.description": "Lo que costaría el uso de {window} con las tarifas públicas de la API. El uso por suscripción sin un precio público se contabiliza como uso sin precio, no como gratuito.",
	"costs.window.1h": "la última hora",
	"costs.window.24h": "las últimas 24 horas",
	"costs.window.7d": "los últimos 7 días",
	"costs.window.30d": "los últimos 30 días",
	"costs.window.90d": "los últimos 90 días",
	"costs.window.all": "todo el tiempo",
	"costs.no_priced_usage": "No hay uso con precio en este período",
	"costs.unpriced_requests": "Solicitudes sin precio",
	"costs.estimate": "Estimación equivalente de API",
	"costs.estimate_title": "Lo que costaría este uso con las tarifas públicas de la API",
	"costs.request_one": "{count} solicitud",
	"costs.request_many": "{count} solicitudes",
	"costs.average_daily": "Promedio diario",
	"costs.average_daily_title": "Estimación ÷ días con uso",
	"costs.active_day_one": "durante {count} día con actividad",
	"costs.active_day_many": "durante {count} días con actividad",
	"costs.per_priced": "Por solicitud con precio",
	"costs.per_priced_title": "Estimación ÷ solicitudes que tienen precio público",
	"costs.priced_count": "{count} con precio",
	"costs.unpriced_title": "Uso por suscripción sin precio público equivalente; excluido de la estimación",
	"costs.excluded": "excluido de la estimación",
	"costs.all_priced": "todo el uso tiene precio",
	"shell.jump": "y luego una letra para ir a la página",
	"theme.system": "Tema del sistema",
	"theme.light": "Tema claro",
	"theme.dark": "Tema oscuro",
	"theme.switch": "haz clic para cambiar",
	"range.all": "Todo",
	"live.reconnecting": "Reconectando",
	"live.disconnected": "Se perdió la conexión en vivo con el servidor de stats; reintentando",
	"live.syncing": "Sincronizando",
	"live.sync_failed": "Error de sincronización",
	"live.retry": "{error} — haz clic para reintentar",
	"live.indexing": "Indexando",
	"live.hours_left": "quedan {hours} h",
	"live.live": "En vivo",
	"live.just_now": "ahora mismo",
	"live.minutes_ago": "hace {count} min",
	"live.hours_ago": "hace {count} h",
	"live.days_ago": "hace {count} d",
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
