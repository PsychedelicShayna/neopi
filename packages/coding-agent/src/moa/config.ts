/**
 * `MIXTURES.toml` discovery, loading, and saving. Mixtures live beside
 * `CHAINS.yml` and `WATCHDOG.yml` on the same search path: the user agent dir,
 * then every directory from `cwd` up to the repository root (both
 * `<dir>/MIXTURES.toml` and `<dir>/.omp/MIXTURES.toml`). Later documents
 * shadow earlier ones by mixture name. Parsing never throws: malformed entries
 * become warnings and are skipped. Validation is not done here; it runs at
 * registration and at save (`validate.ts`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from "@oh-my-pi/pi-ai/judgment";
import type {
	MixtureConfigScope,
	MixtureDefinition,
	FanoutEdge,
	MixtureEdge,
	MixtureLimits,
	MixtureMember,
	MixtureShow,
	MixturesConfigDoc,
	RouteCondition,
	TerminateCondition,
	TransitPartName,
	TransitSpec,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import {
	type BoundedText,
	collectConfigCandidates,
	type ConfigRejection,
	configCandidatePaths,
	readBoundedText,
} from "../advisor/watchdog";
import { serializeMixturesConfig } from "./toml";
import { MAX_FILE_BYTES, prepareDocumentPresets, type PreparedDocumentPresets } from "./validate";

export const MIXTURES_FILE_NAME = "MIXTURES.toml";

const SHOW_VALUES = new Set<string>(["always", "never", "final"]);

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown, where: string, key: string, warnings: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	warnings.push(`${where}: ${key} must be a number — ignored`);
	return undefined;
}

function camelPart(part: string): string {
	return part === "tool_trace" ? "toolTrace" : part;
}

function parsePresets(value: unknown, where: string, warnings: string[]): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		warnings.push(`${where}: expected a table of strings — ignored`);
		return undefined;
	}
	const presets: Record<string, string> = {};
	for (const [name, text] of Object.entries(value)) {
		if (typeof text !== "string") {
			warnings.push(`${where}.${name}: expected a string — preset dropped`);
			continue;
		}
		presets[name] = text;
	}
	return Object.keys(presets).length > 0 ? presets : undefined;
}

function parseConditionState(
	value: unknown,
	where: string,
	warnings: string[],
): ("output" | "input" | "toolTrace")[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		warnings.push(`${where}: state must be a list — ignored`);
		return undefined;
	}
	const parts: ("output" | "input" | "toolTrace")[] = [];
	for (const item of value) {
		const part = typeof item === "string" ? camelPart(item) : "";
		if (part === "output" || part === "input" || part === "toolTrace") parts.push(part);
		else warnings.push(`${where}: unknown state part ${JSON.stringify(item)} — dropped`);
	}
	return parts;
}

function parseCriteria(value: unknown): { true?: string; false?: string } | undefined {
	if (!isRecord(value)) return undefined;
	const criteria: { true?: string; false?: string } = {};
	if (typeof value.true === "string") criteria.true = value.true;
	if (typeof value.false === "string") criteria.false = value.false;
	return criteria;
}

function parseRoute(value: unknown, where: string, warnings: string[]): RouteCondition | undefined {
	if (value === undefined) return undefined;
	const instructions = isRecord(value) ? stringField(value.instructions) : undefined;
	if (!isRecord(value) || !instructions) {
		warnings.push(`${where}: route needs instructions — ignored`);
		return undefined;
	}
	const route: RouteCondition = { instructions };
	const state = parseConditionState(value.state, where, warnings);
	if (state) route.state = state;
	const minConfidence = numberField(value.min_confidence, where, "min_confidence", warnings);
	if (minConfidence !== undefined) route.minConfidence = minConfidence;
	const fallback = stringField(value.fallback);
	if (fallback) route.fallback = fallback;
	return route;
}

function parseTerminate(value: unknown, where: string, warnings: string[]): TerminateCondition | undefined {
	if (value === undefined) return undefined;
	const instructions = isRecord(value) ? stringField(value.instructions) : undefined;
	if (!isRecord(value) || !instructions) {
		warnings.push(`${where}: terminate needs instructions — ignored`);
		return undefined;
	}
	const terminate: TerminateCondition = { instructions };
	const criteria = parseCriteria(value.criteria);
	if (criteria) terminate.criteria = criteria;
	const state = parseConditionState(value.state, where, warnings);
	if (state) terminate.state = state;
	const threshold = numberField(value.threshold, where, "threshold", warnings);
	if (threshold !== undefined) terminate.threshold = threshold;
	return terminate;
}

function parseQuestion(
	value: unknown,
	where: string,
	warnings: string[],
): ChoiceQuestion | NoulQuestion | ScoreQuestion | undefined {
	const instructions = isRecord(value) ? stringField(value.instructions) : undefined;
	if (!isRecord(value) || !instructions) {
		warnings.push(`${where}: a verdict member needs a question with instructions — member dropped`);
		return undefined;
	}
	if (value.type === "noul") {
		const criteria = parseCriteria(value.criteria);
		return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
	}
	if (value.type === "choice") {
		const criteria: Record<string, string | null> = {};
		if (isRecord(value.criteria)) {
			for (const [label, rubric] of Object.entries(value.criteria)) {
				criteria[label] = typeof rubric === "string" && rubric.trim() ? rubric : null;
			}
		}
		return { type: "choice", instructions, criteria };
	}
	if (value.type === "score") {
		const levels = Array.isArray(value.criteria)
			? value.criteria.filter((level): level is string => typeof level === "string")
			: [];
		// Fewer than two levels is a validation error (E18), not a parse failure: keep what was written.
		const [first = "", second = "", ...rest] = levels;
		return { type: "score", instructions, criteria: [first, second, ...rest] };
	}
	warnings.push(`${where}: question type must be choice, noul, or score — member dropped`);
	return undefined;
}

function parseMember(raw: unknown, where: string, warnings: string[]): MixtureMember | undefined {
	if (!isRecord(raw)) {
		warnings.push(`${where}: expected a table — member dropped`);
		return undefined;
	}
	const id = stringField(raw.id)?.trim();
	if (!id) {
		warnings.push(`${where}: a member needs an id — member dropped`);
		return undefined;
	}
	const at = `${where} (${id})`;
	let show: MixtureShow | undefined;
	if (raw.show !== undefined) {
		if (typeof raw.show === "string" && SHOW_VALUES.has(raw.show)) show = raw.show as MixtureShow;
		else warnings.push(`${at}: show must be always, never, or final — ignored`);
	}
	const description = stringField(raw.description);
	if (raw.kind === "verdict") {
		const question = parseQuestion(raw.question, at, warnings);
		if (!question) return undefined;
		const member: MixtureMember = { kind: "verdict", id, question };
		if (description) member.description = description;
		if (show) member.show = show;
		if (raw.state !== undefined) {
			const state = Array.isArray(raw.state)
				? raw.state.map(item => (typeof item === "string" ? camelPart(item) : "")).filter(isTransitPartName)
				: [];
			member.state = state;
		}
		const render = stringField(raw.render);
		if (render) member.render = render;
		return member;
	}
	if (raw.kind !== undefined && raw.kind !== "model") {
		warnings.push(`${at}: kind must be model or verdict — member dropped`);
		return undefined;
	}
	const model = stringField(raw.model)?.trim();
	if (!model) {
		warnings.push(`${at}: a model member needs a model — member dropped`);
		return undefined;
	}
	const member: MixtureMember = { id, model };
	if (description) member.description = description;
	if (show) member.show = show;
	const role = stringField(raw.role)?.trim();
	if (role) member.role = role;
	if (typeof raw.system_prompt === "string") member.systemPrompt = raw.system_prompt;
	if (typeof raw.inherit === "boolean") member.inherit = raw.inherit;
	if (typeof raw.tools === "boolean") {
		member.tools = raw.tools;
	} else if (Array.isArray(raw.tools)) {
		member.tools = raw.tools.filter((name): name is string => typeof name === "string" && name.trim() !== "");
	} else if (raw.tools !== undefined) {
		warnings.push(`${at}: tools must be true, false, or a list of names — ignored`);
	}
	const maxTokens = numberField(raw.max_tokens, at, "max_tokens", warnings);
	if (maxTokens !== undefined) {
		if (Number.isInteger(maxTokens) && maxTokens > 0) member.maxTokens = maxTokens;
		else warnings.push(`${at}: max_tokens must be a positive integer — ignored`);
	}
	const route = parseRoute(raw.route, at, warnings);
	if (route) member.route = route;
	const terminate = parseTerminate(raw.terminate, at, warnings);
	if (terminate) member.terminate = terminate;
	return member;
}

function isTransitPartName(value: string): value is TransitPartName {
	return (
		value === "output" ||
		value === "input" ||
		value === "reasoning" ||
		value === "toolTrace" ||
		value === "transcript"
	);
}

/**
 * Parse an `x` table. Known parts map to camelCase; unknown keys are kept verbatim
 * so validation can report them (`edge.x.unknown_part`) instead of losing them.
 */
