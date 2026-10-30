import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcServer } from "@oh-my-pi/pi-natives";
import { SessionDaemonClient } from "../../src/daemon/client";
import { SessionDaemon } from "../../src/daemon/server";
import { sessionDaemonEndpoint } from "../../src/daemon/paths";

/**
 * A scripted stand-in for `npi --mode rpc-ui`: same frame vocabulary, no model.
 * `prompt` streams three updates spaced 150ms apart so viewers can attach and
 * detach mid-turn; the journal holds completed replies.
 */
const FAKE_RPC_UI = `
const out = f => process.stdout.write(JSON.stringify(f) + "\\n");
const journal = [];
const answers = [];
const stateIds = [];
let live = null;
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], capabilities: [] });
let buf = "";
process.stdin.on("data", async chunk => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		const ok = data => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
		if (cmd.type === "extension_ui_response") { answers.push(cmd); continue; }
		if (cmd.type === "ask") {
			ok();
			out({ type: "extension_ui_request", id: "q1", method: "confirm", title: "proceed?" });
			continue;
		}
		if (cmd.type === "dump") { ok({ answers, stateIds }); continue; }
		if (cmd.type === "get_state") stateIds.push(cmd.id);
		if (cmd.type === "snapshot_session_journal") {
			out({ type: "journal_state", reason: "snapshot", entries: journal.slice() });
			if (live !== null) out({ type: "message_start", snapshot: true, message: { text: live } });
			ok({ entries: journal.length });
		} else if (cmd.type === "get_state") {
			ok({ model: { provider: "mock", id: "m1" }, sessionName: "fake " + process.pid, isStreaming: live !== null, marker: cmd.marker });
		} else if (cmd.type === "negotiate_protocol") {
			ok({ protocolVersion: 2 });
		} else if (cmd.type === "prompt") {
			ok();
			live = "";
			out({ type: "agent_start" });
			out({ type: "message_start" });
			for (const word of ["alpha ", "beta ", "gamma"]) {
				await new Promise(r => setTimeout(r, 150));
				live += word;
				out({ type: "message_update", delta: word });
			}
			journal.push(live); live = null;
			out({ type: "message_end" });
			out({ type: "agent_end" });
		} else if (cmd.id !== undefined) ok();
	}
});
`;

let tmp: string;
let daemon: SessionDaemon | undefined;
const clients: SessionDaemonClient[] = [];

async function start(): Promise<SessionDaemon> {
	tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "session-daemon-"));
	const script = path.join(tmp, "fake-rpc-ui.js");
	await Bun.write(script, FAKE_RPC_UI);
	daemon = new SessionDaemon({ dir: tmp, sessionCommand: args => [process.execPath, script, ...args] });
	expect(await daemon.start()).toBe(true);
	return daemon;
}

async function connect(d: SessionDaemon): Promise<SessionDaemonClient> {
	const client = await SessionDaemonClient.connect(d.endpoint);
	clients.push(client);
	return client;
}

function collect(client: SessionDaemonClient): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	client.onFrame(frame => frames.push(frame));
	return frames;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(20);
	}
}

const deltas = (frames: Record<string, unknown>[]) =>
	frames.filter(f => f.type === "message_update").map(f => f.delta as string);

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	await daemon?.shutdown();
	daemon = undefined;
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("SessionDaemonClient request lifetime", () => {
	it("rejects a pending request when its connection closes", async () => {
		tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "daemon-disconnect-"));
		const endpoint = sessionDaemonEndpoint(tmp);
		const peer = await IpcServer.listen(endpoint, { framing: "lines" }, connection => {
			connection.start(() => connection.end(), () => {});
		});
		try {
			const client = await SessionDaemonClient.connect(endpoint);
			clients.push(client);
			await expect(client.request({ type: "get_state" })).rejects.toThrow(/closed/);
		} finally {
			await peer.close();
		}
	});
});

