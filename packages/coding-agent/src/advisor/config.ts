import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { type Document, isMap, isNode, isSeq, type ParsedNode, type YAMLMap, type YAMLSeq } from "yaml";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { writeFileAtomically } from "../utils/atomic-file";
import { ADVISOR_DEFAULT_BUDGET_PER_UPDATE, ADVISOR_MAX_BUDGET_PER_UPDATE } from "./emission-guard";
import { collectConfigCandidates, readBoundedText } from "./watchdog";
import { materializeYamlAlias, parseYamlMappingDocument, yamlDocumentRoot } from "../config/yaml-document";

import {
	ADVISOR_SESSION_SCOPES,
	ADVISOR_SYNC_BACKLOG_MODES,
	type AdvisorConfig,
	type AdvisorConfigScope,
	type AdvisorSyncBacklog,
	slugifyAdvisorName,
	type WatchdogConfigDoc,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";

export {
	ADVISOR_REVIEW_MODES,
	ADVISOR_SESSION_SCOPES,
	ADVISOR_SYNC_BACKLOG_MODES,
	slugifyAdvisorName,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";
export type { AdvisorReviewMode, AdvisorSessionScope, AdvisorSyncBacklog } from "@oh-my-pi/pi-tui/overlays/advisor-config";

const WATCHDOG_ADVISOR_KEYS = [
	"id",
	"name",
	"model",
	"tools",
	"reviewMode",
	"reviewInterval",
	"syncBacklog",
	"instructions",
	"systemPrompt",
	"enabled",
	"includeThinking",
	"scope",
	"maxNotesPerUpdate",
] as const;

interface WatchdogAdvisorOrigin {
	advisor: AdvisorConfig;
	base: AdvisorConfig;
	name: string;
	occurrence: number;
	fingerprint: string | undefined;
}

interface WatchdogBaseline {
	doc: WatchdogConfigDoc;
	origins: WatchdogAdvisorOrigin[];
	filePath: string;
	sourceWasPresent: boolean;
}

/** Load snapshots stay out of the public editor shape while saves compute path-level changes. */
const watchdogBaselines = new WeakMap<WatchdogConfigDoc, WatchdogBaseline>();
const watchdogRepairDocs = new WeakSet<WatchdogConfigDoc>();
/**
 * Runtime health of a single advisor, surfaced in stats and the status line.
 * - `running` — actively processing primary turns
 * - `paused` — user-toggled off via per-advisor switch (runtime disposed)
 * - `quota_exhausted` — provider returned a quota/usage-limit error that host
 *   recovery could not absorb; the runtime stays paused, batch retained, until
 *   it is reset or rebuilt (compaction, image drop, shake, session switch,
 *   `/advisor` rebuild, config reload, restart). No timer resumes it.
 * - `error` — repeated transient failures; backlog dropped to prevent stall
 * - `no_model` — no model resolved for this advisor's role/explicit model
 */
export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

/**
 * The result of walking the `WATCHDOG.yml`/`WATCHDOG.yaml` search path: the
 * deduped advisor roster plus the concatenated top-level `instructions` baseline
 * that is prepended (alongside `WATCHDOG.md`) to every advisor.
 */
export interface DiscoveredAdvisors {
	advisors: AdvisorConfig[];
	/** Winning source for each advisor slug; display metadata only, never a new discovery policy. */
	sources: ReadonlyMap<string, { path: string; scope: AdvisorConfigScope }>;
	/** Every readable candidate in discovery load order, including disabled and malformed files. */
	files: { path: string; scope: AdvisorConfigScope; enabled?: boolean }[];
	sharedInstructions: string | undefined;
	sharedMaxNotesPerUpdate?: number;
	/**
	 * Human-readable config problems collected during the walk: unparseable
	 * files and dropped entries. Surfaced as one aggregated session warning so
	 * a broken roster entry never fails silently.
	 */
	warnings: string[];
	/** A present file was unreadable or malformed; keep the prior live roster during hot reload. */
	unsafeToReconcile: boolean;
}

/** Keep the legacy default for empty enabled files, but never synthesize it when every file is off. */
export function advisorRosterForRuntime(discovered: DiscoveredAdvisors): AdvisorConfig[] | undefined {
	return discovered.advisors.length > 0 ||
		(discovered.files.length > 0 && discovered.files.every(file => file.enabled === false))
		? discovered.advisors
		: undefined;
}

const reviewIntervalSchema = type("1 <= number.integer <= 9007199254740991");
const syncBacklogSchema = type.enumerated(...ADVISOR_SYNC_BACKLOG_MODES);
const sessionScopeSchema = type.enumerated(...ADVISOR_SESSION_SCOPES);
const syncBacklogEntrySchema = type.enumerated(...ADVISOR_SYNC_BACKLOG_MODES, 1, 3, 5);
const SYNC_BACKLOG_NUMERIC_THRESHOLDS = { 1: "1", 3: "3", 5: "5" } as const;

function normalizeSyncBacklog(
	value: AdvisorSyncBacklog | keyof typeof SYNC_BACKLOG_NUMERIC_THRESHOLDS,
): AdvisorSyncBacklog {
	return typeof value === "number" ? SYNC_BACKLOG_NUMERIC_THRESHOLDS[value] : value;
}

function assertAdvisorCadence(advisor: AdvisorConfig): void {
	if (advisor.reviewInterval !== undefined) reviewIntervalSchema.assert(advisor.reviewInterval);
	if (advisor.syncBacklog !== undefined) syncBacklogSchema.assert(advisor.syncBacklog);
}

const advisorEntrySchema = type({
	name: "string",
	"id?": "string > 0",
	"model?": "string",
	"tools?": "string[]",
	"reviewMode?": "'turn' | 'agent-end'",
	"reviewInterval?": reviewIntervalSchema,
	"syncBacklog?": syncBacklogEntrySchema,
	"instructions?": "string",
	"systemPrompt?": "string",
	"enabled?": "boolean",
	"includeThinking?": "boolean",
	"maxNotesPerUpdate?": "number",
	"scope?": sessionScopeSchema,
});

type AdvisorYamlEntry = typeof advisorEntrySchema.infer;

/** Validate inline/generated definitions through the same schema as WATCHDOG entries. */
export function parseInlineAdvisorConfig(value: unknown): AdvisorConfig {
	return editableAdvisorConfig(advisorEntrySchema.assert(value));
}

export function advisorDefinitionJsonSchema(): Record<string, unknown> {
	return advisorEntrySchema.toJsonSchema();
}
function editableAdvisorConfig(entry: AdvisorYamlEntry): AdvisorConfig {
	const advisor: AdvisorConfig = { name: entry.name };
	if (entry.id !== undefined) advisor.id = entry.id;
	if (entry.model?.trim()) advisor.model = entry.model;
	if (entry.tools !== undefined) advisor.tools = [...entry.tools];
	if (entry.reviewMode !== undefined) advisor.reviewMode = entry.reviewMode;
	if (entry.reviewInterval !== undefined) advisor.reviewInterval = entry.reviewInterval;
	if (entry.syncBacklog !== undefined) advisor.syncBacklog = normalizeSyncBacklog(entry.syncBacklog);
	if (entry.instructions?.trim()) advisor.instructions = entry.instructions;
	if (entry.systemPrompt !== undefined) advisor.systemPrompt = entry.systemPrompt;
	if (entry.enabled !== undefined) advisor.enabled = entry.enabled;
	if (entry.includeThinking !== undefined) advisor.includeThinking = entry.includeThinking;
	if (entry.scope !== undefined) advisor.scope = entry.scope;
	if (
		typeof entry.maxNotesPerUpdate === "number" &&
		Number.isFinite(entry.maxNotesPerUpdate) &&
		entry.maxNotesPerUpdate >= 1
	) {
		advisor.maxNotesPerUpdate = Math.trunc(entry.maxNotesPerUpdate);
	}
	return advisor;
}

/**
 * Validate one parsed `WATCHDOG.yml` document per entry instead of as a whole:
 * a single malformed advisor drops out with a warning naming it, while the
 * healthy entries still load. Also reports non-string `instructions` and a
 * non-list `advisors` key — both previously failed the whole file silently.
 */
function parseWatchdogDoc(
	doc: Record<string, unknown>,
	path: string,
): {
	enabled: boolean | undefined;
	instructions: string | undefined;
	entries: AdvisorYamlEntry[];
	sharedMaxNotesPerUpdate: number | undefined;
	warnings: string[];
} {
	const warnings: string[] = [];
	const enabled = typeof doc.enabled === "boolean" ? doc.enabled : undefined;
	if (doc.enabled !== undefined && enabled === undefined) {
		warnings.push(`${path}: enabled must be a boolean — ignored`);
	}
	const rawInstructions = doc.instructions;
	const instructions = typeof rawInstructions === "string" ? rawInstructions : undefined;
	if (rawInstructions !== undefined && instructions === undefined) {
		warnings.push(`${path}: instructions must be a string — ignored`);
	}
	const rawMaxNotes = doc.maxNotesPerUpdate;
	const sharedMaxNotesPerUpdate =
		typeof rawMaxNotes === "number" && Number.isFinite(rawMaxNotes) && rawMaxNotes >= 1
			? Math.trunc(rawMaxNotes)
			: undefined;
	const rawAdvisors = doc.advisors;
	if (rawAdvisors !== undefined && !Array.isArray(rawAdvisors)) {
		warnings.push(`${path}: advisors must be a list — ignored`);
	}
	const entries: AdvisorYamlEntry[] = [];
	const ids = new Set<string>();
	for (const [index, rawEntry] of (Array.isArray(rawAdvisors) ? rawAdvisors : []).entries()) {
		const result = advisorEntrySchema(rawEntry);
		if (result instanceof type.errors) {
			const rawName =
				rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>).name : undefined;
			const label = typeof rawName === "string" && rawName.trim() ? `"${rawName}"` : `#${index + 1}`;
			warnings.push(`${path}: advisor ${label} dropped — ${result.summary}`);
			continue;
		}
		if (result.id) {
			if (ids.has(result.id)) {
				warnings.push(`${path}: advisor "${result.name}" has duplicate id "${result.id}"; save to repair IDs`);
			}
			ids.add(result.id);
		}
		entries.push(result);
	}
	return { enabled, instructions, entries, sharedMaxNotesPerUpdate, warnings };
}

/** Resolve the non-blocker budget from advisor, shared, and settings precedence. */
export function resolveAdvisorMaxNotesPerUpdate(
	advisorBudget: number | undefined,
	sharedBudget: number | undefined,
	settingsBudget: number | undefined,
): number {
	const clamp = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 1
			? Math.min(ADVISOR_MAX_BUDGET_PER_UPDATE, Math.trunc(value))
			: undefined;

	return clamp(advisorBudget) ?? clamp(sharedBudget) ?? clamp(settingsBudget) ?? ADVISOR_DEFAULT_BUDGET_PER_UPDATE;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR = "\u0000";

/**
 * Returns a stable provider-facing UUIDv7 for one advisor within one primary session.
 *
 * Codex treats `session_id`/`conversation_id` as a UUID-shaped routing identity,
 * so advisor labels such as `-advisor` stay local-only.
 */
export function getOrCreateAdvisorProviderSessionId(
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
	randomSessionId: () => string = () => Bun.randomUUIDv7(),
): string | undefined {
	if (!primarySessionId) return undefined;
	const key = `${primarySessionId}${ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR}${slug}`;
	const existing = ids.get(key);
	if (existing) return existing;

	const next = randomSessionId();
	if (!UUID_V7_PATTERN.test(next)) {
		throw new Error("Advisor provider session id generator returned a non-UUIDv7 value");
	}
	ids.set(key, next);
	return next;
}

/** Built tool names, for validating an advisor's `tools` list. */
const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

/**
 * Keep only valid tool names from an advisor's `tools` list, dropping unknowns
 * with a warning. The advisor is a full agent, so any built tool may be granted;
 * the runtime further filters to what's actually available this session.
 * `undefined` means "use the default subset" (read/grep/glob); only an explicit
 * raw empty list means "no tools".
 */
function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	// Normalize legacy aliases (search→grep, find→glob) and dedupe before validating.
	const filtered = normalizeToolNames(tools).filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		logger.warn("Advisor config: dropping unknown tool", { path: sourcePath, tool: name });
		return false;
	});
	return filtered.length > 0 ? filtered : undefined;
}

