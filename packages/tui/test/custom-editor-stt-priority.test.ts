import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Input } from "../src/components/input";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";
import { CustomEditor } from "../src/prompt/custom-editor";
import { SPACE_HOLD_RELEASE_MS } from "../src/space-hold";
import { getEditorTheme, initTheme } from "../src/theme";

describe("fork-owned Ctrl+Space: xAI priority over configured Space gestures", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function editorWithShortcuts() {
		const editor = new CustomEditor(getEditorTheme());
		const xai = vi.fn();
		const configured = vi.fn();
		const end = vi.fn();
		editor.setText("Draft");
		editor.setCustomKeyHandler("ctrl+space", xai);
		editor.setCustomKeyHandler("ctrl+alt+space", configured);
		editor.spaceHold.handler = { enabled: () => true, onStart: configured, onEnd: end };
		return { editor, xai, configured, end };
	}

	it.each(["\x00", "\x1b[32;5u", "\x1b[32;5:1u", "\x1b[27;5;32~"])(
		"quarantines modifier-release Space repeats after %j without blocking the next real Ctrl+Space",
		chord => {
			const { editor, xai, configured } = editorWithShortcuts();
			editor.handleInput(chord);
			for (let i = 0; i < 8; i++) {
				vi.advanceTimersByTime(40);
				editor.handleInput(" ");
			}
			expect(configured).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("Draft");
			editor.handleInput(chord);
			expect(xai).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
			for (let i = 0; i < 4; i++) {
				vi.advanceTimersByTime(40);
				editor.handleInput(" ");
			}
			expect(configured).toHaveBeenCalledTimes(1);
		},
	);

	it("swallows Kitty repeats and modifier transitions, but accepts explicit fresh presses", () => {
		const { editor, xai, configured } = editorWithShortcuts();
		editor.handleInput("\x1b[32;5:1u");
		for (let i = 0; i < 8; i++) {
			vi.advanceTimersByTime(40);
			editor.handleInput(i < 4 ? "\x1b[32;5:2u" : "\x1b[32;1:2u");
		}
		expect(xai).toHaveBeenCalledTimes(1);
		expect(configured).not.toHaveBeenCalled();
		editor.handleInput("\x1b[32;1:3u");
		editor.handleInput("\x1b[32;5:1u");
		expect(xai).toHaveBeenCalledTimes(2);
		editor.handleInput("\x1b[32;1:3u");
		editor.handleInput("\x1b[32;7:1u");
		expect(configured).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"retires an existing configured hold (latched=%s) before dispatch, without transcribing it",
		latched => {
			const { editor, xai, configured, end } = editorWithShortcuts();
			for (let i = 0; i < 4; i++) {
				vi.advanceTimersByTime(40);
				editor.handleInput(" ");
			}
			if (latched) editor.handleInput("\x7f");
			expect(configured).toHaveBeenCalledTimes(1);
			editor.handleInput("\x00");
			expect(xai).toHaveBeenCalledTimes(1);
			expect(end).not.toHaveBeenCalled();
			vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
			editor.handleInput(" ");
			expect(editor.getText()).toBe("Draft ");
			expect(end).not.toHaveBeenCalled();
		},
	);

	it("reaches xAI even while a post-processing chain owns normal composer input", () => {
		const { editor, xai } = editorWithShortcuts();
		editor.setChainLock({ onSkip() {}, onCancel() {} });
		editor.handleInput("\x00");
		expect(xai).toHaveBeenCalledTimes(1);
	});

	it.each(["\x00", "\x1b[32;5u", "\x1b[27;5;32~"])(
		"preserves deliberate overlay word separators after %j starts a new typing gesture",
		chord => {
			const { editor, xai } = editorWithShortcuts();
			const terminal = new VirtualTerminal(60, 12);
			const ui = new TUI(terminal);
			ui.addChild(editor);
			ui.setFocus(editor);
			ui.addInputListener(data => (editor.handleSpeechShortcut(data) ? { consume: true } : undefined));
			const input = new Input();
			const overlay = ui.showOverlay(input);
			try {
				ui.start();
				terminal.sendInput(chord);
				for (const key of ["a", " ", "b"]) {
					vi.advanceTimersByTime(20);
					terminal.sendInput(key);
				}
				expect(xai).toHaveBeenCalledTimes(1);
				expect(input.getValue()).toBe("a b");
				expect(editor.getText()).toBe("Draft");
			} finally {
				overlay.hide();
				ui.stop();
			}
		},
	);
});
