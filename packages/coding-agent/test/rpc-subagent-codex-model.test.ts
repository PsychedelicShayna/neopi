import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { IrcBus } from "../src/irc/bus";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "../src/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "../src/modes/rpc/rpc-subagents";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import type { AgentSessionHandle } from "../src/session/agent-session-handle";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { RemoteAgentSession } from "../src/thread/remote-agent-session";
import type { ThreadService } from "../src/thread/services";
import { agentsThreadService } from "../src/thread/services/agents";
import { identityThreadService } from "../src/thread/services/identity";
import { SubagentWorker } from "../src/thread/subagent-worker";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";
import type { AgentsProbe, AgentsProbeGlobals } from "./fixtures/agents-bridge-worker";
import { codexModelSwitchAgent, codexTestToken } from "./helpers/codex-model-switch";

const cleanups: Array<() => unknown> = [];
let root: string;

beforeEach(async () => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-model-"));
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await fs.rm(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function transport() {
	const started = Promise.withResolvers<ServerWebSocket<undefined>>();
	const requests: Array<{ socket: ServerWebSocket<undefined>; body: Record<string, unknown> }> = [];
	let closes = 0;
	let sse = 0;
	const send = (socket: ServerWebSocket<undefined>, event: unknown) => socket.send(JSON.stringify(event));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			sse++;
			return new Response("unexpected SSE", { status: 500 });
		},
		websocket: {
			message(socket: ServerWebSocket<undefined>, message) {
				const body = JSON.parse(String(message)) as Record<string, unknown>;
				requests.push({ socket, body });
				if (requests.length === 1) {
					send(socket, { type: "response.created", response: { id: "original" } });
					const item = { type: "function_call", id: "fc_probe", call_id: "probe", name: "probe", arguments: "{}" };
					send(socket, { type: "response.output_item.added", item: { ...item, arguments: "" } });
					send(socket, { type: "response.output_item.done", item });
					started.resolve(socket);
				} else {
					send(socket, {
						type: "response.output_item.added",
						item: { type: "message", id: "msg_target", role: "assistant", content: [] },
					});
					send(socket, { type: "response.content_part.added", part: { type: "output_text", text: "" } });
					send(socket, { type: "response.output_text.delta", delta: "target completed" });
					send(socket, {
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_target",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "target completed" }],
						},
					});
					complete(socket);
				}
			},
			close() {
				closes++;
			},
		},
	});
	function complete(socket: ServerWebSocket<undefined>) {
		send(socket, {
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
		});
	}
	cleanups.push(() => server.stop(true));
	return {
		started: started.promise,
		requests,
		complete,
		url: `http://127.0.0.1:${server.port}`,
		closes: () => closes,
		sse: () => sse,
	};
}

async function setup(home: "direct" | "worker", url: string) {
	const auth = await AuthStorage.create(":memory:");
	cleanups.push(() => auth.close());
	auth.keys.setRuntime("anthropic", "test-key");
	const modelsPath = path.join(root, "models.yml");
	const models = ["original", "target"].map(id => ({
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 1024,
		preferWebsockets: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: Object.fromEntries(
				["codex-fixture", "codex-sibling"].map(provider => [
					provider,
					{ api: "openai-codex-responses", apiKey: codexTestToken, baseUrl: url, models },
				]),
			),
		}),
	);
	const catalog = new ModelRegistry(auth, modelsPath);
	const model = catalog.find("codex-fixture", "original");
	if (!model) throw new Error("fixture model missing");
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
	const sessionFile = path.join(root, "Worker.jsonl");
	let session: AgentSessionHandle;
	if (home === "worker") {
		const received = Promise.withResolvers<AgentsProbe>();
		const service: ThreadService = {
			name: "agents-probe",
			globals: (): AgentsProbeGlobals => ({ ready: received.resolve }),
		};
		const worker = new SubagentWorker({
			entry: new URL("./fixtures/agents-bridge-worker.ts", import.meta.url),
			services: [identityThreadService, agentsThreadService, service],
			initTimeoutMs: 60_000,
		});
		cleanups.push(() => worker.terminate("test end"));
		const [, probe] = await Promise.all([worker.ready, received.promise]);
		await probe.open("Worker", {
			codexModel: model,
			modelsPath,
			sessionFile,
			settings: { "compaction.enabled": false, "retry.enabled": false },
			runtimeApiKeys: { anthropic: "test-key" },
		});
		const remote = AgentRegistry.global().get("Worker")?.session;
		if (!(remote instanceof RemoteAgentSession)) throw new Error("expected real worker-homed session");
		session = remote;
	} else {
		const local = new AgentSession({
			agent: codexModelSwitchAgent(model),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: catalog,
		});
		cleanups.push(() => local.dispose());
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			session: local,
			sessionFile,
			status: "running",
		});
		session = local;
	}
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	cleanups.push(() => registry.dispose());
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "Worker",
		runToken: sessionFile,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile,
	});
	const parent = {
		setModelTemporary: () => {
			throw new Error("parent must not change");
		},
	};
	const context: Pick<RpcCommandHandlerContext, "session" | "subagentRegistry" | "success" | "error"> = {
		session: parent as unknown as AgentSession,
		subagentRegistry: registry,
		success: (id, command, data) =>
			({ id, type: "response", command, success: true, ...(data ? { data } : {}) }) as RpcResponse,
		error: (id, command, error) => ({ id, type: "response", command, success: false, error }),
	};
	return { session, handle: createRpcCommandHandler(context as RpcCommandHandlerContext), settings };
}

