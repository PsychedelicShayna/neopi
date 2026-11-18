/**
 * Every registered slash command is advertised with where it can run, and RPC `prompt` text that names a
 * terminal-only builtin is refused instead of being sent to the model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildAvailableSlashCommands,
	toAcpAvailableCommands,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const BARE_SESSION = {
	customCommands: [],
	skills: [],
	sessionManager: { getCwd: () => process.cwd() },
	setSlashCommands: () => {},
};

describe("command catalog", () => {
	test("lists terminal-only builtins beside headless ones, each with its availability", async () => {
		const commands = await buildAvailableSlashCommands(BARE_SESSION as never, async () => [
			{ name: "notes", description: "Open notes", content: "body", source: "test" },
		]);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));
		expect(byName.settings).toMatchObject({
			source: "builtin",
			availability: "tui",
			description: expect.any(String),
		});
		expect(byName.hotkeys.availability).toBe("tui");
		expect(byName.model.availability).toBe("headless");
		expect(byName.notes.availability).toBe("headless");
		// A terminal-only command keeps its metadata so a GUI can render it as unavailable.
		expect(byName.fork.subcommands?.length).toBeGreaterThan(0);
	});

	test("ACP clients are still offered only the commands they can drive", async () => {
		const acp = toAcpAvailableCommands(await buildAvailableSlashCommands(BARE_SESSION as never, async () => []));
		const names = acp.map(command => command.name);
		expect(names).toContain("model");
		expect(names).not.toContain("settings");
		expect(names).not.toContain("hotkeys");
	});
});

describe("RPC prompt with a terminal-only slash command", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let handle: (command: RpcCommand) => Promise<RpcResponse>;
	let promptSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				getApiKey: () => "test-key",
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		promptSpy = vi.spyOn(session, "prompt");
		const frames: object[] = [];
		const output = (frame: object) => void frames.push(frame);
		const context: Partial<RpcCommandHandlerContext> = {
			session,
			output,
			success: (id, command, data) =>
				({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}) }) as RpcResponse,
			error: (id, command, error, code) =>
				({ id, type: "response", command, success: false, error, ...(code ? { code } : {}) }) as RpcResponse,
			promptResults: new RpcPromptResults(session, output, () => false),
			ownPrompt: () => "owner",
			reservePromptEntryId: () => undefined,
			executeCustomPromptCommand: async () => null,
			emitAvailableCommandsUpdate: async () => {},
			reloadPluginState: async () => {},
			getAvailableCommands: async () => [],
			onPromptError: () => () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
			trackBackground: () => {},
		};
		handle = createRpcCommandHandler(context as RpcCommandHandlerContext);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
	});

	test.each(["/settings", "/hotkeys", "/exit", "/fork pane"])(
		"%s is refused with a structured error and never reaches the model",
		async text => {
			const response = await handle({ id: "p", type: "prompt", message: text });
			const name = text.slice(1).split(" ")[0];
			expect(response).toEqual({
				id: "p",
				type: "response",
				command: "prompt",
				success: false,
				error: `/${name} needs the terminal UI`,
				code: "command_requires_tui",
			});
			expect(promptSpy).not.toHaveBeenCalled();
		},
	);

	test("a headless builtin still runs locally and unknown slash text is still chat", async () => {
		const local = await handle({ id: "m", type: "prompt", message: "/usage" });
		expect(local.success).toBe(true);
		expect(promptSpy).not.toHaveBeenCalled();
		const chat = await handle({ id: "c", type: "prompt", message: "/tmp/not-a-command look here" });
		expect(chat.success).toBe(true);
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});
});
