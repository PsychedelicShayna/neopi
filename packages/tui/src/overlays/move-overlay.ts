/**
 * `/move` overlay: a path input with live directory autocomplete.
 *
 * Rendered as a centered modal via `showHookCustom(..., { overlay: true })`.
 * The user types a path, Tab autocompletes the highlighted directory, and Enter
 * confirms — yielding the resolved directory string (or `undefined` on cancel).
 */
import { type Component, type Focusable, Key, matchesKey, truncateToWidth } from "../index";
import { theme } from "../theme/theme";
import {
	applyMenuMotion,
	MenuKeyReader,
	MenuViewport,
	menuScrollBy,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import { formTheme } from "../chrome/form-theme";
import { bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { TextFormField } from "../components/form";
import { formatKeyHint } from "../app-keybindings";
import { editorKey } from "../chrome/keybinding-hints";
import type { NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { node, span } from "../native/describe";
import { actionBar, actionButton, overlayCard, statusHintsRow } from "../native/overlay";
import { getKeybindings } from "../keybindings";
import { MenuSelection } from "../components/menu-selection";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import { contentRowWidth, renderScrollableList } from "../chrome/selector-helpers";

export interface MoveOverlayResult {
	directory: string;
}

/** Directory suggestion displayed by the move dialog. */
export interface MoveDirectoryEntry {
	/** Full absolute path. */
	value: string;
	/** Display label (basename + trailing slash). */
	label: string;
}

/** Directory autocomplete supplied by the host. */
export interface MoveDirectorySource {
	search(prefix: string, cwd: string, max: number): MoveDirectoryEntry[];
}

const MAX_RESULTS = 15;

/**
 * Overlay component for `/move`: a single-line path input with a live-filtered
 * list of matching directories. Tab accepts the highlighted suggestion; Enter
 * confirms the current input (or the highlighted suggestion if the input is
 * empty). Escape leaves the path field without clearing it, then cancels.
 */
export class MoveOverlay implements Component, Focusable {
	readonly #field: TextFormField;
	readonly #keys = new MenuKeyReader();
	readonly #viewport = new MenuViewport();
	readonly #help = new MenuHelp("jk gg/G C-u d e y");
	readonly #menu = new MenuSelection<MoveDirectoryEntry>([], {
		getKey: entry => entry.value,
		getSearchText: entry => `${entry.label} ${entry.value}`,
	});
	#focused = false;
	#pathFocused = true;
	#rowCounts: number[] = [];
	#cwd: string;
	#source: MoveDirectorySource;
	#done: (result: MoveOverlayResult | undefined) => void;
	#revision = 0;
	#nativeScroll: NativeScroll | undefined;
	#renderMemo:
		| { width: number; fieldLines: readonly string[]; revision: number; lines: readonly string[] }
		| undefined;
	#native: { revision: number; node: NativeNode } | undefined;

	constructor(cwd: string, done: (result: MoveOverlayResult | undefined) => void, source: MoveDirectorySource) {
		this.#cwd = cwd;
		this.#source = source;
		this.#done = done;
		this.#field = new TextFormField({
			theme: formTheme,
			prompt: theme.fg("dim", "Path: "),
			empty: "submit",
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: () => this.#confirm(),
			onCancel: () => this.#setPathFocus(false),
		});
		this.#updateResults();
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#field.focused = value && this.#pathFocused;
		this.#revision++;
	}

	get filterFocused(): boolean {
		return this.#pathFocused;
	}

	navigationSnapshot(): unknown {
		return {
			field: this.#field.navigationSnapshot(),
			pathFocused: this.#pathFocused,
			selected: this.#menu.selectedKey,
			viewportTop: this.#viewport.top,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object") return;
		const state = snapshot as {
			field?: unknown;
			pathFocused?: boolean;
			selected?: string;
			viewportTop?: MenuViewportPosition | number;
		};
		this.#field.restoreNavigation(state.field);
		this.#updateResults();
		if (typeof state.selected === "string") this.#menu.setSelectedKey(state.selected);
		this.#setPathFocus(state.pathFocused === true);
		this.#viewport.setTop(state.viewportTop);
		this.#nativeScroll = undefined;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#field.setUseTerminalCursor(useTerminalCursor);
	}

	pasteText(text: string): void {
		if (!this.#pathFocused) return;
		this.#field.pasteText(text);
		this.#updateResults();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.#done(undefined);
			return;
		}
		if (this.#pathFocused) {
			// Tab is the path field's existing nondestructive completion action.
			if (matchesKey(data, Key.tab)) {
				this.#accept();
				return;
			}
			const before = this.#field.getValue();
			if (this.#field.input.handleInput(data)) {
				this.#keys.reset();
				if (this.#field.getValue() !== before) this.#updateResults();
				return;
			}
		}
		if (!this.#pathFocused && this.#help.handleInput(data)) {
			this.#revision++;
			return;
		}
		const action = this.#keys.read(data);
		if (!action || action === "pending") return;
		if (action.kind === "cancel") {
			this.#done(undefined);
			return;
		}
		if (action.kind === "search") {
			this.#setPathFocus(true);
			return;
		}
		if (action.kind === "context") {
			this.#setPathFocus(!this.#pathFocused);
			return;
		}
		if (action.kind === "confirm") {
			this.#confirm();
			return;
		}
		// Space never confirms a filesystem move; there are no horizontal panes.
		if (action.kind === "toggle" || action.kind === "horizontal") return;
		this.#viewport.layout(this.#rowCounts, this.#menu.selectedIndex, MAX_RESULTS);
		applyMenuMotion(action, this.#menu, this.#viewport, { wrap: false });
		const by = menuScrollBy(action);
		if (by) this.#nativeScroll = { by, n: (this.#nativeScroll?.n ?? 0) + 1 };
		this.#revision++;
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const fieldLines = this.#field.render(innerWidth);
		const memo = this.#renderMemo;
		if (memo?.width === width && memo.fieldLines === fieldLines && memo.revision === this.#revision)
			return memo.lines;
		const lines = [topBorder(width, "Move to directory")];
		for (const fieldLine of fieldLines) lines.push(row(fieldLine, width));
		lines.push(row("", width));
		const results = this.#menu.visibleItems;
		const window = this.#viewport.layout(this.#rowCounts, this.#menu.selectedIndex, MAX_RESULTS);
		if (results.length === 0 && this.#field.getValue().length > 0) {
			lines.push(row(theme.fg("dim", "No matching directories"), width));
		} else {
			const rowWidth = contentRowWidth(innerWidth, results.length, MAX_RESULTS);
			const rows: string[] = [];
			for (let i = window.startIndex; i < window.endIndex; i++) {
				const item = results[i]!;
				const selected = i === this.#menu.selectedIndex;
				const marker = selected ? theme.fg("accent", "▶ ") : "  ";
				const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				rows.push(truncateToWidth(`${marker}${label}`, rowWidth));
			}
			for (const line of renderScrollableList(rows, {
				width: innerWidth,
				totalRows: results.length,
				scrollOffset: window.rowOffset,
			})) {
				lines.push(row(line, width));
			}
		}
		lines.push(row("", width));
		const hint = this.#pathFocused
			? `Type path · ${formatKeyHint("tab")} complete · Enter confirm · Esc back to list`
			: `/ or Tab edit · Enter confirm · ${editorKey("tui.select.cancel")} cancel · ? help`;
		for (const line of menuHintLines(hint, innerWidth, this.#pathFocused ? "" : "jk gg/G C-u d e y")) {
			lines.push(row(theme.fg("dim", line), width));
		}
		lines.push(bottomBorder(width));
		const rendered = this.#help.render(lines, width);
		this.#renderMemo = { width, fieldLines, revision: this.#revision, lines: rendered };
		return rendered;
	}

	describe(): NativeNode {
		if (this.#help.open) return this.#help.describe();
		const memo = this.#native;
		if (memo?.revision === this.#revision) return memo.node;
		const items = this.#menu.visibleItems.map(item =>
			node("item", { label: item.label, detail: [span(item.value, "path")] }, undefined, item.value),
		);
		const list = {
			...node(
				"list",
				{
					selected: this.#menu.selectedKey ?? null,
					empty: this.#field.getValue().length > 0 ? [span("No matching directories", "dim")] : undefined,
					max: { lines: MAX_RESULTS },
				},
				items,
				"results",
			),
			scroll: this.#nativeScroll,
		};
		const hints = statusHintsRow(
			[span(this.#pathFocused ? "Type path · Tab complete · Esc back to list" : "/ or Tab edit · ? help", "dim")],
			[],
		);
		const actions = actionBar([
			actionButton("Accept", "accept", { keys: this.#pathFocused ? "tab" : undefined }),
			this.#pathFocused ? actionButton("Back to list", "back", { keys: "escape" }) : null,
			actionButton("Cancel", "cancel", {
				keys: this.#pathFocused ? undefined : (getKeybindings().getKeys("tui.select.cancel")[0] ?? "escape"),
			}),
			actionButton("Confirm", "confirm", { keys: "enter", tone: "accent" }),
		]);
		const described = overlayCard("omp.dialog.move", "Move to directory", [this.#field, list, hints, actions]);
		this.#native = { revision: this.#revision, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#help.open) {
			if (event.type === "action") this.#help.handleInput("\x1b");
			this.#revision++;
			return;
		}
		if (event.type === "action") {
			if (event.act === "accept") this.#accept();
			else if (event.act === "confirm") this.#confirm();
			else if (event.act === "back") this.#setPathFocus(false);
			else if (event.act === "cancel" || event.act === "close") this.#done(undefined);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		const index = this.#menu.visibleItems.findIndex(result => result.value === event.item);
		if (index === -1) return;
		this.#menu.setSelectedIndex(index);
		this.#viewport.reveal();
		this.#setPathFocus(false);
		if (event.type === "activate") this.#confirm();
	}

	#setPathFocus(focused: boolean): void {
		this.#pathFocused = focused;
		this.#field.focused = this.#focused && focused;
		this.#keys.reset();
		this.#revision++;
	}

	/** Tab in the path field fills it with the highlighted suggestion. */
	#accept(): void {
		const selected = this.#menu.selectedItem;
		if (!selected) return;
		this.#field.setValue(selected.value);
		this.#setPathFocus(true);
		this.#updateResults();
	}

	invalidate(): void {
		this.#field.input.prompt = theme.fg("dim", "Path: ");
		this.#field.invalidate();
		this.#revision++;
		this.#renderMemo = undefined;
	}

	#updateResults(): void {
		const results = this.#source.search(this.#field.getValue(), this.#cwd, MAX_RESULTS + 5);
		this.#menu.setItems(results);
		this.#menu.moveToBoundary("first");
		this.#rowCounts = results.map(() => 1);
		this.#viewport.reveal();
		this.#revision++;
	}

	#confirm(): void {
		const selected = this.#menu.selectedItem;
		if (selected) this.#done({ directory: selected.value });
		else if (this.#field.getValue().trim().length > 0) this.#done({ directory: this.#field.getValue().trim() });
		else this.#done(undefined);
	}
}
