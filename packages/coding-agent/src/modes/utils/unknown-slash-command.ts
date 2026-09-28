import { lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";

/**
 * Detects `/name` input that matches no registered command, so the TUI can warn instead of sending a
 * mistyped command to the model as prose.
 */

/** A leading `/name` or `/ns:name` token; a second `/` inside it (e.g. `/etc/hosts`) marks a path. */
const COMMAND_TOKEN = /^\/([A-Za-z][\w.-]*(?::[\w.-]+)?)(?=\s|$)/;

const MAX_SUGGESTION_DISTANCE = 2;

export interface UnknownSlashCommand {
	name: string;
	suggestion?: string;
}

/**
 * Returns the unknown command in `text`, with the closest known name when one is within two edits.
 * Returns `undefined` for non-command text and for any name in `known`.
 */
export function findUnknownSlashCommand(text: string, known: Iterable<string>): UnknownSlashCommand | undefined {
	const name = COMMAND_TOKEN.exec(text)?.[1];
	if (!name) return undefined;
	const separator = name.indexOf(":");
	const prefix = separator === -1 ? undefined : name.slice(0, separator);
	let suggestion: string | undefined;
	let best = MAX_SUGGESTION_DISTANCE + 1;
	for (const candidate of known) {
		if (candidate === name || (candidate === prefix && lookupBuiltinSlashCommand(prefix)?.allowArgs))
			return undefined;
		const distance = boundedEditDistance(name.toLowerCase(), candidate.toLowerCase(), best - 1);
		if (distance < best) {
			best = distance;
			suggestion = candidate;
		}
	}
	return suggestion === undefined ? { name } : { name, suggestion };
}

/** Levenshtein distance, or `limit + 1` once it provably exceeds `limit`. */
function boundedEditDistance(a: string, b: string, limit: number): number {
	if (limit < 0 || Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
			current.push(value);
			if (value < rowMin) rowMin = value;
		}
		if (rowMin > limit) return limit + 1;
		previous = current;
	}
	return previous[b.length]!;
}
