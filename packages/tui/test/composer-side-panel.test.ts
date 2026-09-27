import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SidePanel } from "@oh-my-pi/pi-tui/chrome/side-panel";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer, type SidePanelDock } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, type ResizeScrollbackMode, Text } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const PANEL_TEXT = "panel task";
const RIGHT: SidePanelDock = { side: "right", width: { ratio: 0.3, min: 32, max: 48 }, splitAt: 110, chatMinWidth: 60 };

/** A 100-column transcript line, so every chat width wraps it differently. */
function ledgerLine(index: number): string {
	const label = `E${String(index).padStart(2, "0")}:`;
	return label + "abcdefghij".repeat(10).slice(label.length);
}

interface Harness {
	term: VirtualTerminal;
	composer: Composer;
	transcript: TranscriptContainer;
	panel: SidePanel;
	writes: string[];
	settle(): Promise<void>;
	/** Native scrollback above the live screen, as plain text rows. */
	history(): string[];
	viewport(): string[];
}

async function setup(
	options: { columns?: number; rows?: number; mode?: ResizeScrollbackMode; entries?: number; chrome?: Component[] } = {},
): Promise<Harness> {
	const rows = options.rows ?? 24;
	const term = new VirtualTerminal(options.columns ?? 120, rows, 5000);
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal: term,
		tuiOptions: { renderScheduler: scheduler },
		preferences: {
			...COMPOSER_DEFAULTS,
			quiet: true,
			resizeScrollback: options.mode ?? "rebuild",
			spellingTypoDetection: false,
			spellingAutocomplete: false,
		},
	});
	const transcript = new TranscriptContainer();
	for (let index = 0; index < (options.entries ?? 0); index++) transcript.addChild(new Text(ledgerLine(index), 0, 0));
	composer.setRuntimeChildren([transcript, ...(options.chrome ?? [new Text("EDITOR", 0, 0)])]);
	composer.start();
	const panel = new SidePanel({ onChange: () => composer.ui.requestRender() });
	panel.register({ id: "todo", title: "TODO", content: () => [PANEL_TEXT] });
	const settle = () => scheduler.settle(term);
	await settle();
	return {
		term,
		composer,
		transcript,
		panel,
		writes,
		settle,
		history: () => {
			const buffer = term.getScrollBuffer();
			return buffer.slice(0, buffer.length - rows).map(row => row.trimEnd());
		},
		viewport: () => term.getViewport().map(row => row.trimEnd()),
	};
}

/** Rows of `rows` that start a ledger entry, keyed by label, in order. */
function entryRows(rows: readonly string[]): string[] {
	return rows.filter(row => /^E\d\d:/.test(row));
}

