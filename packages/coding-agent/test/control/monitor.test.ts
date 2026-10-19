import { afterEach, describe, expect, test, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import * as net from "node:net";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { TranscriptLiveState } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { MAX_CONNECTIONS, MAX_MONITOR_CONNECTIONS, MAX_PENDING_HANDSHAKES } from "../../src/control/budget";
import { ControlClient } from "../../src/control/client";
import { ControlHost } from "../../src/control/host";
import {
	ControlMonitorService,
	MONITOR_LIVE_BACKPRESSURE_BYTES,
	MONITOR_LIVE_INTERVAL_MS,
	MONITOR_LIVE_MAX_CHARS,
	MONITOR_TRANSCRIPT_ENTRY_CAP,
	MONITOR_TRANSCRIPT_READ_CAP,
	type MonitorConnection,
	type MonitorGrant,
} from "../../src/control/monitor-service";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { transcriptEntryTooLargeError } from "../../src/session/transcript-slice";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { MonitorAttachConnection } from "../../src/monitor/attach";
import { ControlServer } from "../../src/control/server";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

interface HostFixture {
	host: ControlHost;
	registry: AgentRegistry;
	root: AgentRef;
	sub: AgentRef;
	advisor: AgentRef;
	child: AgentSession;
	/** Control registry directory the host publishes into. */
	dir: string;
	connect(capability?: string, probe?: boolean): Promise<ControlClient>;
}

async function hostFixture(): Promise<HostFixture> {
	const temp = TempDir.createSync("npi-mon-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const sessions: AgentSession[] = [];
	const clients: ControlClient[] = [];
	const refs: AgentRef[] = [];
	const registry = AgentRegistry.global();
	const hosts: ControlHost[] = [];
	cleanups.push(async () => {
		await Promise.all(
			clients.map(async client => {
				const closed = Promise.withResolvers<void>();
				client.onClose(closed.resolve);
				client.close();
				await closed.promise;
			}),
		);
		for (const host of hosts) await host.close();
		for (const ref of refs.reverse()) registry.unregister(ref.id, ref);
		for (const session of sessions.reverse()) await session.dispose();
		auth.close();
		await temp.remove();
	});
	const createSession = (): AgentSession => {
		const model = createMockModel({ provider: "anthropic", responses: [] });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: [], tools: [] },
				streamFn: model.stream,
			}),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		});
		sessions.push(session);
		return session;
	};
	const owner = createSession();
	const child = createSession();
	const rootId = `monitor-${randomUUID()}`;
	const root = registry.register({ id: rootId, displayName: "private-root", kind: "main", session: owner });
	const subFile = temp.join("sub.jsonl");
	const advisorFile = temp.join("advisor.jsonl");
	writeFileSync(subFile, "only-the-granted-sub\n");
	writeFileSync(advisorFile, "private-advisor-transcript\n");
	const sub = registry.register({
		id: `${rootId}/sub`,
		displayName: "worker",
		kind: "sub",
		parentId: rootId,
		session: child,
		sessionFile: subFile,
		status: "idle",
	});
	const advisor = registry.register({
		id: `${rootId}/advisor`,
		displayName: "advisor",
		kind: "advisor",
		parentId: rootId,
		session: null,
		sessionFile: advisorFile,
		status: "parked",
		history: { readOnly: true },
	});
	refs.push(root, sub, advisor);
	const host = new ControlHost({ session: owner, role: "rpc", dir: temp.path(), tmuxPane: null });
	hosts.push(host);
	await host.start();
	return {
		host,
		registry,
		root,
		sub,
		advisor,
		child,
		dir: temp.path(),
		async connect(capability?: string, probe = false) {
			const publication = host.publication;
			if (!publication) throw new Error("monitor test host did not publish");
			const client = new ControlClient({
				metadata: capability === undefined ? publication.metadata() : { ...publication.metadata(), token: "" },
				label: "monitor-contract",
				monitorCapability: capability,
				probe,
				timeoutMs: 2_000,
			});
			clients.push(client);
			await client.connect();
			return client;
		},
	};
}

test("monitor panes cannot exhaust operator control handshakes", async () => {
	const fixture = await hostFixture();
	const { capability } = fixture.host.monitor.grant(fixture.sub.id);
	for (let index = 0; index < MAX_MONITOR_CONNECTIONS; index++) {
		await fixture.connect(capability);
	}
	const operator = await fixture.connect(undefined, true);
	const status = await operator.request({ type: "get_status" });
	expect(status.success).toBe(true);
	expect((status.data as { connections: number }).connections).toBe(MAX_MONITOR_CONNECTIONS + 1);
});

