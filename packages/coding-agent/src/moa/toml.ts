/**
 * Schema-specific `MIXTURES.toml` emitter. Bun parses TOML but has no
 * serializer, so this writes exactly the document shapes `config.ts` reads,
 * mapping the camelCase types back to snake_case keys. Comments in a
 * hand-edited file are not preserved by a save.
 */
import type {
	MixtureDefinition,
	MixtureEdge,
	MixtureLimits,
	MixtureMember,
	MixturesConfigDoc,
	TransitSpec,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { isFanoutEdge } from "@oh-my-pi/pi-tui/overlays/mixture-types";

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
// Characters a multi-line basic string must escape: backslash, quote, and control characters except newline and tab.
const MULTILINE_ESCAPE = /[\\"\u0000-\u0008\u000b-\u001f\u007f]/g;

function tomlKey(key: string): string {
	return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function escapeMultiline(char: string): string {
	if (char === "\\") return "\\\\";
	if (char === '"') return '\\"';
	if (char === "\r") return "\\r";
	return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * A basic string (JSON escapes are valid TOML escapes), or a multi-line basic
 * string for text with newlines so prompts stay hand-editable. Every quote is
 * escaped, so no run of three can close the string early. Bun's parser keeps a
 * newline right after the opening delimiter (the TOML spec trims it), so none
 * is inserted: the text round-trips through `Bun.TOML.parse` byte for byte.
 */
function tomlString(value: string): string {
	if (!value.includes("\n")) return JSON.stringify(value);
	return `"""${value.replace(MULTILINE_ESCAPE, escapeMultiline)}"""`;
}

function tomlNumber(value: number): string {
	return String(value);
}

function tomlStringArray(values: readonly string[]): string {
	return `[${values.map(tomlString).join(", ")}]`;
}

function inlineTable(entries: [string, string][]): string {
	if (entries.length === 0) return "{}";
	return `{ ${entries.map(([key, value]) => `${tomlKey(key)} = ${value}`).join(", ")} }`;
}

function transitInline(x: TransitSpec): string {
	const entries: [string, string][] = [];
	if (x.output) entries.push(["output", "true"]);
	if (x.input) entries.push(["input", "true"]);
	if (x.reasoning) entries.push(["reasoning", "true"]);
	if (x.toolTrace) entries.push(["tool_trace", "true"]);
	if (x.transcript === true) {
		entries.push(["transcript", "true"]);
	} else if (x.transcript) {
		const transcript: [string, string][] = [];
		if (x.transcript.optimize) transcript.push(["optimize", tomlString(x.transcript.optimize)]);
		if (x.transcript.budgetTokens !== undefined)
			transcript.push(["budget_tokens", tomlNumber(x.transcript.budgetTokens)]);
		entries.push(["transcript", transcript.length === 0 ? "true" : inlineTable(transcript)]);
	}
	return inlineTable(entries);
}

function pushPresets(lines: string[], header: string, presets: Record<string, string> | undefined): void {
	if (!presets) return;
	const names = Object.keys(presets);
	if (names.length === 0) return;
	lines.push("", `[${header}]`);
	for (const name of names) lines.push(`${tomlKey(name)} = ${tomlString(presets[name]!)}`);
}

function pushLimits(lines: string[], limits: MixtureLimits | undefined): void {
	if (!limits) return;
	const body: string[] = [];
	if (limits.maxHops !== undefined) body.push(`max_hops = ${tomlNumber(limits.maxHops)}`);
	if (limits.budgetUsd !== undefined) body.push(`budget_usd = ${tomlNumber(limits.budgetUsd)}`);
	if (limits.wallClockMinutes !== undefined) body.push(`wall_clock_minutes = ${tomlNumber(limits.wallClockMinutes)}`);
	if (limits.onLimit) body.push(`on_limit = ${tomlString(limits.onLimit)}`);
	if (limits.limitTarget) body.push(`limit_target = ${tomlString(limits.limitTarget)}`);
	if (body.length === 0) return;
	lines.push("", "[mixtures.limits]", ...body);
}

function pushMember(lines: string[], member: MixtureMember): void {
	lines.push("", "[[mixtures.members]]", `id = ${tomlString(member.id)}`);
	if (member.description !== undefined) lines.push(`description = ${tomlString(member.description)}`);
	if (member.show) lines.push(`show = ${tomlString(member.show)}`);
	if (member.kind === "verdict") {
		lines.push(`kind = "verdict"`);
		if (member.state) lines.push(`state = ${tomlStringArray(member.state.map(snakePart))}`);
		if (member.render !== undefined) lines.push(`render = ${tomlString(member.render)}`);
		const question = member.question;
		lines.push("[mixtures.members.question]", `type = ${tomlString(question.type)}`);
		lines.push(`instructions = ${tomlString(question.instructions)}`);
		if (question.type === "choice") {
			// TOML has no null: an empty rubric means "the option name suffices".
			const criteria = Object.entries(question.criteria).map(
				([label, rubric]): [string, string] => [label, tomlString(rubric ?? "")],
			);
			lines.push(`criteria = ${inlineTable(criteria)}`);
		} else if (question.type === "score") {
			lines.push(`criteria = ${tomlStringArray(question.criteria)}`);
		} else if (question.criteria) {
			lines.push(`criteria = ${conditionCriteria(question.criteria)}`);
		}
		return;
	}
	lines.push(`model = ${tomlString(member.model)}`);
	if (member.role !== undefined) lines.push(`role = ${tomlString(member.role)}`);
	if (member.systemPrompt !== undefined) lines.push(`system_prompt = ${tomlString(member.systemPrompt)}`);
	if (member.inherit !== undefined) lines.push(`inherit = ${member.inherit}`);
	if (member.tools !== undefined)
		lines.push(`tools = ${typeof member.tools === "boolean" ? member.tools : tomlStringArray(member.tools)}`);
	if (member.maxTokens !== undefined) lines.push(`max_tokens = ${tomlNumber(member.maxTokens)}`);
	if (member.route) {
		lines.push("[mixtures.members.route]", `instructions = ${tomlString(member.route.instructions)}`);
		if (member.route.state) lines.push(`state = ${tomlStringArray(member.route.state.map(snakePart))}`);
		if (member.route.minConfidence !== undefined)
			lines.push(`min_confidence = ${tomlNumber(member.route.minConfidence)}`);
		if (member.route.fallback !== undefined) lines.push(`fallback = ${tomlString(member.route.fallback)}`);
	}
	if (member.terminate) {
		lines.push("[mixtures.members.terminate]", `instructions = ${tomlString(member.terminate.instructions)}`);
		if (member.terminate.criteria) lines.push(`criteria = ${conditionCriteria(member.terminate.criteria)}`);
		if (member.terminate.state) lines.push(`state = ${tomlStringArray(member.terminate.state.map(snakePart))}`);
		if (member.terminate.threshold !== undefined)
			lines.push(`threshold = ${tomlNumber(member.terminate.threshold)}`);
	}
}

function conditionCriteria(criteria: { true?: string; false?: string }): string {
	const entries: [string, string][] = [];
	if (criteria.true !== undefined) entries.push(["true", tomlString(criteria.true)]);
	if (criteria.false !== undefined) entries.push(["false", tomlString(criteria.false)]);
	return inlineTable(entries);
}

function snakePart(part: string): string {
	return part === "toolTrace" ? "tool_trace" : part;
}

function pushEdge(lines: string[], edge: MixtureEdge): void {
	lines.push("", "[[mixtures.edges]]");
	if (edge.id !== undefined) lines.push(`id = ${tomlString(edge.id)}`);
	lines.push(`from = ${tomlString(edge.from)}`);
	lines.push(`to = ${isFanoutEdge(edge) ? tomlStringArray(edge.to) : tomlString(edge.to)}`);
	lines.push(`x = ${transitInline(edge.x)}`);
	if (edge.envelope !== undefined) lines.push(`envelope = ${tomlString(edge.envelope)}`);
	if (edge.when !== undefined) lines.push(`when = ${tomlString(edge.when)}`);
	if (edge.show) lines.push(`show = ${tomlString(edge.show)}`);
	if (edge.maxTraversals !== undefined) lines.push(`max_traversals = ${tomlNumber(edge.maxTraversals)}`);
	if (!isFanoutEdge(edge)) return;
	if (edge.slices !== undefined)
		lines.push(`slices = ${Array.isArray(edge.slices) ? tomlStringArray(edge.slices) : tomlString(edge.slices)}`);
	lines.push(`join = ${tomlString(edge.join)}`);
	if (edge.joinX) lines.push(`join_x = ${transitInline(edge.joinX)}`);
	if (edge.joinEnvelope !== undefined) lines.push(`join_envelope = ${tomlString(edge.joinEnvelope)}`);
	if (edge.quorum !== undefined) lines.push(`quorum = ${tomlNumber(edge.quorum)}`);
	if (edge.graceMs !== undefined) lines.push(`grace_ms = ${tomlNumber(edge.graceMs)}`);
	if (edge.anonymize !== undefined) lines.push(`anonymize = ${edge.anonymize}`);
}

function pushMixture(lines: string[], mixture: MixtureDefinition): void {
	lines.push("", "[[mixtures]]", `name = ${tomlString(mixture.name)}`);
	if (mixture.description !== undefined) lines.push(`description = ${tomlString(mixture.description)}`);
	lines.push(`entry = ${tomlString(mixture.entry)}`);
	if (mixture.serve !== undefined) lines.push(`serve = ${mixture.serve}`);
	pushLimits(lines, mixture.limits);
	if (mixture.steering) lines.push("", "[mixtures.steering]", `target = ${tomlString(mixture.steering.target)}`);
	pushPresets(lines, "mixtures.envelopes", mixture.envelopes);
	pushPresets(lines, "mixtures.roles", mixture.roles);
	for (const member of mixture.members) pushMember(lines, member);
	for (const edge of mixture.edges) pushEdge(lines, edge);
}

/** Serialize a doc to canonical, hand-editable `MIXTURES.toml`; `""` for an empty doc. */
export function serializeMixturesConfig(doc: MixturesConfigDoc): string {
	const lines: string[] = [];
	pushPresets(lines, "envelopes", doc.envelopes);
	pushPresets(lines, "roles", doc.roles);
	for (const mixture of doc.mixtures) pushMixture(lines, mixture);
	if (lines.length === 0) return "";
	// Drop the leading blank separator.
	while (lines[0] === "") lines.shift();
	return `${lines.join("\n")}\n`;
}
