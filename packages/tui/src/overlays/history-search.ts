import { type Component, Ellipsis, Input, matchesKey, padding, Spacer, truncateToWidth, visibleWidth } from "../index";
import { compileMenuRegex } from "../menu-search";
import { theme } from "../theme/theme";
import { MenuHelp, MenuHints } from "../components/menu-hints";
/** Prompt history fields displayed in search results. */
export interface HistorySearchEntry {
	prompt: string;
	created_at: number;
	/** Project folder the prompt was typed in. */
	cwd?: string;
}

/** Searchable prompt history supplied by the host. */
export interface HistorySource {
	search(query: string, limit: number): HistorySearchEntry[];
	getRecent(limit: number): HistorySearchEntry[];
}
import { boundKeys, rawKeyHint } from "../chrome/keybinding-hints";
import { OverlayPanel } from "../chrome/overlay-box";
import { contentRowWidth, renderScrollableList } from "../chrome/selector-helpers";
import { MenuSelection } from "../components/menu-selection";
import {
	applyMenuMotion,
	MenuKeyReader,
	MenuSearchField,
	MenuViewport,
	menuScrollBy,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import type { KeyName } from "../key-hint-format";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { col, keyed, node, span } from "../native/describe";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { hintsRow, overlayCard } from "../native/overlay";
import { picker, pickerAction, pickerAge, pickerDate, pickerEvent, pickerHits, pickerQuery } from "../native/picker";
import { shortenPath } from "../render/render-utils";

const ENTER_KEYS: readonly KeyName[] = ["enter"];

/** Native item key of a history entry: key-path safe (prompts may hold `/` and newlines), stable across queries. */
function nativeEntryKey(entry: HistorySearchEntry): string {
	return `${entry.created_at}-${Bun.hash(entry.prompt).toString(36)}`;
}

interface HistoryNativeMemo {
	picker: boolean;
	items: readonly HistorySearchEntry[];
	selected: HistorySearchEntry | undefined;
	query: string;
	cursor: number;
	focused: boolean;
	scroll: NativeScroll | undefined;
	node: NativeNode;
}

/** Key of the `picker` child a dock-mounted history search describes (hoisted into `layer`). */
const PICKER_KEY = "picker";

/** Visible result rows; also the jump distance for PageUp/PageDown. */
const MAX_VISIBLE = 10;

/**
 * Quiet period after the last query edit before the synchronous storage
 * search runs. Only applied when the host wires {@link HistorySearchComponent.setOnRequestRender},
 * since the deferred results need a repaint to show up.
 */
const SEARCH_DEBOUNCE_MS = 100;

/** Split a query the same way `HistorySource` tokenizes it, so highlights align with matches. */
function queryTokens(query: string): string[] {
	if (compileMenuRegex(query)) return [];
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(tok => tok.length > 0);
}

/** Wrap every case-insensitive occurrence of any token in `text` with the accent color. */
function highlightTokens(text: string, tokens: string[]): string {
	const ranges = pickerHits(text, tokens);
	if (ranges.length === 0) return text;
	let out = "";
	let pos = 0;
	for (const [start, end] of ranges) {
		if (start > pos) out += text.slice(pos, start);
		out += theme.fg("accent", text.slice(start, end));
		pos = end;
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

/** A past prompt as a picker row: its first line (with query hits), age and project folder. */
function historyPickerItem(entry: HistorySearchEntry, tokens: readonly string[]): TspPickerItem {
	const label = entry.prompt.trim().split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
	const hits = pickerHits(label, tokens);
	return {
		id: nativeEntryKey(entry),
		label,
		...(entry.cwd ? { detail: shortenPath(entry.cwd) } : {}),
		facts: { when: pickerAge(entry.created_at * 1000) },
		...(hits.length > 0 ? { hits } : {}),
		title: pickerDate(entry.created_at * 1000),
	};
}

class HistoryResultsList implements Component {
	#menu: MenuSelection<HistorySearchEntry>;
	#tokens: string[] = [];
	#maxVisible = MAX_VISIBLE;
	readonly #viewport: MenuViewport;
	#rowCounts: number[] = [];
	/** Highlighted prompt text per entry, valid for one `(tokens, budget)` pair; reset on invalidate (theme). */
	#highlightCache = new WeakMap<HistorySearchEntry, { tokens: string[]; budget: number; text: string }>();

	constructor(menu: MenuSelection<HistorySearchEntry>, viewport: MenuViewport) {
		this.#menu = menu;
		this.#viewport = viewport;
	}

	setTokens(tokens: string[]): void {
		this.#tokens = tokens;
		this.#rowCounts = this.#menu.visibleItems.map(() => 1);
	}

	prepareViewport(): ReturnType<MenuViewport["layout"]> {
		return this.#viewport.layout(this.#rowCounts, this.#menu.selectedIndex, this.#maxVisible);
	}

	invalidate(): void {
		this.#highlightCache = new WeakMap();
	}

	/** Truncated, token-highlighted prompt of `entry` for `budget` cells. */
	#highlightedPrompt(entry: HistorySearchEntry, budget: number): string {
		const cached = this.#highlightCache.get(entry);
		if (cached !== undefined && cached.tokens === this.#tokens && cached.budget === budget) return cached.text;
		const normalized = entry.prompt.replace(/\s+/g, " ").trim();
		const text = highlightTokens(truncateToWidth(normalized, budget), this.#tokens);
		this.#highlightCache.set(entry, { tokens: this.#tokens, budget, text });
		return text;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const items = this.#menu.visibleItems;

		if (items.length === 0) {
			const message = this.#tokens.length > 0 ? "No matching history" : "No history yet";
			lines.push(theme.fg("muted", `  ${theme.status.info} ${message}`));
			return lines;
		}

		const cursorSymbol = `${theme.nav.cursor} `;
		const gutterWidth = visibleWidth(cursorSymbol);

		const { startIndex, endIndex, rowOffset } = this.prepareViewport();

		const rowWidth = contentRowWidth(width, items.length, this.#maxVisible);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const entry = items[i];
			if (!entry) continue;
			const isSelected = i === this.#menu.selectedIndex;

			const timeStr = pickerAge(entry.created_at * 1000);
			const timeWidth = visibleWidth(timeStr);
			const showTime = rowWidth >= gutterWidth + 12 + timeWidth;

			const promptBudget = Math.max(4, rowWidth - gutterWidth - (showTime ? timeWidth + 1 : 0));
			const highlighted = this.#highlightedPrompt(entry, promptBudget);

			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(gutterWidth);
			let line = cursor + (isSelected ? theme.bold(highlighted) : highlighted);

			if (showTime) {
				// Pad the prompt region so the timestamp sits flush right with a one-cell gap.
				line = `${truncateToWidth(line, rowWidth - timeWidth - 1, Ellipsis.Unicode, true)} ${theme.fg("dim", timeStr)}`;
			}

			rows.push(
				isSelected
					? theme.bg("selectedBg", truncateToWidth(line, rowWidth, Ellipsis.Omit, true))
					: truncateToWidth(line, rowWidth),
			);
		}

		lines.push(...renderScrollableList(rows, { width, totalRows: items.length, scrollOffset: rowOffset }));
		return lines;
	}
}

export class HistorySearchComponent extends OverlayPanel {
	#historyStorage: HistorySource;
	#searchInput: Input;
	readonly #search = new MenuSearchField("", true);
	readonly #keys = new MenuKeyReader();
	readonly #help = new MenuHelp("jk gg/G C-u d e y");
	readonly #viewport = new MenuViewport();
	#nativeScroll: NativeScroll | undefined;
	#menu: MenuSelection<HistorySearchEntry>;
	#resultsList: HistoryResultsList;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;
	#nativeHints: NativeNode | undefined;
	#nativeMemo: HistoryNativeMemo | undefined;
	#pickerItems: { items: readonly HistorySearchEntry[]; rows: readonly TspPickerItem[] } | undefined;
	/** Trimmed query the current results were fetched for; `undefined` before the first fetch. */
	#resultsQuery: string | undefined;
	#searchTimer: NodeJS.Timeout | undefined;
	#onRequestRender?: () => void;

	constructor(historyStorage: HistorySource, onSelect: (prompt: string) => void, onCancel: () => void) {
		super("History", "omp.overlay.history");
		this.#historyStorage = historyStorage;
		this.#onSelect = prompt => {
			this.#cancelPendingSearch();
			onSelect(prompt);
		};
		this.#onCancel = () => {
			this.#cancelPendingSearch();
			onCancel();
		};

		this.#menu = new MenuSelection<HistorySearchEntry>([], {
			getKey: entry => `${entry.created_at}:${entry.prompt}`,
			getSearchText: entry => entry.prompt,
		});
		this.#searchInput = this.#search.input;

		this.#resultsList = new HistoryResultsList(this.#menu, this.#viewport);

		const dot = theme.fg("dim", theme.sep.dot);
		const hint = [rawKeyHint("enter", "select"), "/ search · Tab field/list · Esc field/list/close · ? help"].join(
			dot,
		);

		this.addChild(new Spacer(1));
		this.addChild({ render: width => [this.#search.render(width, { muted: text => theme.fg("dim", text) })] });
		this.addChild(new Spacer(1));
		this.addChild(this.#resultsList);
		this.addChild(new Spacer(1));
		this.addChild(new MenuHints(hint, text => theme.fg("dim", text), "jk gg/G C-u d e y"));
		this.addChild(new Spacer(1));

		this.#updateResults();
	}

	get filterFocused(): boolean {
		return this.#search.focused;
	}

	navigationSnapshot(): unknown {
		this.#flushPendingSearch();
		return {
			search: this.#search.navigationSnapshot(),
			selected: this.#menu.selectedItem && nativeEntryKey(this.#menu.selectedItem),
			top: this.#viewport.top,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object") return;
		const state = snapshot as { search?: unknown; selected?: string; top?: MenuViewportPosition | number };
		this.#cancelPendingSearch();
		this.#search.restoreNavigation(state.search);
		this.#updateResults();
		const index = this.#menu.visibleItems.findIndex(entry => nativeEntryKey(entry) === state.selected);
		if (index >= 0) this.#menu.setSelectedIndex(index);
		this.#viewport.setTop(state.top);
		this.#keys.reset();
		this.#nativeScroll = undefined;
		this.#nativeMemo = undefined;
	}

	leaveMenu(): void {
		this.#search.focused = false;
		this.#cancelPendingSearch();
	}

	#escape(): void {
		if (this.#search.focused || this.#search.value) {
			this.#search.setValue("");
			this.#search.focused = false;
			this.#updateResults();
		} else this.#onCancel();
		this.#keys.reset();
	}

	/**
	 * Repaint hook for debounced result updates. Once set, query edits search
	 * storage after a {@link SEARCH_DEBOUNCE_MS} quiet period instead of on
	 * every key; without it every edit searches synchronously.
	 */
	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	override dispose(): void {
		this.#cancelPendingSearch();
		super.dispose();
	}

	override render(width: number): readonly string[] {
		return this.#help.render(super.render(width), width);
	}

	handleInput(keyData: string): void {
		const before = this.#search.query;
		const field = this.#search.handleInput(keyData);
		if (field !== "pass") {
			this.#keys.reset();
			if (this.#search.query !== before) this.#scheduleResults();
			return;
		}
		if (this.#help.handleInput(keyData)) {
			this.#keys.reset();
			this.#onRequestRender?.();
			return;
		}
		if (matchesKey(keyData, "ctrl+c")) {
			this.#onCancel();
			return;
		}
		const action = this.#keys.read(keyData);
		if (!action || action === "pending") return;
		if (action.kind === "search") {
			this.#search.focused = true;
			return;
		}
		if (action.kind === "context") {
			this.#search.focused = !this.#search.focused;
			return;
		}
		if (action.kind === "cancel") {
			this.#escape();
			return;
		}
		if (action.kind === "confirm" || action.kind === "toggle") {
			this.#flushPendingSearch();
			const selected = this.#menu.selectedItem;
			if (selected) this.#onSelect(selected.prompt);
			return;
		}
		this.#flushPendingSearch();
		this.#resultsList.prepareViewport();
		applyMenuMotion(action, this.#menu, this.#viewport);
		const by = menuScrollBy(action);
		if (by) this.#nativeScroll = { by, n: (this.#nativeScroll?.n ?? 0) + 1 };
	}

	/**
	 * With the `picker` kind: a `size:"md"` sheet of past prompts (first line
	 * with hits, age, folder) as a keyed child the reconciler hoists into
	 * `layer`, since the selector replaces the editor in the dock. Otherwise
	 * the query field (the `Input`, which describes itself as `input`), the
	 * results as a `list` keyed by entry (filter = query, age as the item
	 * value), and the key hints.
	 */
	override describe(cx: DescribeContext): NativeNode {
		if (this.#help.open) return this.#help.describe();
		const items = this.#menu.visibleItems;
		const selected = this.#menu.selectedItem;
		const usePicker = cx.supports("picker");
		const query = this.#searchInput.getValue();
		const cursor = this.#searchInput.getCursor();
		const memo = this.#nativeMemo;
		if (
			memo &&
			memo.picker === usePicker &&
			memo.items === items &&
			memo.selected === selected &&
			memo.query === query &&
			memo.cursor === cursor &&
			memo.focused === this.#search.focused &&
			memo.scroll === this.#nativeScroll
		) {
			return memo.node;
		}
		if (usePicker) {
			const root = col([keyed(this.#describePicker(items, selected, query), PICKER_KEY)]);
			this.#nativeMemo = {
				picker: true,
				items,
				selected,
				query,
				cursor,
				focused: this.#search.focused,
				scroll: this.#nativeScroll,
				node: root,
			};
			return root;
		}

		const rows = items.map(entry =>
			node(
				"item",
				{
					label: entry.prompt.replace(/\s+/g, " ").trim(),
					value: [span(pickerAge(entry.created_at * 1000), "dim")],
				},
				undefined,
				nativeEntryKey(entry),
			),
		);
		const list = {
			...node(
				"list",
				{
					selected: selected ? nativeEntryKey(selected) : null,
					filter: this.#search.query || undefined,
					empty: this.#search.query ? "No matching history" : "No history yet",
					max: { lines: MAX_VISIBLE },
					virtual: true,
				},
				rows,
				"list",
			),
			scroll: this.#nativeScroll,
		};
		this.#nativeHints = hintsRow([
			{ keys: ["j", "k", "up", "down"], label: "navigate" },
			{ keys: ENTER_KEYS, label: "select" },
			{ keys: ["/"], label: "search" },
			{ keys: ["escape"], label: this.#search.focused ? "back to list" : "close" },
		]);
		const queryError = compileMenuRegex(query)?.error;
		const root = overlayCard(this.nativeRole, this.title, [
			this.#searchInput,
			...(queryError ? [node("text", { spans: [span(queryError, "error")] })] : []),
			list,
			this.#nativeHints,
		]);
		this.#nativeMemo = {
			picker: false,
			items,
			selected,
			query,
			cursor,
			focused: this.#search.focused,
			scroll: this.#nativeScroll,
			node: root,
		};
		return root;
	}

	#describePicker(
		items: readonly HistorySearchEntry[],
		selected: HistorySearchEntry | undefined,
		query: string,
	): NativeNode {
		let rows = this.#pickerItems;
		if (rows?.items !== items) {
			const tokens = queryTokens(this.#search.query);
			rows = { items, rows: items.map(entry => historyPickerItem(entry, tokens)) };
			this.#pickerItems = rows;
		}
		return picker({
			title: this.title,
			subtitle: compileMenuRegex(query)?.error,
			icon: "history",
			noun: "prompts",
			size: "md",
			layout: "rows",
			preview: "none",
			...pickerQuery(this.#searchInput),
			placeholder: "Search prompts…",
			columns: [{ id: "when", format: "time" }],
			items: rows.rows,
			selected: selected ? nativeEntryKey(selected) : null,
			empty: "No history yet",
			actions: [
				pickerAction("insert", "Insert", "enter", { primary: true }),
				pickerAction(
					"close",
					this.#search.focused ? "Back to list" : "Close",
					boundKeys("app.interrupt", ["escape"])[0] ?? "escape",
					{ end: true },
				),
			],
		});
	}

	/**
	 * Picker: a row click highlights, a second click or `Insert` inserts it
	 * (Enter), `Back to list` leaves the query, `Close` cancels, `Clear search` empties the query.
	 * List: picking a result does what highlighting it and pressing Enter does.
	 * A row picked while a debounced search is pending belongs to the previous
	 * query: results are refreshed first and the pick only lands if that entry
	 * is still among them.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		const ev = pickerEvent(event, PICKER_KEY);
		if (ev) {
			if (ev.kind === "action") {
				if (ev.act === "close") this.#escape();
				else if (ev.act === "insert") this.handleInput("\r");
				else if (ev.act === "clear") {
					this.#search.setValue("");
					this.#updateResults();
				}
				return;
			}
			this.#flushPendingSearch();
			const index = this.#menu.visibleItems.findIndex(entry => nativeEntryKey(entry) === ev.item);
			if (index < 0) return;
			this.#search.focused = false;
			this.#keys.reset();
			this.#menu.setSelectedIndex(index);
			this.#viewport.reveal();
			if (ev.kind === "activate") this.#onSelect(this.#menu.visibleItems[index]!.prompt);
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || event.key !== "list") return;
		this.#flushPendingSearch();
		const index = this.#menu.visibleItems.findIndex(entry => nativeEntryKey(entry) === event.item);
		const target = this.#menu.visibleItems[index];
		if (!target) return;
		this.#search.focused = false;
		this.#keys.reset();
		this.#menu.setSelectedIndex(index);
		this.#viewport.reveal();
		this.#onSelect(target.prompt);
	}

	/**
	 * Refresh results after a query edit: fuzzy trailing whitespace is ignored,
	 * while regex whitespace is literal. Empty queries refresh immediately;
	 * other changes debounce when a repaint hook is wired.
	 */
	#scheduleResults(): void {
		const rawQuery = this.#search.query;
		const query = compileMenuRegex(rawQuery) ? rawQuery : rawQuery.trim();
		if (query === this.#resultsQuery) {
			this.#cancelPendingSearch();
			return;
		}
		const requestRender = this.#onRequestRender;
		if (!query || !requestRender || compileMenuRegex(rawQuery)?.error) {
			this.#updateResults();
			return;
		}
		this.#cancelPendingSearch();
		this.#searchTimer = setTimeout(() => {
			this.#searchTimer = undefined;
			this.#updateResults();
			requestRender();
		}, SEARCH_DEBOUNCE_MS);
	}

	/** Run a pending debounced search now, so selection acts on the current query's results. */
	#flushPendingSearch(): void {
		if (this.#searchTimer === undefined) return;
		this.#cancelPendingSearch();
		this.#updateResults();
	}

	#cancelPendingSearch(): void {
		if (this.#searchTimer === undefined) return;
		clearTimeout(this.#searchTimer);
		this.#searchTimer = undefined;
	}

	#updateResults(): void {
		this.#cancelPendingSearch();
		const rawQuery = this.#search.query;
		const regex = compileMenuRegex(rawQuery);
		const query = regex ? rawQuery : rawQuery.trim();
		this.#resultsQuery = query;
		const results = regex?.error
			? []
			: query
				? this.#historyStorage.search(query, this.#resultLimit)
				: this.#historyStorage.getRecent(this.#resultLimit);
		this.#menu.setItems(results);
		this.#menu.moveToBoundary("first");
		this.#viewport.reveal();
		this.#resultsList.setTokens(query ? queryTokens(query) : []);
	}
}
