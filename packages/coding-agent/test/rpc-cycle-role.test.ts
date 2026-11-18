/**
 * Issue #666: `cycle_role` is Ctrl+P role cycling over RPC, and `get_roles` reports the `cycleOrder` it walks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgCycleOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcRoles } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-roles";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ROLES = {
	default: "anthropic/claude-sonnet-4-5",
	smol: "anthropic/claude-haiku-4-5:low",
	ghost: "nowhere/nothing",
	reviewer: "anthropic/claude-opus-4-5",
};

function modelKey(model: Model | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

describe("cycle_role", () => {
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let roles: RpcRoles;
	let frames: object[];
	let handle: (command: RpcCommand) => Promise<RpcResponse>;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		settings = Settings.isolated({ modelRoles: ROLES, cycleOrder: ["smol", "ghost", "default", "reviewer"] });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		roles = new RpcRoles(session);
		frames = [];
		const context: Pick<RpcCommandHandlerContext, "session" | "rpcRoles" | "output" | "success" | "error"> = {
			session,
			rpcRoles: roles,
			output: frame => void frames.push(frame),
			success: (id, command, data) =>
				({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}) }) as RpcResponse,
			error: (id, command, error, code) =>
				({ id, type: "response", command, success: false, error, ...(code ? { code } : {}) }) as RpcResponse,
		};
		handle = createRpcCommandHandler(context as RpcCommandHandlerContext);
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
	});

	function cycle(direction?: unknown): Promise<RpcResponse> {
		return handle({ id: "c", type: "cycle_role", ...(direction === undefined ? {} : { direction }) } as RpcCommand);
	}

	test("get_roles reports the configured cycle order", () => {
		expect(roles.list().cycleOrder).toEqual(["smol", "ghost", "default", "reviewer"]);
	});

	test("walks the cycle order forward, skipping roles without an available model, and wraps", async () => {
		// Active model is the `default` slot; `ghost` resolves to nothing and is not a stop.
		const first = await roles.cycle("forward");
		expect(first).toMatchObject({ role: "reviewer", thinkingLevel: session.thinkingLevel });
		expect(modelKey(session.model)).toBe("anthropic/claude-opus-4-5");

		const wrapped = await roles.cycle("forward");
		expect(wrapped).toMatchObject({ role: "smol", thinkingLevel: ThinkingLevel.Low });
		expect(modelKey(session.model)).toBe("anthropic/claude-haiku-4-5");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	test("backward is the reverse walk", async () => {
		expect(await roles.cycle("backward")).toMatchObject({ role: "smol" });
		expect(await roles.cycle("backward")).toMatchObject({ role: "reviewer" });
		expect(await roles.cycle("backward")).toMatchObject({ role: "default" });
		expect(modelKey(session.model)).toBe("anthropic/claude-sonnet-4-5");
	});

	test("the cycled role becomes the active role", async () => {
		await roles.cycle("forward");
		expect(roles.activeRole()).toBe("reviewer");
		expect(roles.list().activeRole).toBe("reviewer");
	});

	test("returns null and changes nothing when fewer than two role models are available", async () => {
		cfgCycleOrder.override(settings, ["ghost", "reviewer"]);
		const before = session.model;
		expect(await roles.cycle("forward")).toBeNull();
		expect(session.model).toBe(before);
	});

	test("the command defaults to forward, answers with the role result, and announces the new model", async () => {
		const response = await cycle();
		expect(response).toMatchObject({
			id: "c",
			type: "response",
			command: "cycle_role",
			success: true,
			data: { role: "reviewer" },
		});
		expect(frames).toEqual([{ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel }]);
		const back = await cycle("backward");
		expect(back).toMatchObject({ success: true, data: { role: "default" } });
	});

	test("the command answers null without announcing when there is nothing to cycle to", async () => {
		cfgCycleOrder.override(settings, ["default"]);
		const response = await cycle("forward");
		expect(response).toEqual({ id: "c", type: "response", command: "cycle_role", success: true, data: null });
		expect(frames).toEqual([]);
	});

	test.each(["sideways", 1, null])("rejects direction %p", async direction => {
		const before = session.model;
		const response = await cycle(direction);
		expect(response.success).toBe(false);
		expect(session.model).toBe(before);
	});
});
