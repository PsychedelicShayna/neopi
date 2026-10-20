import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const scratchRoot = path.join(os.homedir(), ".cache", "npi-canary");

describe("live /tool: command reports and completion", () => {
	let tempDir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;
	let provider: AutocompleteProvider;
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));

	beforeAll(() => initTheme());

	beforeEach(async () => {
		resetSettingsForTest();
		await fs.mkdir(scratchRoot, { recursive: true });
		tempDir = await TempDir.create(path.join(scratchRoot, "tool-slash-test-"));
		vi.spyOn(os, "homedir").mockReturnValue(tempDir.path());
		execute.mockClear();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		auth = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const registry = new ModelRegistry(auth, path.join(tempDir.path(), "models.yml"));
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in model registry");
		const makeTool = (name: string): Tool => ({
			name,
			label: name,
			description: `Docs for ${name}`,
			parameters: { type: "object", properties: {} },
			execute,
		});
		const read = makeTool("read");
		const mission = makeTool("mission");
		const disabled = makeTool("disabled");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, tools: [read, mission], systemPrompt: ["Test"], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: registry,
			toolRegistry: new Map([read, mission, disabled].map(tool => [tool.name, tool])),
		});
		terminal = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		mode.addAutocompleteProvider(base => {
			provider = base;
			return base;
		});
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		auth?.close();
		await tempDir?.remove();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function screen(): string {
		return terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd()).join("\n");
	}

	it.each(["missing", "disabled", "xd://read", "raed"])(
		"Enter on /tool:%s resolves to a report without invoking or sending to the agent",
		async name => {
			const command = `/tool:${name}`;
			const blocks = mode.chatContainer.children.length;
			const onSubmit = mode.editor.onSubmit!;
			const submitted = Promise.withResolvers<void>();
			mode.editor.onSubmit = async text => {
				try {
					await onSubmit(text);
					submitted.resolve();
				} catch (error) {
					submitted.reject(error);
				}
			};
			terminal.sendInput(command);
			await terminal.waitForRender(() => mode.editor.getText() === command);
			terminal.sendInput("\r");
			await expect(submitted.promise).resolves.toBeUndefined();
			await terminal.waitForRender(() => screen().includes(`No enabled tool named "${name}"`));
			expect(screen()).toContain("Nearest enabled matches:");
			expect(screen()).toContain("/tool:read");
			expect(screen()).not.toContain("/tool:disabled");
			if (name === "raed") expect(screen().indexOf("/tool:read")).toBeLessThan(screen().indexOf("/tool:mission"));
			expect(mode.chatContainer.children).toHaveLength(blocks);
			expect(session.messages).toEqual([]);
			expect(execute).not.toHaveBeenCalled();
			terminal.sendInput("\x1b");
			await terminal.waitForRender(() => !screen().includes("No enabled tool named"));
			terminal.sendInput("draft after report");
			await terminal.waitForRender(() => mode.editor.getText() === "draft after report");
		},
	);

	async function toolCompletions(): Promise<string[]> {
		const query = "/tool:";
		const result = await provider.getSuggestions([query], 0, query.length);
		return result?.items.map(item => item.value).filter(value => value.startsWith("tool:")) ?? [];
	}

	it("rebuilds enabled-tool completion after runtime selection changes", async () => {
		expect(await toolCompletions()).toEqual(expect.arrayContaining(["tool:read", "tool:mission"]));
		expect(await toolCompletions()).not.toContain("tool:disabled");
		await session.setActiveToolsByName([]);
		expect(await toolCompletions()).toEqual(["tool:"]);
		expect(mode.slashCommandNames.has("tool:read")).toBe(false);
		await session.setActiveToolsByName(["disabled"]);
		expect(await toolCompletions()).toEqual(expect.arrayContaining(["tool:", "tool:disabled"]));
		expect(await toolCompletions()).not.toContain("tool:read");
		expect(await toolCompletions()).not.toContain("tool:mission");
		expect(mode.slashCommandNames.has("tool:disabled")).toBe(true);
	});
});
