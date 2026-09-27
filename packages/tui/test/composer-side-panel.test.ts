import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	getInlineImagePresentation,
	Image,
	type ImageBudget,
	setInlineImagePresentation,
} from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { SidePanel } from "@oh-my-pi/pi-tui/chrome/side-panel";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer, type SidePanelDock } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, type ResizeScrollbackMode, type TerminalFramePlan, Text, TUI } from "@oh-my-pi/pi-tui";
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
	scheduler: VirtualRenderScheduler;
	settle(): Promise<void>;
	/** Native scrollback above the live screen, as plain text rows. */
	history(): string[];
	viewport(): string[];
}

async function setup(
	options: {
		columns?: number;
		rows?: number;
		mode?: ResizeScrollbackMode;
		entries?: number;
		chrome?: Component[];
	} = {},
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
		scheduler,
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

	it("docking before the first paint leaves the parent terminal's scrollback alone", async () => {
		const term = new VirtualTerminal(120, 24, 5000);
		for (let index = 0; index < 40; index++) term.write(`shell line ${index}\r\n`);
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
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, resizeScrollback: "rebuild" },
		});
		const panel = new SidePanel();
		composer.setRuntimeChildren([new TranscriptContainer(), new Text("EDITOR", 0, 0)]);
		// InteractiveMode.init configures the panel before it starts the composer.
		composer.setSidePanel(panel, RIGHT);
		composer.start({ clearScrollback: false });
		try {
			await scheduler.settle(term);
			expect(composer.sidePanelDocked).toBe(true);
			const written = writes.join("");
			expect(written).not.toContain("\x1b[3J");
			expect(written).not.toContain("\x1b[2J");
			expect(term.getScrollBuffer().some(row => row.startsWith("shell line 0"))).toBe(true);
		} finally {
			composer.stop();
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
	it("paints the divider at the join column on every row, status line included", async () => {
		const esc = String.fromCharCode(27);
		// A status-line-shaped row: background SGR left open, an OSC 8 hyperlink,
		// wide glyphs, and rule characters running past the chat width.
		const status = `${esc}[48;2;15;18;22m π > ${esc}]8;;file:///tmp${esc}\\🌳 repo${esc}]8;;${esc}\\ ▶${"─".repeat(200)}`;
		const h = await setup({ entries: 3, chrome: [new Text("EDITOR", 0, 0), new Text(status, 0, 0)] });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const dividerCol = h.composer.sidePanelGeometry()?.dividerCol;
			expect(dividerCol).toBe(81);
			const view = h.term.getViewport();
			expect(view.some(row => row.includes("π >"))).toBe(true);
			for (const row of view) {
				// Divider cells " │" at columns 81–82 (the VT trims trailing blanks).
				let col = 0;
				let found = "";
				for (const ch of row) {
					if (col >= 81 && col < 83) found += ch;
					col += Bun.stringWidth(ch);
				}
				expect(found).toBe(" │");
			}
		} finally {
			h.composer.stop();
		}
	});

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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

interface KittyCommand {
	a: string | undefined;
	d: string | undefined;
	i: number;
	p: number | undefined;
}

/** Every Kitty graphics command in `data`, in order. */
function kittyCommands(data: string): KittyCommand[] {
	const commands: KittyCommand[] = [];
	for (const match of data.matchAll(/\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\/g)) {
		const fields = new Map(match[1]!.split(",").map(field => field.split("=") as [string, string]));
		commands.push({
			a: fields.get("a"),
			d: fields.get("d"),
			i: Number(fields.get("i")),
			p: fields.has("p") ? Number(fields.get("p")) : undefined,
		});
	}
	return commands;
}

/** A transcript image block; `live` keeps it an active (non-retirable) block. */
class ImageBlock implements Component {
	readonly image: Image;
	constructor(
		budget: ImageBudget,
		key: string,
		rows: number,
		private readonly live = false,
	) {
		this.image = new Image(
			PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: rows, maxHeightCells: rows, budget, imageKey: key },
			{ widthPx: rows * 10, heightPx: rows * 10 },
		);
	}
	isTranscriptBlockFinalized(): boolean {
		return !this.live;
	}
	render(width: number): readonly string[] {
		return this.image.render(width);
	}
	invalidate(): void {
		this.image.invalidate();
	}
}