test("monitor and operator admission limits remain independent and reusable", async () => {
	const fixture = await hostFixture();
	const { capability } = fixture.host.monitor.grant(fixture.sub.id);
	const operators: ControlClient[] = [];
	for (let index = 0; index < MAX_CONNECTIONS; index++) {
		operators.push(await fixture.connect());
	}
	const monitors: ControlClient[] = [];
	for (let index = 0; index < MAX_MONITOR_CONNECTIONS; index++) {
		monitors.push(await fixture.connect(capability));
	}
	await expect(fixture.connect()).rejects.toMatchObject({
		code: "rate_limited",
		message: "control connection limit reached",
	});
	await expect(fixture.connect(capability)).rejects.toMatchObject({
		code: "rate_limited",
		message: "monitor connection limit reached",
	});
	const closed = Promise.withResolvers<void>();
	operators[0].onClose(closed.resolve);
	operators[0].close();
	await closed.promise;
	const replacement = await fixture.connect();
	expect((await replacement.request({ type: "get_status" })).success).toBe(true);
	// The operator close/replacement must not detach any of the monitor panes.
	expect((await monitors[0].request({ type: "monitor_subscribe" })).success).toBe(true);
});

test("pending hello sockets have a separate bounded admission pool", async () => {
	const fixture = await hostFixture();
	const publication = fixture.host.publication;
	if (!publication) throw new Error("monitor test host did not publish");
	const operator = await fixture.connect();
	const pending: net.Socket[] = [];
	cleanups.push(() => {
		for (const socket of pending) socket.destroy();
	});
	for (let index = 0; index < MAX_PENDING_HANDSHAKES; index++) {
		const socket = net.connect(publication.endpoint);
		pending.push(socket);
		await once(socket, "data", { signal: AbortSignal.timeout(2_000) });
	}
	await expect(fixture.connect()).rejects.toMatchObject({ code: "closed" });
	// Saturated handshakes must not interrupt a previously authenticated operator.
	expect((await operator.request({ type: "get_status" })).success).toBe(true);
});

test("canary: refused socket with blocked flush must not retain a pending slot forever", async () => {
	const accept = ControlServer.prototype.accept;
	let server: ControlServer | undefined;
	vi.spyOn(ControlServer.prototype, "accept").mockImplementation(function (this: ControlServer, socket: net.Socket) {
		server = this;
		accept.call(this, socket);
	});
	const fixture = await hostFixture();
	const publication = fixture.host.publication;
	if (!publication) throw new Error("monitor test host did not publish");
	const operators: ControlClient[] = [];
	for (let index = 0; index < MAX_CONNECTIONS; index++) operators.push(await fixture.connect());
	const rawClients: net.Socket[] = [];
	cleanups.push(() => {
		for (const socket of rawClients) socket.destroy();
	});
	for (let index = 0; index < MAX_PENDING_HANDSHAKES; index++) {
		const socket = net.connect(publication.endpoint);
		rawClients.push(socket);
		await once(socket, "data", { signal: AbortSignal.timeout(2_000) });
		socket.pause();
		socket.write(
			`${"{\n".repeat(12_000)}${JSON.stringify({
				type: "hello",
				protocolVersion: 2,
				token: publication.token,
				client: { label: "blocked-refusal", kind: "cli" },
			})}\n`,
		);
		await until(
			() =>
				[...server!.connections].filter(connection => !connection.authenticated && connection.socket.writableEnded)
					.length ===
				index + 1,
			"blocked refusal",
		);
	}
	const refused = [...server!.connections].filter(connection => !connection.authenticated);
	await Bun.sleep(6_000);
	const closed = Promise.withResolvers<void>();
	operators[0].onClose(closed.resolve);
	operators[0].close();
	await closed.promise;
	const replacement = await fixture.connect().then(
		() => "connected",
		(error: { code: string }) => error.code,
	);
	expect({
		authenticated: [...server!.connections].filter(connection => connection.authenticated).length,
		pending: [...server!.connections].filter(connection => !connection.authenticated).length,
		replacement,
	}).toEqual({ authenticated: MAX_CONNECTIONS, pending: 0, replacement: "connected" });
	// Reclaim the transport, not just its admission entry.
	expect(refused.every(connection => connection.socket.destroyed)).toBe(true);
}, 30_000);

