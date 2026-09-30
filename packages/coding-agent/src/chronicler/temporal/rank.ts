/**
 * Sibling ranking for recall descent. Every ranker returns absolute scores in
 * [0, 1] so relevance is comparable across levels (the backtrack rule compares
 * a node's score with its best child's).
 */
import { prompt } from "@oh-my-pi/pi-utils";
import rankInputTemplate from "../../prompts/chronicler/temporal/rank-input.md" with { type: "text" };
import rankSystemTemplate from "../../prompts/chronicler/temporal/rank-system.md" with { type: "text" };
import { type ChronicleModelClient, parseJsonObject } from "./model";

export interface RankCandidate {
	key: string;
	label: string;
	text: string;
}

export interface RankOutcome {
	scores: number[];
	/** Set when this hop fell back from the model to lexical scoring. */
	fallback?: string;
}

export interface NodeRanker {
	readonly kind: "model" | "lexical";
	score(query: string, candidates: readonly RankCandidate[], signal?: AbortSignal): Promise<RankOutcome>;
}

const STOPWORDS = new Set(
	(
		"a an and are as at be been but by did do does for from had has have he her his how i if in into is it its " +
		"me my no not of on or our she so that the their them then there these they this to was we were what when " +
		"where which who why will with you your about after before around during some something thing things time"
	).split(" "),
);

function stem(word: string): string {
	for (const suffix of ["ing", "edly", "ed", "ies", "es", "ly", "s"]) {
		if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
			return suffix === "ies" ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
		}
	}
	return word;
}

export function terms(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 2 || STOPWORDS.has(raw)) continue;
		out.add(stem(raw));
	}
	return out;
}

/** Fraction of query terms (stemmed, stopwords removed) the text contains. */
export function lexicalScore(query: string, text: string): number {
	const wanted = terms(query);
	if (wanted.size === 0) return 0;
	const have = terms(text);
	let hits = 0;
	for (const term of wanted) if (have.has(term)) hits++;
	return hits / wanted.size;
}

export const lexicalRanker: NodeRanker = {
	kind: "lexical",
	async score(query, candidates) {
		return { scores: candidates.map(candidate => lexicalScore(query, `${candidate.label}\n${candidate.text}`)) };
	},
};

export function createModelRanker(client: ChronicleModelClient): NodeRanker {
	return {
		kind: "model",
		async score(query, candidates, signal) {
			if (candidates.length === 0) return { scores: [] };
			try {
				const reply = parseJsonObject(
					await client.complete(
						prompt.render(rankSystemTemplate, {}),
						prompt.render(rankInputTemplate, { query, candidates }),
						Math.max(256, candidates.length * 24 + 64),
						signal,
					),
				);
				if (!Array.isArray(reply.scores)) throw new Error("rank reply lacks scores");
				const byKey = new Map<string, number>();
				for (const item of reply.scores) {
					if (typeof item !== "object" || item === null) continue;
					const { key, score } = item as { key?: unknown; score?: unknown };
					if (typeof key === "string" && typeof score === "number" && Number.isFinite(score)) {
						byKey.set(key, Math.min(1, Math.max(0, score / 10)));
					}
				}
				return { scores: candidates.map(candidate => byKey.get(candidate.key) ?? 0) };
			} catch (error) {
				if (signal?.aborted) throw error;
				const fallback = await lexicalRanker.score(query, candidates);
				return { ...fallback, fallback: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
