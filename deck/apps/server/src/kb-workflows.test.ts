import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KbService } from "./kb-service.ts";
import {
	kbProject,
	kbPrompt,
	kbSessionIdentity,
	kbTools,
	writeKb,
	readKb,
	type KbAgentIdentity,
} from "./kb-workflows.ts";
import { buildKbRouter } from "./routes-kb.ts";
import { buildOnboardingRouter } from "./routes-onboarding.ts";
import { createKbAgentTools } from "./kb-cli-extension.ts";
import { executeDeckSlashCommand } from "./deck-slash-commands.ts";
import { closeDb, openDb } from "./db/index.ts";
import { createInbox, getInbox, listInbox } from "./db/inbox.ts";
import { createV1Routine } from "./db/routines.ts";
import { RoutinesRunner } from "./routines-runner.ts";
import { stringifySettingsToml as stringifyToml } from "@oh-my-pi/pi-utils/settings-toml";

let root: string;
let vault: string;
let project: string;
let kb: KbService;
let identity: KbAgentIdentity;
let saved: Record<string, string | undefined>;
const keys = ["HOME", "NPI_DECK_HOME", "NPI_DECK_DB_PATH", "NPI_DECK_KB_ROOT"];
async function note(relative: string, content: string) {
	await mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
	await writeFile(path.join(vault, relative), content);
}
beforeEach(async () => {
	saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	root = await mkdtemp(path.join(os.tmpdir(), "deck-kb-workflow-"));
	vault = path.join(root, "vault");
	project = path.join(root, "neodeck");
	await mkdir(path.join(project, ".git"), { recursive: true });
	await note("broad.md", "+++\nname = 'Broad topic'\ntags = ['entry']\n+++\n[[middle]]\n");
	await note("middle.md", "# Middle\n[[target]]\n");
	await note("target.md", "# Target\nDecision: use narrow traversal.\n");
	await note("projects/neodeck/learned.md", "# Project learning\n[[broad]]\n");
	await note("projects/neopi/adrs/choice.md", "Protected foreign ADR\n");
	await note("hidden/secret.md", "Secret\n");
	await note(".kbignore", "hidden/\n");
	process.env.HOME = root;
	process.env.NPI_DECK_HOME = root;
	process.env.NPI_DECK_KB_ROOT = vault;
	process.env.NPI_DECK_DB_PATH = path.join(root, "deck.db");
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	kb = new KbService({ root: vault });
	identity = { agentId: "server-agent", projectCwd: project, readOnly: false };
});
afterEach(async () => {
	closeDb();
	for (const key of keys) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	await rm(root, { recursive: true, force: true });
});

test("multi-hop traversal reuses entry and reverse-edge indexes until explicit invalidation", async () => {
	const entry = (await readKb(kb, { operation: "search", query: "Broad topic" })) as any;
	expect(entry.results[0].path).toBe("broad.md");
	expect(entry.results[0].title).toBe("Broad topic");
	await kb.getBacklinks("broad.md");
	const warmEntry = (await readKb(kb, { operation: "search", query: "Broad topic" })) as any;
	expect(warmEntry.results).toEqual(entry.results);
	await note("projects/neodeck/learned.md", "# Changed learning\n[[target]]\n");
	const first = (await readKb(kb, { operation: "links", path: entry.results[0].path })) as any;
	const second = (await readKb(kb, { operation: "links", path: first.links[0].resolved })) as any;
	const target = (await readKb(kb, { operation: "open", path: second.links[0].resolved })) as any;
	expect(target.body).toContain("Decision: use narrow traversal");
	const back = (await readKb(kb, { operation: "backlinks", path: "target" })) as any;
	expect(back.backlinks.map((link: any) => link.source)).toEqual(["middle.md"]);
	const reverse = (await readKb(kb, { operation: "backlinks", path: "broad.md" })) as any;
	expect(reverse.backlinks[0].source).toBe("projects/neodeck/learned.md");
	expect(((await readKb(kb, { operation: "search", query: "learned" })) as any).results[0].path).toBe(
		"projects/neodeck/learned.md",
	);
	await expect(readKb(kb, { operation: "open", path: "hidden/secret.md" })).rejects.toThrow("excluded");
	await symlink(path.join(vault, "hidden"), path.join(vault, "hidden-alias"));
	await expect(readKb(kb, { operation: "open", path: "hidden-alias/secret.md" })).rejects.toThrow("excluded");
	kb.invalidate();
	expect(((await readKb(kb, { operation: "backlinks", path: "broad" })) as any).backlinks).toEqual([]);
	expect(
		((await readKb(kb, { operation: "backlinks", path: "target" })) as any).backlinks
			.map((link: any) => link.source)
			.sort(),
	).toEqual(["middle.md", "projects/neodeck/learned.md"]);
});

