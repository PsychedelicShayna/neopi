import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseTimeBound } from "../../src/chronicler/temporal/calendar";
import { indexChronicle } from "../../src/chronicler/temporal/indexer";
import { parseKeywords, prefilterTranscripts, resolveRecallSessions } from "../../src/chronicler/temporal/prefilter";
import { lexicalRanker } from "../../src/chronicler/temporal/rank";
import { recallChronicle } from "../../src/chronicler/temporal/recall";
import { createSummarizer } from "../../src/chronicler/temporal/summarize";
import { createFakeChronicleModel, writeSessionAtoms } from "./temporal-fixture";

const ALPHA = "a1a1a1a1-0000-7000-8000-00000000000a";
const BETA = "b2b2b2b2-0000-7000-8000-00000000000b";
const GAMMA = "c3c3c3c3-0000-7000-8000-00000000000c";

describe("transcript keyword grammar", () => {
	it("binds AND before OR, with case-insensitive operators and parenthesized overrides", () => {
		expect(parseKeywords("daemon or tmux and hub")).toEqual({
			operator: "OR", left: { term: "daemon" }, right: {
				operator: "AND", left: { term: "tmux" }, right: { term: "hub" },
			},
		});
		expect(parseKeywords('(daemon AND tmux) OR "session hub"')).toEqual({
			operator: "OR", left: { operator: "AND", left: { term: "daemon" }, right: { term: "tmux" } },
			right: { term: "session hub" },
		});
		expect(parseKeywords('(daemon OR tmux) AND "AND"')).toEqual({
			operator: "AND", left: { operator: "OR", left: { term: "daemon" }, right: { term: "tmux" } },
			right: { term: "AND" },
		});
		expect(parseKeywords('"quoted \\"word\\""')).toEqual({ term: 'quoted "word"' });
	});
	it("rejects malformed expressions instead of widening the search", () => {
		for (const expression of ["", "daemon tmux", "daemon AND", "OR daemon", "()", "(daemon", "daemon)", '"open', '""']) {
			expect(() => parseKeywords(expression)).toThrow();
		}
	});
});

describe("recall session selection", () => {
	it("defaults to current, widens explicitly, and preserves empty selections", () => {
		expect(resolveRecallSessions({ currentSessionId: ALPHA })).toEqual([ALPHA]);
		expect(resolveRecallSessions({ scope: "all", currentSessionId: ALPHA })).toBeUndefined();
		expect(resolveRecallSessions({ session: BETA.slice(0, 8), currentSessionId: ALPHA })).toEqual([BETA.slice(0, 8)]);
		expect(resolveRecallSessions({ sessions: [ALPHA, BETA, ALPHA] })).toEqual([ALPHA, BETA]);
		expect(resolveRecallSessions({ sessions: [] })).toEqual([]);
		expect(resolveRecallSessions({ keywords: "daemon AND tmux", currentSessionId: ALPHA })).toBeUndefined();
		expect(resolveRecallSessions({ scope: "current", keywords: "daemon", currentSessionId: ALPHA })).toEqual([ALPHA]);
		expect(() => resolveRecallSessions({ scope: "current" })).toThrow("No current session");
		expect(() => resolveRecallSessions({ scope: "session" })).toThrow("requires session");
		expect(() => resolveRecallSessions({ scope: "sessions" })).toThrow("requires sessions");
		expect(() => resolveRecallSessions({ sessions: [""] })).toThrow("must not be empty");
	});
});

