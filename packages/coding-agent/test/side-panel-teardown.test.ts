import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/** A 100-column transcript line: it wraps at the docked chat width but not at the terminal width. */
function ledgerLine(index: number): string {
	const label = `E${String(index).padStart(2, "0")}:`;
	return label + "abcdefghij".repeat(10).slice(label.length);
}

describe("InteractiveMode quit while docked", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-side-panel-teardown-");
		// Quiet startup: no welcome header holding the transcript back from retiring.
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "sidebar.enabled": true, "tui.resizeScrollback": "rebuild" }),
			modelRegistry,
		});
	});

	afterAll(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("flushes the un-retired tail at the docked chat width and clears nothing", async () => {
		const term = new VirtualTerminal(120, 24, 2000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			realWrite(data);
		};
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal: term,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, spellingTypoDetection: false, spellingAutocomplete: "off" },
		});
		composer.start();
		const mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
		);
		try {
			composer.setRuntimeChildren([mode.chatContainer, new Text("EDITOR", 0, 0)]);
			mode.sidePanel.applySettings();
			// Four finalized entries that still fit on screen: nothing has retired yet.
			for (let index = 0; index < 4; index++) mode.chatContainer.addChild(new Text(ledgerLine(index), 0, 0));
			composer.ui.requestRender();
			await scheduler.settle(term);
			expect(composer.sidePanelDocked).toBe(true);
			const chatWidth = composer.sidePanelGeometry()?.chatRect.width ?? 0;
			expect(chatWidth).toBe(81);

			writes.length = 0;
			mode.stop();
			const quit = writes.join("");
			expect(quit).not.toContain("\x1b[3J");
			const rows = term.getScrollBuffer().map(row => row.trimEnd());
			const runs = rows.flatMap(row => row.match(/E\d\d:[a-j]+/g) ?? []);
			// Every entry reached the terminal, each wrapped at the docked chat width.
			expect(new Set(runs.map(run => run.slice(0, 4)))).toEqual(new Set(["E00:", "E01:", "E02:", "E03:"]));
			for (const run of runs) expect(run.length).toBeLessThanOrEqual(chatWidth);
		} finally {
			composer.stop();
		}
	});
});
