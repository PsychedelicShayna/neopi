import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { isMap, isNode, isSeq, type YAMLMap, type YAMLSeq } from "yaml";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { ADVISOR_DEFAULT_BUDGET_PER_UPDATE, ADVISOR_MAX_BUDGET_PER_UPDATE } from "./emission-guard";
import { collectConfigCandidates } from "./watchdog";
import { materializeYamlAlias, parseYamlMappingDocument, yamlDocumentRoot } from "../config/yaml-document";

import type { AdvisorConfig, AdvisorConfigScope, WatchdogConfigDoc } from "@oh-my-pi/pi-tui/overlays/advisor-config";

const WATCHDOG_ADVISOR_KEYS = [
	"name",
	"model",
	"tools",
	"instructions",
	"systemPrompt",
	"enabled",
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
 * - `quota_exhausted` — provider returned a quota/rate-limit error; the
 *   runtime auto-retries after a cooldown so it can resume without user action
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
	sharedInstructions: string | undefined;
	sharedMaxNotesPerUpdate?: number;
	/**
	 * Human-readable config problems collected during the walk: unparseable
	 * files and dropped entries. Surfaced as one aggregated session warning so
	 * a broken roster entry never fails silently.
	 */
	warnings: string[];
}

const advisorEntrySchema = type({
	name: "string",
	"model?": "string",
	"tools?": "string[]",
	"instructions?": "string",
	"systemPrompt?": "string",
	"enabled?": "boolean",
	"maxNotesPerUpdate?": "number",
});

type AdvisorYamlEntry = typeof advisorEntrySchema.infer;

function editableAdvisorConfig(entry: AdvisorYamlEntry): AdvisorConfig {
	const advisor: AdvisorConfig = { name: entry.name };
	if (entry.model?.trim()) advisor.model = entry.model;
	if (entry.tools !== undefined) advisor.tools = [...entry.tools];
	if (entry.instructions?.trim()) advisor.instructions = entry.instructions;
	if (entry.systemPrompt !== undefined) advisor.systemPrompt = entry.systemPrompt;
	if (entry.enabled !== undefined) advisor.enabled = entry.enabled;
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
	instructions: string | undefined;
	entries: AdvisorYamlEntry[];
	sharedMaxNotesPerUpdate: number | undefined;
	warnings: string[];
} {
	const warnings: string[] = [];
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
	for (const [index, rawEntry] of (Array.isArray(rawAdvisors) ? rawAdvisors : []).entries()) {
		const result = advisorEntrySchema(rawEntry);
		if (result instanceof type.errors) {
			const rawName =
				rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>).name : undefined;
			const label = typeof rawName === "string" && rawName.trim() ? `"${rawName}"` : `#${index + 1}`;
			warnings.push(`${path}: advisor ${label} dropped — ${result.summary}`);
			continue;
		}
		entries.push(result);
	}
	return { instructions, entries, sharedMaxNotesPerUpdate, warnings };
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

/**
 * Normalize an advisor name into a filesystem-/id-safe slug used for its
 * transcript filename and session id: lowercase, non-alphanumerics collapsed to
 * `-`, leading/trailing `-` trimmed. Falls back to `"advisor"` when nothing
 * survives; callers dedupe collisions.
 */
export function slugifyAdvisorName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "advisor";
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
 * user + project search path as `WATCHDOG.md`. Advisors are keyed by slug; a
 * more-specific file (project leaf > project ancestor > user) replaces an earlier
 * entry with the same slug. Top-level `instructions` across all files concatenate
 * into the shared baseline. A malformed file is logged and skipped — never
 * thrown — so a bad project config can't kill the session.
 */
