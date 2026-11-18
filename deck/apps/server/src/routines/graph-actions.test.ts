import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { GraphObject, GraphRunRecord, GraphValue, RoutineGraph } from "@npi-deck/protocol";
import { closeDb, getDb, openDb } from "../db/index.ts";
import { createInbox, getInbox } from "../db/inbox.ts";
import { createGraphRoutine, getGraphRun, listRuns, updateGraphRoutine } from "../db/routines.ts";
import { listTasks } from "../db/tasks.ts";
import { cardExecutionProperties, cardFrontmatter } from "../card-properties.ts";
import { buildRoutinesRouter } from "../routes-routines.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import { notificationService, NotificationChannelRejectedError } from "../notifications/service.ts";
import { executeGraph, findGraphOutput, readGraphPath } from "./graph-runner.ts";
import { githubIssueTransport } from "./github-issues.ts";

const root = tmpdir();
let home = "";
let runner: RoutinesRunner;
let oldHome: string | undefined;
const channels: string[] = [];
const restores: Array<() => void> = [];
function setup() {
	fs.mkdirSync(root, { recursive: true });
	home = fs.mkdtempSync(path.join(root, "deck-actions-"));
	oldHome = process.env.NPI_DECK_HOME; process.env.NPI_DECK_HOME = home;
	openDb({ path: path.join(home, "deck.db") });
	runner = new RoutinesRunner();
	return runner;
}
afterEach(async () => {
	await runner?.dispose();
	for (const channel of channels.splice(0)) notificationService.unregister(channel);
	for (const restore of restores.splice(0)) restore();
	closeDb();
	if (oldHome === undefined) delete process.env.NPI_DECK_HOME; else process.env.NPI_DECK_HOME = oldHome;
	if (home) fs.rmSync(home, { recursive: true, force: true });
});
function flow(type = "action.create-card", request: GraphObject = { title: "Created", properties: { "read-only": true, worktree: "/isolated/worktree" }, orderInState: 17, archived: true }): RoutineGraph {
	return { version: 2, nodes: [
		{ id: "source", type: "event.source", config: { eventType: "manual" } },
		{ id: "action", type, config: { request } },
	], edges: [{ id: "source-action", from: { nodeId: "source", port: "event" }, to: { nodeId: "action", port: "in" } }] };
}
function trace(routineId: string): GraphRunRecord { return getGraphRun(listRuns(routineId)[0]!.id)!; }
function json(body: unknown): RequestInit { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }
function action(record: GraphRunRecord) { return record.nodeRuns.find(node => node.nodeId === "action")!; }
function messageFlow(): RoutineGraph { return flow("action.send-message", { destination: "isolated-recorder", payload: { kind: "routine_failed", level: "info", title: "Isolated message", body: "hello" } }); }
function channel(deliver: () => Promise<void> | void): void {
	channels.push("isolated-recorder"); notificationService.register({ id: "isolated-recorder", deliver });
}

test("production catalogue, HTTP save/reopen/run/trace and actual card service preserve supported properties", async () => {
	setup();
	const api = buildRoutinesRouter(runner);
	const catalogue = await (await api.request("/routine-node-types")).json() as { nodeTypes: Array<{ type: string; kind: string; configSchema: unknown }> };
	for (const type of ["action.create-card", "action.send-message", "action.file-issue"]) expect(catalogue.nodeTypes.find(node => node.type === type)).toMatchObject({ kind: "action", configSchema: { type: "object" } });
	const graph = flow();
	const invalid = structuredClone(graph); invalid.nodes[1]!.config = {};
	expect((await api.request("/routine-graphs/validate", json(invalid))).status).toBe(400);
	const saved = await (await api.request("/routines", json({ name: "Real cards", graph }))).json() as { id: string };
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	expect((await api.request(`/routines/${saved.id}`)).status).toBe(200);
	const response = await api.request(`/routines/${saved.id}/run?operationId=explicit-card`, json({ original: { card: "source", value: false } }));
	expect(response.status).toBe(202);
	for (let i = 0; i < 100 && !listRuns(saved.id).some(run => getGraphRun(run.id)); i++) await Bun.sleep(5);
	const record = trace(saved.id);
	expect(record.status).toBe("success");
	const result = action(record).outputs[0]!;
	const receipt = result.result.receipt as GraphObject;
	expect(receipt).toMatchObject({ title: "Created", orderInState: 17, properties: { "read-only": true, worktree: "/isolated/worktree" } });
	expect(receipt.archivedAt).toBeString(); expect(receipt.id).toBeString(); expect(receipt.displayId).toBeNumber();
	const stored = listTasks({ includeArchived: true }).find(card => card.id === receipt.id)!;
	expect(cardExecutionProperties(stored.body)).toEqual({ readOnly: true, worktree: "/isolated/worktree" });
	expect(findGraphOutput(result, "source")?.result.original).toEqual({ card: "source", value: false });
	expect((await (await api.request(`/routines/${saved.id}/runs/${record.id}/graph`)).json() as GraphRunRecord).nodeRuns).toEqual(record.nodeRuns);
});

