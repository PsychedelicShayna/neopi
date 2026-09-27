import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SidePanelController } from "@oh-my-pi/pi-coding-agent/modes/controllers/side-panel-controller";
import { cfgSidebarEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { type Component, parseSgrMouse, type SgrMouseEvent, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { getThemeByName, initTheme, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class CardBlock implements Component {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return ["card one"];
	}
	invalidate(): void {}
	getClickFocusAgentIds(): string[] {
		return ["AgentA"];
	}
}

async function harness(columns: number, overrides: Record<string, unknown> = {}) {
	const term = new VirtualTerminal(columns, 24);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal: term,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, spellingTypoDetection: false, spellingAutocomplete: false },
	});
	const transcript = new TranscriptContainer();
	transcript.addChild(new CardBlock());
	composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
	composer.start();
	const settings = Settings.isolated(overrides);
	const controller = new SidePanelController({
		ui: composer.ui,
		composer,
		settings,
		keybindings: KeybindingsManager.inMemory(),
	});
	const settle = () => scheduler.settle(term);
	await settle();
	return { term, composer, settings, controller, settle, stop: () => composer.stop() };
}

function click(row: number, col: number): SgrMouseEvent {
	const event = parseSgrMouse(`\x1b[<0;${col + 1};${row + 1}M`);
	if (!event) throw new Error("bad report");
	return event;
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SidePanelController", () => {
	it("toggles the dock when wide and a fullscreen form when narrow", async () => {
		const wide = await harness(120);
		try {
			wide.controller.toggle();
			await wide.settle();
			expect(cfgSidebarEnabled.get(wide.settings)).toBe(true);
			expect(wide.controller.docked).toBe(true);
			expect(wide.controller.fullscreenOpen).toBe(false);
			wide.controller.toggle();
			await wide.settle();
			expect(cfgSidebarEnabled.get(wide.settings)).toBe(false);
			expect(wide.controller.docked).toBe(false);
		} finally {
			wide.stop();
		}

		const narrow = await harness(100);
		try {
			const ui = narrow.composer.ui;
			narrow.controller.toggle();
			await narrow.settle();
			expect(narrow.controller.fullscreenOpen).toBe(true);
			expect(cfgSidebarEnabled.get(narrow.settings)).toBe(false);
			expect(ui.hasOverlay()).toBe(true);

			// Escape inside the form closes it through onClose.
			ui.getFocused()?.handleInput?.("\x1b");
			await narrow.settle();
			expect(narrow.controller.fullscreenOpen).toBe(false);
			expect(ui.hasOverlay()).toBe(false);
			// The next toggle reopens rather than hiding an overlay that is already gone.
			narrow.controller.toggle();
			await narrow.settle();
			expect(narrow.controller.fullscreenOpen).toBe(true);

			// Widening past the threshold does not turn the same key into "dock".
			narrow.term.resize(120, 24);
			await narrow.settle();
			narrow.controller.toggle();
			await narrow.settle();
			expect(narrow.controller.fullscreenOpen).toBe(false);
			expect(cfgSidebarEnabled.get(narrow.settings)).toBe(false);
		} finally {
			narrow.stop();
		}

		const stacked = await harness(100);
		try {
			const ui = stacked.composer.ui;
			stacked.controller.toggle();
			const dialog: Component = { render: () => ["dialog"], invalidate: () => {} };
			ui.showOverlay(dialog);
			await stacked.settle();
			stacked.controller.closeFullscreen();
			await stacked.settle();
			expect(stacked.controller.fullscreenOpen).toBe(false);
			expect(ui.hasOverlay()).toBe(true);
			expect(ui.getFocused()).toBe(dialog);
		} finally {
			stacked.stop();
		}
	});

	it("warns once about out-of-range widths and docks with the defaults", async () => {
		const warn = vi.spyOn(logger, "warn");
		const ratio = await harness(120, { "sidebar.enabled": true, "sidebar.width.ratio": 0.9 });
		try {
			ratio.controller.applySettings();
			ratio.controller.applySettings();
			await ratio.settle();
			const warnings = warn.mock.calls.filter(([, meta]) => JSON.stringify(meta).includes("sidebar.width.ratio"));
			expect(warnings).toHaveLength(1);
			// The default ratio 0.3 of 120 columns, not 0.9.
			expect(ratio.composer.sidePanelGeometry()?.panelRect.width).toBe(36);
		} finally {
			ratio.stop();
		}

		warn.mockClear();
		const negative = await harness(120, {
			"sidebar.enabled": true,
			"sidebar.width.min": -1,
			"sidebar.width.max": -1,
		});
		try {
			negative.controller.applySettings();
			negative.controller.applySettings();
			await negative.settle();
			const warnings = warn.mock.calls.filter(([, meta]) => JSON.stringify(meta).includes("sidebar.width"));
			expect(warnings).toHaveLength(1);
			// Defaults (32–48, ratio 0.3 of 120 → 36), not a zero-width panel.
			expect(negative.composer.sidePanelGeometry()?.panelRect.width).toBe(36);
		} finally {
			negative.stop();
		}

		warn.mockClear();
		const bounds = await harness(120, { "sidebar.enabled": true, "sidebar.width.min": 50, "sidebar.width.max": 40 });
		try {
			bounds.controller.applySettings();
			bounds.controller.applySettings();
			await bounds.settle();
			const warnings = warn.mock.calls.filter(([, meta]) => JSON.stringify(meta).includes("sidebar.width.min"));
			expect(warnings).toHaveLength(1);
			expect(bounds.composer.sidePanelGeometry()?.panelRect.width).toBe(36);
		} finally {
			bounds.stop();
		}
	});

	it("raises the dock threshold to what custom minimum widths need", async () => {
		// 60-column panel + 60-column chat + divider need 123 columns; the default 110 cannot dock them.
		const h = await harness(120, { "sidebar.width.min": 60, "sidebar.width.max": 80, "sidebar.splitAt": 110 });
		try {
			h.controller.toggle();
			await h.settle();
			// 120 columns is narrow for these widths: the toggle shows the fullscreen form.
			expect(h.controller.fullscreenOpen).toBe(true);
			expect(cfgSidebarEnabled.get(h.settings)).toBe(false);
			h.controller.closeFullscreen();
			h.term.resize(130, 24);
			await h.settle();
			h.controller.toggle();
			await h.settle();
			expect(h.controller.docked).toBe(true);
			expect(h.composer.sidePanelGeometry()?.panelRect.width).toBeGreaterThanOrEqual(60);
		} finally {
			h.stop();
		}
	});

	for (const side of ["right", "left"] as const) {
		it(`routes inline mouse by column on a ${side} dock`, async () => {
			const h = await harness(120, { "sidebar.enabled": true, "sidebar.side": side });
			try {
				const routed: number[] = [];
				h.controller.register({
					id: "todo",
					title: "TODO",
					content: {
						render: () => ["task"],
						invalidate: () => {},
						routeMouse: (_event: SgrMouseEvent, line: number) => routed.push(line),
					} as Component & { routeMouse(event: SgrMouseEvent, line: number, col: number): void },
				});
				h.controller.applySettings();
				h.composer.setHoveredClickId("AgentA");
				h.composer.ui.requestRender();
				await h.settle();
				const geometry = h.composer.sidePanelGeometry();
				if (!geometry) throw new Error("expected a docked frame");
				const { chatRect, panelRect, dividerCol } = geometry;
				const cardRow = h.term.getViewport().findIndex(row => row.includes("card one"));
				expect(h.term.getViewportRowBackgroundColumns(cardRow).length).toBeGreaterThan(0);

				// Chat column: not consumed, row routing continues.
				expect(h.controller.routeInlineMouse(click(cardRow, chatRect.col + 1))).toBe(false);
				// Panel body row 1 (under the title): routed with the panel-local row.
				expect(h.controller.routeInlineMouse(click(1, panelRect.col + 1))).toBe(true);
				expect(routed).toEqual([0]);
				// Divider: consumed with no action; the painted hover band clears on its own.
				h.composer.setHoveredClickId("AgentA");
				h.composer.ui.requestRender();
				await h.settle();
				expect(h.term.getViewportRowBackgroundColumns(cardRow).length).toBeGreaterThan(0);
				expect(h.controller.routeInlineMouse(click(cardRow, dividerCol + 1))).toBe(true);
				expect(routed).toEqual([0]);
				await h.settle();
				expect(h.term.getViewportRowBackgroundColumns(cardRow)).toEqual([]);
				// With no hover target left, further motion over the divider paints nothing.
				const writes = vi.spyOn(h.term, "write");
				expect(h.controller.routeInlineMouse(click(cardRow, dividerCol + 1))).toBe(true);
				await h.settle();
				expect(writes).not.toHaveBeenCalled();
				writes.mockRestore();
				// Out-of-range rows are not routed.
				expect(h.controller.routeInlineMouse(click(24, panelRect.col + 1))).toBe(false);
				// While the alt screen owns the display no viewport is published: nothing routes.
				const overlay = h.composer.ui.showOverlay(
					{ render: () => ["modal"], invalidate: () => {} },
					{ fullscreen: true },
				);
				await h.settle();
				expect(h.controller.routeInlineMouse(click(1, panelRect.col + 1))).toBe(false);
				overlay.hide();
			} finally {
				h.stop();
			}
		});
	}

	it("re-renders cached section titles in a new theme after invalidate", async () => {
		const h = await harness(120, { "sidebar.enabled": true });
		const original = theme;
		try {
			h.controller.register({ id: "todo", title: "TODO", content: () => ["task"] });
			h.controller.applySettings();
			await h.settle();
			const light = (await getThemeByName("light")) as Theme;
			expect(light).toBeDefined();
			const darkTitle = theme.fg("accent", "TODO");
			setThemeInstance(light);
			const lightTitle = theme.fg("accent", "TODO");
			expect(lightTitle).not.toBe(darkTitle);
			h.controller.invalidate();
			const frame = h.composer.renderFrame({ columns: 120, rows: 24 });
			expect(frame.viewport.join("\n")).toContain(lightTitle);
		} finally {
			setThemeInstance(original);
			h.stop();
		}
	});
});
