import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { KillRing } from "../kill-ring";
import type { TspInputProps } from "@oh-my-pi/pi-wire";
import { node } from "../native/describe";
import { sameProps } from "../native/memo";
import { plainText } from "../native/spans";
import {
	clampTextOffset,
	type DescribeContext,
	type NativeNode,
	type NativeTextEdit,
	type NativeUiEvent,
	resolveTextEdit,
} from "../native/node";
import { getEditorTheme } from "../theme/tui-adapters";
import { SpaceHoldGesture } from "../space-hold";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import type { VimMode } from "../vim";
import { getMenuSearchVimMode } from "../vim-preference";
import { Editor } from "./editor";
import { cursorColumnWindow } from "./scroll-viewport";
import {
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceWithWidth,
	visibleWidth,
} from "../utils";

const segmenter = getSegmenter();

/**
 * Clean text entering the single-line value from outside the keyboard (pastes, dictation) —
 * decode tmux's re-encoded control bytes (both extended-keys formats, e.g. Ctrl+J → "\n") back to
 * literal bytes so the escape tail does not leak in, remove newlines/carriage returns, expand tabs,
 * NFC-normalize, then strip any remaining control bytes. The decoder can synthesize Ctrl+A..Ctrl+Z
 * (0x01..0x1A) from a paste, and a single-line value must hold none of them — newlines are already
 * gone and tabs are already spaces by the time the C0/DEL strip runs.
 *
 * NFC normalization rationale: macOS Finder drag-drops file paths in NFD
 * (Conjoining Jamo, U+1100..U+11FF). `Bun.stringWidth` counts each
 * conjoining jamo as a separate cell — a Korean syllable like `화` is
 * 1 char and 2 cells in NFC, but 2 chars and 3 cells in NFD (ᄒ=2 cells
 * + ᅪ=1 cell). The terminal renders the NFD sequence as a single
 * combined syllable (2 cells visible), so the width mismatch shows up
 * as cursor drift past the visible filename — N×~1.5 cells for a path
 * with N Korean syllables. NFC normalization at insert time stores the
 * value in the same form everything else in the codebase assumes.
 */
function toSingleLine(text: string): string {
	return replaceTabs(decodeReencodedPasteControls(text).replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, ""))
		.normalize("NFC")
		.replace(/[\x00-\x1F\x7F]/g, "");
}

interface InputState {
	value: string;
	cursor: number;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	#value: string = "";
	#initialValue = "";
	#vimEditor: Editor | undefined;
	#cursor: number = 0; // Cursor position in the value
	#useTerminalCursor = false;
	/** Rendered before the editable area; set to "" for chrome-less embedding. */
	prompt = "> ";
	/** Render the editable value as bullets while retaining the real value internally. */
	mask = false;
	/** Dim hint a native terminal shows while the value is empty. */
	placeholder: string | undefined;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	/** Explicit cancellation may discard the draft. Escape may only leave an unchanged field. */
	onCancel?: () => void;
	/** Space-bar push-to-talk; set its `handler` to enable it. */
	readonly spaceHold = new SpaceHoldGesture(
		count => this.deleteBeforeCursor(count),
		() => this.vimMode === "insert",
	);
	/** When set, replaces the cursor glyph at end-of-text with this ANSI-styled string. */
	cursorOverride: string | undefined;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	#pasteHandler = new BracketedPasteHandler();

	// Kill ring for Emacs-style kill/yank operations
	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	#undoStack: InputState[] = [];

	/** Code units of the current volatile speech-to-text preview (see {@link setVolatileText}). */
	#volatileTextLen = 0;

	#native?: { props: TspInputProps; node: NativeNode };

	constructor(private readonly options?: { coalesceTypingUndo?: boolean }) {}

	getValue(): string {
		return this.#value;
	}

	/** The caret as a UTF-16 offset into {@link getValue}. */
	getCursor(): number {
		return this.#cursor;
	}