describe("Composer side panel: inline images", () => {
	const terminal = TERMINAL as unknown as { id: string; imageProtocol: ImageProtocol | null };
	const originalProtocol = TERMINAL.imageProtocol;
	const originalId = TERMINAL.id;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCells: CellDimensions;

	beforeEach(() => {
		originalCells = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		terminal.id = "xterm";
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCells);
		terminal.imageProtocol = originalProtocol;
		terminal.id = originalId;
		setKittyGraphics(originalGraphics);
	});

	function idOf(h: Harness, key: string): number {
		return h.composer.ui.imageBudget.acquireId(key);
	}

	/**
	 * Whether the terminal holds a placement of `id`. The VT engine reports a
	 * placement's row as of its emission (scrolling does not move it), so
	 * presence is the observable; rows are asserted through the painted text.
	 */
	function placed(h: Harness, id: number): boolean {
		return h.term.graphicsPlacements().some(placement => placement.imageId === id);
	}

	for (const mode of ["append", "preserve"] as const) {
		it(`(1) ${mode}: deletes a fully live placement once with d=i and re-places it without a retransmit`, async () => {
			const h = await setup({ entries: 2, mode });
			try {
				h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "one", 4));
				h.composer.ui.requestRender();
				await h.settle();
				const id = idOf(h, "one");
				expect(placed(h, id)).toBe(true);
				const placementId = h.term.graphicsPlacements().find(placement => placement.imageId === id)?.placementId;

				h.writes.length = 0;
				h.composer.setSidePanel(h.panel, RIGHT);
				await h.settle();
				const dock = kittyCommands(h.writes.join(""));
				expect(dock.filter(command => command.a === "d")).toEqual([{ a: "d", d: "i", i: id, p: placementId }]);
				expect(placed(h, id)).toBe(false);
				expect(h.viewport().some(row => row.includes("image/png"))).toBe(true);

				h.writes.length = 0;
				h.composer.setSidePanel(undefined);
				await h.settle();
				const undock = kittyCommands(h.writes.join(""));
				expect(undock.some(command => command.a === "p" && command.i === id)).toBe(true);
				expect(undock.some(command => (command.a === "t" || command.a === "T") && command.i === id)).toBe(false);
				expect(placed(h, id)).toBe(true);
			} finally {
				h.composer.stop();
			}
		});
	}

	it("(1b)(3)(4) rebuild: the dock reset deletes all, docked images stay text, undock retransmits", async () => {
		const h = await setup({ entries: 2, mode: "rebuild" });
		try {
			h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "one", 4));
			h.composer.ui.requestRender();
			await h.settle();
			const id = idOf(h, "one");
			expect(placed(h, id)).toBe(true);

			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const dock = kittyCommands(h.writes.join(""));
			expect(dock.some(command => command.a === "d" && command.d === "A")).toBe(true);
			expect(dock.some(command => command.a === "d" && command.d === "i")).toBe(false);
			expect(dock.some(command => command.a === "p")).toBe(false);
			expect(h.term.graphicsPlacements()).toEqual([]);
			expect(h.viewport().some(row => row.includes("image/png"))).toBe(true);

			// (3) An image arriving while docked renders text and places nothing.
			h.writes.length = 0;
			h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "two", 3));
			h.composer.ui.requestRender();
			await h.settle();
			const second = idOf(h, "two");
			expect(kittyCommands(h.writes.join("")).filter(command => command.i === second)).toEqual([]);
			expect(h.term.graphicsPlacements()).toEqual([]);

			// (4) Undock: the reset dropped transmit tracking, so the replay re-sends the data.
			h.writes.length = 0;
			h.composer.setSidePanel(undefined);
			await h.settle();
			const undock = kittyCommands(h.writes.join(""));
			for (const image of [id, second]) {
				expect(undock.some(command => command.a === "t" && command.i === image)).toBe(true);
				expect(undock.some(command => command.a === "p" && command.i === image)).toBe(true);
				expect(placed(h, image)).toBe(true);
			}
		} finally {
			h.composer.stop();
		}
	});

	it("(1c) an image introduced by a scrolling paint is live and deleted once on dock", async () => {
		const h = await setup({ entries: 30, mode: "append" });
		try {
			const before = h.history().length;
			h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "scroll", 6));
			h.composer.ui.requestRender();
			await h.settle();
			expect(h.history().length).toBeGreaterThan(before);
			const id = idOf(h, "scroll");
			expect(placed(h, id)).toBe(true);

			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const deletes = kittyCommands(h.writes.join("")).filter(command => command.a === "d");
			expect(deletes).toEqual([{ a: "d", d: "i", i: id, p: 1 }]);
			expect(placed(h, id)).toBe(false);
		} finally {
			h.composer.stop();
		}
	});

	it("(1d) an image first drawn mid-scroll records its post-scroll row and is deleted once on dock", async () => {
		const h = await setup({ rows: 10, mode: "append" });
		try {
			// One paint: 20 one-row entries retire while a 5-row image lands at viewport rows 0–4.
			for (let index = 0; index < 20; index++) h.transcript.addChild(new Text(`S${index}`, 0, 0));
			h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "mid", 5));
			for (let index = 0; index < 2; index++) h.transcript.addChild(new Text(`T${index}`, 0, 0));
			h.writes.length = 0;
			h.composer.ui.requestRender();
			await h.settle();
			const id = idOf(h, "mid");
			const placement = h.term.graphicsPlacements().find(entry => entry.imageId === id);
			expect(placement?.numRows).toBe(5);
			// The entries retired above; the block's reserved rows fill viewport rows 0–4.
			expect(h.history().filter(row => /^S\d+$/.test(row))).toHaveLength(20);
			expect(h.viewport()).toEqual(["", "", "", "", "", "", "T0", "", "T1", "EDITOR"]);

			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, { ...RIGHT, splitAt: 100 });
			await h.settle();
			const deletes = kittyCommands(h.writes.join("")).filter(command => command.a === "d");
			expect(deletes).toEqual([{ a: "d", d: "i", i: id, p: placement?.placementId }]);
		} finally {
			h.composer.stop();
		}
	});

	for (const mode of ["append", "preserve"] as const) {
		it(`(2) ${mode}: an image scrolled into scrollback is never deleted on dock`, async () => {
			const h = await setup({ entries: 2, mode });
			try {
				h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "archived", 4));
				h.composer.ui.requestRender();
				await h.settle();
				const id = idOf(h, "archived");
				for (let index = 2; index < 40; index++) h.transcript.addChild(new Text(ledgerLine(index), 0, 0));
				h.composer.ui.requestRender();
				await h.settle();
				// The block's rows (after two entries) are now far above the live screen.
				expect(entryRows(h.history()).length).toBeGreaterThan(20);
				expect(placed(h, id)).toBe(true);
				const history = h.history();

				h.writes.length = 0;
				h.composer.setSidePanel(h.panel, RIGHT);
				await h.settle();
				const deletes = kittyCommands(h.writes.join("")).filter(command => command.a === "d");
				expect(deletes).toEqual([]);
				expect(placed(h, id)).toBe(true);
				expect(h.history().slice(0, history.length)).toEqual(history);
			} finally {
				h.composer.stop();
			}
		});
	}

	it("a native height shrink leaves a placement's old epoch untouched by the dock", async () => {
		const h = await setup({ entries: 2, mode: "append" });
		try {
			h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "shrink", 4));
			h.composer.ui.requestRender();
			await h.settle();
			const id = idOf(h, "shrink");
			const before = h.term.graphicsPlacements().find(entry => entry.imageId === id);
			expect(before).toBeDefined();
			const epoch = before?.placementId;

			// The terminal shrinks under the frame: its reflow may push the image's
			// top rows into scrollback, a move no paint accounted for.
			h.writes.length = 0;
			h.term.resize(120, 6);
			await h.scheduler.advance(h.term, 500);
			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, { ...RIGHT, splitAt: 100 });
			await h.scheduler.advance(h.term, 500);
			const deletes = kittyCommands(h.writes.join("")).filter(command => command.a === "d");
			// No delete of any kind may target the placement the shrink moved.
			expect(deletes.filter(command => command.i === id && (command.p === epoch || command.d === "I"))).toEqual([]);
		} finally {
			h.composer.stop();
		}
	});

	it("(2b) a placement known only from a resize-buffer paint is never deleted on dock", async () => {
		const h = await setup({ entries: 2, mode: "append" });
		try {
			h.writes.length = 0;
			h.term.resize(118, 24);
			await h.settle();
			// The terminal borrowed the alternate buffer for the resize; the image is first
			// placed there, with no normal-screen attach row.
			h.transcript.addChild(new ImageBlock(h.composer.ui.imageBudget, "alt", 3));
			h.composer.ui.requestRender();
			await h.settle();
			const id = idOf(h, "alt");
			const borrowed = h.writes.join("");
			expect(borrowed).toContain("\x1b[?1049h");
			expect(kittyCommands(borrowed).some(command => command.a === "p" && command.i === id)).toBe(true);

			h.writes.length = 0;
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.scheduler.advance(h.term, 500);
			const settled = h.writes.join("");
			expect(settled).toContain("\x1b[?1049l");
			expect(h.composer.sidePanelDocked).toBe(true);
			expect(kittyCommands(settled).filter(command => command.a === "d")).toEqual([]);
			expect(h.viewport().some(row => row.includes("image/png"))).toBe(true);
		} finally {
			h.composer.stop();
		}
	});

	it("(6) an image in a fullscreen overlay above the dock renders as a graphic", async () => {
		const h = await setup({ entries: 2, mode: "append" });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			const modal = new ImageBlock(h.composer.ui.imageBudget, "modal", 4);
			h.writes.length = 0;
			const handle = h.composer.ui.showOverlay(modal, { fullscreen: true });
			await h.settle();
			const id = idOf(h, "modal");
			const commands = kittyCommands(h.writes.join(""));
			expect(commands.some(command => command.a === "p" && command.i === id)).toBe(true);
			handle.hide();
			await h.settle();
			expect(h.composer.sidePanelDocked).toBe(true);
		} finally {
			h.composer.stop();
		}
	});
});