describe("next-request Codex subagent model selection", () => {
	for (const home of ["direct", "worker"] as const) {
		test.each([
			["codex-fixture", "target"],
			["codex-sibling", "target"],
			["anthropic", "claude-haiku-4-5"],
		])(
			`${home}: %s/%s leaves the active socket alive through a completed tool call`,
			async (provider, modelId) => {
				const wire = transport();
				const { session, handle, settings } = await setup(home, wire.url);
				const toolDone = Promise.withResolvers<void>();
				cleanups.push(
					session.subscribe(event => {
						if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end")
							toolDone.resolve();
					}),
				);
				const turn = session.prompt("run the probe");
				const socket = await wire.started;
				await toolDone.promise;
				try {
					const response = await handle({
						id: "switch",
						type: "set_subagent_model",
						subagentId: "Worker",
						provider,
						modelId,
					} as RpcCommand);
					expect(response.success).toBe(true);
					expect(session.model?.id).toBe(modelId);
					expect(wire.closes()).toBe(0);
					expect(wire.requests.map(request => request.body.model)).toEqual(["original"]);
					expect(wire.sse()).toBe(0);
				} finally {
					wire.complete(socket);
					await turn;
				}
				await waitFor(() => !session.isStreaming && wire.closes() >= 1);
				expect(
					session.messages.filter(message => message.role === "assistant").map(message => message.stopReason),
				).not.toContain("error");
				expect(
					session.messages.some(
						message =>
							message.role === "assistant" && message.model === "original" && message.stopReason === "toolUse",
					),
				).toBe(true);
				expect(session.messages.some(message => message.role === "assistant" && message.model === modelId)).toBe(
					true,
				);
				expect(wire.sse()).toBe(0);
				if (provider !== "anthropic") {
					expect(wire.requests.map(request => request.body.model)).toEqual(["original", "target"]);
					expect(wire.requests[1]?.socket).not.toBe(socket);
					expect(wire.requests[1]?.body.previous_response_id).toBeUndefined();
				}
				expect(settings.getModelRole("default")).toBeUndefined();
			},
			60_000,
		);
	}
	test("an idle model selection closes the old socket promptly", async () => {
		const wire = transport();
		const { session, handle } = await setup("direct", wire.url);
		const turn = session.prompt("run the probe");
		wire.complete(await wire.started);
		await turn;
		expect(wire.closes()).toBe(0);
		expect(
			await handle({
				type: "set_subagent_model",
				subagentId: "Worker",
				provider: "codex-fixture",
				modelId: "target",
			}),
		).toMatchObject({ success: true });
		await waitFor(() => wire.closes() === 1);
	});

	test.each([
		["abort", false],
		["abort", true],
		["dispose", false],
		["dispose", true],
	] as const)("%s still closes an active request (retired: %p)", async (operation, retired) => {
		const wire = transport();
		const { session, handle } = await setup("direct", wire.url);
		const turn = session.prompt("run the probe");
		await wire.started;
		if (retired) {
			expect(
				await handle({
					type: "set_subagent_model",
					subagentId: "Worker",
					provider: "codex-fixture",
					modelId: "target",
				}),
			).toMatchObject({ success: true });
		}
		if (operation === "abort") await session.abort();
		else await session.dispose();
		await turn;
		await waitFor(() => wire.closes() === 1);
		expect(wire.requests).toHaveLength(1);
		expect(wire.sse()).toBe(0);
	});
});
