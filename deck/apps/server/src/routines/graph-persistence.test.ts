import { stringifySettingsToml as stringifyToml } from "@oh-my-pi/pi-utils/settings-toml";
import { stringifySpec } from "../../../web/src/components/routines/spec-toml.ts";
import { importLegacyRoutineYaml } from "./legacy-yaml.ts";
import { migrateRoutines } from "./graph-migration.ts";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import { Hono } from "hono";
import { INBOX_CARD_ADDED_EVENT, inboxCardAddedNodeType, type InboxItem } from "@npi-deck/protocol";
import { createInbox, deleteInbox, getInbox, listInbox, updateInbox } from "../db/inbox.ts";
import { admitInboxGraphEvent, pendingInboxGraphEvents } from "../db/inbox-graph-events.ts";
import { startRun } from "../db/routines.ts";
import { buildInboxRouter } from "../routes-inbox.ts";
import { executeDeckStep } from "./steps/deck.ts";
import type {
	GraphNodeType,
	GraphObject,
	GraphOutput,
	GraphRunRecord,
	GraphValue,
	Routine,
	RoutineGraph,
	RoutineRun,
	RoutineSpec,
} from "@npi-deck/protocol";
import { closeDb, getDb, openDb } from "../db/index.ts";
import {
	createGraphRoutine,
	createRoutine,
	createV1Routine,
	getGraphRun,
	getRoutine,
	listRuns,
	updateGraphRoutine,
} from "../db/routines.ts";
import { listStepRuns } from "../db/routine-step-runs.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "../owned-process.ts";
import { buildRoutinesRouter } from "../routes-routines.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import { findGraphOutput, readGraphPath } from "./graph-runner.ts";

