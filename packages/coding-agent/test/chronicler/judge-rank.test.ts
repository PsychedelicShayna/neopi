import { describe, expect, it } from "bun:test";
import type { Judge, JudgeOptions, JudgmentRequest } from "@oh-my-pi/pi-ai";
import { createJudgeRanker } from "../../src/chronicler/temporal/judge-rank";
import { lexicalScore, type RankCandidate } from "../../src/chronicler/temporal/rank";
import { JUDGED_CONTENT_MAX_TOKENS } from "../../src/export/ttsr";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";

type Script = (request: JudgmentRequest, options?: JudgeOptions) => unknown | Promise<unknown>;

/** Scripted transport boundary, not a module mock: the consumer sees real requests. */
function scriptedJudge(script: Script) {
	const requests: JudgmentRequest[] = [];
	const judge = {
		label: "scripted",
		async judge(request: JudgmentRequest, options?: JudgeOptions) {
			requests.push(request);
			return script(request, options);
		},
	} as unknown as Judge;
	return { judge, requests };
}

function result(answers: Record<string, unknown>) {
	return { api: "scripted", provider: "scripted", model: "scripted", usage: {}, answers };
}

function entries(request: JudgmentRequest): Record<string, RankCandidate> {
	return (request.state as unknown as { candidates: Record<string, RankCandidate> }).candidates;
}

const CANDIDATES: RankCandidate[] = [
	{ key: "__proto__", label: "First", text: "alpha evidence" },
	{ key: "other", label: "Second", text: "beta evidence" },
	{ key: "__proto__", label: "Third", text: "gamma evidence" },
];

