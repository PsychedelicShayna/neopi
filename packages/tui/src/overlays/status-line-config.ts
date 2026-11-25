import { t } from "@oh-my-pi/pi-utils/i18n";
import { uiProvenanceSuffix } from "../theme/provenance";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { bottomBorder, dividerSplit, PanelRows, row, topBorderSplit } from "../chrome/overlay-box";
import { sanitizeStatusText } from "../chrome/shared";
import { Input } from "../components/input";
import { compileMenuRegex } from "../menu-search";
import { MenuKeyReader, MenuSearchField, MenuViewport } from "../components/menu-navigation";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import type { MenuWindow } from "../components/menu-selection";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import { type Component, getKeybindings, matchesKey, routeSgrMouseInput, truncateToWidth } from "../index";
import { extractPrintableText } from "../keys";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import {
	isStatusLineSegmentId,
	parseUsageBarSegmentId,
	STATUS_LINE_SEGMENT_IDS,
	type BuiltinStatusLineSegmentId,
	type StatusLineSegmentId,
} from "../status-line/schema";
import {
	DEFAULT_LIVE_METER_TEMPLATE,
	DEFAULT_USAGE_BAR_TEMPLATE,
	LIVE_METER_TEMPLATE_TOKENS,
	limitUsageBarTemplate,
	USAGE_BAR_TEMPLATE_TOKENS,
	usageBarLabel,
} from "../status-line/segments";
import { getSelectListTheme, theme } from "../theme";
import { getComposerShapeOptions } from "./composer-shape-registry";

/** What applying the editor writes: the status-line widgets, their usage templates, and the composer. */
export interface StatusLineLayout {
	composerShape: string;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	/** Usage-bar templates that differ from the default, keyed by segment id. */
	usageTemplates: Record<string, string>;
}

/** One widget in the editor's stable list; disabled widgets keep their place. */
export interface StatusLineWidgetRow {
	id: StatusLineSegmentId;
	enabled: boolean;
}

export type StatusLineEditorFocus = "list" | "template" | "search";

/**
 * The editor's unapplied state, autosaved after every change and restored on
 * reopen. `base` is the active layout the draft was last reconciled with: a
 * draft that still equals its base holds no edits and follows later changes
 * to the active layout, while a draft with edits is kept until it is applied
 * or explicitly reset.
 */
export interface StatusLineEditorDraft {
	version: 1;
	base: StatusLineLayout;
	composerShape: string;
	left: StatusLineWidgetRow[];
	right: StatusLineWidgetRow[];
	usageTemplates: Record<string, string>;
	/** Selected row: `composer`, `reset`, or a widget id. */
	selected: string;
	/** First visible list line. */
	top: number;
	focus: StatusLineEditorFocus;
	query: string;
}

/** Persistence and live preview belong to the host, never to the overlay. */
export interface StatusLineConfigCallbacks {
	/** The layout currently in effect. */
	active: () => StatusLineLayout;
	/** Draft persisted by an earlier editor session, already validated. */
	draft?: StatusLineEditorDraft;
	/** Capture each snapshot synchronously; the host coalesces disk writes and preserves it on rejection. */
	saveDraft: (draft: StatusLineEditorDraft) => Promise<void>;
	/** Persist `layout` as the active configuration. */
	apply: (layout: StatusLineLayout) => Promise<void>;
	/** Show `layout` live; undefined restores the active configuration. */
	preview: (layout: StatusLineLayout | undefined) => void;
	close: () => void;
	requestRender: () => void;
	notify: (message: string) => void;
	usageReports?: readonly UsageReport[];
	renderPreview?: (shape: string, width: number) => readonly string[];
}

