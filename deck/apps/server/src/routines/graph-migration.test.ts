import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettingsToml as parse, stringifySettingsToml as stringify } from "@oh-my-pi/pi-utils/settings-toml";
import type { RoutineGraph, RoutineSpec } from "@npi-deck/protocol";
import { closeDb, getDb, openDb } from "../db/index.ts";
import {
	createGraphRoutine,
	createRoutine,
	createV1Routine,
	getGraphRun,
	getRoutine,
	listRuns,
	startRun,
	updateGraphRoutine,
} from "../db/routines.ts";
import { upsertWebhookSecret } from "../db/routine-step-runs.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "../owned-process.ts";
import { buildRoutinesRouter } from "../routes-routines.ts";
import { buildHooksRouter } from "../routes-hooks.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import {
	exportRoutineMigration,
	inspectRoutineMigrations,
	migrateRoutines,
	restoreRoutineDefinition,
} from "./graph-migration.ts";
import { findGraphOutput } from "./graph-runner.ts";
import { loadState, saveState } from "./state.ts";

let home = "";
let runner: RoutinesRunner;
let server: ReturnType<typeof Bun.serve> | undefined;
const keys = ["NPI_DECK_HOME", "NPI_DECK_DB_PATH", "NPI_DECK_DEFAULT_CWD", "PI_CODING_AGENT_DIR"] as const;
let prior: Partial<Record<(typeof keys)[number], string | undefined>>;
beforeEach(() => {
	prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "neodeck-migration-"));
	process.env.NPI_DECK_HOME = home;
	process.env.NPI_DECK_DB_PATH = path.join(home, "deck.db");
	process.env.NPI_DECK_DEFAULT_CWD = home;
	process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	initializeOwnedGeneration();
	runner = new RoutinesRunner();
});
afterEach(async () => {
	try {
		server?.stop(true);
		server = undefined;
		await runner?.dispose();
	} finally {
		try {
			await stopOwnedProcesses();
		} finally {
			try {
				closeDb();
			} finally {
				for (const key of keys)
					if (prior[key] === undefined) delete process.env[key];
					else process.env[key] = prior[key];
				if (home) fs.rmSync(home, { recursive: true, force: true });
			}
		}
	}
});
function spec(
	steps: RoutineSpec["steps"] = [{ id: "value", type: "transform", body: "return context.trigger;" }],
): RoutineSpec {
	return { name: "migration-fixture", trigger: [{ manual: {} }], steps };
}
function seed(source = spec(), raw = stringify(source)) {
	return createV1Routine({
		name: source.name,
		description: source.description,
		spec: source,
		specToml: raw,
		enabled: false,
	});
}
function migrate(id: string) {
	return migrateRoutines(runner.graphRegistry, { routineId: id, backupDirectory: path.join(home, "backups") });
}
function row(id: string) {
	return getDb().query<Record<string, unknown>, [string]>("SELECT * FROM routines WHERE id = ?").get(id)!;
}
function graph(id: string): RoutineGraph {
	return getRoutine(id)!.graph!;
}
function request(method = "POST", body?: unknown): RequestInit {
	return {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	};
}

// Reproduces the current persisted shape before conversion, without running an original.
test("saved TOML has no native definition until explicit conversion; migration never executes", () => {
	const source = spec([{ id: "write", type: "write", path: "must-not-exist.txt", content: "not during migration" }]);
	const routine = seed(source, `# retain this exact original\n${stringify(source)}`);
	const before = row(routine.id);
	expect(getRoutine(routine.id)?.graph).toBeUndefined();
	expect(inspectRoutineMigrations(runner.graphRegistry, routine.id)[0]?.status).toBe("ready");
	expect(row(routine.id)).toEqual(before);
	const converted = migrate(routine.id);
	expect(converted.reports[0]?.status).toBe("migrated");
	expect(fs.existsSync(path.join(home, "must-not-exist.txt"))).toBe(false);
	expect(listRuns(routine.id)).toEqual([]);
	expect(row(routine.id)).toEqual({
		...before,
		spec_version: 2,
		spec_toml: null,
		graph_json: JSON.stringify(graph(routine.id)),
	});
	expect(fs.statSync(converted.backupPath!).mode & 0o777).toBe(0o600);
	expect(fs.statSync(path.dirname(converted.backupPath!)).mode & 0o777).toBe(0o700);
});

