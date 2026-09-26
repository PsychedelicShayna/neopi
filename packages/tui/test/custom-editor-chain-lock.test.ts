import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

describe("CustomEditor chain lock", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("drops typing, routes Escape and Ctrl+C to the lock, and edits again once unlocked", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		const onClear = vi.fn();
		editor.setText("draft");
		editor.setChainLock({ onEscape, onClear });

		editor.handleInput("abc");
		expect(editor.getText()).toBe("draft");

		editor.handleInput("\x1b");
		expect(onEscape).toHaveBeenCalledTimes(1);

		editor.handleInput("\x03");
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("draft");

		editor.setChainLock(undefined);
		editor.handleInput("x");
		expect(editor.getText()).toBe("draftx");
	});

	it("drops dictation that lands while the chain holds the composer", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		editor.setText("draft");
		editor.setChainLock({ onEscape: vi.fn(), onClear: vi.fn() });

		editor.setVolatileText(" spoken");
		editor.commitVolatileText(" spoken");
		editor.insertText(" typed");
		editor.submit();
		expect(editor.getText()).toBe("draft");
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