let home = "";
let runner: RoutinesRunner | undefined;
let oldHome: string | undefined;
let oldDb: string | undefined;
let inboxServer: Server<undefined> | undefined;
function setup(): RoutinesRunner {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "neodeck-graph-persistence-"));
	oldHome = process.env.NPI_DECK_HOME;
	oldDb = process.env.NPI_DECK_DB_PATH;
	process.env.NPI_DECK_HOME = home;
	process.env.NPI_DECK_DB_PATH = path.join(home, "deck.db");
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	initializeOwnedGeneration();
	runner = new RoutinesRunner();
	return runner;
}
afterEach(async () => {
	inboxServer?.stop(true);
	inboxServer = undefined;
	await runner?.dispose();
	await stopOwnedProcesses();
	closeDb();
	if (oldHome === undefined) delete process.env.NPI_DECK_HOME;
	else process.env.NPI_DECK_HOME = oldHome;
	if (oldDb === undefined) delete process.env.NPI_DECK_DB_PATH;
	else process.env.NPI_DECK_DB_PATH = oldDb;
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = "";
	runner = undefined;
});
function graph(eventType = "manual"): RoutineGraph {
	return { version: 2, nodes: [{ id: "source", type: "event.source", config: { eventType } }], edges: [] };
}
function definition(
	type: string,
	outputType: "object" | "string" | "number" = "object",
	multiple = false,
): GraphNodeType {
	return {
		type,
		label: type,
		kind: "operation",
		inputs: [{ id: "in", type: "object", multiple }],
		outputs: [{ id: "out", type: outputType }],
	};
}
function connect(spec: RoutineGraph, id: string, from: string, to: string, fromPort = "out", toPort = "in"): void {
	spec.edges.push({ id, from: { nodeId: from, port: fromPort }, to: { nodeId: to, port: toPort } });
}
function request(body: unknown, method = "POST"): RequestInit {
	return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

test("native save/load and metadata updates keep JSON as the only source and reject legacy authoring", async () => {
	const run = setup();
	const api = buildRoutinesRouter(run);
	const source = graph();
	source.layout = { nodes: { source: { x: 12, y: 34 } } };
	for (const legacy of [
		{ specToml: 'name = "wrong"' },
		{ cron: "* * * * *" },
		{ actionKind: "bash" },
		{ actionBody: "echo wrong" },
		{ actionCwd: home },
	]) {
		expect((await api.request("/routines", request({ name: "mixed", graph: source, ...legacy }))).status).toBe(400);
	}
	const response = await api.request("/routines", request({ name: "native", graph: source }));
	expect(response.status).toBe(201);
	const saved = (await response.json()) as Routine;
	expect(saved.specVersion).toBe(2);
	expect(getRoutine(saved.id)?.graph).toEqual(source);
	const row = getDb()
		.query<{ graph_json: string; spec_toml: string | null }, [string]>(
			"SELECT graph_json, spec_toml FROM routines WHERE id = ?",
		)
		.get(saved.id)!;
	expect(JSON.parse(row.graph_json)).toEqual(source);
	expect(row.spec_toml).toBeNull();
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	expect(getRoutine(saved.id)?.graph).toEqual(source);
	for (const patch of [
		{ specToml: 'name = "wrong"' },
		{ cron: "* * * * *" },
		{ actionKind: "bash" },
		{ actionBody: "echo wrong" },
		{ actionCwd: home },
	]) {
		expect((await api.request(`/routines/${saved.id}`, request(patch, "PATCH"))).status).toBe(400);
		expect(getRoutine(saved.id)?.graph).toEqual(source);
	}
	const patch = await api.request(
		`/routines/${saved.id}`,
		request({ name: "renamed", description: "still native", enabled: false }, "PATCH"),
	);
	expect(patch.status).toBe(200);
	expect(getRoutine(saved.id)).toMatchObject({ name: "renamed", enabled: false, graph: source });
	const changed = graph("inbox");
	expect((await api.request(`/routines/${saved.id}`, request({ graph: changed }, "PATCH"))).status).toBe(200);
	expect(((await (await api.request(`/routines/${saved.id}`)).json()) as Routine).graph).toEqual(changed);
});

test("registered config schema, native API manual execution and catalogue share the same real registry", async () => {
	const run = setup();
	const multiply: GraphNodeType = {
		...definition("multiply", "number"),
		configSchema: {
			type: "object",
			properties: { factor: { type: "number" } },
			required: ["factor"],
			additionalProperties: false,
		},
	};
	run.graphRegistry.register({
		definition: multiply,
		execute: ({ node, inputs }) => [
			{
				port: "out",
				value: (inputs[0]!.output.result.count as number) * (node.config.factor as number),
			},
		],
	});
	const api = buildRoutinesRouter(run);
	const native = graph();
	native.nodes.push({ id: "multiply", type: "multiply", config: { factor: 3 } });
	connect(native, "multiply-edge", "source", "multiply", "event");
	const invalid = structuredClone(native);
	invalid.nodes[1]!.config.factor = "not numeric";
	expect((await api.request("/routines", request({ name: "invalid config", graph: invalid }))).status).toBe(400);
	const saved = (await (
		await api.request("/routines", request({ name: "multiply", graph: native, enabled: false }))
	).json()) as Routine;
	const catalogue = (await (await api.request("/routine-node-types")).json()) as { nodeTypes: GraphNodeType[] };
	expect(catalogue.nodeTypes.find(type => type.type === "multiply")).toEqual(multiply);
	await run.fireGraphEvent(saved.id, { eventType: "manual", event: { count: 99 } });
	expect(listRuns(saved.id)).toEqual([]);
	const response = await api.request(`/routines/${saved.id}/run`, request({ count: 7 }));
	expect(response.status).toBe(202);
	const deadline = Date.now() + 3000;
	let trace: GraphRunRecord | undefined;
	while (!trace && Date.now() < deadline) {
		await Bun.sleep(10);
		const record = listRuns(saved.id)[0];
		if (record) trace = getGraphRun(record.id);
	}
	expect(trace).toMatchObject({ status: "success", activation: { eventType: "manual", event: { count: 7 } } });
	const result = trace?.nodeRuns.find(node => node.nodeId === "multiply")?.outputs[0];
	expect(result).toMatchObject({ result: { value: 21 }, inputs: [{ result: { count: 7 } }] });
	expect(listRuns(saved.id)[0]?.trigger).toBe("manual");
});

test("invalid typed edges fail before save, update or dispatch even if the stored graph is corrupted", async () => {
	const run = setup();
	let calls = 0;
	run.graphRegistry.register({
		definition: definition("text", "string"),
		execute: () => {
			calls++;
			return [{ port: "out", value: "truthy" }];
		},
	});
	run.graphRegistry.register({
		definition: { ...definition("number"), inputs: [{ id: "in", type: "number" }] },
		execute: () => {
			calls++;
			return [{ port: "out", value: 1 }];
		},
	});
	const invalid = graph();
	invalid.nodes.push({ id: "text", type: "text", config: {} }, { id: "number", type: "number", config: {} });
	connect(invalid, "source-text", "source", "text", "event");
	connect(invalid, "text-number", "text", "number");
	const api = buildRoutinesRouter(run);
	expect((await api.request("/routine-graphs/validate", request(invalid))).status).toBe(400);
	expect((await api.request("/routines", request({ name: "invalid", graph: invalid }))).status).toBe(400);
	expect(() => createGraphRoutine({ name: "invalid", graph: invalid }, run.graphRegistry)).toThrow("invalid graph");
	const valid = createGraphRoutine({ name: "valid", graph: graph() }, run.graphRegistry);
	expect((await api.request(`/routines/${valid.id}`, request({ graph: invalid }, "PATCH"))).status).toBe(400);
	expect(() => updateGraphRoutine(valid.id, { graph: invalid }, run.graphRegistry)).toThrow("invalid graph");
	expect(getRoutine(valid.id)?.graph).toEqual(graph());
	getDb().query("UPDATE routines SET graph_json = ? WHERE id = ?").run(JSON.stringify(invalid), valid.id);
	expect((await api.request(`/routines/${valid.id}/run`, request({}))).status).toBe(400);
	await expect(run.fire(valid.id)).rejects.toThrow("invalid graph");
	expect(listRuns(valid.id)).toEqual([]);
	expect(calls).toBe(0);
});

test("actual native run preserves truthy scalar, object and ordered recursive provenance after later edits", async () => {
	const run = setup();
	const event = { original: { nested: [1, "not true", false] }, text: "original event" };
	const object = { exact: { value: 7 } };
	const seen: GraphOutput[] = [];
	run.graphRegistry.register({
		definition: definition("text", "string"),
		execute: ({ inputs }) => {
			expect(inputs[0]!.output.result).toBe(event);
			return [{ port: "out", value: "truthy-not-boolean" }];
		},
	});
	run.graphRegistry.register({
		definition: definition("numeric", "number"),
		execute: () => [{ port: "out", value: 1 }],
	});
	run.graphRegistry.register({ definition: definition("object"), execute: () => [{ port: "out", value: object }] });
	run.graphRegistry.register({
		definition: definition("join", "object", true),
		execute: ({ inputs }) => {
			seen.push(...inputs.map(input => input.output));
			expect(inputs.map(input => input.output.nodeId)).toEqual(["number", "text", "object"]);
			expect(inputs[2]!.output.result).toBe(object);
			expect(readGraphPath(inputs[1]!.output, ["result", "value"])).toBe("truthy-not-boolean");
			expect(findGraphOutput(inputs[1]!.output, "source")?.result).toBe(event);
			return [{ port: "out", value: { values: inputs.map(input => input.output.result) } }];
		},
	});
	const native = graph("inbox");
	native.nodes.push(
		{ id: "text", type: "text", config: {} },
		{ id: "number", type: "numeric", config: {} },
		{ id: "object", type: "object", config: {} },
		{ id: "join", type: "join", config: {} },
	);
	for (const node of ["text", "number", "object"]) connect(native, `source-${node}`, "source", node, "event");
	for (const node of ["number", "text", "object"]) connect(native, `${node}-join`, node, "join");
	const saved = createGraphRoutine({ name: "provenance", graph: native }, run.graphRegistry);
	await run.fireGraphEvent(saved.id, { eventType: "inbox", event });
	const record = listRuns(saved.id)[0]!;
	const trace = getGraphRun(record.id)!;
	expect(trace.status).toBe("success");
	expect(record.exitCode).toBe(0);
	expect(trace.activation.event).toEqual(event);
	const join = trace.nodeRuns.find(node => node.nodeId === "join")!;
	expect(join.outputs[0]!.inputs).toEqual(seen);
	expect(join.inputs.map(input => input.result)).toEqual([{ value: 1 }, { value: "truthy-not-boolean" }, object]);
	expect(findGraphOutput(join.outputs[0]!, "source")?.result).toEqual(event);
	expect(readGraphPath(join.outputs[0]!, ["inputs", 1, "inputs", 0, "result", "original", "nested", 1])).toBe(
		"not true",
	);
	const changed = graph("different");
	updateGraphRoutine(saved.id, { graph: changed }, run.graphRegistry);
	const api = buildRoutinesRouter(run);
	const response = await api.request(`/routines/${saved.id}/runs/${record.id}/graph`);
	expect(response.status).toBe(200);
	expect(((await response.json()) as GraphRunRecord).graph).toEqual(native);
	expect(getRoutine(saved.id)?.graph).toEqual(changed);
	expect((await api.request(`/routines/other/runs/${record.id}/graph`)).status).toBe(404);
	const listing = (await (await api.request(`/routines/${saved.id}/runs`)).json()) as { runs: RoutineRun[] };
	expect(listing.runs[0]).not.toHaveProperty("graph");
	expect(listing.runs[0]).not.toHaveProperty("nodeRuns");
});

test("stored graph traces redact user credential fields without mutating execution inputs or usage metadata", async () => {
	const run = setup();
	const event = {
		access_token: "test-event-token",
		ordinary: { count: 17, truthy: "not-literal-true", enabled: false, absent: null },
		nested: { Password: 17, list: [{ "api-key": "test-nested-key", kept: 1 }] },
	};
	const original = structuredClone(event);
	let received: unknown;
	run.graphRegistry.register({
		definition: definition("inspect", "number"),
		execute: ({ activation, inputs, node, recordUsage }) => {
			received = inputs[0]!.output.result;
			expect(activation.event).toBe(event);
			expect(received).toBe(event);
			expect(node.config.API_KEY).toBe("test-config-key");
			recordUsage({ llmTokensIn: 7, llmTokensOut: 9, llmCostMicros: 10 });
			return [{ port: "out", value: 1 }];
		},
	});
	const native = graph();
	native.budget = { max_steps_executed: 3 };
	native.nodes.push({ id: "inspect", type: "inspect", config: { API_KEY: "test-config-key", allowance: 17 } });
	connect(native, "inspect-input", "source", "inspect", "event");
	const saved = createGraphRoutine({ name: "protected-provenance", graph: native }, run.graphRegistry);
	await run.fire(saved.id, "manual", event);
	const record = listRuns(saved.id)[0]!;
	const trace = getGraphRun(record.id)!;
	const protectedEvent = {
		...event,
		access_token: "[redacted]",
		nested: { Password: "[redacted]", list: [{ "api-key": "[redacted]", kept: 1 }] },
	};
	expect(record.exitCode).toBe(0);
	expect(received).toBe(event);
	expect(event).toEqual(original);
	expect(JSON.parse(record.triggerPayload!)).toEqual(protectedEvent);
	expect(trace.activation.event).toEqual(protectedEvent);
	expect(trace.outputs.find(output => output.nodeId === "source")?.result).toEqual(protectedEvent);
	const inspected = trace.nodeRuns.find(node => node.nodeId === "inspect")!;
	expect(inspected.inputs[0]!.result).toEqual(protectedEvent);
	expect(findGraphOutput(inspected.outputs[0]!, "source")?.result).toEqual(protectedEvent);
	expect(inspected.outputs[0]!.result).toEqual({ value: 1 });
	expect(trace.usage).toEqual({ stepsExecuted: 2, llmTokensIn: 7, llmTokensOut: 9, llmCostMicros: 10 });
	expect(trace.graph.budget).toEqual(native.budget);
	expect(trace.graph.nodes[1]!.config).toEqual({ API_KEY: "[redacted]", allowance: 17 });
	expect(native.nodes[1]!.config.API_KEY).toBe("test-config-key");
	const stored = getDb()
		.query<{ graph_run_json: string }, [string]>("SELECT graph_run_json FROM routine_runs WHERE id = ?")
		.get(record.id)!.graph_run_json;
	for (const credential of ["test-event-token", "test-nested-key", "test-config-key"])
		expect(stored).not.toContain(credential);
	const api = buildRoutinesRouter(run);
	const response = await api.request(`/routines/${saved.id}/runs/${record.id}/graph`);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(trace);
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	expect(getGraphRun(record.id)).toEqual(trace);
});

test("recursive provenance cannot expand a moderate activation into an unbounded persisted trace", async () => {
	const run = setup();
	run.graphRegistry.register({
		definition: definition("pass"),
		execute: ({ inputs }) => [{ port: "out", value: inputs[0]!.output.result }],
	});
	const native = graph();
	let previous = "source";
	for (let index = 0; index < 100; index++) {
		const nodeId = `pass-${index}`;
		native.nodes.push({ id: nodeId, type: "pass", config: {} });
		connect(native, `edge-${index}`, previous, nodeId, previous === "source" ? "event" : "out");
		previous = nodeId;
	}
	const saved = createGraphRoutine({ name: "bounded-trace", graph: native }, run.graphRegistry);
	await run.fire(saved.id, "manual", { payload: "x".repeat(8 * 1024) });
	const record = listRuns(saved.id)[0]!;
	expect(record.endedAt).toBeDefined();
	expect(record.exitCode).toBe(1);
	expect(record.error).toContain("Graph trace exceeds");
	expect(record.stepCountTotal).toBe(101);
	expect(getGraphRun(record.id)).toBeUndefined();
	const row = getDb()
		.query<{ bytes: number | null }, [string]>(
			"SELECT length(graph_run_json) AS bytes FROM routine_runs WHERE id = ?",
		)
		.get(record.id)!;
	expect(row.bytes).toBeNull();
	const api = buildRoutinesRouter(run);
	const listing = (await (await api.request(`/routines/${saved.id}/runs`)).json()) as { runs: RoutineRun[] };
	expect(listing.runs[0]?.error).toContain("serialization budget");
	expect((await api.request(`/routines/${saved.id}/runs/${record.id}/graph`)).status).toBe(404);
});

test("oversized handler errors leave bounded history and retain incurred usage", async () => {
	const run = setup();
	run.graphRegistry.register({
		definition: definition("large-error"),
		execute: ({ recordUsage }) => {
			recordUsage({ llmTokensIn: 7, llmTokensOut: 9, llmCostMicros: 10 });
			throw new Error("oversized-handler-error ".repeat(500_000));
		},
	});
	const native = graph();
	native.nodes.push({ id: "failure", type: "large-error", config: {} });
	connect(native, "failure-input", "source", "failure", "event");
	const saved = createGraphRoutine({ name: "bounded-history-error", graph: native }, run.graphRegistry);
	await run.fire(saved.id, "manual", {});
	const record = listRuns(saved.id)[0]!;
	expect(record.exitCode).toBe(1);
	expect(record.error).toContain("serialization budget");
	expect(record.error!.length).toBeLessThanOrEqual(8192);
	expect(record.totalLlmTokens).toBe(16);
	expect(record.totalLlmCostMicros).toBe(10);
	expect(record.stepCountTotal).toBe(2);
	expect(record.stepCountFailed).toBe(1);
	expect(getGraphRun(record.id)).toBeUndefined();
});

test("serialization depth budget preserves completed execution aggregates independently of engine stack limits", async () => {
	const run = setup();
	let deep: GraphValue = "leaf";
	for (let index = 0; index < 20_000; index++) deep = { nested: deep };
	run.graphRegistry.register({
		definition: definition("deep-result"),
		execute: ({ recordUsage }) => {
			recordUsage({ llmTokensIn: 3, llmTokensOut: 5, llmCostMicros: 12 });
			return [{ port: "out", value: deep }];
		},
	});
	const native = graph();
	native.nodes.push({ id: "deep", type: "deep-result", config: {} });
	connect(native, "deep-input", "source", "deep", "event");
	const saved = createGraphRoutine({ name: "deep-history-error", graph: native }, run.graphRegistry);
	await run.fire(saved.id, "manual", {});
	const record = listRuns(saved.id)[0]!;
	expect(record.endedAt).toBeDefined();
	expect(record.exitCode).toBe(1);
	expect(record.error).toContain("serialization depth budget");
	expect(record.totalLlmTokens).toBe(8);
	expect(record.totalLlmCostMicros).toBe(12);
	expect(record.stepCountTotal).toBe(2);
	expect(record.stepCountFailed).toBe(0);
	expect(getGraphRun(record.id)).toBeUndefined();
});

test("native failures and usage-budget aborts finalize traces and existing run aggregates", async () => {
	const run = setup();
	run.graphRegistry.register({
		definition: definition("fail"),
		execute: () => {
			throw new Error("real handler failure");
		},
	});
	const failed = graph();
	failed.nodes.push({ id: "fail", type: "fail", config: {} });
	connect(failed, "fail-edge", "source", "fail", "event");
	const saved = createGraphRoutine({ name: "failed", graph: failed }, run.graphRegistry);
	await run.fire(saved.id, "manual", { original: "failure event" });
	const failureRun = listRuns(saved.id)[0]!;
	expect(getGraphRun(failureRun.id)).toMatchObject({ status: "failed", graph: failed });
	expect(getGraphRun(failureRun.id)?.nodeRuns.find(node => node.nodeId === "fail")).toMatchObject({
		status: "failed",
		inputs: [{ result: { original: "failure event" } }],
	});
	expect(failureRun).toMatchObject({ exitCode: 1, stepCountFailed: 1 });
	run.graphRegistry.register({
		definition: definition("usage"),
		execute: ({ recordUsage }) => {
			recordUsage({ llmTokensIn: 4, llmTokensOut: 2, llmCostMicros: 7 });
			return [{ port: "out", value: "used tokens" }];
		},
	});
	const budget = graph();
	budget.budget = { max_llm_tokens_input: 3 };
	budget.nodes.push({ id: "usage", type: "usage", config: {} });
	connect(budget, "usage-edge", "source", "usage", "event");
	const capped = createGraphRoutine({ name: "budget", graph: budget }, run.graphRegistry);
	await run.fire(capped.id);
	const aborted = listRuns(capped.id)[0]!;
	expect(aborted).toMatchObject({ abortReason: "budget", totalLlmTokens: 6, totalLlmCostMicros: 7 });
	expect(getGraphRun(aborted.id)).toMatchObject({ status: "aborted", abortReason: "budget" });
});

test("queued native runs execute their admission snapshot and release concurrency/work lifecycle", async () => {
	const run = setup();
	const entered = deferred();
	const release = deferred();
	const executed: string[] = [];
	run.graphRegistry.register({
		definition: definition("wait"),
		execute: async ({ inputs, node }) => {
			executed.push(node.config.label as string);
			if (inputs[0]!.output.result.invocation === "first") {
				entered.resolve();
				await release.promise;
			}
			return [{ port: "out", value: node.config.label }];
		},
	});
	const native = graph();
	native.concurrency = "queue";
	native.nodes.push({ id: "wait", type: "wait", config: { label: "original" } });
	connect(native, "wait-edge", "source", "wait", "event");
	const saved = createGraphRoutine({ name: "queue", graph: native }, run.graphRegistry);
	const first = run.fire(saved.id, "manual", { invocation: "first" });
	await entered.promise;
	const second = run.fire(saved.id, "manual", { invocation: "second" });
	expect(run.workSnapshot.map(work => work.routineId)).toEqual([saved.id, saved.id]);
	const changed = structuredClone(native);
	changed.nodes[1]!.config.label = "edited";
	updateGraphRoutine(saved.id, { graph: changed }, run.graphRegistry);
	release.resolve();
	await Promise.all([first, second]);
	expect(executed).toEqual(["original", "original"]);
	for (const record of listRuns(saved.id)) expect(getGraphRun(record.id)?.graph).toEqual(native);
	expect(run.workSnapshot).toEqual([]);
	expect(run.concurrency.snapshot().filter(entry => entry.active || entry.queued)).toEqual([]);
});

test("dispose aborts a native handler and concurrency-skipped runs retain a trace", async () => {
	const run = setup();
	const entered = deferred();
	run.graphRegistry.register({
		definition: definition("wait"),
		execute: async ({ signal }) => {
			entered.resolve();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			return [{ port: "out", value: "aborted work" }];
		},
	});
	const native = graph();
	native.nodes.push({ id: "wait", type: "wait", config: {} });
	connect(native, "wait-edge", "source", "wait", "event");
	const saved = createGraphRoutine({ name: "abort", graph: native }, run.graphRegistry);
	const first = run.fire(saved.id);
	await entered.promise;
	await run.fire(saved.id);
	await run.dispose();
	await first;
	const records = listRuns(saved.id);
	expect(records.map(record => record.abortReason).sort()).toEqual(["cancelled", "concurrency_skipped"]);
	for (const record of records) expect(getGraphRun(record.id)).toMatchObject({ status: "aborted", graph: native });
	expect(run.busy).toBe(false);
});

test("manual activation records unmatched event sources and their consumers as skipped without inventing outputs", async () => {
	const run = setup();
	let executions = 0;
	run.graphRegistry.register({
		definition: definition("consumer"),
		execute: () => {
			executions++;
			return [{ port: "out", value: "must not run" }];
		},
	});
	const native = graph("inbox");
	native.nodes.push({ id: "consumer", type: "consumer", config: {} });
	connect(native, "event-edge", "source", "consumer", "event");
	const saved = createGraphRoutine({ name: "unmatched", graph: native }, run.graphRegistry);
	await run.fire(saved.id, "manual", { value: "not an inbox activation" });
	const trace = getGraphRun(listRuns(saved.id)[0]!.id)!;
	expect(trace.activation.eventType).toBe("manual");
	expect(trace.nodeRuns.map(node => ({ id: node.nodeId, status: node.status, outputs: node.outputs }))).toEqual([
		{ id: "source", status: "skipped", outputs: [] },
		{ id: "consumer", status: "skipped", outputs: [] },
	]);
	expect(trace.outputs).toEqual([]);
	expect(executions).toBe(0);
});

test("native cron activates its configured source and never falls back to the legacy cron mirror", async () => {
	const run = setup();
	const manual = createGraphRoutine({ name: "no native cron", graph: graph() }, run.graphRegistry);
	getDb().query("UPDATE routines SET cron = ? WHERE id = ?").run("* * * * * *", manual.id);
	run.schedule(getRoutine(manual.id)!);
	expect(getRoutine(manual.id)?.nextRunAt).toBeUndefined();

	const native = graph("tick");
	native.nodes[0]!.config.cron = "* * * * * *";
	native.nodes.push({ id: "manual-only", type: "event.source", config: { eventType: "manual" } });
	const saved = createGraphRoutine({ name: "native clock", graph: native }, run.graphRegistry);
	run.schedule(saved);
	const deadline = Date.now() + 3000;
	let trace: GraphRunRecord | undefined;
	while (!trace && Date.now() < deadline) {
		await Bun.sleep(20);
		const record = listRuns(saved.id)[0];
		if (record) trace = getGraphRun(record.id);
	}
	run.unschedule(saved.id);
	expect(trace).toMatchObject({
		status: "success",
		activation: { eventType: "tick", sourceNodeId: "source" },
	});
	expect(trace?.activation.event).toEqual(trace?.nodeRuns.find(node => node.nodeId === "source")?.outputs[0]?.result);
	expect(trace?.nodeRuns.find(node => node.nodeId === "manual-only")?.status).toBe("skipped");
	expect(listRuns(saved.id)[0]?.trigger).toBe("cron");
	expect(listRuns(manual.id)).toEqual([]);
});

test("legacy V0 and V1 still execute their own stored source without graph traces", async () => {
	const run = setup();
	const legacy = createRoutine({
		name: "legacy",
		cron: "0 0 1 1 *",
		actionKind: "bash",
		actionBody: "printf legacy-output",
		actionCwd: home,
	});
	const spec: RoutineSpec = {
		name: "pipeline",
		trigger: [{ manual: {} }],
		steps: [{ id: "print", type: "run", command: "printf pipeline-output" }],
	};
	const toml = stringifyToml(spec);
	const pipeline = createV1Routine({ name: spec.name, spec, specToml: toml });
	const api = buildRoutinesRouter(run);
	for (const saved of [legacy, pipeline])
		expect((await api.request(`/routines/${saved.id}`, request({ graph: graph() }, "PATCH"))).status).toBe(400);
	await run.fire(legacy.id);
	await run.fire(pipeline.id);
	const legacyRun = listRuns(legacy.id)[0]!;
	const pipelineRun = listRuns(pipeline.id)[0]!;
	expect(legacyRun).toMatchObject({ exitCode: 0, stdoutExcerpt: "legacy-output" });
	expect(pipelineRun.exitCode).toBe(0);
	expect(listStepRuns(pipelineRun.id)[0]).toMatchObject({ status: "success", stdoutExcerpt: "pipeline-output" });
	expect(getRoutine(pipeline.id)?.specToml).toBe(toml);
	expect(getGraphRun(legacyRun.id)).toBeUndefined();
	expect(getGraphRun(pipelineRun.id)).toBeUndefined();
});

function inboxGraph(): RoutineGraph {
	const native = graph(INBOX_CARD_ADDED_EVENT);
	native.nodes[0]!.type = INBOX_CARD_ADDED_EVENT;
	native.concurrency = "queue";
	return native;
}

async function settleInbox(run: RoutinesRunner): Promise<void> {
	const deadline = Date.now() + 3000;
	while (run.busy && Date.now() < deadline) await Bun.sleep(10);
	expect(run.busy).toBe(false);
}

test("production inbox source catalogue and config validation expose one native contract", async () => {
	const run = setup();
	const api = buildRoutinesRouter(run);
	const catalogue = (await (await api.request("/routine-node-types")).json()) as { nodeTypes: GraphNodeType[] };
	expect(catalogue.nodeTypes.find(node => node.type === INBOX_CARD_ADDED_EVENT)).toEqual(inboxCardAddedNodeType);
	expect((await api.request("/routine-graphs/validate", request(inboxGraph()))).status).toBe(200);
	const configs: GraphObject[] = [
		{},
		{ eventType: "other" },
		{ eventType: INBOX_CARD_ADDED_EVENT, cron: "* * * * *" },
	];
	for (const config of configs) {
		const native = inboxGraph();
		native.nodes[0]!.config = config;
		expect((await api.request("/routine-graphs/validate", request(native))).status).toBe(400);
	}
});

test("HTTP and internal card creation fan out once per source with committed original provenance", async () => {
	const run = setup();
	run.graphRegistry.register({
		definition: definition("intake"),
		execute: ({ activation, inputs, recordUsage }) => {
			expect(activation.event).toBe(inputs[0]!.output.result);
			recordUsage({ llmTokensIn: 2, llmTokensOut: 3 });
			return [{ port: "out", value: "truthy-not-true" }];
		},
	});
	run.graphRegistry.register({
		definition: definition("inspect"),
		execute: ({ inputs }) => {
			const source = findGraphOutput(inputs[0]!.output, "source")!;
			expect(source.result.body).toBe("");
			return [{ port: "out", value: { empty: [], no: false, zero: 0, nil: null } }];
		},
	});
	const native = inboxGraph();
	native.nodes.push(
		{ id: "intake", type: "intake", config: {} },
		{ id: "inspect", type: "inspect", config: {} },
		{ id: "second", type: INBOX_CARD_ADDED_EVENT, config: { eventType: INBOX_CARD_ADDED_EVENT } },
		{ id: "other", type: "event.source", config: { eventType: "unmatched" } },
	);
	connect(native, "intake", "source", "intake", "event");
	connect(native, "inspect", "intake", "inspect");
	const saved = createGraphRoutine({ name: "configured intake", graph: native }, run.graphRegistry);
	const subscriber = createGraphRoutine({ name: "second subscriber", graph: inboxGraph() }, run.graphRegistry);
	run.start();
	const app = new Hono().route("/api", buildInboxRouter()).route("/api", buildRoutinesRouter(run));
	inboxServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	const url = `http://127.0.0.1:${inboxServer.port}/api`;
	const input = { kind: "capture", title: "same text", body: "", source: "" };
	const created = await fetch(`${url}/inbox`, {
		...request(input),
		headers: { "content-type": "application/json", "Idempotency-Key": "one-delivery" },
	});
	expect(created.status).toBe(201);
	const first = { ...((await created.json()) as InboxItem) };
	const repeated = await fetch(`${url}/inbox`, {
		...request(input),
		headers: { "content-type": "application/json", "Idempotency-Key": "one-delivery" },
	});
	expect(((await repeated.json()) as InboxItem).id).toBe(first.id);
	const result = await executeDeckStep(
		{
			id: "create",
			type: "deck",
			action: "create_inbox_item",
			kind: "capture",
			title: input.title,
			body: "",
			source: "",
		},
		{
			run: { id: "test", started: "", iso_started: "", date: "", trigger_kind: "manual" },
			trigger: {},
			steps: {},
			env: {},
			secrets: {},
			state: {},
		},
		AbortSignal.timeout(3000),
	);
	expect(result.status).toBe("success");
	const second = { ...listInbox({}).find(card => card.id !== first.id)! };
	expect(second.title).toBe(first.title);
	expect(second.id).not.toBe(first.id);
	await Promise.all(
		Array.from({ length: 8 }, () =>
			run.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, event: { ...first } }),
		),
	);
	await settleInbox(run);
	expect(listRuns(saved.id)).toHaveLength(4);
	expect(listRuns(subscriber.id)).toHaveLength(2);
	for (const record of listRuns(saved.id)) {
		const response = await fetch(`${url}/routines/${saved.id}/runs/${record.id}/graph`);
		expect(response.status).toBe(200);
		const trace = (await response.json()) as GraphRunRecord;
		const card = (trace.activation.event as GraphObject).id === first.id ? first : second;
		expect(trace.activation.event).toEqual(card);
		expect(trace.graph).toEqual(native);
		expect(trace.status).toBe("success");
		const selected = trace.activation.sourceNodeId!;
		const source = trace.nodeRuns.find(node => node.nodeId === selected)!;
		expect(source).toMatchObject({
			status: "success",
			inputs: [],
			inputPorts: [],
			outputs: [{ nodeId: selected, port: "event", result: card, inputs: [] }],
		});
		expect(trace.nodeRuns.find(node => node.nodeId === "other")?.status).toBe("skipped");
		if (selected === "source") {
			const output = trace.nodeRuns.find(node => node.nodeId === "inspect")!.outputs[0]!;
			expect(findGraphOutput(output, "source")?.result).toEqual(card);
			expect(readGraphPath(output, ["inputs", "0", "result", "value"])).toBe("truthy-not-true");
			expect(output.result).toEqual({ empty: [], no: false, zero: 0, nil: null });
			expect(record.totalLlmTokens).toBe(5);
		} else expect(trace.nodeRuns.find(node => node.nodeId === "source")?.status).toBe("skipped");
	}
	const before = listRuns(saved.id).length;
	await fetch(`${url}/inbox/${first.id}`);
	await fetch(`${url}/inbox/${first.id}`, request({ body: "edited", processed: true }, "PATCH"));
	await fetch(`${url}/inbox/${second.id}/promote`, request({}));
	await fetch(`${url}/inbox/${second.id}`, { method: "DELETE" });
	await settleInbox(run);
	expect(listRuns(saved.id)).toHaveLength(before);
});