test("card actions import legacy bodies at persistence, retain originals and redact both metadata formats", async () => {
	setup();
	const sources = [
		"---\n# original YAML\nread-only: true\npassword: private-card-body\ncustom: {empty: null}\n---\nResearch\n",
		'+++\n# native TOML\nread-only = true\npassword = "private-card-body"\n[custom]\n[__npi]\nversion = 1\nnull_paths = ["/custom/empty"]\n+++\nResearch\n',
	];
	for (const [index, body] of sources.entries()) {
		const title = `Metadata fixture ${index}`;
		const routine = createGraphRoutine({ name: title, graph: flow("action.create-card", { title, body, properties: { worktree: "/isolated/worktree" } }) }, runner.graphRegistry);
		await runner.fire(routine.id, "manual", { id: `metadata-${index}` });
		const record = trace(routine.id);
		expect(record.status).toBe("success");
		const stored = listTasks().find(card => card.title === title)!;
		expect(stored.body.startsWith("+++\n")).toBe(true);
		expect(cardFrontmatter(stored.body).properties).toEqual({ "read-only": true, password: "private-card-body", custom: { empty: null }, worktree: "/isolated/worktree" });
		expect(JSON.stringify(record)).not.toContain("private-card-body");
		const originals = getDb().query<{ body: string }, [string]>("SELECT body FROM card_legacy_originals WHERE task_id = ?").all(stored.id);
		expect(originals.map(row => row.body)).toEqual(index === 0 ? [body] : []);
	}
});

test("card replay across run ids, restart, concurrent admission and explicit intentional repeats", async () => {
	setup(); const graph = flow(); graph.concurrency = "parallel";
	const routine = createGraphRoutine({ name: "idempotent", graph }, runner.graphRegistry);
	await Promise.all([runner.fire(routine.id, "manual", { id: "event-1" }), runner.fire(routine.id, "manual", { id: "event-1" })]);
	const receipts = listRuns(routine.id).map(run => action(getGraphRun(run.id)!).effects![0]!.receipt!.id);
	expect(new Set(receipts).size).toBe(1);
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	await runner.fire(routine.id, "manual", { id: "event-1" });
	expect(action(trace(routine.id)).effects![0]).toMatchObject({ status: "confirmed", replayed: true, receipt: { id: receipts[0] } });
	await runner.fire(routine.id, "manual", { id: "event-1" }, { operationId: "intentional-repeat" });
	expect(action(trace(routine.id)).effects![0]!.receipt!.id).not.toBe(receipts[0]);
	await runner.fire(routine.id, "manual", { id: "event-2" });
	expect(listTasks({ includeArchived: true }).filter(card => card.title === "Created")).toHaveLength(3);
	graph.nodes[1]!.config.request = { title: "Changed" }; updateGraphRoutine(routine.id, { graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "event-1" });
	expect(trace(routine.id).status).toBe("failed"); expect(trace(routine.id).error).toContain("different request or destination");
	expect(action(trace(routine.id)).effects![0]).toMatchObject({ status: "rejected", request: { title: "Changed" } });
	expect(listTasks({ includeArchived: true }).filter(card => card.title === "Changed")).toHaveLength(0);
});

