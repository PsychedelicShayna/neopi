import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { ctlPipe } from "../../src/cli/ctl-pipe";
import { HostBudget } from "../../src/control/budget";
import { ControlClient } from "../../src/control/client";
import { publishControlEndpoint } from "../../src/control/registry";
import { ControlServer, type ControlConnection, type ControlConnectionHost } from "../../src/control/server";
import type { ControlSnapshot } from "../../src/control/types";
import { supportsRpcProtocolV2 } from "../../src/modes/rpc/rpc-client";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "../../src/modes/rpc/rpc-frame";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture(onCommand?: (connection: ControlConnection, frame: Record<string, unknown>) => void) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-pipe-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const instanceId = "abcdef1234567890";
	const snapshot: ControlSnapshot = {
		version: 1,
		instanceId,
		imageId: "test",
		role: "tui",
		pid: process.pid,
		ready: true,
		build: { version: "test", gitSha: null, dirty: null, execPath: process.execPath },
		tmux: { pane: null, session: null, window: null },
		cwd: dir,
		title: null,
		session: null,
		busy: { streaming: false, compacting: false, pendingSteerAndFollowUp: 0, pendingAsyncWork: false, settled: true },
		revisions: { generation: 1, human: 0, focus: 0, draft: 0, dialogs: 0, paint: 0, model: null, role: null },
		view: null,
		modes: { plan: false, chat: "off", goal: false, vibe: false, live: false, repl: false },
		dialogs: [],
		connections: 1,
		requests: { open: 0, retained: 0 },
		hosts: [],
		approvals: { controlAllowed: false, pending: 0 },
		exemptions: [],
	};
	const disconnected = Promise.withResolvers<void>();
	const commands: Record<string, unknown>[] = [];
	const host = {
		instanceId,
		token: "",
		budget: new HostBudget(),
		registryDir: dir,
		snapshot: () => snapshot,
		onAuthenticated: connection =>
			connection.write({
				type: "ready",
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				capabilities: ["control_v1"],
			}),
		onClosed: () => disconnected.resolve(),
		dispatch: async (connection: ControlConnection, frame) => {
			if (frame.type === "bye") {
				connection.close("bye");
				return;
			}
			commands.push(frame);
			onCommand?.(connection, frame);
			connection.respond({
				type: "response",
				command: String(frame.type),
				requestId: frame.requestId as string | undefined,
				id: frame.id as string | undefined,
				success: true,
				data:
					frame.type === "negotiate_protocol"
						? { protocolVersion: 2 }
						: frame.type === "subscribe"
							? { cursor: 0 }
							: (frame.payload ?? snapshot),
			});
		},
	} satisfies ControlConnectionHost;
	const server = new ControlServer({ metadata: { instanceId }, host });
	const publication = await publishControlEndpoint({
		dir,
		role: "tui",
		instanceId,
		imageId: "test",
		execPath: process.execPath,
		gitSha: null,
		profile: null,
		sessionId: "session",
		sessionFile: null,
		title: null,
		cwd: dir,
		tmuxPane: null,
		tmuxSession: null,
		tmuxWindow: null,
		tty: null,
		onConnection: socket => server.accept(socket),
	});
	host.token = publication.token;
	cleanups.push(() => publication.close());
	return { dir, instanceId, publication, commands, disconnected, server };
}