function labelCounts(rows: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of entryRows(rows)) counts.set(row.slice(0, 4), (counts.get(row.slice(0, 4)) ?? 0) + 1);
	return counts;
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Composer side panel: history and geometry", () => {
	it("retires transcript rows at the painted chat width", async () => {
		const h = await setup({ entries: 4 });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			for (let index = 4; index < 40; index++) h.transcript.addChild(new Text(ledgerLine(index), 0, 0));
			h.composer.ui.requestRender();
			await h.settle();
			const chat = h.composer.sidePanelGeometry()?.chatRect;
			expect(chat?.width).toBe(81);
			const retired = h.history();
			expect(entryRows(retired).length).toBeGreaterThan(0);
			for (const row of retired) {
				expect(row).not.toContain(PANEL_TEXT);
				expect(Bun.stringWidth(row)).toBeLessThanOrEqual(81);
			}
			// A 100-column line wraps at the chat width, both retired and live.
			expect(entryRows(retired).every(row => row.length === 81)).toBe(true);
			const live = h.viewport().filter(row => /^E\d\d:/.test(row));
			expect(live.length).toBeGreaterThan(0);
			for (const row of live) expect(row.slice(0, 81).length).toBe(81);
			expect(live.every(row => row.slice(81, 83) === " │")).toBe(true);
		} finally {
			h.composer.stop();
		}
	});

	it("rebuild replays one copy per chat-width change and none for a side flip or quit", async () => {
		const h = await setup({ entries: 40, mode: "rebuild" });
		try {
			const expectOneCopyAt = (width: number): void => {
				const buffer = [...h.history(), ...h.viewport()];
				for (const count of labelCounts(buffer).values()) expect(count).toBe(1);
				const retired = entryRows(h.history());
				expect(retired.length).toBeGreaterThan(0);
				for (const row of retired) expect(row.length).toBe(Math.min(width, 100));
			};
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			expectOneCopyAt(81);
			h.composer.setSidePanel(h.panel, { ...RIGHT, width: { ratio: 0.4, min: 32, max: 48 } });
			await h.settle();
			expectOneCopyAt(69);

			// Same clamped width (min 30 does not move a 48-column panel): repaint only.
			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, { ...RIGHT, width: { ratio: 0.4, min: 30, max: 48 } });
			await h.settle();
			expect(h.writes.join("")).not.toContain("\x1b[3J");

			// Side flip at an unchanged chat width: no replay, panel at column 0.
			const before = h.history();
			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, { ...RIGHT, side: "left", width: { ratio: 0.4, min: 30, max: 48 } });
			await h.settle();
			expect(h.writes.join("")).not.toContain("\x1b[3J");
			expect(h.history()).toEqual(before);
			expect(h.viewport()[0]).toStartWith("TODO");
			expect(h.composer.sidePanelGeometry()?.panelRect.col).toBe(0);

			h.composer.setSidePanel(undefined);
			await h.settle();
			expectOneCopyAt(120);

			// Teardown: undock without a history refresh — no ED3, scrollback untouched.
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const docked = h.history();
			h.writes.length = 0;
			h.composer.setSidePanel(undefined, undefined, { refreshHistory: false });
			await h.settle();
			expect(h.writes.join("")).not.toContain("\x1b[3J");
			expect(h.history()).toEqual(docked);
		} finally {
			h.composer.stop();
		}
	});

	it("append adds one current-width copy per change and preserve never touches prior scrollback", async () => {
		const append = await setup({ entries: 40, mode: "append" });
		try {
			const initial = labelCounts(append.history());
			append.composer.setSidePanel(append.panel, RIGHT);
			await append.settle();
			const docked = append.history();
			for (const [label, count] of labelCounts(docked)) expect(count).toBe((initial.get(label) ?? 0) + 1);
			const appended = docked.slice(docked.length - entryRows(docked).length);
			expect(entryRows(docked).at(-1)?.length).toBe(81);
			expect(appended.length).toBeGreaterThan(0);

			append.composer.setSidePanel(append.panel, { ...RIGHT, side: "left" });
			await append.settle();
			expect(append.history()).toEqual(docked);
		} finally {
			append.composer.stop();
		}

		const preserve = await setup({ entries: 40, mode: "preserve" });
		try {
			const before = preserve.history();
			preserve.composer.setSidePanel(preserve.panel, RIGHT);
			await preserve.settle();
			preserve.composer.setSidePanel(preserve.panel, { ...RIGHT, width: { ratio: 0.4, min: 32, max: 48 } });
			await preserve.settle();
			preserve.composer.setSidePanel(undefined);
			await preserve.settle();
			expect(preserve.history().slice(0, before.length)).toEqual(before);
			expect(preserve.writes.join("")).not.toContain("\x1b[3J");
		} finally {
			preserve.composer.stop();
		}
	});

	it("coalesces a dock with a pending append replay into one copy at the docked width", async () => {
		const h = await setup({ entries: 40, mode: "append" });
		try {
			const initial = labelCounts(h.history());
			h.composer.ui.refreshHistoryAfterWidthChange();
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const after = h.history();
			for (const [label, count] of labelCounts(after)) expect(count).toBe((initial.get(label) ?? 0) + 1);
			expect(entryRows(after).at(-1)?.length).toBe(81);
		} finally {
			h.composer.stop();
		}
	});

	it("docks at full height: a rebuild reset puts the panel title on row 0 and the transcript at the bottom", async () => {
		const rebuild = await setup({ entries: 3, mode: "rebuild" });
		try {
			rebuild.writes.length = 0;
			rebuild.composer.setSidePanel(rebuild.panel, RIGHT);
			await rebuild.settle();
			expect(rebuild.writes.join("")).toContain("\x1b[3J");
			const view = rebuild.viewport();
			expect(view).toHaveLength(24);
			expect(view[0]?.slice(84)).toStartWith("TODO");
			expect(view.at(-1)).toStartWith("EDITOR");
			// Each 100-column entry wraps to two chat rows; the last one ends just above the editor.
			expect(view.at(-3)).toStartWith("E02:");
			for (const count of labelCounts([...rebuild.history(), ...view]).values()) expect(count).toBe(1);
		} finally {
			rebuild.composer.stop();
		}

		for (const mode of ["append", "preserve"] as const) {
			const h = await setup({ entries: 3, mode });
			try {
				const before = h.history();
				h.composer.setSidePanel(h.panel, RIGHT);
				await h.settle();
				// Nothing was committed above the old viewport (startTop 0), so the
				// full-height write pushes nothing and no replay rows exist yet.
				expect(h.history()).toEqual(before);
				expect(h.viewport()[0]?.slice(84)).toStartWith("TODO");
				expect(h.writes.join("")).not.toContain("\x1b[3J");
			} finally {
				h.composer.stop();
			}
		}
	});

	it("bypasses the split when the terminal is narrower than the dock threshold", async () => {
		for (const [columns, splitAt] of [
			[100, 110],
			[120, 130],
		] as const) {
			const h = await setup({ columns, entries: 5 });
			try {
				const undocked = h.composer.renderFrame({ columns, rows: 24 });
				h.composer.setSidePanel(h.panel, { ...RIGHT, splitAt });
				const narrow = h.composer.renderFrame({ columns, rows: 24 });
				expect(narrow.viewport).toEqual(undocked.viewport);
				expect(narrow.viewport.length).toBeLessThan(24);
				expect(h.composer.sidePanelGeometry()).toBeUndefined();
				expect(h.composer.sidePanelDocked).toBe(false);
			} finally {
				h.composer.stop();
			}
		}
	});
});