test("dry-run validates the same request but consumes no live identity or fake receipt", async () => {
	setup(); let sends = 0; channel(() => { sends++; });
	for (const graph of [flow(), messageFlow(), flow("action.file-issue", { host: "github.com", owner: "isolated-owner", repo: "disposable", title: "No external write", body: "planned" })]) {
		const routine = createGraphRoutine({ name: "dry", graph }, runner.graphRegistry);
		const count = listTasks({ includeArchived: true }).length;
		const remote = spyOn(githubIssueTransport, "execute"); restores.push(() => remote.mockRestore());
		await runner.fire(routine.id, "manual", { id: "dry-event" }, { dryRun: true });
		const record = trace(routine.id); expect(record).toMatchObject({ status: "success", dryRun: true });
		expect(action(record).effects![0]).toMatchObject({ status: "planned", replayed: false }); expect(action(record).effects![0]).not.toHaveProperty("receipt");
		expect(listTasks({ includeArchived: true })).toHaveLength(count); expect(sends).toBe(0); expect(remote).not.toHaveBeenCalled();
		if (graph.nodes[1]!.type === "action.create-card") { await runner.fire(routine.id, "manual", { id: "dry-event" }); expect(trace(routine.id).status).toBe("success"); expect(listTasks({ includeArchived: true })).toHaveLength(count + 1); }
	}
});

test("inbox event dry-run leaves the committed delivery available for one live run", async () => {
	setup();
	const graph = flow("action.create-card", { title: "Live inbox delivery" });
	graph.nodes[0]!.config.eventType = "inbox.card_added";
	const routine = createGraphRoutine({ name: "inbox simulation", graph }, runner.graphRegistry);
	const card = createInbox({ kind: "capture", title: "Committed inbox event", body: "Keep the pending delivery" });
	const activation = { eventType: "inbox.card_added", sourceNodeId: "source", event: { ...card } };
	await runner.fireGraphEvent(routine.id, activation, { dryRun: true });
	expect(trace(routine.id)).toMatchObject({ status: "success", dryRun: true, activation });
	expect(action(trace(routine.id)).effects![0]!.status).toBe("planned");
	expect(listTasks().filter(item => item.title === "Live inbox delivery")).toHaveLength(0);
	expect(getInbox(card.id)).toEqual(card);
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	await runner.fireGraphEvent(routine.id, activation);
	expect(listRuns(routine.id)).toHaveLength(2);
	expect(trace(routine.id)).toMatchObject({ status: "success", dryRun: false, activation });
	expect(action(trace(routine.id)).effects![0]).toMatchObject({ status: "confirmed", replayed: false });
	expect(listTasks().filter(item => item.title === "Live inbox delivery")).toHaveLength(1);
	expect(getInbox(card.id)).toEqual(card);
});

test("actual upstream envelopes survive arbitrary false/zero/null/empty/truthy results into action and downstream", async () => {
	setup();
	for (const value of [false, 0, null, "", "truthy-not-true"] as GraphValue[]) {
		const type = `inspect-${JSON.stringify(value)}`;
		runner.graphRegistry.register({ definition: { type, label: type, kind: "operation", inputs: [{ id: "in", type: "object" }], outputs: [{ id: "out", type: "object" }] }, execute: () => [{ port: "out", value }] });
		const graph = flow(); graph.nodes.splice(1, 0, { id: "intervening", type, config: {} });
		graph.nodes.push({ id: "downstream", type: "action.create-card", config: { request: { title: { $from: { nodeId: "source", path: ["result", "title"] } }, properties: { originalResult: { $from: { nodeId: "intervening", path: ["result", "value"] } } } } } });
		graph.edges = [
			{ id: "1", from: { nodeId: "source", port: "event" }, to: { nodeId: "intervening", port: "in" } },
			{ id: "2", from: { nodeId: "intervening", port: "out" }, to: { nodeId: "action", port: "in" } },
			{ id: "3", from: { nodeId: "action", port: "result" }, to: { nodeId: "downstream", port: "in" } },
		];
		const routine = createGraphRoutine({ name: "provenance", graph }, runner.graphRegistry);
		await runner.fire(routine.id, "manual", { id: "card-event", title: "Original title" });
		const record = trace(routine.id); expect(record.status).toBe("success");
		const output = record.nodeRuns.find(node => node.nodeId === "downstream")!.outputs[0]!;
		expect(findGraphOutput(output, "source")?.result.title).toBe("Original title");
		expect(readGraphPath(findGraphOutput(output, "intervening")!, ["result", "value"])).toEqual(value);
		expect(findGraphOutput(output, "action")?.result.status).toBe("confirmed");
		expect((output.result.receipt as GraphObject).properties).toEqual({ originalResult: value });
	}
});