test("semantic export and reimport retain omitted/false/zero/null/empty/nested values and references", () => {
	const source = spec([
		{
			id: "data",
			type: "transform",
			body: "return { list: [false, 0, null, '', 'truthy'], nested: { yes: true } };",
			on_failure: "abort",
			timeout_secs: 17,
		},
		{
			id: "fetch",
			type: "http",
			method: "POST",
			url: "http://127.0.0.1/unused",
			headers: {},
			query: { zero: 0, flag: false, empty: "" },
			body: { from: "{{ steps.data.json.list }}", nested: [null, false, 0, ""] },
			expect_json: false,
		},
		{ id: "write", type: "write", path: "unused.txt", content: "", append: false },
		{ id: "wait", type: "wait", duration_secs: 0.1 },
	]);
	source.state = { declared_keys: [] };
	source.layout = {
		version: 1,
		nodes: { data: { x: 0, y: -10, collapsed: false } },
		edges: [{ from: "data", to: "write", kind: "manual", label: "display only" }],
	};
	const first = seed(source);
	const result = migrate(first.id);
	expect(result.reports[0]?.status).toBe("migrated");
	const exported = parse(exportRoutineMigration(first.id, result.reports[0]!.sourceDigest)) as unknown as RoutineSpec;
	expect(exported).toEqual(source);
	const second = seed(exported);
	expect(migrate(second.id).reports[0]?.status).toBe("migrated");
	expect(graph(second.id)).toEqual(graph(first.id));
	expect(result.reports[0]?.fields.find(field => field.path === "/spec/layout/edges")?.status).toBe(
		"preserved-declaration-only",
	);
	expect(graph(first.id).edges.some(edge => edge.id === "display only")).toBe(false);
});

test("completion survives restart and repeat conversion creates no new rows, nodes or backups", () => {
	const routine = seed();
	const first = migrate(routine.id);
	const saved = row(routine.id);
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	const repeated = migrate(routine.id);
	expect(repeated.reports[0]?.status).toBe("native");
	expect(repeated.backupPath).toBeUndefined();
	expect(row(routine.id)).toEqual(saved);
	expect(getDb().query("SELECT * FROM routine_graph_conversions").all()).toHaveLength(1);
	expect(fs.readdirSync(path.dirname(first.backupPath!))).toHaveLength(1);
});

test("full backup retains raw definitions, state, webhook credentials and historical relationships", () => {
	const routine = seed();
	const registered = seed({ ...spec(), name: "other-original" });
	upsertWebhookSecret({ routineId: registered.id, path: "/hooks/original", secret: "test-only-signing-key" });
	saveState(routine.id, { original: { nested: [false, 0, null] } });
	const historical = startRun(routine.id, "manual", { before: true });
	const before = row(routine.id);
	const result = migrate(routine.id);
	const backup = new Database(result.backupPath!, { readonly: true });
	try {
		expect(backup.query("SELECT * FROM routines WHERE id = ?").get(routine.id)).toEqual(before);
		expect(backup.query("SELECT * FROM routine_state WHERE routine_id = ?").all(routine.id)).toEqual(
			getDb().query("SELECT * FROM routine_state WHERE routine_id = ?").all(routine.id),
		);
		expect(backup.query("SELECT * FROM routine_webhook_secrets").all()).toEqual(
			getDb().query("SELECT * FROM routine_webhook_secrets").all(),
		);
		expect(backup.query("SELECT routine_id FROM routine_runs WHERE id = ?").get(historical.id)).toEqual({
			routine_id: routine.id,
		});
	} finally {
		backup.close();
	}
	expect(listRuns(routine.id)[0]?.id).toBe(historical.id);
	restoreRoutineDefinition(routine.id, result.reports[0]!.sourceDigest);
	expect(row(routine.id)).toEqual(before);
	restoreRoutineDefinition(routine.id, result.reports[0]!.sourceDigest);
	expect(row(routine.id)).toEqual(before);
	getDb().query("UPDATE routines SET name = 'edited-after-restore' WHERE id = ?").run(routine.id);
	expect(() => restoreRoutineDefinition(routine.id, result.reports[0]!.sourceDigest)).toThrow("changed");
});

test("backup failure and precommit interruption leave originals intact, then retry once", () => {
	const routine = seed();
	const before = row(routine.id);
	const notDirectory = path.join(home, "not-a-directory");
	fs.writeFileSync(notDirectory, "file");
	expect(() =>
		migrateRoutines(runner.graphRegistry, { routineId: routine.id, backupDirectory: notDirectory }),
	).toThrow();
	expect(row(routine.id)).toEqual(before);
	getDb().exec(
		"CREATE TRIGGER interrupt_migration BEFORE UPDATE OF graph_json ON routines BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END",
	);
	expect(() => migrate(routine.id)).toThrow("simulated interruption");
	expect(row(routine.id)).toEqual(before);
	expect(getDb().query("SELECT * FROM routine_graph_conversions").all()).toEqual([]);
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	getDb().exec("DROP TRIGGER interrupt_migration");
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	expect(getDb().query("SELECT * FROM routine_graph_conversions").all()).toHaveLength(1);
});

test("production native execution keeps truthy/false/zero/null/empty results and original inputs after native edits/restart", async () => {
	for (const value of [false, 0, null, "", "truthy-not-true", true, { nested: [1, false, null] }]) {
		const routine = seed(
			spec([
				{ id: "first", type: "transform", body: "return context.trigger.value;" },
				{ id: "second", type: "transform", body: "return context.steps.first.json;" },
			]),
		);
		expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
		await runner.fire(routine.id, "manual", { value });
		const run = listRuns(routine.id)[0]!;
		const trace = getGraphRun(run.id)!;
		expect(trace.status).toBe("success");
		const second = trace.nodeRuns.find(node => node.nodeId === "second")!;
		const actual = second.outputs.find(output => output.port === "result")!;
		expect(actual.result).toEqual(
			value !== null && typeof value === "object" && !Array.isArray(value) ? value : { value },
		);
		expect(findGraphOutput(actual, "__trigger_0")?.result).toEqual({ value });
		const original = graph(routine.id);
		updateGraphRoutine(
			routine.id,
			{
				graph: {
					version: 2,
					nodes: [{ id: "new", type: "event.source", config: { eventType: "manual" } }],
					edges: [],
				},
			},
			runner.graphRegistry,
		);
		closeDb();
		openDb({ path: path.join(home, "deck.db") });
		expect(getGraphRun(run.id)?.graph).toEqual(original);
		expect(
			getGraphRun(run.id)
				?.nodeRuns.find(node => node.nodeId === "second")
				?.outputs.find(output => output.port === "result")?.result,
		).toEqual(actual.result);
	}
});

