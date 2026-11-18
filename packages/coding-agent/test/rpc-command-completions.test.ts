/**
 * `get_command_completions` gives hosts without a terminal the argument completions the TUI offers where
 * they need no terminal state.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBuiltinCommandCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { saveCustomPersonality } from "../src/neopi/personality-settings";
import { BUILTIN_PERSONALITIES } from "../src/neopi/personalities";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("get_command_completions", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let handle: (command: RpcCommand) => Promise<RpcResponse>;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const context: Pick<RpcCommandHandlerContext, "session" | "success" | "error"> = {
			session,
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

	async function complete(command: string, prefix: string) {
		const response = await handle({ id: "c", type: "get_command_completions", command, prefix });
		if (!response.success || response.command !== "get_command_completions") throw new Error("Expected success");
		return response.data.items;
	}

	test("offers personality names, matching the typed prefix, as submitting completions", async () => {
		const all = await complete("personality", "");
		expect(all.map(item => item.value)).toEqual(expect.arrayContaining([...BUILTIN_PERSONALITIES]));
		const first = [...BUILTIN_PERSONALITIES][0];
		const narrowed = await complete("personality", first.slice(0, 2));
		expect(narrowed.length).toBeGreaterThan(0);
		for (const item of narrowed) {
			expect(item.value.toLowerCase().startsWith(first.slice(0, 2).toLowerCase())).toBe(true);
			expect(item.submitsCommand).toBe(true);
		}
	});

	test("includes custom personalities from the session's settings", async () => {
		const settings = Settings.isolated({});
		saveCustomPersonality(settings, "session", "Zesty", "Be zesty.");
		const items = await getBuiltinCommandCompletions("personality", "", { settings });
		expect(items.map(item => item.value)).toContain("Zesty");
	});

	test("serves declarative subcommands for other commands, by name or alias, with or without a leading slash", async () => {
		const sounds = await complete("/sounds", "st");
		expect(sounds).toEqual([expect.objectContaining({ value: "status ", label: "status", submitsCommand: true })]);
		expect((await complete("sounds", "")).map(item => item.label)).toEqual(["on", "off", "reload", "status"]);
	});

	test("is empty for a command with no completions, an unknown command, or a prefix past the first argument", async () => {
		expect(await complete("hotkeys", "")).toEqual([]);
		expect(await complete("no-such-command", "")).toEqual([]);
		expect(await complete("sounds", "on extra")).toEqual([]);
	});

	test.each([
		[1, "x"],
		["sounds", 2],
		[undefined, undefined],
	])("rejects non-string arguments %p %p", async (command, prefix) => {
		const response = await handle({
			id: "b",
			type: "get_command_completions",
			command,
			prefix,
		} as unknown as RpcCommand);
		expect(response.success).toBe(false);
	});
});
