// Options page for the OMP Browser Relay extension (plain JS: shipped as-is).
const DEFAULT_PORT = 9224;
const languageInput = document.getElementById("language");
const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");
const copy = {
	en: {
		title: "NeoPi Browser Relay settings",
		language: "Language",
		before: "The extension connects to a local",
		after: "process. Values here must match the flags the relay was started with.",
		port: "Relay port",
		token: "Token (optional)",
		save: "Save",
		invalid: "invalid port",
		saved: "saved",
	},
	es: {
		title: "Configuración de NeoPi Browser Relay",
		language: "Idioma",
		before: "La extensión se conecta a un proceso local de",
		after: "en ejecución. Los valores deben coincidir con las opciones usadas para iniciar el relay.",
		port: "Puerto del relay",
		token: "Token (opcional)",
		save: "Guardar",
		invalid: "puerto no válido",
		saved: "guardado",
	},
};
let language = "en";
let statusKey = "";

function renderLanguage() {
	const text = copy[language];
	document.documentElement.lang = language;
	document.title = text.title;
	document.getElementById("language-label").textContent = text.language;
	document.getElementById("intro-before").textContent = text.before;
	document.getElementById("intro-after").textContent = text.after;
	document.getElementById("port-label").textContent = text.port;
	document.getElementById("token-label").textContent = text.token;
	document.getElementById("save").textContent = text.save;
	status.textContent = statusKey ? text[statusKey] : "";
}

chrome.storage.local.get({ port: DEFAULT_PORT, token: "", language: "en" }).then(stored => {
	portInput.value = String(stored.port);
	tokenInput.value = String(stored.token);
	language = stored.language === "es" ? "es" : "en";
	languageInput.value = language;
	languageInput.disabled = false;
	renderLanguage();
});

languageInput.addEventListener("change", () => {
	language = languageInput.value === "es" ? "es" : "en";
	renderLanguage();
	void chrome.storage.local.set({ language });
});

document.getElementById("save").addEventListener("click", async () => {
	const port = Number(portInput.value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		statusKey = "invalid";
		renderLanguage();
		return;
	}
	await chrome.storage.local.set({ port, token: tokenInput.value });
	statusKey = "saved";
	renderLanguage();
	setTimeout(() => {
		statusKey = "";
		renderLanguage();
	}, 1500);
});