test("saved graph executes isolated shell/write/append/state nodes in order and keeps state across restart", async () => {
	const routine = seed(
		spec([
			{ id: "shell", type: "run", command: "printf 'shell-result'" },
			{ id: "write", type: "write", path: "output/note.txt", content: "{{ steps.shell.stdout }}", append: false },
			{ id: "append", type: "write", path: "output/note.txt", content: "-tail", append: true },
			{ id: "increment", type: "transform", body: "return (context.state.count || 0) + 1;" },
			{
				id: "set",
				type: "set_state",
				state: { count: "{{ steps.increment.json }}", exact: { nested: [false, 0, null, ""] } },
			},
			{ id: "read", type: "transform", body: "return context.state;" },
		]),
	);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	for (const count of [1, 2]) {
		await runner.fire(routine.id);
		expect(fs.readFileSync(path.join(home, "output/note.txt"), "utf8")).toBe("shell-result-tail");
		expect(loadState(routine.id)).toEqual({ count, exact: { nested: [false, 0, null, ""] } });
		const trace = getGraphRun(listRuns(routine.id)[0]!.id)!;
		expect(trace.status).toBe("success");
		expect(
			trace.nodeRuns.find(node => node.nodeId === "read")?.outputs.find(output => output.port === "result")?.result,
		).toEqual({ count, exact: { nested: [false, 0, null, ""] } });
		closeDb();
		openDb({ path: path.join(home, "deck.db") });
	}
});

test("native HTTP uses the real local transport with typed deep substitutions and golden-rule trace", async () => {
	let received: unknown;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			received = await request.json();
			return Response.json({ exact: received });
		},
	});
	const routine = seed(
		spec([
			{ id: "payload", type: "transform", body: "return { nested: [false, 0, null, '', 'truthy'] };" },
			{
				id: "send",
				type: "http",
				method: "POST",
				url: `http://127.0.0.1:${server.port}/record`,
				body: { typed: "{{ steps.payload.json.nested }}" },
				expect_json: true,
			},
		]),
	);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	await runner.fire(routine.id);
	expect(received).toEqual({ typed: [false, 0, null, "", "truthy"] });
	const trace = getGraphRun(listRuns(routine.id)[0]!.id)!;
	expect(trace.status).toBe("success");
	expect(JSON.stringify(trace)).not.toContain("Bearer ");
});

test("bundled census now converts without executing; briefing stays blocked only by its agent", () => {
	for (const slug of ["daily-briefing", "kb-orphan-census"]) {
		const raw = fs.readFileSync(new URL(`../templates/${slug}.toml`, import.meta.url), "utf8");
		const source = parse(raw) as unknown as RoutineSpec;
		const routine = seed(source, raw);
		const before = row(routine.id);
		const result = migrate(routine.id);
		const report = result.reports[0]!;
		expect(report.fields.some(field => field.path.startsWith("/spec/budget/") && field.status === "blocked")).toBe(
			false,
		);
		if (slug === "daily-briefing") {
			expect(report.status).toBe("blocked");
			expect(
				report.fields
					.filter(field => field.status === "blocked")
					.every(field => field.path.startsWith("/spec/steps/5")),
			).toBe(true);
			expect(row(routine.id)).toEqual(before);
		} else {
			expect(report.status).toBe("migrated");
			expect(parse(exportRoutineMigration(routine.id, report.sourceDigest))).toEqual(source);
			expect(migrate(routine.id).reports[0]?.status).toBe("native");
			restoreRoutineDefinition(routine.id, report.sourceDigest);
			expect(row(routine.id)).toEqual(before);
		}
		expect(listRuns(routine.id)).toEqual([]);
	}
});