test("invalid resolved card metadata/state/generic object values fail before mutations", async () => {
	setup(); const before = listTasks({ includeArchived: true }).length;
	const requests: GraphObject[] = [{ title: "bad", unsupported: true }, { title: "bad", properties: { "read-only": "yes" } }, { title: "bad", properties: { worktree: false } }, { title: "bad", stateId: "missing" }, { title: 0 }, { title: "bad", archived: "yes" }];
	for (const request of requests) {
		const routine = createGraphRoutine({ name: "invalid", graph: flow("action.create-card", request) }, runner.graphRegistry);
		await runner.fire(routine.id, "manual", { id: "event" }); expect(trace(routine.id).status).toBe("failed"); expect(action(trace(routine.id)).inputs).toHaveLength(1);
	}
	expect(listTasks({ includeArchived: true })).toHaveLength(before);
});

test("confirmed message receipt survives later failure, replay/restart and concurrent duplicates", async () => {
	setup(); let sends = 0; channel(async () => { sends++; await Bun.sleep(20); });
	const graph = messageFlow(); graph.concurrency = "parallel";
	const routine = createGraphRoutine({ name: "messages", graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "message-event" }, { dryRun: true }); expect(sends).toBe(0);
	await Promise.all([runner.fire(routine.id, "manual", { id: "message-event" }), runner.fire(routine.id, "manual", { id: "message-event" })]);
	expect(sends).toBe(1);
	for (const run of listRuns(routine.id).filter(run => !getGraphRun(run.id)!.dryRun)) expect(action(getGraphRun(run.id)!).effects![0]).toMatchObject({ status: "confirmed", receipt: { status: "dispatched", destination: "isolated-recorder" } });
	closeDb(); openDb({ path: path.join(home, "deck.db") }); await runner.fire(routine.id, "manual", { id: "message-event" }); expect(sends).toBe(1);
	runner.graphRegistry.register({ definition: { type: "fail", label: "fail", kind: "operation", inputs: [{ id: "in", type: "object" }], outputs: [] }, execute: () => { throw new Error("later failure"); } });
	graph.nodes.push({ id: "later", type: "fail", config: {} }); graph.edges.push({ id: "later", from: { nodeId: "action", port: "result" }, to: { nodeId: "later", port: "in" } });
	updateGraphRoutine(routine.id, { graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "new-event" }); const failed = trace(routine.id);
	expect(failed.status).toBe("failed"); expect(action(failed).effects![0]!.status).toBe("confirmed");
	await runner.fire(routine.id, "manual", { id: "new-event" }); expect(sends).toBe(2);
});

test("confirmed message replay recovers downstream after the destination disappears", async () => {
	setup(); let sends = 0; let recover = false; channel(() => { sends++; });
	runner.graphRegistry.register({
		definition: { type: "recovery-gate", label: "Recovery gate", kind: "operation", inputs: [{ id: "in", type: "object" }], outputs: [{ id: "out", type: "object" }] },
		execute: () => { if (!recover) throw new Error("downstream unavailable"); return [{ port: "out", value: {} }]; },
	});
	const graph = messageFlow();
	graph.nodes.push({ id: "gate", type: "recovery-gate", config: {} }, { id: "downstream", type: "action.create-card", config: { request: { title: "Recovered downstream" } } });
	graph.edges.push(
		{ id: "gate", from: { nodeId: "action", port: "result" }, to: { nodeId: "gate", port: "in" } },
		{ id: "downstream", from: { nodeId: "gate", port: "out" }, to: { nodeId: "downstream", port: "in" } },
	);
	const routine = createGraphRoutine({ name: "recovery", graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "recover-event" });
	const confirmed = action(trace(routine.id)).effects![0]!.receipt;
	expect(trace(routine.id).status).toBe("failed");
	expect(action(trace(routine.id)).effects![0]!.status).toBe("confirmed");
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	notificationService.unregister("isolated-recorder"); recover = true;
	await runner.fire(routine.id, "manual", { id: "recover-event" });
	expect(trace(routine.id).status).toBe("success");
	expect(action(trace(routine.id)).effects![0]).toMatchObject({ status: "confirmed", replayed: true, receipt: confirmed });
	expect(sends).toBe(1);
	expect(listTasks().filter(card => card.title === "Recovered downstream")).toHaveLength(1);
	(graph.nodes[1]!.config.request as GraphObject).payload = { kind: "routine_failed", level: "info", title: "Changed" };
	updateGraphRoutine(routine.id, { graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "recover-event" });
	expect(trace(routine.id).error).toContain("different request or destination");
	expect(sends).toBe(1);
});

