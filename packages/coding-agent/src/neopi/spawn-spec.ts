import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { parseCompactionPointInput } from "../config/compaction-threshold";
import { parseSelectorSuffix } from "../config/model-selector-suffix";

export function parseSpawnContextCap(text: string): number {
	try {
		const tokens = parseCompactionPointInput(text);
		if (typeof tokens === "number") return tokens;
	} catch {
		// Report the narrower syntax this surface actually accepts.
	}
	throw new Error(`Invalid context cap "${text}": use a positive token count, e.g. 100000 or 100k.`);
}

interface CappedSelector {
	selector: string;
	context?: number;
}

/** `[...]` can sit before the effort suffix, as in `@smol[200k]:low`. */
export function parseCappedSpawnSelector(value: string): CappedSelector {
	if (!/[[\]]/.test(value)) return { selector: value };
	const match = /^([^[\]]+)\[([^[\]]*)\](:[^[\]:]+)?$/.exec(value);
	if (!match) throw new Error(`Invalid context cap in "${value}": use [100k] before the effort suffix.`);
	return { selector: match[1] + (match[3] ?? ""), context: parseSpawnContextCap(match[2]) };
}

export interface SpawnSpec {
	type: string;
	model?: string;
	effort?: ConfiguredThinkingLevel;
	context?: number;
	prewalk?: string;
	advisor?: string;
}

/** After an optional `agent` prefix, only the first word is parsed as a spec. */
export function parseSpawnArguments(input: string): { spec: string; assignment: string } | undefined {
	const text = input.trimStart().replace(/^agent\s+(?=\S)/, "");
	if (!text) return;
	const space = text.search(/\s/);
	return space < 0
		? { spec: text, assignment: "" }
		: { spec: text.slice(0, space), assignment: text.slice(space).trimStart() };
}

export function parseSpawnSpec(spec: string): SpawnSpec {
	if (/\s/.test(spec)) throw new Error("The /spawn agent spec must be a single word.");
	const [head, ...options] = spec.split(";");
	const { selector, context } = parseCappedSpawnSelector(head);
	const match = /^@?([\w.-]+)(.*)$/.exec(selector);
	if (!match) throw new Error("Expected an agent type in the /spawn spec.");
	const [, type, rest] = match;
	const result: SpawnSpec = { type, context };
	if (rest.startsWith("@") && rest.length > 1) {
		const model = rest.slice(1);
		result.model = model.includes("/") || model.startsWith("@") ? model : `@${model}`;
	} else if (rest) {
		const suffix = rest.startsWith(":") ? parseSelectorSuffix(type + rest) : undefined;
		if (!suffix || suffix.base !== type) throw new Error(`Invalid agent type or effort in "${head}".`);
		result.effort = suffix.level;
	}
	for (const option of options) {
		const equals = option.indexOf("=");
		const key = option.slice(0, equals);
		const value = option.slice(equals + 1);
		if (equals < 1 || !value || (key !== "pre" && key !== "advisor")) {
			throw new Error(`Invalid spawn modifier "${option}": use pre=<selector> or advisor=<selector>.`);
		}
		const field = key === "pre" ? "prewalk" : "advisor";
		if (result[field] !== undefined) throw new Error(`Duplicate spawn modifier "${key}".`);
		result[field] = value;
	}
	return result;
}