/**
 * Discover advisor configs from `WATCHDOG.yml`/`WATCHDOG.yaml` files on the same
 * user + project search path as `WATCHDOG.md`. Persisted IDs distinguish even
 * identically named advisors; legacy entries retain name-slug precedence until
 * first save. More-specific files replace an earlier entry with the same key.
 * Top-level instructions concatenate into the shared baseline. Malformed files
 * are logged and skipped so a bad project config cannot kill the session.
 */
export async function discoverAdvisorConfigs(
	cwd: string,
	agentDir?: string,
	sessionDir?: string,
): Promise<DiscoveredAdvisors> {
	let unsafeToReconcile = false;
	const candidates = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"], {
		onReadError: () => {
			unsafeToReconcile = true;
		},
		onRejected: (filePath, rejection) => {
			unsafeToReconcile = true;
			logger.warn("Skipped config candidate", { path: filePath, ...rejection });
		},
	});
	const items: { path: string; content: string; level: AdvisorConfigScope }[] = candidates.map(item => ({
		...item,
		level: item.level === "project" && path.basename(path.dirname(item.path)) === ".omp" ? "project-omp" : item.level,
	}));
	// The transcript artifact directory is also where scoped settings (#622) live.
	// Session sources are last, so they override project/user legacy names and IDs.
	if (sessionDir) {
		for (const filename of ["WATCHDOG.yml", "WATCHDOG.yaml"]) {
			const filePath = path.join(sessionDir, filename);
			try {
				const result = await readBoundedText(filePath, undefined);
				if ("content" in result) items.push({ path: filePath, content: result.content, level: "session" });
				else unsafeToReconcile = true;
			} catch (error) {
				if (!isEnoent(error)) {
					unsafeToReconcile = true;
					logger.warn("Cannot read session advisor configuration", { path: filePath, error: String(error) });
				}
			}
		}
	}
	const files: DiscoveredAdvisors["files"] = items.map(item => ({ path: item.path, scope: item.level }));
	const advisors = new Map<string, AdvisorConfig>();
	const sources = new Map<string, { path: string; scope: AdvisorConfigScope }>();
	const sharedParts: string[] = [];
	let sharedMaxNotesPerUpdate: number | undefined;
	const warnings: string[] = [];
	const warn = (message: string, context?: Record<string, unknown>): void => {
		warnings.push(message);
		logger.warn("Advisor config", { ...context, error: message });
	};

	for (const [index, item] of items.entries()) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			warn(`${item.path}: failed to parse YAML (${String(err)}) — file skipped`, { path: item.path });
			unsafeToReconcile = true;
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warn(`${item.path}: expected a YAML mapping — file skipped`, { path: item.path });
			unsafeToReconcile = true;
			continue;
		}
		const {
			enabled,
			instructions,
			entries,
			sharedMaxNotesPerUpdate: docSharedMaxNotes,
			warnings: docWarnings,
		} = parseWatchdogDoc(parsed as Record<string, unknown>, item.path);
		for (const message of docWarnings) warn(message, { path: item.path });
		if (enabled !== undefined) files[index].enabled = enabled;
		if (enabled === false) continue;

		if (instructions?.trim()) {
			const expanded = (await expandAtImports(instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		if (docSharedMaxNotes !== undefined) sharedMaxNotesPerUpdate = docSharedMaxNotes;

		const fileIds = new Set<string>();
		for (const [index, entry] of entries.entries()) {
			const duplicateId = entry.id !== undefined && fileIds.has(entry.id);
			if (entry.id) fileIds.add(entry.id);
			const slug = slugifyAdvisorName(entry.name);
			sources.set(slug, { path: item.path, scope: item.level });
			const entryInstructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(duplicateId ? `duplicate:${item.path}:${index}` : entry.id ? `id:${entry.id}` : `name:${slug}`, {
				id: duplicateId ? undefined : entry.id,
				sourceScope: item.level,
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				systemPrompt: entry.systemPrompt,
				reviewMode: entry.reviewMode,
				reviewInterval: entry.reviewInterval,
				syncBacklog: entry.syncBacklog === undefined ? undefined : normalizeSyncBacklog(entry.syncBacklog),
				maxNotesPerUpdate:
					typeof entry.maxNotesPerUpdate === "number" &&
					Number.isFinite(entry.maxNotesPerUpdate) &&
					entry.maxNotesPerUpdate >= 1
						? Math.trunc(entry.maxNotesPerUpdate)
						: undefined,
				enabled: entry.enabled,
				includeThinking: entry.includeThinking,
				scope: entry.scope,
				instructions: entryInstructions,
			});
		}
	}

	return {
		advisors: [...advisors.values()],
		sources,
		files,
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
		sharedMaxNotesPerUpdate,
		warnings,
		unsafeToReconcile,
	};
}

export interface NamedAdvisor {
	name: string;
	scope: AdvisorConfigScope;
	sourcePath: string;
	config: AdvisorConfig;
}
/**
 * Every named definition, including disabled and shadowed entries, in discovery
 * load order (later entries win for references without an exact scope).
 * Instructions and tools match runtime discovery; sourcePath stays exact for UI labels.
 */
export async function listNamedAdvisors(
	cwd: string,
	agentDir?: string,
	sessionDir?: string,
): Promise<NamedAdvisor[]> {
	const discovered = await discoverAdvisorConfigs(cwd, agentDir, sessionDir);
	const result: NamedAdvisor[] = [];
	for (const file of discovered.files) {
		const doc = await loadWatchdogConfigFile(file.path);
		for (const config of doc.advisors) {
			config.sourceScope = file.scope;
			if (config.instructions?.trim())
				config.instructions = (await expandAtImports(config.instructions, file.path)).trim() || undefined;
			config.tools = filterAdvisorTools(config.tools, file.path);
			result.push({ name: config.name, scope: file.scope, sourcePath: file.path, config });
		}
	}
	return result;
}

/** Resolve a scope's canonical file beside its user, project, or session configuration. */
export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string; sessionDir?: string },
): string {
	return path.join(advisorConfigDirectory(scope, dirs), "WATCHDOG.yml");
}