test("old cards, failed transactions, disabled flows and unmatched notifications never become new intake", async () => {
	const run = setup();
	const old = createInbox({ kind: "idea", title: "before configuration" });
	const saved = createGraphRoutine({ name: "disabled", graph: inboxGraph(), enabled: false }, run.graphRegistry);
	createInbox({ kind: "idea", title: "while disabled" });
	updateGraphRoutine(saved.id, { enabled: true }, run.graphRegistry);
	run.start();
	expect(listRuns(saved.id)).toEqual([]);
	expect(() =>
		getDb().transaction(() => {
			createInbox({ kind: "capture", title: "rolled back" });
			throw new Error("rollback");
		})(),
	).toThrow("rollback");
	expect(() => createInbox({ kind: "idea", title: null as unknown as string })).toThrow();
	expect(listInbox({})).toHaveLength(2);
	await run.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, event: { ...old } });
	expect(pendingInboxGraphEvents()).toEqual([]);
	expect(listRuns(saved.id)).toEqual([]);
	const card = createInbox({ kind: "ticket", title: "new" });
	await settleInbox(run);
	expect(listRuns(saved.id)).toHaveLength(1);
	await run.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, sourceNodeId: "wrong", event: { ...card } });
	await settleInbox(run);
	expect(listRuns(saved.id)).toHaveLength(1);
	updateInbox(card.id, { processed: true });
	getInbox(card.id);
	deleteInbox(card.id);
	expect(listRuns(saved.id)).toHaveLength(1);
});