const COMPOSER_ROW = "composer";
const RESET_ROW = "reset";
const SEGMENT_DESCRIPTIONS: Record<BuiltinStatusLineSegmentId, string> = {
	get pi() {
		return t("overlays.status_line_config.desc_pi");
	},
	status: "Statuses supplied by extensions, ordered by their registered keys.",
	get model() {
		return t("overlays.status_line_config.desc_model");
	},
	get live() {
		return t("overlays.status_line_config.desc_live");
	},
	get live_meter() {
		return t("overlays.status_line_config.desc_live_meter");
	},
	get mode() {
		return t("overlays.status_line_config.desc_mode");
	},
	get path() {
		return t("overlays.status_line_config.desc_path");
	},
	get git() {
		return t("overlays.status_line_config.desc_git");
	},
	get pr() {
		return t("overlays.status_line_config.desc_pr");
	},
	get subagents() {
		return t("overlays.status_line_config.desc_subagents");
	},
	get token_in() {
		return t("overlays.status_line_config.desc_token_in");
	},
	get token_out() {
		return t("overlays.status_line_config.desc_token_out");
	},
	get token_total() {
		return t("overlays.status_line_config.desc_token_total");
	},
	get token_rate() {
		return t("overlays.status_line_config.desc_token_rate");
	},
	get cost() {
		return t("overlays.status_line_config.desc_cost");
	},
	get context_pct() {
		return t("overlays.status_line_config.desc_context_pct");
	},
	get context_total() {
		return t("overlays.status_line_config.desc_context_total");
	},
	get context_bar() {
		return t("overlays.status_line_config.desc_context_bar");
	},
	get time_spent() {
		return t("overlays.status_line_config.desc_time_spent");
	},
	get time() {
		return t("overlays.status_line_config.desc_time");
	},
	get session() {
		return t("overlays.status_line_config.desc_session");
	},
	get hostname() {
		return t("overlays.status_line_config.desc_hostname");
	},
	get cache_read() {
		return t("overlays.status_line_config.desc_cache_read");
	},
	get cache_write() {
		return t("overlays.status_line_config.desc_cache_write");
	},
	get cache_hit() {
		return t("overlays.status_line_config.desc_cache_hit");
	},
	get cache() {
		return t("overlays.status_line_config.desc_cache");
	},
	get session_name() {
		return t("overlays.status_line_config.desc_session_name");
	},
	get usage() {
		return t("overlays.status_line_config.desc_usage");
	},
	get collab() {
		return t("overlays.status_line_config.desc_collab");
	},
	get stream() {
		return t("overlays.status_line_config.desc_stream");
	},
	get vim() {
		return t("overlays.status_line_config.desc_vim");
	},
};

type Side = "left" | "right";
type ListLine =
	| { kind: "composer"; key: string }
	| { kind: "header"; side: Side }
	| { kind: "widget"; key: string; side: Side; row: StatusLineWidgetRow }
	| { kind: "blank" }
	| { kind: "reset"; key: string };

function segmentLabel(id: StatusLineSegmentId): string {
	if (id === "live_meter") return t("overlays.status_line_config.live_audio_meter");
	const bar = parseUsageBarSegmentId(id);
	if (bar) return usageBarLabel(bar);
	if (id === "pi") return t("overlays.status_line_config.brand");
	const words = id.replaceAll("_", " ");
	return words[0]!.toUpperCase() + words.slice(1);
}

function copyLayout(layout: StatusLineLayout): StatusLineLayout {
	return {
		composerShape: layout.composerShape,
		leftSegments: [...layout.leftSegments],
		rightSegments: [...layout.rightSegments],
		usageTemplates: { ...layout.usageTemplates },
	};
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameTemplates(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

export function sameStatusLineLayout(a: StatusLineLayout, b: StatusLineLayout): boolean {
	return (
		a.composerShape === b.composerShape &&
		sameIds(a.leftSegments, b.leftSegments) &&
		sameIds(a.rightSegments, b.rightSegments) &&
		sameTemplates(a.usageTemplates, b.usageTemplates)
	);
}

function defaultWidgetTemplate(id: string): string | undefined {
	return id === "live_meter"
		? DEFAULT_LIVE_METER_TEMPLATE
		: parseUsageBarSegmentId(id)
			? DEFAULT_USAGE_BAR_TEMPLATE
			: undefined;
}

/** Keep only templates that differ from the widget default. */
function normalizeTemplates(value: unknown): Record<string, string> {
	const templates: Record<string, string> = {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return templates;
	for (const [id, template] of Object.entries(value)) {
		const defaultTemplate = defaultWidgetTemplate(id);
		if (!defaultTemplate || typeof template !== "string") continue;
		const text = limitUsageBarTemplate(template);
		if (text.trim() && text !== defaultTemplate) templates[id] = text;
	}
	return templates;
}

function normalizeIds(value: unknown): StatusLineSegmentId[] {
	if (!Array.isArray(value)) return [];
	const ids = new Set<StatusLineSegmentId>();
	for (const id of value) if (typeof id === "string" && isStatusLineSegmentId(id)) ids.add(id);
	return [...ids];
}

function normalizeLayout(value: unknown): StatusLineLayout | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.composerShape !== "string" ||
		!Array.isArray(record.leftSegments) ||
		!Array.isArray(record.rightSegments)
	) {
		return undefined;
	}
	const leftSegments = normalizeIds(record.leftSegments);
	const left = new Set(leftSegments);
	return {
		composerShape: record.composerShape,
		leftSegments,
		rightSegments: normalizeIds(record.rightSegments).filter(id => !left.has(id)),
		usageTemplates: normalizeTemplates(record.usageTemplates),
	};
}

function normalizeRows(value: unknown, seen: Set<string>): StatusLineWidgetRow[] {
	if (!Array.isArray(value)) return [];
	const rows: StatusLineWidgetRow[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const { id, enabled } = entry as Record<string, unknown>;
		if (typeof id !== "string" || !isStatusLineSegmentId(id) || seen.has(id)) continue;
		seen.add(id);
		rows.push({ id, enabled: enabled === true });
	}
	return rows;
}

/**
 * Validate a persisted draft. Unknown widgets, duplicate rows and malformed
 * templates are dropped; anything without a usable layout is rejected, so a
 * damaged file never replaces the active layout.
 */
export function parseStatusLineEditorDraft(value: unknown): StatusLineEditorDraft | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.composerShape !== "string" ||
		!Array.isArray(record.left) ||
		!Array.isArray(record.right)
	) {
		return undefined;
	}
	const base = normalizeLayout(record.base);
	if (!base) return undefined;
	const seen = new Set<string>();
	const left = normalizeRows(record.left, seen);
	const right = normalizeRows(record.right, seen);
	const focus = record.focus === "template" || record.focus === "search" ? record.focus : "list";
	return {
		version: 1,
		base,
		composerShape: record.composerShape,
		left,
		right,
		usageTemplates: normalizeTemplates(record.usageTemplates),
		selected: typeof record.selected === "string" ? record.selected : COMPOSER_ROW,
		top: typeof record.top === "number" && Number.isInteger(record.top) && record.top > 0 ? record.top : 0,
		focus,
		query: typeof record.query === "string" ? sanitizeDisplaySingleLine(record.query) : "",
	};
}