function nextEvent(client: ControlClient, type: string): Promise<Record<string, unknown>> {
	const pending = Promise.withResolvers<Record<string, unknown>>();
	const timer = setTimeout(() => {
		unsubscribe();
		pending.reject(new Error(`missing ${type} event`));
	}, 2_000);
	const unsubscribe = client.onEvent(frame => {
		if (frame.type !== type) return;
		clearTimeout(timer);
		unsubscribe();
		pending.resolve(frame);
	});
	return pending.promise;
}

function requireGrant(service: ControlMonitorService, capability: string): MonitorGrant {
	const grant = service.authenticate(capability);
	if (!grant) throw new Error("fresh grant was not authenticated");
	return grant;
}

class MemoryConnection implements MonitorConnection {
	readonly frames: object[] = [];
	bufferedBytes = 0;
	closed = false;
	write(frame: object): void {
		this.frames.push(frame);
	}
	close(): void {
		this.closed = true;
	}
}

interface ServiceFixture {
	service: ControlMonitorService;
	registry: AgentRegistry;
	root: AgentRef;
	sub: AgentRef;
	connection: MemoryConnection;
	grant: MonitorGrant;
	capability: string;
	bumpGeneration(): void;
}

function serviceFixture(ensureLive: (id: string) => Promise<AgentSession>): ServiceFixture {
	const registry = new AgentRegistry();
	const owner = { sessionName: "owner", sessionManager: { getCwd: () => "/tmp" } } as unknown as AgentSession;
	const root = registry.register({ id: "owner", displayName: "owner", kind: "main", session: owner });
	const sub = registry.register({
		id: "owner/sub",
		displayName: "worker",
		kind: "sub",
		parentId: root.id,
		session: null,
		status: "parked",
	});
	let generation = 1;
	const service = new ControlMonitorService({
		session: owner,
		registry,
		generation: () => generation,
		lifecycle: () => ({ ensureLive }),
	});
	cleanups.push(() => service.dispose());
	const { capability } = service.grant(sub.id);
	const grant = requireGrant(service, capability);
	const connection = new MemoryConnection();
	return {
		service,
		registry,
		root,
		sub,
		grant,
		capability,
		connection,
		bumpGeneration: () => {
			generation++;
			service.recheck();
		},
	};
}

function promptTarget(delivered: Array<{ text: string; behavior: string }>): AgentSession {
	return {
		prompt: async (text: string, options: { streamingBehavior: string }) => {
			delivered.push({ text, behavior: options.streamingBehavior });
		},
	} as unknown as AgentSession;
}

