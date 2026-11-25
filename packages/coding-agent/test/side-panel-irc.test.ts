import { afterAll, beforeAll, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseSgrMouse, Text } from "@oh-my-pi/pi-tui";
import { IrcViewerComponent } from "@oh-my-pi/pi-tui/overlays/irc-viewer";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { IrcLogEntry } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession;

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	tempDir = TempDir.createSync("@pi-side-panel-irc-");
	await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings: Settings.isolated({ "sidebar.enabled": true, "sidebar.view": "irc" }),
		modelRegistry,
	});
});

afterAll(async () => {
	await session?.dispose();
	authStorage?.close();
	tempDir?.removeSync();
	resetSettingsForTest();
});

it("pages to an older IRC row and opens the matching message by Enter or click", async () => {
	const entries = Array.from({ length: 48 }, (_, index): IrcLogEntry => {
		const id = `irc-${String(index).padStart(2, "0")}`;
		return {
			message: { id, from: `peer-${id}`, to: "Main", body: `body-${id}`, ts: index },
			outcome: "injected",
			broadcast: false,
		};
	});
	const history = vi.spyOn(IrcBus.prototype, "history").mockReturnValue(entries);
	const term = new VirtualTerminal(120, 24);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal: term,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, spellingTypoDetection: false, spellingAutocomplete: "off" },
	});
	composer.start();
	const mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, composer);
	const selected = () =>
		new Set(term.getViewport().flatMap((line, row) => {
			const id = line.match(/irc-\d\d/)?.[0];
			return id && term.getViewportRowBackgroundColumns(row).length > 0 ? [id] : [];
		}));
	const send = async (key: string) => {
		term.sendInput(key);
		await scheduler.settle(term);
	};
	const viewerSelection = () => {
		const viewer = composer.ui.getFocused();
		if (!(viewer instanceof IrcViewerComponent)) throw new Error("Expected the IRC viewer to have focus");
		return viewer.navigationSnapshot().selected;
	};
	try {
		composer.setRuntimeChildren([mode.chatContainer, new Text("EDITOR", 0, 0)]);
		mode.sidePanel.applySettings();
		mode.sidePanel.toggleFocus();
		await scheduler.settle(term);
		await send("\x1b[B");
		const newest = entries.at(-1)!.message.id;
		expect([...selected()]).toEqual([newest]);
		const page = new Set(term.getViewport().flatMap(line => line.match(/irc-\d\d/g) ?? [])).size;
		expect(page).toBeGreaterThan(2);
		const paged = entries.at(-1 - page)!.message.id;
		await send("\x1b[6~");
		expect([...selected()]).toEqual([paged]);
		await send("\r");
		expect(viewerSelection()).toBe(paged);
		expect(term.getViewport().some(line => line.includes("▍") && line.includes(`body-${paged}`))).toBe(true);

		await send("\x1b");
		const panel = composer.sidePanelGeometry()?.panelRect;
		if (!panel) throw new Error("Expected the IRC side panel to be docked");
		const neighbor = entries.at(-page)!.message.id;
		const row = term.getViewport().findIndex(line => line.includes(`body-${neighbor}`));
		expect(row).toBeGreaterThanOrEqual(0);
		const click = parseSgrMouse(`\x1b[<0;${panel.col + 2};${row + 1}M`);
		if (!click) throw new Error("Expected a mouse report");
		expect(mode.sidePanel.routeInlineMouse(click)).toBe(true);
		await scheduler.settle(term);
		expect(viewerSelection()).toBe(neighbor);
		await send("\x1b");
	} finally {
		mode.stop();
		composer.stop();
		history.mockRestore();
	}
});
