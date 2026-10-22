/**
 * Control host behavior over a real socket, against a real session on a mock
 * model (no network). A consumer sees: approval ownership stays with the pane,
 * a session replaced outside RPC bumps generation and republishes the
 * registry, large commands are accepted, `serve` answers once and leaves no
 * half-installed service, and every declared control-only command routes.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { runSubagentFastCommand } from "../../src/registry/subagent-controls";
import { InputController } from "../../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { RpcSubagentSnapshot } from "../../src/modes/rpc/rpc-types";
import { RpcSessionEventForwarder } from "../../src/modes/rpc/rpc-session-events";
import type { RpcProjectedSessionEventFrame } from "../../src/modes/rpc/rpc-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ctlList, ctlState, withCtlCaller, withCtlIo } from "../../src/cli/ctl-cli";
import { ControlClient } from "../../src/control/client";
import type { ControlPresenter } from "../../src/control/presenter";
import { ControlHost } from "../../src/control/host";
import { type ControlMetadata, readControlEntries } from "../../src/control/registry";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { AgentSession } from "../../src/session/agent-session";
import type { CustomMessage } from "../../src/session/messages";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";
import type { ControlSnapshot } from "../../src/control/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { makeAssistantMessage } from "../session-manager/helpers";

describe("control host", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let host: ControlHost | undefined;
	let client: ControlClient | undefined;
	let dir: string;
	/** Extra sessions and clients a test opened beyond the primary pair. */
	const extraSessions: AgentSession[] = [];
	const extraClients: ControlClient[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-control-host-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		for (const extra of extraClients.splice(0)) extra.close();
		client?.close();
		client = undefined;
		await host?.close();
		host = undefined;
		await session?.dispose();
		session = undefined;
		for (const extra of extraSessions.splice(0)) await extra.dispose();
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function createSession(
		settings: Record<string, unknown> = {},
		manager = SessionManager.inMemory(tempDir.path()),
	): AgentSession {
		const model = createMockModel({ provider: "anthropic", responses: [] });
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: [], tools: [] },
				streamFn: model.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, ...settings }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
	}

	async function start(
		settings: Record<string, unknown> = {},
		options: { subagentEventBus?: EventBus } = {},
	): Promise<{ host: ControlHost; client: ControlClient; hello: ControlSnapshot }> {
		session = createSession(settings);
		dir = mkdtempSync(join(tmpdir(), "omp-ctl-host-"));
		host = new ControlHost({ session, role: "rpc", dir, tmuxPane: null, ...options });
		await host.start();
		const publication = host.publication;
		if (!publication) throw new Error("control host did not publish");
		client = new ControlClient({ metadata: publication.metadata(), label: "test", kind: "cli" });
		const hello = await client.connect();
		return { host, client, hello };
	}

	/** A second connection to the running host. */
	async function connectAnother(label: string): Promise<ControlClient> {
		const publication = host?.publication;
		if (!publication) throw new Error("control host did not publish");
		const extra = new ControlClient({ metadata: publication.metadata(), label, kind: "cli" });
		extraClients.push(extra);
		await extra.connect();
		return extra;
	}

	function emitStarted(bus: EventBus, id: string): void {
		const sessionFile = join(tempDir.path(), `${id}.jsonl`);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			runToken: `${sessionFile}:${id}`,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	test("hello and state carry the root session's RPC state, without the dump fields", async () => {
		const { client, hello } = await start();
		expect(hello.session?.sessionId).toBe(session!.sessionId);
		const state = (await client.request({ type: "state" })).data as ControlSnapshot;
		expect(state.session?.sessionId).toBe(session!.sessionId);
		expect(state.session?.model?.provider).toBe("anthropic");
		expect(state.session?.mode).toBe("default");
		expect(state.session?.systemPrompt).toBeUndefined();
		expect(state.session?.dumpTools).toBeUndefined();
		expect(state.root).toBeUndefined();
	});

	test("first follow-up warns without dropping the message, then respects each connection's choice", async () => {
		const { client } = await start();
		const empty = await client.request({ type: "follow_up", message: "" });
		expect(empty.success).toBe(true);
		expect(empty.warning).toBeUndefined();
		const first = await client.request({ type: "follow_up", message: "first queued message" });
		expect(first.success).toBe(true);
		expect(first.warning).toContain("very likely never reach this agent");
		expect(first.warning).toContain("`steer`");
		expect(session!.getQueuedMessages().followUp).toEqual(["first queued message"]);

		const second = await client.request({ type: "follow_up", message: "second queued message" });
		expect(second.success).toBe(true);
		expect(second.warning).toBeUndefined();

		const other = await connectAnother("another client");
		const independent = await other.request({ type: "follow_up", message: "other client's message" });
		expect(independent.success).toBe(true);
		expect(independent.warning).toBe(first.warning);
		expect(session!.getQueuedMessages().followUp).toEqual([
			"first queued message",
			"second queued message",
			"other client's message",
		]);
	});

	test("a bound calling session keeps its first-use warning across ctl reconnections", async () => {
		const { host } = await start();
		const callerSession = createSession();
		extraSessions.push(callerSession);
		const callerHost = new ControlHost({ session: callerSession, role: "rpc", dir, tmuxPane: null });
		await callerHost.start();
		try {
			const target = host.publication!.metadata();
			const caller = callerHost.publication!.metadata();
			const connect = async () => {
				const connection = new ControlClient({
					metadata: target,
					label: "ctl",
					kind: "tool",
					caller: { instanceId: caller.instanceId, token: caller.token },
				});
				extraClients.push(connection);
				await connection.connect();
				return connection;
			};
			const first = await connect();
			expect((await first.request({ type: "follow_up", message: "first" })).warning).toBeString();
			first.close();
			const reconnected = await connect();
			const second = await reconnected.request({ type: "follow_up", message: "second" });
			expect(second.success).toBe(true);
			expect(second.warning).toBeUndefined();
			expect(session!.getQueuedMessages().followUp).toEqual(["first", "second"]);
		} finally {
			await callerHost.close();
		}
	});

	test("target view reports the focused subagent's session and names the root; root ignores the focus", async () => {
		const { host, client } = await start();
		const viewed = createSession();
		extraSessions.push(viewed);
		host.presenter = {
			...stubPresenter({ approvalOpen: false }).presenter,
			viewTarget: () => ({ agentId: "Viewed", session: viewed }),
		};
		const view = (await client.request({ type: "state", target: "view" })).data as ControlSnapshot;
		expect(view.session?.sessionId).toBe(viewed.sessionId);
		expect(view.root).toEqual({ sessionId: session!.sessionId, generation: 1 });
		expect(view.view?.focusedAgent).toBe("Viewed");
		const root = (await client.request({ type: "get_status" })).data as ControlSnapshot;
		expect(root.session?.sessionId).toBe(session!.sessionId);
		expect(root.root).toBeUndefined();
	});

	test("target view falls back to the root session while nothing is focused", async () => {
		const { host, client } = await start();
		host.presenter = { ...stubPresenter({ approvalOpen: false }).presenter, viewTarget: () => undefined };
		const view = (await client.request({ type: "state", target: "view" })).data as ControlSnapshot;
		expect(view.session?.sessionId).toBe(session!.sessionId);
		expect(view.view?.focusedAgent).toBeNull();
	});

	test("a connection opened after a subagent started still lists it", async () => {
		const bus = new EventBus();
		await start({}, { subagentEventBus: bus });
		emitStarted(bus, "EarlySub");
		const late = await connectAnother("late");
		const reply = await late.request({ type: "get_subagents" });
		expect(reply.success).toBe(true);
		expect((reply.data as { subagents: { id: string }[] }).subagents.map(subagent => subagent.id)).toEqual([
			"EarlySub",
		]);
	});

	test("roundtrips selected-agent effort and fast edits between control and focused view", async () => {
		const bus = new EventBus();
		const { client } = await start({}, { subagentEventBus: bus });
		const child = createSession();
		const sibling = createSession();
		extraSessions.push(child, sibling);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		await child.setModelTemporary(model, ThinkingLevel.Low);
		await sibling.setModelTemporary(model, ThinkingLevel.Low);
		const parentLevel = session!.thinkingLevel;
		const id = "ThinkingSub";
		const ref = AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session: child,
			sessionFile: join(tempDir.path(), `${id}.jsonl`),
			status: "running",
		});
		try {
			emitStarted(bus, id);
			const reply = await client.request({
				type: "set_subagent_thinking_level",
				subagentId: id,
				level: ThinkingLevel.High,
			});
			expect(reply.success).toBe(true);
			expect(child.thinkingLevel).toBe(ThinkingLevel.High);
			expect(session!.thinkingLevel).toBe(parentLevel);
			const enabled = await client.request({ type: "set_subagent_fast", subagentId: id, enabled: true });
			expect(enabled.success).toBe(true);
			expect(enabled.data).toEqual({ enabled: true, active: child.isFastModeActive() });
			const list = async () => {
				const reply = await client.request({ type: "get_subagents" });
				return (reply.data as { subagents: RpcSubagentSnapshot[] }).subagents.find(agent => agent.id === id);
			};
			expect(await list()).toMatchObject({
				resolvedModelIdentity: `${model.provider}/${model.id}`,
				resolvedThinkingLevel: ThinkingLevel.High,
				fastModeEnabled: true,
				fastModeActive: child.isFastModeActive(),
			});
			// The focused view uses these same session controls, not the root session.
			const focused = {
				session,
				viewSession: child,
				focusedAgentId: id,
				statusLine: { invalidate() {} },
				updateEditorBorderColor() {},
				showStatus() {},
			} as unknown as InteractiveModeContext;
			new InputController(focused).cycleThinkingLevel();
			runSubagentFastCommand(child, "off");
			expect(child.thinkingLevel).not.toBe(ThinkingLevel.High);
			expect(await list()).toMatchObject({
				resolvedThinkingLevel: child.thinkingLevel,
				fastModeEnabled: false,
				fastModeActive: false,
			});
			expect(session!.thinkingLevel).toBe(parentLevel);
			expect(session!.isFastModeEnabled()).toBe(false);
			expect(sibling.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(sibling.isFastModeEnabled()).toBe(false);
			const missing = await client.request({
				type: "set_subagent_thinking_level",
				subagentId: "Missing",
				level: ThinkingLevel.High,
			});
			expect(missing.success).toBe(false);
			expect(missing.error).toContain("Subagent not running: Missing");
		} finally {
			AgentRegistry.global().unregister(ref.id);
		}
	});

	test("subagent frames reach only connections that subscribed, at their own level", async () => {
		const bus = new EventBus();
		const { client: watcher } = await start({}, { subagentEventBus: bus });
		const quiet = await connectAnother("quiet");
		const watched: unknown[] = [];
		const heard: unknown[] = [];
		watcher.onEvent(frame => watched.push(frame.type));
		quiet.onEvent(frame => heard.push(frame.type));
		const subscribed = await watcher.request({ type: "set_subagent_subscription", level: "progress" });
		expect(subscribed.data).toEqual({ level: "progress" });
		emitStarted(bus, "StreamedSub");
		// Host writes are ordered per socket, so a round trip flushes any frame emitted before it.
		await watcher.request({ type: "get_status" });
		await quiet.request({ type: "get_status" });
		expect(watched).toContain("subagent_lifecycle");
		expect(heard).not.toContain("subagent_lifecycle");

		// Unsubscribing one connection stops its stream without disturbing another's.
		await quiet.request({ type: "set_subagent_subscription", level: "progress" });
		await watcher.request({ type: "set_subagent_subscription", level: "off" });
		watched.length = 0;
		emitStarted(bus, "LaterSub");
		await watcher.request({ type: "get_status" });
		await quiet.request({ type: "get_status" });
		expect(watched).not.toContain("subagent_lifecycle");
		expect(heard).toContain("subagent_lifecycle");
	});

	test("set_approval_handler and tool_approval_response stay with the pane while control.approvals is off", async () => {
		const { client } = await start();
		const handler = await client.request({ type: "set_approval_handler", handler: "host" });
		expect(handler.success).toBe(false);
		expect(handler.code).toBe("approval_owner_only");
		const verdict = await client.request({ type: "tool_approval_response", id: "t1", approved: true });
		expect(verdict.success).toBe(false);
		expect(verdict.code).toBe("approval_owner_only");
	});

	test("credential settings are unreadable over control while control.secretInput is off", async () => {
		const { client } = await start({ "auth.broker.token": "hunter2" });
		const reply = await client.request({ type: "settings_get", path: "auth.broker.token" });
		expect(reply.success).toBe(false);
		expect(reply.code).toBe("secret_input_disabled");
		expect(JSON.stringify(reply)).not.toContain("hunter2");
	});

	test("a session replaced outside RPC bumps generation and republishes its registry entry", async () => {
		const { host } = await start();
		const before = session!.sessionId;
		expect(host.revisions.generation).toBe(1);
		await session!.newSession();
		expect(session!.sessionId).not.toBe(before);
		expect(host.revisions.generation).toBe(2);
		const [entry] = await readControlEntries({ dir });
		expect(entry?.meta.sessionId).toBe(session!.sessionId);
	});

	test("quiet terminal output is snapshotted on attachment and keeps its ID through persistence", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.join("attached-journal"));
		await manager.ensureOnDisk();
		session = createSession({}, manager);
		dir = tempDir.join("attached-control");
		host = new ControlHost({ session, role: "tui", dir, tmuxPane: null });
		await host.start();
		const publication = host.publication;
		if (!publication) throw new Error("control host did not publish");
		const stdioFrames: RpcProjectedSessionEventFrame[] = [];
		const stdio = new RpcSessionEventForwarder(frame => stdioFrames.push(frame));
		const stopStdio = session.subscribe(event => stdio.forward(event));
		stdio.observeJournal(session);
		const message = makeAssistantMessage();
		message.content = [{ type: "text", text: "quiet in-flight output" }];
		session.agent.emitExternalEvent({ type: "message_start", message });
		const aside: CustomMessage = {
			role: "custom",
			customType: "snapshot-aside",
			content: "external card",
			display: false,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_start", message: aside });
		session.agent.emitExternalEvent({ type: "message_end", message: aside });
		expect(session.agent.state.streamMessage).toBe(message);
		expect(session.agent.state.messages).toContain(aside);
		const frames: Record<string, unknown>[] = [];
		const persisted = Promise.withResolvers<Record<string, unknown>>();
		client = new ControlClient({
			metadata: publication.metadata(),
			label: "journal-reader",
			kind: "cli",
			onFrame: frame => {
				frames.push(frame);
				if (frame.type === "message_persisted") persisted.resolve(frame);
			},
		});
		await client.connect();
		await client.request({ type: "subscribe", events: "all" });
		expect(frames.find(frame => frame.type === "journal_state")).toEqual({
			type: "journal_state",
			reason: "snapshot",
			...manager.getJournalIdentity(),
		});
		expect(frames.find(frame => frame.type === "message_start" && frame.snapshot === true)).toMatchObject({
			messageId: "msg-1",
			message,
			...manager.getJournalIdentity(),
		});
		const snapshot = await client.request({ type: "snapshot_session_journal" });
		expect(snapshot).toMatchObject({ success: true, data: manager.getJournalIdentity() });
		expect(frames.filter(frame => frame.type === "message_start").map(frame => frame.messageId)).toEqual([
			"msg-1",
			"msg-1",
		]);
		message.content = [{ type: "text", text: "quiet in-flight output, completed" }];
		session.agent.emitExternalEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ", completed", partial: message },
		});
		expect(session.agent.state.streamMessage).toBe(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		expect(session.agent.state.streamMessage).toBeNull();
		expect(session.agent.state.messages).toContain(message);
		expect(session.agent.state.messages).toContain(aside);
		const receipt = await persisted.promise;
		expect(receipt).toMatchObject({ type: "message_persisted", messageId: "msg-1", ...manager.getJournalIdentity() });
		expect(stdioFrames.find(frame => frame.type === "message_start")).toMatchObject({ messageId: receipt.messageId });
		expect(
			stdioFrames.find(frame => frame.type === "message_persisted" && frame.entryId === receipt.entryId),
		).toMatchObject({
			messageId: receipt.messageId,
			entryId: receipt.entryId,
		});
		expect(manager.isEntryDurable(String(receipt.entryId))).toBe(true);
		expect(
			frames.find(frame => frame.type === "journal_entry" && (frame.entry as { id: string }).id === receipt.entryId),
		).toMatchObject({
			sessionId: manager.getSessionId(),
			sessionFile: manager.getJournalIdentity().sessionFile,
			entry: { id: receipt.entryId, type: "message" },
		});
		manager.resetLeaf();
		await client.request({ type: "get_entries" });
		expect(frames).toContainEqual({ type: "journal_state", reason: "leaf", ...manager.getJournalIdentity() });
		await session.newSession();
		await client.request({ type: "get_state" });
		const identity = manager.getJournalIdentity();
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "journal_state",
				reason: "identity",
				sessionId: identity.sessionId,
				sessionFile: identity.sessionFile,
			}),
		);
		expect(frames.findLast(frame => frame.type === "journal_state")).toMatchObject(identity);
		stopStdio();
		stdio.dispose();
	});

	test("a command larger than one physical frame is chunked and accepted, not rate limited", async () => {
		const { client } = await start();
		const pad = "x".repeat(6 * 1024 * 1024);
		const status = await client.request({ type: "get_status", pad });
		expect(status.success).toBe(true);
	});

	test("serve answers once, and a bad scheme leaves no host tool installed", async () => {
		const { client } = await start();
		const responses: Record<string, unknown>[] = [];
		client.onEvent(frame => {
			if (frame.type === "response") responses.push(frame);
		});
		const served = await client.request({
			type: "serve",
			tools: [{ name: "ctl_echo", description: "echo", parameters: { type: "object", properties: {} } }],
			schemes: [{ scheme: "not a scheme" }],
		});
		await Bun.sleep(50);
		expect(served.success).toBe(false);
		expect(responses).toHaveLength(0);
		expect(session!.hasRpcHostTool("ctl_echo")).toBe(false);
	});

	test("unserve removes the URI schemes the service installed", async () => {
		const { client } = await start();
		const served = await client.request({ type: "serve", schemes: [{ scheme: "ctltest" }] });
		expect(served.success).toBe(true);
		expect(InternalUrlRouter.instance().getHandler("ctltest")).toBeDefined();
		const removed = await client.request({
			type: "unserve",
			serviceId: (served.data as { serviceId: string }).serviceId,
		});
		expect(removed.success).toBe(true);
		expect(InternalUrlRouter.instance().getHandler("ctltest")).toBeUndefined();
	});

	test("every declared control-only command routes to an implementation", async () => {
		const { client } = await start();
		const replies = await Promise.all([
			client.request({ type: "switch_model", selector: "no-such-model-anywhere" }),
			client.request({ type: "dequeue" }),
			client.request({ type: "requests" }),
			client.request({ type: "rewind", entryId: "missing-entry" }),
			client.request({ type: "draft_insert", text: "x", if: { draft: 0 } }),
		]);
		for (const reply of replies) expect(reply.error ?? "").not.toContain("Unknown command");
		expect(replies.map(reply => reply.code)).toEqual([
			"unknown_model",
			"empty_queue",
			undefined,
			"rewind_invalid",
			"no_tui",
		]);
		expect(replies[2]?.data).toEqual({ open: [], settled: [] });
	});

	/** A presenter that records what reached the pane; `approvalOpen` mimics the approval selector. */
	function stubPresenter(state: { approvalOpen: boolean }) {
		const seen = {
			injected: [] as string[],
			submitted: [] as { text: string; images?: ImageContent[] }[],
			drafts: [] as { text: string; images?: ImageContent[] }[],
		};
		const presenter: ControlPresenter = {
			submit: async (text, images) => {
				seen.submitted.push({ text, images });
				return { delivery: "started" };
			},
			action: async () => ({ handled: true }),
			inject: bytes => seen.injected.push(bytes),
			esc: async () => ({ handled: true }),
			screen: () => ({ lines: [] }),
			dialogs: () =>
				state.approvalOpen
					? [{ dialogId: "d1", family: "approval", kind: "approval", title: "Approve bash?" } as never]
					: [],
			answerDialog: async () => ({ settled: false }),
			draft: () => ({ text: "", images: [] }),
			setDraft: (text, images) => seen.drafts.push({ text, images }),
			insertDraft: () => {},
			rewind: async () => ({ status: "rewound" }),
			notify: () => {},
			draftRevision: () => 0,
			focusRevision: () => 0,
			dialogRevision: () => 0,
		};
		return { presenter, seen };
	}

	test("keys, paste, mouse, and actions cannot answer an open approval while control.approvals is off", async () => {
		const { host, client } = await start();
		const state = { approvalOpen: true };
		const { presenter, seen } = stubPresenter(state);
		host.presenter = presenter;
		const replies = await Promise.all([
			client.request({ type: "keys", keys: [{ key: "enter" }] }),
			client.request({ type: "paste", text: "y" }),
			client.request({ type: "mouse", x: 1, y: 1 }),
			client.request({ type: "action", actionId: "tui.select.confirm" }),
		]);
		expect(replies.map(reply => reply.code)).toEqual([
			"approval_owner_only",
			"approval_owner_only",
			"approval_owner_only",
			"approval_owner_only",
		]);
		expect(seen.injected).toEqual([]);
		state.approvalOpen = false;
		const keys = await client.request({ type: "keys", keys: [{ key: "enter" }] });
		expect(keys.success).toBe(true);
		expect(seen.injected).toHaveLength(1);
	});

	test("a ctl tool call stays bound to its caller while an overlapping call finishes", async () => {
		const { host } = await start();
		const previous = process.env.PI_CONTROL_DIR;
		process.env.PI_CONTROL_DIR = dir;
		try {
			const quick = withCtlCaller(async () => {});
			const slow = withCtlCaller(async () => {
				await Bun.sleep(20);
				return withCtlIo({ stdout: () => {}, stderr: () => {} }, () => ctlState(host.instanceId, true));
			});
			await quick;
			// Bound to this host's own publication, the target is itself: self-target is refused.
			await expect(slow).rejects.toMatchObject({ code: "self_target" });
		} finally {
			if (previous === undefined) delete process.env.PI_CONTROL_DIR;
			else process.env.PI_CONTROL_DIR = previous;
		}
	});

	test("draft writes need a numeric if.draft, and draft_set and input keep their images", async () => {
		const { host, client } = await start();
		const { presenter, seen } = stubPresenter({ approvalOpen: false });
		host.presenter = presenter;
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const unguarded = await client.request({ type: "draft_set", text: "overwrite", if: {} });
		expect(unguarded.code).toBe("precondition_required");
		expect(seen.drafts).toEqual([]);
		const guarded = await client.request({ type: "draft_set", text: "restored", images: [image], if: { draft: 0 } });
		expect(guarded.success).toBe(true);
		expect(seen.drafts).toEqual([{ text: "restored", images: [image] }]);
		await client.request({ type: "input", text: "look", images: [image] });
		expect(seen.submitted).toEqual([{ text: "look", images: [image] }]);
	});
});

