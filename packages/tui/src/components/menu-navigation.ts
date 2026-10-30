import type { TspScrollBy } from "@oh-my-pi/pi-wire";
import { getKeybindings, type KeybindingsManager } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { compileMenuRegex } from "../menu-search";
import { getMenuWindow, type MenuWindow } from "./menu-selection";
import { Input } from "./input";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";

/**
 * A normal-navigation intent resolved from one key. Hosts apply motions with
 * {@link applyMenuMotion} and decide what the remaining intents mean on their
 * surface (AGENTS.md › Menu Navigation).
 */
export type MenuNavAction =
	/** `j`/`k`, Down/Up. */
	| { kind: "move"; delta: -1 | 1 }
	/** `h`/`l`, Left/Right: pane switch, collapse/expand, reorder, or value adjust, per surface. */
	| { kind: "horizontal"; delta: -1 | 1 }
	/** `Ctrl-d`/`Ctrl-u`. */
	| { kind: "halfPage"; delta: -1 | 1 }
	/** PageDown/PageUp. */
	| { kind: "page"; delta: -1 | 1 }
	/** `gg`/`G`, Home/End. */
	| { kind: "boundary"; edge: "first" | "last" }
	/** `Ctrl-e`/`Ctrl-y`: the view moves one line, the selection does not. */
	| { kind: "scroll"; delta: -1 | 1 }
	/** Space: checkbox toggle or soft activation. */
	| { kind: "toggle" }
	/** Enter. */
	| { kind: "confirm" }
	/** Esc / Ctrl-c. */
	| { kind: "cancel" }
	/** Tab/Shift-Tab: next/previous tab, section, or focus region. */
	| { kind: "context"; delta: -1 | 1 }
	/** `/`: focus the surface's filter or search field. */
	| { kind: "search" };

/** Native scroll requests supported by the current wire protocol; half pages have no equivalent. */
export function menuScrollBy(action: MenuNavAction): TspScrollBy | undefined {
	switch (action.kind) {
		case "move":
		case "scroll":
			return action.delta < 0 ? "line-up" : "line-down";
		case "page":
			return action.delta < 0 ? "page-up" : "page-down";
		case "boundary":
			return action.edge === "first" ? "start" : "end";
		default:
			return undefined;
	}
}

/**
 * Resolves raw input into {@link MenuNavAction}s for a surface in normal
 * navigation. Owns the `g` prefix of `gg`: a lone `g` reports `"pending"`, and
 * any key other than a second `g` cancels the prefix and resolves on its own.
 *
 * Hosts MUST route keys to a focused text field (filter, rename, form input)
 * before calling {@link read}, so printable keys type literally there.
 */
export class MenuKeyReader {
	#pendingG = false;
	readonly #keybindings: KeybindingsManager | undefined;

	/** Explicit hosts retain their binding registry; default readers follow the current global registry. */
	constructor(keybindings?: KeybindingsManager) {
		this.#keybindings = keybindings;
	}

	/** True while a `g` waits for its second key. */
	get pending(): boolean {
		return this.#pendingG;
	}

	/** Drop a pending prefix, e.g. when focus moves into a text field. */
	reset(): void {
		this.#pendingG = false;
	}

	read(data: string): MenuNavAction | "pending" | undefined {
		const prefixed = this.#pendingG;
		this.#pendingG = false;
		if (matchesKey(data, "g")) {
			if (prefixed) return { kind: "boundary", edge: "first" };
			this.#pendingG = true;
			return "pending";
		}
		const kb = this.#keybindings ?? getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) return { kind: "cancel" };
		if (kb.matches(data, "tui.select.confirm") || data === "\n") return { kind: "confirm" };
		if (matchesKey(data, "shift+g") || kb.matches(data, "tui.select.last")) return { kind: "boundary", edge: "last" };
		if (kb.matches(data, "tui.select.first")) return { kind: "boundary", edge: "first" };
		if (kb.matches(data, "tui.select.up") || matchesKey(data, "k") || matchesKey(data, "shift+k"))
			return { kind: "move", delta: -1 };
		if (kb.matches(data, "tui.select.down") || matchesKey(data, "j") || matchesKey(data, "shift+j"))
			return { kind: "move", delta: 1 };
		if (kb.matches(data, "tui.select.left") || matchesKey(data, "h") || matchesKey(data, "shift+h"))
			return { kind: "horizontal", delta: -1 };
		if (kb.matches(data, "tui.select.right") || matchesKey(data, "l") || matchesKey(data, "shift+l"))
			return { kind: "horizontal", delta: 1 };
		if (kb.matches(data, "tui.select.halfPageUp")) return { kind: "halfPage", delta: -1 };
		if (kb.matches(data, "tui.select.halfPageDown")) return { kind: "halfPage", delta: 1 };
		if (kb.matches(data, "tui.select.pageUp")) return { kind: "page", delta: -1 };
		if (kb.matches(data, "tui.select.pageDown")) return { kind: "page", delta: 1 };
		if (kb.matches(data, "tui.select.scrollUp")) return { kind: "scroll", delta: -1 };
		if (kb.matches(data, "tui.select.scrollDown")) return { kind: "scroll", delta: 1 };
		if (kb.matches(data, "tui.select.toggle")) return { kind: "toggle" };
		if (kb.matches(data, "tui.select.prevContext")) return { kind: "context", delta: -1 };
		if (kb.matches(data, "tui.select.nextContext")) return { kind: "context", delta: 1 };
		if (kb.matches(data, "tui.select.search")) return { kind: "search" };
		return undefined;
	}
}