test("agent actions, unknown keys, malformed budgets and duplicate ids are never rewritten", () => {
	const cases = [
		{ id: "a", type: "transform", body: "return 1;", on_error: "ignored-but-not-aliased" },
		{ id: "a", type: "agent", prompt: "NEVER RUN THIS", skills_allowed: [], mcp_servers_allowed: [] },
	] as RoutineSpec["steps"];
	const routines = cases.map(step => seed(spec([step])));
	routines.push(
		seed(
			spec([
				{ id: "a", type: "wait", duration_secs: 0.1 },
				{ id: "a", type: "wait", duration_secs: 0.1 },
			]),
		),
	);
	for (const raw of [
		"name = 'broken'\nname = 'duplicate'",
		"bad = [",
		"name = 'other'\ntrigger = []\nsteps = []\nversion = 1",
	])
		routines.push(seed(spec(), raw));
	const malformed = seed();
	getDb().query("UPDATE routines SET budget_json = ? WHERE id = ?").run("not-json-test-secret", malformed.id);
	routines.push(malformed);
	const mirrored = seed();
	getDb().query("UPDATE routines SET concurrency = 'parallel' WHERE id = ?").run(mirrored.id);
	routines.push(mirrored);
	routines.push(
		createRoutine({
			name: "v0-prompt",
			cron: "0 1 * * *",
			actionKind: "prompt",
			actionBody: "NEVER EXECUTE",
			enabled: false,
		}),
	);
	for (const routine of routines) {
		const before = row(routine.id);
		const report = migrate(routine.id).reports[0]!;
		expect(report.status).toBe("blocked");
		expect(report.fields.some(field => field.status === "blocked")).toBe(true);
		expect(JSON.stringify(report)).not.toContain("not-json-test-secret");
		expect(JSON.stringify(report)).not.toContain("NEVER EXECUTE");
		expect(row(routine.id)).toEqual(before);
	}
});

test("migration endpoints preflight, block unsafe originals, export/restore and never run during apply", async () => {
	const routine = seed();
	const api = buildRoutinesRouter(runner);
	const inventory = await api.request("/routine-migrations");
	expect(inventory.status).toBe(200);
	const converted = await api.request(`/routine-migrations/${routine.id}`, request());
	expect(converted.status).toBe(200);
	const body = (await converted.json()) as { reports: Array<{ sourceDigest: string }> };
	expect(listRuns(routine.id)).toEqual([]);
	const digest = body.reports[0]!.sourceDigest;
	expect((await api.request(`/routine-migrations/${routine.id}/${digest}/export`)).status).toBe(200);
	expect((await api.request(`/routine-migrations/${routine.id}/${digest}/restore`, request())).status).toBe(200);
	expect(getRoutine(routine.id)?.specVersion).toBe(1);
	const blocked = seed(
		spec([{ id: "agent", type: "agent", prompt: "NEVER EXECUTE", skills_allowed: [], mcp_servers_allowed: [] }]),
	);
	expect((await api.request(`/routine-migrations/${blocked.id}`, request())).status).toBe(409);
	expect((await api.request("/routine-migrations/missing", request())).status).toBe(404);
});

test("native edits prevent stale restoration/export and dry runs dispatch no actions", async () => {
	const routine = seed(spec([{ id: "write", type: "write", path: "preview.txt", content: "no" }]));
	const result = migrate(routine.id);
	await runner.fire(routine.id, "manual", {}, { dryRun: true });
	expect(fs.existsSync(path.join(home, "preview.txt"))).toBe(false);
	const edited = structuredClone(graph(routine.id));
	edited.nodes.find(node => node.id === "write")!.config.step = {
		id: "write",
		type: "write",
		path: "other.txt",
		content: "different",
	};
	updateGraphRoutine(routine.id, { graph: edited }, runner.graphRegistry);
	expect(() => restoreRoutineDefinition(routine.id, result.reports[0]!.sourceDigest)).toThrow("changed");
	expect(() => exportRoutineMigration(routine.id, result.reports[0]!.sourceDigest)).toThrow("changed");
	const newlyAuthored = createGraphRoutine(
		{ name: "new-native", graph: edited, enabled: false },
		runner.graphRegistry,
	);
	expect(newlyAuthored.specVersion).toBe(2);
	expect(newlyAuthored.specToml).toBeUndefined();
});

test("failure aborts later actions while native diagnostics retain the actual failed handler result", async () => {
	const routine = seed(
		spec([
			{ id: "failed", type: "run", command: "printf 'partial-out'; printf 'partial-err' >&2; exit 7" },
			{ id: "not_run", type: "write", path: "not-run.txt", content: "must not write" },
		]),
	);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	await runner.fire(routine.id);
	const trace = getGraphRun(listRuns(routine.id)[0]!.id)!;
	expect(trace.status).toBe("failed");
	expect(trace.nodeRuns.find(node => node.nodeId === "failed")?.diagnostics?.result).toMatchObject({
		status: "failed",
		stdoutExcerpt: "partial-out",
		stderrExcerpt: "partial-err",
		error: "exit code 7",
	});
	expect(trace.nodeRuns.find(node => node.nodeId === "not_run")?.status).toBe("skipped");
	expect(fs.existsSync(path.join(home, "not-run.txt"))).toBe(false);
});

test("copied deck fixture shapes preserve card properties and reads without touching a live database", async () => {
	const routine = seed(
		spec([
			{
				id: "create",
				type: "deck",
				action: "create_task",
				title: "Migration fixture",
				body: "body",
				properties: { custom: { nested: [false, 0, null, ""] } },
				cwd: home,
			},
			{ id: "fetch", type: "deck", action: "get_task", task_ref: "{{ steps.create.json.id }}" },
			{ id: "list", type: "deck", action: "list_tasks", include_archived: false, limit: 1, since_hours: 24 },
			{
				id: "inbox",
				type: "deck",
				action: "create_inbox_item",
				kind: "capture",
				title: "Copied briefing action",
				body: "{{ steps.fetch.json.title }}",
				source: "routine:migration-test",
			},
		]),
	);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	await runner.fire(routine.id);
	const trace = getGraphRun(listRuns(routine.id)[0]!.id)!;
	expect(trace.status).toBe("success");
	const created = trace.nodeRuns.find(node => node.nodeId === "create")!.outputs[0]!.result;
	expect(created.body).toContain("custom:");
	expect(trace.nodeRuns.find(node => node.nodeId === "fetch")!.outputs[0]!.result.id).toBe(created.id);
	expect(trace.nodeRuns.find(node => node.nodeId === "inbox")!.outputs[0]!.result.title).toBe(
		"Copied briefing action",
	);
});

