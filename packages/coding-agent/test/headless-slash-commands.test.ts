/**
 * Terminal-only builtins whose action is not inherently interactive run headless (RPC, ACP, control): `/personality` and `/notice`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_PERSONALITIES } from "@oh-my-pi/pi-coding-agent/neopi/personalities";
import { currentPersonalityName, saveCustomPersonality } from "@oh-my-pi/pi-coding-agent/neopi/personality-settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	executeAcpBuiltinSlashCommand,
	lookupTuiOnlyBuiltin,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("headless builtins", () => {
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let mock: ReturnType<typeof createMockModel>;
	let output: string[];

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		output = [];
		settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				getApiKey: () => "test-key",
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
	});

	function run(text: string) {
		return executeAcpBuiltinSlashCommand(text, {
			session,
			sessionManager: session.sessionManager,
			settings,
			cwd: process.cwd(),
			output: line => void output.push(line),
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		});
	}

	test("none of them is terminal-only any more, and the catalog says so", async () => {
		for (const name of ["personality", "notice"]) expect(lookupTuiOnlyBuiltin(`/${name}`)).toBeUndefined();
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				skills: [],
				sessionManager: { getCwd: () => process.cwd() },
				setSlashCommands: () => {},
			} as never,
			async () => [],
		);
		const byName = Object.fromEntries(commands.map(command => [command.name, command.availability]));
		expect([byName.personality, byName.notice]).toEqual(["headless", "headless"]);
		expect(byName.settings).toBe("tui");
	});

	describe("/personality", () => {
		test("lists current and available personalities without changing selection or invoking the model", async () => {
			const current = currentPersonalityName(settings);
			expect(await run("/personality")).toEqual({ consumed: true });
			const listed = output.join("\n");
			expect(listed).toContain(current);
			for (const name of BUILTIN_PERSONALITIES) expect(listed).toContain(name);
			expect(currentPersonalityName(settings)).toBe(current);
			expect(mock.calls).toHaveLength(0);
		});

		test("sets a built-in personality for the session, matching case-insensitively", async () => {
			const target = [...BUILTIN_PERSONALITIES].find(name => name !== currentPersonalityName(settings));
			if (!target) throw new Error("Expected a second built-in personality");
			expect(await run(`/personality ${target.toUpperCase()}`)).toEqual({ consumed: true });
			expect(currentPersonalityName(settings)).toBe(target);
			expect(
				settings.getProvenance(
					await import("@oh-my-pi/pi-coding-agent/session/settings").then(m => m.cfgPersonality),
				),
			).toBe("session");
		});

		test("sets a custom personality and refuses unknown names without changing anything", async () => {
			saveCustomPersonality(settings, "session", "Zesty", "Be zesty.");
			expect(await run("/personality Zesty")).toEqual({ consumed: true });
			expect(currentPersonalityName(settings)).toBe("Zesty");
			expect(await run("/personality nobody-by-this-name")).toEqual({ consumed: true, failed: true });
			expect(currentPersonalityName(settings)).toBe("Zesty");
		});
	});

	describe("/notice", () => {
		test("delivers an operator notice through the actual session and completes its model turn", async () => {
			expect(await run("/notice  check the logs")).toEqual({ consumed: true, agentInvoked: true });
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(1);
			const delivered = mock.calls[0].context.messages.find(message => message.role === "developer");
			expect(delivered).toMatchObject({
				role: "developer",
				attribution: "user",
				synthetic: true,
				userInitiated: true,
			});
			expect(JSON.stringify(delivered?.content)).toContain("check the logs");
			expect(session.isStreaming).toBe(false);
		});

		test("needs text without invoking the model or changing the transcript", async () => {
			expect(await run("/notice")).toEqual({ consumed: true, failed: true });
			expect(mock.calls).toHaveLength(0);
			expect(session.messages).toEqual([]);
		});
	});
});