export interface MenuSearchState {
	value: string;
	focused: boolean;
	cursor: number;
	query?: string;
}

export interface MenuSearchTheme {
	muted(text: string): string;
}

/**
 * A menu's draft search field. Hosts refilter when `query` changes, repaint
 * on "edited", and delegate only "pass" to navigation. The draft reaches
 * the matcher only after Enter; losing focus discards unconfirmed edits.
 * Hosts may retain the text when Escape returns to the list instead of clearing it.
 */
export class MenuSearchField {
	readonly #input = new Input();
	#query = "";
	readonly #cancel: "clear" | "retain";

	constructor(value = "", focused = false, cancel: "clear" | "retain" = "clear") {
		this.#input.prompt = "";
		this.#input.setValue(value);
		this.#query = value;
		this.#input.focused = focused;
		this.#cancel = cancel;
	}

	/** Native picker bindings reuse the existing Input query/cursor transport. */
	get input(): Input {
		return this.#input;
	}

	get focused(): boolean {
		return this.#input.focused;
	}

	set focused(value: boolean) {
		if (!value && this.#input.focused && this.value !== this.#query) this.#input.setValue(this.#query);
		this.#input.focused = value;
	}

	get value(): string {
		return this.#input.getValue();
	}

	/** Confirmed pattern used for filtering, never the in-progress draft. */
	get query(): string {
		return this.#query;
	}

	get cursor(): number {
		return this.#input.getCursor();
	}

	setValue(value: string): void {
		this.#input.setValue(value);
		this.#query = value;
	}

	handleInput(data: string): "edited" | "exited" | "pass" {
		if (!this.focused) {
			if (this.#cancel === "retain") return "pass";
			if (!this.value || extractPrintableText(data) !== undefined) return "pass";
			if (!matchesKey(data, "escape") && !getKeybindings().matches(data, "tui.select.cancel")) return "pass";
			this.setValue("");
			return "exited";
		}
		const text = extractPrintableText(data);
		if (text !== undefined) {
			this.#input.insertText(text);
			return "edited";
		}
		const kb = getKeybindings();
		if (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel")) {
			this.setValue(this.#cancel === "retain" ? this.value : "");
			this.focused = false;
			return "exited";
		}
		if (matchesKey(data, "enter") || kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.#query = this.value;
			this.focused = false;
			return "exited";
		}
		this.#input.handleInput(data);
		return "edited";
	}

	render(width: number, theme: MenuSearchTheme): string {
		const columns = Math.max(0, Math.trunc(width));
		if (!this.focused && this.value.length === 0) return theme.muted(truncateToWidth("/ search", columns));
		const prefix = "Search: ";
		const error = compileMenuRegex(this.value)?.error;
		const hint = error
			? ` · Invalid regex: ${error}`
			: this.focused
				? ` · Enter confirm · Esc ${this.#cancel === "retain" ? "back" : "clear"}`
				: ` · j/k · Ctrl-d/u half · gg/G · / search${this.#cancel === "clear" ? " · Esc clear" : ""}`;
		const fieldWidth = Math.max(0, columns - visibleWidth(prefix) - visibleWidth(hint));
		const value = this.focused
			? (this.#input.render(fieldWidth)[0] ?? "")
			: truncateToWidth(replaceTabs(this.value), fieldWidth);
		return theme.muted(truncateToWidth(`${prefix}${replaceTabs(value)}${hint}`, columns));
	}

	navigationSnapshot(): MenuSearchState {
		return { value: this.value, query: this.query, focused: this.focused, cursor: this.cursor };
	}

	restoreNavigation(snapshot: unknown): void {
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as Partial<MenuSearchState>;
		if (typeof state.value !== "string") return;
		this.setValue(typeof state.query === "string" ? state.query : state.focused ? "" : state.value);
		this.focused = state.focused === true;
		if (this.focused) this.#input.setValue(state.value);
		if (typeof state.cursor === "number") this.#input.setCursor(state.cursor);
	}
}

/** A viewport may start partway through a multi-line menu item. */
export interface MenuViewportPosition {
	readonly item: number;
	readonly lineOffset: number;
}

/**
 * Scroll position over a list of variable-height items, independent of the
 * selection. Motions call {@link reveal} so the next layout scrolls the
 * minimum needed to show the selection; {@link scroll} moves only the view,
 * so the selection may leave the window until the next motion.
 */
export class MenuViewport {
	#top: MenuViewportPosition | undefined;
	#revealPending = false;
	#lastVisibleItems = 1;
	#rowCounts: readonly number[] = [];

	get top(): MenuViewportPosition | undefined {
		return this.#top;
	}

	/** Items the last layout showed (at least 1). */
	get visibleItems(): number {
		return this.#lastVisibleItems;
	}

	reveal(): void {
		this.#revealPending = true;
	}

	/** Move by visual lines without moving the selected item. */
	scroll(delta: number): void {
		if (!this.#top || !Number.isFinite(delta)) return;
		let { item, lineOffset } = this.#top;
		lineOffset += Math.trunc(delta);
		while (lineOffset < 0 && item > 0) {
			item--;
			lineOffset += Math.max(0, this.#rowCounts[item] ?? 0);
		}
		while (item < this.#rowCounts.length - 1 && lineOffset >= Math.max(0, this.#rowCounts[item] ?? 0)) {
			lineOffset -= Math.max(0, this.#rowCounts[item] ?? 0);
			item++;
		}
		this.#top = { item, lineOffset: Math.max(0, lineOffset) };
	}

	/** Older numeric snapshots mean an item boundary; current snapshots retain its line offset. */
	setTop(top: MenuViewportPosition | number | undefined): void {
		if (top === undefined) {
			this.#top = undefined;
		} else if (typeof top !== "number" && (typeof top !== "object" || top === null)) {
			return;
		} else {
			const item = typeof top === "number" ? top : top.item;
			const lineOffset = typeof top === "number" ? 0 : top.lineOffset;
			if (!Number.isFinite(item) || !Number.isFinite(lineOffset)) return;
			this.#top = { item: Math.max(0, Math.trunc(item)), lineOffset: Math.max(0, Math.trunc(lineOffset)) };
		}
		this.#revealPending = false;
	}

	/** Window intersections include a clipped leading and/or trailing item. */
	layout(rowCounts: readonly number[], selectedIndex: number, rowBudget: number): MenuWindow {
		this.#rowCounts = rowCounts;
		const count = rowCounts.length;
		const budget = Math.max(1, Math.trunc(rowBudget));
		let totalRows = 0;
		for (const rows of rowCounts) totalRows += Math.max(0, rows);
		if (count === 0) {
			this.#top = { item: 0, lineOffset: 0 };
			this.#revealPending = false;
			this.#lastVisibleItems = 1;
			return { startIndex: 0, endIndex: 0, lineOffset: 0, rowOffset: 0, totalRows };
		}
		if (!this.#top) {
			this.#top = { item: getMenuWindow(rowCounts, selectedIndex, budget).startIndex, lineOffset: 0 };
		}
		let top = Math.min(this.#top.item, count - 1);
		let lineOffset = Math.min(this.#top.lineOffset, Math.max(0, (rowCounts[top] ?? 0) - 1));
		if (this.#revealPending && selectedIndex >= 0 && selectedIndex < count) {
			if (selectedIndex <= top) {
				top = selectedIndex;
				lineOffset = 0;
			} else {
				while (top < selectedIndex && rowsBetween(rowCounts, top, selectedIndex + 1) - lineOffset > budget) {
					top++;
					lineOffset = 0;
				}
			}
		}
		this.#revealPending = false;
		const lastTop = maxTop(rowCounts, budget);
		if (top > lastTop) {
			top = lastTop;
			lineOffset = Math.max(0, rowsBetween(rowCounts, top, count) - budget);
		} else if (top === lastTop) {
			lineOffset = Math.min(lineOffset, Math.max(0, rowsBetween(rowCounts, top, count) - budget));
		}
		let endIndex = top;
		let used = -lineOffset;
		while (endIndex < count && used < budget) {
			used += Math.max(0, rowCounts[endIndex] ?? 0);
			endIndex++;
		}
		this.#top = { item: top, lineOffset };
		this.#lastVisibleItems = Math.max(1, endIndex - top);
		return {
			startIndex: top,
			endIndex,
			lineOffset,
			rowOffset: rowsBetween(rowCounts, 0, top) + lineOffset,
			totalRows,
		};
	}
}

function rowsBetween(rowCounts: readonly number[], start: number, end: number): number {
	let rows = 0;
	for (let index = start; index < end; index++) rows += Math.max(0, rowCounts[index] ?? 0);
	return rows;
}

/** The last top whose window still fills the budget, so the view never scrolls past the end. */
function maxTop(rowCounts: readonly number[], budget: number): number {
	let top = rowCounts.length - 1;
	let used = Math.max(0, rowCounts[top] ?? 0);
	while (top > 0) {
		const rows = Math.max(0, rowCounts[top - 1] ?? 0);
		if (used + rows > budget) break;
		used += rows;
		top--;
	}
	return Math.max(0, top);
}

/** The selection surface a motion drives; {@link MenuSelection} satisfies it. */
export interface MenuMotionTarget {
	move(delta: number, wrap?: boolean): boolean;
	moveToBoundary(edge: "first" | "last"): boolean;
}

/** Outcome of {@link applyMenuMotion}. */
export interface MenuMotionResult {
	/** The action was a motion; the host has nothing left to do for it. */
	handled: boolean;
	/** The selection moved; the host notifies its selection listeners. */
	selectionChanged: boolean;
}

const NOT_A_MOTION: MenuMotionResult = { handled: false, selectionChanged: false };

/**
 * Apply the vertical motions shared by every list: row, half page, page,
 * first/last, and view-only scroll. Half page and page move the view and the
 * selection by the same number of items, as Vim does. Returns unhandled for
 * horizontal, toggle, confirm, cancel, context, and search intents.
 */
export function applyMenuMotion(
	action: MenuNavAction,
	target: MenuMotionTarget,
	viewport: MenuViewport,
	options: { wrap?: boolean } = {},
): MenuMotionResult {
	let selectionChanged: boolean;
	switch (action.kind) {
		case "move":
			selectionChanged = target.move(action.delta, options.wrap ?? false);
			break;
		case "halfPage": {
			const step = Math.max(1, Math.floor(viewport.visibleItems / 2));
			viewport.scroll(action.delta * step);
			selectionChanged = target.move(action.delta * step);
			break;
		}
		case "page": {
			const step = viewport.visibleItems;
			viewport.scroll(action.delta * step);
			selectionChanged = target.move(action.delta * step);
			break;
		}
		case "boundary":
			selectionChanged = target.moveToBoundary(action.edge);
			break;
		case "scroll":
			viewport.scroll(action.delta);
			return { handled: true, selectionChanged: false };
		default:
			return NOT_A_MOTION;
	}
	viewport.reveal();
	return { handled: true, selectionChanged };
}

/**
 * A menu whose per-view context (tab, focused pane, selection, filter,
 * scroll, unsaved edits) survives a menu-history round trip. The host takes
 * a snapshot when the menu closes and hands it back right after reopening.
 * Nested navigation captures the previous snapshot, builds the new page,
 * then notifies the host. The empty page id names the root. Restoration
 * must not notify the host, create another visit, or invoke selection/entry
 * actions that preview or apply settings. Restore the view without replaying
 * the action that originally opened it.
 */
export interface MenuHistoryParticipant {
	navigationSnapshot(): unknown;
	restoreNavigation(snapshot: unknown): void;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	/** True only during an in-flight operation or credential prompt, not a pending second-press confirmation. */
	readonly blocksMenuHistory?: boolean;
}

export function isMenuHistoryParticipant(value: unknown): value is MenuHistoryParticipant {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<MenuHistoryParticipant>).navigationSnapshot === "function" &&
		typeof (value as Partial<MenuHistoryParticipant>).restoreNavigation === "function"
	);
}

/**
 * A menu with live side effects (previews on the real UI, open streams) to
 * settle when menu history moves away from it. The host calls `leaveMenu`
 * just before hiding the menu: persist drafts, undo previews, never prompt.
 */
export interface MenuHistoryLeaver {
	leaveMenu(): void;
}

export function isMenuHistoryLeaver(value: unknown): value is MenuHistoryLeaver {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<MenuHistoryLeaver>).leaveMenu === "function"
	);
}