test("lost message acknowledgement is uncertain and never blindly retried", async () => {
	setup(); let writes = 0; channel(() => { writes++; throw new Error("provider lost receipt with token SECRET"); });
	const routine = createGraphRoutine({ name: "ambiguous", graph: messageFlow() }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "ambiguous" });
	expect(trace(routine.id).status).toBe("failed"); expect(action(trace(routine.id)).effects![0]!.status).toBe("uncertain");
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	await runner.fire(routine.id, "manual", { id: "ambiguous" }); expect(writes).toBe(1); expect(JSON.stringify(trace(routine.id))).not.toContain("SECRET");
});

test("abort before dispatch is write-free; late acknowledgement updates durable effect without downstream activation", async () => {
	setup(); let sends = 0; let settle!: () => void; let dispatched!: () => void;
	const sent = new Promise<void>(resolve => { dispatched = resolve; });
	channel(async () => { sends++; dispatched(); await new Promise<void>(resolve => { settle = resolve; }); });
	const graph = messageFlow();
	graph.nodes.push({ id: "downstream", type: "action.create-card", config: { request: { title: "Must not create" } } }); graph.edges.push({ id: "after", from: { nodeId: "action", port: "result" }, to: { nodeId: "downstream", port: "in" } });
	const cancelled = new AbortController(); cancelled.abort();
	const pre = await executeGraph(graph, { eventType: "manual", event: { id: "pre-abort" } }, runner.graphRegistry, { routineId: "test", signal: cancelled.signal }); expect(pre.status).toBe("aborted"); expect(sends).toBe(0);
	const routine = createGraphRoutine({ name: "late", graph }, runner.graphRegistry);
	const running = runner.fire(routine.id, "manual", { id: "late" }); await sent; await runner.dispose(); await running;
	const aborted = trace(routine.id); expect(aborted.status).toBe("aborted"); expect(action(aborted).effects![0]!.status).toBe("uncertain"); expect(action(aborted).inputs[0]!.result.id).toBe("late");
	settle(); for (let i = 0; i < 100 && action(trace(routine.id)).effects![0]!.status !== "confirmed"; i++) await Bun.sleep(5);
	expect(action(trace(routine.id)).effects![0]!.status).toBe("confirmed"); expect(trace(routine.id).status).toBe("aborted"); expect(listTasks().filter(card => card.title === "Must not create")).toHaveLength(0);
});

test("disabled/no-target message and inactive branch never dispatch", async () => {
	setup(); let sends = 0; channel(() => { sends++; });
	const graph = messageFlow(); (graph.nodes[1]!.config.request as GraphObject).destination = "unregistered";
	const routine = createGraphRoutine({ name: "no-target", graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "no-target" }); expect(action(trace(routine.id)).effects![0]!.status).toBe("not-dispatched");
	const source = graph.nodes[0]!; source.config.eventType = "different"; updateGraphRoutine(routine.id, { graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "inactive" }); expect(action(trace(routine.id)).status).toBe("skipped"); expect(sends).toBe(0);
	expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) as count FROM graph_actions").get()!.count).toBe(0);
});

