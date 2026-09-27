import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgSidebarEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	renderTodoLines,
	TODO_LINE_BUDGET,
	TodoSection,
} from "@oh-my-pi/pi-coding-agent/modes/side-panel/todo-section";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const plain = (lines: readonly string[]): string => Bun.stripANSI(lines.join("\n"));

const PLAN: TodoPhase[] = [
	{
		name: "Build",
		tasks: [
			{ content: "write parser", status: "completed" },
			{ content: "wire the lexer", status: "pending" },
			...Array.from({ length: 7 }, (_, index) => ({ content: `task ${index}`, status: "pending" as const })),
		],
	},
];

describe("renderTodoLines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("lights the task a subagent is working on and applies the collapsed caps", () => {
		const collapsed = renderTodoLines({
			phases: PLAN,
			expanded: false,
			activeDescs: ["wire the lexer"],
			budget: TODO_LINE_BUDGET,
		});
		const matched = collapsed.find(line => line.includes("wire the lexer"));
		expect(matched).toContain(theme.fg("accent", `${theme.checkbox.unchecked} wire the lexer`));
		// The collapsed window caps open tasks with a summary row.
		expect(plain(collapsed)).not.toContain("task 6");
		expect(plain(collapsed)).toContain("3 more");

		const expanded = renderTodoLines({ phases: PLAN, expanded: true, activeDescs: [], budget: TODO_LINE_BUDGET });
		for (const task of PLAN[0]!.tasks) expect(plain(expanded)).toContain(task.content);
		expect(renderTodoLines({ phases: [], expanded: true, activeDescs: [], budget: TODO_LINE_BUDGET })).toEqual([]);
	});

	it("section renders nothing while dismissed and the expanded list otherwise", () => {
		const section = new TodoSection(() => {});
		section.update({ phases: PLAN, activeDescs: [], hidden: true });
		expect(section.content(40)).toEqual([]);
		section.update({ phases: PLAN, activeDescs: [], hidden: false });
		expect(plain(section.content(40))).toContain("task 6");
	});
});

describe("InteractiveMode todo HUD and side panel", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let composer: Composer;
	let term: VirtualTerminal;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-section-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "sidebar.enabled": true }),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 30);
		composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, undefined, composer);
		composer.setRuntimeChildren([mode.chatContainer, mode.todoContainer]);
	});

	afterAll(async () => {
		composer?.stop();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	const frame = (): string => plain(composer.renderFrame({ columns: 120, rows: 30 }).viewport);

	it("hides the HUD while docked and shows the current phases the moment it undocks", () => {
		mode.sidePanel.applySettings();
		mode.setTodos([{ name: "First", tasks: [{ content: "alpha task", status: "pending" }] }]);
		expect(frame()).toContain("alpha task");
		expect(composer.sidePanelDocked).toBe(true);
		expect(mode.todoContainer.render(80)).toEqual([]);

		// Updated while docked, then the dock goes away: the HUD is already current.
		mode.setTodos([{ name: "Second", tasks: [{ content: "beta task", status: "pending" }] }]);
		cfgSidebarEnabled.override(session.settings, false);
		mode.sidePanel.applySettings();
		const undocked = frame();
		expect(composer.sidePanelDocked).toBe(false);
		expect(undocked).toContain("beta task");
		expect(undocked).not.toContain("alpha task");
		expect(plain(mode.todoContainer.render(80))).toContain("beta task");
	});
});