function parseTransit(value: unknown, where: string, warnings: string[]): TransitSpec {
	const x: TransitSpec & Record<string, unknown> = {};
	if (value === undefined) return x;
	if (!isRecord(value)) {
		warnings.push(`${where}: x must be a table — treated as empty`);
		return x;
	}
	for (const [key, part] of Object.entries(value)) {
		const name = camelPart(key);
		if (name === "transcript") {
			if (part === true) {
				x.transcript = true;
			} else if (isRecord(part)) {
				const transcript: { optimize?: "verbatim" | "compact" | "snapcompact"; budgetTokens?: number } = {};
				if (part.optimize === "verbatim" || part.optimize === "compact" || part.optimize === "snapcompact") {
					transcript.optimize = part.optimize;
				} else if (part.optimize !== undefined) {
					warnings.push(`${where}: transcript.optimize must be verbatim, compact, or snapcompact — ignored`);
				}
				const budget = numberField(part.budget_tokens, where, "transcript.budget_tokens", warnings);
				if (budget !== undefined) transcript.budgetTokens = budget;
				x.transcript = transcript;
			}
			continue;
		}
		if (name === "output" || name === "input" || name === "reasoning" || name === "toolTrace") {
			if (part === true) x[name] = true;
			continue;
		}
		x[key] = part;
	}
	return x;
}

