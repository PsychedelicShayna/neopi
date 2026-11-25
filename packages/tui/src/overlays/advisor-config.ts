/**
 * Fullscreen `/advisor configure` overlay: a mouse- and keyboard-driven editor
 * for an exact user, project-root, project-.omp, or session `WATCHDOG.yml` roster.
 *
 * It paints the entire alternate screen from row 0 (so SGR mouse rows index
 * directly into the rendered frame) using the shared {@link ./overlay-box} chrome.
 * The list screen is a two-pane split (the `/extensions` idiom): a clickable
 * advisor/action sidebar on the left, and a scrollable preview of the highlighted
 * advisor's model / tools / instructions on the right, filling the free space.
 *
 * Each screen is backed by a proven primitive — {@link SelectList} (list / detail
 * / tools / thinking), {@link Input} (name), {@link ModelSelectorComponent} (the
 * same rich `/model` picker, in direct-select mode), and {@link HookEditorComponent}
 * (multiline instructions; Ctrl+G opens `$EDITOR`). The overlay edits an in-memory
 * {@link WatchdogConfigDoc} and only touches disk + the live advisors via the host
 * `save` callback.
 */
import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Model, resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type Component,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "../index";
import { getSelectListTheme, theme } from "../theme";
import { sanitizeDisplayWarnings, shortenPath } from "../render/render-utils";
import { sanitizeDisplayLine } from "./extensions/display-text";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys, interruptKey } from "../chrome/keybinding-hints";
import { matchesAppInterrupt } from "../keybinding-matchers";
import { HookEditorComponent } from "./hook-editor";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserSource,
	type ModelPickerCatalogue,
	type ModelPickerOrder,
	sortModelItems,
} from "./model-browser";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import type { TspPrefsProps, TspPrefsRow, TspSpan } from "@oh-my-pi/pi-wire";
import { col, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, actionHint, hintsRow, type NativeHint, overlayCard } from "../native/overlay";
import {
	CLOSE_ACTION,
	pickerAction,
	pickerEvent,
	routeSelectListPicker,
	type SelectPickerOptions,
	selectListPicker,
} from "../native/picker";
import { getThinkingLevelMetadata, parseThinkingLevel } from "../thinking";
import { isMenuHistoryParticipant, MenuKeyReader, type MenuNavAction } from "../components/menu-navigation";
import type { SelectListNavigationState } from "../components/select-list";
import { extractPrintableText } from "../keys";

export const ADVISOR_REVIEW_MODES = ["turn", "agent-end"] as const;
export const ADVISOR_SYNC_BACKLOG_MODES = ["off", "1", "3", "5", "strict"] as const;
export const ADVISOR_SESSION_SCOPES = ["main", "subagent", "all"] as const;

export type AdvisorReviewMode = (typeof ADVISOR_REVIEW_MODES)[number];
export type AdvisorSyncBacklog = (typeof ADVISOR_SYNC_BACKLOG_MODES)[number];
export type AdvisorSessionScope = (typeof ADVISOR_SESSION_SCOPES)[number];
/** One advisor declared in `WATCHDOG.yml`; its instructions specialize the shared baseline. */
export interface AdvisorConfig {
	/** Hidden persistent identity. Legacy rows receive one on their first save. */
	id?: string;
	/** Discovery metadata, never serialized as part of an advisor entry. */
	sourceScope?: AdvisorConfigScope;
	name: string;
	/** Model selector with an optional `:level` thinking suffix, resolved like any other model override. */
	model?: string;
	/** Built-in tool names, including mutating tools; omitted uses read/grep/glob plus available recall, empty grants none. */
	tools?: string[];
	instructions?: string;
	/** Replaces the bundled base prompt; specialization instructions still append. */
	systemPrompt?: string;
	/** Defaults to true; false retains the advisor in the roster and status displays without building its runtime. */
	enabled?: boolean;
	/** Include the primary assistant's reasoning in this advisor's updates; defaults to true. */
	includeThinking?: boolean;
	/** Maximum non-blocker notes per advisor prompt update (default 4); blockers are exempt. */
	maxNotesPerUpdate?: number;
	reviewMode?: AdvisorReviewMode;
	reviewInterval?: number;
	syncBacklog?: AdvisorSyncBacklog;
	/** Which session kinds this advisor attaches to (`main`, `subagent`, or `all`; defaults to `all`). */
	scope?: AdvisorSessionScope;
}

/** The exact storage layer of an advisor roster. */
export type AdvisorConfigScope = "project" | "project-omp" | "user" | "session";

/** Editable raw contents of one `WATCHDOG.yml`, without cross-level merging or `@import` expansion, for exact round trips. */
export interface WatchdogConfigDoc {
	/** False disables the entire file without changing its advisor entries. */
	enabled?: boolean;
	instructions?: string;
	maxNotesPerUpdate?: number;
	advisors: AdvisorConfig[];
	/** Per-entry problems found while loading (dropped entries). Shown when the file becomes active in the editor. */
	warnings?: string[];
}

/** Read-only effective roster: edits still belong to individual raw files. */
export interface EffectiveAdvisorConfig {
	name: string;
	enabled?: boolean;
	sourceFile: string;
	scope: AdvisorConfigScope;
}

export interface AdvisorConfigStat {
	name: string;
	sessionId?: string;
	status: string;
	model?: { provider: string };
	tokens: { input: number; output: number; cacheRead: number };
	cost: number;
	contextWindow: number;
	contextTokens: number;
}

/** Host callbacks: all disk + live-runtime effects flow through these. */
export interface AdvisorConfigCallbacks {
	/** Load a scope's `WATCHDOG.yml` into an editable doc (empty when absent). */
	loadDoc: (scope: AdvisorConfigScope) => Promise<WatchdogConfigDoc>;
	/** Open the selected scope's backing file externally and resolve when editing finishes. */
	openConfigFile?: (scope: AdvisorConfigScope) => Promise<void>;
	/** Persist the doc to the scope's file. Must not touch the live advisors. */
	save: (scope: AdvisorConfigScope, doc: WatchdogConfigDoc) => Promise<void>;
	/** Reload the effective roster after saving a source file. */
	getEffectiveRoster?: () => Promise<readonly EffectiveAdvisorConfig[]>;
	/** Apply the saved configuration to the live advisors (only changed ones restart). */
	apply: () => Promise<void>;
	/** Tear down the overlay and restore the editor. */
	close: () => void;
	requestRender: () => void;
	/** Surface a transient status/warning line to the user. */
	notify: (message: string) => void;
	/**
	 * Surface a sticky warning (e.g. malformed entries in the file just made
	 * active by a scope switch). Falls back to `notify` when omitted.
	 */
	warn?: (message: string) => void;
	/** Live advisor usage stats; lets the preview show tokens/cost per advisor. */
	getAdvisorStats?: () => AdvisorConfigStat[];
	/** Reports normalized by the host to collapse shared credential pools. */
	getUsageReports?: () => Promise<UsageReport[] | null>;
	/** Filter to the advisor's active credential; absent identity includes every limit. */
	getQuotaLimitFilter?: (
		provider: string,
		sessionId: string | undefined,
	) => ((report: UsageReport, limit: UsageLimit) => boolean) | undefined;
	/** Copy the complete configured prompt using the host clipboard helper. */
	copyPrompt?: (prompt: string) => void | Promise<void>;
	/** Persist an independent copy into another exact source file. */
	copyAdvisor?: (advisor: AdvisorConfig, targetPath: string) => Promise<void>;
	/** Sources available to copy and generation pickers, including absent scope files. */
	getSources?: () => Promise<readonly { path: string; scope: AdvisorConfigScope; doc: WatchdogConfigDoc }[]>;
	generateAdvisor?: (bases: readonly AdvisorConfig[], comment: string, signal: AbortSignal) => Promise<AdvisorConfig>;
	/** Open the active role's activation set without discarding this file's draft. */
	editActivationSet?: () => Promise<void>;
}

export interface AdvisorConfigDeps {
	getDefaultSystemPrompt: (advisor: AdvisorConfig, doc: WatchdogConfigDoc) => string;
	getAvailableModels: () => Model[];
	browserSource: ModelBrowserSource;
	defaultToolNames: ReadonlySet<string>;
	externalEditor?: (text: string) => Promise<string | null>;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	availableToolNames: string[];
	syncBacklog?: AdvisorSyncBacklog;
	/** Formatted advisor-role model shown on the seeded default row (e.g. "anthropic/claude-..."). */
	defaultModelLabel?: string;
	effectiveRoster?: readonly EffectiveAdvisorConfig[];
	/** Exact file selected by the scope-first parent; saves stay bound to this source. */
	filePath?: string;
	/** Resolved files edited by each scope, including WATCHDOG.yaml when present. */
	configFiles?: Partial<Record<AdvisorConfigScope, string>>;
	getActivationNote?: (advisor: AdvisorConfig) => string | undefined;
}

/**
 * Normalize an advisor name into a filesystem-/id-safe slug used for its
 * transcript filename and session id: lowercase, non-alphanumerics collapsed to
 * `-`, leading/trailing `-` trimmed. Falls back to `"advisor"` when nothing
 * survives; callers dedupe collisions.
 */
export function slugifyAdvisorName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "advisor";
}

/** Independent copy: never retain discovery metadata or the source's persistent ID. */
export function cloneAdvisorConfig(advisor: AdvisorConfig, existing: readonly AdvisorConfig[]): AdvisorConfig {
	const copy = structuredClone(advisor);
	copy.id = crypto.randomUUID();
	delete copy.sourceScope;
	const base = `${copy.name} (copy)`;
	const slugs = new Set(existing.map(entry => slugifyAdvisorName(entry.name)));
	copy.name = base;
	for (let suffix = 2; slugs.has(slugifyAdvisorName(copy.name)); suffix++) copy.name = `${base} ${suffix}`;
	return copy;
}

const PREVIEW_WIDTH = 60;

/**
 * One-line provider quota display. The host supplies normalized usage reports
 * and an optional credential filter; the overlay owns only presentation.
 */
export function formatCompactQuota(
	provider: string,
	reports: UsageReport[],
	nowMs: number,
	includeLimit?: (report: UsageReport, limit: UsageLimit) => boolean,
): string | null {
	const byWindow = new Map<string, { limit: UsageLimit; fraction: number }>();
	for (const report of reports) {
		if (report.provider !== provider) continue;
		for (const limit of report.limits) {
			if (includeLimit && !includeLimit(report, limit)) continue;
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const key = limit.window?.id ?? limit.scope.windowId ?? "—";
			const existing = byWindow.get(key);
			if (!existing || fraction > existing.fraction) byWindow.set(key, { limit, fraction });
		}
	}
	if (byWindow.size === 0) return null;
	const entries = [...byWindow.values()].sort((a, b) => b.fraction - a.fraction);
	const lines: string[] = [];
	for (const { limit, fraction } of entries) {
		const pct = Math.round(fraction * 100);
		const windowLabel = limit.window?.label ?? limit.scope.windowId ?? "—";
		const identity = limit.label.trim();
		const header = identity && identity !== windowLabel ? `${windowLabel} (${identity})` : windowLabel;
		const parts = [t("overlaysModel.advisorConfig.percentUsed", { header, percent: pct })];
		const window = limit.window;
		if (window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > nowMs) {
			parts.push(
				t("overlaysModel.advisorConfig.quotaReset", {
					label: window.resetLabel ?? t("overlaysModel.advisorConfig.resets"),
					duration: formatDuration(window.resetsAt - nowMs),
				}),
			);
		}
		lines.push(parts.join(" · "));
	}
	return t("overlaysModel.advisorConfig.quota", { items: lines.join(" │ ") });
}