test("ambient chat/routine paths leave prompts untouched; explicit chat reads only the named section", async () => {
	const absent = new KbService({ root: path.join(root, "does-not-exist") });
	expect(await kbPrompt("plain user request", undefined, absent)).toBe("plain user request");
	expect(await kbPrompt("plain routine request", [], absent)).toBe("plain routine request");
	expect(await executeDeckSlashCommand("normal request", { cwd: project, sessionId: "session" })).toBe("fallthrough");
	const explicit = await executeDeckSlashCommand("/kb read target.md", { cwd: project, sessionId: "session" });
	expect(explicit).toMatchObject({ kind: "rewritten" });
	if (explicit !== "fallthrough" && explicit.kind === "rewritten") {
		expect(explicit.prompt).toContain("Decision: use narrow traversal");
		expect(explicit.prompt).not.toContain("Protected foreign ADR");
	}
});

test("an authorized project agent creates its first note in a missing vault", async () => {
	await rm(vault, { recursive: true });
	kb.invalidate();
	await writeKb(kb, identity, {
		path: "projects/neodeck/first.md",
		content: "First learned fact",
		mode: "create",
		kind: "note",
	});
	expect(((await readKb(kb, { operation: "open", path: "projects/neodeck/first.md" })) as any).rawContent).toBe(
		"First learned fact",
	);
});

test("concurrent authorized create operations publish exactly one complete note without overwriting it", async () => {
	const target = "projects/neodeck/concurrent.md";
	const contents = ["First agent's complete note", "Second agent's complete note"];
	const results = await Promise.allSettled(
		contents.map(content => writeKb(kb, identity, { path: target, content, mode: "create", kind: "note" })),
	);
	expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
	expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
	const winner = results.findIndex(result => result.status === "fulfilled");
	expect(await readFile(path.join(vault, target), "utf8")).toBe(contents[winner]);
	await expect(
		writeKb(kb, identity, { path: target, content: "Late overwrite", mode: "create", kind: "note" }),
	).rejects.toThrow("conflict");
	expect(await readFile(path.join(vault, target), "utf8")).toBe(contents[winner]);
});

test("high-entropy notes retain exact literal search and reverse navigation with compact candidate signatures", async () => {
	let state = 17;
	const text = Array.from({ length: 128 * 1024 }, () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return String.fromCharCode(0x4000 + ((state >>> 0) % 0x4000));
	}).join("");
	await note("entropy.md", `${text}\n[[target]]`);
	kb.invalidate();
	for (const query of [text.slice(23, 24), text.slice(49, 51), text.slice(74, 90)]) {
		const result = await kb.search(query, 20);
		expect(result.results.some(hit => hit.path === "entropy.md" && hit.matchKind === "body")).toBe(true);
	}
	expect((await kb.search("impossible-ascii-sequence-zqxv", 20)).results).toEqual([]);
	expect((await kb.getBacklinks("target.md"))?.backlinks.some(link => link.source === "entropy.md")).toBe(true);
});

test("live plan-mode identity blocks KB writes and restores authority after leaving planning", async () => {
	let planning = false;
	const session = { getPlanModeState: () => (planning ? { enabled: true } : undefined) };
	const tools = kbTools(() => kbSessionIdentity("plan-agent", project, session), kb);
	const write = tools.find(tool => tool.name === "kb_write")!;
	const invoke = (name: string) =>
		write.execute(
			"call",
			{ path: `projects/neodeck/${name}.md`, content: "Learning", mode: "create", kind: "note" } as never,
			undefined,
			undefined,
			{} as never,
		);
	await invoke("before-plan");
	planning = true;
	await expect(invoke("during-plan")).rejects.toThrow("forbidden");
	expect(await kb.getFile("projects/neodeck/during-plan.md")).toBeUndefined();
	planning = false;
	await invoke("after-plan");
	expect((await kb.getFile("projects/neodeck/after-plan.md"))?.rawContent).toBe("Learning");
	expect(kbSessionIdentity("gone-agent", project, undefined).readOnly).toBe(true);
});