test("restart resumes only committed pending deliveries and never repeats admitted cards", async () => {
	const run = setup();
	const saved = createGraphRoutine({ name: "pending across restart", graph: inboxGraph() }, run.graphRegistry);
	const card = { ...createInbox({ kind: "capture", title: "committed while runner offline", body: "" }) };
	await run.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, sourceNodeId: "wrong", event: { ...card } });
	expect(listRuns(saved.id)).toEqual([]);
	updateInbox(card.id, { body: "edited before dispatch" });
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	run.start();
	await settleInbox(run);
	expect(listRuns(saved.id)).toHaveLength(1);
	await run.dispose();
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	runner = new RoutinesRunner();
	runner.start();
	await Promise.all(
		Array.from({ length: 4 }, () =>
			runner!.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, event: { ...card } }),
		),
	);
	expect(listRuns(saved.id)).toHaveLength(1);
	const trace = getGraphRun(listRuns(saved.id)[0]!.id)!;
	expect(trace.activation.event).toEqual(card);
	expect(trace.nodeRuns[0]!.outputs[0]!.result).toEqual(card);
});

test("interrupted admitted intake is visibly aborted at restart rather than replayed", async () => {
	const run = setup();
	const saved = createGraphRoutine({ name: "interrupted", graph: inboxGraph() }, run.graphRegistry);
	const card = createInbox({ kind: "capture", title: "admitted before crash" });
	const delivery = pendingInboxGraphEvents()[0]!;
	const admitted = admitInboxGraphEvent(saved.id, delivery.activation, saved.graph!, () =>
		startRun(saved.id, "event", delivery.activation.event),
	)!;
	updateGraphRoutine(saved.id, { graph: graph("different") }, run.graphRegistry);
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	run.start();
	await run.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, event: { ...card } });
	expect(listRuns(saved.id)).toHaveLength(1);
	expect(getGraphRun(admitted.id)).toMatchObject({
		status: "aborted",
		graph: saved.graph,
		activation: delivery.activation,
		error: "server_restarted: intake may have run; not replayed",
	});
	expect(listRuns(saved.id)[0]?.abortReason).toBe("server_restarted");
});

