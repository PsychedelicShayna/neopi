import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { MixtureConfigScope, MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import { isMixtureModel } from "./provider";
import { mixturesConfigFilePath, parseMixturesDoc } from "./config";
import {
	discoverRegistrableMixtures,
	type MixtureDocValidation,
	type MixtureRegistrationContext,
	readMixtureDefinitionFile,
	saveMixtureDefinition,
	validateMixturesConfigDoc,
} from "./registration";
import { serializeMixturesConfig } from "./toml";
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

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

function scopeOf(value: unknown): MixtureConfigScope | undefined {
	return value === "project" || value === "user" ? value : undefined;
}

function findings({ errors, warnings }: MixtureDocValidation) {
	return { errors, warnings };
}

/** Canonicalize only through the core codec, and never publish a draft it can't read back. */
function canonicalToml(doc: MixturesConfigDoc): string {
	const toml = serializeMixturesConfig(doc);
	if (Buffer.byteLength(toml) > MAX_FILE_BYTES) throw new Error(`MIXTURES.toml exceeds ${MAX_FILE_BYTES} bytes`);
	const parsed = parseMixturesDoc(toml ? Bun.TOML.parse(toml) : {}, "draft MIXTURES.toml");
	if (parsed.warnings?.length) throw new Error(parsed.warnings.join("; "));
	if (!Bun.deepEquals(doc, parsed, true))
		throw new Error("NeoPi cannot write this draft as TOML without changing it.");
	return toml;
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
	const sourcePath = (scope: MixtureConfigScope) => mixturesConfigFilePath(scope, { projectDir, agentDir });
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
			const origin = request.headers.get("origin");
			const site = request.headers.get("sec-fetch-site");
			if (
				request.headers.get("host") !== listener.url.host ||
				(origin !== null && origin !== listener.url.origin) ||
				(site !== null && site !== "same-origin" && site !== "none")
			)
				return json({ error: "Foreign origin refused" }, 403);
			if (!url.pathname.startsWith(prefix)) return json({ error: "Not found" }, 404);
			if (!current()) return json({ error: "The invoking session changed. Run /moa web again." }, 410);
			const route = url.pathname.slice(prefix.length);
			try {
				if (request.method === "GET") {
					if (route === "" || route === "editor.js") {
						// The text attribute overrides Bun's default .html bundle loader.
						return new Response(route === "" ? (editorHtml as unknown as string) : editorJs, {
							headers: {
								...HEADERS,
								"Content-Type": route === "" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
							},
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
						if (!scope) return json({ error: "Select project or user scope" }, 400);
						const path = sourcePath(scope);
						const snapshot = await readMixtureDefinitionFile(path);
						const models = registry
							.getAvailable()
							.filter(model => !isMixtureModel(model))
							.map(model => `${model.provider}/${model.id}`);
						return json({
							...snapshot,
							cwd,
							scope,
							sourcePath: path,
							models,
							validation: findings(validateMixturesConfigDoc(snapshot.doc, context)),
						});
					}
				}
				const draft = request.method === "POST" && route === "mixtures/draft";
				if (!draft && !(request.method === "PUT" && route === "mixtures")) return json({ error: "Not found" }, 404);
				if (origin !== listener.url.origin) return json({ error: "Same-origin request required" }, 403);
				if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
					return json({ error: "JSON body required" }, 415);
				const body: unknown = await request.json().catch(() => null);
				const scope = isRecord(body) ? scopeOf(body.scope) : undefined;
				if (!isRecord(body) || !scope || !isRecord(body.doc) || !Array.isArray(body.doc.mixtures))
					return json({ error: "A project or user scope and a mixture document are required" }, 400);
				const doc = body.doc as unknown as MixturesConfigDoc;
				if (draft) {
					const validation = findings(validateMixturesConfigDoc(doc, context));
					const first = validation.errors[0];
					if (first) return json({ error: `${first.path}: ${first.message}`, validation }, 422);
					return json({ validation, toml: canonicalToml(doc) });
				}
				const { baseHash } = body;
				if (baseHash !== null && (typeof baseHash !== "string" || !/^[a-f0-9]{64}$/.test(baseHash)))
					return json({ error: "The source hash from the last load is required" }, 400);
				const save = saved.then(async () => {
					if (!current()) return json({ error: "The invoking session changed. Run /moa web again." }, 410);
					canonicalToml(doc);
					const result = await saveMixtureDefinition({
						...context,
						sourcePath: sourcePath(scope),
						doc,
						baseHash,
						apply: true,
					});
					const message = result.registered
						? `Saved ${scope} MIXTURES.toml and refreshed the mixture roster.`
						: `Saved ${scope} MIXTURES.toml; higher-priority definitions still take precedence.`;
					if (current()) {
						try {
							onSaved?.(message);
						} catch (error) {
							logger.warn("Could not display mixture editor save status", { error: toError(error).message });
						}
					}
					return json({
						hash: result.hash,
						registered: result.registered,
						validation: findings(result.validation),
					});
				});
				saved = save.catch(() => {});
				return await save;
			} catch (error) {
				const message = toError(error).message;
				return json(
					{ error: message },
					message.endsWith(" changed since it was loaded; reload before saving") ? 409 : 422,
				);
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