/**
 * Rows for `active`, keeping the positions `hint` gave to widgets: enabled
 * widgets take the slots their side already holds in the active order, and
 * disabled widgets stay where they were.
 */
function rowsForLayout(
	active: StatusLineLayout,
	hint: { left: readonly StatusLineWidgetRow[]; right: readonly StatusLineWidgetRow[] } | undefined,
): { left: StatusLineWidgetRow[]; right: StatusLineWidgetRow[] } {
	const enabled = new Set<string>([...active.leftSegments, ...active.rightSegments]);
	const build = (want: readonly StatusLineSegmentId[], hinted: readonly StatusLineWidgetRow[]) => {
		const wanted = new Set<string>(want);
		const kept = hinted.map(row => row.id).filter(id => !enabled.has(id) || wanted.has(id));
		let next = 0;
		const ids = kept.map(id => (wanted.has(id) ? want[next++]! : id));
		for (; next < want.length; next++) ids.push(want[next]!);
		return ids.map(id => ({ id, enabled: wanted.has(id) }));
	};
	const left = build(active.leftSegments, hint?.left ?? []);
	const leftIds = new Set(left.map(row => row.id));
	const right = build(
		active.rightSegments,
		(hint?.right ?? []).filter(row => !leftIds.has(row.id)),
	);
	return { left, right };
}

