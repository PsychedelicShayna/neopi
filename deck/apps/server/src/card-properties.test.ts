import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Task } from "@npi-deck/protocol";
import { cardExecutionProperties, cardFrontmatter, withCardProperties } from "./card-properties.ts";
import { closeDb, getDb, openDb } from "./db/index.ts";
import { createInbox } from "./db/inbox.ts";
import { createTask, deleteTask, getTask, listTasks, updateTask } from "./db/tasks.ts";
import { executeDeckSlashCommand } from "./deck-slash-commands.ts";
import { buildTasksRouter } from "./routes-tasks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { executeDeckStep } from "./routines/steps/deck.ts";
import type { RunContext } from "./routines/types.ts";

let root: string | undefined;
afterEach(() => {
	closeDb();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});
function boot(): void {
	root = mkdtempSync(path.join(tmpdir(), "deck-card-properties-"));
	openDb({ path: path.join(root, "deck.db") });
}
const properties = {
	"read-only": true,
	worktree: "/projects/linked",
	model: "fixture/research",
	role: "research",
	custom: { tags: ["one", "two"], score: 0.25, enabled: false },
};
const body =
	'+++\n# Keep this comment\nread-only = true\nworktree = "/projects/linked"\nmodel = "fixture/research"\nrole = "research"\n[custom]\ntags = ["one", "two"]\nscore = 0.25\nenabled = false\n+++\nResearch the code.';
function assertCard(task: Task): void {
	expect(cardFrontmatter(task.body).properties).toEqual(properties);
	expect(task.cwd).toBeUndefined();
}
const request = (data: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(data),
});
const context = (): RunContext => ({
	run: {
		id: "card-properties",
		started: "2026-10-13T00:00:00Z",
		iso_started: "2026-10-13T00:00:00Z",
		date: "2026-10-13",
		trigger_kind: "manual",
	},
	trigger: {},
	steps: {},
	env: {},
	secrets: {},
	state: { properties },
});

test("property merge preserves unrelated TOML spelling/comments and only updates requested properties", () => {
	const raw =
		'+++\n# retained\nrevision = "001"\ncustom = { score = 0.25, enabled = false }\nread-only = false\n+++\nResearch\n';
	expect(withCardProperties(raw)).toBe(raw);
	const merged = withCardProperties(raw, { "read-only": true, worktree: "/linked" });
	expect(merged).toContain('# retained\nrevision = "001"\ncustom = { score = 0.25, enabled = false }\n');
	expect(cardExecutionProperties(merged)).toEqual({ readOnly: true, worktree: "/linked" });
	expect(cardFrontmatter(merged).content).toBe("Research\n");
});

test("invalid executable property types and unimported YAML fail closed", () => {
	expect(() => cardExecutionProperties("+++\nread-only = 'true'\n+++\n")).toThrow("boolean");
	expect(() => cardExecutionProperties("+++\nworktree = ['not', 'a', 'path']\n+++\n")).toThrow("nonempty string");
	expect(cardFrontmatter("+++\ncwd = '/not/routing'\n+++\n").properties.cwd).toBe("/not/routing");
	expect(() => cardExecutionProperties("---\nread-only: true\n---\n")).toThrow("imported");
});

test("API and bridge card creation preserve raw TOML or accept a nested properties mapping independently of project routing", async () => {
	boot();
	const app = buildTasksRouter();
	const raw = await app.request("/tasks", request({ title: "raw", body }));
	expect(raw.status).toBe(201);
	const rawCard = (await raw.json()) as Task;
	assertCard(rawCard);
	expect(rawCard.body).toBe(body);
	const mapped = await app.request("/tasks", request({ title: "bridge", body: "Research the code.", properties }));
	expect(mapped.status).toBe(201);
	assertCard((await mapped.json()) as Task);
	const patched = await app.request(`/tasks/${rawCard.id}`, {
		...request({ properties: { custom: { nested: [true, 0, "value"] } } }),
		method: "PATCH",
	});
	expect(patched.status).toBe(200);
	expect(cardFrontmatter(((await patched.json()) as Task).body).properties).toEqual({
		...properties,
		custom: { nested: [true, 0, "value"] },
	});
});