test("pending work disabled before dispatch is discarded and admission rollback does not consume delivery", async () => {
	const run = setup();
	const saved = createGraphRoutine({ name: "pending disabled", graph: inboxGraph() }, run.graphRegistry);
	const first = createInbox({ kind: "capture", title: "disabled before dispatch" });
	updateGraphRoutine(saved.id, { enabled: false }, run.graphRegistry);
	run.start();
	updateGraphRoutine(saved.id, { enabled: true }, run.graphRegistry);
	await run.fireGraphEvent(saved.id, { eventType: INBOX_CARD_ADDED_EVENT, event: { ...first } });
	expect(listRuns(saved.id)).toEqual([]);
	expect(pendingInboxGraphEvents()).toEqual([]);
	await run.dispose();
	const second = { ...createInbox({ kind: "capture", title: "admission rollback" }) };
	const delivery = pendingInboxGraphEvents()[0]!;
	expect(() =>
		admitInboxGraphEvent(saved.id, delivery.activation, saved.graph!, () => {
			startRun(saved.id, "event", delivery.activation.event);
			throw new Error("admission failed");
		}),
	).toThrow("admission failed");
	expect(listRuns(saved.id)).toEqual([]);
	expect(pendingInboxGraphEvents()).toHaveLength(1);
	runner = new RoutinesRunner();
	runner.start();
	await settleInbox(runner);
	expect(listRuns(saved.id)).toHaveLength(1);
	expect(getGraphRun(listRuns(saved.id)[0]!.id)?.activation.event).toEqual(second);
});