test("production issue action resolves original content, confirms native identity and reconciles lost receipt without another POST", async () => {
	setup();
	let posts = 0;
	let lost = false;
	let issue: GraphObject | undefined;
	const remote = spyOn(githubIssueTransport, "execute").mockImplementation(async command => {
		const response = (value: unknown, status = 200) => ({ exitCode: 0, stderr: "", stdout: `HTTP/2.0 ${status} OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(value)}` });
		if (command.args.includes("POST")) {
			posts++;
			const payload = JSON.parse(command.input!) as GraphObject;
			expect(payload).toMatchObject({ title: "Original issue", labels: ["enhancement"], assignees: ["PsychedelicShayna"], milestone: 2 });
			expect(payload.body).toContain("> NeoDeck on behalf of PsychedelicShayna");
			expect(payload.body).toContain("Original card content");
			issue = { id: 9001, number: 71, html_url: "https://github.com/isolated-owner/disposable/issues/71", repository_url: "https://api.github.com/repos/isolated-owner/disposable", body: payload.body! };
			if (lost) throw new Error("simulated lost response");
			return response(issue, 201);
		}
		if (command.args.some(arg => arg.startsWith("search/issues"))) return response({ total_count: 1, incomplete_results: false, items: [issue] });
		return response(issue);
	}); restores.push(() => remote.mockRestore());
	const graph = flow("action.file-issue", {
		host: "github.com", owner: "isolated-owner", repo: "disposable",
		title: { $from: { nodeId: "source", path: ["result", "title"] } },
		body: { $from: { nodeId: "source", path: ["result", "body"] } },
		labels: ["enhancement"], assignees: ["PsychedelicShayna"], milestone: 2,
	});
	const routine = createGraphRoutine({ name: "issues", graph }, runner.graphRegistry);
	const event = { id: "issue-event", title: "Original issue", body: "Original card content" };
	await runner.fire(routine.id, "manual", event, { dryRun: true }); expect(remote).not.toHaveBeenCalled();
	await runner.fire(routine.id, "manual", event);
	expect(trace(routine.id).status).toBe("success"); expect(action(trace(routine.id)).effects![0]).toMatchObject({ status: "confirmed", receipt: { repository: "isolated-owner/disposable", issue: { id: 9001, number: 71, url: "https://github.com/isolated-owner/disposable/issues/71" } } });
	expect(findGraphOutput(action(trace(routine.id)).outputs[0]!, "source")?.result).toEqual(event);
	await runner.fire(routine.id, "manual", event); expect(posts).toBe(1);
	lost = true; await runner.fire(routine.id, "manual", { ...event, id: "lost-event" });
	expect(trace(routine.id).status).toBe("failed"); expect(action(trace(routine.id)).effects![0]!.status).toBe("uncertain");
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	await runner.fire(routine.id, "manual", { ...event, id: "lost-event" });
	expect(trace(routine.id).status).toBe("success"); expect(action(trace(routine.id)).effects![0]).toMatchObject({ status: "confirmed", replayed: true, receipt: { issue: { number: 71 } } }); expect(posts).toBe(2);
});

test("isolated loopback subprocess runs all production actions through the native API", async () => {
	setup();
	const isolatedHome = path.join(home, "http-home"); fs.mkdirSync(isolatedHome);
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "graph-actions.fixture.ts")], {
		env: { ...process.env, HOME: isolatedHome, NPI_DECK_HOME: isolatedHome, NEODECK_ACTION_FIXTURE_DB: path.join(isolatedHome, "deck.db") },
		stdout: "pipe", stderr: "pipe",
	});
	try {
		const reader = child.stdout.getReader();
		let startup = "";
		let url = "";
		while (!url) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`Isolated server exited before readiness: ${startup}`);
			startup += new TextDecoder().decode(chunk.value);
			url = /^http:\/\/127\.0\.0\.1:\d+$/m.exec(startup)?.[0] ?? "";
		}
		reader.releaseLock();
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		const types = await (await fetch(`${url}/api/routine-node-types`)).json() as { nodeTypes: Array<{ type: string }> };
		expect(types.nodeTypes.filter(type => type.type.startsWith("action."))).toHaveLength(4);
		for (const graph of [flow(), messageFlow(), flow("action.file-issue", { host: "github.com", owner: "isolated-owner", repo: "disposable", title: "Private fixture", body: "Simulated provider only" })]) {
			expect((await fetch(`${url}/api/routine-graphs/validate`, json(graph))).status).toBe(200);
			const saved = await (await fetch(`${url}/api/routines`, json({ name: "Subprocess actions", graph }))).json() as { id: string };
			expect((await fetch(`${url}/api/routines/${saved.id}`)).status).toBe(200);
			const admission = await fetch(`${url}/api/routines/${saved.id}/run?operationId=private-api-operation`, json({ originalCard: { title: "Captain's original", value: false } }));
			expect(admission.status).toBe(202);
			let record: GraphRunRecord | undefined;
			for (let i = 0; i < 100 && !record; i++) {
				const runs = await (await fetch(`${url}/api/routines/${saved.id}/runs`)).json() as { runs: Array<{ id: string }> };
				if (runs.runs[0]) {
					const response = await fetch(`${url}/api/routines/${saved.id}/runs/${runs.runs[0].id}/graph`);
					if (response.ok) record = await response.json() as GraphRunRecord;
				}
				if (!record) await Bun.sleep(10);
			}
			expect(record?.status).toBe("success");
			expect(action(record!).effects![0]!.status).toBe("confirmed");
			expect(findGraphOutput(action(record!).outputs[0]!, "source")?.result.originalCard).toEqual({ title: "Captain's original", value: false });
		}
		const effects = await (await fetch(`${url}/simulated-effects`)).json() as { messages: unknown[]; issues: unknown[] };
		expect(effects.messages).toHaveLength(1); expect(effects.issues).toHaveLength(1);
	} finally {
		child.kill("SIGTERM"); await child.exited;
	}
}, 15_000);

