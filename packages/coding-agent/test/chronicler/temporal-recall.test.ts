/**
 * Recall over the derived temporal view: descent by meaning, backtracking out
 * of a misleading branch, adjacency and neighborhood under scope, stateless
 * narrowing by resolution, canonical evidence, and filesystem-first
 * equivalence. The mock-provider model scores the candidates it is actually
 * sent by concept overlap; nothing is keyed to expected ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter, TempDir } from "@oh-my-pi/pi-utils";
import { loadChronicleCorpus } from "../../src/chronicler/temporal/corpus";
import { indexChronicle } from "../../src/chronicler/temporal/indexer";
import { createModelRanker, lexicalRanker, lexicalScore, type NodeRanker } from "../../src/chronicler/temporal/rank";
import {
	ChronicleViewMissingError,
	rankPayloadTokens,
	type RecallOptions,
	recallChronicle,
} from "../../src/chronicler/temporal/recall";
import { createSummarizer } from "../../src/chronicler/temporal/summarize";
import type { IndexConfig } from "../../src/chronicler/temporal/tree";
import { nodeDir, readViewNode } from "../../src/chronicler/temporal/view";
import {
	createFakeChronicleModel,
	type FakeChronicleModel,
	type FixtureAtom,
	type WrittenSession,
	writeSessionAtoms,
} from "./temporal-fixture";

const CONFIG: IndexConfig = {
	timeZone: "UTC",
	summaryTokens: 500,
	hopTokens: 1000,
	terminalAtoms: 8,
	leadTokens: 120,
	shortNames: false,
};

const ALPHA = "a1a1a1a1-0000-7000-8000-00000000000a";
const BETA = "b2b2b2b2-0000-7000-8000-00000000000b";

const TARGET: FixtureAtom = {
	title: "OAuth token refresh looped until patched",
	eventTime: "2026-09-02T10:00:00.000Z",
	body: "The OAuth token refresh looped: every token refresh triggered another token refresh. The handler was patched to cache the token, and the OAuth refresh now stops after one token exchange.",
};

const BILLING: FixtureAtom = {
	title: "Postgres schema migration for billing",
	eventTime: "2026-09-16T14:00:00.000Z",
	body: "The postgres schema migration added billing tables. Migration order matters for the schema, and postgres locks were checked before the billing rollout.",
};

function repeat(word: string, count: number): string {
	return Array.from({ length: count }, () => word).join(" ");
}

describe("chronicle recall", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let sessionsDir: string;
	let root: string;
	let fake: FakeChronicleModel;
	let model: NodeRanker;

	beforeEach(() => {
		tempDir = TempDir.createSync("@chronicle-recall-");
		agentDir = tempDir.path();
		sessionsDir = path.join(agentDir, "sessions");
		root = path.join(agentDir, "chronicle");
		fake = createFakeChronicleModel();
		model = createModelRanker(fake.client);
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	async function index(): Promise<void> {
		const report = await indexChronicle({
			agentDir,
			root,
			config: CONFIG,
			summarizer: createSummarizer(fake.client),
		});
		expect(report.complete).toBe(true);
	}

	function recall(over: Partial<RecallOptions> & Pick<RecallOptions, "query">) {
		return recallChronicle({ root, budget: 3, beam: 2, neighborhoodMinutes: 90, ranker: model, ...over });
	}

	async function writeParaphraseCorpus(): Promise<WrittenSession> {
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: ALPHA,
			batches: [[TARGET], [BILLING]],
		});
		await index();
		return written;
	}

	it("finds an atom through summaries when the query shares no words with it, and returns canonical evidence", async () => {
		const written = await writeParaphraseCorpus();
		const query = "signin redirect cycle repaired";
		expect(lexicalScore(query, `${TARGET.title} ${TARGET.body}`)).toBe(0);

		const result = await recall({ query });
		const top = result.results[0]!;
		expect(top.id).toBe(written.atomIds[0]!);
		expect(top).toMatchObject({
			via: "descent",
			confident: true,
			stale: false,
			sessionId: ALPHA,
			project: "/work/alpha",
		});
		expect(top.body).toBe(TARGET.body);
		expect(top.transcript).toEqual({ path: written.transcriptPath, entryIds: [written.sourceIds[0]!] });
		expect(top.beat.startsWith(written.chroniclerRoot)).toBe(true);
		expect(result.trace.some(step => step.action === "rank")).toBe(true);
		expect(result.ambiguous).toBe(false);

		const lexical = await recall({ query, ranker: lexicalRanker });
		expect(lexical.results).toEqual([]);
		expect(lexical.ambiguous).toBe(true);
		expect(lexical.candidates.length).toBeGreaterThan(0);
	});

	it("backtracks from a branch whose summary matches but whose atoms each match only a fragment", async () => {
		const decoys: FixtureAtom[] = [
			{
				title: "Login page colors",
				eventTime: "2026-09-08T09:00:00.000Z",
				body: `Login page colors changed. ${repeat("login", 6)} palette and spacing adjusted.`,
			},
			{
				title: "Dashboard animation loop",
				eventTime: "2026-09-08T09:10:00.000Z",
				body: `The dashboard animation loop stutters. ${repeat("loop", 6)} timing tuned.`,
			},
			{
				title: "Readme typo fix",
				eventTime: "2026-09-08T09:20:00.000Z",
				body: `A readme typo fix. ${repeat("fix", 6)} verified in preview.`,
			},
		];
		const fillerText = "postgres migration schema vacuum replica tablespace checkpoint wal";
		const fillers: FixtureAtom[] = Array.from({ length: 10 }, (_, n) => ({
			title: `Postgres maintenance ${n}`,
			eventTime: `2026-09-15T14:${String(n * 2).padStart(2, "0")}:00.000Z`,
			body: `${fillerText}. ${fillerText}. ${fillerText}.`,
		}));
		const target: FixtureAtom = {
			title: "Session token refresh bounce",
			eventTime: "2026-09-15T14:50:00.000Z",
			body: "The session token refresh kept bouncing between two endpoints until a patch pinned the refresh endpoint.",
		};
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: ALPHA,
			batches: [decoys, [...fillers, target]],
		});
		await index();

		const result = await recall({ query: "signin redirect cycle repaired", budget: 1 });
		expect(result.results[0]?.id).toBe(written.atomIds[written.atomIds.length - 1]!);

		const actions = result.trace.filter(step => step.search === "query");
		const month = actions.find(step => step.action === "rank" && step.node === "2026/09")!;
		const weekScores = new Map(month.candidates!.map(candidate => [candidate.key, candidate.score]));
		expect(weekScores.get("2026/09/w2")!).toBeGreaterThan(weekScores.get("2026/09/w3")!);
		const collapse = actions.findIndex(step => step.action === "collapse" && step.node.startsWith("2026/09/w2"));
		const backtrack = actions.findIndex(step => step.action === "backtrack" && step.node === "2026/09/w3");
		const found = actions.findIndex(
			step => step.action === "terminal" && step.candidates?.some(candidate => candidate.score >= 0.6),
		);
		expect(collapse).toBeGreaterThanOrEqual(0);
		expect(backtrack).toBeGreaterThan(collapse);
		expect(found).toBeGreaterThan(backtrack);
	});

	describe("adjacency and scope", () => {
		let anchorSession: WrittenSession;
		let neighborSession: WrittenSession;

		beforeEach(async () => {
			anchorSession = await writeSessionAtoms(sessionsDir, {
				cwd: "/work/alpha",
				sessionId: ALPHA,
				batches: [
					[
						{
							title: "Postgres primary crashed during the migration",
							eventTime: "2026-09-15T14:00:00.000Z",
							body: "The postgres primary crashed halfway through the schema migration; the replica was promoted.",
						},
						{
							title: "Evening cleanup",
							eventTime: "2026-09-15T19:00:00.000Z",
							body: "Closed stale branches in the evening.",
						},
					],
				],
			});
			neighborSession = await writeSessionAtoms(sessionsDir, {
				cwd: "/work/beta",
				sessionId: BETA,
				batches: [
					[
						{
							title: "Misc scratch notes",
							eventTime: "2026-09-15T14:20:00.000Z",
							body: "Scratch notes; see the transcript for what happened.",
						},
					],
				],
			});
			await index();
		});

		it("uses an adjacent-event hint to reach a poorly described neighbor in another session", async () => {
			const query = "the experiment right after the outage";
			const blind = await recall({ query });
			expect(blind.results.map(result => result.id)).not.toContain(neighborSession.atomIds[0]!);

			const hinted = await recall({ query, hint: "postgres crash during migration" });
			const neighbor = hinted.results.find(result => result.id === neighborSession.atomIds[0]);
			expect(neighbor).toMatchObject({ via: "adjacent", anchor: anchorSession.atomIds[0], sessionId: BETA });
			expect(hinted.results.map(result => result.id)).not.toContain(anchorSession.atomIds[1]!);
		});

		it("revalidates neighbors and the hint anchor against canonical atoms", async () => {
			const corpus = await loadChronicleCorpus(sessionsDir);
			const beatOf = (id: string) => corpus.atoms.find(atom => atom.id === id)!.beatFile;
			await fs.rm(path.dirname(beatOf(neighborSession.atomIds[0]!)), { recursive: true });
			const crash = await recall({ query: "postgres crash during migration" });
			expect(crash.results[0]!.id).toBe(anchorSession.atomIds[0]!);
			expect(crash.results[0]!.neighbors.map(neighbor => neighbor.id)).not.toContain(neighborSession.atomIds[0]!);
			expect(crash.trace.some(step => step.action === "atom-missing")).toBe(true);

			await fs.rm(path.dirname(beatOf(anchorSession.atomIds[0]!)), { recursive: true });
			const hinted = await recall({
				query: "the experiment right after the outage",
				hint: "postgres crash during migration",
			});
			expect(hinted.results.some(result => result.via === "adjacent")).toBe(false);
			expect(hinted.trace.some(step => step.search === "hint" && step.action === "atom-missing")).toBe(true);
		});

		it("keeps project and session scope through adjacency and neighborhood expansion", async () => {
			const scoped = await recall({
				query: "the experiment right after the outage",
				hint: "postgres crash during migration",
				project: "alpha",
			});
			expect(scoped.results.every(result => result.project === "/work/alpha")).toBe(true);

			const crash = await recall({ query: "postgres crash during migration" });
			expect(crash.results[0]!.neighbors.map(neighbor => neighbor.id)).toContain(neighborSession.atomIds[0]!);
			const sessionScoped = await recall({ query: "postgres crash during migration", session: ALPHA.slice(0, 8) });
			expect(sessionScoped.results[0]!.id).toBe(anchorSession.atomIds[0]!);
			expect(sessionScoped.results[0]!.neighbors.map(neighbor => neighbor.id)).not.toContain(
				neighborSession.atomIds[0]!,
			);
		});
	});

	it("narrows statelessly by resolution and node from month to week to atom", async () => {
		const written = await writeParaphraseCorpus();
		const query = "signin redirect cycle repaired";
		const months = await recall({ query, resolution: "month" });
		expect(months.results).toEqual([]);
		expect(months.candidates.map(candidate => candidate.key)).toEqual(["2026/09"]);

		const weeks = await recall({ query, resolution: "week", node: months.candidates[0]!.key });
		expect(weeks.candidates[0]).toMatchObject({ key: "2026/09/w1", level: "week" });
		expect(weeks.candidates.map(candidate => candidate.key)).toContain("2026/09/w3");

		const atoms = await recall({ query, node: weeks.candidates[0]!.key });
		expect(atoms.results.map(result => result.id)).toEqual([written.atomIds[0]!]);
	});

	it("survives deleting and rebuilding the view, and discloses changed or deleted canonical atoms", async () => {
		const written = await writeParaphraseCorpus();
		const query = "signin redirect cycle repaired";
		const before = (await recall({ query })).results.map(result => result.id);

		await fs.rm(root, { recursive: true });
		await expect(recall({ query })).rejects.toBeInstanceOf(ChronicleViewMissingError);
		await index();
		expect((await recall({ query })).results.map(result => result.id)).toEqual(before);

		const corpus = await loadChronicleCorpus(sessionsDir);
		const target = corpus.atoms.find(atom => atom.id === written.atomIds[0])!;
		const billing = corpus.atoms.find(atom => atom.id === written.atomIds[1])!;
		await Bun.write(
			target.beatFile,
			(await Bun.file(target.beatFile).text()).replace("one token exchange.", "one token exchange. Later revised."),
		);
		await fs.rm(path.dirname(billing.beatFile), { recursive: true });

		const changed = await recall({ query });
		expect(changed.results[0]).toMatchObject({ id: target.id, stale: true });
		expect(changed.results[0]!.body).toContain("Later revised.");
		expect(changed.view.viewStale).toBe(true);

		const deleted = await recall({ query: "postgres schema migration billing", ranker: lexicalRanker });
		expect(deleted.results.map(result => result.id)).not.toContain(billing.id);
		expect(deleted.evidenceErrors.map(error => error.id)).toContain(billing.id);

		await Bun.write(
			target.beatFile,
			(await Bun.file(target.beatFile).text()).replace(/^event_time: .*$/m, "event_time: 2026-10-20T10:00:00.000Z"),
		);
		const moved = await recall({ query, to: { kind: "local", prefix: "2026-09" } });
		expect(moved.results.map(result => result.id)).not.toContain(target.id);
		expect(moved.trace.some(step => step.action === "moved-out-of-scope" && step.note === target.id)).toBe(true);
	});

	it("reaches the same atom by reading the view directory directly as by native descent", async () => {
		await writeParaphraseCorpus();
		const query = "postgres schema migration billing";
		const native = await recall({ query, ranker: lexicalRanker, budget: 1 });

		let key = "";
		for (;;) {
			const dir = nodeDir(root, key);
			const manifest = (await Bun.file(path.join(dir, "node.json")).json()) as {
				children: { key: string; label: string; description: string }[];
				atoms?: unknown[];
			};
			if (manifest.atoms) break;
			const best = manifest.children
				.map(child => ({ key: child.key, score: lexicalScore(query, `${child.label}\n${child.description}`) }))
				.sort((a, b) => b.score - a.score)[0]!;
			key = best.key;
		}
		const dir = nodeDir(root, key);
		const stubs = (await fs.readdir(dir)).filter(name => name.endsWith(".md") && name !== "NODE.md");
		const scored = await Promise.all(
			stubs.map(async name => {
				const { frontmatter, body } = parseFrontmatter(await Bun.file(path.join(dir, name)).text(), {
					rawKeys: true,
					level: "off",
				});
				return { id: String(frontmatter.id), stub: path.join(dir, name), score: lexicalScore(query, body) };
			}),
		);
		const walked = scored.sort((a, b) => b.score - a.score)[0]!;
		expect(walked.id).toBe(native.results[0]!.id);
		expect(walked.stub).toBe(native.results[0]!.stub);
		const terminal = await readViewNode(root, key);
		expect(terminal.state).toBe("ok");
	});

	it("keeps every rank request within one hop, even for a huge title and a crowded adjacency window", async () => {
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: ALPHA,
			batches: [
				[
					{
						title: `${"Giant ".repeat(2000)}postgres crash`,
						eventTime: "2026-09-15T14:00:00.000Z",
						body: "The postgres primary crashed during the migration.",
					},
				],
			],
		});
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/beta",
			sessionId: BETA,
			batches: [
				Array.from({ length: 30 }, (_, n) => ({
					title: `Nearby note ${n}`,
					eventTime: `2026-09-15T14:${String(n + 1).padStart(2, "0")}:00.000Z`,
					body: `Scratch observation ${n} recorded while the database was down, with enough words to make the route long.`,
				})),
			],
		});
		await index();
		const payloads: number[] = [];
		const recording: NodeRanker = {
			kind: "model",
			async score(query, candidates, signal) {
				payloads.push(rankPayloadTokens(query, candidates));
				return model.score(query, candidates, signal);
			},
		};
		const result = await recall({ query: "postgres crash", hint: "postgres crash", ranker: recording });
		expect(Math.max(...payloads)).toBeLessThanOrEqual(CONFIG.hopTokens);
		const adjacency = result.trace.find(step => step.action === "adjacent");
		expect(adjacency?.candidates).toHaveLength(30);
	});

	it("reports tied plausible periods instead of silently choosing one", async () => {
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: ALPHA,
			batches: [[TARGET, { ...TARGET, eventTime: "2026-09-16T14:00:00.000Z" }]],
		});
		await index();
		const result = await recall({ query: "signin redirect cycle repaired", budget: 1 });
		expect(result.results).toHaveLength(1);
		expect(result.ambiguous).toBe(true);
		expect(result.ask).toBe("adjacent-event");
		expect(result.candidates.map(candidate => candidate.key).sort()).toEqual([
			"2026/09/w1/02/10",
			"2026/09/w3/16/14",
		]);
	});

	it("keeps rank requests within one hop for a recollection longer than a hop, and discloses the clip", async () => {
		await writeParaphraseCorpus();
		const payloads: number[] = [];
		const recording: NodeRanker = {
			kind: "model",
			async score(query, candidates, signal) {
				payloads.push(rankPayloadTokens(query, candidates));
				return model.score(query, candidates, signal);
			},
		};
		const longQuery = `${"remember ".repeat(600)}signin redirect cycle repaired`;
		const result = await recall({ query: longQuery, hint: longQuery, ranker: recording });
		expect(payloads.length).toBeGreaterThan(0);
		expect(Math.max(...payloads)).toBeLessThanOrEqual(CONFIG.hopTokens);
		const clipped = result.trace.filter(step => step.action === "query-clipped").map(step => step.search);
		expect(clipped.sort()).toEqual(["hint", "query"]);
	});
});