function previewLineOrNone(text: string | undefined): string {
	if (!text?.trim()) return t("overlaysModel.advisorConfig.none");
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Omitted means default read/grep/glob; an explicit empty set means no tools. */
function commitTools(
	selected: ReadonlySet<string>,
	all: readonly string[],
	defaults: ReadonlySet<string>,
): string[] | undefined {
	if (selected.size === 0) return [];
	if (selected.size === defaults.size) {
		let matchesDefault = true;
		for (const name of defaults) {
			if (!selected.has(name)) {
				matchesDefault = false;
				break;
			}
		}
		if (matchesDefault) return undefined;
	}
	return all.filter(name => selected.has(name));
}

function formatAdvisorTools(tools: readonly string[] | undefined, emptyLabel: string): string {
	if (tools === undefined) return t("overlaysModel.advisorConfig.defaultTools");
	return tools.length > 0 ? tools.join(", ") : emptyLabel;
}

/** Choice value for "no per-advisor override"; matches no {@link ADVISOR_SYNC_BACKLOG_MODES} entry. */
const SYNC_BACKLOG_INHERIT = "inherit";

/** The tools list's terminal-only "Done" row; the picker applies with its own action instead. */
const TOOLS_DONE = "__done";

/**
 * A picker editor as a component of its own: a component's root picker stays
 * where it is described, the prefs page's editor slot, where a picker
 * described inside the page would be hoisted into `layer` under the sheet.
 */
class EditorSheet implements Component {
	node: NativeNode | undefined;
	readonly #route: (event: NativeUiEvent) => void;

	constructor(route: (event: NativeUiEvent) => void) {
		this.#route = route;
	}

	render(): readonly string[] {
		return [];
	}

	describe(): NativeNode | null {
		return this.node ?? null;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.#route(event);
	}
}

/** Whether two memo dependency lists hold the same values by identity. */
function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** One-line cadence label: mode plus interval. */
function formatReviewCadence(advisor: AdvisorConfig): string {
	const reviewInterval = advisor.reviewInterval ?? 1;
	const mode = advisor.reviewMode ?? "turn";
	return reviewInterval === 1
		? t("overlaysModel.advisorConfig.reviewCadenceOne", { mode, count: reviewInterval })
		: t("overlaysModel.advisorConfig.reviewCadenceMany", { mode, count: reviewInterval });
}

/** Picker description for one explicit catch-up policy value. */
function describeSyncBacklogMode(mode: AdvisorSyncBacklog): string {
	switch (mode) {
		case "off":
			return t("overlaysModel.advisorConfig.backlogOff");
		case "strict":
			return t("overlaysModel.advisorConfig.backlogStrict");
		default:
			return t("overlaysModel.advisorConfig.backlogThreshold", { count: mode });
	}
}

/** Soft-wrap plain text to `width`, returning at least one (possibly empty) line. */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

type Screen =
	| "list"
	| "detail"
	| "delete-confirm"
	| "name"
	| "model"
	| "tools"
	| "thinking"
	| "review-mode"
	| "review-interval"
	| "sync-backlog"
	| "instructions"
	| "systemPrompt"
	| "copy-target"
	| "generate-bases"
	| "generate-comment"
	| "generating";

interface AdvisorNavigationContext {
	screen: Screen;
	index: number;
	thinking?: { selector: string; efforts: readonly string[] };
	tools?: string[];
}

interface AdvisorListState {
	navigation: SelectListNavigationState;
	previewScroll: number;
	previewFocused: boolean;
}

interface AdvisorNavigationSnapshot {
	context: AdvisorNavigationContext;
	scope: AdvisorConfigScope;
	doc: WatchdogConfigDoc;
	/** Opaque host identity preserves the original file-concurrency and repair metadata. */
	docOwner: WatchdogConfigDoc;
	dirty: boolean;
	pendingApply: boolean;
	previewScroll: number;
	previewFocused: boolean;
	lists: [string, AdvisorListState][];
	content: unknown;
}

/** Footer key hints per screen for the described overlay (the ANSI footer strings carry the same keys). */
function screenHints(screen: Screen): (NativeHint | undefined)[] {
	switch (screen) {
		case "list":
			return [
				actionHint(["tui.select.up", "tui.select.down"], t("overlaysModel.advisorConfig.moveHint")),
				actionHint("tui.select.confirm", t("overlaysModel.advisorConfig.selectHint")),
				{ keys: ["c"], label: t("overlaysModel.advisorConfig.cloneHint") },
				{ keys: ["delete"], label: t("overlaysModel.advisorConfig.deleteHint") },
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.closeHint")),
			];
		case "detail":
			return [
				actionHint("tui.select.confirm", t("overlaysModel.advisorConfig.editFieldHint")),
				{ keys: ["c"], label: t("overlaysModel.advisorConfig.cloneHint") },
				{ keys: ["delete"], label: t("overlaysModel.advisorConfig.deleteHint") },
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.backHint")),
			];
		case "delete-confirm":
		case "copy-target":
		case "generate-bases":
			return [
				actionHint("tui.select.confirm", t("overlaysModel.advisorConfig.chooseHint")),
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.cancelHint")),
			];
		case "generating":
			return [actionHint("app.interrupt", t("overlaysModel.advisorConfig.cancelGenerationHint"))];
		case "name":
			return [
				actionHint("tui.input.submit", t("overlaysModel.advisorConfig.saveHint")),
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.cancelHint")),
			];
		case "model":
			return [
				{ keys: ["/"], label: t("overlaysModel.advisorConfig.searchHint") },
				{ keys: ["enter"], label: t("overlaysModel.advisorConfig.pickHint") },
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.backHint")),
			];
		case "thinking":
		case "review-mode":
		case "sync-backlog":
			return [
				actionHint("tui.select.confirm", t("overlaysModel.advisorConfig.pickHint")),
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.backHint")),
			];
		case "review-interval":
			return [
				actionHint("tui.input.submit", t("overlaysModel.advisorConfig.saveHint")),
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.cancelHint")),
			];
		case "tools":
			return [
				actionHint("tui.select.confirm", t("overlaysModel.advisorConfig.toggleHint")),
				{ keys: [], label: t("overlaysModel.advisorConfig.toolsApplyHint") },
				actionHint("tui.select.cancel", t("overlaysModel.advisorConfig.applyHint")),
			];
		case "instructions":
		case "generate-comment":
		case "systemPrompt":
			return [];
	}
}

/**
 * Fullscreen advisor-configuration overlay. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
export class AdvisorConfigOverlayComponent implements Component {
	#tui: TUI;
	#deps: AdvisorConfigDeps;
	#scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#availableToolNames: readonly string[];
	#defaultModelLabel: string | undefined;
	#cb: AdvisorConfigCallbacks;
	#scope: AdvisorConfigScope;
	#doc: WatchdogConfigDoc;
	#effectiveRoster: readonly EffectiveAdvisorConfig[];
	/** Cached usage reports (quota/window/reset) prefetched on overlay open. */
	#cachedReports: UsageReport[] | null = null;
	#dirty = false;
	/** Saved to disk this session but not yet applied to the live advisors. */
	#pendingApply = false;

	/** The advisor the detail screen (and its editors) edits; -1 on the roster or the shared instructions. */
	#detailIndex = -1;
	#nativePrefs: { signature: string; editor: NativeNode | undefined; node: NativeNode } | undefined;
	/** The editor over the prefs page, rebuilt only when one of `deps` changes identity. */
	#nativeEditor: { deps: readonly unknown[]; node: NativeNode } | undefined;
	/** The model screen's catalogue and the advisor's current model among it (picker `current`). */
	#modelItems: ModelBrowserItem[] = [];
	#modelCurrent: string | undefined;
	/** Picker sheet options of the current list screen (thinking, review mode, sync backlog, tools). */
	#sheetOptions: SelectPickerOptions | undefined;
	readonly #editorSheet = new EditorSheet(event => this.#routeEditorPicker(event));
	#screen: Screen = "list";
	/** The interactive element for the current screen. */
	#active: Component = new SelectList([], 1, getSelectListTheme(), { search: "always" });
	#footerHint = "";
	#previewScroll = 0;
	readonly #keys = new MenuKeyReader();
	#navigationContext: AdvisorNavigationContext = { screen: "list", index: -1 };
	#navigationScope: AdvisorConfigScope;
	#thinking: AdvisorNavigationContext["thinking"];
	#tools: Set<string> | undefined;
	#restoringNavigation = false;
	#contextOnly = false;
	#pendingOperations = 0;
	#scopeLoadRevision = 0;
	#previewFocused = false;
	#generationAbort: AbortController | undefined;
	#viewRevision = 0;
	#previewRowsLast = 1;
	#previewWidthLast = 1;
	#previewLayoutDirty = true;
	#previewMaxScroll = 0;
	readonly #listStates = new Map<string, AdvisorListState>();
	#previousNavigationSnapshot: AdvisorNavigationSnapshot | undefined;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	#nativeHints: { screen: Screen; node: NativeNode | undefined } | undefined;
	#nativePreview: { json: string; node: NativeNode } | undefined;
	#nativeRoot:
		| {
				screen: Screen;
				active: Component;
				title: string;
				preview: NativeNode | undefined;
				hints: NativeNode | undefined;
				node: NativeNode;
		  }
		| undefined;

	// Persistent frame: top, growing two-pane body, divider, footer, bottom.
	// The frame paints from screen row 0, so SGR `event.row`/`event.col` —
	// already 0-based — index directly into the stack. The list screen splits
	// (sidebar + preview); every other screen forces the narrow left pane.
	#bodyRowsLast = 3;
	#renderActivePane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRowsLast));
		if (this.#active instanceof SelectList) this.#active.setMaxVisible(Math.max(1, rows - 1));
		else if (this.#active instanceof ModelBrowser) this.#active.setMaxVisible(Math.max(1, rows - 5));
		const lines = [...this.#active.render(width)];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	#renderPreviewPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRowsLast));
		const lines = [...this.#previewWindow(width, rows)];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #split = new SplitPane({
		left: this.#renderActivePane,
		right: this.#renderPreviewPane,
		leftSize: { ratio: 0.34, min: 22, max: 42 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #frameTop = new PanelRows();
	readonly #frameDivider = new PanelRows();
	readonly #frameFooter = new PanelRows();
	readonly #frameBottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#frameTop, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#frameDivider, height: 1 },
			{ content: this.#frameFooter, height: 1 },
			{ content: this.#frameBottom, height: 1 },
		],
	});

	constructor(
		tui: TUI,
		deps: AdvisorConfigDeps,
		scope: AdvisorConfigScope,
		doc: WatchdogConfigDoc,
		callbacks: AdvisorConfigCallbacks,
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#scopedModels = deps.scopedModels;
		this.#availableToolNames = deps.availableToolNames;
		this.#defaultModelLabel = deps.defaultModelLabel;
		this.#cb = callbacks;
		this.#scope = scope;
		this.#navigationScope = scope;
		this.#doc = doc;
		this.#effectiveRoster = deps.effectiveRoster ?? [];
		this.#ensureRosterVisible();
		this.#showList();
		// Prefetch usage reports for quota display; non-fatal if unavailable.
		if (callbacks.getUsageReports) {
			void callbacks
				.getUsageReports()
				.then(r => {
					this.#cachedReports = r;
					this.#cb.requestRender();
				})
				.catch(() => {});
		}
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		this.#bodyRowsLast = bodyRows;
		const state = this.#dirty
			? t("overlaysModel.advisorConfig.unsavedMarker")
			: this.#pendingApply
				? t("overlaysModel.advisorConfig.pendingApplyMarker")
				: "";
		const title = t("overlaysModel.advisorConfig.title", {
			file: sanitizeDisplayLine(this.#deps.filePath ?? this.#scope),
			state,
		});
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([
			isSplit && !this.#deps.filePath ? topBorderSplit(width, title, leftWidth) : topBorder(width, title),
		]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		this.#frameFooter.setLines([row(theme.fg("dim", this.#footerHint), width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(bodyRows + 4);
		return this.#frame.render(width);
	}

	/** Docks as a side sheet beside the transcript, like `/settings`, when the terminal draws `prefs` with `aside`. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	/**
	 * The native settings page (`prefs`) when the terminal draws it: a page per
	 * advisor plus the shared instructions, the advisor's fields as typed rows,
	 * the file actions, and the model/tools/instructions editors over the page.
	 * Otherwise the root card `omp.overlay.advisor`: on the roster screen a
	 * sidebar (the active `SelectList`) beside the highlighted entry's preview;
	 * every other screen shows its editor component alone. Key hints close the
	 * card.
	 */
	describe(cx: DescribeContext): NativeNode {
		if (cx.supports("prefs")) return this.#describePrefs();
		return this.#describeCard();
	}

	/** The advisor index a page shows: the detail's, else the roster's highlighted advisor, else the first. */
	#pageIndex(): number {
		if (this.#detailIndex >= 0) return this.#detailIndex;
		const value = this.#active instanceof SelectList ? (this.#active.getSelectedItem()?.value ?? "") : "";
		const match = /^advisor:(\d+)$/.exec(value);
		return match ? Number(match[1]) : value === "shared" ? -1 : 0;
	}

	#describePrefs(): NativeNode {
		const doc = this.#doc;
		const index = this.#pageIndex();
		const shared = index < 0;
		const advisor = shared ? undefined : doc.advisors[index];
		const pages: TspPrefsProps["pages"][number][] = doc.advisors.map((a, i) => ({
			id: `advisor:${i}`,
			label: a.name || t("overlaysModel.advisorConfig.unnamed"),
			icon: "advisor",
			group: t("overlaysModel.advisorConfig.advisors"),
		}));
		pages.push({
			id: "shared",
			label: t("overlaysModel.advisorConfig.sharedInstructions"),
			icon: "doc",
			group: t("overlaysModel.advisorConfig.allAdvisors"),
		});

		const sections: TspPrefsProps["sections"][number][] = [];
		if (this.#effectiveRoster.length > 0) {
			sections.push({
				id: "effective-roster",
				title: t("overlaysModel.advisorConfig.effectiveRosterHeading"),
				rows: this.#effectiveRoster.map((advisor, i) => ({
					id: `effective:${i}`,
					label: sanitizeDisplayLine(advisor.name),
					hint: `${advisor.scope} · ${sanitizeDisplayLine(shortenPath(advisor.sourceFile))}`,
					disabled: t("overlaysModel.advisorConfig.readOnlyOverview"),
					control: { k: "switch", on: advisor.enabled !== false },
				})),
			});
		}
		if (doc.warnings?.length) {
			sections.push({
				id: "warnings",
				title: t("overlaysModel.advisorConfig.configProblems"),
				rows: sanitizeDisplayWarnings(doc.warnings).map((warning, i) => ({
					id: `warning:${i}`,
					label: t("overlaysModel.advisorConfig.dropped"),
					warning,
					control: { k: "action", label: t("overlaysModel.advisorConfig.saveToRewrite"), act: "save" },
				})),
			});
		}
		if (advisor) {
			const model = advisor.model?.trim();
			const tools = advisor.tools ?? [...this.#deps.defaultToolNames];
			const rows: TspPrefsRow[] = [
				{
					id: "toggleEnabled",
					label: t("overlaysModel.advisorConfig.enabled"),
					hint: this.#deps.getActivationNote?.(advisor) ?? t("overlaysModel.advisorConfig.enabledHint"),
					control: { k: "switch", on: advisor.enabled !== false },
				},
				{ id: "name", label: t("overlaysModel.advisorConfig.name"), control: { k: "text", value: advisor.name } },
				{
					id: "model",
					label: t("overlaysModel.advisorConfig.model"),
					hint: model
						? undefined
						: t("overlaysModel.advisorConfig.usesDefault", {
								model: this.#defaultModelLabel ?? t("overlaysModel.advisorConfig.unset"),
							}),
					changed: model ? true : undefined,
					defaultLabel: model
						? (this.#defaultModelLabel ?? t("overlaysModel.advisorConfig.roleDefault"))
						: undefined,
					control: {
						k: "action",
						label: model || this.#defaultModelLabel || t("overlaysModel.advisorConfig.roleDefault"),
						act: "edit",
					},
				},
				{
					id: "reviewMode",
					label: t("overlaysModel.advisorConfig.reviewMode"),
					hint: t("overlaysModel.advisorConfig.reviewModeHint"),
					changed: advisor.reviewMode !== undefined ? true : undefined,
					control: {
						k: "choice",
						value: advisor.reviewMode ?? "turn",
						options: ADVISOR_REVIEW_MODES.map(mode => ({ value: mode, label: mode })),
						style: "segmented",
					},
				},
				{
					id: "reviewInterval",
					label: t("overlaysModel.advisorConfig.reviewInterval"),
					hint: t("overlaysModel.advisorConfig.reviewIntervalHint"),
					changed: advisor.reviewInterval !== undefined ? true : undefined,
					control: { k: "number", value: advisor.reviewInterval ?? 1, min: 1, step: 1 },
				},
				{
					id: "syncBacklog",
					label: t("overlaysModel.advisorConfig.syncBacklog"),
					hint: t("overlaysModel.advisorConfig.backlogPolicy", { policy: this.#deps.syncBacklog ?? "off" }),
					changed: advisor.syncBacklog !== undefined ? true : undefined,
					control: {
						k: "choice",
						value: advisor.syncBacklog ?? SYNC_BACKLOG_INHERIT,
						options: [
							{ value: SYNC_BACKLOG_INHERIT, label: t("overlaysModel.advisorConfig.inherit") },
							...ADVISOR_SYNC_BACKLOG_MODES.map(mode => ({
								value: mode,
								label: mode,
								detail: describeSyncBacklogMode(mode),
							})),
						],
						style: "menu",
					},
				},
				{
					id: "tools",
					label: t("overlaysModel.advisorConfig.tools"),
					hint: t("overlaysModel.advisorConfig.toolsHint"),
					control: {
						k: "multi",
						values: tools,
						options: this.#availableToolNames.map(name => ({ value: name, label: name })),
					},
				},
				{
					id: "instructions",
					label: t("overlaysModel.advisorConfig.instructions"),
					hint: previewLineOrNone(advisor.instructions),
					control: { k: "action", label: t("overlaysModel.advisorConfig.edit"), act: "edit" },
				},
			];
			if (this.#cb.editActivationSet)
				rows.push({
					id: "activationSet",
					label: t("overlaysModel.advisorConfig.roleSet"),
					hint: this.#deps.getActivationNote?.(advisor) ?? t("overlaysModel.advisorConfig.roleSetHint"),
					control: { k: "action", label: t("overlaysModel.advisorConfig.editRoleSet"), act: "edit" },
				});
			rows.push({
				id: "duplicate",
				label: t("overlaysModel.advisorConfig.duplicateAdvisor"),
				control: { k: "action", label: t("overlaysModel.advisorConfig.duplicate"), act: "edit" },
			});
			if (this.#cb.copyAdvisor && this.#cb.getSources)
				rows.push({
					id: "copy",
					label: t("overlaysModel.advisorConfig.copyToScope"),
					control: { k: "action", label: t("overlaysModel.advisorConfig.chooseFile"), act: "edit" },
				});
			if (this.#cb.copyPrompt)
				rows.push({
					id: "copyPrompt",
					label: t("overlaysModel.advisorConfig.copyFullPrompt"),
					control: { k: "action", label: t("overlaysModel.advisorConfig.copy"), act: "edit" },
				});
			sections.push({ id: "advisor", title: advisor.name || t("overlaysModel.advisorConfig.advisor"), rows });
		} else {
			sections.push({
				id: "shared",
				title: t("overlaysModel.advisorConfig.sharedInstructions"),
				rows: [
					{
						id: "shared",
						label: t("overlaysModel.advisorConfig.instructions"),
						hint: previewLineOrNone(doc.instructions),
						control: { k: "action", label: t("overlaysModel.advisorConfig.edit"), act: "edit" },
					},
				],
			});
		}
		sections.push({
			id: "file",
			title: sanitizeDisplayLine(this.#deps.filePath ?? `WATCHDOG.yml · ${this.#scope}`),
			rows: [
				{
					id: "save",
					label: t("overlaysModel.advisorConfig.saveApply"),
					hint: t("overlaysModel.advisorConfig.saveApplyHint"),
					warning: this.#dirty ? t("overlaysModel.advisorConfig.unsavedChanges") : undefined,
					control: { k: "action", label: t("overlaysModel.advisorConfig.save"), act: "save" },
				},
				{
					id: "add",
					label: t("overlaysModel.advisorConfig.addAdvisor"),
					hint: t("overlaysModel.advisorConfig.addAdvisorHint"),
					control: { k: "action", label: t("overlaysModel.advisorConfig.add"), act: "add" },
				},
			],
		});
		if (this.#cb.generateAdvisor && this.#cb.getSources)
			sections.push({
				id: "generation",
				title: t("overlaysModel.advisorConfig.authoring"),
				rows: [
					{
						id: "generate",
						label: t("overlaysModel.advisorConfig.fromDefinitions"),
						control: { k: "action", label: t("overlaysModel.advisorConfig.chooseAdvisors"), act: "generate" },
					},
				],
			});

		// Name editing shows its draft in the row; the other editors sit over the page.
		const input = this.#screen === "name" && this.#active instanceof Input ? this.#active : undefined;
		const editing = input
			? { row: "name", draft: input.getValue(), cursor: Number(input.debugState().cursor) }
			: null;
		const filteredList =
			this.#active instanceof SelectList && (this.#active.filterFocused || this.#active.getFilter().length > 0);
		const overlay =
			filteredList ||
			this.#screen === "delete-confirm" ||
			this.#screen === "model" ||
			this.#screen === "thinking" ||
			this.#screen === "review-mode" ||
			this.#screen === "review-interval" ||
			this.#screen === "sync-backlog" ||
			this.#screen === "tools" ||
			this.#screen === "instructions" ||
			this.#screen === "systemPrompt" ||
			this.#screen === "copy-target" ||
			this.#screen === "generate-bases" ||
			this.#screen === "generate-comment" ||
			this.#screen === "generating";
		const editor = overlay ? this.#prefsEditor() : undefined;
		const focus =
			this.#screen === "detail" && this.#active instanceof SelectList
				? (this.#active.getSelectedItem()?.value ?? null)
				: null;
		const props: TspPrefsProps = {
			title: this.#dirty
				? t("overlaysModel.advisorConfig.advisorsUnsaved")
				: t("overlaysModel.advisorConfig.advisors"),
			pages,
			page: shared ? "shared" : `advisor:${index}`,
			lead: shared ? t("overlaysModel.advisorConfig.sharedLead") : t("overlaysModel.advisorConfig.advisorLead"),
			sections,
			focus,
			editing,
		};
		const signature = JSON.stringify(props);
		const prev = this.#nativePrefs;
		if (prev && prev.signature === signature && prev.editor === editor) return prev.node;
		let children: NativeChild[] = [];
		if (editor?.k === "picker") {
			this.#editorSheet.node = editor;
			children = [this.#editorSheet];
		} else if (editor) {
			children = [editor];
		}
		const root = node("prefs", props, children);
		this.#nativePrefs = { signature, editor, node: root };
		return root;
	}

	/**
	 * The editor over the prefs page. Choices are picker sheets on `/model`'s
	 * anatomy (search, rows, the highlighted model's facts, one primary
	 * action); the instructions and review-interval editors sit in the page's
	 * editor card.
	 */
	#prefsEditor(): NativeNode {
		const active = this.#active;
		const memo = this.#nativeEditor;
		if (active instanceof ModelBrowser) {
			const order = active.pickerOrder({
				providers: false,
				rest: active.query.trim() ? t("overlaysModel.advisorConfig.matches") : t("overlaysModel.advisorConfig.all"),
			});
			const catalogue = active.pickerItems(this.#modelItems);
			const preview = active.pickerPreview("compact", this.#modelCurrent);
			const deps = [
				getLocale(),
				active,
				order,
				catalogue,
				preview,
				active.query,
				active.value,
				active.cursor,
				active.pickerSelected,
				active.filterFocused,
			];
			if (memo && sameDeps(memo.deps, deps)) return memo.node;
			const sheet = this.#modelSheet(active, order, catalogue, preview);
			this.#nativeEditor = { deps, node: sheet };
			return sheet;
		}
		if (active instanceof SelectList) {
			const view = active.pickerView();
			const deps = [
				getLocale(),
				active,
				view.items,
				view.selected,
				view.pending,
				view.query,
				view.cursor,
				active.filterFocused,
			];
			if (memo && sameDeps(memo.deps, deps)) return memo.node;
			const options = this.#sheetOptions ?? {
				title:
					this.#screen === "list"
						? t("overlaysModel.advisorConfig.advisors")
						: t("overlaysModel.advisorConfig.advisorSettings"),
				noun:
					this.#screen === "list"
						? t("overlaysModel.advisorConfig.advisorsNoun")
						: t("overlaysModel.advisorConfig.fieldsNoun"),
			};
			const props = selectListPicker(active, options);
			const sheet = node(
				"picker",
				this.#screen === "tools"
					? {
							...props,
							items: props.items?.filter(item => item.id !== TOOLS_DONE),
							actions: [
								pickerAction("confirm", t("overlaysModel.advisorConfig.toggle"), "enter"),
								pickerAction(
									"apply",
									active.filterFocused
										? t("overlaysModel.advisorConfig.backToList")
										: view.query
											? t("overlaysModel.advisorConfig.clearSearch")
											: t("overlaysModel.advisorConfig.apply"),
									"escape",
									{
										primary: true,
										end: true,
									},
								),
							],
						}
					: props,
			);
			this.#nativeEditor = { deps, node: sheet };
			return sheet;
		}
		const deps = [getLocale(), active];
		if (memo && sameDeps(memo.deps, deps)) return memo.node;
		const content = this.#screen === "review-interval" ? this.#intervalCard(active) : active;
		const card = col([content], { role: "omp.prefs.editor" });
		this.#nativeEditor = { deps, node: card };
		return card;
	}

	#modelSheet(
		browser: ModelBrowser,
		order: ModelPickerOrder,
		catalogue: ModelPickerCatalogue,
		preview: readonly NativeChild[],
	): NativeNode {
		const name = this.#doc.advisors[this.#detailIndex]?.name || t("overlaysModel.advisorConfig.thisAdvisorCaps");
		const fallback = this.#defaultModelLabel ?? t("overlaysModel.advisorConfig.theRoleDefault");
		return node(
			"picker",
			{
				title: t("overlaysModel.advisorConfig.advisorModel"),
				subtitle: t("overlaysModel.advisorConfig.modelSubtitle", { name, fallback }),
				icon: "model",
				noun: t("overlaysModel.advisorConfig.modelsNoun"),
				size: "md",
				layout: "rows",
				preview: "below",
				placeholder: t("overlaysModel.advisorConfig.searchModels"),
				...browser.pickerRows(catalogue, order, this.#modelCurrent),
				empty: t("overlaysModel.advisorConfig.noModels"),
				actions: [
					pickerAction("use", t("overlaysModel.advisorConfig.useForAdvisor"), "enter", { primary: true }),
					{
						...CLOSE_ACTION,
						label: browser.filterFocused
							? t("overlaysModel.advisorConfig.backToList")
							: t("overlaysModel.advisorConfig.back"),
					},
				],
			},
			preview,
		);
	}

	/** The review-interval field as a titled card: what the number means, the field, Cancel and Save. */
	#intervalCard(input: Component): NativeNode {
		const name = this.#doc.advisors[this.#detailIndex]?.name || t("overlaysModel.advisorConfig.thisAdvisor");
		return overlayCard("omp.overlay.advisor.interval", t("overlaysModel.advisorConfig.intervalTitle", { name }), [
			text([span(t("overlaysModel.advisorConfig.reviewIntervalHint"), "muted")], {
				wrap: "word",
			}),
			input,
			actionBar([
				null,
				actionButton(t("overlaysModel.advisorConfig.cancel"), "field-cancel", { keys: "escape" }),
				actionButton(t("overlaysModel.advisorConfig.save"), "field-save", { keys: "enter", tone: "accent" }),
			]),
		]);
	}

	/** A pointer event on the editor's picker sheet, on the path of the key it stands for. */
	#routeEditorPicker(event: NativeUiEvent): void {
		this.#keys.reset();
		const picked = pickerEvent(event);
		if (!picked) return;
		const active = this.#active;
		if (active instanceof ModelBrowser) {
			if (picked.kind !== "action") active.routePickerItem(picked.item, picked.kind === "activate");
			else if (picked.act === "close") active.handleCancel();
			else if (picked.act === "use" && active.pickerSelected) active.routePickerItem(active.pickerSelected, true);
		} else if (active instanceof SelectList) {
			// The tools list applies on cancel, like its Esc.
			if (picked.kind === "action" && picked.act === "apply") {
				if (active.filterFocused || active.getFilter()) active.handleInput(active.filterFocused ? "\x03" : "\x1b");
				else active.onCancel?.();
			} else routeSelectListPicker(active, event);
		}
		this.#cb.requestRender();
	}

	/**
	 * Native page events, each through the roster/detail selections the keys
	 * make: a page opens that advisor (or the shared instructions), a field
	 * change or button runs the field's detail action, and closing an editor
	 * or the page cancels like Esc.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#keys.reset();
		// The review-interval card's buttons, on its Enter and Esc paths.
		if (event.type === "action" && (event.act === "field-save" || event.act === "field-cancel")) {
			const input = this.#active;
			if (!(input instanceof Input)) return;
			if (event.act === "field-save") input.onSubmit?.(input.getValue());
			else input.onEscape?.();
			return;
		}
		if (event.key !== "") return;
		const index = this.#pageIndex();
		switch (event.type) {
			case "action": {
				if (event.act === "page" && event.value) {
					this.#contextOnly = true;
					try {
						const match = /^advisor:(\d+)$/.exec(event.value);
						if (match) this.#showDetail(Number(match[1]));
						else if (event.value === "shared") this.#showInstructionsEditor(-1);
					} finally {
						this.#contextOnly = false;
					}
					return;
				}
				if (event.act === "close") {
					if (
						event.value !== undefined ||
						("filterFocused" in this.#active && this.#active.filterFocused === true) ||
						(this.#active instanceof SelectList && this.#active.getFilter().length > 0)
					)
						this.handleInput(
							"filterFocused" in this.#active && this.#active.filterFocused === true ? "\x03" : "\x1b",
						);
					else this.#cb.close();
					return;
				}
				if (event.act === "save" || event.act === "add" || event.act === "generate") {
					void this.#onListSelect(event.act).catch(err => {
						this.#cb.notify(
							t("overlaysModel.advisorConfig.error", {
								error: err instanceof Error ? err.message : String(err),
							}),
						);
					});
					return;
				}
				if (event.value === "shared") this.#showInstructionsEditor(-1);
				else if (index >= 0 && event.value && event.act !== "delete" && event.value !== "delete")
					this.#onDetailSelect(index, event.value);
				return;
			}
			case "change": {
				if (index < 0) return;
				const advisor = this.#doc.advisors[index];
				if (!advisor) return;
				if (event.item === "toggleEnabled" && typeof event.value === "boolean") {
					if (event.value !== (advisor.enabled !== false)) this.#onDetailSelect(index, "toggleEnabled");
				} else if (event.item === "tools" && Array.isArray(event.value)) {
					advisor.tools = commitTools(new Set(event.value), this.#availableToolNames, this.#deps.defaultToolNames);
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "name" && typeof event.value === "string" && event.value.trim()) {
					advisor.name = event.value.trim();
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "reviewMode" && (typeof event.value === "string" || event.value === null)) {
					// `turn` is the default, stored as an omitted field; `null` resets to it.
					const mode = event.value === null ? "turn" : ADVISOR_REVIEW_MODES.find(m => m === event.value);
					if (!mode) return;
					advisor.reviewMode = mode === "turn" ? undefined : mode;
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "reviewInterval" && (typeof event.value === "number" || event.value === null)) {
					const interval = event.value ?? 1;
					if (!Number.isSafeInteger(interval) || interval < 1) return;
					advisor.reviewInterval = interval === 1 ? undefined : interval;
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "syncBacklog" && (typeof event.value === "string" || event.value === null)) {
					// The inherit sentinel and `null` match no mode, so the override clears.
					advisor.syncBacklog = ADVISOR_SYNC_BACKLOG_MODES.find(mode => mode === event.value);
					this.#dirty = true;
					this.#showDetail(index);
				}
				return;
			}
			case "activate":
				if (event.item === "shared") this.#showInstructionsEditor(-1);
				else if (index >= 0) this.#onDetailSelect(index, event.item);
				return;
			case "select":
				if (this.#screen === "detail" && this.#active instanceof SelectList) {
					this.#active.setSelectedValue(event.item);
					this.#cb.requestRender();
				}
				return;
			case "toggle":
				return;
		}
	}

	#describeCard(): NativeNode {
		const title = t("overlaysModel.advisorConfig.title", {
			file: sanitizeDisplayLine(this.#deps.filePath ?? this.#scope),
			state: this.#dirty ? t("overlaysModel.advisorConfig.unsavedMarker") : "",
		});
		const preview = this.#screen === "list" ? this.#describePreview() : undefined;
		if (this.#nativeHints?.screen !== this.#screen) {
			const hints = screenHints(this.#screen);
			if (this.#cb.openConfigFile && (this.#screen === "list" || this.#screen === "detail"))
				hints.push({ keys: ["ctrl+g"], label: t("overlaysModel.advisorConfig.editConfigFile") });
			this.#nativeHints = { screen: this.#screen, node: hints.length > 0 ? hintsRow(hints) : undefined };
		}
		const hints = this.#nativeHints.node;
		const prev = this.#nativeRoot;
		if (
			prev?.screen === this.#screen &&
			prev.active === this.#active &&
			prev.title === title &&
			prev.preview === preview &&
			prev.hints === hints
		) {
			return prev.node;
		}
		const head: TspSpan[] = [
			span(
				t("overlaysModel.advisorConfig.title", {
					file: sanitizeDisplayLine(this.#deps.filePath ?? this.#scope),
					state: "",
				}),
			),
		];
		if (this.#dirty) head.push(span("  ● unsaved", "warning"));
		const body: NativeNode = preview
			? node(
					"row",
					{ gap: "md", align: "start", grow: 1 },
					[
						node("col", { min: { w: "22ch" }, max: { w: "42ch" }, basis: 0.34 }, [this.#active], "sidebar"),
						preview,
					],
					"split",
				)
			: node("col", { grow: 1 }, [this.#active], "body");
		const children: NativeChild[] = [body];
		if (hints) children.push(node("rule", undefined, undefined, "divider"), hints);
		const card = overlayCard("omp.overlay.advisor", head, children);
		this.#nativeRoot = { screen: this.#screen, active: this.#active, title, preview, hints, node: card };
		return card;
	}

	/** The highlighted roster entry's preview; rebuilt only when its content changes (live stats, quota). */
	#describePreview(): NativeNode {
		const children: NativeNode[] = [];
		if (this.#doc.warnings?.length) {
			children.push(
				node(
					"col",
					{ tone: "warning" },
					[
						text([span(t("overlaysModel.advisorConfig.droppedHeader"), "warning")]),
						...sanitizeDisplayWarnings(this.#doc.warnings).map(warning =>
							text([span(warning, "warning")], { wrap: "word" }),
						),
					],
					"warnings",
				),
			);
		}
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		if (value === "effective") {
			children.push(
				text([span(t("overlaysModel.advisorConfig.effectiveRosterHeading"), "strong")]),
				...this.#effectiveRoster.map(advisor => text(this.#effectiveAdvisorLabel(advisor), { wrap: "word" })),
				text([span(t("overlaysModel.advisorConfig.overviewHint"), "muted")], { wrap: "word" }),
			);
		}
		const match = /^advisor:(\d+)$/.exec(value);
		const advisor = match ? this.#doc.advisors[Number(match[1])] : undefined;
		if (advisor) {
			children.push(...this.#describeAdvisorPreview(advisor));
		} else if (value === "shared") {
			const instructions = this.#doc.instructions?.trim();
			children.push(
				text([span(t("overlaysModel.advisorConfig.sharedInstructions"), "strong")]),
				instructions
					? text(instructions, { wrap: "word" })
					: text([span(t("overlaysModel.advisorConfig.none"), "muted")]),
			);
		} else {
			const help =
				value === "add"
					? t("overlaysModel.advisorConfig.createPreview")
					: value === "save"
						? t("overlaysModel.advisorConfig.savePreview")
						: value === "close"
							? t("overlaysModel.advisorConfig.closePreview")
							: "";
			if (help) children.push(text([span(help, "muted")], { wrap: "word" }));
		}
		const candidate = node("col", { gap: "sm", grow: 1 }, children, "preview");
		const json = JSON.stringify(candidate);
		if (this.#nativePreview?.json === json) return this.#nativePreview.node;
		this.#nativePreview = { json, node: candidate };
		return candidate;
	}

	#describeAdvisorPreview(advisor: AdvisorConfig): NativeNode[] {
		const model = advisor.model?.trim() || this.#defaultModelLabel || t("overlaysModel.advisorConfig.roleDefault");
		const instructions = advisor.instructions?.trim();
		const out: NativeNode[] = [
			text([span(advisor.name || t("overlaysModel.advisorConfig.unnamed"), "strong")]),
			node("kv", {
				items: [
					{
						k: t("overlaysModel.advisorConfig.enabled"),
						v:
							advisor.enabled === false
								? t("overlaysModel.advisorConfig.offMarker")
								: t("overlaysModel.advisorConfig.onMarker"),
					},
					{ k: t("overlaysModel.advisorConfig.model"), v: model },
					{
						k: t("overlaysModel.advisorConfig.tools"),
						v: formatAdvisorTools(advisor.tools, t("overlaysModel.advisorConfig.noTools")),
					},
					{ k: t("overlaysModel.advisorConfig.review"), v: formatReviewCadence(advisor) },
					{ k: t("overlaysModel.advisorConfig.syncBacklog"), v: this.#syncBacklogLabel(advisor) },
				],
			}),
			text([span(t("overlaysModel.advisorConfig.instructionsColon"), "dim")]),
			instructions
				? text(instructions, { wrap: "word" })
				: text([span(t("overlaysModel.advisorConfig.none"), "muted")]),
		];
		const liveStat = this.#cb.getAdvisorStats?.()?.find(s => s.name === (advisor.name || "default"));
		if (liveStat && (liveStat.status === "running" || liveStat.status === "quota_exhausted")) {
			const spendParts = [
				t("overlaysModel.advisorConfig.tokensIn", { count: liveStat.tokens.input.toLocaleString() }),
				t("overlaysModel.advisorConfig.tokensOut", { count: liveStat.tokens.output.toLocaleString() }),
			];
			if (liveStat.tokens.cacheRead > 0)
				spendParts.push(
					t("overlaysModel.advisorConfig.tokensCached", { count: liveStat.tokens.cacheRead.toLocaleString() }),
				);
			const usage: { k: string; v: string }[] = [
				{ k: t("overlaysModel.advisorConfig.tokens"), v: spendParts.join(", ") },
			];
			if (liveStat.cost > 0)
				usage.push({ k: t("overlaysModel.advisorConfig.cost"), v: `$${liveStat.cost.toFixed(4)}` });
			if (liveStat.contextWindow > 0) {
				const pct = Math.round((liveStat.contextTokens / liveStat.contextWindow) * 100);
				usage.push({
					k: t("overlaysModel.advisorConfig.context"),
					v: `${liveStat.contextTokens.toLocaleString()}/${liveStat.contextWindow.toLocaleString()} (${pct}%)`,
				});
			}
			out.push(text([span(t("overlaysModel.advisorConfig.usageColon"), "dim")]), node("kv", { items: usage }));
		}
		const quotaProvider =
			(advisor.model?.includes("/") ? advisor.model.split("/")[0] : null) ?? liveStat?.model?.provider;
		if (this.#cachedReports && quotaProvider) {
			const quota = formatCompactQuota(
				quotaProvider,
				this.#cachedReports,
				Date.now(),
				this.#cb.getQuotaLimitFilter?.(quotaProvider, liveStat?.sessionId),
			);
			if (quota) out.push(text([span(quota, "dim")], { wrap: "word" }));
		}
		return out;
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#keys.reset();
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		const active = this.#active;
		if (this.#screen === "generating" && active instanceof SelectList) {
			if (matchesAppInterrupt(data)) active.onCancel?.();
			else if (matchesKey(data, "enter")) active.handleInput(data);
			return;
		}
		const textFocused =
			active instanceof Input ||
			active instanceof HookEditorComponent ||
			("filterFocused" in active && active.filterFocused === true);
		if (textFocused) {
			this.#keys.reset();
			const text = active instanceof Input ? extractPrintableText(data) : undefined;
			if (text !== undefined && active instanceof Input) active.insertText(text);
			else active.handleInput?.(data);
			return;
		}
		if (this.#screen === "list" || this.#screen === "detail") {
			const value = active instanceof SelectList ? active.getSelectedItem()?.value : undefined;
			const match = this.#screen === "list" && value ? /^advisor:(\d+)$/.exec(value) : undefined;
			const index = this.#screen === "detail" ? this.#detailIndex : match ? Number(match[1]) : -1;
			if (matchesKey(data, "c") || matchesKey(data, "delete")) {
				this.#keys.reset();
				if (index >= 0) {
					if (matchesKey(data, "c")) this.#cloneAdvisor(index);
					else this.#showDeleteConfirmation(index);
				}
				return;
			}
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (
			!action &&
			this.#cb.openConfigFile &&
			(this.#screen === "list" || this.#screen === "detail") &&
			matchesKey(data, "ctrl+g")
		) {
			void this.#openConfigFile().catch(err => {
				this.#cb.notify(
					t("overlaysModel.advisorConfig.error", { error: err instanceof Error ? err.message : String(err) }),
				);
			});
			return;
		}
		if (action?.kind === "horizontal") {
			if (this.#screen === "list") this.#previewFocused = action.delta > 0;
			else if (this.#screen === "thinking" && active instanceof SelectList && this.#thinking) {
				const value = active.getSelectedItem()?.value ?? "";
				const index = value === "" ? 0 : this.#thinking.efforts.indexOf(value) + 1;
				const next = Math.max(0, Math.min(this.#thinking.efforts.length, index + action.delta));
				active.setSelectedValue(next === 0 ? "" : this.#thinking.efforts[next - 1]!);
			} else if (action.delta < 0) {
				if (active instanceof SelectList) active.onCancel?.();
				else if (active instanceof ModelBrowser) active.handleCancel();
			} else if (active instanceof SelectList && this.#screen === "detail") {
				const item = active.getSelectedItem();
				if (
					item &&
					[
						"name",
						"model",
						"reviewMode",
						"reviewInterval",
						"syncBacklog",
						"tools",
						"instructions",
						"systemPrompt",
					].includes(item.value)
				)
					active.onSelect?.(item);
			}
			this.#cb.requestRender();
			return;
		}
		if (this.#screen === "list") {
			if (action?.kind === "context") {
				this.#previewFocused = !this.#previewFocused;
				this.#cb.requestRender();
				return;
			}
			if (action?.kind === "search") this.#previewFocused = false;
			if (this.#previewFocused && action && this.#applyPreviewMotion(action)) return;
		}
		if (action?.kind === "toggle" && active instanceof SelectList) {
			if (this.#screen === "list") {
				active.handleInput?.(data);
				return;
			}
		}
		if (action && (active instanceof SelectList || active instanceof ModelBrowser)) active.handleNavigation(action);
		else active.handleInput?.(data);
	}

	#applyPreviewMotion(action: MenuNavAction): boolean {
		if (
			action.kind !== "move" &&
			action.kind !== "scroll" &&
			action.kind !== "halfPage" &&
			action.kind !== "page" &&
			action.kind !== "boundary"
		)
			return false;
		if (this.#previewLayoutDirty) {
			const total = this.#previewContent(this.#previewWidthLast).length;
			const rows = this.#bodyRowsLast;
			const contentRows = rows > 1 && total > rows ? rows - 1 : rows;
			this.#previewRowsLast = Math.max(1, contentRows);
			this.#previewMaxScroll = Math.max(0, total - contentRows);
			this.#previewLayoutDirty = false;
		}
		let next = this.#previewScroll;
		switch (action.kind) {
			case "move":
			case "scroll":
				next += action.delta;
				break;
			case "halfPage":
				next += action.delta * Math.max(1, Math.floor(this.#previewRowsLast / 2));
				break;
			case "page":
				next += action.delta * this.#previewRowsLast;
				break;
			case "boundary":
				next = action.edge === "first" ? 0 : this.#previewMaxScroll;
				break;
		}
		this.#previewScroll = Math.max(0, Math.min(this.#previewMaxScroll, next));
		this.#cb.requestRender();
		return true;
	}

	/** Forward enhanced-paste transports into a multiline instructions editor. */
	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (hit && hit.index === 1) {
			const pane = this.#split.locate(hit.line, hit.col);
			// Right pane of the split (the preview) only scrolls; the left pane
			// routes into the active list/component at pane-local coordinates.
			if (pane?.pane === "right") {
				if (event.wheel !== null) {
					this.#previewScroll = Math.max(0, this.#previewScroll + event.wheel);
					this.#cb.requestRender();
				}
				return true;
			}
			if (pane?.pane === "left" && isLayoutMouseRoutable(this.#active)) {
				this.#active.routeMouse(event, pane.line, pane.col);
				return true;
			}
			return true;
		}
		return false;
	}

	// ───────────────────────────── preview ───────────────────────────

	#previewWindow(bodyWidth: number, rows: number): string[] {
		const lines = this.#previewContent(bodyWidth);
		// Overflow status owns a row; never overwrite a content line at the end.
		const contentRows = rows > 1 && lines.length > rows ? rows - 1 : rows;
		this.#previewWidthLast = bodyWidth;
		this.#previewLayoutDirty = false;
		this.#previewRowsLast = Math.max(1, contentRows);
		const maxScroll = Math.max(0, lines.length - contentRows);
		this.#previewMaxScroll = maxScroll;
		const start = Math.min(this.#previewScroll, maxScroll);
		this.#previewScroll = start;
		const window = lines.slice(start, start + contentRows);
		if (contentRows < rows) {
			window.push(
				start + contentRows < lines.length
					? theme.fg("dim", t("overlaysModel.advisorConfig.more", { count: lines.length - contentRows - start }))
					: theme.fg("dim", t("overlaysModel.advisorConfig.end")),
			);
		}
		return window;
	}

	#previewContent(bodyWidth: number): string[] {
		// The fullscreen overlay hides the host's chat-mounted warning toasts, so
		// the active file's load problems are pinned at the top of the preview
		// until a successful save rewrites the file without them.
		const warnings = this.#doc.warnings?.length
			? [
					theme.fg("warning", t("overlaysModel.advisorConfig.droppedHeader")),
					...sanitizeDisplayWarnings(this.#doc.warnings).flatMap(warning =>
						wrap(warning, bodyWidth).map(line => theme.fg("warning", line)),
					),
					"",
				].map(line => truncateToWidth(line, bodyWidth))
			: [];
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		if (value === "effective") {
			return [
				...warnings,
				theme.bold(t("overlaysModel.advisorConfig.effectiveRosterHeading")),
				"",
				...this.#effectiveRoster.flatMap(advisor => wrap(this.#effectiveAdvisorLabel(advisor), bodyWidth)),
				"",
				...wrap(t("overlaysModel.advisorConfig.overviewHint"), bodyWidth),
			].map(line => truncateToWidth(line, bodyWidth));
		}
		const match = /^advisor:(\d+)$/.exec(value);
		if (match) {
			const advisor = this.#doc.advisors[Number(match[1])];
			if (advisor) return [...warnings, ...this.#advisorPreview(advisor, bodyWidth)];
		}
		if (value === "shared") {
			const lines = [...warnings, theme.bold(t("overlaysModel.advisorConfig.sharedInstructions")), ""];
			const text = this.#doc.instructions?.trim();
			lines.push(...(text ? wrap(text, bodyWidth) : [theme.fg("muted", t("overlaysModel.advisorConfig.none"))]));
			return lines.map(line => truncateToWidth(line, bodyWidth));
		}
		const help =
			value === "add"
				? t("overlaysModel.advisorConfig.createPreview")
				: value === "save"
					? t("overlaysModel.advisorConfig.savePreview")
					: value === "close"
						? t("overlaysModel.advisorConfig.closePreview")
						: "";
		return [...warnings, ...wrap(help, bodyWidth).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth))];
	}

	#advisorPreview(advisor: AdvisorConfig, bodyWidth: number): string[] {
		const model = advisor.model?.trim() || this.#defaultModelLabel || t("overlaysModel.advisorConfig.roleDefault");
		const tools = formatAdvisorTools(advisor.tools, t("overlaysModel.advisorConfig.noTools"));
		const syncBacklog = this.#syncBacklogLabel(advisor);
		const activationNote = this.#deps.getActivationNote?.(advisor);
		const lines = [
			theme.bold(advisor.name || t("overlaysModel.advisorConfig.unnamed")),
			"",
			`${theme.fg("dim", t("overlaysModel.advisorConfig.enabledColon"))} ${advisor.enabled === false ? t("overlaysModel.advisorConfig.offMarker") : t("overlaysModel.advisorConfig.onMarker")}`,
			...(activationNote ? [activationNote] : []),
			`${theme.fg("dim", t("overlaysModel.advisorConfig.reasoningColon"))} ${advisor.includeThinking === false ? t("overlaysModel.advisorConfig.offMarker") : t("overlaysModel.advisorConfig.onMarker")}`,
			`${theme.fg("dim", t("overlaysModel.advisorConfig.modelColon"))} ${model}`,
			`${theme.fg("dim", t("overlaysModel.advisorConfig.toolsColon"))} ${tools}`,
			`${theme.fg("dim", t("overlaysModel.advisorConfig.reviewColon"))} ${formatReviewCadence(advisor)}`,
			`${theme.fg("dim", t("overlaysModel.advisorConfig.backlogColon"))} ${syncBacklog}`,
			"",
			theme.fg("dim", t("overlaysModel.advisorConfig.instructionsColon")),
		];
		const instr = advisor.instructions?.trim();
		lines.push(...(instr ? wrap(instr, bodyWidth) : [theme.fg("muted", t("overlaysModel.advisorConfig.none"))]));
		// Show live usage stats when available from the session.
		const liveStat = this.#cb.getAdvisorStats?.()?.find(s => s.name === (advisor.name || "default"));
		if (liveStat && (liveStat.status === "running" || liveStat.status === "quota_exhausted")) {
			lines.push("", theme.fg("dim", t("overlaysModel.advisorConfig.usageColon")));
			const spendParts: string[] = [
				t("overlaysModel.advisorConfig.tokensIn", { count: liveStat.tokens.input.toLocaleString() }),
				t("overlaysModel.advisorConfig.tokensOut", { count: liveStat.tokens.output.toLocaleString() }),
			];
			if (liveStat.tokens.cacheRead > 0)
				spendParts.push(
					t("overlaysModel.advisorConfig.tokensCached", { count: liveStat.tokens.cacheRead.toLocaleString() }),
				);
			lines.push(theme.fg("dim", t("overlaysModel.advisorConfig.tokensLine", { tokens: spendParts.join(", ") })));
			if (liveStat.cost > 0)
				lines.push(theme.fg("dim", t("overlaysModel.advisorConfig.costLine", { cost: liveStat.cost.toFixed(4) })));
			if (liveStat.contextWindow > 0) {
				const pct = Math.round((liveStat.contextTokens / liveStat.contextWindow) * 100);
				lines.push(
					theme.fg(
						"dim",
						t("overlaysModel.advisorConfig.contextLine", {
							used: liveStat.contextTokens.toLocaleString(),
							total: liveStat.contextWindow.toLocaleString(),
							percent: pct,
						}),
					),
				);
			}
		}
		const quotaProvider =
			(advisor.model?.includes("/") ? advisor.model.split("/")[0] : null) ?? liveStat?.model?.provider;
		if (this.#cachedReports && quotaProvider) {
			const quota = formatCompactQuota(
				quotaProvider,
				this.#cachedReports,
				Date.now(),
				this.#cb.getQuotaLimitFilter?.(quotaProvider, liveStat?.sessionId),
			);
			if (quota) lines.push(theme.fg("dim", `  ${quota}`));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	// ───────────────────────────── screens ───────────────────────────

	/** `sheet`: how a list screen describes as a picker over the prefs page. */
	#setScreen(screen: Screen, active: Component, footerHint: string, sheet?: SelectPickerOptions): void {
		this.#viewRevision++;
		if (this.#screen === "generating" && screen !== "generating") this.#generationAbort?.abort();
		const context: AdvisorNavigationContext = {
			screen,
			index: this.#detailIndex,
			thinking: screen === "thinking" ? this.#thinking : undefined,
		};
		const changed =
			screen !== this.#navigationContext.screen ||
			context.index !== this.#navigationContext.index ||
			context.thinking?.selector !== this.#navigationContext.thinking?.selector;
		if (!this.#restoringNavigation && this.#active instanceof SelectList)
			this.#listStates.set(this.#pageKey(this.#navigationContext, this.#navigationScope), {
				navigation: this.#active.navigationSnapshot(),
				previewScroll: this.#previewScroll,
				previewFocused: this.#previewFocused,
			});
		const previous =
			changed && !this.#restoringNavigation && !this.#contextOnly
				? (this.#previousNavigationSnapshot ?? this.navigationSnapshot())
				: undefined;
		this.#previousNavigationSnapshot = undefined;
		const saved = this.#listStates.get(this.#pageKey(context, this.#scope));
		if (saved && active instanceof SelectList)
			active.restoreNavigation(
				changed ? saved.navigation : { ...saved.navigation, selectedValue: active.getSelectedItem()?.value },
			);
		this.#screen = screen;
		this.#active = active;
		this.#sheetOptions = sheet;
		const navigation =
			screen === "list"
				? t("overlaysModel.advisorConfig.paneNavigation")
				: screen === "thinking"
					? t("overlaysModel.advisorConfig.effortNavigation")
					: t("overlaysModel.advisorConfig.parentNavigation");
		this.#footerHint =
			active instanceof SelectList
				? t("overlaysModel.advisorConfig.listFooter", { footer: footerHint, navigation })
				: footerHint;
		if (this.#cb.openConfigFile && (screen === "list" || screen === "detail"))
			this.#footerHint += t("overlaysModel.advisorConfig.editConfigSuffix");
		this.#previewScroll = saved?.previewScroll ?? 0;
		this.#previewFocused = screen === "list" && saved?.previewFocused === true;
		this.#previewLayoutDirty = true;
		this.#navigationContext = context;
		this.#navigationScope = this.#scope;
		this.#keys.reset();
		if (previous !== undefined)
			this.onNavigationVisit?.(
				screen === "list"
					? ""
					: `${screen}:${context.index}${context.thinking ? `:${context.thinking.selector}` : ""}`,
				previous,
			);
		this.#cb.requestRender();
	}

	#pageKey(context: AdvisorNavigationContext, scope: AdvisorConfigScope): string {
		return `${scope}:${context.screen}:${context.index}:${context.thinking?.selector ?? ""}`;
	}

	#ensureRosterVisible(): void {
		if (this.#doc.advisors.length === 0) this.#doc.advisors.push({ id: crypto.randomUUID(), name: "default" });
	}

	#hasSyntheticDefaultAdvisor(doc: WatchdogConfigDoc): boolean {
		if (doc.advisors.length !== 1) return false;
		const advisor = doc.advisors[0];
		return (
			advisor?.name === "default" &&
			!advisor.model?.trim() &&
			advisor.tools === undefined &&
			advisor.reviewMode === undefined &&
			advisor.reviewInterval === undefined &&
			advisor.syncBacklog === undefined &&
			!advisor.instructions?.trim() &&
			advisor.systemPrompt === undefined &&
			advisor.enabled !== false &&
			advisor.includeThinking === undefined &&
			advisor.maxNotesPerUpdate === undefined &&
			advisor.scope === undefined
		);
	}

	#advisorSummary(advisor: AdvisorConfig): string {
		const model = advisor.model?.trim() || this.#defaultModelLabel || t("overlaysModel.advisorConfig.roleDefault");
		const tools = formatAdvisorTools(advisor.tools, t("overlaysModel.advisorConfig.noTools"));
		return t("overlaysModel.advisorConfig.advisorSummary", {
			model,
			tools,
			mode: advisor.reviewMode ?? "turn",
			interval: advisor.reviewInterval ?? 1,
		});
	}

	/** The advisor's explicit catch-up override, else the inherited global policy. */
	#syncBacklogLabel(advisor: AdvisorConfig): string {
		return (
			advisor.syncBacklog ??
			t("overlaysModel.advisorConfig.inheritedBacklog", { policy: this.#deps.syncBacklog ?? "off" })
		);
	}

	#effectiveAdvisorLabel(advisor: EffectiveAdvisorConfig): string {
		return `${sanitizeDisplayLine(advisor.name)} · ${advisor.enabled === false ? t("overlaysModel.advisorConfig.stateDisabled") : t("overlaysModel.advisorConfig.stateEnabled")} · ${advisor.scope} · ${sanitizeDisplayLine(shortenPath(advisor.sourceFile))}`;
	}

	#showList(selectedValue?: string): void {
		this.#detailIndex = -1;
		this.#ensureRosterVisible();
		const items: SelectItem[] = this.#doc.advisors.map((advisor, index) => ({
			value: `advisor:${index}`,
			label: `${advisor.enabled === false ? "○" : "●"} ${advisor.name || t("overlaysModel.advisorConfig.unnamed")}`,
			description: this.#deps.getActivationNote?.(advisor) ?? this.#advisorSummary(advisor),
		}));
		if (this.#effectiveRoster.length > 0) {
			items.unshift({
				value: "effective",
				label: t("overlaysModel.advisorConfig.effectiveRoster"),
				description: t("overlaysModel.advisorConfig.effectiveRosterDescription", {
					count: this.#effectiveRoster.length,
				}),
			});
		}
		items.push({ value: "add", label: t("overlaysModel.advisorConfig.addAdvisorPlus") });
		if (this.#cb.generateAdvisor && this.#cb.getSources)
			items.push({ value: "generate", label: t("overlaysModel.advisorConfig.generateExisting") });
		items.push({
			value: "shared",
			label: t("overlaysModel.advisorConfig.sharedInstructions"),
			description: previewLineOrNone(this.#doc.instructions),
		});
		items.push({ value: "save", label: t("overlaysModel.advisorConfig.saveApply") });
		items.push({ value: "close", label: t("overlaysModel.advisorConfig.close") });

		// Show every row (no internal overflow-search); the split frame supplies height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedValue) list.setSelectedIndex(items.findIndex(item => item.value === selectedValue));
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#previewLayoutDirty = true;
			this.#cb.requestRender();
		};
		// Row selections (Enter, click, Space on an action row) return to the top
		// as they always have; key shortcuts keep the cursor where it was.
		const runSelect = (value: string, keepSelection = false) =>
			void this.#onListSelect(value, keepSelection ? list.getSelectedItem()?.value : undefined).catch(err => {
				this.#cb.notify(
					t("overlaysModel.advisorConfig.error", { error: err instanceof Error ? err.message : String(err) }),
				);
			});
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			if (matchesKey(data, "space")) {
				// Space toggles an advisor row; on any action row it is Enter, so
				// the whole list can be driven without switching keys.
				const value = list.getSelectedItem()?.value;
				if (!value) return;
				const match = /^advisor:(\d+)$/.exec(value);
				const advisor = match ? this.#doc.advisors[Number(match[1])] : undefined;
				if (!advisor) {
					runSelect(value);
					return;
				}
				advisor.enabled = advisor.enabled === false ? undefined : false;
				this.#dirty = true;
				this.#showList(value);
				return;
			}
			if (matchesKey(data, "s")) {
				runSelect("saveOnly", true);
				return;
			}
			if (matchesKey(data, "a")) {
				runSelect("apply", true);
				return;
			}
			handleInput(data);
		};
		list.onSelect = item => runSelect(item.value);
		list.onCancel = () => this.#cb.close();
		this.#setScreen(
			"list",
			list,
			t("overlaysModel.advisorConfig.rosterFooter", {
				move: editorKeys("tui.select.up", "tui.select.down"),
				confirm: editorKey("tui.select.confirm"),
				cancel: editorKey("tui.select.cancel"),
			}),
		);
	}

	async #onListSelect(value: string, selectedValue?: string): Promise<void> {
		if (value === "add") {
			this.#doc.advisors.push({ id: crypto.randomUUID(), name: `Advisor ${this.#doc.advisors.length + 1}` });
			this.#dirty = true;
			this.#showDetail(this.#doc.advisors.length - 1);
			return;
		}
		if (value === "generate") {
			await this.#showGenerationBases();
			return;
		}
		if (value === "shared") {
			this.#showInstructionsEditor(-1);
			return;
		}
		if (value === "saveOnly") {
			await this.#saveDoc();
			this.#showList(selectedValue);
			return;
		}
		if (value === "apply" || value === "save") {
			// The "Save & apply" row always saves; `a` saves only unsaved edits.
			if (value === "save" || this.#dirty) await this.#saveDoc();
			if (!this.#pendingApply) {
				this.#cb.notify(t("overlaysModel.advisorConfig.nothingToApply"));
				this.#showList(selectedValue);
				return;
			}
			this.#pendingOperations++;
			try {
				await this.#cb.apply();
			} finally {
				this.#pendingOperations--;
			}
			this.#pendingApply = false;
			this.#showList(selectedValue);
			return;
		}
		if (value === "close") {
			this.#cb.close();
			return;
		}
		const match = /^advisor:(\d+)$/.exec(value);
		if (match) this.#showDetail(Number(match[1]));
	}

	async #openConfigFile(): Promise<void> {
		if (!this.#cb.openConfigFile || this.#pendingOperations > 0) return;
		if (this.#dirty) {
			this.#cb.notify(t("overlaysModel.advisorConfig.saveBeforeEditing"));
			return;
		}
		const scope = this.#scope;
		const screen = this.#screen;
		const index = this.#detailIndex;
		const selectedValue = this.#active instanceof SelectList ? this.#active.getSelectedItem()?.value : undefined;
		const revision = ++this.#scopeLoadRevision;
		this.#pendingOperations++;
		try {
			await this.#cb.openConfigFile(scope);
			const doc = await this.#cb.loadDoc(scope);
			const roster = await this.#cb.getEffectiveRoster?.();
			if (revision !== this.#scopeLoadRevision) return;
			this.#doc = doc;
			this.#scope = scope;
			if (roster) this.#effectiveRoster = roster;
			this.#pendingApply = true;
			if (doc.warnings?.length) {
				const message = `WATCHDOG.yml: ${sanitizeDisplayWarnings(doc.warnings).join("; ")}`;
				if (this.#cb.warn) this.#cb.warn(message);
				else this.#cb.notify(message);
			}
			if (screen === "detail") this.#showDetail(index, selectedValue);
			else this.#showList(selectedValue);
		} finally {
			this.#pendingOperations--;
			this.#cb.requestRender();
		}
	}

	/** Write the current scope's doc to disk without touching the live advisors. */
	async #saveDoc(): Promise<void> {
		const syntheticAdvisors = this.#hasSyntheticDefaultAdvisor(this.#doc) ? this.#doc.advisors : undefined;
		if (syntheticAdvisors) this.#doc.advisors = [];
		this.#pendingOperations++;
		try {
			await this.#cb.save(this.#scope, this.#doc);
			if (this.#cb.getEffectiveRoster) this.#effectiveRoster = await this.#cb.getEffectiveRoster();
			// The saved file contains only the normalized entries, so the load-time
			// warnings no longer apply to it.
			this.#doc.warnings = undefined;
			this.#dirty = false;
			this.#pendingApply = true;
		} finally {
			if (syntheticAdvisors) this.#doc.advisors = syntheticAdvisors;
			this.#pendingOperations--;
		}
	}

	#showDetail(index: number, selectedField?: string): void {
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		this.#detailIndex = index;
		const modelDescription =
			advisor.model?.trim() || this.#defaultModelLabel || t("overlaysModel.advisorConfig.roleDefault");
		const toolsDescription = formatAdvisorTools(advisor.tools, t("overlaysModel.advisorConfig.noTools"));
		const reviewMode = advisor.reviewMode ?? "turn";
		const reviewInterval = advisor.reviewInterval ?? 1;
		const items: SelectItem[] = [
			{ value: "name", label: t("overlaysModel.advisorConfig.name"), description: advisor.name },
			{
				value: "toggleEnabled",
				label: t("overlaysModel.advisorConfig.enabled"),
				description:
					this.#deps.getActivationNote?.(advisor) ??
					(advisor.enabled === false
						? t("overlaysModel.advisorConfig.offMarker")
						: t("overlaysModel.advisorConfig.onMarker")),
			},
			{
				value: "toggleIncludeThinking",
				label: t("overlaysModel.advisorConfig.readReasoning"),
				description:
					advisor.includeThinking === false
						? t("overlaysModel.advisorConfig.offMarker")
						: t("overlaysModel.advisorConfig.onMarker"),
			},
			{ value: "model", label: t("overlaysModel.advisorConfig.model"), description: modelDescription },
			{ value: "reviewMode", label: t("overlaysModel.advisorConfig.reviewMode"), description: reviewMode },
			{
				value: "reviewInterval",
				label: t("overlaysModel.advisorConfig.reviewInterval"),
				description: String(reviewInterval),
			},
			{
				value: "syncBacklog",
				label: t("overlaysModel.advisorConfig.syncBacklog"),
				description: this.#syncBacklogLabel(advisor),
			},
		];
		if (this.#cb.editActivationSet)
			items.push({
				value: "activationSet",
				label: t("overlaysModel.advisorConfig.roleSet"),
				description: this.#deps.getActivationNote?.(advisor) ?? t("overlaysModel.advisorConfig.editMembership"),
			});
		if (advisor.model?.trim()) {
			items.push({ value: "resetModel", label: t("overlaysModel.advisorConfig.resetModel") });
		}
		items.push(
			{ value: "tools", label: t("overlaysModel.advisorConfig.tools"), description: toolsDescription },
			{
				value: "instructions",
				label: t("overlaysModel.advisorConfig.instructions"),
				description: previewLineOrNone(advisor.instructions),
			},
			{
				value: "systemPrompt",
				label: t("overlaysModel.advisorConfig.systemPrompt"),
				description:
					advisor.systemPrompt === undefined
						? t("overlaysModel.advisorConfig.bundledDefault")
						: previewLineOrNone(advisor.systemPrompt),
			},
			{
				value: "duplicate",
				label: t("overlaysModel.advisorConfig.duplicateAdvisor"),
				description: t("overlaysModel.advisorConfig.duplicateDescription"),
			},
			...(this.#cb.copyAdvisor && this.#cb.getSources
				? [{ value: "copy", label: t("overlaysModel.advisorConfig.copyToScopeMenu") }]
				: []),
			...(this.#cb.copyPrompt
				? [{ value: "copyPrompt", label: t("overlaysModel.advisorConfig.copyFullPrompt") }]
				: []),
			{ value: "back", label: t("overlaysModel.advisorConfig.back") },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedField) list.setSelectedIndex(items.findIndex(item => item.value === selectedField));
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			if (matchesKey(data, "backspace") && list.getSelectedItem()?.value === "systemPrompt") {
				if (advisor.systemPrompt !== undefined) {
					delete advisor.systemPrompt;
					this.#dirty = true;
					this.#showDetail(index, "systemPrompt");
				}
				return;
			}
			handleInput(data);
		};
		list.onSelect = item => this.#onDetailSelect(index, item.value);
		list.onCancel = () => this.#showList();
		this.#setScreen(
			"detail",
			list,
			t("overlaysModel.advisorConfig.detailsFooter", {
				name: advisor.name,
				confirm: editorKey("tui.select.confirm"),
				cancel: editorKey("tui.select.cancel"),
			}),
		);
	}

	#cloneAdvisor(index: number): void {
		const advisor = cloneAdvisorConfig(this.#doc.advisors[index], this.#doc.advisors);
		this.#previousNavigationSnapshot = this.navigationSnapshot();
		this.#doc.advisors.splice(index + 1, 0, advisor);
		this.#dirty = true;
		this.#showDetail(index + 1);
	}

	#showDeleteConfirmation(index: number): void {
		const advisor = this.#doc.advisors[index];
		if (!advisor) return;
		const fromList = this.#screen === "list";
		const cancel = () => (fromList ? this.#showList(`advisor:${index}`) : this.#showDetail(index));
		const file = this.#deps.filePath ?? this.#deps.configFiles?.[this.#scope] ?? `${this.#scope} WATCHDOG.yml`;
		const title = t("overlaysModel.advisorConfig.deleteTitle", { name: sanitizeDisplayLine(advisor.name) });
		const subtitle = t("overlaysModel.advisorConfig.deleteSubtitle", {
			file: sanitizeDisplayLine(shortenPath(file)),
		});
		const list = new SelectList(
			[
				{
					value: "cancel",
					label: t("overlaysModel.advisorConfig.cancel"),
					description: t("overlaysModel.advisorConfig.keepAdvisor"),
				},
				{
					value: "confirm",
					label: t("overlaysModel.advisorConfig.deleteAdvisor"),
					description: `${advisor.name} · ${file}`,
				},
			],
			2,
			getSelectListTheme(),
			{ search: "never", activateOnSpace: false },
		);
		list.onCancel = cancel;
		list.onSelect = item => {
			if (item.value !== "confirm") return cancel();
			this.#previousNavigationSnapshot = this.navigationSnapshot();
			this.#doc.advisors.splice(index, 1);
			this.#dirty = true;
			this.#showList();
		};
		this.#detailIndex = index;
		this.#setScreen("delete-confirm", list, t("overlaysModel.advisorConfig.deleteFooter", { title, subtitle }), {
			title,
			subtitle,
		});
		list.setSelectedIndex(0);
	}

	#onDetailSelect(index: number, field: string): void {
		// Editors opened straight from the prefs page edit this advisor too.
		this.#detailIndex = index;
		switch (field) {
			case "activationSet":
				void this.#cb.editActivationSet?.().catch(error => this.#cb.notify(String(error)));
				return;
			case "duplicate":
				this.#cloneAdvisor(index);
				return;
			case "copy":
				void this.#showCopyTargets(index).catch(error => this.#cb.notify(String(error)));
				return;
			case "copyPrompt": {
				const advisor = this.#doc.advisors[index];
				const prompt = [
					advisor.systemPrompt ?? this.#deps.getDefaultSystemPrompt(advisor, this.#doc),
					this.#doc.instructions,
					advisor.instructions,
				]
					.filter(Boolean)
					.join("\n\n");
				void Promise.resolve(this.#cb.copyPrompt?.(prompt)).then(
					() => this.#cb.notify(t("overlaysModel.advisorConfig.copiedPrompt", { name: advisor.name })),
					error => this.#cb.notify(t("overlaysModel.advisorConfig.copyPromptError", { error: String(error) })),
				);
				return;
			}
			case "toggleEnabled": {
				const a = this.#doc.advisors[index];
				a.enabled = a.enabled === false ? undefined : false;
				this.#dirty = true;
				this.#showDetail(index);
				return;
			}
			case "toggleIncludeThinking": {
				const advisor = this.#doc.advisors[index];
				advisor.includeThinking = advisor.includeThinking === false ? true : false;
				this.#dirty = true;
				this.#showDetail(index, "toggleIncludeThinking");
				return;
			}
			case "name":
				this.#showNameEditor(index);
				return;
			case "model":
				this.#showModelPicker(index);
				return;
			case "reviewMode":
				this.#showReviewModePicker(index);
				return;
			case "reviewInterval":
				this.#showReviewIntervalEditor(index);
				return;
			case "syncBacklog":
				this.#showSyncBacklogPicker(index);
				return;
			case "tools":
				this.#showToolsEditor(index, new Set(this.#doc.advisors[index].tools ?? this.#deps.defaultToolNames), 0);
				return;
			case "resetModel":
				this.#doc.advisors[index].model = undefined;
				this.#dirty = true;
				this.#showDetail(index);
				return;
			case "instructions":
				this.#showInstructionsEditor(index);
				return;
			case "systemPrompt":
				this.#showSystemPromptEditor(index);
				return;
			default:
				this.#showList();
		}
	}

	async #showCopyTargets(index: number): Promise<void> {
		const revision = this.#viewRevision;
		const sources = await this.#cb.getSources?.();
		if (!sources || revision !== this.#viewRevision) return;
		const items: SelectItem[] = sources
			.filter(source => source.path !== this.#deps.filePath)
			.map(source => ({
				value: source.path,
				label: source.scope,
				description: shortenPath(source.path),
			}));
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		list.onSelect = item => {
			const copyRevision = this.#viewRevision;
			const advisor = this.#doc.advisors[index];
			void this.#cb.copyAdvisor?.(advisor, item.value).then(
				() => {
					this.#pendingApply = true;
					this.#cb.notify(
						t("overlaysModel.advisorConfig.copiedAdvisor", { name: advisor.name, file: shortenPath(item.value) }),
					);
					if (copyRevision === this.#viewRevision) this.#showDetail(index);
				},
				error => this.#cb.notify(t("overlaysModel.advisorConfig.copyAdvisorError", { error: String(error) })),
			);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen("copy-target", list, t("overlaysModel.advisorConfig.copyHint"));
	}

	async #showGenerationBases(): Promise<void> {
		const revision = this.#viewRevision;
		const sources = await this.#cb.getSources?.();
		if (!sources || revision !== this.#viewRevision) return;
		const bases = sources.flatMap(source =>
			(source.path === this.#deps.filePath ? this.#doc : source.doc).advisors.map(config => ({
				path: source.path,
				config,
			})),
		);
		const selected = new Set<number>();
		const show = (cursor = 0): void => {
			const items: SelectItem[] = bases.map((base, index) => ({
				value: String(index),
				label: `${selected.has(index) ? "[x]" : "[ ]"} ${base.config.name}`,
				description: shortenPath(base.path),
			}));
			items.push({ value: "generate", label: t("overlaysModel.advisorConfig.generateSelected") });
			const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
			list.setSelectedIndex(cursor);
			list.onSelect = item => {
				if (item.value === "generate") {
					if (!selected.size) {
						this.#cb.notify(t("overlaysModel.advisorConfig.chooseAtLeastOne"));
						return;
					}
					this.#showGenerationComment([...selected].map(index => bases[index].config));
					return;
				}
				const index = Number(item.value);
				if (selected.has(index)) selected.delete(index);
				else selected.add(index);
				show(index);
			};
			list.onCancel = () => this.#showList("generate");
			this.#setScreen("generate-bases", list, t("overlaysModel.advisorConfig.generateBasesHint"));
		};
		show();
	}

	#showGenerationComment(bases: readonly AdvisorConfig[]): void {
		const editor = new HookEditorComponent(
			this.#tui,
			t("overlaysModel.advisorConfig.describeNewAdvisor"),
			"",
			comment => this.#generateAdvisor(bases, comment),
			() => this.#showList("generate"),
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("generate-comment", editor, "");
	}

	#generateAdvisor(bases: readonly AdvisorConfig[], comment: string): void {
		this.#generationAbort?.abort();
		const abort = new AbortController();
		this.#generationAbort = abort;
		const cancel = new SelectList(
			[{ value: "cancel", label: t("overlaysModel.advisorConfig.generating") }],
			1,
			getSelectListTheme(),
		);
		cancel.onCancel = cancel.onSelect = () => {
			abort.abort();
			this.#showList("generate");
		};
		this.#setScreen("generating", cancel, `${interruptKey()} cancel`);
		void this.#cb.generateAdvisor?.(bases, comment, abort.signal).then(
			advisor => {
				if (abort.signal.aborted) return;
				advisor.id = crypto.randomUUID();
				const baseName = advisor.name;
				for (
					let suffix = 2;
					this.#doc.advisors.some(entry => slugifyAdvisorName(entry.name) === slugifyAdvisorName(advisor.name));
					suffix++
				)
					advisor.name = `${baseName} ${suffix}`;
				this.#doc.advisors.push(advisor);
				this.#dirty = true;
				this.#showDetail(this.#doc.advisors.length - 1);
			},
			error => {
				if (abort.signal.aborted) return;
				this.#cb.notify(t("overlaysModel.advisorConfig.generateError", { error: String(error) }));
				this.#showList("generate");
			},
		);
	}
	#showNameEditor(index: number): void {
		this.#detailIndex = index;
		const input = new Input();
		input.setValue(this.#doc.advisors[index].name);
		input.onSubmit = value => {
			const name = value.trim();
			if (name) {
				this.#doc.advisors[index].name = name;
				this.#dirty = true;
			}
			this.#showDetail(index);
		};
		input.onEscape = () => this.#showDetail(index);
		this.#setScreen(
			"name",
			input,
			t("overlaysModel.advisorConfig.nameFooter", {
				submit: editorKey("tui.input.submit"),
				cancel: editorKey("tui.select.cancel"),
			}),
		);
	}

	#showModelPicker(index: number): void {
		this.#detailIndex = index;
		const mruOrder = this.#deps.browserSource.mruOrder;
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
		} else {
			try {
				models = this.#deps.getAvailableModels();
			} catch {
				models = [];
			}
		}
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder });
		// The configured model, whatever thinking suffix it carries, is the picker's current row.
		const model = this.#doc.advisors[index]?.model?.trim();
		const current = model
			? items.find(item => model === item.selector || model.startsWith(`${item.selector}:`))?.selector
			: undefined;
		this.#modelItems = items;
		this.#modelCurrent = current;

		const picker = new ModelBrowser(this.#deps.browserSource, {});
		picker.setMruOrder(mruOrder);
		picker.setPerfStats(this.#deps.browserSource.modelPerf);
		picker.setItems(items);
		if (current) picker.selectSelector(current);
		picker.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			if (efforts.length === 0) {
				this.#doc.advisors[index].model = item.selector;
				this.#dirty = true;
				this.#showDetail(index);
			} else {
				this.#showThinkingPicker(index, item.selector, efforts);
			}
		};
		picker.onCancel = () => this.#showDetail(index);
		this.#setScreen(
			"model",
			picker,
			t("overlaysModel.advisorConfig.modelFooter", {
				enter: formatKeyHint("enter"),
				cancel: editorKey("tui.select.cancel"),
			}),
		);
	}

	#showThinkingPicker(index: number, selector: string, efforts: readonly string[]): void {
		this.#detailIndex = index;
		this.#thinking = { selector, efforts: [...efforts] };
		const items: SelectItem[] = [{ value: "", label: t("overlaysModel.advisorConfig.defaultThinking") }];
		for (const effort of efforts) items.push({ value: effort, label: effort });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		// The level the advisor already runs this model at, when it is this model.
		const model = this.#doc.advisors[index]?.model?.trim();
		const current =
			model === selector ? "" : model?.startsWith(`${selector}:`) ? model.slice(selector.length + 1) : undefined;
		if (current !== undefined) list.setSelectedValue(current);
		list.onSelect = item => {
			// Values are supported efforts or the empty model-default choice.
			this.#doc.advisors[index].model = item.value ? `${selector}:${item.value}` : selector;
			this.#dirty = true;
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showModelPicker(index);
		this.#setScreen(
			"thinking",
			list,
			t("overlaysModel.advisorConfig.thinkingFooter", {
				model: selector,
				confirm: editorKey("tui.select.confirm"),
				cancel: editorKey("tui.select.cancel"),
			}),
			{
				title: t("overlaysModel.advisorConfig.thinkingLevel"),
				subtitle: t("overlaysModel.advisorConfig.thinkingSubtitle", {
					name: this.#doc.advisors[index]?.name || t("overlaysModel.advisorConfig.theAdvisor"),
					model: selector,
				}),
				icon: "thinking",
				noun: t("overlaysModel.advisorConfig.levelsNoun"),
				current: current === undefined ? [] : [current],
				confirm: t("overlaysModel.advisorConfig.useLevel"),
				decorate: item => {
					if (!item.value)
						return {
							label: t("overlaysModel.advisorConfig.modelDefault"),
							detail: t("overlaysModel.advisorConfig.providerDecides"),
						};
					const level = parseThinkingLevel(item.value);
					const dot = `thinking${item.value.charAt(0).toUpperCase()}${item.value.slice(1)}`;
					return {
						detail: level ? getThinkingLevelMetadata(level).description : undefined,
						chips: [{ text: "", dot }],
					};
				},
			},
		);
	}
	#showReviewModePicker(index: number): void {
		this.#detailIndex = index;
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		const current = advisor.reviewMode ?? ADVISOR_REVIEW_MODES[0];
		const items: SelectItem[] = ADVISOR_REVIEW_MODES.map(mode => ({
			value: mode,
			label: mode === current ? `${mode} (current)` : mode,
			description:
				mode === "turn"
					? t("overlaysModel.advisorConfig.reviewEachTurn")
					: t("overlaysModel.advisorConfig.reviewAtEnd"),
		}));
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		list.setSelectedIndex(ADVISOR_REVIEW_MODES.indexOf(current));
		list.onSelect = item => {
			advisor.reviewMode = item.value === "turn" ? undefined : "agent-end";
			this.#dirty = true;
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen(
			"review-mode",
			list,
			t("overlaysModel.advisorConfig.reviewModeFooter", {
				confirm: editorKey("tui.select.confirm"),
				cancel: editorKey("tui.select.cancel"),
			}),
			{
				title: t("overlaysModel.advisorConfig.reviewMode"),
				subtitle: t("overlaysModel.advisorConfig.reviewModeSubtitle", {
					name: advisor.name || t("overlaysModel.advisorConfig.theAdvisor"),
				}),
				icon: "review",
				noun: t("overlaysModel.advisorConfig.modesNoun"),
				current: [current],
				decorate: item => ({ label: item.value }),
			},
		);
	}

	#showReviewIntervalEditor(index: number): void {
		this.#detailIndex = index;
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		const input = new Input();
		input.setValue(String(advisor.reviewInterval ?? 1));
		input.onSubmit = value => {
			const interval = Number(value.trim());
			if (!Number.isSafeInteger(interval) || interval < 1) {
				this.#cb.notify(t("overlaysModel.advisorConfig.invalidInterval"));
				return;
			}
			advisor.reviewInterval = interval === 1 ? undefined : interval;
			this.#dirty = true;
			this.#showDetail(index);
		};
		input.onEscape = () => this.#showDetail(index);
		this.#setScreen(
			"review-interval",
			input,
			t("overlaysModel.advisorConfig.intervalFooter", {
				submit: editorKey("tui.input.submit"),
				cancel: editorKey("tui.select.cancel"),
			}),
		);
	}

	#showSyncBacklogPicker(index: number): void {
		this.#detailIndex = index;
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		const global = this.#deps.syncBacklog ?? "off";
		const current = advisor.syncBacklog;
		const items: SelectItem[] = [
			{
				value: SYNC_BACKLOG_INHERIT,
				label:
					current === undefined
						? t("overlaysModel.advisorConfig.inheritCurrent")
						: t("overlaysModel.advisorConfig.inherit"),
				description: t("overlaysModel.advisorConfig.globalBacklog", { policy: global }),
			},
			...ADVISOR_SYNC_BACKLOG_MODES.map(mode => ({
				value: mode,
				label: mode === current ? t("overlaysModel.advisorConfig.currentMode", { mode }) : mode,
				description: describeSyncBacklogMode(mode),
			})),
		];
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		list.setSelectedIndex(current === undefined ? 0 : ADVISOR_SYNC_BACKLOG_MODES.indexOf(current) + 1);
		list.onSelect = item => {
			// The inherit sentinel matches no mode, so `find` yields undefined — the override clears.
			advisor.syncBacklog = ADVISOR_SYNC_BACKLOG_MODES.find(mode => mode === item.value);
			this.#dirty = true;
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen(
			"sync-backlog",
			list,
			t("overlaysModel.advisorConfig.backlogFooter", {
				confirm: editorKey("tui.select.confirm"),
				cancel: editorKey("tui.select.cancel"),
			}),
			{
				title: t("overlaysModel.advisorConfig.syncBacklog"),
				subtitle: t("overlaysModel.advisorConfig.backlogSubtitle", {
					name: advisor.name || t("overlaysModel.advisorConfig.theAdvisor"),
				}),
				icon: "time",
				noun: t("overlaysModel.advisorConfig.policiesNoun"),
				current: [current ?? SYNC_BACKLOG_INHERIT],
				decorate: item => ({ label: item.value }),
			},
		);
	}

	#showToolsEditor(index: number, selected: Set<string>, cursor: number): void {
		this.#detailIndex = index;
		this.#tools = selected;
		const all = this.#availableToolNames;
		const items: SelectItem[] = all.map(name => ({
			value: name,
			label: `${selected.has(name) ? "[x]" : "[ ]"} ${name}`,
		}));
		items.push({ value: TOOLS_DONE, label: t("overlaysModel.advisorConfig.done") });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		list.setSelectedIndex(cursor);
		list.onSelectionChange = () => this.#cb.requestRender();
		list.onSelect = item => {
			if (item.value === TOOLS_DONE) {
				this.#doc.advisors[index].tools = commitTools(selected, all, this.#deps.defaultToolNames);
				this.#dirty = true;
				this.#showDetail(index);
				return;
			}
			if (selected.has(item.value)) selected.delete(item.value);
			else selected.add(item.value);
			this.#showToolsEditor(
				index,
				selected,
				items.findIndex(candidate => candidate.value === item.value),
			);
		};
		list.onCancel = () => {
			this.#doc.advisors[index].tools = commitTools(selected, all, this.#deps.defaultToolNames);
			this.#dirty = true;
			this.#showDetail(index);
		};
		this.#setScreen(
			"tools",
			list,
			t("overlaysModel.advisorConfig.toolsFooter", {
				confirm: editorKey("tui.select.confirm"),
				cancel: editorKey("tui.select.cancel"),
			}),
			{
				title: t("overlaysModel.advisorConfig.tools"),
				subtitle: t("overlaysModel.advisorConfig.toolsSubtitle", {
					name: this.#doc.advisors[index]?.name || t("overlaysModel.advisorConfig.theAdvisor"),
				}),
				icon: "tools",
				noun: t("overlaysModel.advisorConfig.toolsNoun"),
				current: [...selected],
				decorate: item => ({ label: item.value }),
			},
		);
	}

	#showSystemPromptEditor(index: number): void {
		this.#detailIndex = index;
		const advisor = this.#doc.advisors[index];
		const editor = new HookEditorComponent(
			this.#tui,
			t("overlaysModel.advisorConfig.systemPromptTitle", { name: advisor.name }),
			advisor.systemPrompt ?? this.#deps.getDefaultSystemPrompt(advisor, this.#doc),
			value => {
				advisor.systemPrompt = value;
				this.#dirty = true;
				this.#showDetail(index, "systemPrompt");
			},
			() => this.#showDetail(index, "systemPrompt"),
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("systemPrompt", editor, "");
	}

	/** `index === -1` edits the shared top-level instructions; otherwise advisor[index]. */
	#showInstructionsEditor(index: number): void {
		const shared = index < 0;
		this.#detailIndex = index;
		const current = shared ? this.#doc.instructions : this.#doc.advisors[index].instructions;
		const title = shared
			? t("overlaysModel.advisorConfig.sharedEditorTitle")
			: t("overlaysModel.advisorConfig.instructionsTitle", { name: this.#doc.advisors[index].name });
		const editor = new HookEditorComponent(
			this.#tui,
			title,
			current,
			value => {
				const text = value.trim() ? value : undefined;
				if (shared) this.#doc.instructions = text;
				else this.#doc.advisors[index].instructions = text;
				this.#dirty = true;
				if (shared) this.#showList();
				else this.#showDetail(index);
			},
			() => {
				if (shared) this.#showList();
				else this.#showDetail(index);
			},
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("instructions", editor, "");
	}

	dispose(): void {
		this.#viewRevision++;
		this.#generationAbort?.abort();
		this.#scopeLoadRevision++;
		this.#active.dispose?.();
	}
	leaveMenu(): void {
		this.#viewRevision++;
		this.#generationAbort?.abort();
		this.#keys.reset();
	}

	/** Rebuild labels after a nested role editor, preserving this file's unsaved draft. */
	refreshActivationNotes(pendingApply = false): void {
		if (pendingApply) this.#pendingApply = true;
		const selected = this.#active instanceof SelectList ? this.#active.getSelectedItem()?.value : undefined;
		if (this.#screen === "detail") this.#showDetail(this.#detailIndex, selected);
		else if (this.#screen === "list") this.#showList(selected);
		this.#cb.requestRender();
	}

	get blocksMenuHistory(): boolean {
		return (
			this.#pendingOperations > 0 ||
			(isMenuHistoryParticipant(this.#active) && this.#active.blocksMenuHistory === true)
		);
	}

	navigationSnapshot(): AdvisorNavigationSnapshot {
		return {
			context: {
				...structuredClone(this.#navigationContext),
				tools: this.#screen === "tools" && this.#tools ? [...this.#tools] : undefined,
			},
			scope: this.#scope,
			doc: structuredClone(this.#doc),
			docOwner: this.#doc,
			dirty: this.#dirty,
			pendingApply: this.#pendingApply,
			previewScroll: this.#previewScroll,
			previewFocused: this.#previewFocused,
			lists: structuredClone([...this.#listStates]),
			content:
				this.#active instanceof Input
					? { value: this.#active.getValue(), cursor: this.#active.getCursor() }
					: isMenuHistoryParticipant(this.#active)
						? this.#active.navigationSnapshot()
						: undefined,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object") return;
		const state = snapshot as AdvisorNavigationSnapshot;
		if (
			!state.context ||
			!state.doc ||
			!state.docOwner ||
			!["project", "project-omp", "user", "session"].includes(state.scope)
		)
			return;
		this.#restoringNavigation = true;
		this.#scopeLoadRevision++;
		this.#keys.reset();
		try {
			this.#scope = state.scope;
			this.#navigationScope = state.scope;
			const draft = structuredClone(state.doc);
			this.#doc = state.docOwner;
			for (const key of Object.keys(this.#doc))
				if (!Object.hasOwn(draft, key)) Reflect.deleteProperty(this.#doc, key);
			Object.assign(this.#doc, draft);
			this.#dirty = state.dirty;
			this.#pendingApply = state.pendingApply;
			this.#detailIndex = state.context.index;
			this.#thinking = state.context.thinking;
			this.#listStates.clear();
			for (const [key, value] of state.lists) this.#listStates.set(key, structuredClone(value));
			switch (state.context.screen) {
				case "list":
					this.#showList();
					break;
				case "detail":
					this.#showDetail(state.context.index);
					break;
				case "delete-confirm":
					this.#showDeleteConfirmation(state.context.index);
					break;
				case "name":
					this.#showNameEditor(state.context.index);
					break;
				case "model":
					this.#showModelPicker(state.context.index);
					break;
				case "thinking":
					if (state.context.thinking)
						this.#showThinkingPicker(
							state.context.index,
							state.context.thinking.selector,
							state.context.thinking.efforts,
						);
					else this.#showModelPicker(state.context.index);
					break;
				case "review-mode":
					this.#showReviewModePicker(state.context.index);
					break;
				case "review-interval":
					this.#showReviewIntervalEditor(state.context.index);
					break;
				case "sync-backlog":
					this.#showSyncBacklogPicker(state.context.index);
					break;
				case "tools":
					this.#showToolsEditor(state.context.index, new Set(state.context.tools ?? []), 0);
					break;
				case "instructions":
					this.#showInstructionsEditor(state.context.index);
					break;
				case "systemPrompt":
					this.#showSystemPromptEditor(state.context.index);
					break;
				case "copy-target":
					this.#showDetail(state.context.index);
					break;
				case "generate-bases":
				case "generate-comment":
				case "generating":
					this.#showList("generate");
					break;
			}
			if (this.#active instanceof Input && state.content && typeof state.content === "object") {
				const input = state.content as { value?: string; cursor?: number };
				if (typeof input.value === "string") this.#active.setValue(input.value);
				if (typeof input.cursor === "number") this.#active.setCursor(input.cursor);
			} else if (this.#screen !== "delete-confirm" && isMenuHistoryParticipant(this.#active))
				this.#active.restoreNavigation(state.content);
			this.#previewScroll = state.previewScroll;
			this.#previewFocused = state.previewFocused;
		} finally {
			this.#restoringNavigation = false;
		}
		this.#cb.requestRender();
	}
}
