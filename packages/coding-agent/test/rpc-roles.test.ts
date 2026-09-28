/**
 * Issue #104: `get_roles` / `set_role` expose model roles to RPC hosts, and
 * `get_state.activeRole` reports the role the current model was selected
 * through.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveConfiguredModelPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { KIND_ROLE_IDS, MODEL_ROLE_IDS, MODEL_ROLES } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcRoles } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-roles";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { RpcChild, type RpcFrame } from "./helpers/rpc-child";

const MODEL_ROLES_CONFIG = {
	default: "anthropic/claude-sonnet-4-5",
	smol: "anthropic/claude-haiku-4-5:low",
	ghost: "nowhere/nothing",
	reviewer: "anthropic/claude-opus-4-5",
};

function modelKey(model: Model | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

describe("RpcRoles", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let session: AgentSession;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		settings = Settings.isolated({ modelRoles: MODEL_ROLES_CONFIG });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
	});

	test("lists built-ins in role-id order, then configured extras, each with its pattern chain", () => {
		const { roles } = new RpcRoles(session).list();
		const builtins = MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role].hidden);

		expect(roles.map(role => role.id)).toEqual([...builtins, "ghost", "reviewer"]);
		for (const role of roles) {
			const builtin = builtins.some(id => id === role.id);
			expect(role.source).toBe(builtin ? "builtin" : "configured");
			expect(role.alias).toBe(`@${role.id}`);
			expect(role.section).toBe(KIND_ROLE_IDS.some(id => id === role.id) ? "kind" : "chat");
			expect(role.patterns).toEqual(resolveConfiguredModelPatterns([`@${role.id}`], settings));
		}
	});

	test("a configured role reports its raw selector, pattern chain and resolved thinking level", () => {
		const { roles } = new RpcRoles(session).list();
		const smol = roles.find(role => role.id === "smol");
		expect(smol).toMatchObject({
			name: "Fast",
			tag: "SMOL",
			configured: "anthropic/claude-haiku-4-5:low",
			patterns: ["anthropic/claude-haiku-4-5:low"],
			resolved: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" },
			hidden: false,
		});

		const ghost = roles.find(role => role.id === "ghost");
		expect(ghost?.configured).toBe("nowhere/nothing");
		expect(ghost?.resolved).toBeUndefined();
		expect(ghost?.tag).toBeUndefined();
	});

	test("set_role applies the role's model and thinking suffix and becomes the active role", async () => {
		const roles = new RpcRoles(session);
		const result = await roles.setRole("smol");

		expect(result).toMatchObject({ ok: true, data: { role: "smol", thinkingLevel: "low" } });
		expect(modelKey(session.model)).toBe("anthropic/claude-haiku-4-5");
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(roles.activeRole()).toBe("smol");
		expect(roles.list().activeRole).toBe("smol");
	});

	test("a direct model change clears the active role, including the default role", async () => {
		const roles = new RpcRoles(session);
		await roles.setRole("default");
		expect(roles.activeRole()).toBe("default");

		// What `set_model` does: a direct pick records the `default` role too.
		const opus = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!opus) throw new Error("expected bundled claude-opus-4-5");
		await session.setModel(opus);
		expect(roles.activeRole()).toBeUndefined();
	});

	test("a resumed role selection is reported from the recorded model change", async () => {
		await new RpcRoles(session).setRole("reviewer");
		expect(new RpcRoles(session).activeRole()).toBe("reviewer");
	});

	test("unknown, unresolvable and busy selections fail with codes and leave the model unchanged", async () => {
		const roles = new RpcRoles(session);
		const before = modelKey(session.model);

		expect(await roles.setRole("nope")).toMatchObject({ ok: false, code: "unknown_role" });
		expect(await roles.setRole("ghost")).toMatchObject({ ok: false, code: "role_unresolved" });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		expect(await roles.setRole("smol")).toMatchObject({ ok: false, code: "session_busy" });
		Reflect.deleteProperty(session, "isStreaming");

		expect(modelKey(session.model)).toBe(before);
		expect(roles.activeRole()).toBeUndefined();
	});

	test("a launch role selector seeds the active role only when it produced the current model", () => {
		expect(new RpcRoles(session, "@default").activeRole()).toBe("default");
		expect(new RpcRoles(session, "@reviewer").activeRole()).toBeUndefined();
		expect(new RpcRoles(session, "anthropic/claude-sonnet-4-5").activeRole()).toBeUndefined();
	});
});

describe("RPC get_roles / set_role", () => {
	let child: RpcChild | undefined;
	let root: TempDir | undefined;

	afterEach(async () => {
		await child?.dispose();
		child = undefined;
		await root?.remove();
		root = undefined;
	});

	test("advertises get_roles and drives roles end to end over the wire", async () => {
		root = await TempDir.create("@rpc-roles-");
		await Bun.write(
			path.join(root.path(), "agent", "config.yml"),
			[
				"modelRoles:",
				...Object.entries(MODEL_ROLES_CONFIG).map(([role, value]) => `  ${role}: "${value}"`),
				"",
			].join("\n"),
		);
		child = await RpcChild.spawn({
			root: root.path(),
			args: ["--cwd", root.path(), "--model", "@reviewer"],
		});
		const rpc = child;

		const ready = await rpc.waitFor(frame => frame.type === "ready", 30_000);
		expect(ready.capabilities).toContain("get_roles");

		const state = async (): Promise<RpcFrame> => {
			const response = await rpc.request({ type: "get_state" }, 30_000);
			expect(response.success).toBe(true);
			return response.data as RpcFrame;
		};
		const currentModel = async (): Promise<string | undefined> => {
			const model = (await state()).model as RpcFrame | undefined;
			return model ? `${model.provider}/${model.id}` : undefined;
		};

		// Launched through `--model @reviewer`.
		expect((await state()).activeRole).toBe("reviewer");
		expect(await currentModel()).toBe("anthropic/claude-opus-4-5");

		const listed = await rpc.request({ type: "get_roles" }, 30_000);
		expect(listed.success).toBe(true);
		const listing = listed.data as { roles: RpcFrame[]; activeRole?: string };
		expect(listing.activeRole).toBe("reviewer");
		expect(listing.roles.find(role => role.id === "smol")).toMatchObject({
			configured: "anthropic/claude-haiku-4-5:low",
			patterns: ["anthropic/claude-haiku-4-5:low"],
			resolved: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" },
		});

		const framesBefore = rpc.frames.length;
		const selected = await rpc.request({ type: "set_role", role: "smol" }, 30_000);
		expect(selected).toMatchObject({
			success: true,
			data: { role: "smol", model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" },
		});
		const emitted = rpc.frames.slice(framesBefore).map(frame => frame.type);
		expect(emitted).toContain("model_changed");
		expect(emitted).toContain("config_update");
		expect((await state()).activeRole).toBe("smol");
		expect((await state()).thinkingLevel).toBe("low");

		const unknown = await rpc.request({ type: "set_role", role: "nope" }, 30_000);
		expect(unknown).toMatchObject({ success: false, code: "unknown_role" });
		const unresolved = await rpc.request({ type: "set_role", role: "ghost" }, 30_000);
		expect(unresolved).toMatchObject({ success: false, code: "role_unresolved" });
		expect(await currentModel()).toBe("anthropic/claude-haiku-4-5");
		expect((await state()).activeRole).toBe("smol");

		const direct = await rpc.request(
			{ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" },
			30_000,
		);
		expect(direct.success).toBe(true);
		expect((await state()).activeRole).toBeUndefined();
	}, 90_000);
});