test("card write and journal receipt roll back together if confirmation storage fails", async () => {
	setup(); const count = listTasks({ includeArchived: true }).length;
	getDb().exec("CREATE TRIGGER reject_action_confirmation BEFORE UPDATE ON graph_actions BEGIN SELECT RAISE(ABORT, 'simulated journal failure'); END");
	const routine = createGraphRoutine({ name: "atomic", graph: flow() }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "atomic-event" });
	expect(trace(routine.id).status).toBe("failed");
	expect(listTasks({ includeArchived: true })).toHaveLength(count);
	expect(getDb().query<{ count: number }, []>("SELECT COUNT(*) as count FROM graph_actions").get()!.count).toBe(0);
	getDb().exec("DROP TRIGGER reject_action_confirmation");
	await runner.fire(routine.id, "manual", { id: "atomic-event" });
	expect(trace(routine.id).status).toBe("success");
	expect(listTasks({ includeArchived: true })).toHaveLength(count + 1);
});

test("disabled channel and definite provider rejection remain distinct from uncertainty", async () => {
	setup(); let sends = 0;
	channels.push("disabled", "rejected");
	notificationService.register({ id: "disabled", preflight: () => ({ status: "disabled" }), deliver: () => { sends++; } });
	notificationService.register({ id: "rejected", deliver: () => { sends++; throw new NotificationChannelRejectedError(); } });
	for (const destination of ["disabled", "rejected"]) {
		const graph = messageFlow(); (graph.nodes[1]!.config.request as GraphObject).destination = destination;
		const routine = createGraphRoutine({ name: destination, graph }, runner.graphRegistry);
		await runner.fire(routine.id, "manual", { id: "event" });
		expect(trace(routine.id).status).toBe("failed");
		expect(action(trace(routine.id)).effects![0]!.status).toBe(destination === "disabled" ? "not-dispatched" : "rejected");
	}
	expect(sends).toBe(1);
});

test("credential fields are redacted in durable action requests, receipts and provenance", async () => {
	setup();
	const graph = flow("action.create-card", { title: "Protected card", properties: { password: "private-password", ordinary: false } });
	const routine = createGraphRoutine({ name: "redaction", graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "protected", access_token: "private-token" });
	const record = trace(routine.id);
	expect(record.status).toBe("success");
	expect(JSON.stringify(record)).not.toContain("private-token");
	expect(JSON.stringify(record)).not.toContain("private-password");
	expect(listTasks().find(card => card.title === "Protected card")!.body).toContain("private-password");
	expect((action(record).effects![0]!.receipt!.properties as GraphObject).password).toBe("[redacted]");
	const durable = getDb().query<{ effect_json: string }, []>("SELECT effect_json FROM graph_actions").get()!;
	expect(JSON.parse(durable.effect_json).receipt.properties.password).toBe("[redacted]");
	expect(durable.effect_json).not.toContain("private-password");
});

test("privacy-safe card receipts keep downstream requests identical after restart and replay", async () => {
	setup();
	const graph = flow("action.create-card", { title: "Private source", properties: { password: "private-replay-password", ordinary: false } });
	graph.nodes.push({
		id: "downstream", type: "action.create-card", config: {
			request: { title: "Stable downstream", body: { $from: { nodeId: "action", path: ["result", "receipt", "body"] } } },
		},
	});
	graph.edges.push({ id: "downstream", from: { nodeId: "action", port: "result" }, to: { nodeId: "downstream", port: "in" } });
	const routine = createGraphRoutine({ name: "private replay", graph }, runner.graphRegistry);
	await runner.fire(routine.id, "manual", { id: "private-event" });
	expect(trace(routine.id).status).toBe("success");
	const receipt = action(trace(routine.id)).effects![0]!.receipt!;
	const downstream = listTasks().find(card => card.title === "Stable downstream")!;
	closeDb(); openDb({ path: path.join(home, "deck.db") });
	await runner.fire(routine.id, "manual", { id: "private-event" });
	expect(trace(routine.id).status).toBe("success");
	expect(action(trace(routine.id)).effects![0]).toMatchObject({ replayed: true, receipt });
	expect(listTasks().filter(card => card.title === "Stable downstream")).toEqual([downstream]);
	expect<GraphValue | undefined>(downstream.body).toBe(receipt.body);
	expect(downstream.body).toContain("[redacted]");
	expect(downstream.body).not.toContain("private-replay-password");
	expect(listTasks().find(card => card.title === "Private source")!.body).toContain("private-replay-password");
	expect(JSON.stringify(trace(routine.id))).not.toContain("private-replay-password");
});