class ClickableBlock implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
	invalidate(): void {}
	getClickFocusAgentIds(): string[] {
		return [...this.ids];
	}
}

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width).padEnd(Math.min(width, 20), line.at(-1)));
	}
	invalidate(): void {}
}

describe("Composer side panel: overlays, hover, clicks, cursor", () => {
	it("composites a non-fullscreen overlay across both columns and restores them", async () => {
		const h = await setup({ entries: 5 });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const before = h.term.getViewport();
			const handle = h.composer.ui.showOverlay(new Block(["XXXXXXXXXXXXXXXXXXXX", "YYYYYYYYYYYYYYYYYYYY"]), {
				row: 3,
				col: 72,
				width: 20,
			});
			await h.settle();
			const covered = h.term.getViewport();
			expect(covered[3]?.slice(72, 92)).toBe("X".repeat(20));
			expect(covered[4]?.slice(72, 92)).toBe("Y".repeat(20));
			handle.hide();
			await h.settle();
			expect(h.term.getViewport()).toEqual(before);
		} finally {
			h.composer.stop();
		}
	});

	it("keeps the docked frame behind a fullscreen overlay and restores it on close", async () => {
		const h = await setup({ entries: 5 });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const before = h.term.getViewport();
			h.writes.length = 0;
			const handle = h.composer.ui.showOverlay(new Block(["MODAL"]), { fullscreen: true });
			await h.settle();
			const whileUp = h.writes.join("");
			expect(whileUp).toContain("\x1b[?1049h");
			expect(whileUp).not.toContain(PANEL_TEXT);
			handle.hide();
			await h.settle();
			expect(h.term.getViewport()).toEqual(before);
		} finally {
			h.composer.stop();
		}
	});

	it("bands hovered card rows in the chat column only", async () => {
		const h = await setup({ entries: 2 });
		try {
			h.transcript.addChild(new ClickableBlock(["card one", "card two"], ["AgentA"]));
			h.composer.setSidePanel(h.panel, RIGHT);
			h.composer.setHoveredClickId("AgentA");
			h.composer.ui.requestRender();
			await h.settle();
			const view = h.viewport();
			const cardRows = view.map((row, index) => (row.startsWith("card") ? index : -1)).filter(index => index >= 0);
			expect(cardRows).toHaveLength(2);
			for (const row of cardRows) {
				const banded = h.term.getViewportRowBackgroundColumns(row);
				expect(banded.length).toBeGreaterThan(0);
				expect(Math.max(...banded)).toBeLessThan(81);
			}
		} finally {
			h.composer.stop();
		}
	});

	it("resolves click targets at their painted rows, shifted by the top pad", async () => {
		const h = await setup({ entries: 2 });
		try {
			h.transcript.addChild(new ClickableBlock(["card one", "card two"], ["AgentA"]));
			h.composer.ui.requestRender();
			await h.settle();
			const resolveAll = (): Array<{ text: string; ids: string[] }> => {
				const { top, length } = h.composer.ui.getMutableViewport();
				const view = h.viewport();
				return Array.from({ length }, (_, local) => ({
					text: view[top + local] ?? "",
					ids: h.composer.viewportClickCandidates(local),
				}));
			};
			for (const phase of ["undocked", "docked"] as const) {
				if (phase === "docked") {
					h.composer.setSidePanel(h.panel, RIGHT);
					await h.settle();
				}
				const rows = resolveAll();
				const hits = rows.filter(row => row.ids.includes("AgentA"));
				expect(hits.map(row => row.text.slice(0, 8))).toEqual(["card one", "card two"]);
				for (const row of rows) {
					if (!row.text.startsWith("card")) expect(row.ids).toEqual([]);
				}
				if (phase === "docked") expect(rows).toHaveLength(24);
			}
		} finally {
			h.composer.stop();
		}
	});

	it("places the hardware cursor inside the chat column", async () => {
		const term = new VirtualTerminal(120, 24);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal: term,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, spellingTypoDetection: false, spellingAutocomplete: false },
		});
		composer.setRuntimeChildren([new TranscriptContainer(), composer.editor]);
		composer.start();
		try {
			const panel = new SidePanel();
			panel.register({ id: "todo", title: "TODO", content: () => [PANEL_TEXT] });
			composer.setSidePanel(panel, { ...RIGHT, side: "left" });
			composer.editor.setText("hi");
			composer.ui.requestRender();
			await scheduler.settle(term);
			const chat = composer.sidePanelGeometry()?.chatRect;
			expect(chat?.col).toBe(39);
			const cursor = term.getCursor();
			const row = term.getViewport()[cursor.row] ?? "";
			expect(cursor.col).toBeGreaterThanOrEqual(39);
			expect(cursor.col).toBeLessThan(120);
			// The cursor sits just after the typed text, in the editor's chat-column row.
			expect(row.slice(39, cursor.col)).toContain("hi");
		} finally {
			composer.stop();
		}
	});
});
