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
