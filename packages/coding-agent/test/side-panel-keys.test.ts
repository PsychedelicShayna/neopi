import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SidePanelController } from "@oh-my-pi/pi-coding-agent/modes/controllers/side-panel-controller";
import {
	cfgSidebarAgentAutoscroll,
	cfgSidebarAgentFilters,
	cfgSidebarAgentOrder,
	cfgSidebarEnabled,
	cfgSidebarView,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentsSection } from "@oh-my-pi/pi-coding-agent/modes/side-panel/agents-section";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
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
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, spellingTypoDetection: false, spellingAutocomplete: "off" },
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

	it("gives alt+t to a dialog stacked above the fullscreen panel", async () => {
		const h = await harness(100);
		try {
			h.term.sendInput(ALT_T);
			await h.settle();
			expect(h.sidePanel.fullscreenOpen).toBe(true);

			const received: string[] = [];
			const dialog: Component = {
				render: () => ["dialog"],
				invalidate: () => {},
				handleInput: (data: string) => received.push(data),
			};
			h.composer.ui.showOverlay(dialog);
			await h.settle();
			h.term.sendInput(ALT_T);
			await h.settle();
			expect(received).toEqual([ALT_T]);
			expect(h.sidePanel.fullscreenOpen).toBe(true);

			// Once the dialog closes, alt+t returns to the transcript, closing the covering form.
			h.composer.ui.hideOverlay();
			await h.settle();
			h.term.sendInput(ALT_T);
			await h.settle();
			expect(h.sidePanel.fullscreenOpen).toBe(false);
		} finally {
			h.stop();
		}
	});
});

describe("alt+t focus and the panel keymap", () => {
	it("opens with focus, returns focus on a second alt+t, Esc or Left, and closes on q", async () => {
		const h = await harness(120);
		const typed: string[] = [];
		const editor: Component = {
			render: () => ["EDITOR"],
			invalidate: () => {},
			handleInput: (data: string) => typed.push(data),
		};
		h.composer.ui.setFocus(editor);
		try {
			h.term.sendInput(ALT_T);
			await h.settle();
			expect(cfgSidebarEnabled.get(h.settings)).toBe(true);
			expect(h.sidePanel.active).toBe(true);

			// A second alt+t hands the keyboard back with the panel still docked.
			h.term.sendInput(ALT_T);
			h.term.sendInput("a");
			await h.settle();
			expect(h.sidePanel.active).toBe(false);
			expect(h.sidePanel.docked).toBe(true);
			expect(typed).toEqual(["a"]);

			for (const back of ["\x1b", "\x1b[D"]) {
				h.term.sendInput(ALT_T);
				await h.settle();
				expect(h.sidePanel.active).toBe(true);
				h.term.sendInput(back);
				await h.settle();
				expect(h.sidePanel.active).toBe(false);
				expect(h.sidePanel.docked).toBe(true);
			}

			h.term.sendInput(ALT_T);
			h.term.sendInput("q");
			await h.settle();
			expect(cfgSidebarEnabled.get(h.settings)).toBe(false);
			expect(h.sidePanel.active).toBe(false);
			expect(typed).toEqual(["a"]);
		} finally {
			h.stop();
		}
	});

	it("cycles views with Tab and Shift+Tab without view letters", async () => {
		const h = await harness(120);
		try {
			h.term.sendInput(ALT_T);
			await h.settle();
			expect(cfgSidebarView.get(h.settings)).toBe("agents");
			h.term.sendInput("\t");
			await h.settle();
			expect(h.sidePanel.dockedView).toBe("irc");
			h.term.sendInput("\t");
			await h.settle();
			expect(h.sidePanel.dockedView).toBe("todo");
			h.term.sendInput("\x1b[Z");
			await h.settle();
			expect(h.sidePanel.dockedView).toBe("irc");
			// Letters no longer pick views.
			h.term.sendInput("t");
			await h.settle();
			expect(h.sidePanel.dockedView).toBe("irc");
			expect(h.sidePanel.active).toBe(true);
		} finally {
			h.stop();
		}
	});

	for (const vim of [false, true]) {
		it(`selects rows with arrows${vim ? " and j/k, and h/l move focus and expand," : ""} with Vim ${vim ? "on" : "off"}`, async () => {
			const previousVim = getMenuSearchVimMode();
			setMenuSearchVimMode(vim);
			const h = await harness(120);
			try {
				const ids = ["one", "two", "three"];
				let selected = -1;
				const expanded: string[] = [];
				h.sidePanel.registerView("agents", {
					id: "agents",
					title: "AGENTS",
					content: () => ids.map((id, index) => (index === selected ? `> ${id}` : `  ${id}`)),
					moveSelection: delta => {
						selected = Math.max(0, Math.min(ids.length - 1, selected < 0 ? 0 : selected + delta));
						return true;
					},
					clearSelection: () => {
						selected = -1;
					},
					expand: () => expanded.push(ids[selected]!),
				});
				const send = async (...keys: string[]) => {
					for (const key of keys) h.term.sendInput(key);
					await h.settle();
				};
				await send(ALT_T, "\x1b[B", "\x1b[B");
				expect(selected).toBe(1);
				await send("\x1b[A");
				expect(selected).toBe(0);
				await send("\x1b[C");
				expect(expanded).toEqual(["one"]);
				await send("j");
				expect(selected).toBe(vim ? 1 : 0);
				await send("l");
				expect(expanded).toEqual(vim ? ["one", "two"] : ["one"]);
				await send("h");
				expect(h.sidePanel.active).toBe(!vim);
			} finally {
				setMenuSearchVimMode(previousVim);
				h.stop();
			}
		});
	}
});

