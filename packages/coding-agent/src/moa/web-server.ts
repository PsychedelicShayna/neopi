import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { MixtureConfigScope, MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { getCatalog, getLocale, LOCALES, type Locale, t, type TranslationValues } from "@oh-my-pi/pi-utils/i18n";
import {
	draftMixtureSource,
	loadMixtureSource,
	MixtureAuthoringError,
	type MixtureDefinitionReport,
	saveMixtureSource,
} from "./authoring";
import { ABSENT, mixtureSources } from "./authoring-files";
import { mixturesConfigFilePath } from "./config";
import { isMixtureModel, MixtureCatalog } from "./provider";
import { discoverRegistrableMixtures, type MixtureRegistrationContext } from "./registration";
import { MAX_FILE_BYTES } from "./validate";
import editorHtml from "./web-editor.html" with { type: "text" };
// @ts-expect-error Bun imports this browser script as source text, not as a JS module.
import editorJs from "./web-editor.js" with { type: "text" };

interface MixtureWebEditorOptions extends MixtureRegistrationContext {
	agentDir: string;
	initialScope?: MixtureConfigScope;
	isCurrent?: () => boolean;
	onSaved?: (message: string) => void;
}

export interface MixtureWebEditor {
	url: string;
	stop(): void;
}

const HOST = "127.0.0.1";
// JSON can spell a single TOML character as a six-byte Unicode escape.
const MAX_REQUEST_BYTES = 6 * MAX_FILE_BYTES + 64 * 1024;
const HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

const EDITOR_MESSAGES = "overlaysModel.moaWeb.editor.";
const SERVER_MESSAGES = "overlaysModel.moaWeb.server.";

function editorPage(locale: Locale): string {
	const messages = Object.fromEntries(
		Object.entries(getCatalog(locale))
			.filter(([key]) => key.startsWith(EDITOR_MESSAGES))
			.map(([key, value]) => [key.slice(EDITOR_MESSAGES.length), value]),
	);
	// The catalog already falls back to English per key. The JSON data block is inert under the CSP.
	return (editorHtml as unknown as string).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		if (key === "locale") return locale;
		if (key === "editorMessages") return JSON.stringify(messages).replaceAll("<", "\\u003c");
		return Bun.escapeHTML(t(locale, `${EDITOR_MESSAGES}${key}`));
	});
}

function serverText(locale: Locale, key: string, values?: TranslationValues): string {
	return t(locale, `${SERVER_MESSAGES}${key}`, values);
}

// Keep the existing protocol error and add presentation copy only for localized browser requests.
function displayError(locale: Locale | undefined, key: string, values?: TranslationValues): { displayError?: string } {
	return locale && locale !== "en" ? { displayError: serverText(locale, key, values) } : {};
}