describe("chronicle Judge ranker", () => {
	it("batches siblings in one shared state and maps answer ids, not object order or storage keys", async () => {
		const { judge, requests } = scriptedJudge(() =>
			result({ c2: { type: "noul", noul: 0.9 }, c0: { type: "noul", noul: 0.1 }, c1: { type: "noul", noul: 0.6 } }),
		);
		const ranker = createJudgeRanker(judge);
		expect(ranker.kind).toBe("judge");
		expect(await ranker.score("find evidence", CANDIDATES)).toEqual({ scores: [0.1, 0.6, 0.9] });
		expect(requests).toHaveLength(1);
		expect(requests[0].state).toEqual({
			candidates: { c0: { ...CANDIDATES[0]! }, c1: { ...CANDIDATES[1]! }, c2: { ...CANDIDATES[2]! } },
			search: "find evidence",
		});
		expect(Object.keys(requests[0].questions)).toEqual(["c0", "c1", "c2"]);
		for (const [key, question] of Object.entries(requests[0].questions)) {
			expect(question.type).toBe("noul");
			expect(question.instructions).toContain(`candidates.${key}`);
		}
	});

	it("keeps questions stable while body changes naturally change cache state", async () => {
		const { judge, requests } = scriptedJudge(() => result({ c0: { type: "noul", noul: 0.5 } }));
		const ranker = createJudgeRanker(judge);
		await ranker.score("alpha", [CANDIDATES[0]]);
		await ranker.score("alpha", [{ ...CANDIDATES[0], text: "corrected beta evidence" }]);
		expect(requests[0].questions).toEqual(requests[1].questions);
		expect(requests[0].state).not.toEqual(requests[1].state);
		expect(entries(requests[1]).c0.text).toBe("corrected beta evidence");
	});

	it("uses lexical fallback only for missing or invalid answers while preserving valid probabilities", async () => {
		for (const bad of [
			undefined,
			null,
			{ type: "choice", choice: "yes" },
			{ type: "noul", noul: "0.7" },
			{ type: "noul", noul: NaN },
			{ type: "noul", noul: Infinity },
			{ type: "noul", noul: -0.1 },
			{ type: "noul", noul: 1.1 },
		]) {
			const { judge } = scriptedJudge(() => result({ c0: { type: "noul", noul: 0.75 }, c1: bad }));
			const outcome = await createJudgeRanker(judge).score("beta", CANDIDATES.slice(0, 2));
			expect(outcome.scores).toEqual([0.75, lexicalScore("beta", "Second\nbeta evidence")]);
			expect(outcome.fallback).toContain("missing or invalid probability for c1");
		}
	});

	it("falls back explicitly for malformed responses and transport failures", async () => {
		for (const response of [null, {}, { answers: null }]) {
			const { judge } = scriptedJudge(() => response);
			const outcome = await createJudgeRanker(judge).score("alpha", [CANDIDATES[0]]);
			expect(outcome.scores).toEqual([1]);
			expect(outcome.fallback).toContain("lexical fallback");
		}
		const { judge } = scriptedJudge(() => {
			throw new Error("transport unavailable");
		});
		const outcome = await createJudgeRanker(judge).score("alpha", [CANDIDATES[0]]);
		expect(outcome.scores).toEqual([1]);
		expect(outcome.fallback).toContain("transport unavailable");
	});

	it("keeps unavailable Judge traceable in both phases and uses body-only verification", async () => {
		const ranker = createJudgeRanker(undefined);
		const candidates = [{ key: "a", label: "alpha", text: "unrelated body" }];
		expect(ranker.kind).toBe("judge");
		expect(await ranker.score("alpha", candidates)).toEqual({
			scores: [1],
			fallback: expect.stringContaining("judge unavailable"),
		});
		expect(await ranker.verify!("alpha", candidates)).toEqual({
			scores: [0],
			fallback: expect.stringContaining("judge unavailable"),
		});
	});

	it("preserves cancellation before dispatch, after dispatch, and as a thrown AbortError", async () => {
		const early = new AbortController();
		const reason = new Error("cancelled by caller");
		early.abort(reason);
		const unused = scriptedJudge(() => result({}));
		await expect(createJudgeRanker(unused.judge).score("alpha", CANDIDATES, early.signal)).rejects.toBe(reason);
		expect(unused.requests).toHaveLength(0);
		await expect(createJudgeRanker(undefined).verify!("alpha", CANDIDATES, early.signal)).rejects.toBe(reason);
		const late = new AbortController();
		const dispatched = scriptedJudge((_request, options) => {
			expect(options?.signal).toBe(late.signal);
			late.abort(reason);
			return result({ c0: { type: "noul", noul: 0.8 } });
		});
		await expect(createJudgeRanker(dispatched.judge).verify!("alpha", [CANDIDATES[0]], late.signal)).rejects.toBe(
			reason,
		);
		const abort = new DOMException("cancelled", "AbortError");
		const failing = scriptedJudge(() => {
			throw abort;
		});
		await expect(createJudgeRanker(failing.judge).score("alpha", CANDIDATES)).rejects.toBe(abort);
	});

	it("verifies the entire canonical body including late contradictory evidence", async () => {
		const body = `The system used alpha.\n${"Historical context without a decision.\n".repeat(1_000)}Correction: alpha was rejected; the final decision was beta.`;
		const { judge, requests } = scriptedJudge(request => {
			const full = entries(request).c0.text;
			return result({ c0: { type: "noul", noul: full.endsWith("the final decision was beta.") ? 0.02 : 0.99 } });
		});
		const ranker = createJudgeRanker(judge);
		const outcome = await ranker.verify!("Was alpha the final decision?", [
			{ key: "a", label: "alpha chosen", text: body },
		]);
		expect(outcome).toEqual({ scores: [0.02] });
		expect(entries(requests[0]).c0.text).toBe(body);
		expect(requests[0].questions.c0.instructions).toContain("complete canonical");
	});

	it("never clips oversized bodies and falls back using text beyond the request limit", async () => {
		const body = `${"ordinary unrelated context ".repeat(JUDGED_CONTENT_MAX_TOKENS)} lateuniquematch`;
		expect(countTokens(body, Encoding.Jev)).toBeGreaterThan(JUDGED_CONTENT_MAX_TOKENS);
		const { judge, requests } = scriptedJudge(() => {
			throw new Error("must not send clipped body");
		});
		const outcome = await createJudgeRanker(judge).verify!("lateuniquematch", [
			{ key: "a", label: "unrelated", text: body },
		]);
		expect(requests).toHaveLength(0);
		expect(outcome.scores).toEqual([1]);
		expect(outcome.fallback).toContain("complete candidate exceeds");
	});

	it("splits oversized sibling states sequentially and preserves input order", async () => {
		const body = "ordinary context ".repeat(7_000);
		const candidates = Array.from({ length: 4 }, (_, index) => ({ key: `a${index}`, label: "entry", text: body }));
		let active = 0;
		let peak = 0;
		const { judge, requests } = scriptedJudge(async request => {
			active++;
			peak = Math.max(peak, active);
			expect(countTokens(JSON.stringify(request), Encoding.Jev)).toBeLessThanOrEqual(JUDGED_CONTENT_MAX_TOKENS);
			await Promise.resolve();
			active--;
			return result(
				Object.fromEntries(
					Object.entries(entries(request)).map(([id, candidate]) => [
						id,
						{ type: "noul", noul: Number(candidate.key.slice(1)) / 4 },
					]),
				),
			);
		});
		const outcome = await createJudgeRanker(judge).score("context", candidates);
		expect(outcome).toEqual({ scores: [0, 0.25, 0.5, 0.75] });
		expect(requests.length).toBeGreaterThan(1);
		expect(peak).toBe(1);
	});

	it("does not dispatch empty batches", async () => {
		const { judge, requests } = scriptedJudge(() => result({}));
		const ranker = createJudgeRanker(judge);
		expect(await ranker.score("alpha", [])).toEqual({ scores: [] });
		expect(await ranker.verify!("alpha", [])).toEqual({ scores: [] });
		expect(requests).toHaveLength(0);
	});
});