describe("monitor capability socket boundary", () => {
	test("token-less monitor hello has scope but no host snapshot; other commands are monitor_only", async () => {
		const fixture = await hostFixture();
		const info = fixture.host.monitor.grant(fixture.sub.id);
		const monitor = await fixture.connect(info.capability);
		expect(monitor.snapshot).toBeUndefined();
		expect(monitor.monitorScope).toEqual({ agentId: fixture.sub.id, kind: "sub", canChat: true });
		for (const type of ["state", "get_status", "input", "slash", "agents", "monitor_grant", "subscribe"]) {
			const reply = await monitor.request({ type, text: "must not reach root", agentId: fixture.advisor.id });
			expect(reply.success).toBe(false);
			expect(reply.code).toBe("monitor_only");
			expect(reply.data).toBeUndefined();
		}
		const transcript = await monitor.request({ type: "monitor_transcript", agentId: fixture.advisor.id });
		expect(transcript.success).toBe(true);
		expect((transcript.data as { text: string }).text).toBe("only-the-granted-sub\n");
		const full = await fixture.connect();
		expect(full.snapshot?.session?.sessionId).toBe(fixture.root.session?.sessionId);
		expect((await full.request({ type: "state" })).success).toBe(true);
		const probe = await fixture.connect(undefined, true);
		expect((await probe.request({ type: "state" })).success).toBe(true);
	});

	test("an entry over the read cap arrives whole; only one past the entry cap is an explicit error", async () => {
		const fixture = await hostFixture();
		const file = fixture.sub.sessionFile;
		if (!file) throw new Error("fixture sub has no transcript");
		// Quotes and backslashes double under JSON escaping; the reply is chunked, not cut.
		const large = `{"big":"${'a\\"b'.repeat(Math.ceil((MONITOR_TRANSCRIPT_READ_CAP * 2) / 4))}"}\n`;
		writeFileSync(file, `first\n${large}last\n`);
		const info = fixture.host.monitor.grant(fixture.sub.id);
		const monitor = await fixture.connect(info.capability);
		const texts: string[] = [];
		let fromByte = 0;
		for (let guard = 0; guard < 4 && fromByte < Bun.file(file).size; guard++) {
			const reply = await monitor.request({ type: "monitor_transcript", fromByte }, 10_000);
			expect(reply.success).toBe(true);
			const slice = reply.data as { text: string; newSize: number; error?: string };
			expect(slice.error).toBeUndefined();
			texts.push(slice.text);
			fromByte = slice.newSize;
		}
		expect(texts).toEqual(["first\n", large, "last\n"]);

		// A large entry still being written waits for its newline instead of failing.
		const partial = "x".repeat(MONITOR_TRANSCRIPT_READ_CAP + 1);
		writeFileSync(file, `first\n${partial}`);
		const waiting = await monitor.request({ type: "monitor_transcript", fromByte: 6 }, 10_000);
		expect(waiting.data).toEqual({ text: "", newSize: 6 });

		writeFileSync(file, `first\n${"y".repeat(MONITOR_TRANSCRIPT_ENTRY_CAP + 1)}\nlast\n`);
		const refused = await monitor.request({ type: "monitor_transcript", fromByte: 6 }, 10_000);
		expect(refused.data).toEqual({
			text: "",
			newSize: 6,
			error: transcriptEntryTooLargeError(MONITOR_TRANSCRIPT_ENTRY_CAP),
		});
	});

	test("a wrong monitor capability is unauthorized even without a publication token", async () => {
		const fixture = await hostFixture();
		await expect(fixture.connect("0".repeat(64))).rejects.toMatchObject({ code: "unauthorized" });
	});

	for (const end of ["revoke", "owner exit"] as const) {
		test(`an attach pane reconnects after its socket drops, then ends on ${end}`, async () => {
			const fixture = await hostFixture();
			const sockets: net.Socket[] = [];
			const createConnection = net.createConnection;
			vi.spyOn(net, "createConnection").mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
				const socket = createConnection(...args);
				sockets.push(socket);
				return socket;
			}) as typeof net.createConnection);
			const publication = fixture.host.publication;
			if (!publication) throw new Error("monitor test host did not publish");
			const info = fixture.host.monitor.grant(fixture.sub.id);
			const connection = new MonitorAttachConnection({
				metadata: publication.metadata(),
				capability: info.capability,
				registryDir: fixture.dir,
			});
			cleanups.push(() => connection.dispose());
			await connection.start();
			expect(connection.state).toBe("live");
			const states: string[] = [];
			connection.onChange(() => states.push(connection.state));

			sockets.at(-1)?.destroy();
			await until(() => states.includes("reconnecting") && connection.state === "live", "reconnect");
			expect(sockets).toHaveLength(2);
			expect((await connection.readTranscript(0))?.text).toBe("only-the-granted-sub\n");

			if (end === "revoke") fixture.host.monitor.revoke(info.capability);
			else await fixture.host.close();
			await until(() => connection.state === "ended", "end");
			expect(connection.endReason).toBe(
				end === "revoke" ? "monitor access was revoked" : "the owner session exited",
			);
			expect(sockets).toHaveLength(2);
		});
	}

	test("advisor capabilities cannot chat or redirect chat to a subagent", async () => {
		const fixture = await hostFixture();
		const info = fixture.host.monitor.grant(fixture.advisor.id);
		const monitor = await fixture.connect(info.capability);
		expect(monitor.monitorScope?.canChat).toBe(false);
		const reply = await monitor.request({ type: "monitor_chat", agentId: fixture.sub.id, text: "hello" });
		expect(reply.success).toBe(false);
		expect(reply.code).toBe("read_only");
	});

	for (const change of ["remove", "replace"] as const) {
		test(`${change} of the exact ref sends monitor_gone and closes its socket`, async () => {
			const fixture = await hostFixture();
			const info = fixture.host.monitor.grant(fixture.sub.id);
			const monitor = await fixture.connect(info.capability);
			expect((await monitor.request({ type: "monitor_subscribe" })).success).toBe(true);
			const gone = nextEvent(monitor, "monitor_gone");
			const closed = Promise.withResolvers<void>();
			monitor.onClose(closed.resolve);
			if (change === "remove") fixture.registry.unregister(fixture.sub.id, fixture.sub);
			else {
				const replacement = fixture.registry.register({ ...fixture.sub, session: null, status: "parked" });
				cleanups.push(() => {
					fixture.registry.unregister(replacement.id, replacement);
				});
			}
			expect((await gone).agentId).toBe(fixture.sub.id);
			await closed.promise;
			expect(monitor.closed).toBe(true);
			expect(fixture.host.monitor.authenticate(info.capability)).toBeUndefined();
		});
	}

	test("a generation bump invalidates even an authenticated monitor that has not subscribed", async () => {
		const fixture = await hostFixture();
		const info = fixture.host.monitor.grant(fixture.sub.id);
		const monitor = await fixture.connect(info.capability);
		const gone = nextEvent(monitor, "monitor_gone");
		const closed = Promise.withResolvers<void>();
		monitor.onClose(closed.resolve);
		fixture.host.bumpGeneration();
		expect((await gone).agentId).toBe(fixture.sub.id);
		await closed.promise;
		expect(fixture.host.monitor.authenticate(info.capability)).toBeUndefined();
	});

	test("subscription carries in-flight session state and coalesces a synchronous event burst", async () => {
		const fixture = await hostFixture();
		const initial = createAssistantMessage("initial in-flight assistant");
		fixture.child.agent.emitExternalEvent({ type: "message_start", message: initial });
		const info = fixture.host.monitor.grant(fixture.sub.id);
		const monitor = await fixture.connect(info.capability);
		const subscribed = await monitor.request({ type: "monitor_subscribe" });
		expect((subscribed.data as { live: TranscriptLiveState }).live.assistant).toEqual(initial);
		const frames: Record<string, unknown>[] = [];
		const unsubscribe = monitor.onEvent(frame => {
			if (frame.type === "monitor_live") frames.push(frame);
		});
		const next = nextEvent(monitor, "monitor_live");
		fixture.child.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "call",
			toolName: "lookup",
			args: {},
		});
		for (let index = 0; index < 30; index++) {
			const message: AssistantMessage = { ...initial, content: [{ type: "text", text: `stream ${index}` }] };
			fixture.child.agent.emitExternalEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: String(index), partial: message },
			});
			fixture.child.agent.emitExternalEvent({
				type: "tool_execution_update",
				toolCallId: "call",
				toolName: "lookup",
				args: {},
				partialResult: { content: [{ type: "text", text: `progress ${index}` }] },
			});
		}
		const live = (await next).state as TranscriptLiveState;
		expect(live.assistant?.content).toEqual([{ type: "text", text: "stream 29" }]);
		expect(live.tools[0]?.partialResult?.content).toEqual([{ type: "text", text: "progress 29" }]);
		await monitor.request({ type: "monitor_transcript" });
		expect(frames).toHaveLength(1);
		unsubscribe();
	});

	test("initial and pushed live states stay bounded even when tool arguments exceed the cap", async () => {
		const fixture = await hostFixture();
		const initial = createAssistantMessage("x".repeat(MONITOR_LIVE_MAX_CHARS + 1));
		fixture.child.agent.emitExternalEvent({ type: "message_start", message: initial });
		fixture.child.agent.emitExternalEvent({
			type: "tool_execution_update",
			toolCallId: "huge",
			toolName: "lookup",
			args: { text: "y".repeat(MONITOR_LIVE_MAX_CHARS + 1) },
			partialResult: { content: [] },
		});
		const info = fixture.host.monitor.grant(fixture.sub.id);
		const monitor = await fixture.connect(info.capability);
		const subscribed = await monitor.request({ type: "monitor_subscribe" });
		const state = (subscribed.data as { live: TranscriptLiveState }).live;
		expect(JSON.stringify(state).length).toBeLessThanOrEqual(MONITOR_LIVE_MAX_CHARS);
		const next = nextEvent(monitor, "monitor_live");
		fixture.child.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "huge",
			toolName: "lookup",
			args: { text: "y".repeat(MONITOR_LIVE_MAX_CHARS + 1) },
		});
		const pushed = await next;
		expect(JSON.stringify(pushed.state).length).toBeLessThanOrEqual(MONITOR_LIVE_MAX_CHARS);
		expect(pushed.omitted).toBe("assistant");
	});

	test("a slow monitor waits for writable bytes to drain instead of queueing live frames", async () => {
		const fixture = await hostFixture();
		const info = fixture.host.monitor.grant(fixture.sub.id);
		const grant = requireGrant(fixture.host.monitor, info.capability);
		const connection = new MemoryConnection();
		connection.bufferedBytes = MONITOR_LIVE_BACKPRESSURE_BYTES + 1;
		expect((await fixture.host.monitor.handle(connection, grant, { type: "monitor_subscribe" })).success).toBe(true);
		fixture.child.agent.emitExternalEvent({ type: "message_start", message: createAssistantMessage("latest") });
		await Bun.sleep(MONITOR_LIVE_INTERVAL_MS + 30);
		expect(connection.frames).toHaveLength(0);
		connection.bufferedBytes = 0;
		await Bun.sleep(MONITOR_LIVE_INTERVAL_MS + 30);
		expect(connection.frames).toHaveLength(1);
		expect((connection.frames[0] as { state: TranscriptLiveState }).state.assistant?.content).toEqual([
			{ type: "text", text: "latest" },
		]);
	});
});

