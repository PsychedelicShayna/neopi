import { lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { boundedEditDistance } from "../../utils/string-distance";

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