test("queued migrated runs initialize expression timestamps after admission and migration refuses active work", async () => {
	const source = spec([
		{ id: "wait", type: "wait", duration_secs: 0.1 },
		{ id: "inspect", type: "transform", body: "return context.run;" },
	]);
	source.concurrency = "queue";
	const routine = seed(source);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	const first = runner.fire(routine.id);
	const second = runner.fire(routine.id);
	const untouched = seed();
	expect((await buildRoutinesRouter(runner).request(`/routine-migrations/${untouched.id}`, request())).status).toBe(
		409,
	);
	await Promise.all([first, second]);
	for (const run of listRuns(routine.id)) {
		const trace = getGraphRun(run.id)!;
		expect(trace.status).toBe("success");
		const contextStarted = Date.parse(
			trace.nodeRuns.find(node => node.nodeId === "inspect")!.outputs[0]!.result.started as string,
		);
		expect(contextStarted).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
		expect(contextStarted).toBeLessThanOrEqual(
			Date.parse(trace.nodeRuns.find(node => node.nodeId === "__trigger_0")!.startedAt!),
		);
	}
	expect(getRoutine(untouched.id)?.specVersion).toBe(1);
});

function assertV1Lifecycle(routineId: string, source: RoutineSpec, digest: string) {
	expect(parse(exportRoutineMigration(routineId, digest))).toEqual(source);
	const copy = seed(parse(exportRoutineMigration(routineId, digest)) as unknown as RoutineSpec);
	expect(migrate(copy.id).reports[0]?.status).toBe("migrated");
	expect(graph(copy.id)).toEqual(graph(routineId));
	expect(migrate(routineId).reports[0]?.status).toBe("native");
	restoreRoutineDefinition(routineId, digest);
	expect(getRoutine(routineId)?.specVersion).toBe(1);
	expect(getRoutine(routineId)?.specToml).toBe(stringify(source));
}

test("when skip and continued failure migrate exact context, native receipts and aggregate history", async () => {
	const source = spec([
		{ id: "false_value", type: "transform", body: "return 'must not run';", when: "false" },
		{ id: "bad_predicate", type: "write", path: "must-not-exist.txt", content: "no", when: "missing.deep.property" },
		{ id: "truthy", type: "transform", body: "return 'truthy-result';", when: "'not-a-boolean'" },
		{ id: "failed", type: "run", command: "printf 'out'; printf 'err' >&2; exit 7", on_failure: "continue" },
		{ id: "inspect", type: "transform", body: "return context.steps;" },
	]);
	const routine = seed(source),
		converted = migrate(routine.id).reports[0]!;
	expect(converted.status).toBe("migrated");
	await runner.fire(routine.id);
	const run = listRuns(routine.id)[0]!,
		trace = getGraphRun(run.id)!;
	expect(trace.status).toBe("success");
	expect(run).toMatchObject({ exitCode: 0, stepCountTotal: 3, stepCountFailed: 1 });
	expect(run.abortReason).toBeUndefined();
	const inspect = trace.nodeRuns
		.find(node => node.nodeId === "inspect")!
		.outputs.find(output => output.port === "result")!;
	expect(inspect.result.false_value).toEqual({ status: "skipped", stdout: "", stderr: "", duration_ms: 0 });
	expect(inspect.result.bad_predicate).toEqual({ status: "skipped", stdout: "", stderr: "", duration_ms: 0 });
	expect(inspect.result.failed).toMatchObject({
		status: "failed",
		stdout: "out",
		stderr: "err",
		error: "exit code 7",
	});
	expect(trace.nodeRuns.find(node => node.nodeId === "failed")).toMatchObject({
		status: "failed",
		outputs: [{ port: "completed", result: { stepId: "failed", status: "failed" } }],
	});
	expect(
		trace.nodeRuns.find(node => node.nodeId === "false_value")?.outputs.some(output => output.port === "result"),
	).toBe(false);
	expect(trace.nodeRuns.find(node => node.nodeId === "truthy")?.diagnostics?.whenValue).toBe("not-a-boolean");
	expect(trace.nodeRuns.find(node => node.nodeId === "false_value")?.diagnostics?.whenValue).toBe(false);
	expect(trace.nodeRuns.find(node => node.nodeId === "bad_predicate")?.diagnostics?.whenError).toBeString();
	expect(findGraphOutput(inspect, "__trigger_0")?.result).toEqual({});
	expect(fs.existsSync(path.join(home, "must-not-exist.txt"))).toBe(false);
	assertV1Lifecycle(routine.id, source, converted.sourceDigest);
});

