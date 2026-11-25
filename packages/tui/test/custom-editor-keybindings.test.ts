import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("retries with Ctrl+Alt+R, but not with F5 or Alt+R", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		editor.onRetry = onRetry;

		editor.handleInput("\x1b[15~"); // F5
		editor.handleInput("\x1br"); // Alt+R
		expect(onRetry).not.toHaveBeenCalled();

		editor.handleInput("\x1b[114;7u"); // Ctrl+Alt+R
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	const retryChord = "\x1b[114;7u";

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("ctrl+alt+r", customHandler);
		editor.handleInput(retryChord);

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["ctrl+alt+r"]);
		editor.handleInput(retryChord);

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("routes Ctrl+L to a live-toggle custom handler and Alt+L to display reset by default", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onDisplayReset = vi.fn();
		const onLiveToggle = vi.fn();

		editor.onDisplayReset = onDisplayReset;
		editor.setCustomKeyHandler("ctrl+l", onLiveToggle);

		editor.handleInput("\x0c"); // Ctrl+L
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
		expect(onDisplayReset).not.toHaveBeenCalled();

		editor.handleInput("\x1bl"); // Alt+L
		expect(onDisplayReset).toHaveBeenCalledTimes(1);
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
	});
	it("opens the agent menu on ctrl+d with an empty draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		const menu = vi.fn();
		editor.onAgentMenu = menu;
		editor.handleInput("\x04"); // Ctrl+D
		expect(menu).toHaveBeenCalledTimes(1);
	});

	it("forward-deletes with Ctrl+D and Delete without opening the menu on a draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		const menu = vi.fn();
		editor.onAgentMenu = menu;
		editor.setText("abc");
		editor.moveToLineStart();
		editor.handleInput("\x04");
		expect(menu).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("bc");
		editor.handleInput("\x1b[3~"); // Delete
		expect(menu).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("c");
	});

	it("opens the menu on ctrl+d after the last attachment chip is deleted", () => {
		const editor = new CustomEditor(getEditorTheme());
		const menu = vi.fn();
		editor.onAgentMenu = menu;
		editor.insertTextAttachment("a long pasted blob");
		expect(editor.composerChips()).toHaveLength(1);
		// Deleting the chip token empties the buffer; `pendingTexts` keeps the
		// record so attachment numbering isn't recycled.
		editor.setText("");
		expect(editor.composerChips()).toHaveLength(0);
		editor.handleInput("\x04"); // Ctrl+D
		expect(menu).toHaveBeenCalledTimes(1);
	});

	it("gives Ctrl+D deletion and the agent menu precedence over later handlers on the same chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const menu = vi.fn();
		const onDequeue = vi.fn();
		const customHandler = vi.fn();
		editor.onAgentMenu = menu;
		editor.onDequeue = onDequeue;
		// A later app action and an extension handler both user-bound to Ctrl+D while
		// the default menu binding stays; only explicit user claims are checked for conflicts.
		editor.setActionKeys("app.message.dequeue", ["ctrl+d"]);
		editor.setCustomKeyHandler("ctrl+d", customHandler);
		editor.setText("ab");
		editor.moveToLineStart();
		editor.handleInput("\x04"); // Ctrl+D
		expect(editor.getText()).toBe("b");
		expect(menu).not.toHaveBeenCalled();
		editor.setText("");
		editor.handleInput("\x04");
		expect(menu).toHaveBeenCalledTimes(1);
		expect(onDequeue).not.toHaveBeenCalled();
		expect(customHandler).not.toHaveBeenCalled();
	});

	it("gives Ctrl+D deletion and the agent menu precedence over an earlier base-editor submit binding", () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.input.submit": ["enter", "ctrl+d"] }));
		try {
			const editor = new CustomEditor(getEditorTheme());
			const menu = vi.fn();
			const onSubmit = vi.fn();
			editor.onAgentMenu = menu;
			editor.onSubmit = onSubmit;
			editor.setText("ab");
			editor.moveToLineStart();
			editor.handleInput("\x04"); // Ctrl+D
			expect(editor.getText()).toBe("b");
			expect(menu).not.toHaveBeenCalled();
			editor.setText("");
			editor.handleInput("\x04");
			expect(onSubmit).not.toHaveBeenCalled();
			expect(menu).toHaveBeenCalledTimes(1);
		} finally {
			setKeybindings(previous);
		}
	});

	it("leaves the cursor on a grapheme after Delete in Vim normal mode", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setVimMode(true);
		editor.setText("ab");
		editor.handleInput("\x1b"); // Escape -> Normal, cursor rests on "b"
		editor.handleInput("\x1b[3~");
		expect(editor.getText()).toBe("a");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		editor.handleInput("i");
		editor.handleInput("X");
		expect(editor.getText()).toBe("Xa");
	});

	it("deletes the whole selection and leaves visual mode on Delete", () => {
		// Vim maps Delete to `x`; in Visual mode that takes the selection and returns to Normal.
		// A direct grapheme delete would instead leave the editor in Visual with a stale anchor.
		const editor = new CustomEditor(getEditorTheme());
		editor.setVimMode(true);
		editor.setText("abc");
		editor.handleInput("\x1b"); // Escape -> Normal
		editor.moveToLineStart();
		editor.handleInput("v"); // Visual
		editor.handleInput("l"); // extend over "ab"
		editor.handleInput("\x1b[3~");
		expect(editor.getText()).toBe("c");
		expect(editor.vimMode).toBe("normal");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("cancels a pending character jump on Delete so the next key still types", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("abc");
		editor.moveToLineStart();
		editor.handleInput("\x1d"); // Ctrl+] -> jump forward, awaiting a target character
		editor.handleInput("\x1b[3~");
		editor.handleInput("z");
		expect(editor.getText()).toBe("zbc");
	});

	it("dismisses the spelling-assist popup on Delete", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onAutocompleteUpdate = vi.fn();
		editor.onAutocompleteUpdate = onAutocompleteUpdate;
		editor.setTextAssistProvider({
			getWordReplacements: () => ({ line: 0, startCol: 0, endCol: 3, items: ["the", "ten"] }),
		});
		editor.setText("teh cat");
		editor.moveToLineStart();
		editor.handleInput("\x1b[46;5u"); // Ctrl+. -> spelling replacements
		expect(editor.isShowingAutocomplete()).toBe(true);
		onAutocompleteUpdate.mockClear();
		editor.handleInput("\x1b[3~");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onAutocompleteUpdate).toHaveBeenCalled();
		expect(editor.getText()).toBe("eh cat");
	});

	it("opens the queue body when Delete leaves a bare queue prefix", () => {
		// Deleting back to "->" promotes it to a reserved header line; skipping that leaves the
		// cursor on the Queueing label, so the next characters type into the label instead.
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("->x");
		editor.moveToLineStart();
		editor.handleInput("\x1b[C"); // Right
		editor.handleInput("\x1b[C"); // Right, cursor now before "x"
		editor.handleInput("\x1b[3~");
		expect(editor.getText()).toBe("->\n");
		expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
		editor.handleInput("h");
		editor.handleInput("i");
		expect(editor.getText()).toBe("->\nhi");
	});

	it("honors a remapped menu key with a draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.agent.menu", ["ctrl+q"]);
		const menu = vi.fn();
		editor.onAgentMenu = menu;
		editor.setText("ab");
		editor.handleInput("\x11"); // Ctrl+Q
		expect(menu).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("ab");
	});

	it("keeps the draft and Vim mode when Ctrl+C is repeated", () => {
		const editor = new CustomEditor(getEditorTheme());
		const cancel = vi.fn();
		const menu = vi.fn();
		editor.onCancel = cancel;
		editor.onAgentMenu = menu;
		editor.setVimMode(true);
		editor.setText("draft");
		for (let i = 0; i < 3; i++) editor.handleInput("\x03");
		expect(editor.vimMode).toBe("insert");
		editor.handleInput("\x1b");
		expect(editor.vimMode).toBe("normal");
		expect(cancel).toHaveBeenCalledTimes(3);
		for (let i = 0; i < 3; i++) editor.handleInput("\x03");
		expect(cancel).toHaveBeenCalledTimes(6);
		expect(menu).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");
	});

	it("redoes a Vim change with Alt+U, but not after a different edit", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setVimMode(true);
		editor.setText("abc");
		editor.handleInput("\x1b");
		editor.handleInput("x");
		expect(editor.getText()).toBe("ab");
		editor.handleInput("u");
		expect(editor.getText()).toBe("abc");
		editor.handleInput("\x1bu");
		expect(editor.getText()).toBe("ab");
		editor.handleInput("u");
		editor.handleInput("i");
		editor.handleInput("X");
		editor.handleInput("\x1b");
		editor.handleInput("\x1bu");
		expect(editor.getText()).toBe("abXc");
	});
});