function parseEdge(raw: unknown, where: string, warnings: string[]): MixtureEdge | undefined {
	if (!isRecord(raw)) {
		warnings.push(`${where}: expected a table — edge dropped`);
		return undefined;
	}
	const from = stringField(raw.from)?.trim();
	const to =
		typeof raw.to === "string"
			? raw.to.trim()
			: Array.isArray(raw.to)
				? raw.to.filter((id): id is string => typeof id === "string").map(id => id.trim())
				: undefined;
	if (!from || !to || to.length === 0) {
		warnings.push(`${where}: an edge needs from and to — edge dropped`);
		return undefined;
	}
	const x = parseTransit(raw.x, where, warnings);
	const id = stringField(raw.id)?.trim();
	const edge: MixtureEdge =
		typeof to === "string"
			? { from, to, x }
			: parseFanout(raw, { from, to, x, join: stringField(raw.join)?.trim() ?? "" }, where, warnings);
	if (id) edge.id = id;
	if (typeof raw.envelope === "string" && raw.envelope.trim()) edge.envelope = raw.envelope;
	const when = stringField(raw.when);
	if (when) edge.when = when;
	if (raw.show === "always" || raw.show === "never") edge.show = raw.show;
	else if (raw.show !== undefined) warnings.push(`${where}: show must be always or never — ignored`);
	const maxTraversals = numberField(raw.max_traversals, where, "max_traversals", warnings);
	if (maxTraversals !== undefined) edge.maxTraversals = maxTraversals;
	return edge;
}

function parseFanout(raw: Record<string, unknown>, fanout: FanoutEdge, where: string, warnings: string[]): FanoutEdge {
	if (raw.slices === "same" || raw.slices === "auto") {
		fanout.slices = raw.slices;
	} else if (Array.isArray(raw.slices)) {
		fanout.slices = raw.slices.filter((slice): slice is string => typeof slice === "string");
	}
	if (raw.join_x !== undefined) fanout.joinX = parseTransit(raw.join_x, where, warnings);
	if (typeof raw.join_envelope === "string") fanout.joinEnvelope = raw.join_envelope;
	const quorum = numberField(raw.quorum, where, "quorum", warnings);
	if (quorum !== undefined) fanout.quorum = quorum;
	const graceMs = numberField(raw.grace_ms, where, "grace_ms", warnings);
	if (graceMs !== undefined) fanout.graceMs = graceMs;
	if (typeof raw.anonymize === "boolean") fanout.anonymize = raw.anonymize;
	return fanout;
}

