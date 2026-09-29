import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const ENTER = "\r";
const ESC = "\x1b";

function codeEditor(vim: boolean): { editor: Editor; submitted: string[] } {
	const editor = new Editor(defaultEditorTheme);
	if (vim) editor.setVimMode(true);
	editor.enterInsertsNewline = true;
	const submitted: string[] = [];
	editor.onSubmit = text => {
		submitted.push(text);
	};
	return { editor, submitted };
}

describe("Editor enterInsertsNewline (REPL mode)", () => {
	it("inserts a newline on Enter instead of submitting", () => {
		const { editor, submitted } = codeEditor(false);
		editor.handleInput("const a = 1;");
		editor.handleInput(ENTER);
		editor.handleInput("a + 1");
		expect(editor.getText()).toBe("const a = 1;\na + 1");
		expect(submitted).toEqual([]);
	});

	it("inserts a newline from Vim Insert mode", () => {
		const { editor, submitted } = codeEditor(true);
		editor.handleInput("x = 1");
		editor.handleInput(ENTER);
		editor.handleInput("y = 2");
		expect(editor.getText()).toBe("x = 1\ny = 2");
		expect(submitted).toEqual([]);
	});

	it("moves down a line from Vim Normal mode without editing or submitting", () => {
		const { editor, submitted } = codeEditor(true);
		editor.setText("first\nsecond");
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput(ENTER);
		expect(editor.getText()).toBe("first\nsecond");
		expect(editor.getCursor().line).toBe(1);
		expect(editor.vimMode).toBe("normal");
		expect(submitted).toEqual([]);
	});

	it("still submits a one-line slash command on Enter", () => {
		const { editor, submitted } = codeEditor(true);
		editor.handleInput("/repl agent");
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["/repl agent"]);
	});

	it("still submits through submit() for the host's run key", () => {
		const { editor, submitted } = codeEditor(true);
		editor.setText("print(1)\nprint(2)");
		editor.submit();
		expect(submitted).toEqual(["print(1)\nprint(2)"]);
	});
});
