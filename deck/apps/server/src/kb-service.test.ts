import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { broadcastBus, type BroadcastFrame } from "./broadcast-bus.ts";
import { KbService } from "./kb-service.ts";
import { startKbWatcher } from "./kb-watcher.ts";

let root: string;

function put(rel: string, content = `# ${rel}\n`): void {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "npi-deck-kbignore-"));
	put("notes/hub.md", "# Hub\n\nSee [[idea]], [[secret]], [[kept]] and [[tossed]]. needle\n");
	put("drafts/idea.md", "# Idea\n\nneedle\n");
	put("private/secret.md", "# Secret\n\nneedle\n");
	put("notes/private/public-after-all.md", "# Nested private\n");
	put("journal/today.tmp.md", "# Temp\n\nneedle\n");
	put("archive/kept.md", "# Kept\n");
	put("archive/tossed.md", "# Tossed\n\nneedle\n");
	put("node_modules/pkg/readme.md", "# Vendor\n\nneedle\n");
	writeFileSync(
		path.join(root, ".kbignore"),
		[
			"# kb-local exclusions",
			"drafts/",
			"/private",
			"*.tmp.md",
			"archive/**",
			"!archive/kept.md",
			"!node_modules/",
			"",
		].join("\n"),
		"utf8",
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("KbService with .kbignore", () => {
	test("tree hides ignored dirs and files but keeps negated ones", async () => {
		const kb = new KbService({ root });
		const top = await kb.getTree("");
		expect(top?.dirs.map((d) => d.name)).toEqual(["archive", "journal", "notes"]);
		expect((await kb.getTree("archive"))?.files.map((f) => f.name)).toEqual(["kept.md"]);
		expect((await kb.getTree("journal"))?.files).toEqual([]);
		// `/private` is anchored: a nested `private/` is still shown.
		expect((await kb.getTree("notes"))?.dirs.map((d) => d.name)).toEqual(["private"]);
		expect(await kb.getTree("drafts")).toBeUndefined();
		expect(await kb.getTree("private")).toBeUndefined();
		// Skip-set dirs stay hidden even when .kbignore negates them.
		expect(await kb.getTree("node_modules")).toBeUndefined();
		expect(top?.dirs.find((d) => d.name === "notes")?.mdCount).toBe(2);
	});

	test("ignored files are not readable, writable, searchable or graphed", async () => {
		const kb = new KbService({ root });
		expect(await kb.getFile("drafts/idea.md")).toBeUndefined();
		expect(await kb.getFile("journal/today.tmp.md")).toBeUndefined();
		expect(await kb.getFile("archive/kept.md")).toBeDefined();
		expect(await kb.saveFile("drafts/new.md", "# New\n", "create")).toEqual({ kind: "invalid-path" });

		const search = await kb.search("needle", 50);
		expect(search.results.map((r) => r.path)).toEqual(["notes/hub.md"]);

		const graph = await kb.getGraph();
		expect(graph.nodes.map((n) => n.path).sort()).toEqual([
			"archive/kept.md",
			"notes/hub.md",
			"notes/private/public-after-all.md",
		]);
		expect(graph.edges).toEqual([{ source: "notes/hub.md", target: "archive/kept.md" }]);
		const hub = await kb.getFile("notes/hub.md");
		expect(hub?.outgoingLinks.filter((l) => l.resolved).map((l) => l.target)).toEqual(["kept"]);
	});

	test("an edited .kbignore applies after the index is invalidated", async () => {
		const kb = new KbService({ root });
		expect((await kb.getTree(""))?.dirs.map((d) => d.name)).not.toContain("drafts");
		writeFileSync(path.join(root, ".kbignore"), "journal/\n", "utf8");
		kb.invalidate();
		const names = (await kb.getTree(""))?.dirs.map((d) => d.name);
		expect(names).toEqual(["archive", "drafts", "notes", "private"]);
		expect((await kb.search("needle", 50)).results.map((r) => r.path)).toContain("drafts/idea.md");
	});

	test("parent directory notifications respect directory-only exclusions without hiding replacement files", () => {
		const kb = new KbService({ root });
		// Windows reports `change: drafts` as well as the new child's event.
		expect(kb.isWatchEventIgnored("drafts")).toBe(true);
		expect(kb.isWatchEventIgnored("drafts\\another.md")).toBe(true);
		expect(kb.isWatchEventIgnored(".kbignore")).toBe(false);
		expect(kb.isWatchEventIgnored("")).toBe(false);

		rmSync(path.join(root, "drafts"), { recursive: true });
		// A deleted entry has unknown type, so its notification still refreshes.
		expect(kb.isWatchEventIgnored("drafts")).toBe(false);
		put("drafts", "a visible file, not an excluded directory");
		expect(kb.isWatchEventIgnored("drafts")).toBe(false);
	});

	test("directory notifications follow edited ignore rules after invalidation", () => {
		const kb = new KbService({ root });
		expect(kb.isWatchEventIgnored("drafts")).toBe(true);
		writeFileSync(path.join(root, ".kbignore"), "", "utf8");
		kb.invalidate();
		expect(kb.isWatchEventIgnored("drafts")).toBe(false);
	});

	test("the watcher ignores excluded paths and reloads on .kbignore edits", async () => {
		const prev = process.env.NPI_DECK_WATCH_KB;
		delete process.env.NPI_DECK_WATCH_KB;
		const kb = new KbService({ root });
		await kb.ensureIndex();
		const frames: BroadcastFrame[] = [];
		const unsubscribe = broadcastBus.subscribe((f) => {
			if (f.type === "kb_changed") frames.push(f);
		});
		const dispose = startKbWatcher(kb);
		// A separate, read-only observer records native events without changing
		// the production watcher's callback or exclusion decisions.
		const started = Date.now();
		let phase = "settling";
		const events: { ms: number; phase: string; event: string; filename: string | null; ignored: boolean }[] = [];
		const diagnostic = watch(root, { recursive: true, persistent: false }, (event, filename) => {
			const rel = filename?.toString() ?? null;
			events.push({
				ms: Date.now() - started,
				phase,
				event,
				filename: rel,
				ignored: rel !== null && kb.isWatchEventIgnored(rel),
			});
		});
		const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 700));
		try {
			await settle();
			frames.length = 0;
			phase = "excluded-writes";
			put("drafts/another.md");
			put("private/more.md");
			put("node_modules/pkg/other.md");
			await settle();
			if (frames.length !== 0) {
				console.error("KB_WATCHER_DIAGNOSTIC", JSON.stringify({ platform: process.platform, events, frames }));
			}
			expect(frames).toHaveLength(0);

			writeFileSync(path.join(root, ".kbignore"), "", "utf8");
			await settle();
			expect(frames.length).toBeGreaterThan(0);
			expect((await kb.getTree(""))?.dirs.map((d) => d.name)).toContain("drafts");

			frames.length = 0;
			put("drafts/third.md");
			await settle();
			expect(frames.length).toBeGreaterThan(0);
		} finally {
			diagnostic.close();
			dispose();
			unsubscribe();
			if (prev === undefined) delete process.env.NPI_DECK_WATCH_KB;
			else process.env.NPI_DECK_WATCH_KB = prev;
		}
	});

	test("NPI_DECK_KB_EXCLUDE_DIRS still applies alongside .kbignore", async () => {
		const script = `
			import { KbService } from ${JSON.stringify(path.join(import.meta.dir, "kb-service.ts"))};
			const kb = new KbService({ root: ${JSON.stringify(root)} });
			const tree = await kb.getTree("");
			console.log(JSON.stringify(tree.dirs.map((d) => d.name)));
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: { ...process.env, NPI_DECK_KB_EXCLUDE_DIRS: "notes, journal" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual(["archive"]);
	});
});

describe("KbService orphan census", () => {
	test("lists indexed notes nothing else links to; ignored notes and self-links do not count", async () => {
		// drafts/ is ignored, so its link cannot rescue public-after-all, and
		// public-after-all's link to itself is not a backlink.
		put("drafts/idea.md", "# Idea\n\n[[public-after-all]]\n");
		put("notes/private/public-after-all.md", "# Nested\n\n[[public-after-all]] and [[missing-note]]\n");
		const census = await new KbService({ root }).getOrphanCensus();
		expect(census.root).toBe(path.resolve(root));
		expect(census.notes).toBe(3);
		expect(census.orphans).toEqual([
			{ path: "notes/hub.md", title: "hub", outbound: 1 },
			{ path: "notes/private/public-after-all.md", title: "public-after-all", outbound: 0 },
		]);
		// hub → idea, secret, tossed (all ignored) plus public-after-all → missing-note.
		expect(census.unresolvedLinks).toBe(4);
	});
});

describe("KbService literal full-text search", () => {
	test("different warm queries preserve literal hits, snippets, scores and metadata", async () => {
		put("notes/alpha.md", "+++\nname = 'Human heading'\ntags = ['topic']\n+++\nxxMiXeD::needleYY mixed::needle\n");
		put("notes/beta.md", "# Other\nOnly second/pattern appears here.\n");
		// All query trigrams occur, but not in the query's order.
		put("notes/decoy.md", "# Decoy\nmix ixe xed ed: d:: ::n :ne nee eed edl dle\n");
		const kb = new KbService({ root });
		await kb.getBacklinks("notes/alpha.md");
		const first = await kb.search("mixed::needle", 50);
		expect(first.results).toHaveLength(1);
		expect(first.results[0]).toMatchObject({
			path: "notes/alpha.md", title: "Human heading", score: 11, matchKind: "body",
		});
		expect(first.results[0]?.snippet).toContain("MiXeD::needle");
		const second = await kb.search("second/pattern", 50);
		expect(second.results.map((r) => r.path)).toEqual(["notes/beta.md"]);
		expect(second.results[0]?.snippet).toContain("second/pattern");
		expect((await kb.search("human heading", 50)).results[0]).toMatchObject({
			path: "notes/alpha.md", title: "Human heading", score: 70, matchKind: "title",
		});
		expect((await kb.search("topic", 50)).results[0]).toMatchObject({
			path: "notes/alpha.md", score: 60, matchKind: "tag",
		});
		expect((await kb.search("alpha", 50)).results[0]).toMatchObject({
			path: "notes/alpha.md", score: 100, matchKind: "stem",
		});
	});

	test("short, Unicode and repeated substrings keep literal occurrence semantics", async () => {
		put("notes/literals.md", "§§§ Ω😀 punctuation/@! " + "zz ".repeat(25));
		const kb = new KbService({ root });
		for (const [query, score] of [["§", 12], ["§§", 10], ["Ω😀", 10], ["/@!", 10], ["zz", 30]] as const) {
			const response = await kb.search(query, 50);
			expect(response.results).toHaveLength(1);
			expect(response.results[0]).toMatchObject({ path: "notes/literals.md", matchKind: "body", score });
			expect(response.results[0]?.snippet).toContain(query);
		}
		expect((await kb.search("not-present-anywhere", 50)).totalMatches).toBe(0);
	});

	test("invalidation refreshes body hits and reverse edges across concurrent cold readers", async () => {
		put("notes/source.md", "Old-unique marker [[kept]]\n");
		const kb = new KbService({ root });
		const pending = kb.search("old-unique", 50);
		put("notes/source.md", "New-unique marker [[hub]]\n");
		kb.invalidate();
		const [oldHits, newHits, backlinks] = await Promise.all([
			pending, kb.search("new-unique", 50), kb.getBacklinks("notes/hub.md"),
		]);
		expect(oldHits.totalMatches).toBe(0);
		expect(newHits.results.map((r) => r.path)).toEqual(["notes/source.md"]);
		expect(backlinks?.backlinks.map((b) => b.source)).toEqual(["notes/source.md"]);
		put("notes/source.md", "Replacement marker [[kept]]\n");
		kb.invalidate();
		expect((await kb.search("new-unique", 50)).totalMatches).toBe(0);
		expect((await kb.search("replacement marker", 50)).results.map((r) => r.path)).toEqual(["notes/source.md"]);
		expect((await kb.getBacklinks("notes/hub.md"))?.backlinks).toEqual([]);
		expect((await kb.getBacklinks("archive/kept.md"))?.backlinks.map((b) => b.source).sort()).toEqual(["notes/hub.md", "notes/source.md"]);
	});
});

describe("native TOML frontmatter and non-destructive YAML import", () => {
	test("imports a same-mode sibling once, retains exact YAML and indexes one logical note", async () => {
		const legacy = "---\n# exact YAML comment\nname: Human title # inline title comment\ntags: [entry, topic]\ncustom:\n  # nested KB comment\n  empty: null\n---\nUnique native search text\n[[kept]]\n";
		put("notes/imported.md", legacy);
		chmodSync(path.join(root, "notes/imported.md"), 0o640);
		const kb = new KbService({ root });
		const note = (await kb.getFile("notes/imported.md"))!;
		expect(note.frontmatter).toEqual({ name: "Human title", tags: ["entry", "topic"], custom: { empty: null } });
		expect(note.rawContent.startsWith("+++\n")).toBe(true);
		expect(note.rawContent).toContain("# exact YAML comment");
		expect(note.rawContent).toContain("inline title comment");
		expect(note.rawContent).toContain("nested KB comment");
		expect(note.absolutePath).toBe(path.join(root, "notes/imported.toml.md"));
		expect(readFileSync(path.join(root, "notes/imported.md"), "utf8")).toBe(legacy);
		expect(statSync(note.absolutePath).mode & 0o777).toBe(0o640);
		expect((await kb.getTree("notes"))!.files.filter(file => file.name.startsWith("imported")).map(file => file.path)).toEqual(["notes/imported.md"]);
		const graph = await kb.getGraph();
		expect(graph.nodes.filter(node => node.path.includes("imported")).map(node => node.path)).toEqual(["notes/imported.md"]);
		expect(graph.edges).toContainEqual({ source: "notes/imported.md", target: "archive/kept.md" });
		expect((await kb.search("Unique native search", 20)).results.map(result => result.path)).toEqual(["notes/imported.md"]);
		const edited = note.rawContent.replace("Human title", "Edited title");
		expect((await kb.saveFile("notes/imported.md", edited, "update")).kind).toBe("ok");
		const restarted = new KbService({ root });
		expect((await restarted.getFile("notes/imported.md"))?.frontmatter.name).toBe("Edited title");
		expect(readFileSync(path.join(root, "notes/imported.md"), "utf8")).toBe(legacy);
	});

	test("a canonical sibling wins without parsing or overwriting the original, including invalid native TOML", async () => {
		const legacy = "---\nname: [broken\n---\nLegacy content\n";
		put("notes/winner.md", legacy);
		put("notes/winner.toml.md", "+++\nname = 'Native winner'\n+++\nCanonical content\n");
		const kb = new KbService({ root });
		expect((await kb.getFile("notes/winner.md"))?.frontmatter.name).toBe("Native winner");
		expect((await kb.getTree("notes"))!.files.filter(file => file.name.startsWith("winner"))).toHaveLength(1);
		put("notes/winner.toml.md", "+++\nname = [broken\n+++\nCanonical content\n");
		kb.invalidate();
		const invalid = (await kb.getFile("notes/winner.md"))!;
		expect(invalid.frontmatterError).toBeDefined();
		expect(invalid.rawContent).toContain("Canonical content");
		expect(readFileSync(path.join(root, "notes/winner.md"), "utf8")).toBe(legacy);
	});

	test("raw editing accepts TOML, rejects YAML and malformed native headers without changing stored content", async () => {
		const kb = new KbService({ root });
		const raw = "+++\n# keep\nname = 'Native'\n[custom]\n# nested comment\ntags = ['one', 'two']\n+++\nBody\n";
		expect((await kb.saveFile("notes/new.md", raw, "create")).kind).toBe("ok");
		expect((await kb.getFile("notes/new.md"))?.rawContent).toBe(raw);
		expect((await kb.saveFile("notes/new.md", "---\nname: Legacy\n---\nBody", "update")).kind).toBe("invalid-frontmatter");
		expect((await kb.saveFile("notes/new.md", "+++\nname = [broken\n+++\nBody", "update")).kind).toBe("invalid-frontmatter");
		expect((await kb.getFile("notes/new.md"))?.rawContent).toBe(raw);
	});

	test("external SKILL.md keeps interoperable YAML without creating an owned metadata sibling", async () => {
		const raw = "---\nname: external-skill\ndescription: Keep external YAML\n---\n# Skill\n";
		put("notes/example/SKILL.md", raw);
		const kb = new KbService({ root });
		const skill = (await kb.getFile("notes/example/SKILL.md"))!;
		expect(skill.frontmatter).toEqual({ name: "external-skill", description: "Keep external YAML" });
		expect(skill.body).toBe("# Skill\n");
		expect(skill.rawContent).toBe(raw);
		expect(readFileSync(path.join(root, "notes/example/SKILL.md"), "utf8")).toBe(raw);
		expect(existsSync(path.join(root, "notes/example/SKILL.toml.md"))).toBe(false);
	});
});