function iterationActionFlow(nested: boolean): RoutineGraph {
	const actionBody: GraphObject = { version: 2, nodes: [
		{ id: "item", type: "iteration.input", config: { eventType: "iteration" } },
		{ id: "action", type: "action.create-card", config: { request: { title: { $from: { nodeId: "item", path: ["result", "item"] } } } } },
	], edges: [{ id: "item-action", from: { nodeId: "item", port: "item" }, to: { nodeId: "action", port: "in" } }] };
	const body: GraphObject = nested ? { version: 2, nodes: [
		{ id: "item", type: "iteration.input", config: { eventType: "iteration" } },
		{ id: "loop", type: "iteration.each", config: { path: ["result", "item"], maxIterations: 2, body: actionBody } },
	], edges: [{ id: "item-loop", from: { nodeId: "item", port: "item" }, to: { nodeId: "loop", port: "input" } }] } : actionBody;
	return { version: 2, nodes: [
		{ id: "source", type: "event.source", config: { eventType: "manual" } },
		{ id: "loop", type: "iteration.each", config: { path: ["result", "items"], maxIterations: 2, body } },
	], edges: [{ id: "source-loop", from: { nodeId: "source", port: "event" }, to: { nodeId: "loop", port: "input" } }] };
}
function iterationEffects(record: GraphRunRecord) {
	const nodes = [...record.nodeRuns];
	for (let index = 0; index < nodes.length; index++) for (const pass of nodes[index]!.passes ?? []) nodes.push(...pass.nodeRuns);
	return nodes.flatMap(node => node.effects ?? []);
}
for (const nested of [false, true]) test(`iteration actions inherit original event/card identity through ${nested ? "nested" : "single"} bodies`, async () => {
	setup();
	for (const identity of [{ id: "event-id" }, { card: { id: "card-id" } }] as GraphObject[]) {
		const graph = iterationActionFlow(nested);
		const routine = createGraphRoutine({ name: "iteration identity", graph }, runner.graphRegistry);
		const event: GraphObject = { ...identity, items: nested ? [["first", "second"]] : ["first", "second"] };
		const count = listTasks({ includeArchived: true }).length;
		const preview = await executeGraph(graph, { eventType: "manual", event }, runner.graphRegistry, { routineId: routine.id, dryRun: true });
		expect(preview.status).toBe("success");
		expect(listTasks({ includeArchived: true })).toHaveLength(count);
		await runner.fireGraphEvent(routine.id, { eventType: "manual", event });
		const first = trace(routine.id);
		expect(first.status).toBe("success");
		const receipts = iterationEffects(first);
		expect(receipts).toHaveLength(2);
		expect(new Set(receipts.map(effect => effect.logicalKey)).size).toBe(2);
		expect(listTasks({ includeArchived: true })).toHaveLength(count + 2);
		await runner.fireGraphEvent(routine.id, { eventType: "manual", event });
		const replay = iterationEffects(trace(routine.id));
		expect(replay.map(effect => effect.logicalKey)).toEqual(receipts.map(effect => effect.logicalKey));
		expect(replay.every(effect => effect.replayed)).toBe(true);
		expect(listTasks({ includeArchived: true })).toHaveLength(count + 2);
		await runner.fireGraphEvent(routine.id, { eventType: "manual", event, operationId: "intentional-repeat" });
		expect(trace(routine.id).status).toBe("success");
		expect(listTasks({ includeArchived: true })).toHaveLength(count + 4);
		graph.nodes[0]!.config.eventType = "other";
		updateGraphRoutine(routine.id, { graph }, runner.graphRegistry);
		await runner.fireGraphEvent(routine.id, { eventType: "other", event });
		expect(trace(routine.id).status).toBe("success");
		expect(listTasks({ includeArchived: true })).toHaveLength(count + 6);
	}
});