function webError(
	locale: Locale | undefined,
	status: number,
	key: string,
	values?: TranslationValues,
	details?: object,
): Response {
	return json({ error: serverText("en", key, values), ...details, ...displayError(locale, key, values) }, status);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

function scopeOf(value: unknown): MixtureConfigScope | undefined {
	return value === "project" || value === "user" ? value : undefined;
}

function findings(reports: MixtureDefinitionReport[]) {
	return {
		errors: reports.flatMap(({ index, errors }) =>
			errors.map(issue => ({ ...issue, path: `mixtures[${index}].${issue.path}` })),
		),
		warnings: reports.flatMap(({ index, warnings }) =>
			warnings.map(issue => ({ ...issue, path: `mixtures[${index}].${issue.path}` })),
		),
	};
}

/** A capability URL bound to exactly one invoking workspace. Request bodies never choose the cwd or a path. */
export function startMixtureWebEditor(options: MixtureWebEditorOptions): MixtureWebEditor {
	const { cwd, agentDir, registry, settings, initialScope = "project", isCurrent, onSaved } = options;
	const context = { cwd, agentDir, registry, settings };
	let projectDir = cwd;
	try {
		projectDir = vcs.repo(cwd)?.root() ?? cwd;
	} catch {
		// As with the fullscreen configurator, standalone workspaces save at cwd.
	}
	const dirs = { projectDir, agentDir };
	async function sourceFor(scope: MixtureConfigScope) {
		const path = mixturesConfigFilePath(scope, dirs);
		const source = (await mixtureSources(cwd, dirs)).find(candidate => candidate.path === path);
		return { path, source };
	}
	const prefix = `/${crypto.randomUUID()}/`;
	let stopped = false;
	const current = () => !stopped && (isCurrent?.() ?? true);
	// Serialize saves in this launch, including their roster refreshes, across both scopes.
	let saved: Promise<unknown> = Promise.resolve();

	const server = Bun.serve({
		hostname: HOST,
		port: 0,
		development: false,
		maxRequestBodySize: MAX_REQUEST_BYTES,
		async fetch(request, listener) {
			const url = new URL(request.url);
			const lang = url.searchParams.get("lang");
			const locale = LOCALES.find(candidate => candidate === lang);
			const origin = request.headers.get("origin");
			const site = request.headers.get("sec-fetch-site");
			if (
				request.headers.get("host") !== listener.url.host ||
				(origin !== null && origin !== listener.url.origin) ||
				(site !== null && site !== "same-origin" && site !== "none")
			)
				return webError(locale, 403, "foreignOrigin");
			if (!url.pathname.startsWith(prefix)) return webError(locale, 404, "notFound");
			if (!current()) return webError(locale, 410, "sessionChanged");
			const route = url.pathname.slice(prefix.length);
			let savePath: string | undefined;
			try {
				if (request.method === "GET") {
					if (route === "") {
						const pageLocale = lang === null ? getLocale() : (locale ?? "en");
						return new Response(editorPage(pageLocale), {
							headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" },
						});
					}
					if (route === "editor.js") {
						return new Response(editorJs, {
							headers: { ...HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
						});
					}
					if (route === "mixtures/discovered") {
						const roster = await discoverRegistrableMixtures(context);
						return json({
							cwd,
							mixtures: roster.map(item => ({ name: item.definition.name, revision: item.revision })),
						});
					}
					if (route === "mixtures") {
						const scope = scopeOf(url.searchParams.get("scope") ?? initialScope);
						if (!scope) return webError(locale, 400, "invalidScope");
						const { path, source } = await sourceFor(scope);
						if (!source) return webError(locale, 422, "sourceNotEditable", { path });
						const { doc, hash, toml, validation, parseDiagnostics, readOnly } = await loadMixtureSource(
							source,
							context,
						);
						const models = registry
							.getAvailable()
							.filter(model => !isMixtureModel(model))
							.map(model => `${model.provider}/${model.id}`);
						return json({
							doc,
							hash: hash === ABSENT ? null : hash,
							toml,
							parseDiagnostics,
							readOnly,
							cwd,
							scope,
							sourcePath: source.path,
							models,
							validation: findings(validation),
						});
					}
				}
				const draft = request.method === "POST" && route === "mixtures/draft";
				if (!draft && !(request.method === "PUT" && route === "mixtures")) return webError(locale, 404, "notFound");
				if (origin !== listener.url.origin) return webError(locale, 403, "sameOriginRequired");
				if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
					return webError(locale, 415, "jsonRequired");
				const body: unknown = await request.json().catch(() => null);
				const scope = isRecord(body) ? scopeOf(body.scope) : undefined;
				if (!isRecord(body) || !scope || !isRecord(body.doc) || !Array.isArray(body.doc.mixtures))
					return webError(locale, 400, "documentRequired");
				const doc = body.doc as unknown as MixturesConfigDoc;
				if (draft) {
					const result = draftMixtureSource({ kind: "document", doc }, context);
					const validation = findings(result.validation);
					const first = validation.errors[0];
					if (first)
						return webError(
							locale,
							422,
							"invalidDraft",
							{ path: first.path, message: first.message },
							{
								validation,
								parseDiagnostics: result.parseDiagnostics,
							},
						);
					if (result.parseDiagnostics.length)
						return webError(locale, 422, "unrepresentableDraft", undefined, {
							parseDiagnostics: result.parseDiagnostics,
							validation,
						});
					return json({ ...result, validation });
				}
				const { baseHash, confirmCanonicalRewrite } = body;
				if (baseHash !== null && (typeof baseHash !== "string" || !/^[a-f0-9]{64}$/.test(baseHash)))
					return webError(locale, 400, "sourceHashRequired");
				if (confirmCanonicalRewrite !== undefined && typeof confirmCanonicalRewrite !== "boolean")
					return webError(locale, 400, "confirmationBoolean");
				const save = saved.then(async () => {
					if (!current()) return webError(locale, 410, "sessionChanged");
					const { path, source } = await sourceFor(scope);
					if (!source) return webError(locale, 422, "sourceNotEditable", { path });
					savePath = source.path;
					const result = await saveMixtureSource(
						source,
						{ doc, baseHash: baseHash ?? ABSENT, confirmCanonicalRewrite },
						context,
					);
					const roster = await discoverRegistrableMixtures(context);
					const workspace = MixtureCatalog.for(registry).scope(cwd, agentDir);
					workspace.setRoster(roster);
					const registered = result.validation.every(
						report => !report.runnable || workspace.find(report.name)?.revision === report.revision,
					);
					const uiLocale = getLocale();
					const message = serverText(uiLocale, registered ? "saved" : "savedShadowed", {
						scope: serverText(uiLocale, scope === "project" ? "projectScope" : "userScope"),
					});
					if (current()) {
						try {
							onSaved?.(message);
						} catch (error) {
							logger.warn("Could not display mixture editor save status", { error: toError(error).message });
						}
					}
					return json({
						hash: result.hash === ABSENT ? null : result.hash,
						registered,
						validation: findings(result.validation),
						toml: result.toml,
						parseDiagnostics: result.parseDiagnostics,
					});
				});
				saved = save.catch(() => {});
				return await save;
			} catch (error) {
				if (error instanceof MixtureAuthoringError) {
					const { validation: reports, ...details } = error.details;
					const validation = reports && findings(reports);
					const issue = validation?.errors[0];
					const message = issue ? `${error.message}: ${issue.path}: ${issue.message}` : error.message;
					let localized: { displayError?: string } = {};
					if (locale && locale !== "en") {
						// Only infer the meaning of shared authoring errors with structured discriminators.
						if (details.code === "rewrite-loses-source" && savePath)
							localized = displayError(locale, "rewriteLosesSource", { path: savePath });
						else if (details.current)
							localized = displayError(locale, "reloadChangedSource", { path: details.current.path });
						else if (details.source)
							localized = displayError(locale, "readbackMismatch", { path: details.source.path });
						else if (details.blocked && reports) {
							const blocked = new Set(details.blocked);
							const names = reports
								.filter(report => blocked.has(report.index))
								.map(report => report.name || serverText(locale, "unnamed"))
								.join(", ");
							localized = displayError(locale, "blockedSave", {
								names,
								detail: issue ? `: ${issue.path}: ${issue.message}` : "",
							});
						}
					}
					return json({ error: message, ...details, validation, ...localized }, error.status);
				}
				return json({ error: toError(error).message }, 422);
			}
		},
	});
	server.unref();
	return {
		url: new URL(prefix, server.url).href,
		stop() {
			if (stopped) return;
			stopped = true;
			void server.stop(true);
		},
	};
}