describe("monitor chat revival ownership", () => {
	test("a parked subagent revives and receives a trimmed steer without retargeting the owner", async () => {
		const delivered: Array<{ text: string; behavior: string }> = [];
		const target = promptTarget(delivered);
		const revived = Promise.withResolvers<AgentSession>();
		const requested: string[] = [];
		const fixture = serviceFixture(id => {
			requested.push(id);
			return revived.promise;
		});
		const pending = fixture.service.handle(fixture.connection, fixture.grant, {
			type: "monitor_chat",
			text: "  follow up  ",
		});
		expect(requested).toEqual([fixture.sub.id]);
		fixture.sub.session = target;
		fixture.registry.setStatus(fixture.sub.id, "idle", fixture.sub);
		revived.resolve(target);
		expect((await pending).success).toBe(true);
		expect(delivered).toEqual([{ text: "follow up", behavior: "steer" }]);
	});

	for (const change of ["replaced", "aborted", "revoked", "generation", "wrong-session"] as const) {
		test(`revival re-check rejects a ${change} target before prompting`, async () => {
			const delivered: Array<{ text: string; behavior: string }> = [];
			const target = promptTarget(delivered);
			const revived = Promise.withResolvers<AgentSession>();
			const fixture = serviceFixture(() => revived.promise);
			const pending = fixture.service.handle(fixture.connection, fixture.grant, {
				type: "monitor_chat",
				text: "must not send",
			});
			fixture.sub.session = target;
			if (change === "replaced") fixture.registry.register({ ...fixture.sub, session: target, status: "idle" });
			else if (change === "aborted") fixture.registry.setStatus(fixture.sub.id, "aborted", fixture.sub);
			else if (change === "revoked") fixture.service.revoke(fixture.capability);
			else if (change === "generation") fixture.bumpGeneration();
			else fixture.sub.session = promptTarget([]);
			revived.resolve(target);
			const reply = await pending;
			expect(reply.success).toBe(false);
			expect(reply.code).toBe(change === "aborted" ? "read_only" : "monitor_gone");
			expect(delivered).toHaveLength(0);
		});
	}

	test("strict root identity and ancestry invalidate a capability", () => {
		const fixture = serviceFixture(async () => {
			throw new Error("must not revive");
		});
		fixture.registry.register({ ...fixture.root });
		expect(fixture.service.authenticate(fixture.capability)).toBeUndefined();
		const fresh = fixture.service.grant(fixture.sub.id);
		fixture.sub.parentId = "missing-parent";
		expect(fixture.service.authenticate(fresh.capability)).toBeUndefined();
		expect(() => fixture.service.grant(fixture.sub.id)).toThrow("unknown agent");
	});

	test("at the grant cap the oldest unconnected grant makes room; connected ones survive", () => {
		const fixture = serviceFixture(async () => {
			throw new Error("must not revive");
		});
		fixture.service.attach(fixture.connection, fixture.grant);
		const minted = [fixture.capability];
		for (;;) {
			try {
				minted.push(fixture.service.grant(fixture.sub.id).capability);
			} catch (error) {
				throw new Error(`minting stopped after ${minted.length} grants: ${String(error)}`);
			}
			// The first unconnected grant is the second minted; once it is evicted the cap was hit.
			if (!fixture.service.authenticate(minted[1] ?? "")) break;
			if (minted.length > 1_000) throw new Error("grants were never evicted");
		}
		expect(fixture.service.authenticate(fixture.capability)).toBe(fixture.grant);
		expect(fixture.service.authenticate(minted[2] ?? "")).toBeDefined();
		expect(fixture.service.authenticate(minted.at(-1) ?? "")).toBeDefined();
	});
});
