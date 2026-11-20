import { expect, test } from "bun:test";
import * as path from "node:path";
import { parseFrontmatter, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { ChronicleTool, FinishChronicleTool, ReadChronicleTool } from "../../src/chronicler/chronicle-tool";
import { ChroniclerStore, readCommittedChroniclerBatches } from "../../src/chronicler/store";

test("discovers and reads an older beat outside the newest 200 without filesystem access", async () => {
	const temp = TempDir.createSync("chronicler-discovery-");
	try {
		const store = new ChroniclerStore(temp.path(), { sessionId: "session", project: "project", model: "mock/model" });
		await store.open();
		const source = { id: "evidence", parentId: null, timestamp: "2026-09-08T00:00:00.000Z" };
		const batch = store.beginBatch([source]);
		for (let index = 0; index < 205; index++) {
			store.stageBeat(batch, {
				title: index === 0 ? "SECRET ".repeat(100) : `Beat ${index}`,
				kind: "concept",
				body: `Standalone evidence ${index}. SECRET`,
				topics: [],
				sources: [source.id],
				eventTime: source.timestamp,
				related: [],
			});
		}
		batch.finalized = true;
		await store.commitBatch(batch);
		const attempt = store.beginBatch([]);
		const reader = new ReadChronicleTool(store, attempt, {
			obfuscate: value => value.replaceAll("SECRET", "redacted"),
		});
		const listed = await reader.execute("list", { offset: 200, limit: 10 });
		const listing = listed.content[0];
		if (listing.type !== "text") throw new Error("Expected textual metadata page");
		const page = JSON.parse(listing.text) as {
			beats: { id: string; title: string }[];
			total: number;
			nextOffset: number | null;
		};
		expect(page.total).toBe(205);
		expect(page.beats.map(beat => beat.id)).toEqual(
			store.beats
				.slice(0, 5)
				.reverse()
				.map(beat => beat.id),
		);
		expect(page.nextOffset).toBeNull();
		expect(listing.text).not.toContain("SECRET");
		expect(page.beats.at(-1)!.title.length).toBeLessThan(400);
		const oldest = page.beats.at(-1)!;
		const read = await reader.execute("read", { id: oldest.id });
		expect(JSON.stringify(read.content)).toContain("Standalone evidence 0. redacted");
		await expect(reader.execute("bad", { id: "../arbitrary" })).rejects.toThrow();
		await expect(reader.execute("bad", { offset: -1 })).rejects.toThrow();
		await expect(reader.execute("bad", { limit: 101 })).rejects.toThrow();
		await expect(reader.execute("bad", { id: oldest.id, offset: 0 })).rejects.toThrow();
		const first = await reader.execute("first", {});
		if (first.content[0].type !== "text") throw new Error("Expected textual page");
		const initial = JSON.parse(first.content[0].text) as { beats: { id: string }[]; nextOffset: number };
		expect(initial.beats).toHaveLength(50);
		expect(initial.nextOffset).toBe(50);
		const second = await reader.execute("next", { offset: initial.nextOffset });
		if (second.content[0].type !== "text") throw new Error("Expected textual page");
		const next = JSON.parse(second.content[0].text) as { beats: { id: string }[] };
		expect(next.beats[0].id).toBe(store.beats[154].id);
		attempt.revoked = true;
		await expect(reader.execute("late", {})).rejects.toThrow();
	} finally {
		await temp.remove();
	}
});

test("round-trips optional Chronicler notes without adding a field to ordinary atoms", async () => {
	const temp = TempDir.createSync("chronicler-frontmatter-note-");
	try {
		const meta = { sessionId: "session", project: "project", model: "mock/model" };
		const store = new ChroniclerStore(temp.path(), meta);
		await store.open();
		const source = { id: "evidence", parentId: null, timestamp: "2026-09-08T00:00:00.000Z" };
		const batch = store.beginBatch([source]);
		const tool = new ChronicleTool(store, batch, new Map([[source.id, source]]));
		for (const [title, note] of [
			[
				"With editorial context",
				"That label was the agent's, not a self-description.\nA second line: still my reservation.",
			],
			["Ordinary beat", undefined],
			["Whitespace is silence", "  \n "],
		] as const) {
			await tool.execute(title, {
				title,
				kind: "reflection",
				body: "The agent distinguished attribution from endorsement.",
				topics: [],
				sources: [source.id],
				...(note === undefined ? {} : { chronicler_note: note }),
			});
		}
		await new FinishChronicleTool(store, batch, new Map([[source.id, source]])).execute("finish", { carry: null });
		await store.commitBatch(batch);
		const reopened = new ChroniclerStore(temp.path(), meta);
		await reopened.open();
		const [annotated, ordinary, blank] = reopened.beats;
		expect(annotated!.chroniclerNote).toBe(
			"That label was the agent's, not a self-description.\nA second line: still my reservation.",
		);
		expect(ordinary!.chroniclerNote).toBeUndefined();
		expect(blank!.chroniclerNote).toBeUndefined();
		for (const beat of reopened.beats) {
			const { frontmatter } = parseFrontmatter(await Bun.file(path.join(temp.path(), beat.path)).text(), {
				rawKeys: true,
			});
			expect(frontmatter.chronicler_note).toBe(beat.chroniclerNote);
			expect(Object.hasOwn(frontmatter, "chronicler_note")).toBe(beat === annotated);
		}
		const snapshots = await readCommittedChroniclerBatches(temp.path());
		expect(snapshots[0]!.beats.map(beat => beat.chroniclerNote)).toEqual(
			reopened.beats.map(beat => beat.chroniclerNote),
		);
		const read = await new ReadChronicleTool(reopened, reopened.beginBatch([])).execute("read", {
			id: annotated!.id,
		});
		expect(JSON.stringify(read.content)).toContain("That label was the agent's");
	} finally {
		await temp.remove();
	}
});

test("retains recording limits across empty carry, restart and an omitted update, then explicitly clears them", async () => {
	const temp = TempDir.createSync("chronicler-recording-limits-");
	try {
		const settings = Settings.isolated({ "chronicler.capture.carryChars": 0 });
		const meta = { sessionId: "session", project: "project", model: "mock/model" };
		const store = new ChroniclerStore(temp.path(), meta, {}, false, settings);
		await store.open();
		const source = { id: "directive", parentId: null, timestamp: "2026-09-08T00:00:00.000Z" };
		const limits = { sources: [source.id], text: "Exclude the named private topic in later passes too." };
		const batch = store.beginBatch([source]);
		await new FinishChronicleTool(store, batch, new Map([[source.id, source]]), settings).execute("finish", {
			carry: null,
			recording_limits: limits,
		});
		await store.commitBatch(batch);
		const resumed = new ChroniclerStore(temp.path(), meta, {}, false, settings);
		await resumed.open();
		expect(resumed.recordingLimits).toEqual(limits);
		expect(resumed.carry).toBeNull();
		const next = resumed.beginBatch([]);
		await new FinishChronicleTool(resumed, next, resumed.sourceEntries, settings).execute("finish", { carry: null });
		await resumed.commitBatch(next);
		const later = new ChroniclerStore(temp.path(), meta, {}, false, settings);
		await later.open();
		expect(later.recordingLimits).toEqual(limits);
		const clear = later.beginBatch([]);
		await new FinishChronicleTool(later, clear, later.sourceEntries, settings).execute("finish", {
			carry: null,
			recording_limits: null,
		});
		await later.commitBatch(clear);
		const cleared = new ChroniclerStore(temp.path(), meta, {}, false, settings);
		await cleared.open();
		expect(cleared.recordingLimits).toBeNull();
	} finally {
		await temp.remove();
	}
});

test("rereads committed paused sources after restart but never crosses the visible transcript boundary", async () => {
	const temp = TempDir.createSync("chronicler-paused-source-");
	try {
		const meta = { sessionId: "session", project: "project", model: "mock/model" };
		const store = new ChroniclerStore(temp.path(), meta);
		await store.open();
		const source = { id: "paused", parentId: null, timestamp: "2026-09-08T00:00:00.000Z" };
		const batch = store.beginBatch([source]);
		batch.finalized = true;
		await store.commitBatch(batch);
		const resumed = new ChroniclerStore(temp.path(), meta);
		await resumed.open();
		const attempt = resumed.beginBatch([]);
		const visible = [
			{
				...source,
				message: {
					role: "user" as const,
					content: "We chose a durable queue for the backlog.",
					timestamp: Date.now(),
				},
			},
		];
		const reader = new ReadChronicleTool(resumed, attempt, undefined, undefined, visible);
		const reread = await reader.execute("catch-up", { source: source.id });
		expect(JSON.stringify(reread.content)).toContain("We chose a durable queue");
		await expect(reader.execute("unknown", { source: "other-session" })).rejects.toThrow("Unknown source");
		await expect(reader.execute("mixed", { source: source.id, id: "beat" })).rejects.toThrow("source alone");
		const blinded = new ReadChronicleTool(resumed, attempt, undefined, undefined, []);
		await expect(blinded.execute("hidden", { source: source.id })).rejects.toThrow("unavailable");
	} finally {
		await temp.remove();
	}
});
