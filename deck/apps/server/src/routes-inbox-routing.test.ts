import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { INBOX_CARD_ADDED_EVENT, type InboxHistoryEvent, type InboxProposal, type InboxReceipt, type InboxRouting } from "@npi-deck/protocol";
import { createInbox, getInbox } from "./db/inbox.ts";
import { closeDb, getDb, openDb } from "./db/index.ts";
import { createGraphRoutine, finishGraphRun, startRun } from "./db/routines.ts";
import { getTask, listTasks } from "./db/tasks.ts";
import { admitInboxGraphEvent, pendingInboxGraphEvents } from "./db/inbox-graph-events.ts";
import { GraphNodeRegistry } from "./routines/graph-runner.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { cardFrontmatter } from "./card-properties.ts";
import { githubIssueTransport } from "./routines/github-issues.ts";

let directory = "";
afterEach(() => { mock.restore(); closeDb(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = ""; });
function boot() {
	const root = path.join(homedir(), ".cache/npi-canary/neodeck-pool/InboxRouter/tests");
	fs.mkdirSync(root, { recursive: true });
	directory = fs.mkdtempSync(path.join(root, "routing-"));
	openDb({ path: path.join(directory, "deck.db") });
	return buildInboxRouter();
}
function json(body: unknown): RequestInit { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }; }

test("live proposals preserve the chosen kind without inventing a project or model certainty", async () => {
	const app = boot();
	const item = createInbox({ title: "Broken preview classifier should not invent atlas", kind: "decision" });
	const proposal = await (await app.request(`/inbox/${item.id}/proposal`)).json() as InboxProposal;
	expect(proposal).toMatchObject({ itemId: item.id, kind: "decision", classifier: "manual", confidence: 0, destination: { kind: "card", project: "", column: "s_backlog" } });
	expect((await app.request("/inbox/missing/proposal")).status).toBe(404);
});

test("filing is atomic, replays after reopen, retains Markdown and records origin", async () => {
	const app = boot();
	const item = createInbox({ title: "Keep the notes", kind: "idea", body: "+++\ncustom = 'kept'\n+++\n\nLine one\nLine two\n\n![image](/uploads/notes.png)", source: "deck" });
	const before = listTasks().length;
	const destination = { kind: "card", project: "/explicit/project", column: "active" };
	const first = await app.request(`/inbox/${item.id}/file`, json({ destination }));
	expect(first.status).toBe(200);
	const body = await first.json() as { receipt: InboxReceipt };
	const task = getTask(body.receipt.ref)!;
	expect(task.cwd).toBe("/explicit/project");
	expect(task.stateId).toBe("s_active");
	expect(task.body).toContain("Line one\nLine two");
	expect(task.body).toContain("![image](/uploads/notes.png)");
	expect(cardFrontmatter(task.body).properties).toMatchObject({ custom: "kept", origin: "inbox", origin_ref: item.id });
	expect(getInbox(item.id)?.processedAt).toBeDefined();
	closeDb(); openDb({ path: path.join(directory, "deck.db") });
	const replay = await app.request(`/inbox/${item.id}/file`, json({ destination }));
	expect(await replay.json()).toEqual(body);
	expect(listTasks()).toHaveLength(before + 1);
	const history = await (await app.request(`/inbox/${item.id}/history`)).json() as { events: InboxHistoryEvent[] };
	expect(history.events.filter(event => event.receipt?.ref === task.id)).toHaveLength(1);
	expect((await app.request(`/inbox/${item.id}/file`, json({ destination: { ...destination, column: "backlog" } }))).status).toBe(409);
});

test("invalid and unavailable destinations leave the item and board unchanged", async () => {
	const app = boot();
	const item = createInbox({ title: "Retain on failure", kind: "ticket" });
	const before = listTasks().length;
	for (const [destination, status] of [[null, 400], [{ kind: "unknown" }, 400], [{ kind: "card", project: 7, column: "backlog" }, 400], [{ kind: "card", project: "", column: "missing" }, 400], [{ kind: "thread", agent: "Worker" }, 501], [{ kind: "note", path: "decisions/" }, 501], [{ kind: "issue", repo: "../invalid/repo" }, 400]] as const) {
		expect((await app.request(`/inbox/${item.id}/file`, json({ destination }))).status).toBe(status);
	}
	expect(listTasks()).toHaveLength(before);
	expect(getInbox(item.id)?.processedAt).toBeUndefined();
	const malformed = createInbox({ title: "Bad TOML", kind: "capture", body: "+++\ncustom = [broken\n+++\nbody" });
	expect((await app.request(`/inbox/${malformed.id}/file`, json({ destination: { kind: "card", project: "", column: "s_backlog" } }))).status).toBe(400);
	expect(listTasks()).toHaveLength(before);
	expect(getInbox(malformed.id)?.processedAt).toBeUndefined();
});