describe("Composer side panel: raw SIXEL passthrough", () => {
	const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
	const originalProtocol = TERMINAL.imageProtocol;
	const originalForce = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllow = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const PAYLOAD = "\x1bPq#0;2;0;0;0\n#1~~~~-\n#1@@@@-\n#0????\x1b\\";
	const LABEL = "[image omitted while docked]";

	beforeEach(() => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
	});

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
		if (originalForce === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForce;
		if (originalAllow === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllow;
	});

	function bash(h: Harness, complete: boolean): BashExecutionComponent {
		const block = new BashExecutionComponent("printf sixel", h.composer.ui, false);
		block.appendOutput(`before\n${PAYLOAD}\nafter`);
		if (complete) block.setComplete(0, false);
		h.transcript.addChild(block);
		h.composer.ui.requestRender();
		return block;
	}

	/** Chat-column text of a docked viewport row. */
	const chat = (row: string | undefined): string => (row ?? "").slice(0, 81).trim();
	const raw = (data: string): boolean => data.includes("\x1bPq") || data.includes("~~~~") || data.includes("@@@@");

	it("(5a)(5c) docked: label plus blanks live, in retirement, and in a rebuild replay", async () => {
		const h = await setup({ entries: 1, mode: "rebuild" });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			h.writes.length = 0;
			bash(h, true);
			await h.settle();
			const view = h.viewport();
			const label = view.findIndex(row => chat(row) === LABEL);
			expect(label).toBeGreaterThan(0);
			expect(view.slice(label + 1, label + 4).map(chat)).toEqual(["", "", ""]);
			expect(chat(view[label + 4])).toBe("after");
			expect(raw(h.writes.join(""))).toBe(false);

			// (5c) Retire the block while docked, then rebuild: both copies are label + blanks.
			for (let index = 1; index < 30; index++) h.transcript.addChild(new Text(ledgerLine(index), 0, 0));
			h.composer.ui.requestRender();
			await h.settle();
			const retired = h.history().map(row => row.trim());
			const at = retired.indexOf(LABEL);
			expect(at).toBeGreaterThanOrEqual(0);
			expect(retired.slice(at + 1, at + 4)).toEqual(["", "", ""]);
			h.composer.setSidePanel(h.panel, { ...RIGHT, width: { ratio: 0.4, min: 32, max: 48 } });
			await h.settle();
			const replayed = h.history().map(row => row.trim());
			expect(replayed.filter(row => row === LABEL)).toHaveLength(1);
			expect(raw(h.writes.join(""))).toBe(false);
		} finally {
			h.composer.stop();
		}
	});

	it("(5b) docked: a clipped payload head leaves blank rows, never raw continuation bytes", async () => {
		const probe = await setup({ entries: 0 });
		let rows: number;
		try {
			probe.composer.setSidePanel(probe.panel, RIGHT);
			bash(probe, false);
			await probe.settle();
			const view = probe.viewport();
			const top = view.findIndex(row => chat(row).startsWith("─"));
			const label = view.findIndex(row => chat(row) === LABEL);
			// Rows the block occupies from two below its label to the bottom of the chat column.
			rows = 24 - top - (label - top + 2);
		} finally {
			probe.composer.stop();
		}
		const h = await setup({ rows, entries: 0 });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			h.writes.length = 0;
			bash(h, false);
			await h.settle();
			const view = h.viewport().map(chat);
			expect(view).not.toContain(LABEL);
			expect(view.slice(0, 2)).toEqual(["", ""]);
			expect(view).toContain("after");
			expect(raw(h.writes.join(""))).toBe(false);
		} finally {
			h.composer.stop();
		}
	});

	it("docked: a streamed payload longer than the retention cap never leaks continuation rows", async () => {
		const h = await setup({ entries: 1, mode: "append" });
		try {
			h.composer.setSidePanel(h.panel, RIGHT);
			await h.settle();
			h.writes.length = 0;
			// 150 payload rows: the streaming cap keeps only the last 100, so the
			// retained rows no longer include the DCS start. Not completed.
			const rows = ["\x1bPq#0;2;0;0;0", ...Array.from({ length: 148 }, () => "#1~~~~-"), "#0????\x1b\\"];
			const block = new BashExecutionComponent("printf big-sixel", h.composer.ui, false);
			block.appendOutput(`before\n${rows.join("\n")}\nafter`);
			h.transcript.addChild(block);
			h.composer.ui.requestRender();
			await h.settle();
			for (let index = 1; index < 30; index++) h.transcript.addChild(new Text(ledgerLine(index), 0, 0));
			h.composer.ui.requestRender();
			await h.settle();
			expect(raw(h.writes.join(""))).toBe(false);
			// The text after the payload still paints: only payload rows were blanked.
			expect(Bun.stripANSI(h.writes.join(""))).toContain("after");
			expect([...h.history(), ...h.viewport()].some(row => row.includes("~~~~") || row.includes("????"))).toBe(
				false,
			);

			// Completed and undocked, the surviving raw rows pass through again.
			block.setComplete(0, false);
			h.writes.length = 0;
			h.composer.setSidePanel(undefined);
			await h.settle();
			expect(h.writes.join("")).toContain("#1~~~~-");
		} finally {
			h.composer.stop();
		}
	});

	it("(5d) undocked: all four payload rows pass through live and on retirement", async () => {
		const h = await setup({ entries: 1, mode: "append" });
		try {
			h.writes.length = 0;
			bash(h, true);
			await h.settle();
			const live = h.writes.join("");
			for (const row of PAYLOAD.split("\n")) expect(live).toContain(row);
			h.writes.length = 0;
			for (let index = 1; index < 30; index++) h.transcript.addChild(new Text(ledgerLine(index), 0, 0));
			h.composer.ui.requestRender();
			await h.settle();
			const retired = h.writes.join("");
			for (const row of PAYLOAD.split("\n")) expect(retired).toContain(row);
			expect(retired).not.toContain(LABEL);
		} finally {
			h.composer.stop();
		}
	});
});