test("read traversal follows external vault junctions while agent writes still reject symlink aliases", async () => {
	const external = path.join(root, "external-vault");
	await mkdir(external);
	await writeFile(path.join(external, "remote.md"), "# Remote\nexternal-junction-specific text\n[[target]]");
	await symlink(external, path.join(vault, "cryptocracy"), "junction");
	kb.invalidate();
	expect(
		((await readKb(kb, { operation: "open", path: "cryptocracy/remote.md" })) as { rawContent: string }).rawContent,
	).toContain("external-junction-specific");
	expect((await kb.getGraph()).nodes.some(node => node.path.endsWith("/remote.md"))).toBe(true);
	expect(
		(await kb.search("external-junction-specific", 20)).results.some(hit => hit.path.endsWith("/remote.md")),
	).toBe(true);
	await symlink(external, path.join(vault, "projects/neodeck/external"), "junction");
	await expect(
		writeKb(kb, identity, {
			path: "projects/neodeck/external/remote.md",
			content: "forbidden overwrite",
			mode: "update",
			kind: "note",
		}),
	).rejects.toThrow("symlink");
	expect(await readFile(path.join(external, "remote.md"), "utf8")).toContain("external-junction-specific");
});

test("neighbour edge writes require a parsed, resolved link rather than code or nonexistent targets", async () => {
	const target = "projects/neopi/edges/neodeck/validated.md";
	for (const content of [
		"[[projects/neodeck/missing]]",
		"`[[projects/neodeck/learned]]`",
		"```md\n[[projects/neodeck/learned]]\n```",
		"+++\nexample = '[[projects/neodeck/learned]]'\n+++\nNo body link",
	]) {
		await expect(writeKb(kb, identity, { path: target, content, mode: "create", kind: "edge" })).rejects.toThrow(
			"indexed owning project note",
		);
		expect(await kb.getFile(target)).toBeUndefined();
	}
	await writeKb(kb, identity, {
		path: target,
		content: "Affected API: [[projects/neodeck/learned#Discovery|Owning note]]",
		mode: "create",
		kind: "edge",
	});
	expect((await kb.getLinks(target))?.links[0]?.resolved).toBe("projects/neodeck/learned.md");
	expect((await kb.getBacklinks("projects/neodeck/learned.md"))?.backlinks.some(link => link.source === target)).toBe(
		true,
	);
});

test("server-derived common git identity allows own knowledge and neighbour edges, rejecting aliases and foreign decisions", async () => {
	const worktree = path.join(root, "random-checkout");
	await mkdir(worktree);
	await mkdir(path.join(project, ".git/worktrees/card"), { recursive: true });
	await writeFile(path.join(worktree, ".git"), `gitdir: ${project}/.git/worktrees/card\n`);
	await writeFile(path.join(project, ".git/worktrees/card/commondir"), "../..\n");
	expect(await kbProject(worktree)).toBe("neodeck");
	const own = { path: "projects/neodeck/new.md", content: "Own knowledge", mode: "create", kind: "note" } as const;
	await writeKb(kb, { ...identity, projectCwd: worktree }, own);
	expect(await readFile(path.join(vault, own.path), "utf8")).toBe("Own knowledge");
	const edge = {
		path: "projects/neopi/edges/neodeck/change.md",
		content: "Affected API: [[projects/neodeck/new]]",
		mode: "create",
		kind: "edge",
	} as const;
	await writeKb(kb, identity, edge);
	expect((await kb.getFile(edge.path))?.outgoingLinks[0]?.resolved).toBe(own.path);
	const relatedEdge = { ...edge, path: "projects/related-app/edges/neodeck/change.md" };
	await writeKb(kb, identity, relatedEdge);
	expect((await kb.getFile(relatedEdge.path))?.outgoingLinks[0]?.resolved).toBe(own.path);
	await expect(writeKb(kb, identity, { ...own, path: "projects/related-app/adrs/choice.md" })).rejects.toThrow(
		"authority",
	);
	for (const denied of [
		"projects/neopi/adrs/choice.md",
		"projects/neopi/product-decisions.md",
		"projects/neopi/notes.md",
		"projects/Neopi/ADRs/x.md",
		"projects/neodeck/../neopi/adrs/x.md",
		"projects/neodeck/../../foreign.md",
	]) {
		await expect(writeKb(kb, identity, { ...own, path: denied })).rejects.toThrow();
	}
	await expect(
		writeKb(kb, identity, {
			...edge,
			path: "projects/neopi/edges/neodeck/unlinked.md",
			content: "No owning note link",
		}),
	).rejects.toThrow("link back");
	await expect(
		writeKb(kb, identity, { ...edge, path: "projects/neopi/edges/neodeck/not-edge.md", kind: "note" }),
	).rejects.toThrow("authority");
	await expect(
		writeKb(kb, { ...identity, readOnly: true }, { ...own, path: "projects/neodeck/readonly.md" }),
	).rejects.toThrow("forbidden");
	await expect(writeKb(kb, { ...identity, projectCwd: null }, own)).rejects.toThrow("authenticated project");
	await symlink(path.join(vault, "projects/neopi/adrs"), path.join(vault, "projects/neodeck/alias"));
	await expect(
		writeKb(kb, identity, { ...own, path: "projects/neodeck/alias/choice.md", mode: "update" }),
	).rejects.toThrow("symlink");
	expect(await readFile(path.join(vault, "projects/neopi/adrs/choice.md"), "utf8")).toBe("Protected foreign ADR\n");
});