test("chat task add accepts leading TOML and JSON properties without deriving cwd from worktree", async () => {
	boot();
	await executeDeckSlashCommand(`/task add From chat\n${body}`, { cwd: "" });
	const raw = listTasks({}).find(task => task.title === "From chat")!;
	assertCard(raw);
	expect(raw.body).toBe(body);
	await executeDeckSlashCommand(`/task add ${JSON.stringify({ title: "JSON chat", properties })}`, { cwd: "" });
	assertCard(listTasks({}).find(task => task.title === "JSON chat")!);
});

test("capture/inbox promotion keeps leading TOML ahead of provenance and accepts property overrides", async () => {
	boot();
	const app = buildInboxRouter();
	const item = createInbox({ kind: "capture", title: "capture", body });
	const response = await app.request(`/inbox/${item.id}/promote`, request({}));
	expect(response.status).toBe(201);
	const promoted = ((await response.json()) as { task: Task }).task;
	assertCard(promoted);
	expect(promoted.body.startsWith(body)).toBe(true);
	expect(promoted.body).toContain("Promoted from inbox");
	const override = createInbox({ kind: "ticket", title: "overridden", body: "original" });
	const response2 = await app.request(`/inbox/${override.id}/promote`, request({ body: "Override", properties }));
	expect(response2.status).toBe(201);
	assertCard(((await response2.json()) as { task: Task }).task);
});

test("routine create and promote preserve nested typed templated properties and keep filing explicit", async () => {
	boot();
	const created = await executeDeckStep(
		{
			id: "create",
			type: "deck",
			action: "create_task",
			title: "routine",
			body: "Research",
			properties: {
				"read-only": "{{ state.properties.read-only }}",
				worktree: "{{ state.properties.worktree }}",
				model: "{{ state.properties.model }}",
				role: "{{ state.properties.role }}",
				custom: "{{ state.properties.custom }}",
			},
		},
		context(),
		AbortSignal.timeout(1000),
	);
	expect(created.status).toBe("success");
	assertCard(listTasks({}).find(task => task.title === "routine")!);
	const item = createInbox({ kind: "capture", title: "routine promotion", body: "inbox" });
	const promoted = await executeDeckStep(
		{ id: "promote", type: "deck", action: "promote_inbox_item_to_task", inbox_ref: item.id, body, properties },
		context(),
		AbortSignal.timeout(1000),
	);
	expect(promoted.status).toBe("success");
	assertCard(listTasks({}).find(task => task.title === "routine promotion")!);
});

test("legacy DB metadata imports at boot, keeps exact originals immutable and never replaces native bodies on restart", () => {
	boot();
	const task = createTask({ title: "legacy" });
	const original =
		"---\n# exact original\nread-only: true\ncustom:\n  # nested legacy comment\n  empty: null\n  tags: [one, two]\n---\nResearch\n";
	getDb().query("UPDATE tasks SET body = ? WHERE id = ?").run(original, task.id);
	const dbPath = path.join(root!, "deck.db");
	closeDb();
	openDb({ path: dbPath });
	const canonical = getTask(task.id)!;
	expect(canonical.body.startsWith("+++\n")).toBe(true);
	expect(canonical.body).toContain("# exact original");
	expect(canonical.body).toContain("nested legacy comment");
	expect(cardFrontmatter(canonical.body).properties).toEqual({
		"read-only": true,
		custom: { empty: null, tags: ["one", "two"] },
	});
	expect(
		getDb().query<{ body: string }, [string]>("SELECT body FROM card_legacy_originals WHERE task_id = ?").get(task.id)
			?.body,
	).toBe(original);
	expect(() => getDb().query("DELETE FROM card_legacy_originals WHERE task_id = ?").run(task.id)).toThrow("immutable");
	expect(() => getDb().query("UPDATE card_legacy_originals SET body = '' WHERE task_id = ?").run(task.id)).toThrow(
		"immutable",
	);
	updateTask(task.id, { properties: { owner: "Captain" } });
	const edited = getTask(task.id)!.body;
	expect(edited).toContain("# exact original");
	expect(edited).toContain("nested legacy comment");
	closeDb();
	openDb({ path: dbPath });
	expect(getTask(task.id)!.body).toBe(edited);
	deleteTask(task.id);
	expect(
		getDb().query<{ body: string }, [string]>("SELECT body FROM card_legacy_originals WHERE task_id = ?").get(task.id)
			?.body,
	).toBe(original);
});