test("retry recovery and exhausted after_retry continue retain every native attempt", async () => {
	const source = spec([
		{
			id: "recover",
			type: "run",
			command: "if test -e retried; then printf recovered; else touch retried; printf first; exit 5; fi",
			on_failure: "retry",
			retry: { times: 3, backoff: "exponential", max_delay_secs: 0 },
		},
		{
			id: "exhaust",
			type: "run",
			command: "printf exhausted; exit 9",
			on_failure: "retry",
			retry: { times: 2, backoff: "linear", max_delay_secs: 0, after_retry: "continue" },
		},
		{
			id: "inspect",
			type: "transform",
			body: "return { recovered: steps.recover.stdout, failed: steps.exhaust.error };",
		},
	]);
	const routine = seed(source),
		converted = migrate(routine.id).reports[0]!;
	expect(converted.status).toBe("migrated");
	await runner.fire(routine.id);
	const run = listRuns(routine.id)[0]!,
		trace = getGraphRun(run.id)!;
	expect(trace.status).toBe("success");
	expect(run).toMatchObject({ exitCode: 0, stepCountTotal: 3, stepCountFailed: 1 });
	expect(trace.usage?.stepsExecuted).toBe(5);
	expect(trace.nodeRuns.find(node => node.nodeId === "recover")?.diagnostics?.attempts).toHaveLength(2);
	expect(trace.nodeRuns.find(node => node.nodeId === "exhaust")?.diagnostics?.attempts).toHaveLength(2);
	expect(
		trace.nodeRuns.find(node => node.nodeId === "inspect")?.outputs.find(output => output.port === "result")?.result,
	).toEqual({ recovered: "recovered", failed: "exit code 9" });
	assertV1Lifecycle(routine.id, source, converted.sourceDigest);
});

test("all budget declarations round-trip and native attempt limit excludes sources and when skips", async () => {
	const source = spec([
		{ id: "skip", type: "transform", when: "false", body: "return 'never';" },
		{
			id: "retry",
			type: "run",
			command: "printf attempted; exit 3",
			on_failure: "retry",
			retry: { times: 3, backoff: "linear", max_delay_secs: 0 },
		},
		{ id: "never", type: "write", path: "budget-never.txt", content: "no" },
	]);
	source.budget = {
		max_steps_executed: 1,
		max_duration_secs: 10,
		max_llm_tokens_input: 0,
		max_llm_tokens_output: 0,
		max_llm_cost_usd: 0,
	};
	const routine = seed(source),
		converted = migrate(routine.id).reports[0]!;
	expect(converted.status).toBe("migrated");
	await runner.fire(routine.id);
	const run = listRuns(routine.id)[0]!,
		trace = getGraphRun(run.id)!;
	expect(trace).toMatchObject({ status: "failed", abortReason: "budget", usage: { stepsExecuted: 2 } });
	expect(trace.nodeRuns.find(node => node.nodeId === "retry")?.diagnostics?.attempts).toHaveLength(2);
	expect(run).toMatchObject({ abortReason: "budget", stepCountTotal: 1, stepCountFailed: 0 });
	expect(fs.existsSync(path.join(home, "budget-never.txt"))).toBe(false);
	assertV1Lifecycle(routine.id, source, converted.sourceDigest);
});

test("manual schemas and duplicate event declarations preserve explicit admission without inventing subscriptions", async () => {
	const source = spec();
	source.trigger = [
		{
			manual: {
				params_schema: {
					type: "object",
					required: ["required"],
					properties: { required: { type: "boolean" } },
					additionalProperties: false,
				},
			},
		},
		{ manual: { params_schema: false } },
		{ event: { source: "deck_inbox", type: "added", filter: "trigger.kind === 'capture'" } },
		{ event: { source: "routine_finished" } },
	];
	const routine = seed(source);
	getDb().query("UPDATE routines SET enabled = 1 WHERE id = ?").run(routine.id);
	const converted = migrate(routine.id).reports[0]!;
	expect(converted.status).toBe("migrated");
	expect(graph(routine.id).nodes.filter(node => node.config.eventType === "manual")).toHaveLength(1);
	expect(graph(routine.id).nodes.filter(node => node.config.eventType === "event")).toHaveLength(1);
	expect(graph(routine.id).nodes.some(node => node.config.eventType === "inbox.card_added")).toBe(false);
	for (const trigger of ["manual", "event"] as const) {
		await runner.fire(routine.id, trigger, { false: false, zero: 0, nested: [null, ""] });
		const trace = getGraphRun(listRuns(routine.id)[0]!.id)!;
		expect(trace.status).toBe("success");
		expect(trace.nodeRuns.filter(node => node.nodeId === "value" && node.status === "success")).toHaveLength(1);
		expect(
			trace.nodeRuns.find(node => node.nodeId === "value")?.outputs.find(output => output.port === "result")?.result,
		).toEqual({ false: false, zero: 0, nested: [null, ""] });
	}
	assertV1Lifecycle(routine.id, source, converted.sourceDigest);
});

