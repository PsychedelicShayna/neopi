import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
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
import { cfgTierAnthropic } from "@oh-my-pi/pi-coding-agent/session/settings";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const AGENT_ID = "ThinkingWorker";

describe("RPC set_subagent_thinking_level", () => {
	let root: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let registry: RpcSubagentRegistry;
	let eventBus: EventBus;
	let handle: (command: RpcCommand) => Promise<RpcResponse>;
	let sessionFile: string;
	let settings: Settings;
	const parentSetThinkingLevel = vi.fn();

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		root = await fs.mkdtemp(path.join(scratch, "subagent-thinking-"));
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

	function setup(
		holdFirstRequest = false,
		capEffort = false,
	): {
		requested: SimpleStreamOptions[];
		started: Promise<void>;
		release: () => void;
	} {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const requested: SimpleStreamOptions[] = [];
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
			initialState: { model, thinkingLevel: ThinkingLevel.Low, systemPrompt: ["Test"], tools: [probe] },
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: (requestedModel, context, options) => {
				requested.push({ ...options });
				return mock.stream(requestedModel, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.toml")),
			thinkingLevel: ThinkingLevel.Low,
			thinkingLevelCeiling: capEffort ? ThinkingLevel.Low : undefined,
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
			session: { setThinkingLevel: parentSetThinkingLevel } as unknown as AgentSession,
			subagentRegistry: registry,
			success: (id, command, data) =>
				({ id, type: "response", command, success: true, ...(data ? { data } : {}) }) as RpcResponse,
			error: (id, command, error) => ({ id, type: "response", command, success: false, error }),
		};
		handle = createRpcCommandHandler(context as RpcCommandHandlerContext);
		return { requested, started: started.promise, release: () => release.resolve() };
	}

	function change(level: unknown = ThinkingLevel.High, subagentId: unknown = AGENT_ID): Promise<RpcResponse> {
		return handle({ id: "change", type: "set_subagent_thinking_level", subagentId, level } as RpcCommand);
	}

	function fast(enabled: unknown, subagentId: unknown = AGENT_ID): Promise<RpcResponse> {
		return handle({ id: "fast", type: "set_subagent_fast", subagentId, enabled } as RpcCommand);
	}

	test("changes the next provider request without aborting the request already streaming", async () => {
		const fixture = setup(true);
		const turn = session.prompt("run the probe");
		await fixture.started;
		try {
			expect(await change()).toEqual({
				id: "change",
				type: "response",
				command: "set_subagent_thinking_level",
				success: true,
			});
			expect(session.isStreaming).toBe(true);
			expect(fixture.requested).toHaveLength(1);
			expect(fixture.requested[0].reasoning).toBe(ThinkingLevel.Low);
			expect(fixture.requested[0].signal?.aborted).toBe(false);
		} finally {
			fixture.release();
			await turn;
		}
		expect(fixture.requested.map(options => options.reasoning)).toEqual([ThinkingLevel.Low, ThinkingLevel.High]);
		expect(parentSetThinkingLevel).not.toHaveBeenCalled();
	});

	test.each(["nonsense", ThinkingLevel.Max, null, 7])(
		"rejects unsupported level %p without changing the session",
		async level => {
			setup();
			const entriesBefore = session.sessionManager.getEntries().length;
			const response = await change(level);
			expect(response.success).toBe(false);
			if (!response.success) expect(response.error).toContain("Available levels:");
			expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
			expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
		},
	);

	test("rejects levels above the session ceiling rather than silently clamping", async () => {
		setup(false, true);
		const response = await change(ThinkingLevel.High);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toContain("Available levels:");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	test("allows off as advertised by thinking-level discovery", async () => {
		setup();
		expect((await change(ThinkingLevel.Off)).success).toBe(true);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
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
		const response = await change(ThinkingLevel.High, id);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toBe(`Subagent not running: ${id}`);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	test.each(["", null, 7])("rejects malformed subagent id %p", async id => {
		setup();
		const response = await change(ThinkingLevel.High, id);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toBe("`subagentId` must be a non-empty string.");
	});

	test("changes only the next request's fast tier without interrupting the current request", async () => {
		const fixture = setup(true);
		const originalSettings = cfgTierAnthropic.get(settings);
		const turn = session.prompt("run the probe");
		await fixture.started;
		try {
			const response = await fast(true);
			expect(response).toEqual({
				id: "fast",
				type: "response",
				command: "set_subagent_fast",
				success: true,
				data: { enabled: true, active: session.isFastModeActive() },
			});
			expect(session.isStreaming).toBe(true);
			expect(session.isFastModeEnabled()).toBe(true);
			expect(fixture.requested).toHaveLength(1);
			expect(fixture.requested[0].serviceTier).toBeUndefined();
			expect(fixture.requested[0].signal?.aborted).toBe(false);
		} finally {
			fixture.release();
			await turn;
		}
		expect(fixture.requested.map(options => options.serviceTier)).toEqual([undefined, "priority"]);
		expect(cfgTierAnthropic.get(settings)).toBe(originalSettings);
		expect((await fast(false)).success).toBe(true);
		expect(session.isFastModeEnabled()).toBe(false);
	});

	test.each(["true", null, 7])("rejects malformed fast enabled %p", async enabled => {
		setup();
		const response = await fast(enabled);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toBe("`enabled` must be a boolean.");
		expect(session.isFastModeEnabled()).toBe(false);
	});

	test("the focused fast control label rereads changes made through RPC", async () => {
		setup();
		const command = BUILTIN_MODE_SLASH_COMMANDS.find(command => command.name === "fast");
		if (!command?.getTuiAutocompleteDescription) throw new Error("Expected fast command label");
		const ctx = {
			focusedAgentId: AGENT_ID,
			viewSession: session,
			session: { isFastModeEnabled: () => false, isUltrafastModeEnabled: () => false },
		} as unknown as InteractiveModeContext;
		expect(command.getTuiAutocompleteDescription({ ctx })).toBe("Fast: off");
		expect((await fast(true)).success).toBe(true);
		expect(command.getTuiAutocompleteDescription({ ctx })).toBe("Fast: on");
	});

	test("rejects fast mode when the child model has no supported service tier", async () => {
		setup();
		session.agent.setModel(createMockModel());
		const response = await fast(true);
		expect(response.success).toBe(false);
		if (!response.success) expect(response.error).toContain("unavailable for the subagent's current model");
		expect(session.serviceTierByFamily).toEqual({});
	});

	test("refuses fast edits on an unknown or accepted subagent", async () => {
		setup();
		const missing = await fast(true, "Missing");
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toBe("Subagent not running: Missing");
		AgentRegistry.global().markResultAccepted(AGENT_ID);
		const accepted = await fast(true);
		expect(accepted.success).toBe(false);
		expect(session.isFastModeEnabled()).toBe(false);
	});
});
