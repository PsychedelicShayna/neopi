import { describe, expect, it } from "bun:test";
import { MenuSearchField } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";

const theme = { muted: (text: string) => text };

describe("literal menu search fields", () => {
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

	it("cancels search with Escape and clears the active pattern", () => {
		const field = new MenuSearchField("voice", true);
		expect(field.handleInput("\x1b")).toBe("exited");
		expect(field.value).toBe("");
		expect(field.focused).toBe(false);
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

	it("renders only the search hint when its empty field is not focused", () => {
		const field = new MenuSearchField();
		expect(field.render(80, theme)).toBe("/ search");
		field.focused = true;
		expect(field.render(80, theme)).toContain("Search:");
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
