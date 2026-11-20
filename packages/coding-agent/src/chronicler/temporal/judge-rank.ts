import { type Judge, type JudgmentRequest, judgeQuestions, type NoulQuestion, renderQuestion } from "@oh-my-pi/pi-ai";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { JUDGED_CONTENT_MAX_TOKENS } from "../../export/ttsr";
import questionFile from "../../prompts/judge/chronicle-recall.json" with { type: "json" };
import { lexicalScore, type NodeRanker, type RankCandidate, type RankOutcome } from "./rank";

const QUESTIONS = judgeQuestions(questionFile);
type Phase = keyof typeof QUESTIONS;

/** Index-based question ids cannot collide with arbitrary (or repeated) storage keys. */
function requestFor(
	query: string,
	candidates: readonly RankCandidate[],
	phase: Phase,
): JudgmentRequest<Record<string, NoulQuestion>> {
	const entries: Record<string, { key: string; label: string; text: string }> = {};
	const questions: Record<string, NoulQuestion> = {};
	for (const [index, candidate] of candidates.entries()) {
		const key = `c${index}`;
		entries[key] = { key: candidate.key, label: candidate.label, text: candidate.text };
		questions[key] = renderQuestion(QUESTIONS[phase], { key });
	}
	return { state: { candidates: entries, search: query }, questions };
}

/**
 * Uses the configured Judge, including its state/question cache; content stays in
 * state so edits invalidate it naturally. No adapter cache or inner concurrency.
 * Both phases retain complete supplied text. Requests exceeding the existing
 * judged-content token policy split sequentially; an oversized singleton is
 * scored lexically against its full text, never a prefix or routing summary.
 */
export function createJudgeRanker(judge: Judge | undefined): NodeRanker {
	async function rank(
		query: string,
		candidates: readonly RankCandidate[],
		phase: Phase,
		signal?: AbortSignal,
	): Promise<RankOutcome> {
		signal?.throwIfAborted();
		if (candidates.length === 0) return { scores: [] };
		const scores: number[] = [];
		const diagnostics = new Set<string>();
		function fallback(batch: readonly RankCandidate[], diagnostic: string): void {
			signal?.throwIfAborted();
			for (const candidate of batch) {
				// Verification uses body evidence only, never a suggestive routing label.
				scores.push(
					lexicalScore(query, phase === "verify" ? candidate.text : `${candidate.label}\n${candidate.text}`),
				);
			}
			diagnostics.add(`judge ${phase}: full-text lexical fallback: ${diagnostic}`);
		}
		async function scoreBatch(batch: readonly RankCandidate[]): Promise<void> {
			signal?.throwIfAborted();
			if (!judge) {
				fallback(batch, "judge unavailable");
				return;
			}
			try {
				const request = requestFor(query, batch, phase);
				// Count the whole request (including questions), conservatively reserving
				// at least the same protocol headroom as TTSR's 32k content policy.
				if (countTokens(JSON.stringify(request), Encoding.Jev) > JUDGED_CONTENT_MAX_TOKENS) {
					if (batch.length === 1) {
						fallback(batch, `complete candidate exceeds ${JUDGED_CONTENT_MAX_TOKENS}-token request limit`);
						return;
					}
					const middle = Math.ceil(batch.length / 2);
					await scoreBatch(batch.slice(0, middle));
					await scoreBatch(batch.slice(middle));
					return;
				}
				const result = await judge.judge(request, { signal });
				signal?.throwIfAborted();
				for (const [index, candidate] of batch.entries()) {
					const id = `c${index}`;
					const answer = result?.answers?.[id];
					if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
						fallback([candidate], `missing or invalid probability for ${id}`);
					} else {
						scores.push(answer.noul);
					}
				}
			} catch (error) {
				signal?.throwIfAborted();
				if (
					(error instanceof Error && (error.name === "AbortError" || error.name === "ToolAbortError")) ||
					AIError.is(AIError.classify(error), AIError.Flag.Abort)
				) {
					throw error;
				}
				fallback(batch, error instanceof Error ? error.message : String(error));
			}
		}
		await scoreBatch(candidates);
		return { scores, ...(diagnostics.size ? { fallback: [...diagnostics].join("; ") } : {}) };
	}
	return {
		kind: "judge",
		score: (query, candidates, signal) => rank(query, candidates, "route", signal),
		verify: (query, candidates, signal) => rank(query, candidates, "verify", signal),
	};
}
