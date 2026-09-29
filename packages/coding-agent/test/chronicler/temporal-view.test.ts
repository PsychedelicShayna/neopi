/**
 * Derived temporal view invariants: calendar grouping, lossless terminal
 * enumeration, bounded hops, freshness/staleness, drift repair, pruning, and
 * canonical diagnostics. Atoms are committed through the real ChroniclerStore;
 * summaries come from a mock-provider model through the real prompts.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadChronicleCorpus } from "../../src/chronicler/temporal/corpus";
import { lexicalRanker } from "../../src/chronicler/temporal/rank";
import { recallChronicle } from "../../src/chronicler/temporal/recall";
import * as viewModule from "../../src/chronicler/temporal/view";
import { indexChronicle, type IndexReport } from "../../src/chronicler/temporal/indexer";
import { createSummarizer, type ChronicleSummarizer } from "../../src/chronicler/temporal/summarize";
import {
	buildPlan,
	estimateTokens,
	type IndexConfig,
	maxFanout,
	type PlanNode,
	walkPlan,
} from "../../src/chronicler/temporal/tree";
import {
	nodeDir,
	readViewManifest,
	readViewNode,
	routingText,
	type ViewNode,
	verifyRenders,
} from "../../src/chronicler/temporal/view";
import { createFakeChronicleModel, type FakeChronicleModel, writeSessionAtoms } from "./temporal-fixture";

function config(over: Partial<IndexConfig> = {}): IndexConfig {
	return {
		timeZone: "UTC",
		summaryTokens: 500,
		hopTokens: 1000,
		terminalAtoms: 8,
		leadTokens: 120,
		shortNames: false,
		...over,
	};
}

function atom(title: string, eventTime: string, body = `${title}. Details of ${title.toLowerCase()} recorded.`) {
	return { title, eventTime, body };
}

function terminalOf(plan: PlanNode, id: string): PlanNode {
	for (const node of walkPlan(plan)) if (node.entries.some(entry => entry.id === id)) return node;
	throw new Error(`atom ${id} is in no terminal`);
}

function leaves(plan: PlanNode): PlanNode[] {
	return [...walkPlan(plan)].filter(node => node.children.length === 0);
}

async function snapshot(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for await (const file of new Bun.Glob("**/*").scan({ cwd: dir, dot: true })) {
		out.set(file, Bun.hash(await Bun.file(path.join(dir, file)).arrayBuffer()).toString());
	}
	return out;
}

async function allNodes(root: string, key = ""): Promise<ViewNode[]> {
	const stored = await readViewNode(root, key);
	if (stored.state !== "ok") throw new Error(`node ${key || "root"} is ${stored.state}`);
	const out = [stored.node];
	for (const child of stored.node.children) out.push(...(await allNodes(root, child.key)));
	return out;
}

function ancestorsOf(key: string): string[] {
	const parts = key.split("/");
	const out = [""];
	for (let index = 1; index <= parts.length; index++) out.push(parts.slice(0, index).join("/"));
	return out;
}