/**
 * Scripted provider; these configurations are unreachable through Composer
 * today because blocks holding an Image retire whole. They pin the placement
 * accounting contract for a future producer or retirement policy that could
 * reach them, driving real TUI paints with a real Image and ImageBudget.
 */
describe("Composer side panel: placement accounting (scripted provider)", () => {
	const terminal = TERMINAL as unknown as { id: string; imageProtocol: ImageProtocol | null };
	const originalProtocol = TERMINAL.imageProtocol;
	const originalId = TERMINAL.id;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCells: CellDimensions;

	beforeEach(() => {
		originalCells = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		terminal.id = "xterm";
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCells);
		terminal.imageProtocol = originalProtocol;
		terminal.id = originalId;
		setKittyGraphics(originalGraphics);
	});

	function scripted(height: number) {
		const term = new VirtualTerminal(40, height, 1000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		let plan: () => TerminalFramePlan = () => ({ viewport: [] });
		let nextId = 1;
		tui.setFrameProvider({ renderFrame: () => plan(), acknowledgeHistory: () => {} });
		const image = new Image(
			PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 5, maxHeightCells: 5, budget: tui.imageBudget, imageKey: "scripted" },
			{ widthPx: 40, heightPx: 40 },
		);
		const id = tui.imageBudget.acquireId("scripted");
		const paint = async (next: (image: readonly string[]) => { history?: string[]; viewport: string[] }) => {
			const historyId = nextId++;
			plan = () => {
				const frame = next(image.render(40));
				return {
					viewport: frame.viewport,
					history: frame.history === undefined ? undefined : { id: historyId, rows: frame.history },
				};
			};
			tui.requestRender();
			await scheduler.settle(term);
		};
		/** The docked composition: a replay rendered with images as text, scoped like the composer's. */
		const dockedReplay = async (ledger: (image: readonly string[]) => string[]) => {
			const historyId = nextId++;
			plan = () => {
				const previous = getInlineImagePresentation();
				setInlineImagePresentation("text");
				try {
					return {
						viewport: ["EDITOR"],
						history: { id: historyId, rows: ledger(image.render(40)), kind: "replay" },
					};
				} finally {
					setInlineImagePresentation(previous);
				}
			};
			writes.length = 0;
			tui.requestRender();
			await scheduler.settle(term);
			expect(getInlineImagePresentation()).toBe("graphics");
			return kittyCommands(writes.join(""));
		};
		tui.start();
		return { term, tui, id, paint, dockedReplay, settle: () => scheduler.settle(term) };
	}

	const lines = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

	it("(2c) a placement whose line retired into history is rebased by later scrolls", async () => {
		const s = scripted(12);
		try {
			await s.settle();
			// Block top at physical row 5.
			await s.paint(image => ({ viewport: [...lines("a", 5), ...image, "b0", "EDITOR"] }));
			expect(s.term.graphicsPlacements().some(entry => entry.imageId === s.id)).toBe(true);
			// Its APC line retires in a 10-row batch while the screen scrolls 2 (5 → 3, still live).
			await s.paint(image => ({ history: [...lines("a", 5), ...image], viewport: ["b0", "c0", "c1", "EDITOR"] }));
			// A further paint scrolls 4 (3 → −1): its top rows reach scrollback.
			await s.paint(() => ({ history: ["b0"], viewport: [...lines("c", 6), "EDITOR"] }));
			const commands = await s.dockedReplay(image => [...lines("a", 5), ...image, "b0"]);
			expect(commands.filter(command => command.a === "d")).toEqual([]);
			expect(s.term.graphicsPlacements().some(entry => entry.imageId === s.id)).toBe(true);
		} finally {
			s.tui.stop();
		}
	});

	it("(1d twin) a placement whose top scrolls off in the paint that draws it is archived at emit", async () => {
		const s = scripted(10);
		try {
			await s.paint(() => ({ viewport: ["EDITOR"] }));
			// 20 history rows retire while the block's APC lands at viewport index 1 (rows −3..1).
			await s.paint(image => ({
				history: lines("h", 20),
				viewport: [...image.slice(-2), ...lines("t", 7), "EDITOR"],
			}));
			expect(s.term.graphicsPlacements().some(entry => entry.imageId === s.id)).toBe(true);
			const commands = await s.dockedReplay(image => [...lines("h", 20), ...image, ...lines("t", 7)]);
			expect(commands.filter(command => command.a === "d")).toEqual([]);
		} finally {
			s.tui.stop();
		}
	});
});
