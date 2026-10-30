import * as fs from "node:fs/promises";
import * as path from "node:path";
import { grep, GrepOutputMode } from "@oh-my-pi/pi-natives";
import { readSessionHeader } from "./corpus";
import { isEnoent } from "@oh-my-pi/pi-utils";

export type KeywordExpression =
	| { term: string }
	| { operator: "AND" | "OR"; left: KeywordExpression; right: KeywordExpression };

type Token = { kind: "term"; value: string } | { kind: "AND" | "OR" | "(" | ")" };

/** Literal terms/phrases, explicit operators, AND before OR. No regex interpretation. */
export function parseKeywords(expression: string): KeywordExpression {
	const tokens: Token[] = [];
	let offset = 0;
	while (offset < expression.length) {
		const char = expression[offset]!;
		if (/\s/.test(char)) { offset++; continue; }
		if (char === "(" || char === ")") { tokens.push({ kind: char }); offset++; continue; }
		if (char === '"') {
			let value = "";
			let closed = false;
			while (++offset < expression.length) {
				const next = expression[offset]!;
				if (next === '"') { offset++; closed = true; break; }
				if (next === "\\" && (expression[offset + 1] === '"' || expression[offset + 1] === "\\")) {
					value += expression[++offset]!;
				} else value += next;
			}
			if (!closed || !value.trim()) throw new Error("Keywords need a non-empty, closed quoted phrase");
			tokens.push({ kind: "term", value });
			continue;
		}
		const start = offset;
		while (offset < expression.length && !/[\s()"]/.test(expression[offset]!)) offset++;
		const value = expression.slice(start, offset);
		const operator = value.toUpperCase();
		tokens.push(operator === "AND" || operator === "OR" ? { kind: operator } : { kind: "term", value });
	}
	let cursor = 0;
	const primary = (): KeywordExpression => {
		const token = tokens[cursor++];
		if (token?.kind === "term") return { term: token.value };
		if (token?.kind === "(") {
			const nested = disjunction();
			if (tokens[cursor++]?.kind !== ")") throw new Error("Keywords have an unmatched parenthesis");
			return nested;
		}
		throw new Error("Keywords expect a term, quoted phrase, or parenthesized expression");
	};
	const conjunction = (): KeywordExpression => {
		let left = primary();
		while (tokens[cursor]?.kind === "AND") {
			cursor++;
			left = { operator: "AND", left, right: primary() };
		}
		return left;
	};
	const disjunction = (): KeywordExpression => {
		let left = conjunction();
		while (tokens[cursor]?.kind === "OR") {
			cursor++;
			left = { operator: "OR", left, right: conjunction() };
		}
		return left;
	};
	const parsed = disjunction();
	if (cursor !== tokens.length) throw new Error("Keywords require AND or OR between terms and balanced parentheses");
	return parsed;
}

export interface TranscriptMatch {
	sessionId: string;
	project: string;
	transcript: string;
}

/** Search raw transcript bytes natively; retain paths, never transcript bodies. */
export async function prefilterTranscripts(options: {
	sessionsDir: string;
	keywords: string;
	caseSensitive?: boolean;
	signal?: AbortSignal;
}): Promise<TranscriptMatch[]> {
	const expression = parseKeywords(options.keywords);
	options.signal?.throwIfAborted();
	try {
		await fs.stat(options.sessionsDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const terms = new Map<string, Set<string>>();
	const collect = (node: KeywordExpression): void => {
		if ("term" in node) terms.set(node.term, new Set());
		else { collect(node.left); collect(node.right); }
	};
	collect(expression);
	for (const term of terms.keys()) {
		options.signal?.throwIfAborted();
		const result = await grep({
			path: options.sessionsDir,
			glob: "*/*.jsonl",
			recursive: false,
			pattern: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			ignoreCase: !options.caseSensitive,
			gitignore: false,
			hidden: true,
			mode: GrepOutputMode.FilesWithMatches,
			signal: options.signal,
		});
		if (result.limitReached || result.skippedOversized) {
			throw new Error("Transcript keyword prefilter was incomplete; no partial session selection was used");
		}
		terms.set(term, new Set(result.matches.map(match => path.resolve(options.sessionsDir, match.path))));
	}
	const evaluate = (node: KeywordExpression): Set<string> => {
		if ("term" in node) return terms.get(node.term)!;
		const left = evaluate(node.left);
		const right = evaluate(node.right);
		return node.operator === "AND"
			? new Set([...left].filter(file => right.has(file)))
			: new Set([...left, ...right]);
	};
	const matches: TranscriptMatch[] = [];
	for (const transcript of [...evaluate(expression)].sort()) {
		options.signal?.throwIfAborted();
		const header = await readSessionHeader(transcript);
		if (header) matches.push({ sessionId: header.id, project: header.cwd, transcript });
	}
	return matches;
}

export type RecallScope = "current" | "all" | "session" | "sessions";

/** undefined means unrestricted; [] means no sessions (never an implicit all). */
export function resolveRecallSessions(options: {
	scope?: RecallScope;
	session?: string;
	sessions?: readonly string[];
	keywords?: string;
	currentSessionId?: string;
}): string[] | undefined {
	const selected = [...(options.session === undefined ? [] : [options.session]), ...(options.sessions ?? [])]
		.map(id => id.trim().toLowerCase());
	if (selected.some(id => !id)) throw new Error("Session ids must not be empty");
	if (options.scope === "current") {
		if (selected.length) throw new Error("scope current cannot be combined with session or sessions");
		if (!options.currentSessionId) throw new Error("No current session is available; use scope all or select sessions");
		return [options.currentSessionId.toLowerCase()];
	}
	if (options.scope === "session" && !options.session) throw new Error("scope session requires session");
	if (options.scope === "sessions" && options.sessions === undefined) throw new Error("scope sessions requires sessions");
	if (options.sessions !== undefined || options.session !== undefined) return [...new Set(selected)];
	if (options.scope === "all" || options.keywords !== undefined) return undefined;
	if (!options.currentSessionId) throw new Error("No current session is available; use scope all or select sessions");
	return [options.currentSessionId.toLowerCase()];
}