function advisorConfigDirectory(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string; sessionDir?: string },
): string {
	switch (scope) {
		case "user": return dirs.agentDir;
		case "project": return dirs.projectDir;
		case "project-omp": return path.join(dirs.projectDir, ".omp");
		case "session":
			if (!dirs.sessionDir) throw new Error("This session has no persistent artifact directory");
			return dirs.sessionDir;
	}
}

/**
 * Resolve which `WATCHDOG.{yml,yaml}` to edit for a scope: prefer the canonical
 * `.yml`, but when only a `.yaml` exists for that scope, edit it in place so an
 * existing `.yaml` user isn't shown a blank editor and left with two files at the
 * same precedence. Falls back to `.yml` when neither exists.
 */
export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string; sessionDir?: string },
): Promise<string> {
	const dir = advisorConfigDirectory(scope, dirs);
	const yml = path.join(dir, "WATCHDOG.yml");
	const yaml = path.join(dir, "WATCHDOG.yaml");
	if (!(await Bun.file(yml).exists()) && (await Bun.file(yaml).exists())) return yaml;
	return yml;
}

function watchdogAdvisorFingerprint(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function watchdogAdvisorFingerprints(source: string): (string | undefined)[] {
	try {
		const parsed: unknown = YAML.parse(source);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const rawAdvisors = (parsed as Record<string, unknown>).advisors;
		if (!Array.isArray(rawAdvisors)) return [];
		const fingerprints: (string | undefined)[] = [];
		for (const rawAdvisor of rawAdvisors) {
			if (advisorEntrySchema(rawAdvisor) instanceof type.errors) continue;
			fingerprints.push(watchdogAdvisorFingerprint(rawAdvisor));
		}
		return fingerprints;
	} catch {
		return [];
	}
}

function rememberWatchdogBaseline(
	doc: WatchdogConfigDoc,
	filePath: string,
	sourceWasPresent = true,
	source = "",
): void {
	const occurrences = new Map<string, number>();
	const fingerprints = watchdogAdvisorFingerprints(source);
	const origins = doc.advisors.map((advisor, index) => {
		const occurrence = occurrences.get(advisor.name) ?? 0;
		occurrences.set(advisor.name, occurrence + 1);
		return {
			advisor,
			base: structuredClone(advisor),
			name: advisor.name,
			occurrence,
			fingerprint: fingerprints[index],
		};
	});
	watchdogBaselines.set(doc, { doc: structuredClone(doc), origins, filePath, sourceWasPresent });
}

/**
 * Load one `WATCHDOG.yml` file for editing — raw, un-merged, un-expanded. Missing
 * or unparseable files yield an empty doc (never throws) so the editor opens
 * cleanly on a fresh or broken file. Validation is per entry, matching
 * discovery: malformed entries drop out of `advisors` and land in `warnings`
 * instead of blanking the whole editor.
 */
export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Advisor config: failed to read for edit", { path: filePath, error: String(err) });
			return { advisors: [] };
		}
		const doc: WatchdogConfigDoc = { advisors: [] };
		rememberWatchdogBaseline(doc, filePath, false);
		return doc;
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		logger.warn("Advisor config: failed to parse for edit", { path: filePath, error: String(err) });
		const doc: WatchdogConfigDoc = {
			advisors: [],
			warnings: [`${filePath}: failed to parse YAML (${String(err)})`],
		};
		watchdogRepairDocs.add(doc);
		return doc;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		// Parity with discovery: a non-mapping document is reported, not silently blanked.
		const message = `${filePath}: expected a YAML mapping — file skipped`;
		logger.warn("Advisor config", { path: filePath, error: message });
		const doc: WatchdogConfigDoc = { advisors: [], warnings: [message] };
		watchdogRepairDocs.add(doc);
		return doc;
	}
	const { enabled, instructions, entries, sharedMaxNotesPerUpdate, warnings } = parseWatchdogDoc(
		parsed as Record<string, unknown>,
		filePath,
	);
	for (const message of warnings) logger.warn("Advisor config", { path: filePath, error: message });
	const advisors = entries.map(editableAdvisorConfig);
	const doc: WatchdogConfigDoc = { advisors };
	if (enabled !== undefined) doc.enabled = enabled;
	if (instructions?.trim()) doc.instructions = instructions;
	if (sharedMaxNotesPerUpdate !== undefined) doc.maxNotesPerUpdate = sharedMaxNotesPerUpdate;
	if (warnings.length > 0) doc.warnings = warnings;
	rememberWatchdogBaseline(doc, filePath, true, text);
	return doc;
}

