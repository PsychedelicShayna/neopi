import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getMenuSearchVimMode,
	MenuSearchField,
	setMenuSearchVimMode,
} from "@oh-my-pi/pi-tui/components/menu-navigation";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";

const theme = { muted: (text: string) => text };

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});

it("cancels in one Escape without Vim, retaining the previously confirmed pattern", () => {
	setMenuSearchVimMode(false);
	const field = new MenuSearchField("old", true);
	field.handleInput(" draft");
	expect(field.query).toBe("old draft");
	expect(field.handleInput("\x1b")).toBe("exited");
	expect(field.focused).toBe(false);
	expect(field.query).toBe("old");
	field.focused = true;
	field.handleInput("\x01");
	field.handleInput("\x0b");
	field.handleInput("\r");
	expect(field.confirmedQuery).toBe("");
	expect(field.focused).toBe(false);
});

describe("transactional Vim menu search", () => {
	it("keeps printable remapped menu keys literal while the field is focused", () => {
		const previous = getKeybindings();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.up": "k",
				"tui.select.cancel": "x",
				"tui.select.confirm": "l",
			}),
		);
		try {
			const field = new MenuSearchField("", true);
			for (const key of ["k", "x", "l"]) expect(field.handleInput(key)).toBe("edited");
			expect(field.value).toBe("kxl");
			expect(field.focused).toBe(true);
			expect(field.handleInput("\r")).toBe("exited");
			expect(field.focused).toBe(false);
			expect(field.value).toBe("kxl");
		} finally {
			setKeybindings(previous);
		}
	});

	it("takes literal text only while focused and confirms it with Enter", () => {
		const field = new MenuSearchField();
		expect(field.handleInput("j")).toBe("pass");
		expect(field.value).toBe("");
		field.focused = true;
		for (const key of ["h", "j", "k", "l", "g", "/", " "]) expect(field.handleInput(key)).toBe("edited");
		expect(field.value).toBe("hjklg/ ");
		expect(field.handleInput("\r")).toBe("exited");
		expect(field.focused).toBe(false);
		expect(field.value).toBe("hjklg/ ");
		expect(field.handleInput("\x1b")).toBe("exited");
		expect(field.value).toBe("");
	});

	it("keeps caret editing and consumes list motions while searching", () => {
		const field = new MenuSearchField("alpha", true);
		expect(field.handleInput("\x01")).toBe("edited");
		expect(field.cursor).toBe(0);
		expect(field.handleInput("\x05")).toBe("edited");
		expect(field.cursor).toBe(5);
		for (const key of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"]) {
			expect(field.handleInput(key)).toBe("edited");
		}
		expect(field.value).toBe("alpha");
		expect(field.focused).toBe(true);
	});

	it("uses Escape for Insert to Normal, then cancels back to the confirmed pattern", () => {
		const field = new MenuSearchField("voice", true);
		field.handleInput(" draft");
		expect(field.query).toBe("voice draft");
		expect(field.confirmedQuery).toBe("voice");
		expect(field.handleInput("\x1b")).toBe("edited");
		expect(field.vimMode).toBe("normal");
		expect(field.focused).toBe(true);
		expect(field.handleInput("\x1b")).toBe("exited");
		expect(field.value).toBe("voice");
		expect(field.query).toBe("voice");
		expect(field.focused).toBe(false);
	});

	it("reuses Vim line operators and confirms empty from Normal mode", () => {
		const field = new MenuSearchField("voice", true);
		for (const key of ["\x1b", "d", "d"]) field.handleInput(key);
		expect(field.value).toBe("");
		expect(field.confirmedQuery).toBe("voice");
		expect(field.handleInput("\r")).toBe("exited");
		expect(field.confirmedQuery).toBe("");
		expect(field.focused).toBe(false);
		field.focused = true;
		field.handleInput("new draft");
		for (const key of ["\x1b", "0", "D", "i", "new"]) field.handleInput(key);
		expect(field.value).toBe("new");
		field.handleInput("\r");
		expect(field.confirmedQuery).toBe("new");
	});

	it("clears and consumes Ctrl-C in either editing mode", () => {
		for (const normal of [false, true]) {
			const field = new MenuSearchField("voice", true);
			if (normal) field.handleInput("\x1b");
			expect(field.handleInput("\x03")).toBe("exited");
			expect(field.query).toBe("");
			expect(field.confirmedQuery).toBe("");
			expect(field.focused).toBe(false);
		}
	});

	it("keeps previous preview results for invalid regex and refuses invalid confirmation", () => {
		const field = new MenuSearchField("", true);
		field.handleInput("/voice");
		expect(field.query).toBe("/voice");
		field.handleInput("[");
		expect(field.query).toBe("/voice");
		expect(field.render(140, theme)).toContain("Invalid regex");
		expect(field.handleInput("\r")).toBe("edited");
		expect(field.focused).toBe(true);
		expect(field.confirmedQuery).toBe("");
	});

	it("restores a literal draft at its caret without selecting or submitting", () => {
		const field = new MenuSearchField("aa", true);
		field.handleInput("\x1b[D");
		const restored = new MenuSearchField();
		restored.restoreNavigation(field.navigationSnapshot());
		expect(restored.handleInput("lph")).toBe("edited");
		expect(restored.value).toBe("alpha");
		expect(restored.cursor).toBe(4);
	});

	it("keeps draft and confirmed patterns separate and discards edits on blur", () => {
		const field = new MenuSearchField("old");
		field.focused = true;
		field.handleInput(" draft");
		expect(field.value).toBe("old draft");
		expect(field.query).toBe("old draft");
		expect(field.confirmedQuery).toBe("old");
		field.focused = false;
		expect(field.value).toBe("old");
		field.focused = true;
		field.handleInput(" confirmed");
		field.handleInput("\r");
		expect(field.query).toBe("old confirmed");
		field.handleInput("\x1b");
		expect(field.query).toBe("");
	});

	it("renders only the search hint when its empty field is not focused", () => {
		const field = new MenuSearchField();
		expect(field.render(80, theme)).toBe("/ search");
		field.focused = true;
		expect(field.render(80, theme)).toContain("Search:");
	});

	it("keeps the confirmed pattern visible with compact harness hints", () => {
		const field = new MenuSearchField("", true);
		field.handleInput("voice");
		field.handleInput("\r");
		const confirmed = field.render(160, theme);
		expect(confirmed).toContain("voice");
		expect(confirmed).toContain("/ search");
		expect(confirmed).toContain("? help");
		expect(confirmed).not.toContain("Enter confirm");
		field.focused = true;
		expect(field.render(160, theme)).toContain("Enter confirm");
	});

	it("renders bounded search hints without raw tabs", () => {
		const field = new MenuSearchField("a\tb long query");
		for (const width of [0, 4, 12, 40]) {
			const line = field.render(width, theme);
			expect(line).not.toContain("\t");
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(field.render(80, theme)).toContain("/ search");
		field.focused = true;
		expect(field.render(80, theme)).toContain("Enter confirm");
	});
});
