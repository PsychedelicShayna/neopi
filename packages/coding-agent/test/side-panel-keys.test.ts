import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SidePanelController } from "@oh-my-pi/pi-coding-agent/modes/controllers/side-panel-controller";
import { cfgSidebarEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ALT_T = "\x1bt";

/** Real Composer + SidePanelController + InputController listeners; alt+t arrives through the terminal. */
async function harness(columns: number) {
	const term = new VirtualTerminal(columns, 24);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal: term,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, spellingTypoDetection: false, spellingAutocomplete: false },
	});
	composer.setRuntimeChildren([new TranscriptContainer(), new Text("EDITOR", 0, 0)]);
	composer.start();
	const settings = Settings.isolated();
	const keybindings = KeybindingsManager.inMemory();
	const sidePanel = new SidePanelController({ ui: composer.ui, composer, settings, keybindings });
	const ctx = {
		ui: composer.ui,
		handlesBtwBranchKey: () => false,
		editor: {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		keybindings,
		dictationSpaceHold: () => undefined,
		session: { extensionRunner: undefined },
		showStatus: () => {},
		setClickHoverId: () => {},
		sidePanel,
	} as unknown as InteractiveModeContext;
	new InputController(ctx).setupKeyHandlers();
	const settle = () => scheduler.settle(term);
	await settle();
	return { term, composer, settings, sidePanel, settle, stop: () => composer.stop() };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("app.sidebar.toggle routing", () => {
	it("leaves alt+t to a focused inline tree selector", async () => {
		const h = await harness(120);
		try {
			const tree = new TreeSelectorComponent(
				[],
				null,
				24,
				() => {},
				() => {},
			);
			const received: string[] = [];
			const handle = tree.handleInput.bind(tree);
			tree.handleInput = (data: string) => {
				received.push(data);
				handle(data);
			};
			h.composer.ui.setFocus(tree);
			h.term.sendInput(ALT_T);
			await h.settle();
			expect(received).toEqual([ALT_T]);
			expect(cfgSidebarEnabled.get(h.settings)).toBe(false);
		} finally {
			h.stop();
		}
	});
});