/**
 * Serialize an editable doc back to canonical, hand-editable `WATCHDOG.yml`.
 * Multiline instruction fields use literal block scalars while scalar quoting
 * delegates to Bun's YAML encoder. Round-trips through {@link loadWatchdogConfigFile}.
 * Returns `""` for an empty doc.
 */

/** Append `key: value`, using a literal block scalar for multiline text. Shared with chain config. */
export function appendYamlString(lines: string[], indent: string, key: string, value: string): void {
	const hasSignificantLeadingWhitespace = value.split("\n").some(line => /^[ \t]/.test(line));
	if (!value.includes("\n") || hasSignificantLeadingWhitespace) {
		lines.push(`${indent}${key}: ${YAML.stringify(value)}`);
		return;
	}
	const normalized = value.replaceAll("\r\n", "\n");
	let trailingNewlines = 0;
	for (let index = normalized.length - 1; index >= 0 && normalized[index] === "\n"; index--) {
		trailingNewlines++;
	}
	const chomp = trailingNewlines === 0 ? "|2-" : trailingNewlines === 1 ? "|2" : "|2+";
	const body = trailingNewlines === 0 ? normalized : normalized.slice(0, -trailingNewlines);
	lines.push(`${indent}${key}: ${chomp}`);
	for (const line of body.split("\n")) {
		lines.push(`${indent}  ${line}`);
	}
	for (let index = 1; index < trailingNewlines; index++) {
		lines.push(`${indent}  `);
	}
}