describe("control client handshake", () => {
	test("a server that never challenges times out and the client closes its socket", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ctl-silent-"));
		const endpoint = join(dir, "silent.sock");
		const closed = Promise.withResolvers<void>();
		const server = net.createServer(socket => socket.once("close", () => closed.resolve()));
		await new Promise<void>(resolve => server.listen(endpoint, resolve));
		try {
			const client = new ControlClient({
				metadata: { instanceId: "silentsilent", endpoint, token: "t" } as ControlMetadata,
				label: "test",
				kind: "cli",
				timeoutMs: 100,
			});
			await expect(client.connect()).rejects.toMatchObject({ code: "timeout" });
			await closed.promise;
		} finally {
			server.close();
		}
	});
});

describe("ctl tool request scope", () => {
	test("overlapping ctl calls keep their own output sink", async () => {
		const previous = process.env.PI_CONTROL_DIR;
		process.env.PI_CONTROL_DIR = mkdtempSync(join(tmpdir(), "omp-ctl-io-"));
		try {
			let a = "";
			let b = "";
			const first = withCtlIo({ stdout: text => (a += text), stderr: () => {} }, async () => {});
			const second = withCtlIo({ stdout: text => (b += text), stderr: () => {} }, async () => {
				await Bun.sleep(20);
				await ctlList(true);
			});
			await Promise.all([first, second]);
			expect(a).toBe("");
			expect(JSON.parse(b)).toEqual({ version: 1, sessions: [] });
		} finally {
			if (previous === undefined) delete process.env.PI_CONTROL_DIR;
			else process.env.PI_CONTROL_DIR = previous;
		}
	});
});
