import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const AGENT_ID = "ModelWorker";

function bundled(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled Anthropic model ${id}`);
	return model;
}

describe("RPC set_subagent_model", () => {
	let root: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let handle: (command: RpcCommand) => Promise<RpcResponse>;
	let sessionFile: string;
	let settings: Settings;
	const parentSetModelTemporary = vi.fn();

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		root = await fs.mkdtemp(path.join(scratch, "subagent-model-"));
		sessionFile = path.join(root, `${AGENT_ID}.jsonl`);
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		eventBus = new EventBus();
		registry = new RpcSubagentRegistry(eventBus, () => {});
	});

	afterEach(async () => {
		await session?.dispose();
		registry.dispose();
		authStorage.close();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	function emit(status: SubagentLifecyclePayload["status"] = "started"): void {
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: AGENT_ID,
			runToken: sessionFile,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile,
		} satisfies SubagentLifecyclePayload);
	}

	function setup(holdFirstRequest = false): {
		requestedModels: string[];
		started: Promise<void>;
		release: () => void;
	} {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					started.resolve();
					if (holdFirstRequest) await release.promise;
					return { content: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }] };
				},
				{ content: ["done"] },
			],
		});
		const parameters = type({});
		const probe: AgentTool<typeof parameters, undefined> = {
			name: "probe",
			label: "Probe",
			description: "Continue to the next provider request",
			parameters,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		};
		const agent = new Agent({
			initialState: {
				model: bundled("claude-sonnet-4-5"),
				thinkingLevel: ThinkingLevel.Low,
				systemPrompt: ["Test"],
				tools: [probe],
			},
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(requestedModel.id);
				return mock.stream(requestedModel, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.toml")),
			thinkingLevel: ThinkingLevel.Low,
		});
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			session,
			sessionFile,
			status: "running",
		});
		emit();
		const context: Pick<RpcCommandHandlerContext, "session" | "subagentRegistry" | "success" | "error"> = {
			session: { setModelTemporary: parentSetModelTemporary } as unknown as AgentSession,
			subagentRegistry: registry,
			success: (id, command, data) =>
				({ id, type: "response", command, success: true, ...(data ? { data } : {}) }) as RpcResponse,
			error: (id, command, error) => ({ id, type: "response", command, success: false, error }),
		};
		handle = createRpcCommandHandler(context as RpcCommandHandlerContext);
		return { requestedModels, started: started.promise, release: () => release.resolve() };
	}

	function change(selection: Record<string, unknown>, subagentId: unknown = AGENT_ID): Promise<RpcResponse> {
		return handle({ id: "change", type: "set_subagent_model", subagentId, ...selection } as RpcCommand);
	}

	test("switches the next provider request without aborting the request already streaming", async () => {
		const fixture = setup(true);
		const turn = session.prompt("run the probe");
		await fixture.started;
		try {
			const response = await change({ provider: "anthropic", modelId: "claude-haiku-4-5" });
			expect(response).toEqual({
				id: "change",
				type: "response",
				command: "set_subagent_model",
				success: true,
				data: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: session.thinkingLevel },
			});
			expect(session.isStreaming).toBe(true);
			expect(fixture.requestedModels).toEqual(["claude-sonnet-4-5"]);
		} finally {
			fixture.release();
			await turn;
		}
		expect(fixture.requestedModels).toEqual(["claude-sonnet-4-5", "claude-haiku-4-5"]);
		expect(parentSetModelTemporary).not.toHaveBeenCalled();
	});

	test("resolves a selector like /switch, including its :level suffix, and records a session-only change", async () => {
		setup();
		const response = await change({ selector: "anthropic/claude-opus-4-5:high" });
		if (!response.success || response.command !== "set_subagent_model") throw new Error("Expected success");
		expect(response.data).toMatchObject({
			provider: "anthropic",
			modelId: "claude-opus-4-5",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(session.thinkingLevel).toBe(ThinkingLevel.High);
		const changes = session.sessionManager.getEntries().filter(entry => entry.type === "model_change");
		expect(changes.at(-1)).toMatchObject({ model: "anthropic/claude-opus-4-5", role: "temporary" });
		expect(settings.getModelRole("default")).toBeUndefined();
	});

	test("refuses an unknown selector or model without changing the subagent", async () => {
		setup();
		const selector = await change({ selector: "no-such-model-anywhere" });
		expect(selector.success).toBe(false);
		const exact = await change({ provider: "anthropic", modelId: "no-such-model" });
		expect(exact.success).toBe(false);
		if (!exact.success) expect(exact.error).toBe("Model not found: anthropic/no-such-model");
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	test.each([
		["neither selector nor pair", {}],
		["blank selector", { selector: "  " }],
		["provider without modelId", { provider: "anthropic" }],
		["modelId without provider", { modelId: "claude-haiku-4-5" }],
		["selector with a pair", { selector: "haiku", provider: "anthropic", modelId: "claude-haiku-4-5" }],
		["non-string selector", { selector: 7 }],
	])("rejects %s", async (_name, selection) => {
		setup();
		const response = await change(selection);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toContain("`selector`");
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	test.each(["unknown", "finished", "accepted", "other-owner"])("refuses %s subagents", async kind => {
		setup();
		let id = AGENT_ID;
		if (kind === "unknown") id = "Missing";
		if (kind === "finished") emit("completed");
		if (kind === "accepted") AgentRegistry.global().markResultAccepted(AGENT_ID);
		if (kind === "other-owner") {
			AgentRegistry.global().register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				session,
				sessionFile: path.join(root, "other", `${AGENT_ID}.jsonl`),
				status: "running",
			});
		}
		const response = await change({ provider: "anthropic", modelId: "claude-haiku-4-5" }, id);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toBe(`Subagent not running: ${id}`);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	test.each(["", null, 7])("rejects malformed subagent id %p", async id => {
		setup();
		const response = await change({ selector: "haiku" }, id);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toBe("`subagentId` must be a non-empty string.");
	});

	test("the roster reports the new model once applied", async () => {
		setup();
		await change({ provider: "anthropic", modelId: "claude-haiku-4-5" });
		const [snapshot] = registry.getSubagents();
		expect(snapshot.resolvedModelIdentity).toContain("claude-haiku-4-5");
	});
});
