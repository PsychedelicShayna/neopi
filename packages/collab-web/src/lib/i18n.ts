import { useSyncExternalStore } from "react";

export type Language = "en" | "es";
const STORAGE_KEY = "omp.collab.language";

const spanish: Record<string, string> = {
	"language.label": "Idioma",
	"connect.link": "Enlace para unirse",
	"connect.name": "Nombre visible",
	"connect.action": "Conectar",
	"connect.missing_link": "Primero pega un enlace para unirte.",
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