test("routing lists actual subscriptions and history follows durable flow delivery states", async () => {
	const app = boot();
	const registry = new GraphNodeRegistry();
	const graph = { version: 2 as const, nodes: [{ id: "intake", type: INBOX_CARD_ADDED_EVENT, config: { eventType: INBOX_CARD_ADDED_EVENT } }], edges: [] };
	const enabled = createGraphRoutine({ name: "Live intake", graph, enabled: true }, registry);
	const disabled = createGraphRoutine({ name: "Paused intake", graph, enabled: false }, registry);
	const item = createInbox({ title: "Follow the handoff", kind: "capture" });
	const routing = await (await app.request("/inbox/routing")).json() as InboxRouting;
	expect(routing.flows.map(flow => [flow.id, flow.enabled])).toEqual(expect.arrayContaining([[enabled.id, true], [disabled.id, false]]));
	expect(pendingInboxGraphEvents().filter(delivery => delivery.activation.event.id === item.id && delivery.routineId === enabled.id)).toHaveLength(1);
	const history = async () => (await (await app.request(`/inbox/${item.id}/history`)).json() as { events: InboxHistoryEvent[] }).events;
	expect((await history()).find(event => event.actor === "Live intake")?.text).toContain("queued");
	const activation = pendingInboxGraphEvents().find(delivery => delivery.routineId === enabled.id)!.activation;
	const run = admitInboxGraphEvent(enabled.id, activation, graph, () => startRun(enabled.id, "event"))!;
	expect((await history()).find(event => event.actor === "Live intake")?.text).toContain("running");
	finishGraphRun({ id: run.id, routineId: enabled.id, startedAt: run.startedAt, endedAt: new Date().toISOString(), status: "failed", error: "fixture failure", graph, activation, nodeRuns: [], outputs: [] });
	expect((await history()).find(event => event.actor === "Live intake")?.text).toContain("failed");
});

test("old delivery receipts and new unkeyed promotions both remain visible", async () => {
	const app = boot();
	const item = createInbox({ title: "Legacy keyed delivery", kind: "ticket" });
	const promoted = await (await app.request(`/inbox/${item.id}/promote`, { ...json({}), headers: { "content-type": "application/json", "Idempotency-Key": "legacy-key" } })).json() as { task: { id: string } };
	getDb().query("DELETE FROM inbox_filing_receipts WHERE item_id = ?").run(item.id);
	const legacy = await (await app.request(`/inbox/${item.id}/history`)).json() as { events: InboxHistoryEvent[] };
	expect(legacy.events.some(event => event.receipt?.ref === promoted.task.id)).toBe(true);
	const unkeyed = createInbox({ title: "Unkeyed delivery", kind: "capture" });
	await app.request(`/inbox/${unkeyed.id}/promote`, json({}));
	const history = await (await app.request(`/inbox/${unkeyed.id}/history`)).json() as { events: InboxHistoryEvent[] };
	expect(history.events.filter(event => event.receipt)).toHaveLength(1);
});

test("issue preview makes no external writes, reservations or processing changes", async () => {
	const app = boot();
	const transport = spyOn(githubIssueTransport, "execute").mockRejectedValue(new Error("Preview must not dispatch"));
	const item = createInbox({ title: "Preview without sending", kind: "ticket", body: "Preserve this context." });
	const response = await app.request(`/inbox/${item.id}/file`, json({ destination: { kind: "issue", repo: "owner/repo" }, dryRun: true }));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ plan: { destination: { kind: "issue", repo: "github.com/owner/repo" }, title: item.title } });
	expect(transport).not.toHaveBeenCalled();
	expect(getDb().query("SELECT item_id FROM inbox_filing_requests").all()).toHaveLength(0);
	expect(getDb().query("SELECT logical_key FROM graph_actions").all()).toHaveLength(0);
	expect(getInbox(item.id)?.processedAt).toBeUndefined();
});

test("issue filing reuses provider receipts after restart without a second write", async () => {
	const app = boot();
	const transport = spyOn(githubIssueTransport, "execute").mockImplementation(async command => ({
		exitCode: 0, stderr: "", stdout: `HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({
			id: 17, number: 17, html_url: "https://github.com/owner/repo/issues/17", repository_url: "https://api.github.com/repos/owner/repo",
			body: (JSON.parse(command.input!) as { body: string }).body,
		})}`,
	}));
	const item = createInbox({ title: "Simulated provider only", kind: "ticket" });
	const destination = { kind: "issue", repo: "owner/repo" };
	const first = await app.request(`/inbox/${item.id}/file`, json({ destination }));
	expect(first.status).toBe(200);
	const receipt = await first.json();
	expect(receipt).toMatchObject({ receipt: { kind: "issue", ref: "owner/repo#17", url: "https://github.com/owner/repo/issues/17" } });
	closeDb(); openDb({ path: path.join(directory, "deck.db") });
	const replay = await app.request(`/inbox/${item.id}/file`, json({ destination }));
	expect(await replay.json()).toEqual(receipt);
	expect(transport).toHaveBeenCalledTimes(1);
	expect(getInbox(item.id)?.processedAt).toBeDefined();
	expect((await app.request(`/inbox/${item.id}/file`, json({ destination: { kind: "card", project: "", column: "s_backlog" } }))).status).toBe(409);
});

test("unknown GitHub acceptance reserves the destination and blocks a racing board filing", async () => {
	const app = boot();
	const transport = spyOn(githubIssueTransport, "execute").mockRejectedValue(new Error("Connection lost after dispatch"));
	const item = createInbox({ title: "Do not duplicate an ambiguous write", kind: "ticket" });
	const result = await app.request(`/inbox/${item.id}/file`, json({ destination: { kind: "issue", repo: "owner/repo" } }));
	expect(result.status).toBe(400);
	expect(transport).toHaveBeenCalledTimes(1);
	closeDb(); openDb({ path: path.join(directory, "deck.db") });
	expect((await app.request(`/inbox/${item.id}/file`, json({ destination: { kind: "card", project: "", column: "s_backlog" } }))).status).toBe(409);
	expect(getInbox(item.id)?.processedAt).toBeUndefined();
});
