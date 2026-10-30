/**
 * Fullscreen `/chain configure` overlay: a mouse- and keyboard-driven editor
 * for the `CHAINS.yml` post-processing chains at project or user level.
 *
 * It mirrors {@link ./advisor-config} one level deeper: the list screen is a
 * two-pane split (clickable chain sidebar on the left, a preview of the
 * highlighted chain's description and ordered steps on the right), a chain
 * detail screen edits the chain's name, description, step order, and which steps
 * are on (Space), and a step detail screen edits one step's name, model, tools,
 * transcript context, system prompt, and prompt.
 *
 * Every screen is backed by a proven primitive — {@link SelectList} (list /
 * chain / step / tools / thinking), {@link Input} (names and description),
 * {@link ModelBrowser} (the same rich `/model` picker, in direct-select mode),
 * and {@link HookEditorComponent} (multiline prompt; Ctrl+G opens `$EDITOR`).
 * The overlay edits an in-memory {@link ChainsConfigDoc} and only touches disk +
 * the live chains through the host `save` callback.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type Component,
	extractPrintableText,
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
import { sanitizeDisplayWarnings } from "../render/render-utils";
import { HookEditorComponent } from "./hook-editor";
import { buildBrowserItems, ModelBrowser, type ModelBrowserSource, sortModelItems } from "./model-browser";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import type { ChainConfig, ChainConfigScope, ChainsConfigDoc, ChainStep } from "./chain-types";
import { MenuKeyReader, isMenuHistoryParticipant, type MenuNavAction } from "../components/menu-navigation";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import type { SelectListNavigationState } from "../components/select-list";

/** Host callbacks: all disk + live-runtime effects flow through these. */
export interface ChainConfigCallbacks {
	/** Load a scope's `CHAINS.yml` into an editable doc (empty when absent). */
	loadDoc: (scope: ChainConfigScope) => Promise<ChainsConfigDoc>;
	/** Persist the doc to the scope's file and refresh the live chains. */
	save: (scope: ChainConfigScope, doc: ChainsConfigDoc) => Promise<void>;
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
}

export interface ChainConfigDeps {
	getAvailableModels: () => Model[];
	browserSource: ModelBrowserSource;
	externalEditor?: (text: string) => Promise<string | null>;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	availableToolNames: string[];
	/** Formatted @prose role model, shown for steps with no model (e.g. "github-copilot/grok-4.7"). */
	defaultModelLabel?: string;
	/** Bundled default shown when a step has no system-prompt override. */
	defaultSystemPrompt: string;
}

const PREVIEW_WIDTH = 60;

