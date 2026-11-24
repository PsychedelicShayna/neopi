import { getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { MixtureConfigScope, MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import {
	getCatalogOverrides,
	getLocale,
	LOCALES,
	type Locale,
	t,
	type TranslationValues,
} from "@oh-my-pi/pi-utils/i18n";
import { formatModelString, resolveModelRoleValue } from "../config/model-resolver";
import { formatModelRoleAlias, getKnownRoleIds, getRoleInfo, roleCandidatePool } from "../config/model-roles";
import { judgeRoleChain } from "../judgment";
import {
	draftMixtureSource,
	loadMixtureSource,
	MixtureAuthoringError,
	type MixtureDefinitionReport,
	type MixtureFileWrite,
	type MixtureSourceSnapshot,
	saveMixtureSources,
} from "./authoring";
import { ABSENT, type MixtureSource, mixtureSources, sourceId } from "./authoring-files";
import { discoverMixtures, MIXTURES_FILE_NAME } from "./config";
import { DEFAULT_TERMINATE_THRESHOLD } from "./decisions";
import { BUNDLED_ENVELOPES, BUNDLED_ROLES, moaPartsPartial } from "./envelopes";
import { formatMixtureIssue } from "./findings";
import { isMixtureModel, MixtureCatalog } from "./provider";
import { discoverRegistrableMixtures, type MixtureRegistrationContext } from "./registration";
import { allowedModels } from "./resolve";
import {
	cfgMoaBudgetUsd,
	cfgMoaHardBudgetUsd,
	cfgMoaHardMaxHops,
	cfgMoaJudgeMinConfidence,
	cfgMoaMaxHops,
	cfgMoaOnLimit,
	cfgMoaPartBudgetTokens,
	cfgMoaSummaryModel,
	cfgMoaTranscriptBudgetTokens,
	cfgMoaWallClockMinutes,
} from "./settings";
import { MAX_EDGE_TARGETS, MAX_EDGES, MAX_FILE_BYTES, MAX_MEMBERS, MAX_STATE_PARTS, MAX_TEXT_CHARS } from "./validate";
import { editorAssets, editorPage } from "./web-assets";

interface MixtureWebEditorOptions extends MixtureRegistrationContext {
	agentDir: string;
	/** The source the page opens first when the session has no mixture selected. */
	initialScope?: MixtureConfigScope;
	isCurrent?: () => boolean;
	/** The mixture name the invoking session currently runs, if any. */
	selectedMixture?: () => string | undefined;
	onSaved?: (message: string) => void;
}

export interface MixtureWebEditor {
	url: string;
	stop(): void;
}

const HOST = "127.0.0.1";
/** Files in one save: a move needs two; a batch never needs more than the search path holds. */
const MAX_BATCH_FILES = 16;
// JSON can spell a single TOML character as a six-byte Unicode escape; a move carries two files.
const MAX_REQUEST_BYTES = 2 * 6 * MAX_FILE_BYTES + 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const STUDIO_MESSAGES = "overlaysModel.moaWeb.studio.";
const SERVER_MESSAGES = "overlaysModel.moaWeb.server.";
const HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

function studioPage(locale: Locale): Response {
	const messages = Object.fromEntries(
		Object.entries(getCatalogOverrides(locale))
			.filter(([key]) => key.startsWith(STUDIO_MESSAGES))
			.map(([key, value]) => [key.slice(STUDIO_MESSAGES.length), value]),
	);
	// Leave the English browser table as the per-key fallback. Escape the inert data block's HTML delimiter.
	const substitutions: Record<string, string> = {
		locale,
		pageTitle: Bun.escapeHTML(serverText(locale, "pageTitle")),
		editorMessages: JSON.stringify(messages).replaceAll("<", "\\u003c"),
	};
	return new Response(
		editorPage.replace(/\{\{(\w+)\}\}/g, (marker, key: string) => substitutions[key] ?? marker),
		{
			headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" },
		},
	);
}

function serverText(locale: Locale, key: string, values?: TranslationValues): string {
	return t(locale, `${SERVER_MESSAGES}${key}`, values);
}

function webError(locale: Locale, status: number, key: string, values?: TranslationValues): Response {
	return json({ error: serverText(locale, key, values) }, status);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

/** Client-facing hash: null for a file that does not exist. */
function wireHash(hash: string): string | null {
	return hash === ABSENT ? null : hash;
}

function issuePath(index: number, path: string): string {
	return path ? `mixtures[${index}].${path}` : `mixtures[${index}]`;
}

function findings(reports: readonly MixtureDefinitionReport[], locale: Locale) {
	const present = (key: "errors" | "warnings") =>
		reports.flatMap(({ index, [key]: issues }) =>
			issues.map(issue => ({
				code: issue.code,
				path: issuePath(index, issue.path),
				message: formatMixtureIssue(issue, locale),
			})),
		);
	return { errors: present("errors"), warnings: present("warnings") };
}

function snapshotJson(snapshot: MixtureSourceSnapshot, locale: Locale) {
	const { hash, validation, ...rest } = snapshot;
	return {
		...rest,
		displayPath: shortenPath(snapshot.path),
		hash: wireHash(hash),
		validation: findings(validation, locale),
		reports: validation,
	};
}

/** Every selector the member model field can offer: visible chat roles first, then each allowed concrete model. */
function modelChoices(ctx: MixtureRegistrationContext) {
	const { registry, settings } = ctx;
	const available = registry.getAvailable();
	const isAllowed = allowedModels(ctx, available);
	const roles = [];
	for (const role of getKnownRoleIds(settings)) {
		const info = getRoleInfo(role, settings);
		if (info.hidden || info.section !== "chat") continue;
		const selector = formatModelRoleAlias(role);
		const resolved = resolveModelRoleValue(selector, available, { settings });
		const level =
			resolved.explicitThinkingLevel && resolved.thinkingLevel !== "auto" ? resolved.thinkingLevel : undefined;
		roles.push({
			selector,
			role: true,
			resolved: resolved.model ? formatModelString(resolved.model) : null,
			...(level ? { effort: level } : {}),
			...(resolved.model ? { efforts: [...getSupportedThinkingLevels(resolved.model)] } : {}),
		});
	}
	const models = available
		.filter(model => !isMixtureModel(model) && isAllowed(model))
		.map(model => ({
			selector: formatModelString(model),
			resolved: formatModelString(model),
			efforts: [...getSupportedThinkingLevels(model)],
		}));
	return [...roles, ...models];
}

function bundled(presets: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(Object.keys(presets).map(name => [name, presets[name]!]));
}

/** A capability URL bound to exactly one invoking workspace. Request bodies never choose the cwd or a path. */
export function startMixtureWebEditor(options: MixtureWebEditorOptions): MixtureWebEditor {
	const { cwd, agentDir, registry, settings, initialScope = "project", isCurrent, selectedMixture, onSaved } = options;
	const context: MixtureRegistrationContext = { cwd, agentDir, registry, settings };
	let projectDir = cwd;
	try {
		projectDir = vcs.repo(cwd)?.root() ?? cwd;
	} catch {
		// As with the fullscreen configurator, standalone workspaces save at cwd.
	}
	const dirs = { projectDir, agentDir };
	const sources = () => mixtureSources(cwd, dirs);
	const prefix = `/${crypto.randomUUID()}/`;
	let stopped = false;
	const current = () => !stopped && (isCurrent?.() ?? true);
	// Serialize saves in this launch, including their roster refreshes.
	let saved: Promise<unknown> = Promise.resolve();
	const catalogScope = () => MixtureCatalog.for(registry).scope(cwd, agentDir);

	/** The sidebar list: every source, each mixture with what the harness does with it now. */
	async function listSources() {
		const [list, discovered] = await Promise.all([sources(), discoverMixtures(cwd, agentDir)]);
		const winner = new Map(discovered.mixtures.map(entry => [entry.definition.name, entry.path] as const));
		const scope = catalogScope();
		const snapshots = await Promise.all(list.map(source => loadMixtureSource(source, context)));
		return snapshots.map(snapshot => ({
			id: snapshot.id,
			kind: snapshot.kind,
			path: snapshot.path,
			displayPath: shortenPath(snapshot.path),
			order: snapshot.order,
			...(snapshot.readOnly ? { readOnly: snapshot.readOnly } : {}),
			exists: snapshot.exists,
			hash: wireHash(snapshot.hash),
			...(snapshot.broken ? { broken: snapshot.broken } : {}),
			mixtures: snapshot.validation.map(report => {
				const definition = snapshot.doc.mixtures[report.index]!;
				const owner = winner.get(report.name);
				const shadowedBy = owner !== undefined && owner !== snapshot.path ? sourceId(owner) : undefined;
				const registeredRevision = scope.hasRoster ? scope.find(report.name)?.revision : undefined;
				return {
					name: report.name,
					index: report.index,
					...(definition.description ? { description: definition.description } : {}),
					members: Array.isArray(definition.members) ? definition.members.length : 0,
					edges: Array.isArray(definition.edges) ? definition.edges.length : 0,
					runnable: report.runnable,
					...(report.revision ? { revision: report.revision } : {}),
					...(shadowedBy ? { shadowedBy } : {}),
					status: shadowedBy
						? "shadowed"
						: !report.runnable
							? "invalid"
							: !scope.hasRoster
								? null
								: registeredRevision === report.revision
									? "registered"
									: "unregistered",
				};
			}),
		}));
	}

	async function sourceById(id: unknown): Promise<MixtureSource | undefined> {
		if (typeof id !== "string") return undefined;
		return (await sources()).find(source => source.id === id);
	}

	async function refreshRoster() {
		const roster = await discoverRegistrableMixtures(context);
		const scope = catalogScope();
		scope.setRoster(roster);
		return scope.roster().map(mixture => ({ name: mixture.definition.name, revision: mixture.revision }));
	}

	function bootstrap() {
		const available = registry.getAvailable();
		const isAllowed = allowedModels(context, available);
		const judgePool = roleCandidatePool("judge", settings, registry).filter(
			model => !isMixtureModel(model) && isAllowed(model),
		);
		const summarySelector = cfgMoaSummaryModel.get(settings);
		const summary = resolveModelRoleValue(summarySelector, available, { settings }).model;
		return {
			cwd,
			displayCwd: shortenPath(cwd),
			projectRoot: projectDir,
			displayProjectRoot: shortenPath(projectDir),
			selected: selectedMixture?.() ?? null,
			initialSourceId: sourceId(`${initialScope === "user" ? agentDir : projectDir}/${MIXTURES_FILE_NAME}`),
			models: modelChoices(context),
			judgePlan: judgeRoleChain(settings, registry, judgePool).map(candidate => ({
				model: formatModelString(candidate.model),
				...(candidate.thinkingLevel && candidate.thinkingLevel !== "auto"
					? { effort: candidate.thinkingLevel }
					: {}),
			})),
			summarySelector,
			summaryModel: summary && !isMixtureModel(summary) && isAllowed(summary) ? formatModelString(summary) : null,
			defaults: {
				maxHops: cfgMoaMaxHops.get(settings),
				hardMaxHops: cfgMoaHardMaxHops.get(settings),
				budgetUsd: cfgMoaBudgetUsd.get(settings),
				hardBudgetUsd: cfgMoaHardBudgetUsd.get(settings),
				wallClockMinutes: cfgMoaWallClockMinutes.get(settings),
				onLimit: cfgMoaOnLimit.get(settings),
				minConfidence: cfgMoaJudgeMinConfidence.get(settings),
				threshold: DEFAULT_TERMINATE_THRESHOLD,
				transcriptBudgetTokens: cfgMoaTranscriptBudgetTokens.get(settings),
				partBudgetTokens: cfgMoaPartBudgetTokens.get(settings),
			},
			bundled: { envelopes: bundled(BUNDLED_ENVELOPES), roles: bundled(BUNDLED_ROLES), partial: moaPartsPartial() },
			limits: {
				members: MAX_MEMBERS,
				edges: MAX_EDGES,
				edgeTargets: MAX_EDGE_TARGETS,
				stateParts: MAX_STATE_PARTS,
				textChars: MAX_TEXT_CHARS,
				fileBytes: MAX_FILE_BYTES,
			},
		};
	}

	/** Parse and check the save body; returns the writes or an error response. */
	async function saveRequest(body: unknown, locale: Locale): Promise<MixtureFileWrite[] | Response> {
		const files = isRecord(body) ? body.files : undefined;
		if (!Array.isArray(files) || files.length === 0 || files.length > MAX_BATCH_FILES)
			return webError(locale, 400, "saveBatchSize", { max: MAX_BATCH_FILES });
		const known = await sources();
		const writes: MixtureFileWrite[] = [];
		for (const file of files) {
			if (!isRecord(file)) return webError(locale, 400, "saveFileObject");
			const source = known.find(candidate => candidate.id === file.sourceId);
			if (!source) return webError(locale, 409, "saveFileUnknown");
			const { baseHash, doc, confirmCanonicalRewrite } = file;
			if (baseHash !== null && (typeof baseHash !== "string" || !HASH.test(baseHash)))
				return webError(locale, 400, "sourceHashRequired", { path: source.path });
			if (!isRecord(doc) || !Array.isArray(doc.mixtures))
				return webError(locale, 400, "sourceDocumentRequired", { path: source.path });
			if (confirmCanonicalRewrite !== undefined && typeof confirmCanonicalRewrite !== "boolean")
				return webError(locale, 400, "confirmationBoolean");
			writes.push({
				source,
				baseHash: baseHash ?? ABSENT,
				doc: doc as unknown as MixturesConfigDoc,
				confirmCanonicalRewrite,
			});
		}
		return writes;
	}

	async function save(writes: MixtureFileWrite[], locale: Locale): Promise<Response> {
		if (!current()) return webError(locale, 410, "sessionChanged");
		let snapshots: MixtureSourceSnapshot[];
		try {
			snapshots = await saveMixtureSources(writes, context);
		} catch (error) {
			if (!(error instanceof MixtureAuthoringError)) throw error;
			const { conflicts, files, partial, outcomes, code } = error.details;
			const body: Record<string, unknown> = { error: error.message };
			if (code) body.code = code;
			if (conflicts) {
				body.conflicts = conflicts.map(conflict => ({
					sourceId: conflict.sourceId,
					current: snapshotJson(conflict.current, locale),
				}));
				body.error = serverText(locale, "reloadChangedSource", {
					path: conflicts.map(conflict => conflict.current.path).join(", "),
				});
			}
			if (files) {
				const blockedNames: string[] = [];
				let firstBlocked: { path: string; message: string } | undefined;
				body.files = files.map(file => {
					const validation = file.validation && findings(file.validation, locale);
					if (file.blocked && file.validation) {
						for (const report of file.validation) {
							if (!file.blocked.includes(report.index)) continue;
							blockedNames.push(report.name || serverText(locale, "unnamed"));
							const issue = report.errors[0];
							if (issue && !firstBlocked)
								firstBlocked = {
									path: issuePath(report.index, issue.path),
									message: formatMixtureIssue(issue, locale),
								};
						}
					}
					return {
						sourceId: file.sourceId,
						...(validation ? { validation } : {}),
						...(file.blocked ? { blocked: file.blocked } : {}),
						...(file.parseDiagnostics ? { parseDiagnostics: file.parseDiagnostics } : {}),
					};
				});
				if (blockedNames.length) {
					body.error = serverText(locale, "blockedSave", {
						names: blockedNames.join(", "),
						detail: firstBlocked ? `: ${firstBlocked.path}: ${firstBlocked.message}` : "",
					});
				} else if (code === "rewrite-loses-source") {
					body.error = serverText(locale, "rewriteLosesSource", {
						path: writes
							.filter(write => files.some(file => file.sourceId === write.source.id))
							.map(write => write.source.path)
							.join(", "),
					});
				} else if (files.some(file => file.parseDiagnostics?.length)) {
					body.error = serverText(locale, "unrepresentableDraft");
				}
			}
			if (outcomes) {
				// Something may have reached disk: the roster and the sidebar follow the files as they are now.
				body.partial = partial === true;
				body.files = outcomes.map(outcome => ({ ...outcome, hash: outcome.hash && wireHash(outcome.hash) }));
				body.roster = await refreshRoster();
				body.sources = await listSources();
			}
			return json(body, error.status);
		}
		const roster = await refreshRoster();
		const list = await listSources();
		const written = new Set(writes.map(write => write.source.id));
		const hidden = list
			.filter(source => written.has(source.id))
			.flatMap(source => source.mixtures)
			.filter(mixture => mixture.status === "shadowed" || mixture.status === "unregistered");
		const paths = writes.map(write => shortenPath(write.source.path)).join(", ");
		const message = serverText(
			getLocale(),
			hidden.length ? (hidden.length > 1 ? "savedHiddenMany" : "savedHidden") : "saved",
			{
				paths,
				names: hidden.map(mixture => mixture.name).join(", "),
			},
		);
		if (current()) {
			try {
				onSaved?.(message);
			} catch (error) {
				logger.warn("Could not display mixture editor save status", { error: toError(error).message });
			}
		}
		return json({ files: snapshots.map(snapshot => snapshotJson(snapshot, locale)), sources: list, roster });
	}

	const server = Bun.serve({
		hostname: HOST,
		port: 0,
		development: false,
		maxRequestBodySize: MAX_REQUEST_BYTES,
		async fetch(request, listener) {
			const url = new URL(request.url);
			const lang = url.searchParams.get("lang");
			const locale = LOCALES.find(candidate => candidate === lang) ?? "en";
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
			try {
				if (request.method === "GET") {
					if (route === "") return studioPage(lang === null ? getLocale() : locale);
					if (route.startsWith("assets/")) {
						const name = route.slice("assets/".length);
						const asset = Object.hasOwn(editorAssets, name) ? editorAssets[name] : undefined;
						if (!asset) return webError(locale, 404, "notFound");
						return new Response(asset.body, { headers: { ...HEADERS, "Content-Type": asset.type } });
					}
					if (route === "bootstrap") return json(bootstrap());
					if (route === "mixtures/sources") return json({ sources: await listSources() });
					if (route === "mixtures/source") {
						const source = await sourceById(url.searchParams.get("id"));
						if (!source) return webError(locale, 404, "sourceNotEditable");
						return json(snapshotJson(await loadMixtureSource(source, context), locale));
					}
					return webError(locale, 404, "notFound");
				}
				const draft = request.method === "POST" && route === "mixtures/draft";
				if (!draft && !(request.method === "PUT" && route === "mixtures/save"))
					return webError(locale, 404, "notFound");
				if (origin !== listener.url.origin) return webError(locale, 403, "sameOriginRequired");
				if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
					return webError(locale, 415, "jsonRequired");
				const body: unknown = await request.json().catch(() => null);
				if (draft) {
					if (!isRecord(body) || !(await sourceById(body.sourceId)))
						return webError(locale, 400, "sourceIdRequired");
					if (!isRecord(body.doc) || !Array.isArray(body.doc.mixtures))
						return webError(locale, 400, "documentRequired");
					const result = draftMixtureSource(body.doc as unknown as MixturesConfigDoc, context);
					return json({
						toml: result.toml,
						parseDiagnostics: result.parseDiagnostics,
						validation: findings(result.validation, locale),
						reports: result.validation,
					});
				}
				const writes = await saveRequest(body, locale);
				if (writes instanceof Response) return writes;
				const pending = saved.then(() => save(writes, locale));
				saved = pending.catch(() => {});
				return await pending;
			} catch (error) {
				if (error instanceof MixtureAuthoringError) return json({ error: error.message }, error.status);
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