test("real authenticated HTTP tools capture inbox to KB, enforce readonly/revocation, and deny claimed-project/editor bypass", async () => {
	const token = crypto.randomUUID();
	let running = true;
	const app = buildKbRouter(kb, { resolveAgent: supplied => (running && supplied === token ? identity : undefined) });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	const tools = createKbAgentTools(`http://127.0.0.1:${server.port}/kb/agent`, token);
	const invoke = (name: string, args: unknown) =>
		tools.find(tool => tool.name === name)!.execute("call", args as never, undefined, undefined, {} as never);
	try {
		const captured = createInbox({
			kind: "capture",
			title: "API discovery",
			body: "Typed edges preserve provenance",
			source: "test",
		});
		await invoke("kb_write", {
			path: "projects/neodeck/captured.md",
			captureId: captured.id,
			mode: "create",
			kind: "note",
		});
		expect((await kb.getFile("projects/neodeck/captured.md"))?.rawContent).toContain(captured.body);
		expect(getInbox(captured.id)?.processedAt).toBeTruthy();
		const opened = await invoke("kb_read", { operation: "open", path: "projects/neodeck/captured.md" });
		expect(JSON.stringify(opened.content)).toContain("Typed edges preserve provenance");
		identity.readOnly = true;
		await expect(
			invoke("kb_write", { path: "projects/neodeck/denied.md", content: "no", mode: "create", kind: "note" }),
		).rejects.toThrow("403");
		const claimed = await app.request("/kb/agent/write", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ projectCwd: project, path: "projects/neodeck/x.md" }),
		});
		expect(claimed.status).toBe(400);
		expect(
			(
				await app.request("/kb/file?path=projects/neopi/adrs/choice.md", {
					method: "PUT",
					body: JSON.stringify({ content: "bypass" }),
				})
			).status,
		).toBe(403);
		expect((await app.request("/kb/init", { method: "POST" })).status).toBe(403);
		const onboarding = buildOnboardingRouter();
		expect(
			(
				await onboarding.request("/seed-kb-system", {
					method: "POST",
					body: JSON.stringify({ kbRoot: path.join(root, "unscoped") }),
				})
			).status,
		).toBe(403);
		running = false;
		await expect(invoke("kb_read", { operation: "open", path: "target.md" })).rejects.toThrow("401");
	} finally {
		await server.stop(true);
	}
});

test("explicit capture chat command and wired routine KB input work through persisted consumers", async () => {
	const capture = createInbox({
		kind: "capture",
		title: "Capture section",
		body: "Learned while implementing",
		source: "test",
	});
	const result = await executeDeckSlashCommand(`/kb capture ${capture.id} projects/neodeck/chat-capture.md`, {
		cwd: project,
		sessionId: "session",
	});
	expect(result).toMatchObject({ kind: "consumed", output: "Captured to kb://projects/neodeck/chat-capture.md" });
	const spec = {
		name: "Explicit KB input",
		trigger: [{ manual: {} }],
		steps: [
			{ id: "knowledge", type: "deck", action: "kb_read", path: "target.md" },
			{
				id: "result",
				type: "deck",
				action: "create_inbox_item",
				kind: "investigation",
				title: "Requested knowledge",
				body: "{{ steps.knowledge.json.body }}",
			},
		],
	} as any;
	const routine = createV1Routine({
		name: spec.name,
		description: "",
		specToml: stringifyToml(spec),
		spec,
		enabled: false,
	});
	const runner = new RoutinesRunner();
	try {
		await runner.fire(routine.id, "manual");
	} finally {
		await runner.dispose();
	}
	expect(listInbox({}).find(item => item.title === "Requested knowledge")?.body).toContain(
		"Decision: use narrow traversal",
	);
});