	/** Restore a UTF-16 caret offset, snapping backward to a whole grapheme. */
	setCursor(offset: number): void {
		const clamped = clampTextOffset(offset, this.#value.length);
		if (clamped === this.#value.length) {
			this.#cursor = clamped;
			return;
		}
		this.#cursor = 0;
		for (const grapheme of segmenter.segment(this.#value)) {
			if (grapheme.index > clamped) break;
			this.#cursor = grapheme.index;
		}
	}

	/** Return bounded input content and cursor state for debug inspection. */
	debugState(): Record<string, unknown> {
		return {
			textPreview: this.mask ? "********" : this.#value.slice(0, 120),
			textLength: this.#value.length,
			previewTruncated: this.#value.length > 120,
			cursor: this.#cursor,
			cursorLine: 0,
			selection: null,
			placeholderActive: false,
			masked: this.mask,
		};
	}

	get dirty(): boolean {
		return this.#value !== this.#initialValue;
	}

	/** Replace the value; the caret lands at the end unless `cursor: "start"`. */
	setValue(value: string, options: { cursor?: "start" | "end"; markClean?: boolean } = {}): void {
		if (options.markClean !== false) this.#initialValue = value;
		this.resetVimMode();
		this.#value = value;
		this.#cursor = options.cursor === "start" ? 0 : value.length;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	/** Give modal Escape priority over app-wide navigation when this field owns focus. */
	capturesInput(data: string): boolean {
		return matchesKey(data, "escape") && this.vimConsumesEscape();
	}

	get vimMode(): VimMode {
		return this.#modalEditor()?.vimMode ?? "insert";
	}

	vimConsumesEscape(): boolean {
		return this.#modalEditor()?.vimConsumesEscape() ?? false;
	}

	resetVimMode(): void {
		this.#vimEditor = undefined;
	}

	#modalEditor(): Editor | undefined {
		if (!getMenuSearchVimMode()) {
			this.resetVimMode();
			return undefined;
		}
		const editor = (this.#vimEditor ??= new Editor(getEditorTheme(), {
			normalize: toSingleLine,
			coalesceTypingUndo: this.options?.coalesceTypingUndo,
		}));
		editor.disableSubmit = true;
		if (editor.getText() !== this.#value) {
			editor.setState({ text: this.#value, cursor: { line: 0, col: this.#cursor }, scrollTop: 0 });
		} else if (editor.getCursor().col !== this.#cursor) {
			editor.applyHostEdit({ from: 0, to: 0, text: "", cursor: this.#cursor, len: this.#value.length });
		}
		return editor;
	}

	#readModalEditor(editor: Editor): void {
		this.#value = editor.getText();
		this.#cursor = editor.getCursor().col;
	}

	/**
	 * Apply one key: the editor's text bindings (motion, deletion, kill ring,
	 * undo), pastes and printable text. Returns whether the key was the
	 * field's: false for keys it has no binding for, and for cancel/submit
	 * without an `onEscape`/`onSubmit`, so a host (a list's search field) can
	 * route everything else on.
	 */
	handleInput(data: string, literalPrintable = false): boolean {
		// Handle bracketed paste mode
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining, literalPrintable);
				}
			}
			return true;
		}

		// Space-hold push-to-talk: a sustained space bar starts/stops STT instead of typing spaces.
		switch (this.spaceHold.process(matchesKey(data, "space"), matchesKey(data, "backspace"))) {
			case "type":
				this.insertText(" ");
				return true;
			case "swallow":
				return true;
		}

		const kb = getKeybindings();
		const printable = extractPrintableText(data);
		const editor = this.#modalEditor();
		if (printable !== undefined && (editor || literalPrintable)) {
			if (editor) {
				editor.handleInput(data, true);
				this.#readModalEditor(editor);
			} else this.#insertCharacter(printable);
			return true;
		}

		// In an active modal state Escape belongs to Vim before any host navigation.
		if (matchesKey(data, "escape") && editor?.vimConsumesEscape()) {
			editor.handleInput(data);
			this.#readModalEditor(editor);
			return true;
		}
		const escape = matchesKey(data, "escape");
		if (!escape && (matchesKey(data, "ctrl+c") || kb.matches(data, "tui.select.cancel"))) {
			if (this.onCancel) this.onCancel();
			else if (this.onEscape) this.onEscape();
			else return false;
			return true;
		}

		if (escape) {
			if (!this.onEscape && !this.onCancel) return false;
			if (!this.dirty) this.onEscape?.();
			return true;
		}

		if (matchesKey(data, "enter") || kb.matches(data, "tui.input.submit") || data === "\n") {
			if (!this.onSubmit) return false;
			this.submit();
			return true;
		}

