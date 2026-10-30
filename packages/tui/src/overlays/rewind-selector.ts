/**
 * Fullscreen esc-esc rewind selector.
 *
 * Replays the current session's branch with {@link ChatTranscriptBuilder} on
 * the alternate screen (`ui.showOverlay(..., { fullscreen: true })`) and moves
 * a dotted outline over the rendered transcript block the rewind would land
 * on, instead of listing user messages in a detached picker. Entries that
 * render nothing (notices, hidden custom messages, tool results folded into
 * their call cards) are never outlined: results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output, and the rest
 * are skipped entirely.
 *
 * When the outlined turn has sibling branches in the session tree, the region
 * below the divergence renders as a horizontal strip of half-width columns —
 * the current path first, each alternate branch beside it — and Left/Right
 * slide between them with an eased camera animation. Sibling columns are
 * fully rendered transcripts of that branch's most-recent path, built lazily
 * and cached per divergence.
 *
 * Keys: j/k and Up/Down step through rendered items in the active column.
 * h/l and Left/Right slide between branch variants at forks and jump between
 * user turns elsewhere; Tab/Shift-Tab traverse the same contexts. `/` or `f`
 * focuses the retained filter; Esc leaves the field, then closes the picker.
 * Ctrl-u/d and PageUp/Down page the selection; gg/G select bounds; Ctrl-e/y
 * scroll only the view. Enter rewinds (never Space). A loads earlier turns
 * without changing selection; stepping above the startup tail loads them too.
 *
 * In a TSP terminal (Tern) the same replay is a page, not a sheet: a screen
 * surface of the transcript's own blocks with `pick`/`drop` marks in place of
 * the dotted outline (see `describeScreen`).
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	matchesKey,
	padding,
	routeSgrMouseInput,
	sliceByColumn,
	type TUI,
	truncateToWidth,
} from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import { recentTranscriptEntries, type TranscriptEntryLike as TranscriptEntry } from "../chat/transcript-entry";
import { theme } from "../theme/theme";
import { matchesAppToolsExpand } from "../keybinding-matchers";
import { ChatTranscriptBuilder } from "../chat/chat-transcript-builder";
import {
	nearestVisibleOutlineTarget,
	TranscriptBrowser,
	type TranscriptBrowserFrame,
} from "../chat/transcript-browser";
import { padToWidth } from "../render/utils";
import { expandKeyHint } from "../render/render-utils";
import { formatKeyHints } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	appendOutlineEntries,
	type ComposedColumn,
	composeOutlineColumn,
	describedVisibility,
	type OutlineTarget,
	isUserTurnEntry,
	outlineVisibility,
	positionRail,
	userTurnLabel,
} from "../chat/transcript-outline";
import type { TspMark } from "@oh-my-pi/pi-wire";
import { kbd, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeScreen, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, actionHint, hintsRow, type NativeHint } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import { collectBlocks, targetCopy } from "./copy-selector";
import { compileMenuRegex } from "../menu-search";
import { MenuKeyReader, MenuSearchField } from "../components/menu-navigation";

/** One alternate branch at a divergence: its root and message path root → most-recent leaf. */
export interface BranchVariantPath {
	rootId: string;
	entries: TranscriptEntry[];
}

export interface RewindSelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandThinkingBlocks?: () => boolean;
	linkTargets?: ReadonlyMap<string, string>;
	requestRender: () => void;
	/** Sibling branch paths of `entryId`'s turn (excluding the turn itself). */
	siblingPaths?: (entryId: string) => BranchVariantPath[];
	/** Rewind the session to `entryId` (a message entry anywhere in the tree). */
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

/** Lazily built transcript column for one alternate branch. */
interface SiblingColumn {
	rootId: string;
	builder: ChatTranscriptBuilder;
	targets: OutlineTarget[];
	/** Short label for the column header: the branch's first user prompt. */
	label: string;
}

/**
 * A replayed block on the rewind page, carrying a transient `mark`: it
 * describes as the block with the mark merged into its root props, and hands
 * events and rendering to the block.
 */
class MarkedBlock implements Component {
	mark: TspMark | undefined;
	#memo: { node: NativeNode; mark: TspMark; out: NativeNode } | undefined;

	constructor(readonly block: Component) {}

	render(width: number): readonly string[] {
		return this.block.render(width);
	}

	invalidate(): void {
		this.block.invalidate?.();
	}

	describe(cx: DescribeContext): NativeNode | null {
		const described = this.block.describe?.(cx) ?? null;
		const mark = this.mark;
		if (!described || !mark) return described;
		const memo = this.#memo;
		if (memo?.node === described && memo.mark === mark) return memo.out;
		const out = node(described.k, { ...described.p, mark }, described.c, described.key);
		this.#memo = { node: described, mark, out };
		return out;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.block.handleNativeEvent?.(event);
	}
}

const kMarked = Symbol("rewind.marked");

/** A replayed block tagged with its page wrapper, so stepping reuses one wrapper per block. */
interface MarkTagged {
	[kMarked]?: MarkedBlock;
}

/** The page's first row while older history is unreplayed: `a` loads it. */
const EARLIER_TURNS = node(
	"row",
	{ role: "omp.rewind.earlier", gap: "xs", align: "center" },
	[kbd("a"), text([span("load earlier turns", "muted")])],
	"earlier",
);

/** Blank columns between branch-strip columns. */
const STRIP_GAP = 2;
/** Duration of the branch-swap camera slide. */
const SLIDE_MS = 160;

const NORMAL_MOTION_HINTS: readonly NativeHint[] = [
	{ keys: ["ctrl+u", "ctrl+d"], label: "half page" },
	{ keys: ["pageUp", "pageDown"], label: "page" },
	{ keys: ["g", "shift+g"], label: "gg/G bounds" },
	{ keys: ["ctrl+e", "ctrl+y"], label: "view" },
	{ keys: ["tab", "shift+tab"], label: "context" },
];