export async function discoverAdvisorConfigs(cwd: string, agentDir?: string): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const advisors = new Map<string, AdvisorConfig>();
	const sharedParts: string[] = [];
	let sharedMaxNotesPerUpdate: number | undefined;
	const warnings: string[] = [];
	const warn = (message: string, context?: Record<string, unknown>): void => {
		warnings.push(message);
		logger.warn("Advisor config", { ...context, error: message });
	};

	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			warn(`${item.path}: failed to parse YAML (${String(err)}) — file skipped`, { path: item.path });
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			warn(`${item.path}: expected a YAML mapping — file skipped`, { path: item.path });
			continue;
		}
		const {
			instructions,
			entries,
			sharedMaxNotesPerUpdate: docSharedMaxNotes,
			warnings: docWarnings,
		} = parseWatchdogDoc(parsed as Record<string, unknown>, item.path);
		for (const message of docWarnings) warn(message, { path: item.path });

		if (instructions?.trim()) {
			const expanded = (await expandAtImports(instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		if (docSharedMaxNotes !== undefined) sharedMaxNotesPerUpdate = docSharedMaxNotes;

		for (const entry of entries) {
			const slug = slugifyAdvisorName(entry.name);
			const entryInstructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(slug, {
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				systemPrompt: entry.systemPrompt,
				maxNotesPerUpdate:
					typeof entry.maxNotesPerUpdate === "number" &&
					Number.isFinite(entry.maxNotesPerUpdate) &&
					entry.maxNotesPerUpdate >= 1
						? Math.trunc(entry.maxNotesPerUpdate)
						: undefined,
				enabled: entry.enabled,
				instructions: entryInstructions,
			});
		}
	}

	return {
		advisors: [...advisors.values()],
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
		sharedMaxNotesPerUpdate,
		warnings,
	};
}

/**
 * Resolve the `WATCHDOG.yml` path for a scope: `project` → `<projectDir>/WATCHDOG.yml`
 * (discovered by the project-level walk), `user` → `<agentDir>/WATCHDOG.yml` (the
 * user-level candidate).
 */
export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

/**
 * Resolve which `WATCHDOG.{yml,yaml}` to edit for a scope: prefer the canonical
 * `.yml`, but when only a `.yaml` exists for that scope, edit it in place so an
 * existing `.yaml` user isn't shown a blank editor and left with two files at the
 * same precedence. Falls back to `.yml` when neither exists.
 */
export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): Promise<string> {
	const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
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
	const { instructions, entries, sharedMaxNotesPerUpdate, warnings } = parseWatchdogDoc(
		parsed as Record<string, unknown>,
		filePath,
	);
	for (const message of warnings) logger.warn("Advisor config", { path: filePath, error: message });
	const advisors = entries.map(editableAdvisorConfig);
	const doc: WatchdogConfigDoc = { advisors };
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
			lines.push(`  - name: ${YAML.stringify(advisor.name)}`);
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
			if (advisor.instructions?.trim()) {
				appendYamlString(lines, "    ", "instructions", advisor.instructions);
			}
			if (advisor.systemPrompt !== undefined) {
				appendYamlString(lines, "    ", "systemPrompt", advisor.systemPrompt);
			}
			if (advisor.enabled !== undefined) lines.push(`    enabled: ${advisor.enabled}`);
			if (
				typeof advisor.maxNotesPerUpdate === "number" &&
				Number.isFinite(advisor.maxNotesPerUpdate) &&
				advisor.maxNotesPerUpdate >= 1
			) {
				lines.push(`    maxNotesPerUpdate: ${Math.trunc(advisor.maxNotesPerUpdate)}`);
			}
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function watchdogAdvisorValues(advisor: AdvisorConfig): Record<(typeof WATCHDOG_ADVISOR_KEYS)[number], unknown> {
	return {
		name: advisor.name,
		model: advisor.model?.trim() ? advisor.model : undefined,
		tools: advisor.tools === undefined ? undefined : [...advisor.tools],
		instructions: advisor.instructions?.trim() ? advisor.instructions : undefined,
		systemPrompt: advisor.systemPrompt,
		enabled: advisor.enabled,
		maxNotesPerUpdate:
			typeof advisor.maxNotesPerUpdate === "number" &&
			Number.isFinite(advisor.maxNotesPerUpdate) &&
			advisor.maxNotesPerUpdate >= 1
				? Math.trunc(advisor.maxNotesPerUpdate)
				: undefined,
	};
}

function findWatchdogAdvisor(
	sequence: YAMLSeq<unknown>,
	name: string,
	occurrence: number,
): { index: number; map: YAMLMap<unknown, unknown> } | undefined {
	let seen = 0;
	for (const [index, item] of sequence.items.entries()) {
		if (!isMap(item) || item.get("name") !== name) continue;
		if (seen === occurrence) return { index, map: item };
		seen++;
	}
	return undefined;
}

function removeMalformedWatchdogAdvisors(sequence: YAMLSeq<unknown>): void {
	for (let index = sequence.items.length - 1; index >= 0; index--) {
		const item = sequence.items[index];
		const value: unknown = isNode(item) ? item.toJSON() : item;
		if (!(advisorEntrySchema(value) instanceof type.errors)) continue;
		sequence.delete(index);
	}
}

function resolveWatchdogAdvisorOrigin(
	sequence: YAMLSeq<unknown>,
	origin: WatchdogAdvisorOrigin,
	origins: readonly WatchdogAdvisorOrigin[],
): { index: number; map: YAMLMap<unknown, unknown> } | undefined {
	const candidates: { index: number; map: YAMLMap<unknown, unknown> }[] = [];
	for (const [index, item] of sequence.items.entries()) {
		if (isMap(item) && item.get("name") === origin.name) candidates.push({ index, map: item });
	}
	if (origin.fingerprint !== undefined) {
		const exact = candidates.filter(
			candidate => watchdogAdvisorFingerprint(candidate.map.toJSON()) === origin.fingerprint,
		);
		if (exact.length === 1) return exact[0];
		if (exact.length > 1) return undefined;
	}
	const baselineCount = origins.filter(candidate => candidate.name === origin.name).length;
	if (candidates.length !== baselineCount) return undefined;
	return candidates[origin.occurrence];
}

function patchWatchdogAdvisor(map: YAMLMap<unknown, unknown>, advisor: AdvisorConfig, base?: AdvisorConfig): void {
	const values = watchdogAdvisorValues(advisor);
	const baseValues = base ? watchdogAdvisorValues(base) : undefined;
	const parsedCurrent = advisorEntrySchema(map.toJSON());
	const currentValues =
		baseValues && !(parsedCurrent instanceof type.errors)
			? watchdogAdvisorValues(editableAdvisorConfig(parsedCurrent))
			: undefined;
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
	const document = parseYamlMappingDocument(source);
	const root = yamlDocumentRoot(document);
	const topLevelValues = {
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
				instructions: baseline.doc.instructions?.trim() ? baseline.doc.instructions : undefined,
				maxNotesPerUpdate: baseline.doc.maxNotesPerUpdate,
			}
		: undefined;
	for (const key of ["instructions", "maxNotesPerUpdate"] as const) {
		if (baseTopLevelValues && Bun.deepEquals(topLevelValues[key], baseTopLevelValues[key])) continue;
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
				const existing = findWatchdogAdvisor(existingSequence, advisor.name, occurrence);
				if (existing) {
					patchWatchdogAdvisor(existing.map, advisor);
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
	removeMalformedWatchdogAdvisors(sequence);

	const resolvedOrigins = baseline.origins.map(origin => ({
		origin,
		existing: resolveWatchdogAdvisorOrigin(sequence, origin, baseline.origins),
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
				candidate => !claimedOrigins.has(candidate.origin) && candidate.origin.name === advisor.name,
			) ??
			(() => {
				const positional = resolvedOrigins[index];
				return positional && !claimedOrigins.has(positional.origin) ? positional : undefined;
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
		patchWatchdogAdvisor(resolved.existing.map, advisor, resolved.origin.base);
	}

	const removals = resolvedOrigins
		.filter(resolved => !claimedOrigins.has(resolved.origin) && resolved.existing)
		.map(resolved => resolved.existing!)
		.sort((left, right) => right.index - left.index);
	for (const removal of removals) sequence.delete(removal.index);
	for (const advisor of advisorsToAppend) {
		sequence.add(document.createNode(watchdogAdvisorValues(advisor)));
	}
	if (sequence.items.length === 0) root.delete("advisors");
	return document.toString({ lineWidth: 0 });
}

/**
 * Write an editable doc under the file lock. Known fields are patched into the
 * latest document so comments, future fields, and disjoint edits survive. The
 * file is removed only when the resulting document is empty.
 */
export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const storedBaseline = watchdogBaselines.get(doc);
	const baseline = storedBaseline?.filePath === filePath ? storedBaseline : undefined;
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
			await Bun.write(filePath, content);
		} else {
			await fs.rm(filePath, { force: true });
		}
		watchdogRepairDocs.delete(doc);
		rememberWatchdogBaseline(doc, filePath, wroteFile, content);
	});
}