export function serializeWatchdogConfig(doc: WatchdogConfigDoc): string {
	const lines: string[] = [];
	ensureAdvisorIds(doc);
	if (doc.enabled !== undefined) lines.push(`enabled: ${doc.enabled}`);
	if (doc.instructions?.trim()) appendYamlString(lines, "", "instructions", doc.instructions);
	if (
		typeof doc.maxNotesPerUpdate === "number" &&
		Number.isFinite(doc.maxNotesPerUpdate) &&
		doc.maxNotesPerUpdate >= 1
	) {
		lines.push(`maxNotesPerUpdate: ${Math.trunc(doc.maxNotesPerUpdate)}`);
	}
	if (doc.advisors.length > 0) {
		lines.push("advisors:");
		for (const advisor of doc.advisors) {
			assertAdvisorCadence(advisor);
			lines.push(`  - name: ${YAML.stringify(advisor.name)}`);
			lines.push(`    id: ${YAML.stringify(advisor.id!)}`);
			if (advisor.model?.trim()) lines.push(`    model: ${YAML.stringify(advisor.model)}`);
			if (advisor.tools !== undefined) {
				if (advisor.tools.length === 0) {
					lines.push("    tools: []");
				} else {
					lines.push("    tools:");
					for (const tool of advisor.tools) {
						lines.push(`      - ${YAML.stringify(tool)}`);
					}
				}
			}
			if (advisor.reviewMode !== undefined) lines.push(`    reviewMode: ${YAML.stringify(advisor.reviewMode)}`);
			if (advisor.syncBacklog !== undefined) {
				lines.push(`    syncBacklog: ${YAML.stringify(advisor.syncBacklog)}`);
			}
			if (advisor.instructions?.trim()) {
				appendYamlString(lines, "    ", "instructions", advisor.instructions);
			}
			if (advisor.systemPrompt !== undefined) {
				appendYamlString(lines, "    ", "systemPrompt", advisor.systemPrompt);
			}
			if (advisor.enabled !== undefined) lines.push(`    enabled: ${advisor.enabled}`);
			if (advisor.includeThinking !== undefined) lines.push(`    includeThinking: ${advisor.includeThinking}`);
			if (
				typeof advisor.maxNotesPerUpdate === "number" &&
				Number.isFinite(advisor.maxNotesPerUpdate) &&
				advisor.maxNotesPerUpdate >= 1
			) {
				lines.push(`    maxNotesPerUpdate: ${Math.trunc(advisor.maxNotesPerUpdate)}`);
			}
			if (advisor.reviewInterval !== undefined) {
				lines.push(`    reviewInterval: ${advisor.reviewInterval}`);
			}
			if (advisor.scope !== undefined) {
				sessionScopeSchema.assert(advisor.scope);
				lines.push(`    scope: ${YAML.stringify(advisor.scope)}`);
			}
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function watchdogAdvisorValues(advisor: AdvisorConfig): Record<(typeof WATCHDOG_ADVISOR_KEYS)[number], unknown> {
	return {
		id: advisor.id,
		name: advisor.name,
		model: advisor.model?.trim() ? advisor.model : undefined,
		tools: advisor.tools === undefined ? undefined : [...advisor.tools],
		instructions: advisor.instructions?.trim() ? advisor.instructions : undefined,
		systemPrompt: advisor.systemPrompt,
		enabled: advisor.enabled,
		includeThinking: advisor.includeThinking,
		reviewMode: advisor.reviewMode,
		reviewInterval: advisor.reviewInterval,
		syncBacklog: advisor.syncBacklog,
		scope: advisor.scope,
		maxNotesPerUpdate:
			typeof advisor.maxNotesPerUpdate === "number" &&
			Number.isFinite(advisor.maxNotesPerUpdate) &&
			advisor.maxNotesPerUpdate >= 1
				? Math.trunc(advisor.maxNotesPerUpdate)
				: undefined,
	};
}

function findWatchdogAdvisor(
	document: Document.Parsed<ParsedNode>,
	sequence: YAMLSeq<unknown>,
	name: string,
	occurrence: number,
): { index: number; map: YAMLMap<unknown, unknown> } | undefined {
	let seen = 0;
	for (const [index, item] of sequence.items.entries()) {
		if (!isMap(item) || watchdogAdvisorMapValues(document, item)?.name !== name) continue;
		if (seen === occurrence) return { index, map: item };
		seen++;
	}
	return undefined;
}

function removeMalformedWatchdogAdvisors(document: Document.Parsed<ParsedNode>, sequence: YAMLSeq<unknown>): void {
	for (let index = sequence.items.length - 1; index >= 0; index--) {
		const item = sequence.items[index];
		const value: unknown = isNode(item) ? item.toJS(document) : item;
		if (!(advisorEntrySchema(value) instanceof type.errors)) continue;
		sequence.delete(index);
	}
}

function resolveWatchdogAdvisorOrigin(
	document: Document.Parsed<ParsedNode>,
	sequence: YAMLSeq<unknown>,
	origin: WatchdogAdvisorOrigin,
	origins: readonly WatchdogAdvisorOrigin[],
): { index: number; map: YAMLMap<unknown, unknown> } | undefined {
	const candidates: { index: number; map: YAMLMap<unknown, unknown> }[] = [];
	if (origin.base.id && origins.filter(candidate => candidate.base.id === origin.base.id).length === 1) {
		for (const [index, item] of sequence.items.entries()) {
			if (isMap(item) && item.get("id") === origin.base.id) candidates.push({ index, map: item });
		}
		return candidates.length === 1 ? candidates[0] : undefined;
	}
	const sameNameOrigins = origins.filter(
		candidate => candidate.name === origin.name && candidate.base.id === origin.base.id,
	);
	const occurrence = sameNameOrigins.indexOf(origin);
	for (const [index, item] of sequence.items.entries()) {
		if (
			isMap(item) &&
			watchdogAdvisorMapValues(document, item)?.name === origin.name &&
			(origin.base.id === undefined || item.get("id") === origin.base.id)
		)
			candidates.push({ index, map: item });
	}
	if (origin.fingerprint !== undefined) {
		const exact = candidates.filter(
			candidate => watchdogAdvisorFingerprint(candidate.map.toJS(document)) === origin.fingerprint,
		);
		if (exact.length === 1) return exact[0];
		if (exact.length > 1) {
			// Identical rows are safe only while their baseline order is unchanged.
			const unchangedOrder =
				candidates.length === sameNameOrigins.length &&
				candidates.every(
					(candidate, index) =>
						watchdogAdvisorFingerprint(candidate.map.toJS(document)) === sameNameOrigins[index].fingerprint,
				);
			return unchangedOrder ? candidates[occurrence] : undefined;
		}
	}
	if (candidates.length !== sameNameOrigins.length) return undefined;
	return candidates[occurrence];
}

function watchdogAdvisorMapValues(
	document: Document.Parsed<ParsedNode>,
	map: YAMLMap<unknown, unknown>,
): Record<(typeof WATCHDOG_ADVISOR_KEYS)[number], unknown> | undefined {
	const parsed = advisorEntrySchema(map.toJS(document));
	return parsed instanceof type.errors ? undefined : watchdogAdvisorValues(editableAdvisorConfig(parsed));
}

function watchdogAdvisorOriginUnchanged(
	document: Document.Parsed<ParsedNode>,
	map: YAMLMap<unknown, unknown>,
	origin: WatchdogAdvisorOrigin,
): boolean {
	if (origin.fingerprint !== undefined) {
		return watchdogAdvisorFingerprint(map.toJS(document)) === origin.fingerprint;
	}
	const currentValues = watchdogAdvisorMapValues(document, map);
	if (!currentValues) return false;
	const expectedValues = watchdogAdvisorValues(origin.base);
	return WATCHDOG_ADVISOR_KEYS.every(key => Bun.deepEquals(currentValues[key], expectedValues[key]));
}

function patchWatchdogAdvisor(
	document: Document.Parsed<ParsedNode>,
	map: YAMLMap<unknown, unknown>,
	advisor: AdvisorConfig,
	base?: AdvisorConfig,
): void {
	const values = watchdogAdvisorValues(advisor);
	const baseValues = base ? watchdogAdvisorValues(base) : undefined;
	const currentValues = baseValues ? watchdogAdvisorMapValues(document, map) : undefined;
	for (const key of WATCHDOG_ADVISOR_KEYS) {
		if (baseValues && Bun.deepEquals(values[key], baseValues[key])) continue;
		if (baseValues && currentValues && !Bun.deepEquals(currentValues[key], baseValues[key])) continue;
		const value = values[key];
		if (value === undefined) map.delete(key);
		else map.set(key, value);
	}
}

function patchWatchdogDocument(source: string, doc: WatchdogConfigDoc, baseline?: WatchdogBaseline): string {
	if (!source.trim() && (!baseline || !baseline.sourceWasPresent)) return serializeWatchdogConfig(doc);
	for (const advisor of doc.advisors) assertAdvisorCadence(advisor);
	const document = parseYamlMappingDocument(source);
	const root = yamlDocumentRoot(document);
	const topLevelValues = {
		enabled: doc.enabled,
		instructions: doc.instructions?.trim() ? doc.instructions : undefined,
		maxNotesPerUpdate:
			typeof doc.maxNotesPerUpdate === "number" &&
			Number.isFinite(doc.maxNotesPerUpdate) &&
			doc.maxNotesPerUpdate >= 1
				? Math.trunc(doc.maxNotesPerUpdate)
				: undefined,
	};
	const baseTopLevelValues = baseline
		? {
				enabled: baseline.doc.enabled,
				instructions: baseline.doc.instructions?.trim() ? baseline.doc.instructions : undefined,
				maxNotesPerUpdate: baseline.doc.maxNotesPerUpdate,
			}
		: undefined;
	const currentInstructions = root.get("instructions");
	const currentMaxNotesPerUpdate = root.get("maxNotesPerUpdate");
	const currentTopLevelValues = {
		enabled: typeof root.get("enabled") === "boolean" ? (root.get("enabled") as boolean) : undefined,
		instructions:
			typeof currentInstructions === "string" && currentInstructions.trim() ? currentInstructions : undefined,
		maxNotesPerUpdate:
			typeof currentMaxNotesPerUpdate === "number" &&
			Number.isFinite(currentMaxNotesPerUpdate) &&
			currentMaxNotesPerUpdate >= 1
				? Math.trunc(currentMaxNotesPerUpdate)
				: undefined,
	};
	for (const key of ["enabled", "instructions", "maxNotesPerUpdate"] as const) {
		if (baseTopLevelValues && Bun.deepEquals(topLevelValues[key], baseTopLevelValues[key])) continue;
		if (baseTopLevelValues && !Bun.deepEquals(currentTopLevelValues[key], baseTopLevelValues[key])) {
			continue;
		}
		const value = topLevelValues[key];
		if (value === undefined) root.delete(key);
		else root.set(key, value);
	}

	if (!baseline) {
		if (doc.advisors.length === 0) {
			root.delete("advisors");
		} else {
			let existingNode = materializeYamlAlias(document, ["advisors"]);
			if (!isSeq(existingNode)) existingNode = document.createNode([]);
			if (!isSeq(existingNode)) throw new Error("WATCHDOG.yml advisors must be a sequence");
			const existingSequence = existingNode as YAMLSeq<unknown>;
			const occurrences = new Map<string, number>();
			const items: unknown[] = [];
			for (const advisor of doc.advisors) {
				const occurrence = occurrences.get(advisor.name) ?? 0;
				occurrences.set(advisor.name, occurrence + 1);
				const existing = findWatchdogAdvisor(document, existingSequence, advisor.name, occurrence);
				if (existing) {
					patchWatchdogAdvisor(document, existing.map, advisor);
					items.push(existing.map);
				} else {
					items.push(document.createNode(watchdogAdvisorValues(advisor)));
				}
			}
			existingSequence.items = items;
			root.set("advisors", existingSequence);
		}
		return document.toString({ lineWidth: 0 });
	}

	let advisorNode = materializeYamlAlias(document, ["advisors"]);
	if (!isSeq(advisorNode)) {
		root.set("advisors", document.createNode([]));
		advisorNode = root.get("advisors");
	}
	if (!isSeq(advisorNode)) throw new Error("WATCHDOG.yml advisors must be a sequence");
	const sequence = advisorNode as YAMLSeq<unknown>;
	for (let index = 0; index < sequence.items.length; index++) {
		materializeYamlAlias(document, ["advisors", index]);
	}
	removeMalformedWatchdogAdvisors(document, sequence);

	const resolvedOrigins = baseline.origins.map(origin => ({
		origin,
		existing: resolveWatchdogAdvisorOrigin(document, sequence, origin, baseline.origins),
	}));
	const matches = new Map<AdvisorConfig, (typeof resolvedOrigins)[number]>();
	const claimedOrigins = new Set<WatchdogAdvisorOrigin>();

	// Preserve object identity when the editor mutates the loaded doc in place.
	for (const advisor of doc.advisors) {
		const resolved = resolvedOrigins.find(candidate => candidate.origin.advisor === advisor);
		if (!resolved) continue;
		matches.set(advisor, resolved);
		claimedOrigins.add(resolved.origin);
	}
	// Editors may clone rows. Match those copies by stable name/occurrence order,
	// then by unchanged position for a renamed clone.
	for (const [index, advisor] of doc.advisors.entries()) {
		if (matches.has(advisor)) continue;
		const resolved =
			resolvedOrigins.find(
				candidate =>
					!claimedOrigins.has(candidate.origin) &&
					advisor.id !== undefined &&
					candidate.origin.base.id === advisor.id,
			) ??
			resolvedOrigins.find(
				candidate =>
					!claimedOrigins.has(candidate.origin) &&
					candidate.origin.base.id === undefined &&
					candidate.origin.name === advisor.name,
			) ??
			(() => {
				const positional = resolvedOrigins[index];
				return positional && positional.origin.base.id === undefined && !claimedOrigins.has(positional.origin)
					? positional
					: undefined;
			})();
		if (!resolved) continue;
		matches.set(advisor, resolved);
		claimedOrigins.add(resolved.origin);
	}

	const advisorsToAppend: AdvisorConfig[] = [];
	for (const advisor of doc.advisors) {
		const resolved = matches.get(advisor);
		if (!resolved) {
			advisorsToAppend.push(advisor);
			continue;
		}
		if (!resolved.existing) continue;
		patchWatchdogAdvisor(document, resolved.existing.map, advisor, resolved.origin.base);
	}

	const removals = resolvedOrigins
		.filter(
			resolved =>
				!claimedOrigins.has(resolved.origin) &&
				resolved.existing &&
				watchdogAdvisorOriginUnchanged(document, resolved.existing.map, resolved.origin),
		)
		.map(resolved => resolved.existing!)
		.sort((left, right) => right.index - left.index);
	for (const removal of removals) sequence.delete(removal.index);
	for (const advisor of advisorsToAppend) {
		sequence.add(document.createNode(watchdogAdvisorValues(advisor)));
	}
	if (sequence.items.length === 0) root.delete("advisors");
	return document.toString({ lineWidth: 0 });
}

function ensureAdvisorIds(doc: WatchdogConfigDoc): void {
	const used = new Set<string>();
	for (const advisor of doc.advisors) {
		if (!advisor.id || used.has(advisor.id)) advisor.id = crypto.randomUUID();
		used.add(advisor.id);
	}
}

/**
 * Write an editable doc under the file lock. Known fields are patched into the
 * latest document so comments, future fields, and disjoint edits survive. The
 * file is removed only when the resulting document is empty.
 */
export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const storedBaseline = watchdogBaselines.get(doc);
	const baseline = storedBaseline?.filePath === filePath ? storedBaseline : undefined;
	ensureAdvisorIds(doc);
	await withFileLock(filePath, async () => {
		let source = "";
		try {
			source = await fs.readFile(filePath, "utf8");
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		let content: string;
		try {
			content = patchWatchdogDocument(source, doc, baseline);
		} catch (error) {
			if (!watchdogRepairDocs.has(doc)) throw error;
			content = serializeWatchdogConfig(doc);
		}
		const root = yamlDocumentRoot(parseYamlMappingDocument(content));
		const wroteFile = root.items.length > 0;
		if (wroteFile) {
			await writeFileAtomically(filePath, content);
		} else {
			await fs.rm(filePath, { force: true });
		}
		watchdogRepairDocs.delete(doc);
		rememberWatchdogBaseline(doc, filePath, wroteFile, content);
	});
}