/** Same length and identical elements (or both undefined). */
function sameElements<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export class RewindSelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#browser: TranscriptBrowser;
	#targets: OutlineTarget[] = [];
	#selected = 0;
	/** Per-main-target "renders at least one non-blank row", refreshed each frame. */
	#mainVisible: boolean[] | undefined;
	/** Same, for the active sibling column. */
	#siblingVisible: boolean[] | undefined;
	#expanded = false;

	// Branch strip: present when the selected turn has sibling branches.
	// Column 0 is the current path; siblings follow in tree order.
	#variantCache = new Map<string, SiblingColumn[]>();
	/** 0 = current path column; 1..n = sibling column index + 1. */
	#activeVariant = 0;
	/** Selected target within the active sibling column. */
	#siblingSelected = 0;
	/** Camera slide between variant positions (fractional column index). */
	#slide: { from: number; to: number; startedAt: number } | undefined;
	#slideTimer: NodeJS.Timeout | undefined;
	readonly #keys = new MenuKeyReader();
	readonly #search = new MenuSearchField();
	#width = 0;
	#pageStarts: number[] = [];
	#pageEnds: number[] = [];
	#geometryTargets: OutlineTarget[] | undefined;
	#geometrySelected = -1;
	#geometryVariant = -1;
	#geometrySiblingSelected = -1;
	#geometryExpanded = false;
	#geometryFilter: string | undefined;

	/** Whole branch; the selector may currently replay only its tail. */
	#entries: TranscriptEntry[];
	/** True while older history is still unreplayed. */
	#truncated = false;
	/** The transcript projection follows only the confirmed query. */
	get #filter(): string | undefined {
		return this.#search.query || undefined;
	}
	/** Main transcript rows from the last frame; the filter matches what is on screen. */
	#mainRows: readonly (readonly string[])[] = [];
	/** Plain text per rendered child row array, cached by stable row identity. */
	#rowText = new WeakMap<readonly string[], { raw: string; lower: string }>();
	/** Native filter haystacks per main target (no rendered rows under TSP). */
	#nativeTexts: { targets: OutlineTarget[]; texts: { raw: string; lower: string }[] } | undefined;
	/** Compiled word patterns of the last filter query. */
	#filterPatterns: { query: string; patterns: RegExp[] } | undefined;
	/**
	 * Last {@link #filterMatches} result and its inputs. Frames hand back fresh
	 * outer `mainRows`/`mainVisible` arrays over cached per-child rows, so those
	 * compare element-wise.
	 */
	#filterMemo:
		| {
				query: string;
				targets: OutlineTarget[];
				expanded: boolean;
				native: boolean;
				mainRows: readonly (readonly string[])[];
				mainVisible: readonly boolean[] | undefined;
				matches: readonly number[];
		  }
		| undefined;
	/** Last described bar and the state it was built from. */
	#bar: { memo: string; targets: OutlineTarget[]; node: NativeNode } | undefined;

	constructor(
		entries: TranscriptEntry[],
		private readonly deps: RewindSelectorDeps,
	) {
		this.#entries = entries;
		this.#search.input.placeholder = "words…";
		const tail = recentTranscriptEntries(entries);
		this.#truncated = tail.length < entries.length;
		this.#builder = this.#replay(tail);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#browser = new TranscriptBrowser({
			getHeight: () => this.deps.ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#frame(context.contentWidth, context.chromeWidth),
		});
	}

	get filterFocused(): boolean {
		return this.#search.focused;
	}

	navigationSnapshot(): unknown {
		const column = this.#activeVariant > 0 ? this.#stripColumns()[this.#activeVariant - 1] : undefined;
		return {
			selected: this.#targets[this.#selected]?.turnId,
			variant: column?.rootId,
			sibling: column?.targets[this.#siblingSelected]?.entryId,
			search: this.#search.navigationSnapshot(),
			expanded: this.#expanded,
			truncated: this.#truncated,
			viewport: this.#browser.navigationSnapshot(),
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object") return;
		const state = snapshot as {
			selected?: string;
			variant?: string;
			sibling?: string;
			search?: unknown;
			expanded?: boolean;
			truncated?: boolean;
			viewport?: unknown;
		};
		this.leaveMenu();
		this.#search.restoreNavigation(state.search);
		if (typeof state.expanded === "boolean") this.#expanded = state.expanded;
		if (typeof state.truncated === "boolean" && state.truncated !== this.#truncated) {
			const entries = state.truncated ? recentTranscriptEntries(this.#entries) : this.#entries;
			const previous = this.#builder;
			this.#builder = this.#replay(entries);
			previous.dispose();
			this.#truncated = entries.length < this.#entries.length;
		} else this.#builder.setExpanded(this.#expanded);
		for (const columns of this.#variantCache.values())
			for (const column of columns) column.builder.setExpanded(this.#expanded);
		const selected = this.#targets.findIndex(target => target.turnId === state.selected);
		if (selected >= 0) this.#selected = selected;
		this.#activeVariant = 0;
		this.#siblingSelected = 0;
		if (state.variant) {
			const columns = this.#stripColumns();
			const index = columns.findIndex(column => column.rootId === state.variant);
			if (index >= 0) {
				this.#activeVariant = index + 1;
				const sibling = columns[index]!.targets.findIndex(target => target.entryId === state.sibling);
				if (sibling >= 0) this.#siblingSelected = sibling;
			}
		}
		this.#mainRows = [];
		this.#mainVisible = undefined;
		this.#siblingVisible = undefined;
		this.#geometryTargets = undefined;
		this.#filterMemo = undefined;
		this.#bar = undefined;
		this.#browser.restoreNavigation(state.viewport);
	}

	leaveMenu(): void {
		this.#search.focused = false;
		this.#stopSlide();
		this.#keys.reset();
	}

	#ensureGeometry(): void {
		if (
			!this.#browser.bodyHeight ||
			this.#geometryTargets !== this.#targets ||
			this.#geometrySelected !== this.#selected ||
			this.#geometryVariant !== this.#activeVariant ||
			this.#geometrySiblingSelected !== this.#siblingSelected ||
			this.#geometryExpanded !== this.#expanded ||
			this.#geometryFilter !== this.#filter
		) {
			this.render(this.#width || this.deps.ui.terminal?.columns || process.stdout.columns || 80);
		}
	}

	#pageSize(): number {
		this.#ensureGeometry();
		const top = this.#browser.scrollOffset;
		const bottom = top + this.#browser.bodyHeight;
		let first = 0;
		let end = this.#pageEnds.length;
		while (first < end) {
			const middle = (first + end) >>> 1;
			if (this.#pageEnds[middle]! <= top) first = middle + 1;
			else end = middle;
		}
		const visible =
			this.#filter !== undefined ? undefined : this.#activeVariant > 0 ? this.#siblingVisible : this.#mainVisible;
		let count = 0;
		for (let index = first; index < this.#pageStarts.length && this.#pageStarts[index]! < bottom; index++) {
			if (this.#pageEnds[index]! > this.#pageStarts[index]! && visible?.[index] !== false) count++;
		}
		return Math.max(1, count);
	}

	#recordPageGeometry(
		rows: readonly (readonly string[])[],
		targets: readonly OutlineTarget[],
		selected: number,
		lineOffset = 0,
		destinationStart = 0,
		targetCount = targets.length,
	): void {
		this.#pageStarts.length = destinationStart + targetCount;
		this.#pageEnds.length = destinationStart + targetCount;
		let child = 0;
		let offset = lineOffset;
		for (let index = 0; index < targetCount; index++) {
			const target = targets[index]!;
			while (child < target.start) offset += rows[child++]?.length ?? 0;
			this.#pageStarts[destinationStart + index] = offset;
			while (child < target.end) offset += rows[child++]?.length ?? 0;
			if (index === selected) offset += 2;
			this.#pageEnds[destinationStart + index] = offset;
		}
	}

	#boundary(edge: "first" | "last"): void {
		if (this.#filter === undefined && this.#activeVariant === 0 && edge === "first" && this.#truncated)
			this.#loadFullHistory(false);
		this.#ensureGeometry();
		if (this.#filter !== undefined) {
			const matches = this.#filterMatches();
			const next = edge === "first" ? matches[0] : matches.at(-1);
			if (next !== undefined) this.#selected = next;
		} else if (this.#activeVariant > 0) {
			const targets = this.#stripColumns()[this.#activeVariant - 1]?.targets ?? [];
			const direction = edge === "first" ? 1 : -1;
			let index = edge === "first" ? 0 : targets.length - 1;
			while (index >= 0 && index < targets.length && this.#siblingVisible?.[index] === false) index += direction;
			if (index >= 0 && index < targets.length) this.#siblingSelected = index;
		} else {
			const direction = edge === "first" ? 1 : -1;
			let index = edge === "first" ? 0 : this.#targets.length - 1;
			while (index >= 0 && index < this.#targets.length && !this.#isMainSelectable(index)) index += direction;
			if (index >= 0 && index < this.#targets.length) this.#selected = index;
		}
		this.deps.requestRender();
	}

	/** Number of selectable rewind points on the current path; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	#newBuilder(): ChatTranscriptBuilder {
		const builder = new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			expandThinkingBlocks: this.deps.expandThinkingBlocks,
			linkTargets: this.deps.linkTargets,
			requestRender: this.deps.requestRender,
		});
		builder.setExpanded(this.#expanded);
		return builder;
	}

	/** Build a transcript for `entries` and adopt its targets. */
	#replay(entries: TranscriptEntry[]): ChatTranscriptBuilder {
		const builder = this.#newBuilder();
		this.#targets = appendOutlineEntries(builder, entries);
		return builder;
	}

	/** Replay the whole branch, keeping the main outline on the same turn. */
	#loadFullHistory(requestRender = true): void {
		if (!this.#truncated) return;
		const selectedId = this.#targets[this.#selected]?.turnId;
		const previous = this.#builder;
		this.#builder = this.#replay(this.#entries);
		previous.dispose();
		this.#truncated = false;
		this.#mainVisible = undefined;
		this.#mainRows = [];
		const restored = selectedId ? this.#targets.findIndex(target => target.turnId === selectedId) : -1;
		this.#selected = restored >= 0 ? restored : Math.max(0, this.#targets.length - 1);
		if (requestRender) this.deps.requestRender();
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.container.invalidate();
		}
		this.#browser.invalidate();
	}

	dispose(): void {
		this.leaveMenu();
		this.#builder.dispose();
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.dispose();
		}
		this.#variantCache.clear();
	}

	// ========================================================================
	// Branch strip
	// ========================================================================

	/** Sibling columns for the selected turn, built lazily and cached per divergence. */
	#stripColumns(): SiblingColumn[] {
		const target = this.#targets[this.#selected];
		if (!target || !this.deps.siblingPaths) return [];
		const cached = this.#variantCache.get(target.turnId);
		if (cached) return cached;
		const columns: SiblingColumn[] = [];
		for (const sibling of this.deps.siblingPaths(target.turnId)) {
			if (sibling.entries.length === 0) continue;
			const builder = this.#newBuilder();
			const targets = appendOutlineEntries(builder, sibling.entries);
			const firstUser = sibling.entries.find(isUserTurnEntry);
			const label = (firstUser && userTurnLabel(firstUser)) || sibling.rootId;
			columns.push({ rootId: sibling.rootId, builder, targets, label });
		}
		this.#variantCache.set(target.turnId, columns);
		return columns;
	}

	/** The target the dotted outline currently rests on. */
	#outlinedTarget(): OutlineTarget | undefined {
		if (this.#activeVariant > 0) {
			return this.#stripColumns()[this.#activeVariant - 1]?.targets[this.#siblingSelected];
		}
		return this.#targets[this.#selected];
	}

	#slideTo(variant: number): void {
		const now = Date.now();
		const from = this.#slidePosition(now);
		this.#slide = { from, to: variant, startedAt: now };
		this.#activeVariant = variant;
		// The camera slide is repaint-only; a native surface has no camera to move.
		if (isNativeRendering()) {
			this.deps.requestRender();
			return;
		}
		this.#slideTimer ??= setInterval(() => {
			if (!this.#slide || Date.now() - this.#slide.startedAt >= SLIDE_MS) this.#stopSlide();
			this.deps.requestRender();
		}, 16);
		this.deps.requestRender();
	}

	#stopSlide(): void {
		this.#slide = undefined;
		if (this.#slideTimer !== undefined) {
			clearInterval(this.#slideTimer);
			this.#slideTimer = undefined;
		}
	}

	/** Fractional variant position of the camera at `now` (eased). */
	#slidePosition(now: number): number {
		if (!this.#slide) return this.#activeVariant;
		const t = Math.min(1, (now - this.#slide.startedAt) / SLIDE_MS);
		const eased = 1 - (1 - t) ** 3;
		return this.#slide.from + (this.#slide.to - this.#slide.from) * eased;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null && this.#browser.scroll(event.wheel * 3)) this.deps.requestRender();
				return true;
			});
			return;
		}
		const before = this.#search.query;
		const field = this.#search.handleInput(data);
		if (field !== "pass") {
			this.#keys.reset();
			if (this.#search.query !== before) {
				if (!isNativeRendering() && this.#mainRows.length === 0) this.#ensureGeometry();
				this.#filterChanged();
			} else this.deps.requestRender();
			return;
		}
		if (matchesKey(data, "f")) {
			this.#openFilter();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#toggleExpanded();
			return;
		}
		if (data === "a" || data === "A") {
			this.#loadFullHistory();
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (!action) {
			if (this.#browser.handleScrollKey(data)) this.deps.requestRender();
			return;
		}
		if (action.kind === "search") this.#openFilter();
		else if (action.kind === "cancel") this.deps.onCancel();
		else if (action.kind === "horizontal" || action.kind === "context") {
			if (action.kind === "context") this.#search.focused = false;
			if (this.#filter !== undefined) this.#stepFiltered(action.delta, true);
			else if (action.delta < 0) this.#left();
			else this.#right();
		} else if (action.kind === "move") {
			if (this.#filter !== undefined) this.#stepFiltered(action.delta, false);
			else this.#moveVertical(action.delta);
		} else if (action.kind === "halfPage" || action.kind === "page") {
			const page = this.#pageSize();
			const delta = action.delta * Math.max(1, Math.floor(page / (action.kind === "halfPage" ? 2 : 1)));
			if (this.#filter !== undefined) this.#stepFiltered(delta, false);
			else this.#moveVertical(delta, false);
		} else if (action.kind === "boundary") this.#boundary(action.edge);
		else if (action.kind === "confirm") {
			if (this.#filter !== undefined) this.#selectFiltered();
			else this.#selectOutlined();
		} else if (action.kind === "scroll") {
			this.#browser.handleMenuAction(action);
			this.deps.requestRender();
		}
		// Rewinding changes the branch: Space never activates it.
	}

	/** `/` or the existing `f`: focus the retained filter over the whole branch. */
	#openFilter(): void {
		this.#loadFullHistory();
		this.#search.focused = true;
		this.#keys.reset();
		this.#activeVariant = 0;
		this.#siblingSelected = 0;
		this.#stopSlide();
		this.deps.requestRender();
	}

	/** Left: the previous branch at a fork, else the previous user turn. */
	#left(): void {
		if (this.#activeVariant > 0) this.#slideTo(this.#activeVariant - 1);
		else this.#move(-1, true);
	}

	/** Right: the next branch at a fork, else the next user turn. */
	#right(): void {
		const columns = this.#stripColumns();
		if (this.#activeVariant < columns.length) {
			this.#siblingSelected = 0;
			this.#slideTo(this.#activeVariant + 1);
		} else if (this.#activeVariant === 0) {
			this.#move(1, true);
		}
	}

	/** Enter while filtering: rewind to the selection when it matches. */
	#selectFiltered(): void {
		const target = this.#filterMatches().includes(this.#selected) ? this.#targets[this.#selected] : undefined;
		if (target) this.deps.onSelect(target.entryId);
	}

	/** Enter: rewind to the outlined turn (main path or the active branch column). */
	#selectOutlined(): void {
		const target = this.#outlinedTarget();
		if (target) this.deps.onSelect(target.entryId);
	}

	#toggleExpanded(): void {
		this.#expanded = !this.#expanded;
		this.#builder.setExpanded(this.#expanded);
		this.#mainRows = [];
		for (const columns of this.#variantCache.values()) {
			for (const column of columns) column.builder.setExpanded(this.#expanded);
		}
		this.deps.requestRender();
	}

	// ========================================================================
	// Filter
	// ========================================================================

	/** The query changed; keep the selection when it still matches, else rest on the newest match above it. */
	#filterChanged(): void {
		const matches = this.#filterMatches();
		if (!matches.includes(this.#selected)) {
			this.#selected = matches.findLast(index => index < this.#selected) ?? matches.at(-1) ?? this.#selected;
		}
		this.deps.requestRender();
	}

	#stepFiltered(delta: number, userTurnsOnly: boolean): void {
		const matches = this.#filterMatches();
		const direction = delta < 0 ? -1 : 1;
		let first = 0;
		let end = matches.length;
		while (first < end) {
			const middle = (first + end) >>> 1;
			if (matches[middle]! < this.#selected) first = middle + 1;
			else end = middle;
		}
		let position = first;
		if (direction < 0) position--;
		else if (matches[position] === this.#selected) position++;
		let remaining = Math.abs(delta);
		let next = this.#selected;
		for (; position >= 0 && position < matches.length && remaining > 0; position += direction) {
			const candidate = matches[position]!;
			if (userTurnsOnly && !this.#targets[candidate]!.isUserTurn) continue;
			next = candidate;
			remaining--;
		}
		if (next !== this.#selected) {
			this.#selected = next;
			this.deps.requestRender();
		}
	}

	/**
	 * Visible main-path target indices whose rendered text contains every
	 * whitespace-separated Latin query word as a whole word (case-insensitive:
	 * `ls` matches `ls -la` but not `tools`). Other scripts match substrings so
	 * a Chinese query can find text inside a sentence without spaces.
	 * All visible targets match an empty query.
	 * Matching the rendered rows keeps results honest: collapsed tool output
	 * only matches once the configured tool-expansion action expands it.
	 */
	#filterMatches(): readonly number[] {
		const query = this.#filter ?? "";
		const native = isNativeRendering();
		const memo = this.#filterMemo;
		if (
			memo &&
			memo.query === query &&
			memo.targets === this.#targets &&
			memo.expanded === this.#expanded &&
			memo.native === native &&
			sameElements(memo.mainVisible, this.#mainVisible) &&
			(native || sameElements(memo.mainRows, this.#mainRows))
		) {
			memo.mainRows = this.#mainRows;
			memo.mainVisible = this.#mainVisible;
			return memo.matches;
		}
		const patterns = this.#compileFilter(query);
		const regex = compileMenuRegex(query);
		if (native && this.#nativeTexts?.targets !== this.#targets) {
			this.#nativeTexts = {
				targets: this.#targets,
				// Turn text plus its commands and tool output, like the expanded rendered rows.
				texts: this.#targets.map(target => {
					const blocks = collectBlocks(target.entries);
					const parts = [targetCopy(target, blocks).content, ...blocks.map(block => block.content)];
					const raw = parts.join("\n");
					return { raw, lower: raw.toLowerCase() };
				}),
			};
		}
		const matches: number[] = [];
		for (let index = 0; index < this.#targets.length; index++) {
			if (!this.#isMainSelectable(index)) continue;
			const target = this.#targets[index]!;
			const matched = native
				? patterns.every(pattern => pattern.test((regex ? this.#nativeTexts?.texts[index]?.raw : this.#nativeTexts?.texts[index]?.lower) ?? ""))
				: patterns.every(pattern => {
						for (let child = target.start; child < target.end; child++) {
							const rows = this.#mainRows[child];
							if (rows !== undefined && pattern.test(this.#plainRowText(rows, !!regex))) return true;
						}
						return false;
					});
			if (matched) matches.push(index);
		}
		this.#filterMemo = {
			query,
			targets: this.#targets,
			expanded: this.#expanded,
			native,
			mainRows: this.#mainRows,
			mainVisible: this.#mainVisible,
			matches,
		};
		return matches;
	}

	/** Word patterns of `query`, compiled once per distinct query. */
	#compileFilter(query: string): RegExp[] {
		const cached = this.#filterPatterns;
		if (cached?.query === query) return cached.patterns;
		const regex = compileMenuRegex(query);
		if (regex) {
			const patterns = [regex.regex ?? /(?!)/];
			this.#filterPatterns = { query, patterns };
			return patterns;
		}
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const patterns = words.map(word =>
			/^[\p{Script=Latin}\p{N}_]+$/u.test(word)
				? new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(word)}(?![\\p{L}\\p{N}_])`, "u")
				: new RegExp(RegExp.escape(word), "u"),
		);
		this.#filterPatterns = { query, patterns };
		return patterns;
	}

	/** Plain text of one rendered child row array, cached by array identity. */
	#plainRowText(rows: readonly string[], raw: boolean): string {
		let text = this.#rowText.get(rows);
		if (text === undefined) {
			const original = Bun.stripANSI(rows.join("\n"));
			text = { raw: original, lower: original.toLowerCase() };
			this.#rowText.set(rows, text);
		}
		return raw ? text.raw : text.lower;
	}

	/** Move inside a column; only a single-row Up may leave a sibling's top. */
	#moveVertical(delta: number, allowColumnExit = true): void {
		if (this.#activeVariant === 0) {
			this.#move(delta);
			return;
		}
		const targets = this.#stripColumns()[this.#activeVariant - 1]?.targets ?? [];
		const direction = delta < 0 ? -1 : 1;
		let changed = false;
		for (let step = 0; step < Math.abs(delta); step++) {
			let index = this.#siblingSelected + direction;
			while (index >= 0 && index < targets.length && this.#siblingVisible?.[index] === false) index += direction;
			if (index >= 0 && index < targets.length) {
				this.#siblingSelected = index;
				changed = true;
			} else if (direction < 0 && allowColumnExit) {
				this.#activeVariant = 0;
				this.#siblingSelected = 0;
				this.#stopSlide();
				if (!this.#move(-1)) this.deps.requestRender();
				return;
			} else break;
		}
		if (changed) this.deps.requestRender();
	}

	/** Clamp main-path stepping, loading the earlier tail only when needed. */
	#move(delta: number, userTurnsOnly = false): boolean {
		const direction = delta < 0 ? -1 : 1;
		let changed = false;
		for (let step = 0; step < Math.abs(delta); step++) {
			let index = this.#selected + direction;
			while (
				index >= 0 &&
				index < this.#targets.length &&
				(!this.#isMainSelectable(index) || (userTurnsOnly && !this.#targets[index]!.isUserTurn))
			)
				index += direction;
			if (index < 0 && this.#truncated) {
				this.#loadFullHistory(false);
				changed = true;
				index = this.#selected + direction;
				while (
					index >= 0 &&
					(!this.#isMainSelectable(index) || (userTurnsOnly && !this.#targets[index]!.isUserTurn))
				)
					index += direction;
			}
			if (index < 0 || index >= this.#targets.length) break;
			this.#selected = index;
			changed = true;
		}
		if (changed) {
			this.#activeVariant = 0;
			this.#siblingSelected = 0;
			this.#stopSlide();
			this.deps.requestRender();
		}
		return changed;
	}

	#isMainSelectable(index: number): boolean {
		return this.#mainVisible?.[index] ?? true;
	}

	/**
	 * Adopt the main path's per-target visibility. A selection on a target
	 * that shows nothing (the empty turn an interrupt leaves last, a turn the
	 * expansion toggle collapsed) moves to the nearest one that shows and
	 * leaves the strip.
	 */
	#adoptVisibility(visible: boolean[]): void {
		this.#mainVisible = visible;
		const selected = nearestVisibleOutlineTarget(visible, this.#selected);
		if (selected === this.#selected) return;
		this.#selected = selected;
		this.#activeVariant = 0;
		this.#siblingSelected = 0;
	}

	// ========================================================================
	// Native: the transcript as a page
	// ========================================================================

	/**
	 * The rewind page: the replayed transcript fills a screen surface block by
	 * block, as the live one reads, the outlined turn marked `pick` under a
	 * "Continue from here" caption (revealed as the outline moves) and what the
	 * rewind drops marked `drop`. At a fork the region below it becomes a strip
	 * of branch columns, the current path first. The bar is this component's
	 * own node, docked under the page, so the filter field keeps the caret.
	 */
	describeScreen(cx: DescribeContext): NativeScreen {
		this.#adoptVisibility(describedVisibility(this.#builder.container.children, this.#targets, cx));
		return { role: "omp.rewind", main: this.#page(cx), dock: [this] };
	}

	/** The page's blocks, marked for the current outline. */
	#page(cx: DescribeContext): NativeChild[] {
		const blocks = this.#builder.container.children;
		const page: NativeChild[] = [];
		const filter = this.#filter;
		if (filter !== undefined) {
			// Only the matching turns of the current path, like the filtered frame.
			const matches = this.#filterMatches();
			for (const index of matches) {
				const target = this.#targets[index]!;
				const picked = index === this.#selected;
				if (picked) page.push(this.#caption(this.#targets, index, "main"));
				for (let i = target.start; i < target.end; i++)
					page.push(this.#marked(blocks[i]!, picked ? "pick" : undefined));
			}
			if (matches.length === 0) {
				page.push(text([span(`No turns match "${filter}"`, "muted")], { role: "omp.rewind.empty" }));
			}
			return page;
		}
		if (this.#truncated) page.push(EARLIER_TURNS);
		const columns = this.#stripColumns();
		const anchor = this.#targets[this.#selected];
		if (columns.length === 0 || !anchor) {
			this.#markRun(page, blocks, 0, this.#targets, this.#selected, "main");
			return page;
		}
		// Shared history above the fork at full width, then the branches side by side.
		for (let i = 0; i < anchor.start; i++) page.push(this.#marked(blocks[i]!, undefined));
		const count = columns.length + 1;
		const current: NativeChild[] = [this.#columnHead(0, count, "current")];
		this.#markRun(
			current,
			blocks,
			anchor.start,
			this.#targets,
			this.#activeVariant === 0 ? this.#selected : -1,
			"main",
		);
		const strip = [this.#column(0, current, "current")];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const active = this.#activeVariant === index + 1;
			if (active) {
				this.#siblingVisible = describedVisibility(column.builder.container.children, column.targets, cx);
			}
			const children: NativeChild[] = [this.#columnHead(index + 1, count, column.label)];
			const picked = active ? this.#siblingSelected : -1;
			this.#markRun(children, column.builder.container.children, 0, column.targets, picked, column.rootId);
			strip.push(this.#column(index + 1, children, column.rootId));
		}
		page.push(node("row", { role: "omp.rewind.strip", gap: "lg", align: "start" }, strip, "strip"));
		return page;
	}

	/**
	 * Push `blocks[from..]` marked for `targets[picked]` (-1: none): unmarked
	 * above it, then the caption and `pick` on its blocks, `drop` below.
	 */
	#markRun(
		out: NativeChild[],
		blocks: readonly Component[],
		from: number,
		targets: readonly OutlineTarget[],
		picked: number,
		column: string,
	): void {
		const target = targets[picked];
		for (let i = from; i < blocks.length; i++) {
			if (target && i === target.start) out.push(this.#caption(targets, picked, column));
			const mark = !target || i < target.start ? undefined : i < target.end ? "pick" : "drop";
			out.push(this.#marked(blocks[i]!, mark));
		}
	}

	/**
	 * The line over the outlined turn: what Enter does and what it drops.
	 * Keyed by the turn, so every step adds a fresh one that scrolls into view.
	 */
	#caption(targets: readonly OutlineTarget[], picked: number, column: string): NativeNode {
		const target = targets[picked]!;
		const below = targets.length - picked - 1;
		const spans = [
			span(`${theme.icon.rewind} `, "accent"),
			span(target.isUserTurn ? "Rewind to here" : "Continue from here", "accent strong"),
		];
		if (target.isUserTurn) spans.push(span(`${theme.sep.dot}the prompt returns to the editor`, "dim"));
		spans.push(
			span(
				below > 0
					? `${theme.sep.dot}${below} turn${below === 1 ? "" : "s"} below dropped`
					: `${theme.sep.dot}nothing below to drop`,
				"dim",
			),
		);
		const caption = text(spans, { role: "omp.rewind.here", wrap: "none" });
		return { ...caption, key: `here:${column}:${target.turnId}`, reveal: "start" };
	}

	/** One branch column of the strip; the active one carries the accent tone. */
	#column(index: number, children: readonly NativeChild[], key: string): NativeNode {
		const active = index === this.#activeVariant;
		return node(
			"col",
			{ role: "omp.rewind.branch", gap: "lg", ...(active ? { tone: "accent" } : {}) },
			children,
			key,
		);
	}

	/** A strip column's caption: `⎇ i/n · label`. */
	#columnHead(index: number, count: number, label: string): NativeNode {
		const active = index === this.#activeVariant;
		return text(
			[
				span(`${theme.icon.branch} `, active ? "accent" : "dim"),
				span(`${index + 1}/${count}`, active ? "accent" : "dim"),
				span(`${theme.sep.dot}${label}`, active ? "strong" : "dim"),
			],
			{ role: "omp.rewind.branch.head", wrap: "none" },
		);
	}

	/** `block` wrapped to carry `mark`; one wrapper per block, so ids and view state persist while stepping. */
	#marked(block: Component & MarkTagged, mark: TspMark | undefined): MarkedBlock {
		const marked = (block[kMarked] ??= new MarkedBlock(block));
		marked.mark = mark;
		return marked;
	}

	/** The bar docked under the page: position, key hints, Cancel and Rewind; the filter field while filtering. */
	describe(_cx: DescribeContext): NativeNode {
		const filter = this.#filter;
		const columns = filter === undefined ? this.#stripColumns() : [];
		const memo = `${this.#selected}|${this.#activeVariant}|${this.#siblingSelected}|${this.#truncated}|${columns.length}|${filter ?? "\0"}|${this.#search.focused}|${this.#search.value}|${this.#search.cursor}`;
		if (this.#bar?.memo === memo && this.#bar.targets === this.#targets) return this.#bar.node;

		const title = text([span(`${theme.icon.rewind} `, "accent"), span("Rewind", "strong")], { wrap: "none" });
		const upDown = actionHint(["tui.select.up", "tui.select.down"], "step");
		const rewind = actionButton("Rewind here", "rewind", { keys: "enter", tone: "accent" });
		let children: NativeChild[];
		if (filter === undefined && !this.#search.focused) {
			const column = columns[this.#activeVariant - 1];
			const at = column ? this.#siblingSelected : this.#selected;
			const of = column ? column.targets.length : this.#targets.length;
			children = [
				title,
				text([span(`${at + 1}/${of}`, "dim")], { wrap: "none" }),
				hintsRow([
					upDown,
					{ keys: ["h", "l", "left", "right"], label: columns.length > 0 ? "branches" : "user turns" },
					{ keys: ["/", "f"], label: "search" },
					...NORMAL_MOTION_HINTS,
					this.#truncated ? { keys: ["a"], label: "earlier turns" } : undefined,
				]),
				actionBar([null, actionButton("Cancel", "cancel", { keys: "escape" }), rewind]),
			];
		} else {
			const matches = this.#filterMatches();
			const at = matches.indexOf(this.#selected);
			children = [
				title,
				this.#search.input,
				...(compileMenuRegex(this.#search.value)?.error ? [text([span(compileMenuRegex(this.#search.value)!.error!, "error")])] : []),
				text(
					[
						matches.length === 0
							? span("no matches", "error")
							: span(`${at >= 0 ? at + 1 : "-"}/${matches.length}`, "dim"),
					],
					{ wrap: "none" },
				),
				hintsRow(
					this.#search.focused
						? [{ keys: ["enter"], label: "confirm search" }, { keys: ["escape"], label: "clear search" }]
						: [
								upDown,
								{ keys: ["h", "l", "left", "right"], label: "user turns" },
								{ keys: ["/", "f"], label: "search" },
								...NORMAL_MOTION_HINTS,
							],
				),
				actionBar([
					actionButton("Show all", "clear-filter"),
					actionButton(this.#search.focused ? "Back to list" : "Close", "cancel", { keys: "escape" }),
					rewind,
				]),
			];
		}
		const root = node("row", { role: "omp.rewind.bar", gap: "md", align: "center", wrap: true }, children);
		this.#bar = { memo, targets: this.#targets, node: root };
		return root;
	}

	/** The bar's buttons run their keys' paths; everything else belongs to the blocks. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		const filtering = this.#filter !== undefined;
		if (event.act === "rewind") {
			if (filtering) this.#selectFiltered();
			else this.#selectOutlined();
		} else if (event.act === "cancel") {
			if (this.#search.focused || this.#search.value) {
				this.#search.setValue("");
				this.#search.focused = false;
				this.#filterChanged();
			} else this.deps.onCancel();
		} else if (event.act === "clear-filter") {
			this.#search.setValue("");
			this.#search.focused = false;
			this.#filterChanged();
		}
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		this.#width = width;
		const lines = this.#browser.render(width);
		this.#geometryTargets = this.#targets;
		this.#geometrySelected = this.#selected;
		this.#geometryVariant = this.#activeVariant;
		this.#geometrySiblingSelected = this.#siblingSelected;
		this.#geometryExpanded = this.#expanded;
		this.#geometryFilter = this.#filter;
		return lines;
	}

	#frame(contentWidth: number, chromeWidth: number): TranscriptBrowserFrame {
		// The outline consumes two columns each side ("┆ " / " ┆"), unselected
		// rows a matching two-column left gutter so blocks never shift while stepping.
		const children = this.#builder.container.children;
		const prepared = this.#browser.prepareOutline(children, this.#targets, this.#selected, contentWidth);
		this.#mainRows = prepared.childRows;
		this.#adoptVisibility(prepared.visible);

		if (this.#filter !== undefined)
			return this.#filterFrame(this.#filter, prepared.childRows, contentWidth, chromeWidth);

		const columns = this.#stripColumns();
		if (columns.length === 0) this.#recordPageGeometry(prepared.childRows, this.#targets, this.#selected);
		const composed =
			columns.length > 0
				? this.#renderStrip(prepared.childRows, columns, contentWidth)
				: this.#browser.composeOutline({
						children,
						targets: this.#targets,
						selected: this.#selected,
						columnWidth: contentWidth,
						prepared,
					}).column;
		const position = this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : "";
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const leftRight = formatKeyHints(["left", "right"]);
		const lateral = columns.length > 0 ? `${leftRight} branches` : `${leftRight} user turns`;
		const keys = `j/k ${upDown} step · h/l ${lateral} · Tab context · / or f search · Ctrl-u/d half · PgUp/Dn · gg/G · Ctrl-e/y view · Enter rewind · ${this.#truncated ? "a earlier turns · " : ""}${expandKeyHint()} expand · ${editorKey("tui.select.cancel")} close`;
		return {
			header: [this.#header()],
			body: {
				lines: composed.lines,
				anchor: this.#outlineAnchor(composed),
			},
			footer: this.#search.focused
				? [this.#search.render(chromeWidth, { muted: text => theme.fg("dim", text) })]
				: [theme.fg("dim", `${position}${keys}`)],
		};
	}

	#header(): string {
		return `${theme.icon.rewind} ${theme.bold("Rewind")}${theme.sep.dot}${theme.fg("dim", "pick the point to continue from")}`;
	}

	/** Only the matching items of the current path, concatenated; no branch strip. */
	#filterFrame(
		query: string,
		childRows: readonly (readonly string[])[],
		contentWidth: number,
		chromeWidth: number,
	): TranscriptBrowserFrame {
		const matches = this.#filterMatches();
		const rows: (readonly string[])[] = [];
		const targets: OutlineTarget[] = [];
		for (const index of matches) {
			const target = this.#targets[index]!;
			const start = rows.length;
			rows.push(...childRows.slice(target.start, target.end));
			targets.push({ ...target, start, end: rows.length });
		}
		const selected = matches.indexOf(this.#selected);
		const composed = composeOutlineColumn(rows, 0, rows.length, targets, selected, contentWidth, undefined);
		this.#recordPageGeometry(rows, targets, selected);
		const lines = matches.length > 0 ? composed.lines : [theme.fg("muted", `  No items match "${query}"`)];
		const count =
			matches.length === 0
				? theme.fg("error", "no matches")
				: theme.fg("dim", `${selected >= 0 ? selected + 1 : "-"}/${matches.length}`);
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const keys = this.#search.focused
			? "Enter confirm search · Esc clear search"
			: `j/k ${upDown} step · h/l user turns · Ctrl-u/d half · PgUp/Dn · gg/G · Ctrl-e/y view · Enter rewind · Esc close`;
		return {
			header: [this.#header()],
			body: {
				lines,
				anchor:
					composed.selStart >= 0
						? {
								id: `rewind:filter:${query}:${this.#targets[this.#selected]?.turnId ?? this.#selected}`,
								start: composed.selStart,
								end: composed.selEnd,
							}
						: undefined,
			},
			footer: [
				this.#search.render(chromeWidth, { muted: text => theme.fg("dim", text) }),
				`${count} · ${theme.fg("dim", keys)}`,
			],
		};
	}

	/** Selection anchor keyed by the outlined turn/sibling identity plus its composed range. */
	#outlineAnchor(composed: ComposedColumn): { id: string; start: number; end: number } | undefined {
		if (composed.selStart < 0) return undefined;
		const outlined = this.#outlinedTarget();
		const id =
			this.#activeVariant > 0
				? `rewind:sibling:${this.#stripColumns()[this.#activeVariant - 1]?.rootId ?? this.#activeVariant}:${outlined?.entryId ?? this.#siblingSelected}`
				: `rewind:main:${outlined?.turnId ?? this.#selected}`;
		return { id, start: composed.selStart, end: composed.selEnd };
	}

	/**
	 * Shared prefix at full width, then the divergence as a camera-positioned
	 * strip of half-width branch columns (current path first, siblings after).
	 */
	#renderStrip(mainRows: (readonly string[])[], columns: SiblingColumn[], contentWidth: number): ComposedColumn {
		const anchor = this.#targets[this.#selected]!;
		const colWidth = Math.max(24, Math.floor((contentWidth - STRIP_GAP) / 2));
		const count = columns.length + 1;

		// Shared history above the fork, full width, never outlined.
		const prefix = composeOutlineColumn(mainRows, 0, anchor.start, [], -1, contentWidth, undefined);
		const stripTop = prefix.lines.length + (count > 2 ? 2 : 0);
		if (this.#activeVariant === 0) this.#recordPageGeometry(mainRows, this.#targets, -1, 0, 0, this.#selected);

		// Column 0: the current path from the fork down, re-rendered at column width.
		const suffixRows = this.#browser.renderOutlineRows(
			this.#builder.container.children.slice(anchor.start),
			colWidth,
		);
		const suffixTargets = this.#targets.slice(this.#selected).map(target => ({
			...target,
			start: target.start - anchor.start,
			end: target.end - anchor.start,
		}));
		const currentHeader = this.#columnHeader(0, count, "current", colWidth);
		if (this.#activeVariant === 0)
			this.#recordPageGeometry(suffixRows, suffixTargets, 0, stripTop + currentHeader.length, this.#selected);
		const composedColumns: ComposedColumn[] = [
			composeOutlineColumn(
				suffixRows,
				0,
				suffixRows.length,
				suffixTargets,
				this.#activeVariant === 0 ? 0 : -1,
				colWidth,
				currentHeader,
			),
		];
		for (let index = 0; index < columns.length; index++) {
			const column = columns[index]!;
			const rows = this.#browser.renderOutlineRows(column.builder.container.children, colWidth);
			const header = this.#columnHeader(index + 1, count, column.label, colWidth);
			if (this.#activeVariant === index + 1) {
				this.#siblingVisible = outlineVisibility(rows, column.targets);
				this.#recordPageGeometry(rows, column.targets, this.#siblingSelected, stripTop + header.length);
			}
			composedColumns.push(
				composeOutlineColumn(
					rows,
					0,
					rows.length,
					column.targets,
					this.#activeVariant === index + 1 ? this.#siblingSelected : -1,
					colWidth,
					header,
				),
			);
		}

		// Camera over the strip: keep the active (possibly mid-slide) column centered.
		const stride = colWidth + STRIP_GAP;
		const totalWidth = count * colWidth + (count - 1) * STRIP_GAP;
		const cameraAt = (position: number) =>
			Math.max(
				0,
				Math.min(position * stride - (contentWidth - colWidth) / 2, Math.max(0, totalWidth - contentWidth)),
			);
		const position = this.#slidePosition(Date.now());
		const camera = cameraAt(position);

		const height = Math.max(...composedColumns.map(column => column.lines.length));
		const lines = prefix.lines;
		// With more branches than the window fits, a dot rail tracks the active
		// column and dim ellipses flag content beyond the visible edge.
		// Edge markers follow the slide's destination, not the eased camera,
		// so they flip in step with the dot rail.
		if (count > 2) {
			const settled = cameraAt(this.#activeVariant);
			lines.push(
				positionRail(
					count,
					this.#activeVariant,
					settled > 0.5,
					settled + contentWidth < totalWidth - 0.5,
					contentWidth,
				),
				"",
			);
		}
		const active = composedColumns[this.#activeVariant]!;
		const selStart = active.selStart >= 0 ? lines.length + active.selStart : -1;
		const selEnd = active.selEnd >= 0 ? lines.length + active.selEnd : -1;
		for (let row = 0; row < height; row++) {
			let line = "";
			let filled = 0;
			for (let index = 0; index < count; index++) {
				const x0 = index * stride - camera;
				const x1 = x0 + colWidth;
				const visible0 = Math.max(0, x0);
				const visible1 = Math.min(contentWidth, x1);
				if (visible1 <= visible0) continue;
				const source = colWidth > 0 ? padToWidth(composedColumns[index]!.lines[row] ?? "", colWidth) : "";
				const slice = sliceByColumn(source, visible0 - x0, visible1 - visible0, true);
				line +=
					padding(Math.max(0, visible0 - filled)) +
					(visible1 - visible0 > 0 ? padToWidth(slice, visible1 - visible0) : "");
				filled = visible1;
			}
			lines.push(line);
		}
		return { lines, selStart, selEnd };
	}

	/** Two caption rows leading a strip column: `⎇ i/n · label` plus a spacer. */
	#columnHeader(index: number, count: number, label: string, columnWidth: number): string[] {
		const caption = truncateToWidth(
			`${theme.icon.branch} ${index + 1}/${count} ${theme.sep.dot} ${label}`,
			columnWidth - 2,
		);
		const active = index === this.#activeVariant;
		return [` ${theme.fg(active ? "accent" : "dim", caption)}`, ""];
	}
}