describe("side-panel popups", () => {
	it("opens help on ? and the Agents filter popup on f, which toggles live and closes on Esc", async () => {
		const h = await harness(120);
		try {
			h.sidePanel.registerView(
				"agents",
				new AgentsSection({
					settings: h.settings,
					observed: () => undefined,
					visible: () => true,
					agents: () => [],
					focusedAgentId: () => undefined,
					focus: () => {},
					returnToPrimary: () => {},
					openTranscript: () => {},
					message: () => {},
					revive: () => {},
					kill: () => {},
					requestRender: () => h.composer.ui.requestRender(),
					onChange: () => () => {},
				}),
			);
			const screen = () => h.term.getViewport().join("\n");
			const send = async (...keys: string[]) => {
				for (const key of keys) h.term.sendInput(key);
				await h.settle();
			};
			await send(ALT_T);
			expect(screen()).toContain("? help");
			await send("?");
			expect(screen()).toContain("i DM · r revive · x kill");
			// The card swallows other keys and closes on Esc, leaving the panel focused.
			await send("q");
			expect(h.sidePanel.active).toBe(true);
			expect(screen()).toContain("i DM · r revive · x kill");
			await send("\x1b");
			expect(h.sidePanel.active).toBe(true);
			expect(screen()).not.toContain("i DM · r revive · x kill");

			await send("f");
			expect(screen()).toContain("Filters");
			expect(screen()).toContain("[x] Running subagents");
			expect(screen()).toContain("[ ] Idle subagents");
			await send("\x1b[B", " ");
			expect(cfgSidebarAgentFilters.get(h.settings)).toEqual(["running", "advisors", "idle"]);
			expect(screen()).toContain("[x] Idle subagents");
			await send("\x1b[F", " ");
			expect(cfgSidebarAgentOrder.get(h.settings)).toBe("newest-at-top");
			// Esc closes the popup, not the panel or its focus.
			await send("\x1b");
			expect(screen()).not.toContain("Filters");
			expect(h.sidePanel.active).toBe(true);
		} finally {
			h.stop();
		}
	});
});