describe("native transcript prefilter and recall", () => {
	let temp: TempDir;
	let sessionsDir: string;
	let root: string;
	beforeEach(async () => {
		temp = TempDir.createSync("@chronicle-prefilter-");
		sessionsDir = path.join(temp.path(), "sessions");
		root = path.join(temp.path(), "chronicle");
		for (const [sessionId, project, title, time] of [
			[ALPHA, "/work/alpha", "DAEMON routing repaired", "2026-09-02T10:00:00.000Z"],
			[BETA, "/work/beta", "session hub routing repaired", "2026-09-03T10:00:00.000Z"],
			[GAMMA, "/work/gamma", "tmux routing repaired", "2026-10-02T10:00:00.000Z"],
		] as const) {
			const written = await writeSessionAtoms(sessionsDir, { sessionId, cwd: project,
				batches: [[{ title, eventTime: time, body: "Routing repaired and saved." }]],
			});
			if (sessionId === ALPHA) {
				await Bun.write(written.transcriptPath, `${await Bun.file(written.transcriptPath).text()}${JSON.stringify({ type: "custom", data: "tmux C++ a.b" })}\n`);
			}
		}
		await Bun.write(path.join(sessionsDir, "-work-alpha", "diagnostic.jsonl"), 'not a session daemon tmux\n');
		await Bun.write(path.join(sessionsDir, "-work-alpha", "artifact", "__chronicler.jsonl"), 'daemon tmux\n');
	});
	afterEach(async () => { await temp.remove(); });

	const ids = async (keywords: string, caseSensitive = false) =>
		(await prefilterTranscripts({ sessionsDir, keywords, caseSensitive })).map(match => match.sessionId).sort();

	it("matches AND across transcript lines, OR, phrases, case, and literal punctuation", async () => {
		expect(await ids("daemon AND tmux")).toEqual([ALPHA]);
		expect(await ids('(daemon AND tmux) OR "session hub"')).toEqual([ALPHA, BETA]);
		expect(await ids("daemon OR tmux AND missing")).toEqual([ALPHA]);
		expect(await ids("(daemon OR tmux) AND missing")).toEqual([]);
		expect(await ids('"session hub"')).toEqual([BETA]);
		expect(await ids("daemon", true)).toEqual([]);
		expect(await ids("DAEMON", true)).toEqual([ALPHA]);
		expect(await ids('"C++" AND "a.b"')).toEqual([ALPHA]);
		expect(await ids('"aXb"')).toEqual([]);
	});

	it("returns no sessions for an absent root and honours cancellation", async () => {
		expect(await prefilterTranscripts({ sessionsDir: path.join(temp.path(), "missing"), keywords: "daemon" })).toEqual([]);
		const controller = new AbortController();
		controller.abort();
		await expect(prefilterTranscripts({ sessionsDir, keywords: "daemon", signal: controller.signal })).rejects.toThrow();
	});

	it("restricts descent, adjacency and neighbors to selected sessions and event dates", async () => {
		const fake = createFakeChronicleModel();
		const report = await indexChronicle({ agentDir: temp.path(), root,
			config: { timeZone: "UTC", summaryTokens: 500, hopTokens: 1000, terminalAtoms: 8, leadTokens: 120, shortNames: false },
			summarizer: createSummarizer(fake.client),
		});
		expect(report.complete).toBe(true);
		const recall = (selection: { sessions?: string[]; keywords?: string; project?: string; from?: string; to?: string }) =>
			recallChronicle({ root, query: "routing repaired", hint: "routing repaired", ranker: lexicalRanker,
				budget: 10, beam: 4, neighborhoodMinutes: 60 * 24 * 60,
				...selection, sessionsDir,
				from: selection.from ? parseTimeBound(selection.from) : undefined,
				to: selection.to ? parseTimeBound(selection.to) : undefined,
			});
		const current = await recall({ sessions: resolveRecallSessions({ currentSessionId: ALPHA }) });
		expect(current.results.map(atom => atom.sessionId)).toEqual([ALPHA]);
		const all = await recall({ sessions: resolveRecallSessions({ scope: "all" }) });
		expect([...new Set(all.results.map(atom => atom.sessionId))].sort()).toEqual([ALPHA, BETA, GAMMA]);
		const list = await recall({ sessions: [ALPHA.slice(0, 8), GAMMA] });
		expect(list.results.map(atom => atom.sessionId).sort()).toEqual([ALPHA, GAMMA]);
		expect(list.results.flatMap(atom => atom.neighbors).every(atom => atom.sessionId !== BETA)).toBe(true);
		const dated = await recall({ from: "2026-09-03", to: "2026-09" });
		expect(dated.results.map(atom => atom.sessionId)).toEqual([BETA]);
		const filtered = await recall({ keywords: "daemon AND tmux" });
		expect(filtered.results.map(atom => atom.sessionId)).toEqual([ALPHA]);
		expect(filtered.prefilter?.matchingSessions).toEqual([ALPHA]);
		expect(filtered.results.flatMap(atom => atom.neighbors).every(atom => atom.sessionId === ALPHA)).toBe(true);
		expect((await recall({ keywords: "daemon", sessions: [BETA] })).results).toEqual([]);
		expect((await recall({ keywords: "daemon", project: "beta" })).results).toEqual([]);
		expect((await recall({ keywords: "absentterm" })).results).toEqual([]);
		expect((await recall({ sessions: [] })).results).toEqual([]);
	});
});