describe("SessionDaemon", () => {
	it("hosts two sessions and lists them with model, title and status", async () => {
		const d = await start();
		const c = await connect(d);
		await c.create(tmp);
		await c.create(tmp);
		await until(() => d.list().every(s => s.model !== null));
		const sessions = await c.list();
		expect(sessions).toHaveLength(2);
		expect(sessions.every(s => s.model === "mock/m1" && s.status === "idle" && s.title?.startsWith("fake"))).toBe(
			true,
		);
	});

	it("streams one reply to two viewers; either can prompt; a late attacher resumes mid-message", async () => {
		const d = await start();
		const a = await connect(d);
		const { id } = await a.create(tmp);
		const aFrames = collect(a);
		await a.attach(id);
		const b = await connect(d);
		const bFrames = collect(b);
		await b.attach(id);

		await b.request({ type: "prompt", message: "hi" });
		await until(() => aFrames.some(f => f.type === "agent_end") && bFrames.some(f => f.type === "agent_end"));
		expect(deltas(aFrames)).toEqual(["alpha ", "beta ", "gamma"]);
		expect(deltas(bFrames)).toEqual(["alpha ", "beta ", "gamma"]);

		// Second turn, prompted by A; C attaches after the first word.
		await a.request({ type: "prompt", message: "again" });
		await until(() => deltas(aFrames).length === 4);
		const aBeforeC = aFrames.length;
		const c = await connect(d);
		const cFrames = collect(c);
		await c.attach(id);
		await until(() => cFrames.some(f => f.type === "agent_end"));
		const snapshot = cFrames.find(f => f.type === "message_start" && f.snapshot === true) as {
			message: { text: string };
		};
		// Snapshot text + live tail reassemble the reply exactly once.
		expect(snapshot.message.text + deltas(cFrames).join("")).toBe("alpha beta gamma");
		// A saw no snapshot frames from C's attach (its own attach snapshot came earlier).
		expect(aFrames.slice(aBeforeC).some(f => f.snapshot === true || f.reason === "snapshot")).toBe(false);
		expect(deltas(aFrames)).toEqual(["alpha ", "beta ", "gamma", "alpha ", "beta ", "gamma"]);
	});

	it("keeps the session running with no viewers; reattaching shows the completed reply", async () => {
		const d = await start();
		const a = await connect(d);
		const { id } = await a.create(tmp);
		collect(a);
		await a.attach(id);
		await a.request({ type: "prompt", message: "hi" });
		await a.detach();
		a.close();
		await until(() => d.list()[0]!.status === "idle" && d.list()[0]!.viewers === 0);
		const r = await connect(d);
		const rFrames = collect(r);
		await r.attach(id);
		const journal = rFrames.find(f => f.type === "journal_state") as { entries: string[] };
		expect(journal.entries).toEqual(["alpha beta gamma"]);
		expect(d.list()[0]!.status).toBe("idle");
	});

	it("rejects a session with a bad cwd without disturbing running sessions", async () => {
		const d = await start();
		const c = await connect(d);
		const { id } = await c.create(tmp);
		await expect(c.create(path.join(tmp, "does-not-exist"))).rejects.toThrow();
		await until(() => d.list().find(s => s.id === id)?.status === "idle");
		expect((await c.list()).map(s => s.id)).toEqual([id]);
	});

	it("a second daemon for the same profile directory does not start", async () => {
		const d = await start();
		const second = new SessionDaemon({ dir: tmp });
		expect(await second.start()).toBe(false);
		expect(await (await connect(d)).list()).toEqual([]);
	});

	it("first answer wins through the socket; a second answer gets already_answered and others get the cancel", async () => {
		const d = await start();
		const a = await connect(d);
		const { id } = await a.create(tmp);
		const aFrames = collect(a);
		await a.attach(id);
		const b = await connect(d);
		const bFrames = collect(b);
		await b.attach(id);

		await a.request({ type: "ask" });
		const isAsk = (f: Record<string, unknown>) => f.type === "extension_ui_request" && f.id === "q1";
		await until(() => aFrames.some(isAsk) && bFrames.some(isAsk));

		a.send({ type: "extension_ui_response", id: "q1", confirmed: true });
		const isCancel = (f: Record<string, unknown>) =>
			f.type === "extension_ui_request" && f.method === "cancel" && f.targetId === "q1";
		await until(() => bFrames.some(isCancel));
		expect(aFrames.some(isCancel)).toBe(false);

		b.send({ type: "extension_ui_response", id: "q1", confirmed: false });
		await until(() => bFrames.some(f => f.type === "response" && f.code === "already_answered"));

		const dump = (await a.request({ type: "dump" })) as { answers: { id: string; confirmed: boolean }[] };
		expect(dump.answers).toHaveLength(1);
		expect(dump.answers[0]!.confirmed).toBe(true);
		expect(dump.answers[0]!.id).toBe("q1");
	});

	it("routes colliding client request ids back to the connection that asked", async () => {
		const d = await start();
		const a = await connect(d);
		const { id } = await a.create(tmp);
		const aFrames = collect(a);
		await a.attach(id);
		const b = await connect(d);
		const bFrames = collect(b);
		await b.attach(id);

		a.send({ type: "get_state", id: "1", marker: "from-a" });
		b.send({ type: "get_state", id: "1", marker: "from-b" });
		const stateResponses = (frames: Record<string, unknown>[]) =>
			frames.filter(f => f.type === "response" && f.command === "get_state");
		await until(() => stateResponses(aFrames).length >= 1 && stateResponses(bFrames).length >= 1);
		await Bun.sleep(200);
		const markers = (frames: Record<string, unknown>[]) =>
			stateResponses(frames).map(f => (f.data as { marker: string }).marker);
		expect(stateResponses(aFrames).map(f => f.id)).toEqual(["1"]);
		expect(stateResponses(bFrames).map(f => f.id)).toEqual(["1"]);
		expect(markers(aFrames)).toEqual(["from-a"]);
		expect(markers(bFrames)).toEqual(["from-b"]);

		const dump = (await a.request({ type: "dump" })) as { stateIds: string[] };
		const seen = dump.stateIds.slice(-2);
		expect(new Set(seen).size).toBe(2);
		expect(seen.includes("1")).toBe(false);
	});

	it("shows a late attacher an interaction that is still open", async () => {
		const d = await start();
		const a = await connect(d);
		const { id } = await a.create(tmp);
		collect(a);
		await a.attach(id);
		await a.request({ type: "ask" });
		const c = await connect(d);
		const cFrames = collect(c);
		await c.attach(id);
		await until(() => cFrames.some(f => f.type === "extension_ui_request" && f.id === "q1"));
	});
});