test("migrated webhook keeps exact credentials, authenticates native admission and restores registration unchanged", async () => {
	const source = spec();
	source.trigger = [{ webhook: { path: "/hooks/migrated", secret_env: "TEST_ONLY_SECRET" } }];
	const routine = seed(source);
	getDb().query("UPDATE routines SET enabled = 1 WHERE id = ?").run(routine.id);
	upsertWebhookSecret({ routineId: routine.id, path: "/hooks/migrated", secret: "isolated-test-key" });
	const credential = getDb().query("SELECT * FROM routine_webhook_secrets WHERE routine_id = ?").get(routine.id);
	const converted = migrate(routine.id).reports[0]!;
	expect(converted.status).toBe("migrated");
	expect(getDb().query("SELECT * FROM routine_webhook_secrets WHERE routine_id = ?").get(routine.id)).toEqual(
		credential,
	);
	const timestamp = String(Math.floor(Date.now() / 1000)),
		body = JSON.stringify({ exact: [false, 0, null, ""] });
	const signature = `sha256=${createHmac("sha256", "isolated-test-key").update(`${timestamp}.${body}`).digest("hex")}`;
	const response = await buildHooksRouter(runner).request("/hooks/migrated", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-routine-timestamp": timestamp,
			"x-routine-signature": signature,
		},
		body,
	});
	expect(response.status).toBe(202);
	const deadline = Date.now() + 3000;
	while (!listRuns(routine.id)[0]?.endedAt && Date.now() < deadline) await Bun.sleep(10);
	const trace = getGraphRun(listRuns(routine.id)[0]!.id)!;
	expect(trace.status).toBe("success");
	expect(
		trace.nodeRuns.find(node => node.nodeId === "value")?.outputs.find(output => output.port === "result")?.result,
	).toEqual({ exact: [false, 0, null, ""] });
	const used = getDb().query("SELECT * FROM routine_webhook_secrets WHERE routine_id = ?").get(routine.id);
	assertV1Lifecycle(routine.id, source, converted.sourceDigest);
	expect(getDb().query("SELECT * FROM routine_webhook_secrets WHERE routine_id = ?").get(routine.id)).toEqual(used);
});

test("orphan registrations, mismatched hook paths and multiple hooks retain originals with exact blockers", () => {
	for (const mode of ["orphan", "mismatch", "multiple"] as const) {
		const source = spec();
		if (mode !== "orphan") source.trigger = [{ webhook: { path: "/hooks/declared", secret_env: "TEST_ONLY" } }];
		if (mode === "multiple") source.trigger.push({ webhook: { path: "/hooks/second", secret_env: "TEST_ONLY" } });
		const routine = seed(source);
		upsertWebhookSecret({ routineId: routine.id, path: `/hooks/${mode}`, secret: "unchanged-test-key" });
		const before = row(routine.id),
			secret = getDb().query("SELECT * FROM routine_webhook_secrets WHERE routine_id = ?").get(routine.id);
		const report = migrate(routine.id).reports[0]!;
		expect(report.status).toBe("blocked");
		expect(
			report.fields.some(field => field.path === "/row/webhook_registration" && field.status === "blocked"),
		).toBe(true);
		if (mode === "multiple")
			expect(
				report.fields.some(field => field.path === "/spec/trigger/1/webhook" && field.status === "blocked"),
			).toBe(true);
		expect(row(routine.id)).toEqual(before);
		expect(getDb().query("SELECT * FROM routine_webhook_secrets WHERE routine_id = ?").get(routine.id)).toEqual(
			secret,
		);
	}
});

test("V0 bash and script use exact original argv and aggregate receipts with reversible conversion", async () => {
	for (const action of [
		{
			actionKind: "bash" as const,
			actionBody: "printf '{{literal}}'; printf 'original-stderr' >&2; exit 7",
			expected: "{{literal}}",
			exit: 7,
		},
		{
			actionKind: "script" as const,
			actionBody: "/usr/bin/printf    %s    {{literal}}",
			expected: "{{literal}}",
			exit: 0,
		},
	]) {
		const routine = createRoutine({
			name: `v0-${action.actionKind}`,
			cron: "0 1 * * *",
			actionKind: action.actionKind,
			actionBody: action.actionBody,
			actionCwd: home,
			enabled: false,
		});
		getDb()
			.query(
				"UPDATE routines SET concurrency = 'queue', timezone = 'UTC', tags = 'one, two', budget_json = ? WHERE id = ?",
			)
			.run('{"max_steps_executed":0}', routine.id);
		await runner.fire(routine.id);
		const original = listRuns(routine.id)[0]!;
		const before = row(routine.id),
			converted = migrate(routine.id).reports[0]!;
		expect(converted.status).toBe("migrated");
		expect(listRuns(routine.id)).toHaveLength(1);
		const exported = parse(exportRoutineMigration(routine.id, converted.sourceDigest)) as unknown as Parameters<
			typeof createRoutine
		>[0] & {
			metadata: { concurrency: string; timezone: string | null; tags: string | null; budget_json: string | null };
		};
		const copy = createRoutine(exported);
		getDb()
			.query("UPDATE routines SET concurrency = ?, timezone = ?, tags = ?, budget_json = ? WHERE id = ?")
			.run(
				exported.metadata.concurrency,
				exported.metadata.timezone,
				exported.metadata.tags,
				exported.metadata.budget_json,
				copy.id,
			);
		expect(migrate(copy.id).reports[0]?.status).toBe("migrated");
		expect(graph(copy.id)).toEqual(graph(routine.id));
		expect(migrate(routine.id).reports[0]?.status).toBe("native");
		await runner.fire(routine.id, "manual", {}, { dryRun: true });
		expect(
			getGraphRun(listRuns(routine.id)[0]!.id)?.nodeRuns.find(node => node.type === "process.v0")?.diagnostics,
		).toBeUndefined();
		await runner.fire(routine.id);
		const native = listRuns(routine.id)[0]!;
		expect(native).toMatchObject({
			exitCode: action.exit,
			stdoutExcerpt: action.expected,
			stderrExcerpt: original.stderrExcerpt,
			stepCountTotal: 0,
			stepCountFailed: 0,
		});
		expect(native.abortReason).toBeUndefined();
		expect(original).toMatchObject({
			exitCode: native.exitCode,
			stdoutExcerpt: native.stdoutExcerpt,
			stderrExcerpt: native.stderrExcerpt,
		});
		restoreRoutineDefinition(routine.id, converted.sourceDigest);
		expect(getRoutine(routine.id)?.specVersion).toBe(0);
		expect(row(routine.id)).toEqual({ ...before, last_run_at: row(routine.id).last_run_at });
	}
});

