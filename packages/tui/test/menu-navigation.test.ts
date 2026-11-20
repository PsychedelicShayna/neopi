import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getMenuSearchVimMode,
	MenuKeyReader,
	MenuSearchField,
	MenuViewport,
	setMenuSearchVimMode,
} from "../src/components/menu-navigation";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});

describe("menu keybinding ownership", () => {
	it("leaves Vim aliases unhandled when disabled while preserving conventional navigation", () => {
		setMenuSearchVimMode(false);
		const reader = new MenuKeyReader();
		for (const key of ["h", "j", "k", "l", "H", "J", "K", "L", "g", "G", "\x15", "\x04", "\x05", "\x19"]) {
			expect(reader.read(key)).toBeUndefined();
			expect(reader.pending).toBe(false);
		}
		for (const [key, action] of [
			["\x1b[A", { kind: "move", delta: -1 }],
			["\x1b[B", { kind: "move", delta: 1 }],
			["\x1b[D", { kind: "horizontal", delta: -1 }],
			["\x1b[C", { kind: "horizontal", delta: 1 }],
			["\x1b[H", { kind: "boundary", edge: "first" }],
			["\x1b[F", { kind: "boundary", edge: "last" }],
			["\x1b[5~", { kind: "page", delta: -1 }],
			["\x1b[6~", { kind: "page", delta: 1 }],
			["\t", { kind: "context", delta: 1 }],
			["\x1b[Z", { kind: "context", delta: -1 }],
			["/", { kind: "search" }],
			[" ", { kind: "toggle" }],
			["\r", { kind: "confirm" }],
			["\x1b", { kind: "cancel" }],
		] as const) {
			expect(reader.read(key)).toEqual(action);
		}
	});

	it("enables all Vim motions live and drops pending prefixes when disabled", () => {
		const reader = new MenuKeyReader();
		for (const [key, action] of [
			["j", { kind: "move", delta: 1 }],
			["k", { kind: "move", delta: -1 }],
			["h", { kind: "horizontal", delta: -1 }],
			["l", { kind: "horizontal", delta: 1 }],
			["G", { kind: "boundary", edge: "last" }],
			["\x15", { kind: "halfPage", delta: -1 }],
			["\x04", { kind: "halfPage", delta: 1 }],
			["\x19", { kind: "scroll", delta: -1 }],
			["\x05", { kind: "scroll", delta: 1 }],
		] as const) {
			expect(reader.read(key)).toEqual(action);
		}
		expect(reader.read("g")).toBe("pending");
		expect(reader.read("g")).toEqual({ kind: "boundary", edge: "first" });
		expect(reader.read("g")).toBe("pending");
		setMenuSearchVimMode(false);
		expect(reader.read("g")).toBeUndefined();
		setMenuSearchVimMode(true);
		expect(reader.read("g")).toBe("pending");
	});

	it("keeps explicit non-Vim half-page and scroll bindings usable when Vim is disabled", () => {
		setMenuSearchVimMode(false);
		const reader = new MenuKeyReader(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.halfPageDown": "alt+d",
				"tui.select.scrollUp": "alt+y",
			}),
		);
		expect(reader.read("\x1bd")).toEqual({ kind: "halfPage", delta: 1 });
		expect(reader.read("\x1by")).toEqual({ kind: "scroll", delta: -1 });
	});

	it("honors an injected registry while default readers follow global changes", () => {
		const previous = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "alt+b" }));
			const local = new MenuKeyReader(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "alt+a" }));
			const shared = new MenuKeyReader();
			expect(local.read("\x1ba")).toEqual({ kind: "move", delta: 1 });
			expect(local.read("\x1bb")).toBeUndefined();
			expect(shared.read("\x1bb")).toEqual({ kind: "move", delta: 1 });
			expect(shared.read("\x1ba")).toBeUndefined();

			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "alt+c" }));
			expect(shared.read("\x1bc")).toEqual({ kind: "move", delta: 1 });
			expect(local.read("\x1ba")).toEqual({ kind: "move", delta: 1 });
			expect(local.read("\x1bc")).toBeUndefined();
		} finally {
			setKeybindings(previous);
		}
	});
});

describe("literal menu field typing", () => {
	it("keeps printable bindings literal while sharing editor undo and modal Escape", () => {
		const previous = getKeybindings();
		try {
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.select.cancel": "j",
					"tui.input.submit": "k",
					"tui.editor.deleteCharBackward": "l",
					"tui.select.down": "g",
					"tui.editor.undo": "ctrl+z",
				}),
			);
			const field = new MenuSearchField("", true);
			for (const key of "jklg/") expect(field.handleInput(key)).toBe("edited");
			expect(field.value).toBe("jklg/");
			expect(field.focused).toBe(true);
			expect(field.handleInput("\x1a")).toBe("edited");
			expect(field.value).toBe("jklg");
			expect(field.handleInput("\x1b")).toBe("edited");
			expect(field.handleInput("\x1b")).toBe("exited");
			expect(field.focused).toBe(false);
		} finally {
			setKeybindings(previous);
		}
	});

	it("inserts Kitty text at the caret through the same typing path", () => {
		const field = new MenuSearchField("ab", true);
		field.input.setCursor(1);
		expect(field.handleInput("\x1b[106u")).toBe("edited");
		expect(field.value).toBe("ajb");
		expect(field.cursor).toBe(2);
	});
});

describe("menu viewport visual lines", () => {
	it("clips a leading item one line at a time and keeps snapshots immutable", () => {
		const view = new MenuViewport();
		view.layout([3, 3, 3], 0, 4);
		view.scroll(1);
		expect(view.layout([3, 3, 3], 0, 4)).toEqual({
			startIndex: 0,
			endIndex: 2,
			lineOffset: 1,
			rowOffset: 1,
			totalRows: 9,
		});
		const saved = view.top;
		view.scroll(1);
		expect(view.layout([3, 3, 3], 0, 4).lineOffset).toBe(2);
		expect(saved).toEqual({ item: 0, lineOffset: 1 });
		view.setTop(saved);
		expect(view.layout([3, 3, 3], 0, 4).lineOffset).toBe(1);
		view.reveal();
		expect(view.layout([3, 3, 3], 0, 4).lineOffset).toBe(0);
	});

	it("scrolls within one item taller than the viewport and clamps at its last line window", () => {
		const view = new MenuViewport();
		view.layout([10], 0, 4);
		view.scroll(1);
		expect(view.layout([10], 0, 4).lineOffset).toBe(1);
		view.scroll(20);
		expect(view.layout([10], 0, 4).lineOffset).toBe(6);
		view.scroll(-1);
		expect(view.layout([10], 0, 4).lineOffset).toBe(5);
	});

	it("accepts numeric item-boundary snapshots and preserves single-row scrolling", () => {
		const view = new MenuViewport();
		view.setTop(1);
		expect(view.layout([1, 1, 1, 1, 1], 0, 2)).toMatchObject({ startIndex: 1, lineOffset: 0, rowOffset: 1 });
		view.scroll(1);
		expect(view.layout([1, 1, 1, 1, 1], 0, 2)).toMatchObject({ startIndex: 2, lineOffset: 0, rowOffset: 2 });
		view.scroll(-1);
		expect(view.layout([1, 1, 1, 1, 1], 0, 2)).toMatchObject({ startIndex: 1, lineOffset: 0, rowOffset: 1 });
	});
});