test("a graph-created card gets its own new event, and failing intake is not successful filing", async () => {
	const run = setup();
	run.graphRegistry.register({
		definition: definition("create-child"),
		execute: ({ activation }) => {
			if ((activation.event as GraphObject).source !== "child")
				createInbox({ kind: "capture", title: "child", source: "child" });
			return [{ port: "out", value: (activation.event as GraphObject).id! }];
		},
	});
	const native = inboxGraph();
	native.nodes.push({ id: "child", type: "create-child", config: {} });
	connect(native, "child", "source", "child", "event");
	const saved = createGraphRoutine({ name: "configured create-card consumer", graph: native }, run.graphRegistry);
	run.start();
	const parent = createInbox({ kind: "capture", title: "parent" });
	await settleInbox(run);
	expect(listRuns(saved.id)).toHaveLength(2);
	expect(
		new Set(listRuns(saved.id).map(record => (getGraphRun(record.id)!.activation.event as GraphObject).id)).size,
	).toBe(2);
	expect(getInbox(parent.id)?.processedAt).toBeUndefined();
	run.graphRegistry.register({
		definition: definition("fail-intake"),
		execute: () => {
			throw new Error("intake failed");
		},
	});
	native.nodes[1]!.type = "fail-intake";
	updateGraphRoutine(saved.id, { graph: native }, run.graphRegistry);
	const failed = createInbox({ kind: "ticket", title: "do not infer filed" });
	await settleInbox(run);
	const record = listRuns(saved.id).find(
		record => (getGraphRun(record.id)!.activation.event as GraphObject).id === failed.id,
	)!;
	expect(getGraphRun(record.id)).toMatchObject({
		status: "failed",
		nodeRuns: [{ status: "success" }, { status: "failed", inputs: [{ result: failed }], inputPorts: ["in"] }],
	});
	expect(getInbox(failed.id)?.processedAt).toBeUndefined();
});