describe("ctl pipe", () => {
	test("captures early ready, relays ids and v2 chunks, and EOF only detaches", async () => {
		const f = await fixture();
		const input = new PassThrough();
		const frames: Record<string, unknown>[] = [];
		const physical: Record<string, unknown>[] = [];
		const decoder = new RpcFrameDecoder();
		const encoder = new RpcFrameEncoder();
		const stderr: string[] = [];
		const payload = "x".repeat(MAX_RPC_FRAME_BYTES + 100);
		const result = await ctlPipe(f.instanceId, {
			registry: { dir: f.dir },
			input,
			label: "neocode",
			io: {
				stderr: text => stderr.push(text),
				stdout: text => {
					for (const line of text.trim().split("\n")) {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						physical.push(parsed);
						const frame = decoder.push(parsed) as Record<string, unknown> | undefined;
						if (!frame) continue;
						frames.push(frame);
						if (frame.type === "ready")
							input.write(`${JSON.stringify({ type: "negotiate_protocol", id: "n", protocolVersion: 2 })}\n`);
						if (frame.command === "negotiate_protocol") {
							encoder.setProtocolVersion(2);
							input.write(encoder.encode({ type: "echo", id: "echo", payload }));
						}
						if (frame.id === "echo") input.end();
					}
				},
			},
		});
		expect(result).toBe(0);
		expect(stderr).toEqual([]);
		expect(frames.map(frame => (frame.type === "ready" ? "ready" : frame.command))).toEqual([
			"ready",
			"negotiate_protocol",
			"echo",
		]);
		expect(frames[0]).toMatchObject({
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			capabilities: ["control_v1"],
		});
		expect(frames[1]).toMatchObject({ id: "n", success: true });
		expect(supportsRpcProtocolV2(frames[0])).toBe(true);
		expect(frames[2]).toMatchObject({ id: "echo", success: true, data: payload });
		expect(physical.some(frame => frame.type === "rpc_chunk")).toBe(true);
		expect(f.commands[0]).toMatchObject({ type: "subscribe", events: "all" });
		await f.disconnected.promise;
		// A fresh authenticated client proves EOF did not shut down the owner.
		const client = new ControlClient({ metadata: f.publication.metadata(), label: "after-eof" });
		try {
			await client.connect();
			expect((await client.request({ type: "get_status" })).success).toBe(true);
		} finally {
			client.close();
		}
	});

	test("relays journal notifications and unknown event kinds without disrupting command responses", async () => {
		const notifications = [
			{ type: "journal_state", reason: "snapshot", sessionId: "native", sessionFile: "/sessions/native.jsonl", leafId: null },
			{ type: "future_session_event", payload: { retained: true } },
		];
		const f = await fixture((connection, frame) => {
			if (frame.type === "echo") for (const notification of notifications) connection.write(notification);
		});
		const input = new PassThrough();
		const frames: Record<string, unknown>[] = [];
		const result = await ctlPipe(f.instanceId, {
			registry: { dir: f.dir }, input,
			io: {
				stderr: () => {},
				stdout: text => {
					for (const line of text.trim().split("\n")) {
						const frame = JSON.parse(line) as Record<string, unknown>;
						frames.push(frame);
						if (frame.type === "ready") input.write(`${JSON.stringify({ type: "echo", id: "barrier" })}\n`);
						if (frame.id === "barrier") input.end();
					}
				},
			},
		});
		expect(result).toBe(0);
		for (const notification of notifications) expect(frames).toContainEqual(notification);
		expect(frames.find(frame => frame.id === "barrier")).toMatchObject({ type: "response", success: true });
	});

	test("slow output bounds queued frames until the consumer drains", async () => {
		const f = await fixture();
		const input = new PassThrough();
		const frames: Record<string, unknown>[] = [];
		const first = Promise.withResolvers<void>();
		let release: (() => void) | undefined;
		const output = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
				frames.push(frame);
				if (frames.length === 2) {
					release = callback;
					first.resolve();
				} else {
					callback();
					if (frame.id === "last") input.end();
				}
			},
		});
		for (let i = 0; i < 20; i++)
			input.write(`${JSON.stringify({ type: "echo", id: i === 19 ? "last" : String(i) })}\n`);
		const result = ctlPipe(f.instanceId, { registry: { dir: f.dir }, input, output });
		await first.promise;
		await Bun.sleep(50);
		expect(frames.map(frame => frame.type)).toEqual(["ready", "response"]);
		expect(output.writableLength).toBe(Buffer.byteLength(JSON.stringify(frames[1])) + 1);
		release!();
		expect(await result).toBe(0);
		expect(frames.slice(1).map(frame => frame.id)).toEqual([
			...Array.from({ length: 19 }, (_, i) => String(i)),
			"last",
		]);
		output.destroy();
	});

	test("blocked owner bounds stdin forwarding, then drains every buffered frame before EOF", async () => {
		const blocked = Promise.withResolvers<ControlConnection>();
		const f = await fixture((connection, frame) => {
			if (frame.type === "block") {
				connection.socket.pause();
				blocked.resolve(connection);
			}
		});
		const input = new PassThrough();
		const paused = Promise.withResolvers<void>();
		input.once("pause", () => paused.resolve());
		const sent = vi.spyOn(ControlClient.prototype, "sendRaw");
		const payload = "x".repeat(512 * 1024);
		const count = 16;
		// One chunk exercises buffered frames; its final frame has no newline.
		const burst = Array.from({ length: count }, (_, i) =>
			JSON.stringify({ type: "echo", id: `burst-${i}`, padding: payload }),
		).join("\n");
		const result = ctlPipe(f.instanceId, {
			registry: { dir: f.dir },
			input,
			io: {
				stderr: () => {},
				stdout: text => {
					const frame = JSON.parse(text) as Record<string, unknown>;
					if (frame.type === "ready") input.write('{"type":"block","id":"block"}\n');
					if (frame.id === "block") input.end(burst);
				},
			},
		});
		const owner = await blocked.promise;
		cleanups.push(async () => {
			owner.socket.resume();
			input.end();
			await result;
		});
		await paused.promise;
		await Bun.sleep(50);
		expect(input.isPaused()).toBe(true);
		expect(sent.mock.calls.length).toBeGreaterThan(1);
		expect(sent.mock.calls.length).toBeLessThan(count + 1);
		const forwardedWhileBlocked = sent.mock.calls.length;
		await Bun.sleep(50);
		expect(sent.mock.calls.length).toBe(forwardedWhileBlocked);
		owner.socket.resume();
		expect(await result).toBe(0);
		await f.disconnected.promise;
		expect(f.commands.filter(frame => frame.type === "echo").map(frame => frame.id)).toEqual(
			Array.from({ length: count }, (_, i) => `burst-${i}`),
		);
		input.destroy();
	});

	test("owner socket closure ends the pipe even with stdin still open", async () => {
		const f = await fixture();
		const input = new PassThrough();
		const result = ctlPipe(f.instanceId, {
			registry: { dir: f.dir },
			input,
			io: {
				stderr: () => {},
				stdout: text => {
					if (text.includes('"ready"'))
						queueMicrotask(() => {
							void f.publication.close();
						});
				},
			},
		});
		expect(await result).toBe(0);
		expect(input.destroyed).toBe(false);
		input.destroy();
	});

	test("unresolved target emits only a machine-readable startup failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-pipe-missing-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const out: string[] = [];
		const err: string[] = [];
		const input = new PassThrough();
		expect(
			await ctlPipe("missing", {
				registry: { dir: path.join(root, "missing") },
				input,
				io: { stdout: text => out.push(text), stderr: text => err.push(text) },
			}),
		).toBe(1);
		expect(out).toEqual([]);
		expect(JSON.parse(err.join(""))).toMatchObject({ type: "startup_error", code: "control_unavailable" });
		input.destroy();
	});
});