test("legacy input imports only at persistence and retains every distinct source", () => {
	boot();
	const first = "---\n# first\nowner: Captain\n---\nFirst\n";
	const second = "---\n# second\nowner: Pilot\n---\nSecond\n";
	const task = createTask({ title: "import", body: first, properties: { "read-only": true } });
	expect(cardFrontmatter(task.body).properties).toEqual({ owner: "Captain", "read-only": true });
	updateTask(task.id, { body: second });
	const originals = getDb()
		.query<{ body: string }, [string]>("SELECT body FROM card_legacy_originals WHERE task_id = ? ORDER BY body")
		.all(task.id);
	expect(originals.map(row => row.body)).toEqual([first, second]);
});

test("malformed legacy DB metadata retains its original and cannot execute", () => {
	boot();
	const task = createTask({ title: "invalid legacy" });
	const original = "---\nread-only: [broken\n---\nTask";
	getDb().query("UPDATE tasks SET body = ? WHERE id = ?").run(original, task.id);
	closeDb();
	openDb({ path: path.join(root!, "deck.db") });
	expect(getTask(task.id)?.body).toBe(original);
	expect(() => cardExecutionProperties(original)).toThrow("imported");
	expect(
		getDb().query<{ body: string }, [string]>("SELECT body FROM card_legacy_originals WHERE task_id = ?").get(task.id)
			?.body,
	).toBe(original);
});

test("raw multiline TOML fence-shaped lines remain metadata across loading and property patches", () => {
	const raw =
		"+++\n# keep exact comment  \nnotes = \"\"\"before\n+++\nafter\"\"\"\nliteral = '''first\n+++\nlast'''\n+++\nBody\n+++\nBody fence\n";
	const parsed = cardFrontmatter(raw);
	expect(parsed.properties).toEqual({ notes: "before\n+++\nafter", literal: "first\n+++\nlast" });
	expect(parsed.content).toBe("Body\n+++\nBody fence\n");
	expect(withCardProperties(raw)).toBe(raw);
	const patched = withCardProperties(raw, { "read-only": true });
	expect(patched).toContain("# keep exact comment  \n");
	expect(cardFrontmatter(patched).properties).toEqual({ ...parsed.properties, "read-only": true });
	expect(cardFrontmatter(patched).content).toBe(parsed.content);
});

test("rich property writes and raw database saves round-trip multiline fence data", () => {
	boot();
	const text = "before\n+++\nafter\n";
	const created = createTask({ title: "rich fences", body: "Instructions\n", properties: { custom: { text } } });
	expect(cardFrontmatter(created.body).properties).toEqual({ custom: { text } });
	expect(cardFrontmatter(created.body).content).toBe("Instructions\n");
	const raw = '+++\r\n# retained\r\ntext = """before\r\n+++\r\nafter"""\r\n+++\r\nInstructions\r\n';
	updateTask(created.id, { body: raw });
	expect(getTask(created.id)?.body).toBe(raw);
	expect(cardFrontmatter(raw).content).toBe("Instructions\r\n");
});