function parseLimits(value: unknown, where: string, warnings: string[]): MixtureLimits | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		warnings.push(`${where}: limits must be a table — ignored`);
		return undefined;
	}
	const limits: MixtureLimits = {};
	const maxHops = numberField(value.max_hops, where, "limits.max_hops", warnings);
	if (maxHops !== undefined) limits.maxHops = maxHops;
	const budgetUsd = numberField(value.budget_usd, where, "limits.budget_usd", warnings);
	if (budgetUsd !== undefined) limits.budgetUsd = budgetUsd;
	const wallClock = numberField(value.wall_clock_minutes, where, "limits.wall_clock_minutes", warnings);
	if (wallClock !== undefined) limits.wallClockMinutes = wallClock;
	if (value.on_limit === "stop" || value.on_limit === "pause" || value.on_limit === "judge") {
		limits.onLimit = value.on_limit;
	} else if (value.on_limit !== undefined) {
		warnings.push(`${where}: limits.on_limit must be stop, pause, or judge — ignored`);
	}
	const target = stringField(value.limit_target)?.trim();
	if (target) limits.limitTarget = target;
	return limits;
}

function parseMixture(raw: unknown, where: string, warnings: string[]): MixtureDefinition | undefined {
	if (!isRecord(raw)) {
		warnings.push(`${where}: expected a table — mixture dropped`);
		return undefined;
	}
	const name = stringField(raw.name)?.trim();
	if (!name) {
		warnings.push(`${where}: a mixture needs a name — mixture dropped`);
		return undefined;
	}
	const at = `${where} (${name})`;
	const members = (Array.isArray(raw.members) ? raw.members : [])
		.map((member, index) => parseMember(member, `${at}.members[${index}]`, warnings))
		.filter((member): member is MixtureMember => member !== undefined);
	const edges = (Array.isArray(raw.edges) ? raw.edges : [])
		.map((edge, index) => parseEdge(edge, `${at}.edges[${index}]`, warnings))
		.filter((edge): edge is MixtureEdge => edge !== undefined);
	// A missing entry is kept empty so validation names it (entry.unresolved) rather than hiding the mixture.
	const mixture: MixtureDefinition = { name, entry: stringField(raw.entry)?.trim() ?? "", members, edges };
	const description = stringField(raw.description);
	if (description) mixture.description = description;
	if (typeof raw.serve === "boolean") mixture.serve = raw.serve;
	const limits = parseLimits(raw.limits, at, warnings);
	if (limits) mixture.limits = limits;
	if (raw.steering !== undefined) {
		const target = isRecord(raw.steering) ? stringField(raw.steering.target)?.trim() : undefined;
		if (target) mixture.steering = { target };
		else warnings.push(`${at}: steering needs a target — ignored`);
	}
	const envelopes = parsePresets(raw.envelopes, `${at}.envelopes`, warnings);
	if (envelopes) mixture.envelopes = envelopes;
	const roles = parsePresets(raw.roles, `${at}.roles`, warnings);
	if (roles) mixture.roles = roles;
	return mixture;
}

/** Validate one parsed `MIXTURES.toml` table entry by entry, keeping every well-formed mixture. */
export function parseMixturesDoc(raw: unknown, filePath: string): MixturesConfigDoc {
	const warnings: string[] = [];
	if (!isRecord(raw)) return { mixtures: [], warnings: [`${filePath}: expected a TOML table — file skipped`] };
	const doc: MixturesConfigDoc = { mixtures: [] };
	const envelopes = parsePresets(raw.envelopes, `${filePath}: envelopes`, warnings);
	if (envelopes) doc.envelopes = envelopes;
	const roles = parsePresets(raw.roles, `${filePath}: roles`, warnings);
	if (roles) doc.roles = roles;
	const rawMixtures = raw.mixtures ?? [];
	if (!Array.isArray(rawMixtures)) {
		warnings.push(`${filePath}: mixtures must be an array of tables — ignored`);
	} else {
		rawMixtures.forEach((entry, index) => {
			const mixture = parseMixture(entry, `${filePath}: mixtures[${index}]`, warnings);
			if (mixture) doc.mixtures.push(mixture);
		});
	}
	if (warnings.length > 0) doc.warnings = warnings;
	return doc;
}

/** A candidate skipped unread: over `MAX_FILE_BYTES`, or not a regular file at all. */
function rejectionWarning(filePath: string, rejection: ConfigRejection): string {
	return rejection.kind === "too_large"
		? `${filePath}: file.too_large (${rejection.bytes} bytes; the cap is ${MAX_FILE_BYTES}) — file skipped`
		: `${filePath}: file.not_regular (not a regular file) — file skipped`;
}