test("production iteration gates persist distinct passes and the executed snapshot through the HTTP trace route", async () => {
	const run = setup(),
		api = buildRoutinesRouter(run);
	const body: GraphObject = {
		version: 2,
		nodes: [
			{ id: "item", type: "iteration.input", config: { eventType: "iteration" } },
			{ id: "gate", type: "gate.if", config: { path: ["result", "item"] } },
			{ id: "truthy", type: "gate.compare", config: { path: ["result", "value"], operator: "ne", right: true } },
			{ id: "falsy", type: "gate.member", config: { path: ["result", "value"], values: [false, 0] } },
		],
		edges: [
			{ id: "i-g", from: { nodeId: "item", port: "item" }, to: { nodeId: "gate", port: "input" } },
			{ id: "g-t", from: { nodeId: "gate", port: "true" }, to: { nodeId: "truthy", port: "input" } },
			{ id: "g-f", from: { nodeId: "gate", port: "false" }, to: { nodeId: "falsy", port: "input" } },
		],
	};
	const native = graph();
	native.nodes.push({
		id: "loop",
		type: "iteration.each",
		config: { path: ["result", "items"], maxIterations: 3, body },
	});
	connect(native, "s-l", "source", "loop", "event", "input");
	const response = await api.request(
		"/routines",
		request({ name: "real gates and iteration", graph: native, enabled: false }),
	);
	expect(response.status).toBe(201);
	const saved = (await response.json()) as Routine;
	const event = { items: ["truthy-not-true", true, 0], original: { message: "original event" } };
	expect((await api.request(`/routines/${saved.id}/run`, request(event))).status).toBe(202);
	let trace: GraphRunRecord | undefined;
	const deadline = Date.now() + 3000;
	while (!trace && Date.now() < deadline) {
		await Bun.sleep(10);
		const record = listRuns(saved.id)[0];
		if (record) trace = getGraphRun(record.id);
	}
	expect(trace?.status).toBe("success");
	const loop = trace!.nodeRuns[1]!;
	expect(loop.passes).toHaveLength(3);
	for (const [index, pass] of loop.passes!.entries()) {
		expect(pass.outputs[0]?.result).toEqual({ item: event.items[index], index, count: 3 });
		expect(pass.outputs[0]?.iteration).toEqual([{ nodeId: "loop", index }]);
		const gate = pass.nodeRuns.find(node => node.nodeId === "gate")!.outputs[0]!;
		expect(gate.port).toBe(index === 2 ? "false" : "true");
		expect(gate.result).toEqual({ value: event.items[index]! });
		expect(findGraphOutput(pass.outputs.at(-1)!, "source")?.result).toEqual(event);
	}
	expect(loop.passes![0]!.nodeRuns[2]!.outputs[0]!.port).toBe("true");
	expect(loop.passes![1]!.nodeRuns[2]!.outputs[0]!.port).toBe("false");
	expect(loop.passes![2]!.nodeRuns[3]!.outputs[0]!.result).toEqual({ value: 0 });
	updateGraphRoutine(saved.id, { graph: graph("edited") }, run.graphRegistry);
	const persistedResponse = await api.request(`/routines/${saved.id}/runs/${trace!.id}/graph`);
	expect(persistedResponse.status).toBe(200);
	const persisted = (await persistedResponse.json()) as GraphRunRecord;
	expect(persisted.graph).toEqual(native);
	expect(
		findGraphOutput(persisted.nodeRuns[1]!.outputs[0]!, "gate", undefined, [{ nodeId: "loop", index: 1 }])?.result,
	).toEqual({ value: true });
	expect(persisted.nodeRuns[1]!.passes).toEqual(loop.passes);
});

test("native preview returns real per-pass provenance and planned actions without database writes", async () => {
	const run = setup(),
		api = buildRoutinesRouter(run),
		native = graph("inbox.card_added");
	const body: GraphObject = {
		version: 2,
		nodes: [
			{ id: "item", type: "iteration.input", config: { eventType: "iteration" } },
			{ id: "gate", type: "gate.if", config: { path: ["result", "item"] } },
			{
				id: "card",
				type: "action.create-card",
				config: { request: { title: "Preview only", body: "Never written" } },
			},
		],
		edges: [
			{ id: "item-gate", from: { nodeId: "item", port: "item" }, to: { nodeId: "gate", port: "input" } },
			{ id: "gate-card", from: { nodeId: "gate", port: "true" }, to: { nodeId: "card", port: "in" } },
		],
	};
	native.nodes.push({
		id: "loop",
		type: "iteration.each",
		config: { path: ["result", "items"], maxIterations: 3, body },
	});
	connect(native, "source-loop", "source", "loop", "event", "input");
	const saved = createGraphRoutine({ name: "write-free preview", graph: native, enabled: false }, run.graphRegistry);
	const changes = () => getDb().query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
	const before = changes(),
		beforeRoutine = getRoutine(saved.id);
	const event = { id: "preview-event", items: ["truthy-not-true", true, 0], token: "do-not-disclose" };
	const response = await api.request(
		`/routines/${saved.id}/preview`,
		request({
			eventType: "inbox.card_added",
			event,
			sourceNodeId: "source",
		}),
	);
	expect(response.status).toBe(200);
	const trace = (await response.json()) as GraphRunRecord;
	expect(trace).toMatchObject({ status: "success", dryRun: true, routineId: saved.id, graph: native });
	expect(trace.graph.budget).toEqual({ max_duration_secs: 120, max_steps_executed: 10_000 });
	const passes = trace.nodeRuns[1]!.passes!;
	expect(passes).toHaveLength(3);
	expect(passes.map(pass => pass.nodeRuns[1]!.outputs[0]!.result)).toEqual([
		{ value: "truthy-not-true" },
		{ value: true },
		{ value: 0 },
	]);
	expect(passes[0]!.nodeRuns[2]!.effects?.[0]?.status).toBe("planned");
	expect(passes[1]!.nodeRuns[2]!.effects?.[0]?.status).toBe("planned");
	expect(passes[2]!.nodeRuns[2]!.status).toBe("skipped");
	expect(JSON.stringify(trace)).not.toContain("do-not-disclose");
	expect(listRuns(saved.id)).toEqual([]);
	expect(getRoutine(saved.id)).toEqual(beforeRoutine);
	expect(changes()).toBe(before);
	expect(
		(
			await api.request(
				`/routines/${saved.id}/preview`,
				request({ eventType: "inbox.card_added", event: {}, sourceNodeId: "missing" }),
			)
		).status,
	).toBe(400);
});