describe("focused side-panel scrolling", () => {
	it("moves and reveals the agent selection before Enter acts on it", async () => {
		const previousVim = getMenuSearchVimMode();
		const h = await harness(120);
		const agents = Array.from({ length: 40 }, (_, index): AgentRecordLike => ({
			id: `agent-${String(index).padStart(2, "0")}`,
			displayName: `Agent ${index}`,
			kind: "sub",
			status: "running",
			session: null,
			sessionFile: null,
			createdAt: index,
			lastActivity: index,
		}));
		const opened: string[] = [];
		const section = new AgentsSection({
			settings: h.settings,
			agents: () => agents,
			focusedAgentId: () => undefined,
			observed: () => undefined,
			visible: () => h.sidePanel.visible,
			focus: () => {},
			returnToPrimary: () => {},
			openTranscript: id => opened.push(id),
			message: () => {},
			revive: () => {},
			kill: () => {},
			requestRender: () => h.composer.ui.requestRender(),
			onChange: () => () => {},
		});
		const send = async (...keys: string[]) => {
			for (const key of keys) h.term.sendInput(key);
			await h.settle();
		};
		const selected = () =>
			h.term.getViewport().flatMap((line, row) => {
				const id = line.match(/agent-\d\d/)?.[0];
				return id && h.term.getViewportRowBackgroundColumns(row).length > 0 ? [id] : [];
			});
		try {
			cfgSidebarAgentAutoscroll.override(h.settings, false);
			cfgSidebarAgentOrder.override(h.settings, "newest-at-bottom");
			h.sidePanel.registerView("agents", section);
			setMenuSearchVimMode(false);
			await send(ALT_T);
			await send("\x1b[B");
			expect(selected()).toEqual(["agent-00"]);
			const page = h.term.getViewport().filter(line => /agent-\d\d/.test(line)).length;
			expect(page).toBeGreaterThan(2);
			const paged = agents[page]!.id;
			await send("\x1b[6~");
			expect(selected()).toEqual([paged]);
			await send("\r");
			expect(opened).toEqual([paged]);

			await send("\x1b[5~");
			expect(selected()).toHaveLength(1);
			expect(agents.findIndex(agent => agent.id === selected()[0])).toBeLessThan(page);

			setMenuSearchVimMode(true);
			await send("\x1b[H");
			await send("\x04");
			const half = agents[Math.floor(page / 2)]!.id;
			expect(selected()).toEqual([half]);
			await send("\r");
			expect(opened).toEqual([paged, half]);
			await send("\x15");
			expect(selected()).toHaveLength(1);
			expect(agents.findIndex(agent => agent.id === selected()[0])).toBeLessThan(Math.floor(page / 2));
		} finally {
			h.sidePanel.dispose();
			h.stop();
			setMenuSearchVimMode(previousVim);
		}
	});

	for (const vim of [false, true]) {
		it(`opens immediately and jumps by two digits with Vim ${vim ? "on" : "off"}`, async () => {
			const previousVim = getMenuSearchVimMode();
			setMenuSearchVimMode(vim);
			const h = await harness(100);
			try {
				const content = Array.from({ length: 110 }, (_, i) => `fixture-row-${i}`);
				h.sidePanel.registerView("agents", { id: "agents", title: "AGENTS", content: () => content });
				const screen = () => h.term.getViewport().join("\n");
				const firstRow = () => Number(screen().match(/fixture-row-(\d+)/)?.[1]);
				const send = async (...keys: string[]) => {
					for (const key of keys) h.term.sendInput(key);
					await h.settle();
				};
				await send(ALT_T);
				expect(h.sidePanel.fullscreenActive).toBe(true);
				// No navigation hints clutter the bottom.
				expect(screen()).not.toContain("gg/G");
				expect(screen()).not.toContain("Esc");
				expect(firstRow()).toBe(0);
				await send("3");
				expect(firstRow()).toBe(0);
				await send("0");
				const jumped = firstRow();
				expect(jumped).toBeGreaterThanOrEqual(24);
				expect(jumped).toBeLessThanOrEqual(28);
				await send("\x1b[B");
				expect(firstRow()).toBe(jumped + 1);
				await send("j");
				expect(firstRow()).toBe(jumped + (vim ? 2 : 1));
				if (vim) {
					await send("k", "\x05");
					expect(firstRow()).toBe(jumped + 2);
					await send("\x19");
					expect(firstRow()).toBe(jumped + 1);
					await send("\x04");
					expect(firstRow()).toBeGreaterThan(jumped + 2);
					await send("\x15");
					expect(firstRow()).toBe(jumped + 1);
					await send("G");
					expect(screen()).toContain("fixture-row-109");
					await send("g", "g");
					expect(firstRow()).toBe(0);
				}
				await send("\x03");
				expect(h.sidePanel.fullscreenOpen).toBe(false);
			} finally {
				setMenuSearchVimMode(previousVim);
				h.stop();
			}
		});
	}
});