function parseMixturesText(text: string, filePath: string): MixturesConfigDoc {
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch (err) {
		return { mixtures: [], warnings: [`${filePath}: failed to parse TOML (${String(err)})`] };
	}
	return parseMixturesDoc(parsed, filePath);
}

/** A discovered mixture with the document presets it may reference. */
export interface DiscoveredMixture {
	definition: MixtureDefinition;
	/** Document-level envelope presets of the file that declared it. */
	envelopes: Readonly<Record<string, string>>;
	/** Document-level role presets of the file that declared it. */
	roles: Readonly<Record<string, string>>;
	/** Snapshot shared by all mixtures in this parsed document. */
	preparedPresets: PreparedDocumentPresets;
	/** The file that declared it. */
	path: string;
}

export interface DiscoveredMixtures {
	/**
	 * Merged roster, later files shadowing earlier ones by name, in declaration order.
	 * A name declared twice in one file keeps both declarations, so validation refuses it.
	 */
	mixtures: DiscoveredMixture[];
	warnings: string[];
}

/**
 * The workspace scope a roster belongs to: every `MIXTURES.toml` path the search
 * path probes for (cwd, agentDir), readable or not, in order. Two sessions share a
 * roster only when they would discover from the same files.
 */
export function mixtureScopeKey(cwd: string, agentDir?: string): string {
	return JSON.stringify(configCandidatePaths(cwd, agentDir, [MIXTURES_FILE_NAME]).candidates);
}

/** Discover mixtures from every `MIXTURES.toml` on the user + project search path. */
export async function discoverMixtures(cwd: string, agentDir?: string): Promise<DiscoveredMixtures> {
	const warnings: string[] = [];
	// Bounded before anything reads it: every session discovers these files at startup.
	const items = await collectConfigCandidates(cwd, agentDir, [MIXTURES_FILE_NAME], {
		maxBytes: MAX_FILE_BYTES,
		onRejected: (filePath, rejection) => {
			const message = rejectionWarning(filePath, rejection);
			warnings.push(message);
			logger.warn("Mixture config", { path: filePath, error: message });
		},
	});
	const mixtures = new Map<string, DiscoveredMixture[]>();
	// Candidates arrive user first, then project ancestor→leaf, so later files shadow earlier ones.
	for (const item of items) {
		const doc = parseMixturesText(item.content, item.path);
		const preparedPresets = prepareDocumentPresets(doc.envelopes, doc.roles);
		for (const message of doc.warnings ?? []) {
			warnings.push(message);
			logger.warn("Mixture config", { path: item.path, error: message });
		}
		for (const definition of doc.mixtures) {
			const declared: DiscoveredMixture = {
				definition,
				envelopes: preparedPresets.envelopes,
				roles: preparedPresets.roles,
				preparedPresets,
				path: item.path,
			};
			const same = mixtures.get(definition.name);
			if (same?.[0]?.path === item.path) {
				same.push(declared);
				continue;
			}
			mixtures.delete(definition.name);
			mixtures.set(definition.name, [declared]);
		}
	}
	return { mixtures: [...mixtures.values()].flat(), warnings };
}

/** `project` → `<projectDir>/MIXTURES.toml`, `user` → `<agentDir>/MIXTURES.toml`. */
export function mixturesConfigFilePath(
	scope: MixtureConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, MIXTURES_FILE_NAME);
}

/** Load one `MIXTURES.toml` for editing, raw and un-merged. A missing file is an empty doc. */
export async function loadMixturesConfigFile(filePath: string): Promise<MixturesConfigDoc> {
	let read: BoundedText;
	try {
		read = await readBoundedText(filePath, MAX_FILE_BYTES);
	} catch (err) {
		if (!isEnoent(err))
			logger.warn("Mixture config: failed to read for edit", { path: filePath, error: String(err) });
		return { mixtures: [] };
	}
	if ("rejected" in read) return { mixtures: [], warnings: [rejectionWarning(filePath, read.rejected)] };
	return parseMixturesText(read.content, filePath);
}

/** Write a bounded doc; oversized output preserves the file, and an empty doc removes it. */
export async function saveMixturesConfigFile(filePath: string, doc: MixturesConfigDoc): Promise<void> {
	const content = serializeMixturesConfig(doc);
	if (!content) {
		await fs.rm(filePath, { force: true });
		return;
	}
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_FILE_BYTES) throw new Error(rejectionWarning(filePath, { kind: "too_large", bytes }));
	await Bun.write(filePath, content);
}