describe("shipped dequeue defaults", () => {
	it("binds both alt+up and shift+up to the steering dequeue", () => {
		const keybindings = KeybindingsManager.inMemory();
		const keys = keybindings.getKeys("app.message.dequeue");
		expect(keys).toContain("alt+up");
		expect(keys).toContain("shift+up");
	});
	it("does not steal shift+up from an explicit user binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.editor.cursorUp": "shift+up",
		});

		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["alt+up"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["shift+up"]);
	});
	it("routes the shipped shift+up default through DEFAULT_ACTION_KEYS to the dequeue handler", () => {
		// F12: the registry test above does not cover DEFAULT_ACTION_KEYS, the second
		// defaults table that custom-editor.ts seeds its match set from. Drive a real
		// editor without calling setActionKeys, so the shipped entry is the only thing
		// that can make the shift+up wire form (CSI 1;2A) reach onDequeue.
		const editor = new CustomEditor(getEditorTheme());
		const onDequeue = vi.fn();

		editor.onDequeue = onDequeue;
		editor.handleInput("\x1b[1;2A");

		expect(onDequeue).toHaveBeenCalledTimes(1);
	});
});

describe("reserved Ctrl+Space", () => {
	it("keeps Ctrl+Space on xAI speech input regardless of user overrides", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.stt.toggle": "f5",
			"app.dictation.toggle": ["ctrl+space", "ctrl+alt+space"],
			"app.history.search": "ctrl+space",
		});

		expect(keybindings.getKeys("app.stt.toggle")).toEqual(["ctrl+space"]);
		expect(keybindings.getKeys("app.dictation.toggle")).toEqual(["ctrl+alt+space"]);
		expect(keybindings.getKeys("app.history.search")).toEqual([]);
		expect(keybindings.matches("\x00", "app.stt.toggle")).toBe(true);
		expect(keybindings.matches("\x00", "app.history.search")).toBe(false);

		keybindings.setUserBindings({ "app.retry": ["ctrl+space", "alt+shift+r"] });
		expect(keybindings.getKeys("app.retry")).toEqual(["alt+shift+r"]);
		expect(keybindings.getKeys("app.stt.toggle")).toEqual(["ctrl+space"]);
	});
});

describe("chain send default", () => {
	it("never claims the bytes terminals send for a newline chord", () => {
		const keybindings = KeybindingsManager.inMemory({});
		// ESC CR: legacy Alt+Enter, and Shift+Enter in terminals mapped to send it (Alacritty, tmux).
		for (const newline of ["\x1b\r", "\x1b[13;2~", "\x1b[13;2u", "\x1b[13;3u", "\n"]) {
			expect(keybindings.matches(newline, "app.message.chain")).toBe(false);
		}
		expect(keybindings.matches("\x1b\x03", "app.message.chain")).toBe(true);
		// Alt+C is reserved for other use; it no longer sends through the chain.
		expect(keybindings.matches("\x1bc", "app.message.chain")).toBe(false);
	});
});