export class StatusLineConfigOverlayComponent implements Component {
	readonly #cb: StatusLineConfigCallbacks;
	readonly #shapes = getComposerShapeOptions();
	readonly #listTheme = getSelectListTheme();
	#active: StatusLineLayout;
	#base: StatusLineLayout;
	#composerShape: string;
	#left: StatusLineWidgetRow[];
	#right: StatusLineWidgetRow[];
	#templates: Record<string, string>;
	#selected: string;
	readonly #viewport = new MenuViewport();
	#viewportRows: number[] = [];
	readonly #reader = new MenuKeyReader();
	#focus: StatusLineEditorFocus;
	readonly #search = new MenuSearchField();
	readonly #template = new Input();
	#prompt: "exit" | "reset" | undefined;
	/** Latest editor message; host statuses render behind the fullscreen editor, so the footer repeats it until the next key. */
	#notice: { text: string; warning: boolean } | undefined;
	#applying = false;
	#closed = false;
	#leavePending = false;
	#draftWriteRevision = 0;
	#draftError: string | undefined;
	#bodyRows = Math.max(3, (process.stdout.rows || 40) - 4);
	#listRows = this.#bodyRows;
	readonly #titleRow = new PanelRows();
	readonly #divider = new PanelRows();
	readonly #footer = new PanelRows();
	readonly #help = new MenuHelp(undefined, () => t("overlays.status_line_config.move_help"));
	readonly #bottom = new PanelRows();
	readonly #split = new SplitPane({
		left: (width, height) => this.#renderList(width, height ?? this.#bodyRows),
		right: (width, height) => this.#details(width).slice(0, height ?? this.#bodyRows),
		leftSize: { ratio: 0.5, min: 26, max: 72 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #frame = new Stack({
		children: [
			{ content: this.#titleRow, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#divider, height: 1 },
			{ content: this.#footer },
			{ content: this.#bottom, height: 1 },
		],
	});

	constructor(callbacks: StatusLineConfigCallbacks) {
		this.#cb = callbacks;
		const active = callbacks.active();
		this.#active = normalizeLayout(active) ?? copyLayout(active);
		const draft = callbacks.draft;
		const holdsEdits =
			draft !== undefined &&
			!sameStatusLineLayout(this.#layoutOf(draft), draft.base) &&
			!sameStatusLineLayout(this.#layoutOf(draft), this.#active);
		if (draft && holdsEdits) {
			this.#base = copyLayout(draft.base);
			this.#composerShape = draft.composerShape;
			this.#left = draft.left.map(row => ({ ...row }));
			this.#right = draft.right.map(row => ({ ...row }));
			this.#templates = { ...draft.usageTemplates };
		} else {
			// No edits to keep: follow the active layout, reusing the draft's row positions.
			this.#base = copyLayout(this.#active);
			this.#composerShape = this.#active.composerShape;
			({ left: this.#left, right: this.#right } = rowsForLayout(this.#active, draft));
			this.#templates = { ...this.#active.usageTemplates };
		}
		this.#addCatalogRows();
		this.#selected = draft?.selected ?? COMPOSER_ROW;
		this.#viewport.setTop(draft?.top ?? 0);
		this.#focus = draft?.focus ?? "list";
		this.#search.setValue(draft?.query ?? "");
		this.#template.prompt = "";
		if (!this.#keys().includes(this.#selected)) this.#selected = COMPOSER_ROW;
		if (this.#focus === "template" && !defaultWidgetTemplate(this.#selected)) this.#focus = "list";
		this.#syncTemplateField();
		this.#syncFocusFlags();
		if (draft && holdsEdits && this.#pending) {
			this.#notify(t("overlays.status_line_config.draft_restored"));
		}
		this.#cb.preview(this.#layout());
	}

	/** Widgets the catalog or cached usage reports offer that no row holds yet join the end, disabled. */
	#addCatalogRows(): void {
		const known = new Set<string>([...this.#left, ...this.#right].map(row => row.id));
		const add = (id: StatusLineSegmentId) => {
			if (known.has(id)) return;
			known.add(id);
			this.#right.push({ id, enabled: false });
		};
		for (const id of STATUS_LINE_SEGMENT_IDS) add(id);
		for (const id of Object.keys(this.#templates)) if (isStatusLineSegmentId(id)) add(id);
		for (const report of this.#cb.usageReports ?? []) {
			for (const limit of report.limits) {
				const { windowId, tier } = limit.scope;
				if (!windowId) continue;
				const normalizedTier = tier?.trim().toLowerCase();
				const id = `usage:${report.provider}:${windowId}${normalizedTier ? `:${normalizedTier}` : ""}`;
				if (isStatusLineSegmentId(id)) add(id);
			}
		}
	}

	#layoutOf(draft: StatusLineEditorDraft): StatusLineLayout {
		return {
			composerShape: draft.composerShape,
			leftSegments: draft.left.filter(row => row.enabled).map(row => row.id),
			rightSegments: draft.right.filter(row => row.enabled).map(row => row.id),
			usageTemplates: { ...draft.usageTemplates },
		};
	}

	#layout(): StatusLineLayout {
		return {
			composerShape: this.#composerShape,
			leftSegments: this.#left.filter(row => row.enabled).map(row => row.id),
			rightSegments: this.#right.filter(row => row.enabled).map(row => row.id),
			usageTemplates: { ...this.#templates },
		};
	}

	#draft(): StatusLineEditorDraft {
		return {
			version: 1,
			base: copyLayout(this.#base),
			composerShape: this.#composerShape,
			left: this.#left.map(row => ({ ...row })),
			right: this.#right.map(row => ({ ...row })),
			usageTemplates: { ...this.#templates },
			selected: this.#selected,
			top: this.#viewport.top?.item ?? 0,
			focus: this.#focus,
			query: this.#search.query,
		};
	}

	/** True while the draft differs from the layout in effect. */
	get #pending(): boolean {
		return !sameStatusLineLayout(this.#layout(), this.#active);
	}

	// ── Draft persistence ─────────────────────────────────────────────────

	/** Capture every change synchronously; the host coalesces disk writes across editor instances. */
	#persist(): void {
		const revision = ++this.#draftWriteRevision;
		let writing: Promise<void>;
		try {
			writing = this.#cb.saveDraft(this.#draft());
		} catch (error) {
			this.#draftFailed(error);
			this.#cb.requestRender();
			return;
		}
		void writing
			.then(
				() => {
					if (revision === this.#draftWriteRevision) this.#draftError = undefined;
				},
				(error: unknown) => this.#draftFailed(error),
			)
			.finally(() => this.#cb.requestRender());
	}

	#draftFailed(error: unknown): void {
		const message = sanitizeStatusText(String(error));
		if (this.#draftError === undefined) {
			this.#notify(t("overlays.status_line_config.draft_save_failed", { message: `${message}` }), true);
		}
		this.#draftError = message;
	}

	/** A layout edit: preview it live and autosave the draft. */
	#edited(): void {
		this.#cb.preview(this.#layout());
		this.#persist();
		this.#cb.requestRender();
	}

	/** An editor-state change (selection, viewport, focus, query): autosave only. */
	#moved(): void {
		this.#persist();
		this.#cb.requestRender();
	}

	// ── List model ────────────────────────────────────────────────────────

	#matches(row: StatusLineWidgetRow): boolean {
		const regex = compileMenuRegex(this.#search.query);
		if (regex) return !!regex.regex && [row.id, segmentLabel(row.id)].some(text => regex.regex!.test(text));
		const query = this.#search.query.trim().toLowerCase();
		if (!query) return true;
		return row.id.toLowerCase().includes(query) || segmentLabel(row.id).toLowerCase().includes(query);
	}

	#lines(): ListLine[] {
		const lines: ListLine[] = [{ kind: "composer", key: COMPOSER_ROW }];
		for (const [side, rows] of [
			["left", this.#left],
			["right", this.#right],
		] as const) {
			lines.push({ kind: "header", side });
			for (const row of rows) if (this.#matches(row)) lines.push({ kind: "widget", key: row.id, side, row });
		}
		lines.push({ kind: "blank" }, { kind: "reset", key: RESET_ROW });
		return lines;
	}

	#keys(): string[] {
		const keys: string[] = [];
		for (const line of this.#lines()) if ("key" in line) keys.push(line.key);
		return keys;
	}

	#lineIndex(key: string, lines = this.#lines()): number {
		return lines.findIndex(line => "key" in line && line.key === key);
	}

	/** Physical one-line rows include headers and blanks; selection skips them separately. */
	#window(lines = this.#lines()): MenuWindow {
		if (this.#viewportRows.length !== lines.length) this.#viewportRows = lines.map(() => 1);
		return this.#viewport.layout(
			this.#viewportRows,
			Math.max(0, this.#lineIndex(this.#selected, lines)),
			Math.max(1, this.#listRows),
		);
	}

	#select(key: string): void {
		this.#selected = key;
		if (this.#focus === "template" && !parseUsageBarSegmentId(key)) this.#focus = "list";
		this.#syncFocusFlags();
		this.#syncTemplateField();
		this.#viewport.reveal();
		this.#window();
		this.#moved();
	}

	/** Move the selection by `delta` selectable rows, clamped at either end. */
	#moveSelection(delta: number): void {
		const keys = this.#keys();
		const index = Math.max(0, keys.indexOf(this.#selected));
		const next = keys[Math.max(0, Math.min(keys.length - 1, index + delta))];
		if (next !== undefined) this.#select(next);
	}

	#boundary(which: "first" | "last"): void {
		const keys = this.#keys();
		const key = which === "first" ? keys[0] : keys.at(-1);
		if (key !== undefined) this.#select(key);
	}

	/** Scroll the view by `delta` lines; the selection stays where it is. */
	#scroll(delta: number): void {
		this.#window();
		this.#viewport.scroll(delta);
		this.#window();
		this.#moved();
	}

	#sideOf(id: string): { side: Side; rows: StatusLineWidgetRow[]; index: number } | undefined {
		for (const [side, rows] of [
			["left", this.#left],
			["right", this.#right],
		] as const) {
			const index = rows.findIndex(row => row.id === id);
			if (index >= 0) return { side, rows, index };
		}
		return undefined;
	}

	// ── Edits ─────────────────────────────────────────────────────────────

	#toggle(): void {
		const key = this.#selected;
		if (key === COMPOSER_ROW) this.#cycleComposer(1);
		else if (key === RESET_ROW) this.#requestReset();
		else {
			const found = this.#sideOf(key);
			if (!found) return;
			found.rows[found.index]!.enabled = !found.rows[found.index]!.enabled;
			this.#edited();
		}
	}

	/** Move the selected widget one place earlier or later in the status line, across the side boundary at either end. */
	#reorder(direction: -1 | 1): void {
		const found = this.#sideOf(this.#selected);
		if (!found) return;
		const { side, rows, index } = found;
		const next = index + direction;
		if (next >= 0 && next < rows.length) {
			[rows[index], rows[next]] = [rows[next]!, rows[index]!];
		} else if (side === "left" && direction === 1) this.#right.unshift(...rows.splice(index, 1));
		else if (side === "right" && direction === -1) this.#left.push(...rows.splice(index, 1));
		else return;
		this.#viewport.reveal();
		this.#window();
		this.#edited();
	}

	/** Cycle the composer shape; the widget selection and viewport stay put. */
	#cycleComposer(direction: -1 | 1): void {
		const count = this.#shapes.length;
		if (count === 0) return;
		const index = this.#shapes.findIndex(shape => shape.value === this.#composerShape);
		const next = index < 0 ? (direction === 1 ? 0 : count - 1) : (index + direction + count) % count;
		this.#composerShape = this.#shapes[next]!.value;
		this.#edited();
	}

	#setTemplate(id: string, value: string): void {
		const text = limitUsageBarTemplate(value);
		if (!text.trim() || text === defaultWidgetTemplate(id)) delete this.#templates[id];
		else this.#templates[id] = text;
		this.#edited();
	}

	#syncTemplateField(): void {
		if (!defaultWidgetTemplate(this.#selected)) return;
		const value = this.#templates[this.#selected] ?? defaultWidgetTemplate(this.#selected) ?? "";
		if (this.#template.getValue() !== value) this.#template.setValue(value);
	}

	#syncFocusFlags(): void {
		this.#template.focused = this.#focus === "template";
		this.#search.focused = this.#focus === "search";
	}

	#setFocus(focus: StatusLineEditorFocus): void {
		if (this.#focus === "template" && focus !== "template") this.#syncTemplateField();
		this.#focus = focus;
		this.#syncFocusFlags();
		this.#reader.reset();
		this.#moved();
	}

	#requestReset(): void {
		if (!this.#pending) {
			this.#notify(t("overlays.status_line_config.draft_matches"));
			return;
		}
		this.#prompt = "reset";
		this.#cb.requestRender();
	}

	/** Discard the draft's edits: the only path that drops them. Rows keep their positions. */
	#reset(): void {
		this.#base = copyLayout(this.#active);
		this.#composerShape = this.#active.composerShape;
		({ left: this.#left, right: this.#right } = rowsForLayout(this.#active, {
			left: this.#left,
			right: this.#right,
		}));
		this.#templates = { ...this.#active.usageTemplates };
		this.#addCatalogRows();
		this.#syncTemplateField();
		this.#notify(t("overlays.status_line_config.draft_reset"));
		this.#edited();
	}

	/** Apply the draft; the editor stays open unless `thenClose`. A failure keeps both the draft and the old layout. */
	async #apply(thenClose: boolean): Promise<void> {
		if (!thenClose && !this.#pending) {
			this.#notify(t("overlays.status_line_config.no_changes"));
			return;
		}
		const layout = this.#layout();
		this.#applying = true;
		this.#cb.requestRender();
		try {
			await this.#cb.apply(copyLayout(layout));
			this.#active = copyLayout(layout);
			this.#base = copyLayout(layout);
			this.#notify(t("overlays.status_line_config.layout_applied"));
			// A history reopen may already own a newer draft; never replace it on late completion.
			if (!this.#closed) {
				this.#persist();
				if (thenClose) this.#close();
			}
		} catch (error) {
			this.#notify(
				t("overlays.status_line_config.apply_failed", { error: `${sanitizeStatusText(String(error))}` }),
				true,
			);
		} finally {
			this.#applying = false;
			if (this.#leavePending) {
				this.#leavePending = false;
				this.#cb.preview(undefined);
			}
			this.#cb.requestRender();
		}
	}

	#requestClose(): void {
		if (this.#pending) {
			this.#prompt = "exit";
			this.#cb.requestRender();
		} else this.#close();
	}

	/** Leave without applying: the live view returns to the active layout and the draft stays saved. */
	#close(): void {
		this.#closed = true;
		this.#prompt = undefined;
		this.#persist();
		this.#cb.preview(undefined);
		if (this.#pending) this.#cb.notify(t("overlays.status_line_config.draft_kept"));
		this.#cb.close();
	}

	/**
	 * Menu history is leaving this editor (Ctrl-O): no apply prompt. The draft
	 * is saved immediately. An in-flight apply restores the live view after it
	 * settles, so the host can advance the active snapshot before restoration.
	 */
	leaveMenu(): void {
		if (this.#closed) return;
		this.#search.focused = false;
		this.#closed = true;
		this.#prompt = undefined;
		this.#persist();
		if (this.#applying) this.#leavePending = true;
		else this.#cb.preview(undefined);
	}

	// ── Input ─────────────────────────────────────────────────────────────

	#notify(text: string, warning = false): void {
		this.#notice = { text: sanitizeStatusText(text), warning };
		this.#cb.notify(text);
		this.#cb.requestRender();
	}

	handleInput(data: string): void {
		if (this.#closed || this.#applying) return;
		this.#notice = undefined;
		if (data.startsWith("\x1b[<")) {
			this.#reader.reset();
			this.#handleMouse(data);
			return;
		}
		if (this.#prompt) {
			this.#reader.reset();
			this.#handlePrompt(data, extractPrintableText(data));
			return;
		}
		if (this.#focus === "template") {
			this.#reader.reset();
			this.#handleTemplateInput(data);
			return;
		}
		if (this.#focus === "search") {
			this.#reader.reset();
			this.#handleSearchInput(data);
			return;
		}
		if (this.#help.handleInput(data)) {
			this.#cb.requestRender();
			return;
		}
		const action = this.#reader.read(data);
		if (action === "pending") return;
		switch (action?.kind) {
			case "cancel":
				if (this.#search.value) {
					this.#search.setValue("");
					this.#moved();
					return;
				}
				this.#requestClose();
				return;
			case "move":
				this.#moveSelection(action.delta);
				return;
			case "horizontal":
				this.#reorder(action.delta);
				return;
			case "halfPage":
				this.#moveSelection(action.delta * Math.max(1, Math.floor(this.#listRows / 2)));
				return;
			case "page":
				this.#moveSelection(action.delta * Math.max(1, this.#listRows));
				return;
			case "boundary":
				this.#boundary(action.edge);
				return;
			case "scroll":
				this.#scroll(action.delta);
				return;
			case "toggle":
			case "confirm":
				this.#toggle();
				return;
			case "context":
				if (defaultWidgetTemplate(this.#selected)) {
					this.#syncTemplateField();
					this.#setFocus("template");
				} else this.#notify(t("overlays.status_line_config.template_edit_help"));
				return;
			case "search":
				this.#setFocus("search");
				return;
		}
		const char = extractPrintableText(data);
		if (char === "[" || matchesKey(data, "alt+up")) this.#reorder(-1);
		else if (char === "]" || matchesKey(data, "alt+down")) this.#reorder(1);
		else if (char === "<") this.#cycleComposer(-1);
		else if (char === ">") this.#cycleComposer(1);
		else if (char === "s" || matchesKey(data, "ctrl+s")) void this.#apply(false);
		else if (char === "R") this.#requestReset();
	}

	#handlePrompt(data: string, char: string | undefined): void {
		const prompt = this.#prompt;
		const yes =
			char === "y" || char === "Y" || (prompt === "exit" && getKeybindings().matches(data, "tui.select.confirm"));
		const no = char === "n" || char === "N";
		if (prompt === "exit") {
			if (yes) {
				this.#prompt = undefined;
				void this.#apply(true);
			} else if (no) this.#close();
			else if (getKeybindings().matches(data, "tui.select.cancel") || char === "c") {
				this.#prompt = undefined;
				this.#cb.requestRender();
			}
			return;
		}
		if (yes) {
			this.#prompt = undefined;
			this.#reset();
		} else if (no || getKeybindings().matches(data, "tui.select.cancel")) {
			this.#prompt = undefined;
			this.#cb.requestRender();
		}
	}

	#handleTemplateInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab")
		) {
			this.#setFocus("list");
			return;
		}
		const before = this.#template.getValue();
		const printable = extractPrintableText(data);
		if (printable !== undefined) this.#template.insertText(printable);
		else if (!this.#template.handleInput(data)) return;
		const value = limitUsageBarTemplate(this.#template.getValue());
		if (this.#template.getValue() !== value) this.#template.setValue(value);
		if (value !== before) this.#setTemplate(this.#selected, value);
		else this.#cb.requestRender();
	}

	#handleSearchInput(data: string): void {
		const before = this.#search.query;
		const result = this.#search.handleInput(data);
		if (result === "pass") return;
		const draft = sanitizeDisplaySingleLine(this.#search.value);
		if (draft !== this.#search.value) this.#search.input.setValue(draft);
		if (result === "exited") {
			this.#search.setValue(draft);
			this.#setFocus("list");
		}
		if (this.#search.query === before) {
			this.#cb.requestRender();
			return;
		}
		// A changed filter always lands on its first widget match, never Composer/Reset.
		const first = this.#lines().find(line => line.kind === "widget");
		this.#selected = first && "key" in first ? first.key : COMPOSER_ROW;
		this.#syncTemplateField();
		this.#viewport.setTop(0);
		this.#viewport.reveal();
		this.#window();
		this.#moved();
	}

	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			const hit = this.#frame.locate(event.row, event.col);
			const pane = hit?.index === 1 ? this.#split.locate(hit.line, hit.col) : undefined;
			if (pane?.pane !== "left") return false;
			if (event.wheel !== null) {
				this.#scroll(event.wheel);
				return true;
			}
			if (!event.leftClick || this.#prompt) return true;
			const line = this.#lines()[(this.#viewport.top?.item ?? 0) + pane.line];
			if (!line || !("key" in line)) return true;
			if (this.#focus !== "list") this.#setFocus("list");
			if (line.key === this.#selected) this.#toggle();
			else this.#select(line.key);
			return true;
		});
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	#renderLine(line: ListLine, width: number): string {
		const cursor = this.#listTheme.symbols?.cursor ?? "›";
		const selected = "key" in line && line.key === this.#selected;
		const prefix = selected ? `${cursor} ` : "  ";
		const style = (text: string, dim = false) =>
			selected
				? this.#listTheme.selectedText(truncateToWidth(`${prefix}${text}`, width))
				: truncateToWidth(`${prefix}${dim ? theme.fg("dim", text) : text}`, width);
		switch (line.kind) {
			case "composer": {
				const shape = this.#shapes.find(option => option.value === this.#composerShape);
				return style(
					t("overlays.status_line_config.composer_cycle", {
						label: `${sanitizeStatusText(shape?.label ?? this.#composerShape)}`,
					}),
				);
			}
			case "header":
				return truncateToWidth(
					theme.fg(
						"accent",
						line.side === "left"
							? t("overlays.status_line_config.left_side")
							: t("overlays.status_line_config.right_side"),
					),
					width,
				);
			case "widget": {
				const { id, enabled } = line.row;
				const templated = this.#templates[id] !== undefined ? " ✎" : "";
				return style(
					`[${enabled ? "x" : " "}] ${segmentLabel(id)}${uiProvenanceSuffix("statusSegments", parseUsageBarSegmentId(id) ? "usage" : id, true)} · ${sanitizeStatusText(id)}${templated}`,
					!enabled,
				);
			}
			case "blank":
				return "";
			case "reset":
				return style(t("overlays.status_line_config.reset_active"), !this.#pending);
		}
	}

	#renderList(width: number, height: number): string[] {
		this.#listRows = Math.max(1, height);
		const lines = this.#lines();
		const view = this.#window(lines);
		return lines.slice(view.startIndex, view.endIndex).map(line => this.#renderLine(line, width));
	}

	#details(width: number): string[] {
		const id = this.#selected;
		const wrap = (text: string) => Bun.wrapAnsi(text, Math.max(1, width)).split("\n");
		const lines: string[] = [];
		if (id === COMPOSER_ROW) {
			const shape = this.#shapes.find(option => option.value === this.#composerShape);
			lines.push(
				...wrap(sanitizeStatusText(shape?.description ?? t("overlays.status_line_config.composer_shape_help"))),
			);
		} else if (id === RESET_ROW) {
			lines.push(
				...wrap(
					this.#pending
						? t("overlays.status_line_config.reset_description")
						: t("overlays.status_line_config.nothing_to_reset"),
				),
			);
		} else if (defaultWidgetTemplate(id)) {
			const meter = id === "live_meter";
			const tokens = meter ? LIVE_METER_TEMPLATE_TOKENS : USAGE_BAR_TEMPLATE_TOKENS;
			lines.push(
				...wrap(
					meter
						? t("overlays.status_line_config.meter_description")
						: t("overlays.status_line_config.quota_description"),
				),
				"",
				theme.fg(this.#focus === "template" ? "accent" : "muted", t("overlays.status_line_config.template")),
				...this.#template.render(Math.max(1, width)),
				...wrap(
					theme.fg(
						"dim",
						t("overlays.status_line_config.template_tokens", {
							join: `${tokens.map(token => `{${token}}`).join(" ")}`,
							defaultWidgetTemplate: `${defaultWidgetTemplate(id)}`,
						}),
					),
				),
			);
		} else {
			lines.push(
				...wrap(
					sanitizeStatusText(
						SEGMENT_DESCRIPTIONS[id as BuiltinStatusLineSegmentId] ??
							t("overlays.status_line_config.widget_description"),
					),
				),
			);
		}
		if (this.#focus === "search" || this.#search.value) {
			lines.push(
				"",
				theme.fg(this.#focus === "search" ? "accent" : "muted", t("overlays.status_line_config.search")),
			);
			lines.push(this.#search.render(Math.max(1, width), { muted: text => theme.fg("muted", text) }));
		}
		lines.push(
			"",
			theme.fg("accent", t("overlays.status_line_config.live_preview")),
			"",
			...(this.#cb.renderPreview?.(this.#composerShape, width) ?? []),
		);
		return lines.map(line => truncateToWidth(line, width));
	}

	#hints(): string {
		if (this.#applying) return t("settings.selector.applying");
		if (this.#prompt === "exit") return t("overlays.status_line_config.prompt_hints");
		if (this.#prompt === "reset") return t("overlays.status_line_config.reset_hints");
		if (this.#focus === "template") return t("overlays.status_line_config.template_hints");
		if (this.#focus === "search") return t("overlays.status_line_config.search_hints");
		const query = sanitizeStatusText(this.#search.value);
		const listHints = t("overlays.status_line_config.list_hints");
		return query ? t("overlays.status_line_config.filter_hint", { query, listHints }) : listHints;
	}

	render(width: number): readonly string[] {
		this.#bodyRows = Math.max(3, (process.stdout.rows || 40) - 4);
		this.#split.setHeight(this.#bodyRows);
		const leftWidth = this.#split.measure(width).left?.width ?? 0;
		const state = `${this.#pending ? t("overlays.status_line_config.unapplied_draft") : ""}${this.#draftError ? t("overlays.status_line_config.draft_not_saved") : ""}`;
		this.#titleRow.setLines([
			topBorderSplit(width, t("overlays.status_line_config.title", { state: `${state}` }), leftWidth),
		]);
		this.#divider.setLines([dividerSplit(width, leftWidth)]);
		const notice = this.#prompt || this.#applying ? undefined : this.#notice;
		const footer = notice
			? theme.fg(notice.warning ? "warning" : "accent", notice.text)
			: this.#prompt
				? theme.fg("warning", this.#hints())
				: theme.fg("dim", this.#hints());
		const footerLines = menuHintLines(
			footer,
			Math.max(1, width - 4),
			this.#focus === "list" && !this.#prompt ? undefined : "",
		);
		this.#footer.setLines(footerLines.map(line => row(line, width)));
		this.#bodyRows = Math.max(3, (process.stdout.rows || 40) - 3 - footerLines.length);
		this.#split.setHeight(this.#bodyRows);
		this.#bottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(this.#bodyRows + 3 + footerLines.length);
		return this.#help.render(this.#frame.render(width), width);
	}
}