		if (editor) {
			const mode = editor.vimMode;
			const value = this.#value;
			const cursor = this.#cursor;
			const pending = editor.vimPending;
			editor.handleInput(data, true);
			this.#readModalEditor(editor);
			return (
				value !== this.#value || cursor !== this.#cursor || mode !== editor.vimMode || pending !== editor.vimPending
			);
		}

		if (kb.matches(data, "tui.editor.undo")) {
			this.#undo();
			return true;
		}

		// Deletion
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.#handleBackspace();
			return true;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.#handleForwardDelete();
			return true;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
			return true;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.#deleteWordForward();
			return true;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.#deleteToLineStart();
			return true;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.#deleteToLineEnd();
			return true;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.#yank();
			return true;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.#yankPop();
			return true;
		}

		// Cursor movement
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#lastAction = null;
			if (this.#cursor > 0) {
				const beforeCursor = this.#value.slice(0, this.#cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.#cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return true;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#lastAction = null;
			if (this.#cursor < this.#value.length) {
				const afterCursor = this.#value.slice(this.#cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.#cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return true;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#lastAction = null;
			this.#cursor = 0;
			return true;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#lastAction = null;
			this.#cursor = this.#value.length;
			return true;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#moveWordBackwards();
			return true;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#moveWordForwards();
			return true;
		}

		// Regular character input, including Kitty CSI-u text-producing sequences.
		if (!printable) return false;
		this.#insertCharacter(printable);
		return true;
	}

	/** Insert decoded printable text with ordinary typing undo groups, without keybinding dispatch. */
	insertText(text: string): void {
		const editor = this.#modalEditor();
		if (!editor) {
			this.#insertCharacter(text);
			return;
		}
		editor.insertText(toSingleLine(text));
		this.#readModalEditor(editor);
	}

	/** Apply terminal paste semantics to text from non-bracketed paste transports
	 *  (e.g. kitty's OSC 5522 enhanced clipboard read). Mirrors `Editor.pasteText`. */
	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	/** Terminal-side selection edits and undo on the `input` node (see {@link applyHostEdit}). */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "edit") this.applyHostEdit(event);
		else if (event.type === "undo") {
			const editor = this.#modalEditor();
			if (editor) {
				editor.handleNativeEvent(event);
				this.#readModalEditor(editor);
			} else this.#undo();
		}
	}

	/**
	 * Apply an edit the terminal made over its own selection (TSP `edit`):
	 * replace `[from, to)` with `text` (newlines stripped, as a paste) and put
	 * the caret at `cursor`, as one undo unit. Offsets are in the described
	 * text, so a masked field's count bullets, one per grapheme. Stale edits
	 * (`len` no longer the described length) are dropped.
	 */
	applyHostEdit(edit: NativeTextEdit): void {
		let valueEdit = edit;
		if (this.mask) {
			// Bullet offsets → value offsets through the grapheme starts.
			const starts = Array.from(segmenter.segment(this.#value), grapheme => grapheme.index);
			starts.push(this.#value.length);
			const bullets = starts.length - 1;
			if (edit.len !== bullets) return;
			let from = clampTextOffset(edit.from, bullets);
			let to = clampTextOffset(edit.to, bullets);
			if (to < from) [from, to] = [to, from];
			const text = typeof edit.text === "string" ? edit.text : "";
			const cursor = clampTextOffset(edit.cursor, bullets - (to - from) + text.length);
			const after = cursor - from - text.length;
			valueEdit = {
				from: starts[from]!,
				to: starts[to]!,
				text,
				cursor:
					cursor <= from
						? starts[cursor]!
						: after >= 0
							? starts[from]! + text.length + starts[to + after]! - starts[to]!
							: starts[from]! + cursor - from,
				len: this.#value.length,
			};
		}
		const editor = this.#modalEditor();
		if (editor) {
			editor.applyHostEdit(valueEdit);
			this.#readModalEditor(editor);
			return;
		}
		const resolved = resolveTextEdit(this.#value, valueEdit, toSingleLine);
		if (!resolved) return;
		this.#lastAction = null;
		if (resolved.changed) {
			this.#pushUndo();
			this.#value = resolved.text;
		}
		this.#cursor = resolved.cursor;
	}

	/** Programmatically trigger submission (e.g. for voice submit). */
	submit(): void {
		const editor = this.#vimEditor;
		if (editor?.vimPending) editor.handleInput("\x1b");
		this.onSubmit?.(this.#value);
	}

	/** Delete up to `count` characters immediately before the cursor. */
	deleteBeforeCursor(count: number): void {
		const removable = Math.min(count, this.#cursor);
		if (removable <= 0) return;
		this.#lastAction = null;
		this.#pushUndo();
		this.#replaceBeforeCursor(removable, "");
	}

	/** Show or replace a volatile speech-to-text preview at the cursor, outside undo history.
	 *  Finalize it with {@link commitVolatileText} or drop it with {@link clearVolatileText}. */
	setVolatileText(text: string): void {
		const clean = toSingleLine(text);
		this.#replaceBeforeCursor(this.#volatileTextLen, clean);
		this.#volatileTextLen = clean.length;
	}

	/** Remove the current volatile preview without committing it. */
	clearVolatileText(): void {
		this.setVolatileText("");
	}

	/** Drop any volatile preview, then insert `text` as a single undoable edit. */
	commitVolatileText(text: string): void {
		this.clearVolatileText();
		const clean = toSingleLine(text);
		if (!clean) return;
		this.#lastAction = null;
		this.#pushUndo();
		this.#replaceBeforeCursor(0, clean);
	}

	/** Replace up to `count` code units before the cursor with `text`, leaving the cursor after it. The
	 *  range stops at the start of the value: a volatile preview's length can outrun the cursor once
	 *  the caret moves while dictation is still streaming. */
	#replaceBeforeCursor(count: number, text: string): void {
		const start = Math.max(0, this.#cursor - count);
		this.#value = this.#value.slice(0, start) + text + this.#value.slice(this.#cursor);
		this.#cursor = start + text.length;
	}

	#insertCharacter(text: string): void {
		const isWordChunk =
			this.options?.coalesceTypingUndo !== false &&
			[...segmenter.segment(text)].every(seg => getWordNavKind(seg.segment) !== "whitespace");
		// Undo coalescing: consecutive word typing coalesces into one undo unit.
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#pushUndo();
		}
		this.#lastAction = "type-word";

		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
	}

	#handleBackspace(): void {
		this.#lastAction = null;
		if (this.#cursor <= 0) {
			return;
		}

		this.#pushUndo();

		const beforeCursor = this.#value.slice(0, this.#cursor);
		const graphemes = [...segmenter.segment(beforeCursor)];
		const lastGrapheme = graphemes[graphemes.length - 1];
		const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

		this.#value = this.#value.slice(0, this.#cursor - graphemeLength) + this.#value.slice(this.#cursor);
		this.#cursor -= graphemeLength;
	}

	#handleForwardDelete(): void {
		this.#lastAction = null;
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();

		const afterCursor = this.#value.slice(this.#cursor);
		const graphemes = [...segmenter.segment(afterCursor)];
		const firstGrapheme = graphemes[0];
		const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + graphemeLength);
	}

	#deleteToLineStart(): void {
		if (this.#cursor === 0) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(0, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(this.#cursor);
		this.#cursor = 0;
	}

	#deleteToLineEnd(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(this.#cursor);
		this.#killRing.push(deletedText, { prepend: false, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor);
	}

	#deleteWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}

		// Save state before cursor movement (moveWordBackwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordBackwards();
		const deleteFrom = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(deleteFrom, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, deleteFrom) + this.#value.slice(this.#cursor);
		this.#cursor = deleteFrom;
	}

	#deleteWordForward(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		// Save state before cursor movement (moveWordForwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordForwards();
		const deleteTo = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(this.#cursor, deleteTo);
		this.#killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(deleteTo);
	}

	#yank(): void {
		const text = this.#killRing.peek();
		if (!text) {
			return;
		}

		this.#pushUndo();
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) {
			return;
		}

		this.#pushUndo();

		const prevText = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor - prevText.length) + this.#value.slice(this.#cursor);
		this.#cursor -= prevText.length;

		this.#killRing.rotate();
		const text = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#pushUndo(): void {
		this.#undoStack.push({ value: this.#value, cursor: this.#cursor });
	}

	#undo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) {
			return;
		}
		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#lastAction = null;
	}

	#moveWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordLeft(this.#value, this.#cursor);
	}

	#moveWordForwards(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordRight(this.#value, this.#cursor);
	}

	#handlePaste(pastedText: string): void {
		const editor = this.#modalEditor();
		if (editor) {
			editor.pasteText(pastedText);
			this.#readModalEditor(editor);
			return;
		}
		this.#lastAction = null;
		this.#pushUndo();
		this.#replaceBeforeCursor(0, toSingleLine(pastedText));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	/**
	 * An `input` with the value, the caret as a UTF-16 offset and the prompt;
	 * the terminal draws the caret, scrolls horizontally and places the IME.
	 * A masked input sends one bullet per grapheme, with the caret mapped onto
	 * them, so the secret never leaves the process.
	 */
	describe(_cx: DescribeContext): NativeNode {
		let value = this.#value;
		let cursor = this.#cursor;
		if (this.mask) {
			const graphemes = [...segmenter.segment(this.#value)];
			value = "•".repeat(graphemes.length);
			cursor = graphemes.filter(grapheme => grapheme.index < this.#cursor).length;
		}
		const prompt = plainText(this.prompt);
		const props: TspInputProps = {
			text: value,
			cursor,
			sendable: false,
			mode: this.#vimEditor && this.#modalEditor()?.nativeVimMode,
			prompt: prompt || undefined,
			placeholder: this.placeholder,
		};
		if (this.#native && sameProps(this.#native.props, props)) return this.#native.node;
		const described = node("input", props);
		this.#native = { props, node: described };
		return described;
	}

	render(width: number): readonly string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		// Calculate visible window
		const prompt = this.prompt;
		const availableWidth = width - visibleWidth(prompt);

		if (availableWidth <= 0) {
			return [sliceWithWidth(prompt, 0, width, true).text];
		}

		let cursorIndex = this.#cursor;
		// Ensure we always have a grapheme to invert at the cursor (space at end).
		let visibleValue = this.#value;
		if (this.mask) {
			const graphemes = [...segmenter.segment(this.#value)];
			visibleValue = "•".repeat(graphemes.length);
			cursorIndex = graphemes.filter(grapheme => grapheme.index < this.#cursor).length;
		}
		// At end of text the cursor sits on trailing padding, sized to fit a (possibly wide) cursor override.
		const atEnd = this.#cursor >= this.#value.length;
		const override =
			atEnd && this.cursorOverride !== undefined
				? { text: this.cursorOverride, width: visibleWidth(this.cursorOverride) }
				: undefined;
		const displayValue = atEnd ? visibleValue + " ".repeat(override?.width ?? 1) : visibleValue;

		const window = cursorColumnWindow(displayValue, cursorIndex, availableWidth);
		const visibleText = window.text;
		const cursorDisplay = window.cursorIndex;

		// Build the visible line and insert the cursor marker at the buffer cursor.
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? "";
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before the cursor cell for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";
		const { text: cursorChar, width: cursorWidth } = override ?? this.#cursorCell(atCursor);

		// Clamp only the trailing text (measured in terminal cells), keeping the cursor marker intact.
		const beforeWidth = visibleWidth(beforeCursor);
		const remainingAfterWidth = Math.max(0, availableWidth - beforeWidth - cursorWidth);
		const clampedAfterCursor = sliceWithWidth(afterCursor, 0, remainingAfterWidth, true).text;
		const renderedNoMarker = beforeCursor + cursorChar + clampedAfterCursor;
		const textWithCursor = beforeCursor + marker + cursorChar + clampedAfterCursor;

		const visualLength = visibleWidth(renderedNoMarker);
		const pad = padding(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + pad;
		return [line];
	}

	/** The rendered cursor cell: the grapheme under the cursor, inverted unless the terminal draws its own cursor. */
	#cursorCell(atCursor: string): { text: string; width: number } {
		if (this.#useTerminalCursor) return { text: atCursor, width: visibleWidth(atCursor) };
		if (getMenuSearchVimMode() && (!this.#vimEditor || this.#vimEditor.vimMode === "insert"))
			return { text: `\x1b[4m${atCursor || " "}\x1b[24m`, width: visibleWidth(atCursor || " ") };
		return { text: `\x1b[7m${atCursor || " "}\x1b[27m`, width: visibleWidth(atCursor || " ") };
	}
}