function previewLineOrNone(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Omitted or empty grants no tools, so an empty selection stores `undefined`. */
function commitTools(selected: ReadonlySet<string>, all: readonly string[]): string[] | undefined {
	if (selected.size === 0) return undefined;
	return all.filter(name => selected.has(name));
}

function formatStepTools(tools: readonly string[] | undefined): string {
	return tools && tools.length > 0 ? tools.join(", ") : "no tools";
}

/** Steps that run; `enabled: false` keeps a step in the chain without running it. */
function enabledStepCount(chain: ChainConfig): number {
	return chain.steps.filter(step => step.enabled !== false).length;
}

/** Soft-wrap plain text to `width`, returning at least one (possibly empty) line. */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

type Screen =
	| "list"
	| "chain"
	| "chainName"
	| "description"
	| "step"
	| "stepName"
	| "model"
	| "thinking"
	| "tools"
	| "prompt"
	| "systemPrompt";

interface ChainNavigationContext {
	screen: Screen;
	chainIndex?: number;
	stepIndex?: number;
	thinking?: { selector: string; efforts: readonly string[] };
	tools?: readonly string[];
}

interface ChainListState {
	navigation: SelectListNavigationState;
	previewScroll: number;
	previewFocused: boolean;
}

interface ChainNavigationSnapshot {
	context: ChainNavigationContext;
	scope: ChainConfigScope;
	doc: ChainsConfigDoc;
	dirty: boolean;
	previewScroll: number;
	previewFocused: boolean;
	lists: [string, ChainListState][];
	content: unknown;
}

/**
 * Fullscreen chain-configuration overlay. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
export class ChainConfigOverlayComponent implements Component {
	#tui: TUI;
	#deps: ChainConfigDeps;
	#scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#availableToolNames: readonly string[];
	#defaultModelLabel: string | undefined;
	#cb: ChainConfigCallbacks;
	#scope: ChainConfigScope;
	#doc: ChainsConfigDoc;
	#dirty = false;
	/** Chain row awaiting a second Delete/Backspace before it is removed. */
	#pendingDeleteChain: number | null = null;

	#screen: Screen = "list";
	/** The interactive element for the current screen. */
	#active: Component = new SelectList([], 1, getSelectListTheme(), { search: "always" });
	#footerHint = "";
	#previewScroll = 0;
	#previewFocused = false;
	#previewRowsLast = 1;
	#previewWidthLast = 1;
	#previewLayoutDirty = true;
	#previewMaxScroll = 0;
	#previousNavigationSnapshot: ChainNavigationSnapshot | undefined;
	readonly #keys = new MenuKeyReader();
	readonly #help = new MenuHelp();
	#chainIndex: number | undefined;
	#stepIndex: number | undefined;
	#thinking: ChainNavigationContext["thinking"];
	#tools: readonly string[] | undefined;
	#navigationContext: ChainNavigationContext = { screen: "list" };
	#restoringNavigation = false;
	#pendingOperations = 0;
	readonly #listStates = new Map<string, ChainListState>();
	#navigationScope: ChainConfigScope = "project";
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;

	// Persistent frame: top, growing two-pane body, divider, footer, bottom.
	// The frame paints from screen row 0, so SGR `event.row`/`event.col` —
	// already 0-based — index directly into the stack. The list screen splits
	// (sidebar + preview); every other screen forces the narrow left pane.
	#bodyRowsLast = 3;
	#renderActivePane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRowsLast));
		if (this.#active instanceof SelectList) this.#active.setMaxVisible(Math.max(1, rows - 1));
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
			{ content: this.#frameFooter },
			{ content: this.#frameBottom, height: 1 },
		],
	});

	constructor(
		tui: TUI,
		deps: ChainConfigDeps,
		initialScope: ChainConfigScope,
		initialDoc: ChainsConfigDoc,
		callbacks: ChainConfigCallbacks,
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#scopedModels = deps.scopedModels;
		this.#availableToolNames = deps.availableToolNames;
		this.#defaultModelLabel = deps.defaultModelLabel;
		this.#cb = callbacks;
		this.#scope = initialScope;
		this.#doc = initialDoc;
		this.#showList();
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const editing = this.#active instanceof Input || this.#active instanceof HookEditorComponent;
		const hints = menuHintLines(
			`${this.#footerHint}${editing ? "" : " · / filter · ? help"}`,
			Math.max(1, width - 4),
			editing ? "" : undefined,
		);
		const bodyRows = Math.max(3, height - 3 - hints.length);
		this.#bodyRowsLast = bodyRows;
		const title = `Chain configuration · ${this.#scope}${this.#dirty ? "  ● unsaved" : ""}${this.#screen === "list" && this.#previewFocused ? " · Preview" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([isSplit ? topBorderSplit(width, title, leftWidth) : topBorder(width, title)]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		this.#frameFooter.setLines(hints.map(line => row(theme.fg("dim", line), width)));
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(bodyRows + 3 + hints.length);
		return this.#help.render(this.#frame.render(width), width);
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#keys.reset();
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		let active = this.#active;
		if (
			active instanceof Input ||
			active instanceof HookEditorComponent ||
			("filterFocused" in active && active.filterFocused === true)
		) {
			this.#keys.reset();
			const printable = active instanceof Input ? extractPrintableText(data) : undefined;
			if (active instanceof Input && printable !== undefined) active.insertText(printable);
			else active.handleInput?.(data);
			return;
		}
		if (this.#help.handleInput(data)) {
			this.#keys.reset();
			this.#cb.requestRender();
			return;
		}
		let cancelledDelete = false;
		if (
			this.#screen === "list" &&
			this.#pendingDeleteChain !== null &&
			!matchesKey(data, "delete") &&
			!matchesKey(data, "backspace")
		) {
			const selected = active instanceof SelectList ? active.getSelectedItem()?.value : undefined;
			this.#pendingDeleteChain = null;
			this.#showList(selected);
			active = this.#active;
			cancelledDelete = true;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (cancelledDelete && action?.kind === "cancel") return;
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
			} else if (active instanceof SelectList) {
				const item = active.getSelectedItem();
				const navigable =
					item &&
					((this.#screen === "chain" &&
						(/^step:/.test(item.value) || ["name", "description"].includes(item.value))) ||
						(this.#screen === "step" &&
							["name", "model", "tools", "systemPrompt", "prompt"].includes(item.value)));
				if (navigable && item) active.onSelect?.(item);
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
			const value = active.getSelectedItem()?.value ?? "";
			if (["delete", "resetModel"].includes(value) || (this.#screen === "list" && this.#dirty && value === "close"))
				return;
			if (this.#screen === "chain" && value.startsWith("step:") && this.#chainIndex !== undefined) {
				const step = this.#doc.chains[this.#chainIndex]?.steps[Number(value.slice(5))];
				if (step) {
					// Toggle in the decoded action path without opening the step editor.
					if (step.enabled === false) delete step.enabled;
					else step.enabled = false;
					this.#dirty = true;
					this.#showChain(this.#chainIndex, value);
				}
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

	/** Forward enhanced-paste transports into the multiline prompt editor. */
	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (hit && hit.index === 1) {
			const pane = this.#split.locate(hit.line, hit.col);
			// Pointer focus follows a click or wheel, never passive hover.
			if (pane?.pane === "right") {
				if (event.leftClick || event.wheel !== null) this.#previewFocused = true;
				if (event.wheel !== null) this.#applyPreviewMotion({ kind: "scroll", delta: event.wheel });
				else if (event.leftClick) this.#cb.requestRender();
				return true;
			}
			if (pane?.pane === "left" && isLayoutMouseRoutable(this.#active)) {
				if (event.leftClick || event.wheel !== null) this.#previewFocused = false;
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
					? theme.fg("dim", `  ↓ ${lines.length - contentRows - start} more`)
					: theme.fg("dim", "  (end)"),
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
					theme.fg("warning", "⚠ Config problems — dropped while loading:"),
					...sanitizeDisplayWarnings(this.#doc.warnings).flatMap(warning =>
						wrap(warning, bodyWidth).map(line => theme.fg("warning", line)),
					),
					"",
				].map(line => truncateToWidth(line, bodyWidth))
			: [];
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		const match = /^chain:(\d+)$/.exec(value);
		if (match) {
			const chain = this.#doc.chains[Number(match[1])];
			if (chain) return [...warnings, ...this.#chainPreview(chain, bodyWidth)];
		}
		const help =
			value === "add"
				? "Create a new chain, then add the steps its text passes through, top to bottom."
				: value === "scope"
					? `Switch between the project and user CHAINS.yml. Currently editing the ${this.#scope}-level file.`
					: value === "save"
						? "Write this scope's CHAINS.yml and reload the live chains without a restart."
						: value === "close"
							? "Close the editor. Unsaved changes are discarded."
							: "";
		return [...warnings, ...wrap(help, bodyWidth).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth))];
	}

	#chainPreview(chain: ChainConfig, bodyWidth: number): string[] {
		const lines = [theme.bold(chain.name || "(unnamed)"), ""];
		const description = chain.description?.trim();
		lines.push(...(description ? wrap(description, bodyWidth) : [theme.fg("muted", "(no description)")]));
		const enabled = enabledStepCount(chain);
		const count = enabled === chain.steps.length ? `${enabled}` : `${enabled} of ${chain.steps.length} on`;
		lines.push("", theme.fg("dim", `Steps (${count}):`));
		if (chain.steps.length === 0) {
			lines.push(theme.fg("muted", "  (none — a chain needs at least one step)"));
		}
		for (const [index, step] of chain.steps.entries()) {
			const off = step.enabled === false ? theme.fg("muted", " (off)") : "";
			lines.push(`  ${index + 1}. ${step.name || "(unnamed)"}${off}`);
			lines.push(theme.fg("dim", `     ${this.#stepModelLabel(step)} · ${formatStepTools(step.tools)}`));
			lines.push(theme.fg("muted", `     ${previewLineOrNone(step.prompt)}`));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	// ───────────────────────────── screens ───────────────────────────

	/**
	 * Mount a screen and restore that page's saved list state. An explicit
	 * `selectedValue` (the row the caller is returning to) wins over the saved selection.
	 */
	#setScreen(screen: Screen, active: Component, footerHint: string, selectedValue?: string): void {
		const context: ChainNavigationContext = {
			screen,
			chainIndex: this.#chainIndex,
			stepIndex: this.#stepIndex,
			thinking: screen === "thinking" ? this.#thinking : undefined,
			tools: screen === "tools" ? this.#tools : undefined,
		};
		const changed =
			screen !== this.#navigationContext.screen ||
			context.chainIndex !== this.#navigationContext.chainIndex ||
			context.stepIndex !== this.#navigationContext.stepIndex;
		if (!this.#restoringNavigation && this.#active instanceof SelectList)
			this.#listStates.set(this.#pageKey(this.#navigationContext, this.#navigationScope), {
				navigation: this.#active.navigationSnapshot(),
				previewScroll: this.#previewScroll,
				previewFocused: this.#previewFocused,
			});
		const previous =
			changed && !this.#restoringNavigation
				? (this.#previousNavigationSnapshot ?? this.navigationSnapshot())
				: undefined;
		this.#previousNavigationSnapshot = undefined;
		const savedList = this.#listStates.get(this.#pageKey(context, this.#scope));
		if (savedList && active instanceof SelectList) {
			const selected = !changed
				? active.getSelectedItem()?.value
				: (selectedValue ?? savedList.navigation.selectedValue);
			active.restoreNavigation({ ...savedList.navigation, selectedValue: selected });
		}
		this.#screen = screen;
		this.#active = active;
		const navigationHint =
			screen === "thinking" ? "h/l effort" : screen === "list" ? "h/l, Tab panes" : "h parent / l open";
		this.#footerHint = active instanceof SelectList ? `${navigationHint} · ${footerHint} · / search` : footerHint;
		this.#previewScroll = savedList?.previewScroll ?? 0;
		this.#previewFocused = screen === "list" && savedList?.previewFocused === true;
		this.#previewLayoutDirty = true;
		this.#keys.reset();
		if (changed) this.#pendingDeleteChain = null;
		this.#navigationContext = context;
		this.#navigationScope = this.#scope;
		if (previous !== undefined)
			this.onNavigationVisit?.(
				screen === "list" ? "" : `${screen}:${context.chainIndex ?? "new"}:${context.stepIndex ?? "new"}`,
				previous,
			);
		this.#cb.requestRender();
	}

	#pageKey(context: ChainNavigationContext, scope: ChainConfigScope): string {
		return `${scope}:${context.screen}:${context.chainIndex ?? "new"}:${context.stepIndex ?? "new"}`;
	}

	#otherScope(): ChainConfigScope {
		return this.#scope === "project" ? "user" : "project";
	}

	/** Steps without a model run on the `@prose` role, so show that plus the role's model. */
	#stepModelLabel(step: ChainStep): string {
		const model = step.model?.trim();
		if (model) return model;
		return this.#defaultModelLabel ? `@prose (default · ${this.#defaultModelLabel})` : "@prose (default)";
	}

	#chainSummary(chain: ChainConfig): string {
		const total = chain.steps.length;
		const enabled = enabledStepCount(chain);
		const noun = `step${total === 1 ? "" : "s"}`;
		const count = enabled === total ? `${total} ${noun}` : `${enabled} of ${total} ${noun} on`;
		const description = chain.description?.trim();
		return description ? `${count} · ${previewLineOrNone(description)}` : count;
	}

	/**
	 * A chain with no steps is inert and a step with no prompt is a model call
	 * with no instruction; neither is silently written to disk.
	 */
	#validationError(): string | null {
		for (const chain of this.#doc.chains) {
			const name = chain.name || "(unnamed)";
			if (chain.steps.length === 0) return `Chain "${name}" has no steps — add one before saving.`;
			for (const [index, step] of chain.steps.entries()) {
				if (!step.prompt.trim()) {
					return `Chain "${name}" step ${index + 1} ("${step.name || "(unnamed)"}") has an empty prompt.`;
				}
			}
		}
		return null;
	}

	#showList(selectedValue?: string): void {
		this.#chainIndex = undefined;
		this.#stepIndex = undefined;
		const items: SelectItem[] = this.#doc.chains.map((chain, index) => ({
			value: `chain:${index}`,
			label:
				this.#pendingDeleteChain === index ? `⚠ Delete "${chain.name || "(unnamed)"}"?` : chain.name || "(unnamed)",
			description: this.#pendingDeleteChain === index ? undefined : this.#chainSummary(chain),
		}));
		items.push({ value: "add", label: "+ New chain" });
		items.push({ value: "scope", label: `Scope: ${this.#scope}`, description: `→ ${this.#otherScope()}` });
		items.push({ value: "save", label: "Save & apply" });
		items.push({ value: "close", label: "Close" });

		// The split frame supplies the list's viewport height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedValue) list.setSelectedValue(selectedValue);
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			const selected = list.getSelectedItem()?.value ?? "";
			const match = /^chain:(\d+)$/.exec(selected);
			if (match && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
				this.#onDeleteChain(Number(match[1]));
				return;
			}
			handleInput(data);
		};
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#previewLayoutDirty = true;
			this.#cb.requestRender();
		};
		list.onSelect = item =>
			void this.#onListSelect(item.value).catch(err => {
				this.#cb.notify(`Chain config: ${err instanceof Error ? err.message : String(err)}`);
			});
		list.onCancel = () => this.#cb.close();
		this.#setScreen(
			"list",
			list,
			this.#pendingDeleteChain !== null
				? "Delete again to confirm removal · any other key cancels"
				: "Enter/Space edit · Del×2 removes · Esc close",
			selectedValue,
		);
	}

	#onDeleteChain(index: number): void {
		if (this.#pendingDeleteChain === index) {
			this.#doc.chains.splice(index, 1);
			this.#pendingDeleteChain = null;
			this.#dirty = true;
			this.#showList();
			return;
		}
		this.#pendingDeleteChain = index;
		this.#showList(`chain:${index}`);
	}

	async #onListSelect(value: string): Promise<void> {
		if (value === "add") {
			this.#showNewChainEditor();
			return;
		}
		if (value === "scope") {
			if (this.#dirty) {
				this.#cb.notify('Unsaved changes — "Save & apply" or Close before switching scope.');
				return;
			}
			const next = this.#otherScope();
			this.#pendingOperations++;
			const doc = await this.#cb.loadDoc(next).finally(() => {
				this.#pendingOperations--;
			});
			this.#doc = doc;
			this.#scope = next;
			// Surface malformed entries in the file just made active. The host shows
			// the initial scope's warnings when the overlay opens, so only switches
			// report here — no double-showing the opening file.
			if (doc.warnings?.length) {
				const message = `CHAINS.yml: ${sanitizeDisplayWarnings(doc.warnings).join("; ")}`;
				if (this.#cb.warn) this.#cb.warn(message);
				else this.#cb.notify(message);
			}
			this.#showList();
			return;
		}
		if (value === "save") {
			const problem = this.#validationError();
			if (problem) {
				this.#cb.notify(`Not saved — ${problem}`);
				return;
			}
			this.#pendingOperations++;
			await this.#cb.save(this.#scope, this.#doc).finally(() => {
				this.#pendingOperations--;
			});
			// The saved file contains only the normalized entries, so the load-time
			// warnings no longer apply to it. (On failure the throw skips this.)
			this.#doc.warnings = undefined;
			this.#dirty = false;
			this.#showList();
			return;
		}
		if (value === "close") {
			this.#cb.close();
			return;
		}
		const match = /^chain:(\d+)$/.exec(value);
		if (match) this.#showChain(Number(match[1]));
	}

	#showNewChainEditor(): void {
		this.#chainIndex = undefined;
		this.#stepIndex = undefined;
		const input = new Input();
		input.setValue(`Chain ${this.#doc.chains.length + 1}`);
		input.onSubmit = value => {
			const name = value.trim();
			if (!name) {
				this.#showList();
				return;
			}
			this.#doc.chains.push({ name, steps: [] });
			this.#dirty = true;
			this.#showChain(this.#doc.chains.length - 1);
		};
		input.onEscape = () => this.#showList();
		this.#setScreen("chainName", input, "Name the new chain · Enter create · Esc cancel");
	}

	// ───────────────────────────── chain detail ──────────────────────

	#showChain(index: number, selectedField?: string): void {
		this.#chainIndex = index;
		this.#stepIndex = undefined;
		const chain = this.#doc.chains[index];
		if (!chain) {
			this.#showList();
			return;
		}
		const items: SelectItem[] = [
			{ value: "name", label: "Name", description: chain.name },
			{ value: "description", label: "Description", description: previewLineOrNone(chain.description) },
		];
		for (const [stepIndex, step] of chain.steps.entries()) {
			items.push({
				value: `step:${stepIndex}`,
				label: `${step.enabled === false ? "[ ]" : "[x]"} ${stepIndex + 1}. ${step.name || "(unnamed)"} — ${this.#stepModelLabel(step)}`,
				description: `${formatStepTools(step.tools)} · ${previewLineOrNone(step.prompt)}`,
			});
		}
		items.push(
			{ value: "addStep", label: "+ Add step" },
			{ value: "delete", label: "Delete this chain" },
			{ value: "back", label: "Back" },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedField) {
			const found = items.findIndex(item => item.value === selectedField);
			if (found >= 0) list.setSelectedIndex(found);
		}
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			const selected = list.getSelectedItem()?.value ?? "";
			const stepMatch = /^step:(\d+)$/.exec(selected);
			if (stepMatch) {
				const stepIndex = Number(stepMatch[1]);
				if (matchesKey(data, "alt+up") || data === "[") {
					this.#moveStep(index, stepIndex, -1);
					return;
				}
				if (matchesKey(data, "alt+down") || data === "]") {
					this.#moveStep(index, stepIndex, 1);
					return;
				}
				if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
					chain.steps.splice(stepIndex, 1);
					this.#dirty = true;
					this.#showChain(
						index,
						chain.steps.length > 0 ? `step:${Math.min(stepIndex, chain.steps.length - 1)}` : "addStep",
					);
					return;
				}
			}
			handleInput(data);
		};
		list.onSelect = item => this.#onChainSelect(index, item.value);
		list.onCancel = () => this.#showList(`chain:${index}`);
		this.#setScreen(
			"chain",
			list,
			`Editing "${chain.name}" · Enter / click edit · Space turns a step on/off · Alt+↑↓ or [ ] reorder steps · Delete removes a step · Esc back`,
			selectedField,
		);
	}

	#moveStep(chainIndex: number, stepIndex: number, delta: number): void {
		const chain = this.#doc.chains[chainIndex];
		if (!chain) return;
		const target = stepIndex + delta;
		if (target < 0 || target >= chain.steps.length) return;
		const moved = chain.steps.splice(stepIndex, 1)[0];
		if (!moved) return;
		chain.steps.splice(target, 0, moved);
		this.#dirty = true;
		this.#showChain(chainIndex, `step:${target}`);
	}

	#onChainSelect(index: number, field: string): void {
		const chain = this.#doc.chains[index];
		if (!chain) {
			this.#showList();
			return;
		}
		switch (field) {
			case "name":
				this.#showChainNameEditor(index);
				return;
			case "description":
				this.#showDescriptionEditor(index);
				return;
			case "addStep":
				this.#showNewStepEditor(index);
				return;
			case "delete":
				this.#previousNavigationSnapshot = this.navigationSnapshot();
				this.#doc.chains.splice(index, 1);
				this.#dirty = true;
				this.#showList();
				return;
			case "back":
				this.#showList(`chain:${index}`);
				return;
			default: {
				const match = /^step:(\d+)$/.exec(field);
				if (match) this.#showStep(index, Number(match[1]));
				else this.#showList();
			}
		}
	}

	#showChainNameEditor(index: number): void {
		const chain = this.#doc.chains[index];
		if (!chain) {
			this.#showList();
			return;
		}
		const input = new Input();
		input.setValue(chain.name);
		input.onSubmit = value => {
			const name = value.trim();
			if (name) {
				chain.name = name;
				this.#dirty = true;
			}
			this.#showChain(index, "name");
		};
		input.onEscape = () => this.#showChain(index, "name");
		this.#setScreen("chainName", input, "Type a name · Enter save · Esc cancel");
	}

	#showDescriptionEditor(index: number): void {
		const chain = this.#doc.chains[index];
		if (!chain) {
			this.#showList();
			return;
		}
		const input = new Input();
		input.setValue(chain.description ?? "");
		input.onSubmit = value => {
			const text = value.trim();
			chain.description = text ? text : undefined;
			this.#dirty = true;
			this.#showChain(index, "description");
		};
		input.onEscape = () => this.#showChain(index, "description");
		this.#setScreen("description", input, "Describe this chain · Enter save · Esc cancel");
	}

	#showNewStepEditor(chainIndex: number): void {
		this.#chainIndex = chainIndex;
		this.#stepIndex = undefined;
		const chain = this.#doc.chains[chainIndex];
		if (!chain) {
			this.#showList();
			return;
		}
		const input = new Input();
		input.setValue(`Step ${chain.steps.length + 1}`);
		input.onSubmit = value => {
			const name = value.trim();
			if (!name) {
				this.#showChain(chainIndex, "addStep");
				return;
			}
			chain.steps.push({ name, prompt: "" });
			this.#dirty = true;
			this.#showStep(chainIndex, chain.steps.length - 1);
		};
		input.onEscape = () => this.#showChain(chainIndex, "addStep");
		this.#setScreen("stepName", input, "Name the new step · Enter create · Esc cancel");
	}

	// ───────────────────────────── step detail ───────────────────────

	#step(chainIndex: number, stepIndex: number): ChainStep | undefined {
		return this.#doc.chains[chainIndex]?.steps[stepIndex];
	}

	#showStep(chainIndex: number, stepIndex: number, selectedField?: string): void {
		this.#chainIndex = chainIndex;
		this.#stepIndex = stepIndex;
		const step = this.#step(chainIndex, stepIndex);
		if (!step) {
			this.#showChain(chainIndex);
			return;
		}
		const items: SelectItem[] = [
			{ value: "name", label: "Name", description: step.name },
			{ value: "model", label: "Model", description: this.#stepModelLabel(step) },
		];
		if (step.model?.trim()) items.push({ value: "resetModel", label: "Reset model to @prose default" });
		items.push(
			{ value: "tools", label: "Tools", description: formatStepTools(step.tools) },
			{
				value: "context",
				label: "Transcript context",
				description: step.context
					? "on — the step reads the session transcript with the draft"
					: "off — the step sees only the draft",
			},
			{
				value: "systemPrompt",
				label: "System prompt",
				description: step.systemPrompt === undefined ? "(bundled default)" : previewLineOrNone(step.systemPrompt),
			},
			{ value: "prompt", label: "Prompt", description: previewLineOrNone(step.prompt) },
			{ value: "delete", label: "Delete this step" },
			{ value: "back", label: "Back" },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedField) {
			const found = items.findIndex(item => item.value === selectedField);
			if (found >= 0) list.setSelectedIndex(found);
		}
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			if (matchesKey(data, "backspace") && list.getSelectedItem()?.value === "systemPrompt") {
				if (step.systemPrompt !== undefined) {
					delete step.systemPrompt;
					this.#dirty = true;
					this.#showStep(chainIndex, stepIndex, "systemPrompt");
				}
				return;
			}
			handleInput(data);
		};
		list.onSelect = item => this.#onStepSelect(chainIndex, stepIndex, item.value);
		list.onCancel = () => this.#showChain(chainIndex, `step:${stepIndex}`);
		this.#setScreen(
			"step",
			list,
			`Step ${stepIndex + 1} "${step.name}" · Enter / click edit · Esc back to the chain`,
			selectedField,
		);
	}

	#onStepSelect(chainIndex: number, stepIndex: number, field: string): void {
		const step = this.#step(chainIndex, stepIndex);
		if (!step) {
			this.#showChain(chainIndex);
			return;
		}
		switch (field) {
			case "name":
				this.#showStepNameEditor(chainIndex, stepIndex);
				return;
			case "model":
				this.#showModelPicker(chainIndex, stepIndex);
				return;
			case "resetModel":
				step.model = undefined;
				this.#dirty = true;
				this.#showStep(chainIndex, stepIndex, "model");
				return;
			case "tools":
				this.#showToolsEditor(chainIndex, stepIndex, new Set(step.tools ?? []), 0);
				return;
			case "context":
				step.context = step.context ? undefined : true;
				this.#dirty = true;
				this.#showStep(chainIndex, stepIndex, "context");
				return;
			case "systemPrompt":
				this.#showSystemPromptEditor(chainIndex, stepIndex);
				return;
			case "prompt":
				this.#showPromptEditor(chainIndex, stepIndex);
				return;
			case "delete": {
				this.#previousNavigationSnapshot = this.navigationSnapshot();
				const chain = this.#doc.chains[chainIndex];
				chain?.steps.splice(stepIndex, 1);
				this.#dirty = true;
				this.#showChain(chainIndex);
				return;
			}
			default:
				this.#showChain(chainIndex, `step:${stepIndex}`);
		}
	}

	#showStepNameEditor(chainIndex: number, stepIndex: number): void {
		const step = this.#step(chainIndex, stepIndex);
		if (!step) {
			this.#showChain(chainIndex);
			return;
		}
		const input = new Input();
		input.setValue(step.name);
		input.onSubmit = value => {
			const name = value.trim();
			if (name) {
				step.name = name;
				this.#dirty = true;
			}
			this.#showStep(chainIndex, stepIndex, "name");
		};
		input.onEscape = () => this.#showStep(chainIndex, stepIndex, "name");
		this.#setScreen("stepName", input, "Type a name · Enter save · Esc cancel");
	}

	#showModelPicker(chainIndex: number, stepIndex: number): void {
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

		const picker = new ModelBrowser(this.#deps.browserSource, {});
		picker.setMruOrder(mruOrder);
		picker.setPerfStats(this.#deps.browserSource.modelPerf);
		picker.setItems(items);
		picker.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			if (efforts.length === 0) {
				this.#setStepModel(chainIndex, stepIndex, item.selector);
			} else {
				this.#showThinkingPicker(chainIndex, stepIndex, item.selector, efforts);
			}
		};
		picker.onCancel = () => this.#showStep(chainIndex, stepIndex, "model");
		this.#setScreen("model", picker, "/ search · Enter / click twice picks · h / Esc back");
	}

	#setStepModel(chainIndex: number, stepIndex: number, selector: string | undefined): void {
		const step = this.#step(chainIndex, stepIndex);
		if (!step) {
			this.#showChain(chainIndex);
			return;
		}
		step.model = selector;
		this.#dirty = true;
		this.#showStep(chainIndex, stepIndex, "model");
	}

	#showThinkingPicker(chainIndex: number, stepIndex: number, selector: string, efforts: readonly string[]): void {
		this.#thinking = { selector, efforts: [...efforts] };
		const items: SelectItem[] = [{ value: "", label: "(model default thinking)" }];
		for (const effort of efforts) items.push({ value: effort, label: effort });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		list.onSelect = item => {
			// Values are supported efforts or the empty model-default choice.
			this.#setStepModel(chainIndex, stepIndex, item.value ? `${selector}:${item.value}` : selector);
		};
		list.onCancel = () => this.#showModelPicker(chainIndex, stepIndex);
		this.#setScreen("thinking", list, `Thinking effort for ${selector} · Enter / click pick · Esc back`);
	}

	#showToolsEditor(chainIndex: number, stepIndex: number, selected: Set<string>, cursor: number): void {
		this.#tools = [...selected];
		const all = this.#availableToolNames;
		const items: SelectItem[] = all.map(name => ({
			value: name,
			label: `${selected.has(name) ? "[x]" : "[ ]"} ${name}`,
		}));
		items.push({ value: "__done", label: "Done" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		list.setSelectedIndex(cursor);
		list.onSelectionChange = () => this.#cb.requestRender();
		const commit = (): void => {
			const step = this.#step(chainIndex, stepIndex);
			if (step) {
				step.tools = commitTools(selected, all);
				this.#dirty = true;
			}
			this.#showStep(chainIndex, stepIndex, "tools");
		};
		list.onSelect = item => {
			if (item.value === "__done") {
				commit();
				return;
			}
			if (selected.has(item.value)) selected.delete(item.value);
			else selected.add(item.value);
			this.#showToolsEditor(
				chainIndex,
				stepIndex,
				selected,
				items.findIndex(candidate => candidate.value === item.value),
			);
		};
		list.onCancel = commit;
		this.#setScreen("tools", list, "Enter / click toggle · select Done or Esc to apply (empty = no tools)");
	}

	#showPromptEditor(chainIndex: number, stepIndex: number): void {
		const step = this.#step(chainIndex, stepIndex);
		if (!step) {
			this.#showChain(chainIndex);
			return;
		}
		const editor = new HookEditorComponent(
			this.#tui,
			`Prompt — ${step.name}`,
			step.prompt,
			value => {
				step.prompt = value;
				this.#dirty = true;
				this.#showStep(chainIndex, stepIndex, "prompt");
			},
			() => this.#showStep(chainIndex, stepIndex, "prompt"),
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("prompt", editor, "");
	}

	#showSystemPromptEditor(chainIndex: number, stepIndex: number): void {
		const step = this.#step(chainIndex, stepIndex);
		if (!step) {
			this.#showChain(chainIndex);
			return;
		}
		const editor = new HookEditorComponent(
			this.#tui,
			`System prompt — ${step.name}`,
			step.systemPrompt ?? this.#deps.defaultSystemPrompt,
			value => {
				step.systemPrompt = value;
				this.#dirty = true;
				this.#showStep(chainIndex, stepIndex, "systemPrompt");
			},
			() => this.#showStep(chainIndex, stepIndex, "systemPrompt"),
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("systemPrompt", editor, "");
	}

	get blocksMenuHistory(): boolean {
		return (
			this.#pendingOperations > 0 ||
			(isMenuHistoryParticipant(this.#active) && this.#active.blocksMenuHistory === true)
		);
	}

	navigationSnapshot(): ChainNavigationSnapshot {
		return {
			context: structuredClone(this.#navigationContext),
			scope: this.#scope,
			doc: structuredClone(this.#doc),
			dirty: this.#dirty,
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
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as ChainNavigationSnapshot;
		if (!state.context || !state.doc || !Array.isArray(state.doc.chains)) return;
		this.#restoringNavigation = true;
		this.#keys.reset();
		try {
			this.#doc = structuredClone(state.doc);
			this.#listStates.clear();
			for (const [key, value] of state.lists ?? []) this.#listStates.set(key, structuredClone(value));
			this.#scope = state.scope;
			this.#dirty = state.dirty;
			this.#pendingDeleteChain = null;
			this.#chainIndex = state.context.chainIndex;
			this.#stepIndex = state.context.stepIndex;
			this.#thinking = state.context.thinking;
			this.#tools = state.context.tools;
			const chain = state.context.chainIndex;
			const step = state.context.stepIndex;
			if (state.context.screen === "list") this.#showList();
			else if (state.context.screen === "chainName" && chain === undefined) this.#showNewChainEditor();
			else if (chain === undefined || !this.#doc.chains[chain]) this.#showList();
			else if (state.context.screen === "chain") this.#showChain(chain);
			else if (state.context.screen === "chainName") this.#showChainNameEditor(chain);
			else if (state.context.screen === "description") this.#showDescriptionEditor(chain);
			else if (state.context.screen === "stepName" && step === undefined) this.#showNewStepEditor(chain);
			else if (step === undefined || !this.#step(chain, step)) this.#showChain(chain);
			else {
				switch (state.context.screen) {
					case "stepName":
						this.#showStepNameEditor(chain, step);
						break;
					case "model":
						this.#showModelPicker(chain, step);
						break;
					case "thinking":
						if (state.context.thinking)
							this.#showThinkingPicker(
								chain,
								step,
								state.context.thinking.selector,
								state.context.thinking.efforts,
							);
						else this.#showModelPicker(chain, step);
						break;
					case "tools":
						this.#showToolsEditor(chain, step, new Set(state.context.tools), 0);
						break;
					case "prompt":
						this.#showPromptEditor(chain, step);
						break;
					case "systemPrompt":
						this.#showSystemPromptEditor(chain, step);
						break;
					default:
						this.#showStep(chain, step);
				}
			}
			if (this.#active instanceof Input && typeof state.content === "object" && state.content !== null) {
				const field = state.content as { value?: string; cursor?: number };
				if (typeof field.value === "string") this.#active.setValue(field.value);
				if (typeof field.cursor === "number") this.#active.setCursor(field.cursor);
			} else if (isMenuHistoryParticipant(this.#active)) this.#active.restoreNavigation(state.content);
			this.#previewScroll = state.previewScroll;
			this.#previewFocused = state.context.screen === "list" && state.previewFocused === true;
		} finally {
			this.#restoringNavigation = false;
		}
	}

	leaveMenu(): void {
		this.#keys.reset();
		this.#pendingDeleteChain = null;
	}
}
