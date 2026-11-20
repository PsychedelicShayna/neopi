import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { afterEach, describe, expect, it, beforeEach } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Form, SelectFormField, TextFormField } from "@oh-my-pi/pi-tui/components/form";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";

const theme = {
	label: (text: string) => text,
	description: (text: string) => text,
	error: (text: string) => text,
	hint: (text: string) => text,
};

function field(secret = false): TextFormField {
	return new TextFormField({ theme, secret, initialValue: "draft", onSubmit: () => {}, onCancel: () => {} });
}

afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("form menu history", () => {
	it("returns a standalone choice's search to its list before canceling the form", () => {
		let cancelled = 0;
		const choices = new SelectFormField({
			theme,
			items: [
				{ value: "literal", label: "literal" },
				{ value: "other", label: "other" },
			],
			maxVisible: 1,
			selectTheme: getSelectListTheme(),
			onSubmit: () => {},
			onCancel: () => cancelled++,
		});
		const form = new Form({ fields: [choices], onCancel: () => cancelled++ });
		form.handleInput("/");
		form.handleInput("literal");
		form.handleInput("\x1b");
		expect(cancelled).toBe(0);
		expect(choices.selectList.filterFocused).toBe(true);
		form.handleInput("\x1b");
		expect(cancelled).toBe(0);
		expect(choices.selectList.filterFocused).toBe(false);
		expect(choices.selectList.getFilter()).toBe("");
		form.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	it("restores ordinary draft text, caret and focused field without submitting", () => {
		const first = field();
		const second = field();
		const form = new Form({ fields: [first, second], onCancel: () => {} });
		form.focused = true;
		form.handleInput("\t");
		second.input.setCursor(2);
		const saved = form.navigationSnapshot();
		form.handleInput("hjklgG / ");
		form.handleInput("\x1b[Z");
		form.restoreNavigation(saved);
		expect(second.focused).toBe(true);
		expect(first.focused).toBe(false);
		form.handleInput("X");
		expect(second.getValue()).toBe("drXaft");
	});

	it("types printable cancel, submit, delete and context bindings literally", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["j", "space"],
				"tui.input.submit": ["k"],
				"tui.editor.deleteCharBackward": ["backspace", "h"],
				"tui.editor.deleteCharForward": ["delete", "/"],
				"tui.select.nextContext": ["tab", "g"],
				"tui.select.prevContext": ["shift+tab", "l"],
			}),
		);
		let submitted = 0;
		let cancelled = 0;
		const first = new TextFormField({
			theme,
			onSubmit: () => {
				submitted++;
			},
			onCancel: () => {
				cancelled++;
			},
		});
		const second = field();
		const form = new Form({
			fields: [first, second],
			onCancel: () => {
				cancelled++;
			},
		});
		form.focused = true;
		for (const character of "hjklggG / ") form.handleInput(character);
		expect(first.getValue()).toBe("hjklggG / ");
		expect(first.focused).toBe(true);
		expect(second.focused).toBe(false);
		expect(submitted).toBe(0);
		expect(cancelled).toBe(0);
		form.handleInput("\r");
		expect(submitted).toBe(1);
		form.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	it("keeps physical submit and cancel on standalone literal text fields", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["j"],
				"tui.input.submit": ["k"],
			}),
		);
		const submitted: string[] = [];
		let cancelled = 0;
		const text = new TextFormField({
			theme,
			onSubmit: value => {
				submitted.push(value);
			},
			onCancel: () => {
				cancelled++;
			},
		});
		text.handleInput("j");
		text.handleInput("k");
		expect(submitted).toEqual([]);
		expect(cancelled).toBe(0);
		text.handleInput("\r");
		expect(submitted).toEqual(["jk"]);
		text.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	it("never snapshots or restores credential field contents", () => {
		const secret = field(true);
		expect(secret.navigationSnapshot()).toBeUndefined();
		secret.setValue("new credential");
		secret.restoreNavigation({ value: "stale credential", cursor: 0 });
		expect(secret.getValue()).toBe("new credential");
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
