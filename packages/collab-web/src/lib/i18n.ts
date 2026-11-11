import { useSyncExternalStore } from "react";

export type Language = "en" | "es";
const STORAGE_KEY = "omp.collab.language";

const spanish: Record<string, string> = {
	"language.label": "Idioma",
	"connect.link": "Enlace para unirse",
	"connect.name": "Nombre visible",
	"connect.action": "Conectar",
	"connect.missing_link": "Primero pega un enlace para unirte.",
	"composer.response": "escribe tu respuesta…",
	"composer.submit_response": "enviar respuesta",
	"composer.submit": "Enviar",
	"composer.cancel": "Cancelar",
	"composer.stop_turn": "detener el turno actual",
	"composer.stop": "Detener",
	"composer.queued": "en cola",
	"composer.send_enter": "enviar (Enter)",
	"composer.send": "Enviar",
	"connection.connecting": "Conectando",
	"connection.waiting": "Uniéndose",
	"connection.live": "En vivo",
	"connection.reconnecting": "Reconectando",
	"connection.ended": "Finalizada",
	"connection.label": "conexión: {phase}",
	"connection.connecting_relay": "Conectando al relay…",
	"connection.reconnecting_progress": "Reconectando…{progress}",
	"connection.rejoin": "Volver a unirse",
	"connection.new_link": "Usar otro enlace",
	"theme.system": "Tema del sistema",
	"theme.light": "Tema claro",
	"theme.dark": "Tema oscuro",
	"theme.switch": "haz clic para cambiar",
};

function storedLanguage(): Language {
	try {
		return globalThis.localStorage.getItem(STORAGE_KEY) === "es" ? "es" : "en";
	} catch {
		return "en";
	}
}

let language = storedLanguage();
const listeners = new Set<() => void>();

function applyLanguage(): void {
	if (typeof document !== "undefined") document.documentElement.lang = language;
}
applyLanguage();

export function setLanguage(next: Language): void {
	language = next;
	try {
		globalThis.localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// The in-memory choice still works when storage is unavailable.
	}
	applyLanguage();
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useLanguage(): Language {
	return useSyncExternalStore(
		subscribe,
		() => language,
		() => "en",
	);
}

export function useTranslation(): (key: string, english: string) => string {
	const current = useLanguage();
	return (key, english) => (current === "es" ? (spanish[key] ?? english) : english);
}