test("requested historical run lookup is independent of summary limits and checks routine ownership", async () => {
	const run = setup(),
		api = buildRoutinesRouter(run);
	const saved = createGraphRoutine({ name: "history", graph: graph() }, run.graphRegistry);
	const other = createGraphRoutine({ name: "other", graph: graph() }, run.graphRegistry);
	const oldest = startRun(saved.id, "manual");
	for (let index = 0; index < 55; index++) {
		const record = startRun(saved.id, "manual");
		getDb()
			.query("UPDATE routine_runs SET started_at = ? WHERE id = ?")
			.run(`2099-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, record.id);
	}
	expect(listRuns(saved.id, 50).some(record => record.id === oldest.id)).toBe(false);
	const response = await api.request(`/routines/${saved.id}/runs/${oldest.id}`);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(oldest);
	expect((await api.request(`/routines/${other.id}/runs/${oldest.id}`)).status).toBe(404);
	expect((await api.request(`/routines/${saved.id}/runs/missing`)).status).toBe(404);
});

test("builder TOML creates an API routine that executes natively with explicit null state", async () => {
	const run = setup();
	const api = buildRoutinesRouter(run);
	const spec: RoutineSpec = {
		name: "builder-toml-acceptance",
		trigger: [{ manual: {} }],
		steps: [
			{ id: "state", type: "set_state", state: { cleared: null, nested: [null, false, 0, ""] } },
			{
				id: "answer",
				type: "transform",
				body: "return { answer: 42, enabled: false, empty: '', state: context.state };",
			},
		],
	};
	const specToml = stringifySpec(spec);
	expect(specToml).toContain("__npi");
	const response = await api.request("/routines", request({ name: spec.name, specToml, enabled: false }));
	expect(response.status).toBe(201);
	const saved = (await response.json()) as Routine;
	expect(saved.specToml).toBe(specToml);
	await run.fire(saved.id);
	const record = listRuns(saved.id)[0]!;
	expect(record.exitCode).toBe(0);
	const output = listStepRuns(record.id)[1]!;
	expect(output.status).toBe("success");
	expect(JSON.parse(output.outputJson!)).toEqual({
		answer: 42,
		enabled: false,
		empty: "",
		state: { cleared: null, nested: [null, false, 0, ""] },
	});
	const stored = getDb()
		.query<{ spec_yaml: string | null; spec_toml: string }, [string]>(
			"SELECT spec_yaml, spec_toml FROM routines WHERE id = ?",
		)
		.get(saved.id)!;
	expect(stored).toEqual({ spec_yaml: null, spec_toml: specToml });
});

test("legacy YAML imports once, runs as TOML and retains exact original through API re-save and graph conversion", async () => {
	const run = setup();
	const api = buildRoutinesRouter(run);
	const original =
		"# untouched legacy provenance\nname: imported-routine # routine slug comment\ntrigger:\n  - manual: {}\nsteps:\n  - id: state\n    type: set_state\n    state: {cleared: null, nested: [null, false, 0, '']} # nested state comment\n  - id: answer\n    type: transform\n    body: 'return context.state;'\n";
	const legacy = createRoutine({
		name: "imported-routine",
		cron: "",
		actionKind: "script",
		actionBody: "",
		enabled: false,
	});
	getDb().query("UPDATE routines SET spec_version = 1, spec_yaml = ? WHERE id = ?").run(original, legacy.id);
	// Reopening exercises the boot importer, not just the normalized read path.
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	const imported = getRoutine(legacy.id)!;
	expect(imported.specToml).toBe(importLegacyRoutineYaml(original));
	for (const comment of ["# untouched legacy provenance", "# routine slug comment", "# nested state comment"])
		expect(imported.specToml).toContain(comment);
	const edited = `${imported.specToml}\n# native source edit\n`;
	expect((await api.request(`/routines/${legacy.id}`, request({ specToml: edited }, "PATCH"))).status).toBe(200);
	await run.fire(legacy.id);
	const output = listStepRuns(listRuns(legacy.id)[0]!.id)[1]!;
	expect(output.status).toBe("success");
	expect(JSON.parse(output.outputJson!)).toEqual({ cleared: null, nested: [null, false, 0, ""] });
	const row = getDb()
		.query<{ spec_yaml: string; spec_toml: string }, [string]>(
			"SELECT spec_yaml, spec_toml FROM routines WHERE id = ?",
		)
		.get(legacy.id)!;
	expect(row).toEqual({ spec_yaml: original, spec_toml: edited });
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	expect(getRoutine(legacy.id)?.specToml).toBe(edited);
	expect(
		migrateRoutines(run.graphRegistry, { routineId: legacy.id, backupDirectory: path.join(home, "backups") })
			.reports[0]?.status,
	).toBe("migrated");
	expect(
		getDb().query<{ spec_yaml: string }, [string]>("SELECT spec_yaml FROM routines WHERE id = ?").get(legacy.id)
			?.spec_yaml,
	).toBe(original);
});

test("unsupported legacy values fail explicitly without overwriting original or canonical TOML", () => {
	setup();
	for (const unsupported of [
		"name: bad\nname: duplicate\ntrigger: [{manual: {}}]\nsteps: []\n",
		"name: bad\ntrigger: [{manual: {}}]\nsteps: [{id: answer, type: transform, body: 'return 42;'}]\nunknown: do-not-drop\n",
	]) {
		const legacy = createRoutine({
			name: "unsupported",
			cron: "",
			actionKind: "script",
			actionBody: "",
			enabled: false,
		});
		getDb().query("UPDATE routines SET spec_version = 1, spec_yaml = ? WHERE id = ?").run(unsupported, legacy.id);
		closeDb();
		openDb({ path: path.join(home, "deck.db") });
		expect(getRoutine(legacy.id)?.specImportError).toContain("cannot be imported losslessly");
		const row = getDb()
			.query<{ spec_yaml: string; spec_toml: string | null }, [string]>(
				"SELECT spec_yaml, spec_toml FROM routines WHERE id = ?",
			)
			.get(legacy.id)!;
		expect(row).toEqual({ spec_yaml: unsupported, spec_toml: null });
	}
});

test("unimportable legacy routines stay visible and isolated from listing, startup and inbox transactions", async () => {
	const run = setup();
	const bad = createRoutine({
		name: "blocked",
		cron: "* * * * *",
		actionKind: "script",
		actionBody: "",
		enabled: true,
	});
	const original = 'name: blocked\ntrigger: [{manual: {}}]\nsteps: [{id: blocked, type: transform, body: "\\f"}]\n';
	getDb().query("UPDATE routines SET spec_version = 1, spec_yaml = ? WHERE id = ?").run(original, bad.id);
	const spec: RoutineSpec = {
		name: "healthy",
		trigger: [{ manual: {} }],
		steps: [{ id: "answer", type: "transform", body: "return 42;" }],
	};
	const healthy = createV1Routine({
		name: spec.name,
		description: "",
		specToml: stringifySpec(spec),
		spec,
		enabled: true,
	});
	const api = buildRoutinesRouter(run);
	const response = await api.request("/routines");
	expect(response.status).toBe(200);
	const listing = await response.text();
	expect(listing).toContain(bad.id);
	expect(listing).toContain("specImportError");
	const unavailable = getRoutine(bad.id)!;
	expect(unavailable.specImportError).toContain("cannot be imported losslessly");
	expect(unavailable.specToml).toBeUndefined();
	expect((await api.request(`/routines/${bad.id}`)).status).toBe(200);
	expect(() => run.start()).not.toThrow();
	const inbox = createInbox({ kind: "capture", title: "unrelated write" });
	expect(getInbox(inbox.id)?.title).toBe("unrelated write");
	await expect(run.fire(bad.id)).rejects.toThrow("cannot be imported losslessly");
	expect((await api.request(`/routines/${bad.id}/run`, { method: "POST" })).status).toBe(409);
	expect(listRuns(bad.id)).toEqual([]);
	await run.fire(healthy.id);
	expect(listRuns(healthy.id)[0]?.exitCode).toBe(0);
	expect(
		getDb()
			.query<{ spec_yaml: string; spec_toml: string | null }, [string]>(
				"SELECT spec_yaml, spec_toml FROM routines WHERE id = ?",
			)
			.get(bad.id),
	).toEqual({ spec_yaml: original, spec_toml: null });
	const repairedToml = stringifySpec({ ...spec, name: "blocked" });
	const repairedResponse = await api.request(`/routines/${bad.id}`, request({ specToml: repairedToml }, "PATCH"));
	expect(repairedResponse.status).toBe(200);
	const repaired = (await repairedResponse.json()) as Routine;
	expect(repaired.id).toBe(bad.id);
	expect(repaired.specImportError).toBeUndefined();
	expect(repaired.specToml).toBe(repairedToml);
	expect(
		getDb().query<{ spec_yaml: string }, [string]>("SELECT spec_yaml FROM routines WHERE id = ?").get(bad.id)
			?.spec_yaml,
	).toBe(original);
	await run.fire(bad.id);
	expect(listRuns(bad.id)[0]?.exitCode).toBe(0);
});