describe("chronicle temporal view", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let sessionsDir: string;
	let root: string;
	let fake: FakeChronicleModel;
	let summarizer: ChronicleSummarizer;

	beforeEach(() => {
		tempDir = TempDir.createSync("@chronicle-view-");
		agentDir = tempDir.path();
		sessionsDir = path.join(agentDir, "sessions");
		root = path.join(agentDir, "chronicle");
		fake = createFakeChronicleModel();
		summarizer = createSummarizer(fake.client);
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	const index = (over: Partial<Parameters<typeof indexChronicle>[0]> = {}): Promise<IndexReport> =>
		indexChronicle({ agentDir, root, config: config(), summarizer, ...over });

	it("groups atoms from several sessions and projects into sparse wall-clock buckets with month-clamped weeks", async () => {
		const alpha = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000001",
			batches: [
				[atom("Monday cleanup", "2026-08-31T10:05:00.000Z"), atom("Tuesday parser", "2026-09-01T10:10:00.000Z")],
			],
		});
		const beta = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/beta",
			sessionId: "b2b2b2b2-0000-7000-8000-000000000002",
			batches: [[atom("Tuesday deploy", "2026-09-01T10:20:00.000Z")]],
		});
		const corpus = await loadChronicleCorpus(sessionsDir);
		const plan = buildPlan(corpus.atoms, config())!;

		// Aug 31 2026 is a Monday in the same ISO week as Sep 1; clamping splits it.
		expect(terminalOf(plan, alpha.atomIds[0]!).key).toBe("2026/08/w6/31/10");
		const shared = terminalOf(plan, alpha.atomIds[1]!);
		expect(shared.key).toBe("2026/09/w1/01/10");
		expect(terminalOf(plan, beta.atomIds[0]!).key).toBe(shared.key);
		expect(shared.projects).toEqual(["/work/alpha", "/work/beta"]);
		expect(shared.sessions).toHaveLength(2);
		expect(shared.entries.map(entry => entry.sessionId).sort()).toEqual(shared.sessions);

		for (const node of walkPlan(plan)) expect(node.atomCount).toBeGreaterThan(0);
		expect([...walkPlan(plan)].filter(node => node.level === "week").map(node => node.key)).toEqual([
			"2026/08/w6",
			"2026/09/w1",
		]);
	});

	it("keys buckets by the configured zone and keeps a repeated DST hour together", async () => {
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000003",
			batches: [
				[
					atom("Late night", "2026-09-03T02:00:00.000Z"),
					atom("First pass of the repeated hour", "2026-11-01T05:30:00.000Z"),
					atom("Second pass of the repeated hour", "2026-11-01T06:30:00.000Z"),
				],
			],
		});
		const corpus = await loadChronicleCorpus(sessionsDir);
		expect(terminalOf(buildPlan(corpus.atoms, config())!, written.atomIds[0]!).key).toBe("2026/09/w1/03/02");
		expect(
			terminalOf(buildPlan(corpus.atoms, config({ timeZone: "America/Sao_Paulo" }))!, written.atomIds[0]!).key,
		).toBe("2026/09/w1/02/23");

		const ny = buildPlan(corpus.atoms, config({ timeZone: "America/New_York" }))!;
		const repeated = terminalOf(ny, written.atomIds[1]!);
		expect(repeated.key).toBe("2026/11/w1/01/01");
		expect(terminalOf(ny, written.atomIds[2]!)).toBe(repeated);
	});

	it("splits dense hours and paginates identical timestamps without dropping atoms, within bounded hops", async () => {
		const spread = Array.from({ length: 10 }, (_, minute) =>
			atom(`Spread ${minute}`, `2026-09-10T09:${String(minute * 5).padStart(2, "0")}:00.000Z`),
		);
		const burst = Array.from({ length: 60 }, (_, n) => atom(`Burst ${n}`, "2026-09-10T15:07:00.000Z"));
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000004",
			batches: [spread, burst],
		});
		const cfg = config({ terminalAtoms: 2, hopTokens: 400 });
		const corpus = await loadChronicleCorpus(sessionsDir);
		const plan = buildPlan(corpus.atoms, cfg)!;

		const terminals = leaves(plan);
		const placed = terminals.flatMap(node => node.entries.map(entry => entry.id));
		expect(placed.sort()).toEqual([...written.atomIds].sort());
		for (const node of terminals) expect(node.entries.length).toBeLessThanOrEqual(2);
		const pages = terminals.filter(node => node.level === "page");
		expect(pages).toHaveLength(30);
		for (const node of walkPlan(plan)) expect(node.children.length).toBeLessThanOrEqual(maxFanout(cfg));
		expect([...walkPlan(plan)].some(node => node.level === "group")).toBe(true);

		await index({ config: cfg });
		for (const node of await allNodes(root)) {
			expect(estimateTokens(routingText(node))).toBeLessThanOrEqual(cfg.hopTokens);
		}
	});

	it("enumerates every atom in its terminal bucket with stubs, marking a clipped lead", async () => {
		const long = `${"The migration rewrote the schema cache. ".repeat(40)}Final line.`;
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000005",
			batches: [
				[
					atom("Schema cache rewrite", "2026-09-12T08:10:00.000Z", long),
					atom("Short follow-up", "2026-09-12T08:20:00.000Z"),
				],
			],
		});
		await index();
		const stored = await readViewNode(root, "2026/09/w2/12/08");
		if (stored.state !== "ok") throw new Error("terminal missing");
		const terminal = stored.node;
		expect(terminal.atoms?.map(entry => entry.id)).toEqual(written.atomIds);
		const markdown = await Bun.file(path.join(nodeDir(root, terminal.key), "NODE.md")).text();
		for (const entry of terminal.atoms!) {
			expect(markdown).toContain(entry.id);
			const stub = await Bun.file(path.join(nodeDir(root, terminal.key), entry.stub)).text();
			expect(stub).toContain(`id: ${entry.id}`);
			expect(stub).toContain(`Canonical atom: ${entry.beatFile}`);
		}
		const clipped = terminal.atoms!.find(entry => entry.id === written.atomIds[0])!;
		expect(clipped.leadRemainder).toBeGreaterThan(0);
		expect(clipped.route).toMatch(/\[\+\d+ chars in canonical atom\]/);
		expect(clipped.stub).toMatch(/^20260912T081000Z-schema-cache-rewrite-[0-9a-z]{12}\.md$/i);
	});

	it("regenerates only the changed atom's ancestor chain and marks the view incomplete while writing", async () => {
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000006",
			batches: [
				[
					atom("Week two alpha", "2026-09-08T09:00:00.000Z"),
					atom("Week two beta", "2026-09-09T11:00:00.000Z"),
					atom("Week three gamma", "2026-09-15T12:00:00.000Z"),
					atom("Week three delta", "2026-09-17T13:00:00.000Z"),
				],
			],
		});
		const first = await index();
		expect(first.complete).toBe(true);
		expect((await readViewManifest(root))?.complete).toBe(true);

		const corpus = await loadChronicleCorpus(sessionsDir);
		const changed = corpus.atoms.find(entry => entry.id === written.atomIds[2])!;
		const beforeEdit = await snapshot(sessionsDir);
		const text = await Bun.file(changed.beatFile).text();
		await Bun.write(changed.beatFile, text.replace("Details of week three gamma", "Revised details of gamma"));

		const dry = await index({ dryRun: true });
		const terminalKey = "2026/09/w3/15/12";
		expect(new Set(dry.changes.map(change => change.key))).toEqual(new Set(ancestorsOf(terminalKey)));
		expect(dry.changes.find(change => change.key === terminalKey)?.reason).toBe("inputs-changed");

		const manifestDuringWrite: (boolean | undefined)[] = [];
		const watching: ChronicleSummarizer = {
			identity: summarizer.identity,
			async summarize(...args) {
				manifestDuringWrite.push((await readViewManifest(root))?.complete);
				return summarizer.summarize(...args);
			},
		};
		const callsBefore = fake.summaryCalls;
		const refreshed = await index({ summarizer: watching });
		const generated = refreshed.changes.filter(change => change.outcome === "generated").map(change => change.key);
		expect(new Set(generated)).toEqual(new Set(ancestorsOf(terminalKey)));
		expect(refreshed.nodes.fresh).toBe(refreshed.nodes.total - generated.length);
		expect(fake.summaryCalls - callsBefore).toBe(manifestDuringWrite.length);
		expect(manifestDuringWrite.length).toBeGreaterThan(0);
		expect(manifestDuringWrite.every(complete => complete === false)).toBe(true);
		expect(refreshed.complete).toBe(true);

		// Indexing reads canonical atoms only: every session file is byte-identical except the one edited above.
		const afterIndex = await snapshot(sessionsDir);
		const differing = [...afterIndex].filter(([file, hash]) => beforeEdit.get(file) !== hash).map(([file]) => file);
		expect(differing).toEqual([path.relative(sessionsDir, changed.beatFile)]);
	});

	it("detects model, timezone, and render drift without --rebuild and repairs corrupt nodes", async () => {
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000007",
			batches: [[atom("One", "2026-09-08T09:00:00.000Z"), atom("Two", "2026-09-09T11:00:00.000Z")]],
		});
		await index();

		const other = createFakeChronicleModel({ id: "another-summary-model" });
		const modelDry = await index({ dryRun: true, summarizer: createSummarizer(other.client) });
		const reasons = new Map(modelDry.changes.map(change => [change.key, change.reason]));
		expect(reasons.get("2026/09/w2")).toBe("model-changed");
		expect(reasons.has("2026/09/w2/08/09")).toBe(false);

		const zoneDry = await index({ dryRun: true, config: config({ timeZone: "Etc/UTC" }) });
		expect(new Map(zoneDry.changes.map(change => [change.key, change.reason])).get("2026/09/w2/08/09")).toBe(
			"config-changed",
		);

		await Bun.write(path.join(nodeDir(root, "2026/09/w2/08"), "NODE.md"), "hand edited\n");
		await Bun.write(path.join(nodeDir(root, "2026/09/w2/09/11"), "node.json"), "{ not json");
		const repaired = await index();
		const byKey = new Map(
			repaired.changes.filter(change => change.outcome === "generated").map(change => [change.key, change.reason]),
		);
		expect(byKey.get("2026/09/w2/08")).toBe("drift");
		expect(byKey.get("2026/09/w2/09/11")).toBe("corrupt");
		expect(repaired.derived.map(problem => problem.key)).toEqual(
			expect.arrayContaining(["2026/09/w2/08", "2026/09/w2/09/11"]),
		);
		for (const node of await allNodes(root)) expect(await verifyRenders(root, node)).toEqual([]);
	});

	it("leaves ancestors of an out-of-window stale node blocked and the view incomplete", async () => {
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000008",
			batches: [[atom("Early", "2026-09-02T09:00:00.000Z"), atom("Later", "2026-09-16T09:00:00.000Z")]],
		});
		await index();
		const corpus = await loadChronicleCorpus(sessionsDir);
		const later = corpus.atoms.find(entry => entry.id === written.atomIds[1])!;
		await Bun.write(later.beatFile, (await Bun.file(later.beatFile).text()).replace("Details of later", "Changed"));

		const report = await index({ until: { kind: "local", prefix: "2026-09-06" } });
		const outcomes = new Map(report.changes.map(change => [change.key, change.outcome]));
		expect(outcomes.get("2026/09/w3/16/09")).toBe("outside-window");
		for (const key of ["2026/09/w3/16", "2026/09/w3", "2026/09", "2026", ""])
			expect(outcomes.get(key)).toBe("blocked");
		expect(report.complete).toBe(false);
		expect((await readViewManifest(root))?.complete).toBe(false);
	});

	it("prunes deleted atoms and reports malformed or dangling canonical data without blocking siblings", async () => {
		const written = await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-000000000009",
			batches: [
				[atom("Kept", "2026-09-08T09:00:00.000Z")],
				[atom("Removed later", "2026-09-20T09:00:00.000Z")],
				[atom("Corrupted later", "2026-09-22T09:00:00.000Z")],
			],
		});
		await index();
		const corpus = await loadChronicleCorpus(sessionsDir);
		const removed = corpus.atoms.find(entry => entry.id === written.atomIds[1])!;
		const corrupted = corpus.atoms.find(entry => entry.id === written.atomIds[2])!;
		await fs.rm(path.dirname(removed.beatFile), { recursive: true });
		await Bun.write(corrupted.beatFile, (await Bun.file(corrupted.beatFile).text()).replace(/^title: .*$/m, ""));
		const transcript = await Bun.file(written.transcriptPath).text();
		await Bun.write(
			written.transcriptPath,
			transcript
				.split("\n")
				.filter(line => !line.includes(`"id":"${written.sourceIds[0]}"`))
				.join("\n"),
		);

		const report = await index();
		expect(report.atoms).toBe(1);
		expect(report.nodes.pruned).toBeGreaterThan(0);
		expect(await Bun.file(path.join(nodeDir(root, "2026/09/w3/20"), "node.json")).exists()).toBe(false);
		expect(report.canonical).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "malformed", path: path.dirname(corrupted.beatFile) }),
				expect.objectContaining({ kind: "dangling-entry", atomId: written.atomIds[0] }),
			]),
		);
		const kept = await readViewNode(root, "2026/09/w2/08/09");
		expect(kept.state === "ok" && kept.node.atoms?.[0]?.id).toBe(written.atomIds[0]!);
	});

	it("refuses view roots that overlap canonical data or unowned directories and leaves them untouched", async () => {
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-00000000000c",
			batches: [[atom("Kept", "2026-09-08T09:00:00.000Z")]],
		});
		const unowned = path.join(agentDir, "notes");
		await Bun.write(path.join(unowned, "keep.txt"), "mine");
		const before = await snapshot(agentDir);
		for (const bad of [sessionsDir, agentDir, path.join(sessionsDir, "inner"), unowned]) {
			await expect(index({ root: bad })).rejects.toThrow(/Refusing/);
		}
		expect(await snapshot(agentDir)).toEqual(before);
		expect(() => nodeDir(root, "2026/../../escape")).toThrow();
	});

	it("treats malformed or content-edited node.json as corrupt: recall discloses it and index repairs it", async () => {
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-00000000000d",
			batches: [[atom("Monday note", "2026-09-08T09:00:00.000Z"), atom("Tuesday note", "2026-09-09T11:00:00.000Z")]],
		});
		await index();
		const weekFile = path.join(nodeDir(root, "2026/09/w2"), "node.json");
		const week = await Bun.file(weekFile).json();
		week.children[0].description = "tampered description";
		await Bun.write(weekFile, JSON.stringify(week));
		const dayFile = path.join(nodeDir(root, "2026/09/w2/09"), "node.json");
		const day = await Bun.file(dayFile).json();
		day.children = [{}];
		await Bun.write(dayFile, JSON.stringify(day));
		expect((await readViewNode(root, "2026/09/w2")).state).toBe("corrupt");
		expect((await readViewNode(root, "2026/09/w2/09")).state).toBe("corrupt");

		const recalled = await recallChronicle({
			root,
			query: "tuesday note",
			budget: 1,
			beam: 2,
			neighborhoodMinutes: 90,
			ranker: lexicalRanker,
		});
		expect(recalled.view.viewStale).toBe(true);
		expect(recalled.trace.some(step => step.action === "view-drift" && step.node === "2026/09/w2")).toBe(true);

		const repaired = await index();
		const reasons = new Map(
			repaired.changes.filter(change => change.outcome === "generated").map(c => [c.key, c.reason]),
		);
		expect(reasons.get("2026/09/w2")).toBe("corrupt");
		expect(reasons.get("2026/09/w2/09")).toBe("corrupt");
		expect((await readViewNode(root, "2026/09/w2")).state).toBe("ok");
	});

	it("publishes the incomplete manifest before any node is written", async () => {
		await writeSessionAtoms(sessionsDir, {
			cwd: "/work/alpha",
			sessionId: "a1a1a1a1-0000-7000-8000-00000000000e",
			batches: [Array.from({ length: 6 }, (_, n) => atom(`Parallel ${n}`, `2026-09-0${n + 1}T0${n}:00:00.000Z`))],
		});
		const original = viewModule.writeViewNode;
		const seen: (boolean | null)[] = [];
		const spy = spyOn(viewModule, "writeViewNode").mockImplementation(async (...args) => {
			seen.push((await readViewManifest(root))?.complete ?? null);
			return original(...args);
		});
		try {
			await index();
		} finally {
			spy.mockRestore();
		}
		expect(seen.length).toBeGreaterThan(6);
		expect(seen.every(complete => complete === false)).toBe(true);
	});
});