test("long migrated completion chains persist all prior results without exponential ancestry expansion", async () => {
	const source = spec(
		Array.from({ length: 24 }, (_, index) => ({
			id: `step_${index}`,
			type: "transform" as const,
			body:
				index === 0
					? "return trigger.value;"
					: `return { original: steps.step_0.json, previous: steps.step_${index - 1}.status };`,
		})),
	);
	const routine = seed(source);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	await runner.fire(routine.id, "manual", { value: "truthy-not-true" });
	const run = listRuns(routine.id)[0]!;
	expect(run).toMatchObject({ exitCode: 0, stepCountTotal: 24 });
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	const trace = getGraphRun(run.id)!;
	expect(trace.status).toBe("success");
	const last = trace.nodeRuns
		.find(node => node.nodeId === "step_23")!
		.outputs.find(output => output.port === "result")!;
	expect(last.result).toEqual({ original: "truthy-not-true", previous: "success" });
	expect(findGraphOutput(last, "step_0", "result")?.result).toEqual({ value: "truthy-not-true" });
	expect(findGraphOutput(last, "__trigger_0")?.result).toEqual({ value: "truthy-not-true" });
});

test("V0 process launch failures retain original aggregate terminal outcomes after conversion", async () => {
	const routine = createRoutine({
		name: "v0-launch-failure",
		cron: "0 1 * * *",
		actionKind: "script",
		actionBody: path.join(home, "missing-command"),
		actionCwd: home,
		enabled: false,
	});
	await runner.fire(routine.id);
	const original = listRuns(routine.id)[0]!;
	expect(original.exitCode).not.toBe(0);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	await runner.fire(routine.id);
	const native = listRuns(routine.id)[0]!;
	expect(native.error).toBe(original.error);
	expect(native.stdoutExcerpt).toBe(original.stdoutExcerpt);
	expect(native.stderrExcerpt).toBe(original.stderrExcerpt);
	expect(native.exitCode).toBe(original.exitCode);
	expect(getGraphRun(native.id)?.nodeRuns.find(node => node.type === "process.v0")?.diagnostics?.v0).toMatchObject({
		stdoutExcerpt: original.stdoutExcerpt,
		stderrExcerpt: original.stderrExcerpt,
		exitCode: original.exitCode,
	});
});

test("V0 cancellation waits for process-tree cleanup and retains the actual terminal receipt", async () => {
	const marker = path.join(home, "v0-child.pid");
	const routine = createRoutine({
		name: "v0-cancel",
		cron: "0 1 * * *",
		actionKind: "bash",
		actionBody: `printf partial; sleep 30 & echo $! > '${marker}'; wait`,
		actionCwd: home,
		enabled: false,
	});
	const stop = async () => {
		const firing = runner.fire(routine.id);
		const deadline = Date.now() + 3000;
		while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
		expect(fs.existsSync(marker)).toBe(true);
		await runner.dispose();
		await firing;
		const pid = Number(fs.readFileSync(marker, "utf8"));
		const child = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
		const status = new TextDecoder().decode(child.stdout).trim();
		expect(status === "" || status.startsWith("Z")).toBe(true);
		runner = new RoutinesRunner();
		return listRuns(routine.id)[0]!;
	};
	const original = await stop();
	fs.rmSync(marker);
	expect(migrate(routine.id).reports[0]?.status).toBe("migrated");
	const native = await stop();
	expect(native).toMatchObject({
		stdoutExcerpt: original.stdoutExcerpt,
		stderrExcerpt: original.stderrExcerpt,
		exitCode: original.exitCode,
		stepCountTotal: 0,
		stepCountFailed: 0,
	});
	expect(native.abortReason).toBeUndefined();
	expect(getGraphRun(native.id)?.nodeRuns.find(node => node.type === "process.v0")?.diagnostics?.v0).toMatchObject({
		stdoutExcerpt: "partial",
		exitCode: native.exitCode,
	});
});
