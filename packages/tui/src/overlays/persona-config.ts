/**
 * Fullscreen `/persona` and `/live-persona` overlay: a mouse- and
 * keyboard-driven editor for named personas, built on the same frame and
 * primitives as {@link ./chain-config} and {@link ./advisor-config}.
 *
 * The list screen is a two-pane split (persona sidebar on the left, the
 * highlighted persona's definition on the right). Space toggles which persona
 * is active, Delete twice removes one, `s` saves and applies. A detail screen
 * edits one persona's fields. The overlay edits an in-memory
 * {@link PersonaConfigDoc}; disk and session effects flow only through the host
 * `save` callback.
 *
 * Two variants share the overlay: `persona` (session system-prompt personas
 * with a mode, inline or file source, and literal) and `live` (instruction
 * sets for the live voice model, including an immutable built-in default).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { buildBrowserItems, ModelBrowser, type ModelBrowserSource } from "./model-browser";
import {
	type Component,
	extractPrintableText,
	Input,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "../index";
import { getSelectListTheme, theme } from "../theme";
import { HookEditorComponent } from "./hook-editor";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import { MenuKeyReader, isMenuHistoryParticipant, type MenuNavAction } from "../components/menu-navigation";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import type { SelectListNavigationState } from "../components/select-list";

export type PersonaConfigVariant = "persona" | "live" | "personality";
export type PersonaConfigMode = "replace" | "prepend" | "append" | "literal-substitute";
export const PERSONA_CONFIG_MODES: readonly PersonaConfigMode[] = [
	"replace",
	"prepend",
	"append",
	"literal-substitute",
];

const MODE_DESCRIPTIONS: Record<PersonaConfigMode, string> = {
	replace: "Replace the whole system prompt",
	prepend: "Insert before the system prompt",
	append: "Insert after the system prompt",
	"literal-substitute": "Replace one literal inside the system prompt",
};

export type PersonaSourceField = {
	key: string;
	label: string;
	description?: string;
	enabledBy?: string;
} & (
	| { kind: "boolean"; value: boolean }
	| {
			kind: "choice";
			value: string;
			options: ReadonlyArray<{ value: string; label: string; description?: string }>;
	  }
);

export interface PersonaConfigEntry {
	name: string;
	/** Name the entry has on disk; undefined for entries created in this overlay. */
	originalName?: string;
	definitionScope?: string;
	/** Immutable bundled entry (the live `default`); may be cloned, never edited. */
	builtin?: boolean;
	/** `persona` variant only. */
	mode: PersonaConfigMode;
	/** `persona` variant only; live personas are always inline. */
	sourceKind: "inline" | "file";
	/** Inline persona text, or the live persona's instructions. */
	content: string;
	/** Path relative to the agent directory for file-backed personas. */
	path: string;
	literal: string;
	inheritToTasks: boolean;
	/** `live` variant only: editable context-ingest controls. */
	sources?: PersonaSourceField[];
	/** Lossless normalized settings carrier; the TUI does not inspect it. */
	sourcesRaw?: unknown;
}

export interface PersonaConfigDoc {
	entries: PersonaConfigEntry[];
	/** Name of the active entry; undefined means none (live: the built-in default). */
	active?: string;
}

export interface PersonaConfigCallbacks {
	apply?: (doc: PersonaConfigDoc) => Promise<string>;
	preview?: (entry: PersonaConfigEntry) => Promise<string>;
	name?: (initial: string) => Promise<string | undefined>;
	scopeLabel?: () => string;
	editingScope?: () => string;
	cycleScope?: () => Promise<PersonaConfigDoc>;
	/**
	 * Persist the doc and apply the active selection. Resolves to a confirmation
	 * shown in the footer; throw to report a failure there instead.
	 */
	save: (doc: PersonaConfigDoc) => Promise<string>;
	close: () => void;
	requestRender: () => void;
}

export interface PersonaGenerationReference {
	id: string;
	label: string;
}

export interface PersonaGenerationRequest {
	model: Model;
	references: string[];
	description: string;
	doc: PersonaConfigDoc;
	signal: AbortSignal;
}

export interface PersonaGenerationDeps {
	getAvailableModels: () => Model[];
	browserSource: ModelBrowserSource;
	references: (doc: PersonaConfigDoc) => Promise<PersonaGenerationReference[]>;
	generate: (request: PersonaGenerationRequest) => Promise<string>;
}

export interface PersonaConfigDeps {
	variant: PersonaConfigVariant;
	externalEditor?: (text: string) => Promise<string | null>;
	/** Instructions a new entry starts from (live: the built-in default). */
	newEntryContent?: string;
	/** `live` variant only: client protocol text appended on operator request. */
	protocolLinesText?: string;
	protocolMarker?: string;
	/** `live` variant only: defaults for a newly created entry. */
	newEntrySources?: () => { fields: PersonaSourceField[]; raw: unknown };
	/** Optional live-persona generation; no generation runs until explicitly submitted. */
	generation?: PersonaGenerationDeps;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREVIEW_WIDTH = 60;

function previewLineOrNone(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = replaceTabs(text.trim().split("\n", 1)[0] ?? "");
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(replaceTabs(text), Math.max(1, width), { trim: false }).split("\n");
}

type Screen =
	| "list"
	| "detail"
	| "sources"
	| "name"
	| "content"
	| "path"
	| "literal"
	| "mode"
	| "generator"
	| "references"
	| "description";

interface PersonaNavigationContext {
	screen: Screen;
	entryIndex?: number;
	creation?: { content: string; from?: string; sourceIndex?: number };
}

interface PersonaListState {
	navigation: SelectListNavigationState;
	previewScroll: number;
	previewFocused: boolean;
}

interface PersonaNavigationSnapshot {
	context: PersonaNavigationContext;
	doc: PersonaConfigDoc;
	dirty: boolean;
	previewScroll: number;
	previewFocused: boolean;
	lists: [string, PersonaListState][];
	content: unknown;
	generation?: { model?: Model; references: PersonaGenerationReference[]; selected: string[]; description: string };
}

export class PersonaConfigOverlayComponent implements Component {
	#tui: TUI;
	#deps: PersonaConfigDeps;
	#cb: PersonaConfigCallbacks;
	#doc: PersonaConfigDoc;
	#dirty = false;
	#saving = false;
	/** First Esc on a dirty list arms close; the second discards. */
	#closeArmed = false;
	/** Entry row awaiting a second Delete/Backspace before it is removed. */
	#pendingDelete: number | null = null;

	#screen: Screen = "list";
	#entryIndex: number | undefined;
	#active: Component = new SelectList([], 1, getSelectListTheme(), { search: "always" });
	#footerHint = "";
	readonly #help = new MenuHelp();
	/** One-shot message (save result, validation error) shown until the next screen change. */
	#footerNote: { text: string; tone: "success" | "warning" } | undefined;
	#previewScroll = 0;
	#previewFocused = false;
	#previewRowsLast = 1;
	#previewWidthLast = 1;
	#previewLayoutDirty = true;
	#previewMaxScroll = 0;
	readonly #listStates = new Map<string, PersonaListState>();
	#previousNavigationSnapshot: PersonaNavigationSnapshot | undefined;
	readonly #keys = new MenuKeyReader();
	#navigationContext: PersonaNavigationContext = { screen: "list" };
	#creation: PersonaNavigationContext["creation"];
	#restoringNavigation = false;
	#yankedPersonality?: PersonaConfigEntry;
	#generationModel: Model | undefined;
	#generationReferences: PersonaGenerationReference[] = [];
	#generationSelected = new Set<string>();
	#generationDescription = "";
	#generationAbort: AbortController | undefined;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;

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

	constructor(tui: TUI, deps: PersonaConfigDeps, doc: PersonaConfigDoc, callbacks: PersonaConfigCallbacks) {
		this.#tui = tui;
		this.#deps = deps;
		this.#cb = callbacks;
		this.#doc = doc;
		this.#showList();
	}

	get #noun(): string {
		return this.#deps.variant === "personality"
			? "personality"
			: this.#deps.variant === "live"
				? "live persona"
				: "persona";
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const active = this.#active;
		const textFocused =
			active instanceof Input ||
			active instanceof HookEditorComponent ||
			("filterFocused" in active && active.filterFocused === true);
		const footerLines = menuHintLines(
			this.#footerNote?.text ?? `${this.#footerHint}${textFocused ? "" : " · ? help"}`,
			Math.max(1, width - 4),
			textFocused ? "" : undefined,
		);
		const bodyRows = Math.max(3, height - 3 - footerLines.length);
		this.#bodyRowsLast = bodyRows;
		const heading =
			this.#deps.variant === "personality"
				? `Personalities · ${this.#cb.scopeLabel?.() ?? "project"} · Ctrl-S scope`
				: this.#deps.variant === "live"
					? "Live personas"
					: "Personas";
		const title = `${heading} · active: ${this.#activeLabel()}${this.#dirty ? "  ● unsaved" : ""}${this.#screen === "list" && this.#previewFocused ? " · Preview" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([
			isSplit && this.#deps.variant !== "personality"
				? topBorderSplit(width, title, leftWidth)
				: topBorder(width, title),
		]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		this.#frameFooter.setLines(footerLines.map(line => row(theme.fg(this.#footerNote?.tone ?? "dim", line), width)));
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(bodyRows + 3 + footerLines.length);
		return this.#help.render(this.#frame.render(width), width);
	}

	#activeLabel(): string {
		if (this.#doc.active) return this.#doc.active;
		return this.#deps.variant === "live" ? "default" : "off";
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (this.#generationAbort) {
			if (matchesKey(data, "escape")) {
				this.#generationAbort.abort();
				this.#generationAbort = undefined;
				if (this.#screen === "generator") this.#showGenerator();
				else this.#showDescription();
			}
			return;
		}
		if (this.#saving) return;
		if (matchesKey(data, "ctrl+s") && this.#cb.cycleScope) {
			if (this.#dirty) {
				this.#flash("Save your changes before switching scope.");
				return;
			}
			this.#saving = true;
			void this.#cb
				.cycleScope()
				.then(doc => {
					this.#doc = doc;
					this.#listStates.clear();
					this.#showList();
				})
				.catch(error => this.#flash(String(error)))
				.finally(() => {
					this.#saving = false;
					this.#cb.requestRender();
				});
			return;
		}
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
			this.#cb.requestRender();
			return;
		}
		let cancelledDelete = false;
		if (
			this.#screen === "list" &&
			this.#pendingDelete !== null &&
			!matchesKey(data, "delete") &&
			!matchesKey(data, "backspace")
		) {
			const selected = active instanceof SelectList ? active.getSelectedItem()?.value : undefined;
			this.#pendingDelete = null;
			this.#showList(selected);
			active = this.#active;
			cancelledDelete = true;
		}
		if (this.#deps.variant === "personality" && this.#screen === "list" && active instanceof SelectList) {
			const match = /^entry:(\d+)$/.exec(active.getSelectedItem()?.value ?? "");
			const index = match ? Number(match[1]) : undefined;
			const entry = index === undefined ? undefined : this.#doc.entries[index];
			if (entry && matchesKey(data, "ctrl+g") && this.#deps.externalEditor) {
				this.#saving = true;
				this.#tui.stop();
				void this.#deps
					.externalEditor(entry.content)
					.then(text => {
						if (text === null || text === entry.content) return;
						if (entry.builtin) this.#showNewEntryEditor(text, entry.name, index);
						else {
							entry.content = text;
							this.#dirty = true;
							this.#showList(`entry:${index}`);
						}
					})
					.catch(error => this.#flash(String(error)))
					.finally(() => {
						this.#saving = false;
						this.#tui.start();
						this.#cb.requestRender();
					});
				return;
			}
			if (matchesKey(data, "s")) {
				this.#save(() =>
					this.#showList(active instanceof SelectList ? active.getSelectedItem()?.value : undefined),
				);
				return;
			}
			if (matchesKey(data, "a") && this.#cb.apply) {
				if (entry) this.#doc.active = entry.name;
				this.#saving = true;
				void this.#cb
					.apply(this.#doc)
					.then(message => {
						this.#dirty = false;
						this.#showList(active instanceof SelectList ? active.getSelectedItem()?.value : undefined);
						this.#flash(message, "success");
					})
					.catch(error => this.#flash(String(error)))
					.finally(() => {
						this.#saving = false;
						this.#cb.requestRender();
					});
				return;
			}
			if (entry && matchesKey(data, "y")) {
				this.#yankedPersonality = { ...entry };
				this.#flash(`Yanked ${entry.name}`, "success");
				return;
			}
			if (matchesKey(data, "p") && this.#yankedPersonality) {
				this.#showNewEntryEditor(this.#yankedPersonality.content, this.#yankedPersonality.name);
				return;
			}
			if (entry && matchesKey(data, "c")) {
				this.#showNewEntryEditor(entry.content, entry.name, index);
				return;
			}
			if (entry && matchesKey(data, "e") && !entry.builtin) {
				this.#showContentEditor(index!);
				return;
			}
			if (entry && matchesKey(data, "v") && this.#cb.preview) {
				this.#saving = true;
				void this.#cb
					.preview(entry)
					.then(text =>
						this.#setScreen(
							"content",
							new HookEditorComponent(
								this.#tui,
								"Full system prompt preview",
								text,
								() => this.#showList(),
								() => this.#showList(),
							),
							"",
						),
					)
					.catch(error => this.#flash(String(error)))
					.finally(() => {
						this.#saving = false;
						this.#cb.requestRender();
					});
				return;
			}
		}
		const action = this.#keys.read(data);
		if (this.#screen === "list" && (action === undefined || action === "pending" || action.kind !== "cancel")) {
			this.#closeArmed = false;
		}
		if (action === "pending") return;
		if (cancelledDelete && action?.kind === "cancel") return;
		if (action?.kind === "horizontal") {
			if (this.#screen === "list") this.#previewFocused = action.delta > 0;
			else if (active instanceof SelectList) {
				if (action.delta < 0) active.onCancel?.();
				else if (this.#screen === "detail") {
					const item = active.getSelectedItem();
					if (item && ["name", "mode", "path", "literal", "content", "view", "sources"].includes(item.value)) {
						active.onSelect?.(item);
					}
				}
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
			const item = active.getSelectedItem();
			if (this.#screen === "references") {
				if (item?.value.startsWith("reference:")) {
					const id = item.value.slice("reference:".length);
					if (this.#generationSelected.has(id)) this.#generationSelected.delete(id);
					else this.#generationSelected.add(id);
					this.#showReferences(item.value);
				}
				return;
			}
			if (item?.value === "delete") return;
			if (this.#screen === "list") {
				const match = /^entry:(\d+)$/.exec(item?.value ?? "");
				const entry = match ? this.#doc.entries[Number(match[1])] : undefined;
				if (entry) {
					this.#toggleActive(entry);
					this.#showList(item?.value);
					return;
				}
			}
		}
		if (action && active instanceof SelectList) active.handleNavigation(action);
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

	pasteText(text: string): void {
		if (this.#saving) return;
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (hit && hit.index === 1) {
			const pane = this.#split.locate(hit.line, hit.col);
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
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		const match = /^entry:(\d+)$/.exec(value);
		const entry = match
			? this.#doc.entries[Number(match[1])]
			: this.#entryIndex === undefined
				? undefined
				: this.#doc.entries[this.#entryIndex];
		if (entry && this.#screen === "sources") {
			const field = entry.sources?.find(item => item.key === value);
			return wrap(field?.description ?? "", bodyWidth).map(line =>
				truncateToWidth(theme.fg("muted", line), bodyWidth),
			);
		}
		if (entry && this.#screen === "detail" && value === "sources") {
			return wrap("Choose which crew activity the voice agent hears about with this persona.", bodyWidth).map(line =>
				truncateToWidth(theme.fg("muted", line), bodyWidth),
			);
		}
		if (entry && this.#screen === "detail" && value === "append-protocol") {
			return (this.#deps.protocolLinesText ?? "")
				.split("\n")
				.slice(0, 12)
				.map(line => truncateToWidth(theme.fg("muted", replaceTabs(line)), bodyWidth));
		}
		if (entry) return this.#entryPreview(entry, bodyWidth);
		const help =
			value === "add"
				? `Create a new ${this.#noun}, then fill in its definition.`
				: value === "save"
					? `Write the ${this.#noun}s and apply the active selection.`
					: value === "close"
						? "Close the editor. Unsaved changes ask for confirmation first."
						: "";
		return wrap(help, bodyWidth).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth));
	}

	#entryPreview(entry: PersonaConfigEntry, bodyWidth: number): string[] {
		const active = this.#isActive(entry);
		const lines = [theme.bold(`${active ? "● " : ""}${entry.name}`), ""];
		if (this.#deps.variant === "persona") {
			lines.push(theme.fg("dim", `Mode: ${entry.mode}`));
			lines.push(theme.fg("dim", `Source: ${entry.sourceKind === "file" ? `file ${entry.path}` : "inline"}`));
			if (entry.mode === "literal-substitute") lines.push(theme.fg("dim", `Literal: ${entry.literal || "(none)"}`));
			lines.push(theme.fg("dim", `Inherit to tasks: ${entry.inheritToTasks ? "yes" : "no"}`), "");
		} else if (entry.builtin) {
			lines.push(
				theme.fg(
					"dim",
					this.#deps.variant === "personality"
						? "Built-in preset · read-only · clone to customize"
						: "Built-in default · read-only · clone to customize",
				),
				"",
			);
		}
		if (this.#deps.variant === "live" || entry.sourceKind === "inline") {
			lines.push(...(entry.content.trim() ? wrap(entry.content, bodyWidth) : [theme.fg("muted", "(empty)")]));
		}
		return lines.map(line => truncateToWidth(replaceTabs(line), bodyWidth));
	}

	// ───────────────────────────── helpers ───────────────────────────

	#setScreen(screen: Screen, active: Component, footerHint: string): void {
		const context: PersonaNavigationContext = { screen, entryIndex: this.#entryIndex, creation: this.#creation };
		const changed =
			screen !== this.#navigationContext.screen || context.entryIndex !== this.#navigationContext.entryIndex;
		if (!this.#restoringNavigation && this.#active instanceof SelectList) {
			this.#listStates.set(this.#pageKey(this.#navigationContext), {
				navigation: this.#active.navigationSnapshot(),
				previewScroll: this.#previewScroll,
				previewFocused: this.#previewFocused,
			});
		}
		const previous =
			changed && !this.#restoringNavigation
				? (this.#previousNavigationSnapshot ?? this.navigationSnapshot())
				: undefined;
		this.#previousNavigationSnapshot = undefined;
		const saved = this.#listStates.get(this.#pageKey(context));
		if (saved && active instanceof SelectList) {
			active.restoreNavigation(
				changed ? saved.navigation : { ...saved.navigation, selectedValue: active.getSelectedItem()?.value },
			);
		}
		this.#screen = screen;
		this.#active = active;
		const navigationHint = screen === "list" ? "Tab panes" : screen === "detail" ? "← parent / → open" : "← parent";
		this.#footerHint = active instanceof SelectList ? `${navigationHint} · ${footerHint} · / search` : footerHint;
		this.#footerNote = undefined;
		this.#previewScroll = saved?.previewScroll ?? 0;
		this.#previewFocused = screen === "list" && saved?.previewFocused === true;
		this.#previewLayoutDirty = true;
		this.#keys.reset();
		if (changed) {
			this.#pendingDelete = null;
			this.#closeArmed = false;
		}
		this.#navigationContext = context;
		if (previous !== undefined)
			this.onNavigationVisit?.(screen === "list" ? "" : `${screen}:${context.entryIndex ?? "new"}`, previous);
		this.#cb.requestRender();
	}

	#pageKey(context: PersonaNavigationContext): string {
		return `${context.screen}:${context.entryIndex ?? "new"}`;
	}

	/**
	 * The fullscreen overlay hides the host's status toasts, so messages land in
	 * the footer until the next screen change.
	 */
	#flash(text: string, tone: "success" | "warning" = "warning"): void {
		this.#footerNote = { text: replaceTabs(text), tone };
		this.#cb.requestRender();
	}

	#isActive(entry: PersonaConfigEntry): boolean {
		if (this.#doc.active === undefined) return this.#deps.variant === "live" && entry.builtin === true;
		return this.#doc.active === entry.name;
	}

	/** Space on an entry: make it active, or deactivate it when it already is. */
	#toggleActive(entry: PersonaConfigEntry): void {
		this.#doc.active =
			this.#deps.variant === "personality"
				? entry.name
				: this.#isActive(entry) || entry.builtin
					? undefined
					: entry.name;
		this.#dirty = true;
	}

	#entrySummary(entry: PersonaConfigEntry): string {
		if (entry.builtin) return "built-in default";
		if (this.#deps.variant === "personality")
			return entry.builtin ? "Built-in preset" : `${entry.definitionScope ?? "new"} · ${entry.content.length} chars`;
		if (this.#deps.variant !== "persona") return `${entry.content.length} chars`;
		return `${entry.mode} · ${entry.sourceKind === "file" ? replaceTabs(entry.path) || "(no path)" : "inline"}`;
	}

	#sourcesSummary(entry: PersonaConfigEntry): string {
		const labels: string[] = [];
		let advisor = false;
		for (const field of entry.sources ?? []) {
			if (field.kind !== "boolean" || !field.value) continue;
			if (field.key.startsWith("advisorNotes.")) advisor = true;
			else labels.push(field.label);
		}
		if (advisor) labels.push("Advisor notes");
		return labels.join(", ") || "none";
	}

	#validationError(): string | null {
		const seen = new Set<string>();
		for (const entry of this.#doc.entries) {
			if (
				!(this.#deps.variant === "personality"
					? entry.name.trim() === entry.name && !!entry.name && !/[\x00-\x1f\x7f]/.test(entry.name)
					: NAME_PATTERN.test(entry.name))
			)
				return `"${entry.name}": names may contain only letters, numbers, '.', '_' or '-'.`;
			if (seen.has(entry.name)) return `Two ${this.#noun}s are named "${entry.name}".`;
			seen.add(entry.name);
			if (entry.builtin) continue;
			if (this.#deps.variant === "live" || entry.sourceKind === "inline") {
				if (!entry.content.trim()) return `"${entry.name}" has empty content.`;
			} else if (!entry.path.trim()) {
				return `"${entry.name}" has no file path.`;
			}
			if (this.#deps.variant === "persona" && entry.mode === "literal-substitute" && !entry.literal)
				return `"${entry.name}" needs a literal to substitute.`;
		}
		return null;
	}

	/** Validate, persist, and apply; then redraw via `reshow` and report the result in the footer. */
	#save(reshow: () => void): void {
		const problem = this.#validationError();
		if (problem) {
			this.#flash(`Not saved — ${problem}`);
			return;
		}
		this.#saving = true;
		this.#flash("Saving — editing is paused until the write completes", "success");
		void this.#cb.save(this.#doc).then(
			message => {
				this.#saving = false;
				for (const entry of this.#doc.entries) if (!entry.builtin) entry.originalName = entry.name;
				this.#dirty = false;
				reshow();
				this.#flash(message, "success");
			},
			err => {
				this.#saving = false;
				this.#flash(`Not saved — ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	}

	// ───────────────────────────── list ──────────────────────────────

	#showList(selectedValue?: string): void {
		this.#entryIndex = undefined;
		this.#creation = undefined;
		const items: SelectItem[] = this.#doc.entries.map((entry, index) => ({
			value: `entry:${index}`,
			label:
				this.#pendingDelete === index
					? `⚠ Delete "${entry.name}"?`
					: `${this.#isActive(entry) ? "●" : "○"} ${entry.name}`,
			description: this.#pendingDelete === index ? undefined : this.#entrySummary(entry),
		}));
		items.push({ value: "add", label: `+ New ${this.#noun}` });
		if (this.#deps.generation) items.push({ value: "generate", label: `Generate ${this.#noun}` });
		items.push({ value: "save", label: this.#cb.apply ? "Save" : "Save & apply" });
		items.push({ value: "close", label: "Close" });

		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedValue)
			list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex(item => item.value === selectedValue),
				),
			);
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			const selected = list.getSelectedItem()?.value ?? "";
			const match = /^entry:(\d+)$/.exec(selected);
			if (match && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
				this.#onDelete(Number(match[1]));
				return;
			}
			if (matchesKey(data, "s")) {
				this.#save(() => this.#showList(selected));
				return;
			}
			handleInput(data);
		};
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#previewLayoutDirty = true;
			this.#cb.requestRender();
		};
		list.onSelect = item => this.#onListSelect(item.value);
		list.onCancel = () => this.#requestClose();
		this.#setScreen(
			"list",
			list,
			this.#pendingDelete !== null
				? "Delete again to confirm removal · any other key cancels"
				: this.#deps.variant === "personality"
					? "Enter details · Space select · a apply · s save · c clone · y/p copy · e edit · Ctrl-G editor · v full prompt · Esc close"
					: "Enter edit · Space active · Del×2 · s save · Esc close",
		);
	}

	#requestClose(): void {
		if (this.#dirty && !this.#closeArmed) {
			this.#closeArmed = true;
			this.#flash("Unsaved changes — press Esc again to discard them, or s to save & apply");
			return;
		}
		this.#cb.close();
	}

	#onDelete(index: number): void {
		const entry = this.#doc.entries[index];
		if (!entry) return;
		if (entry.builtin) {
			this.#flash("Built-in presets cannot be deleted.");
			return;
		}
		if (
			this.#deps.variant === "personality" &&
			entry.definitionScope &&
			entry.definitionScope !== this.#cb.editingScope?.()
		) {
			this.#flash(`Inherited from ${entry.definitionScope}. Switch to that scope to delete it.`);
			return;
		}
		if (this.#pendingDelete === index) {
			this.#doc.entries.splice(index, 1);
			if (this.#doc.active === entry.name) this.#doc.active = undefined;
			this.#pendingDelete = null;
			this.#dirty = true;
			this.#showList();
			return;
		}
		this.#pendingDelete = index;
		this.#showList(`entry:${index}`);
	}

	#onListSelect(value: string): void {
		if (value === "generate") {
			this.#generationSelected.clear();
			this.#generationDescription = "";
			this.#showGenerator();
			return;
		}
		if (value === "add") {
			this.#showNewEntryEditor();
			return;
		}
		if (value === "save") {
			this.#save(() => this.#showList(value));
			return;
		}
		if (value === "close") {
			this.#requestClose();
			return;
		}
		const match = /^entry:(\d+)$/.exec(value);
		if (match) this.#showDetail(Number(match[1]));
	}

	#uniqueName(base: string): string {
		const taken = new Set(this.#doc.entries.map(entry => entry.name));
		if (!taken.has(base)) return base;
		for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
	}

	#showNewEntryEditor(content = this.#deps.newEntryContent ?? "", from?: string, sourceIndex?: number): void {
		if (this.#cb.name) {
			this.#saving = true;
			void this.#cb
				.name(this.#uniqueName(from ? `${from}-copy` : `personality-${this.#doc.entries.length + 1}`))
				.then(name => {
					if (!name) return;
					if (!NAME_PATTERN.test(name) || this.#doc.entries.some(entry => entry.name === name)) {
						this.#flash("Invalid or duplicate name.");
						return;
					}
					this.#doc.entries.push({
						name,
						mode: "replace",
						sourceKind: "inline",
						content,
						path: "",
						literal: "",
						inheritToTasks: false,
					});
					this.#dirty = true;
					this.#showContentEditor(this.#doc.entries.length - 1);
				})
				.catch(error => this.#flash(String(error)))
				.finally(() => {
					this.#saving = false;
					this.#cb.requestRender();
				});
			return;
		}
		this.#entryIndex = undefined;
		this.#creation = { content, from, sourceIndex };
		const sourceEntry = sourceIndex === undefined ? undefined : this.#doc.entries[sourceIndex];
		const fresh = sourceEntry ? undefined : this.#deps.newEntrySources?.();
		const input = new Input();
		input.setValue(this.#uniqueName(from ? `${from}-copy` : `persona-${this.#doc.entries.length + 1}`));
		input.onSubmit = value => {
			const name = value.trim();
			if (!name) {
				this.#showList("add");
				return;
			}
			if (!NAME_PATTERN.test(name) || this.#doc.entries.some(entry => entry.name === name)) {
				this.#flash(`Invalid or duplicate name: ${name}`);
				return;
			}
			this.#doc.entries.push({
				name,
				mode: sourceEntry?.mode ?? "replace",
				sourceKind: sourceEntry?.sourceKind ?? "inline",
				content,
				path: sourceEntry?.path ?? "",
				literal: sourceEntry?.literal ?? "",
				inheritToTasks: sourceEntry?.inheritToTasks ?? false,
				sources: sourceEntry ? structuredClone(sourceEntry.sources) : fresh?.fields,
				sourcesRaw: structuredClone(sourceEntry ? sourceEntry.sourcesRaw : fresh?.raw),
			});
			this.#dirty = true;
			this.#showDetail(this.#doc.entries.length - 1);
		};
		input.onEscape = () => this.#showList("add");
		this.#setScreen("name", input, `Name the new ${this.#noun} · Enter create · Esc cancel`);
	}

	#showGenerator(): void {
		const deps = this.#deps.generation;
		if (!deps) return this.#showList();
		const picker = new ModelBrowser(deps.browserSource, {});
		picker.setItems(buildBrowserItems(deps.getAvailableModels()));
		picker.onActivate = item => {
			this.#generationModel = item.model;
			const controller = new AbortController();
			this.#generationAbort = controller;
			this.#flash("Loading references · Esc cancel", "success");
			void deps
				.references(this.#doc)
				.then(references => {
					if (controller.signal.aborted) return;
					this.#generationAbort = undefined;
					this.#generationReferences = references;
					this.#showReferences();
				})
				.catch(error => {
					if (controller.signal.aborted) return;
					this.#generationAbort = undefined;
					this.#flash(error instanceof Error ? error.message : String(error));
				});
		};
		picker.onCancel = () => this.#showList("generate");
		this.#setScreen("generator", picker, "Select Generator Model · Enter choose · Esc back · / search");
	}

	#showReferences(selectedValue?: string): void {
		const items: SelectItem[] = this.#generationReferences.map(reference => ({
			value: `reference:${reference.id}`,
			label: `${this.#generationSelected.has(reference.id) ? "☑" : "☐"} ${reference.label}`,
		}));
		items.push({ value: "continue", label: "Continue to Describe Persona" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedValue)
			list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex(item => item.value === selectedValue),
				),
			);
		list.onSelect = item => {
			if (item.value !== "continue") {
				const id = item.value.slice("reference:".length);
				if (this.#generationSelected.has(id)) this.#generationSelected.delete(id);
				else this.#generationSelected.add(id);
				this.#showReferences(item.value);
			} else if (this.#generationSelected.size === 0) {
				this.#flash("Select at least one reference, including the default template if desired.");
			} else this.#showDescription();
		};
		list.onCancel = () => this.#showGenerator();
		this.#setScreen("references", list, "Select Reference Models · Space toggle · Enter continue · Esc generator");
	}

	#showDescription(): void {
		const input = new Input();
		input.setValue(this.#generationDescription);
		input.onEscape = () => {
			this.#generationDescription = input.getValue();
			this.#showReferences("continue");
		};
		input.onSubmit = description => {
			this.#generationDescription = description;
			const deps = this.#deps.generation;
			const model = this.#generationModel;
			if (!description.trim()) return this.#flash("Describe the persona to generate.");
			if (!deps || !model) return this.#showGenerator();
			const controller = new AbortController();
			this.#generationAbort = controller;
			this.#flash("Generating persona · Esc cancel", "success");
			void deps
				.generate({
					model,
					references: [...this.#generationSelected],
					description,
					doc: structuredClone(this.#doc),
					signal: controller.signal,
				})
				.then(content => {
					if (controller.signal.aborted) return;
					this.#generationAbort = undefined;
					if (!content.trim()) {
						this.#flash("Generator returned empty instructions.");
						return;
					}
					const fresh = this.#deps.newEntrySources?.();
					this.#doc.entries.push({
						name: this.#uniqueName("generated-persona"),
						mode: "replace",
						sourceKind: "inline",
						content,
						path: "",
						literal: "",
						inheritToTasks: false,
						sources: fresh?.fields,
						sourcesRaw: fresh?.raw,
					});
					this.#dirty = true;
					this.#showDetail(this.#doc.entries.length - 1, "name");
				})
				.catch(error => {
					if (controller.signal.aborted) return;
					this.#generationAbort = undefined;
					this.#flash(error instanceof Error ? error.message : String(error));
				});
		};
		this.#setScreen("description", input, "Describe Persona · Enter generate · Esc references");
	}

	// ───────────────────────────── detail ────────────────────────────

	#showDetail(index: number, selectedField?: string): void {
		const entry = this.#doc.entries[index];
		if (!entry) {
			this.#showList();
			return;
		}
		this.#entryIndex = index;
		this.#creation = undefined;
		const items: SelectItem[] = [];
		if (entry.builtin) {
			items.push(
				{ value: "active", label: "Active", description: this.#isActive(entry) ? "● on" : "○ off" },
				{ value: "view", label: "Instructions", description: "read-only · Enter to view" },
			);
			if (this.#deps.variant === "live") {
				items.push({ value: "sources", label: "Context sources", description: this.#sourcesSummary(entry) });
			}
			items.push({ value: "clone", label: "Clone to customize" }, { value: "back", label: "Back" });
		} else {
			items.push(
				{ value: "name", label: "Name", description: entry.name },
				{ value: "active", label: "Active", description: this.#isActive(entry) ? "● on" : "○ off" },
			);
			if (this.#deps.variant === "persona") {
				items.push(
					{ value: "mode", label: "Mode", description: entry.mode },
					{ value: "source", label: "Source", description: entry.sourceKind },
				);
				if (entry.sourceKind === "file") {
					items.push({ value: "path", label: "File path", description: replaceTabs(entry.path) || "(none)" });
				} else {
					items.push({ value: "content", label: "Content", description: previewLineOrNone(entry.content) });
				}
				if (entry.mode === "literal-substitute") {
					items.push({ value: "literal", label: "Literal", description: replaceTabs(entry.literal) || "(none)" });
				}
				items.push({
					value: "inherit",
					label: "Inherit to tasks",
					description: entry.inheritToTasks ? "● on" : "○ off",
				});
			} else if (this.#deps.variant === "personality") {
				items.push({ value: "content", label: "Instructions", description: previewLineOrNone(entry.content) });
			} else {
				items.push(
					{ value: "content", label: "Instructions", description: previewLineOrNone(entry.content) },
					{ value: "sources", label: "Context sources", description: this.#sourcesSummary(entry) },
					{
						value: "append-protocol",
						label: "Append client protocol lines",
						description: entry.content.includes(this.#deps.protocolMarker ?? "<client-protocol>")
							? "already present"
							: "adds the label and delegation rules as plain text you can edit",
					},
				);
			}
			items.push(
				{ value: "clone", label: "Clone" },
				{ value: "delete", label: `Delete this ${this.#noun}` },
				{ value: "back", label: "Back" },
			);
		}
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedField)
			list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex(item => item.value === selectedField),
				),
			);
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			if (matchesKey(data, "s")) {
				this.#save(() => this.#showDetail(index, list.getSelectedItem()?.value));
				return;
			}
			handleInput(data);
		};
		list.onSelect = item => this.#onDetailSelect(index, item.value);
		list.onCancel = () => this.#showList(`entry:${index}`);
		this.#setScreen(
			"detail",
			list,
			`Editing "${entry.name}" · Enter / click edit · Space toggle · s save & apply · Esc back`,
		);
	}

	#onDetailSelect(index: number, field: string): void {
		const entry = this.#doc.entries[index];
		if (!entry) {
			this.#showList();
			return;
		}
		switch (field) {
			case "name":
				this.#showNameEditor(index);
				return;
			case "active":
				this.#toggleActive(entry);
				this.#showDetail(index, field);
				return;
			case "mode":
				this.#showModePicker(index);
				return;
			case "source":
				entry.sourceKind = entry.sourceKind === "inline" ? "file" : "inline";
				this.#dirty = true;
				this.#showDetail(index, field);
				return;
			case "inherit":
				entry.inheritToTasks = !entry.inheritToTasks;
				this.#dirty = true;
				this.#showDetail(index, field);
				return;
			case "content":
				this.#showContentEditor(index);
				return;
			case "view":
				this.#showContentEditor(index, true);
				return;
			case "sources":
				this.#showSources(index);
				return;
			case "append-protocol": {
				const marker = this.#deps.protocolMarker ?? "<client-protocol>";
				const protocol = this.#deps.protocolLinesText;
				let note: { text: string; tone?: "success" | "warning" };
				if (!protocol) {
					note = { text: "Client protocol lines are unavailable." };
				} else if (entry.content.includes(marker)) {
					note = { text: "Already present" };
				} else {
					entry.content = `${entry.content.trimEnd()}\n\n${protocol.trim()}\n`;
					this.#dirty = true;
					note = { text: "Client protocol lines appended — save to apply", tone: "success" };
				}
				this.#showDetail(index, field);
				this.#flash(note.text, note.tone);
				return;
			}
			case "path":
				this.#showFieldEditor(index, "path", "Path relative to the agent directory");
				return;
			case "literal":
				this.#showFieldEditor(index, "literal", "Literal text in the system prompt to replace");
				return;
			case "clone":
				this.#showNewEntryEditor(entry.content, entry.name, index);
				return;
			case "delete":
				this.#previousNavigationSnapshot = this.navigationSnapshot();
				this.#pendingDelete = null;
				this.#doc.entries.splice(index, 1);
				if (this.#doc.active === entry.name) this.#doc.active = undefined;
				this.#dirty = true;
				this.#showList();
				return;
			default:
				this.#showList(`entry:${index}`);
		}
	}

	#showSources(index: number, selectedKey?: string): void {
		const entry = this.#doc.entries[index];
		if (!entry) return this.#showList();
		const fields = entry.sources ?? [];
		const isEnabled = (field: PersonaSourceField): boolean => {
			if (!field.enabledBy) return true;
			const controller = fields.find(candidate => candidate.key === field.enabledBy);
			return controller?.kind === "boolean" && controller.value;
		};
		const choiceOptions = (field: Extract<PersonaSourceField, { kind: "choice" }>) => {
			if (field.options.some(option => option.value === field.value)) return field.options;
			return [{ value: field.value, label: `Custom (${field.value})` }, ...field.options];
		};
		const items: SelectItem[] = fields.map(field => {
			const enabled = isEnabled(field);
			const controller = field.enabledBy ? fields.find(candidate => candidate.key === field.enabledBy) : undefined;
			const dependency = controller ? `(needs ${controller.label})` : undefined;
			const selectedLabel =
				field.kind === "choice"
					? (choiceOptions(field).find(option => option.value === field.value)?.label ?? field.value)
					: undefined;
			const label =
				field.kind === "boolean" ? `${field.value ? "●" : "○"} ${field.label}` : `${field.label}: ${selectedLabel}`;
			return {
				value: field.key,
				label: enabled ? label : theme.fg("dim", label),
				description: enabled ? undefined : dependency,
			};
		});
		items.push({ value: "back", label: "Back" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selectedKey) {
			list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex(item => item.value === selectedKey),
				),
			);
		}
		const select = (key: string) => {
			if (key === "back") {
				this.#showDetail(index, "sources");
				return;
			}
			const field = fields.find(candidate => candidate.key === key);
			if (!field || !isEnabled(field)) return;
			if (field.kind === "boolean") {
				field.value = !field.value;
			} else {
				const options = choiceOptions(field);
				const current = options.findIndex(option => option.value === field.value);
				field.value = options[(current + 1) % options.length]?.value ?? field.value;
			}
			this.#dirty = true;
			this.#showSources(index, key);
		};
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (list.filterFocused) {
				handleInput(data);
				return;
			}
			if (matchesKey(data, "s")) {
				this.#save(() => this.#showSources(index, list.getSelectedItem()?.value));
				return;
			}
			handleInput(data);
		};
		list.onSelect = item => select(item.value);
		list.onCancel = () => this.#showDetail(index, "sources");
		this.#entryIndex = index;
		this.#setScreen("sources", list, "↑↓ move · Space / Enter toggle or cycle · s save & apply · Esc back");
	}

	#showNameEditor(index: number): void {
		const entry = this.#doc.entries[index];
		if (!entry) return this.#showList();
		const input = new Input();
		input.setValue(entry.name);
		input.onSubmit = value => {
			const name = value.trim();
			if (name && name !== entry.name) {
				if (!NAME_PATTERN.test(name) || this.#doc.entries.some(other => other.name === name)) {
					this.#flash(`Invalid or duplicate name: ${name}`);
					return;
				}
				if (this.#doc.active === entry.name) this.#doc.active = name;
				entry.name = name;
				this.#dirty = true;
			}
			this.#showDetail(index, "name");
		};
		input.onEscape = () => this.#showDetail(index, "name");
		this.#setScreen("name", input, "Type a name · Enter save · Esc cancel");
	}

	#showFieldEditor(index: number, field: "path" | "literal", hint: string): void {
		const entry = this.#doc.entries[index];
		if (!entry) return this.#showList();
		const input = new Input();
		input.setValue(entry[field]);
		input.onSubmit = value => {
			entry[field] = field === "path" ? value.trim() : value;
			this.#dirty = true;
			this.#showDetail(index, field);
		};
		input.onEscape = () => this.#showDetail(index, field);
		this.#setScreen(field, input, `${hint} · Enter save · Esc cancel`);
	}

	#showModePicker(index: number): void {
		const entry = this.#doc.entries[index];
		if (!entry) return this.#showList();
		const items: SelectItem[] = PERSONA_CONFIG_MODES.map(mode => ({
			value: mode,
			label: mode,
			description: MODE_DESCRIPTIONS[mode],
		}));
		const list = new SelectList(items, items.length, getSelectListTheme(), { search: "always" });
		list.setSelectedIndex(Math.max(0, PERSONA_CONFIG_MODES.indexOf(entry.mode)));
		list.onSelect = item => {
			entry.mode = item.value as PersonaConfigMode;
			this.#dirty = true;
			this.#showDetail(index, "mode");
		};
		list.onCancel = () => this.#showDetail(index, "mode");
		this.#setScreen("mode", list, "Enter / click choose · Esc back");
	}

	#showContentEditor(index: number, readOnly = false): void {
		const entry = this.#doc.entries[index];
		if (!entry) return this.#showList();
		const label = this.#deps.variant === "live" ? "Instructions" : "Content";
		const field = readOnly ? "view" : "content";
		const editor = new HookEditorComponent(
			this.#tui,
			readOnly ? `${label} — ${entry.name} (read-only; changes are discarded)` : `${label} — ${entry.name}`,
			entry.content,
			value => {
				if (!readOnly) {
					entry.content = value;
					this.#dirty = true;
				}
				this.#showDetail(index, field);
			},
			() => this.#showDetail(index, field),
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("content", editor, "");
	}

	get blocksMenuHistory(): boolean {
		return (
			this.#saving ||
			this.#generationAbort !== undefined ||
			(isMenuHistoryParticipant(this.#active) && this.#active.blocksMenuHistory === true)
		);
	}

	navigationSnapshot(): PersonaNavigationSnapshot {
		return {
			context: structuredClone(this.#navigationContext),
			doc: structuredClone(this.#doc),
			dirty: this.#dirty,
			previewScroll: this.#previewScroll,
			previewFocused: this.#previewFocused,
			lists: structuredClone([...this.#listStates]),
			generation: {
				model: this.#generationModel,
				references: structuredClone(this.#generationReferences),
				selected: [...this.#generationSelected],
				description: this.#generationDescription,
			},
			content:
				this.#active instanceof Input
					? { value: this.#active.getValue(), cursor: this.#active.getCursor() }
					: isMenuHistoryParticipant(this.#active)
						? this.#active.navigationSnapshot()
						: undefined,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (this.#generationAbort) return;
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as PersonaNavigationSnapshot;
		if (!state.context || !state.doc || !Array.isArray(state.doc.entries)) return;
		this.#restoringNavigation = true;
		this.#keys.reset();
		try {
			this.#doc = structuredClone(state.doc);
			this.#listStates.clear();
			for (const [key, value] of state.lists ?? []) this.#listStates.set(key, structuredClone(value));
			this.#dirty = state.dirty;
			this.#pendingDelete = null;
			this.#closeArmed = false;
			this.#entryIndex = state.context.entryIndex;
			this.#creation = state.context.creation;
			this.#generationModel = state.generation?.model;
			this.#generationReferences = structuredClone(state.generation?.references ?? []);
			this.#generationSelected = new Set(state.generation?.selected);
			this.#generationDescription = state.generation?.description ?? "";
			const index = state.context.entryIndex;
			switch (state.context.screen) {
				case "generator":
					this.#showGenerator();
					break;
				case "references":
					this.#showReferences();
					break;
				case "description":
					this.#showDescription();
					break;
				case "detail":
					if (index !== undefined) this.#showDetail(index);
					else this.#showList();
					break;
				case "sources":
					if (index !== undefined) this.#showSources(index);
					else this.#showList();
					break;
				case "name":
					if (index !== undefined) this.#showNameEditor(index);
					else
						this.#showNewEntryEditor(
							state.context.creation?.content,
							state.context.creation?.from,
							state.context.creation?.sourceIndex,
						);
					break;
				case "mode":
					if (index !== undefined) this.#showModePicker(index);
					else this.#showList();
					break;
				case "path":
				case "literal":
					if (index !== undefined)
						this.#showFieldEditor(
							index,
							state.context.screen,
							state.context.screen === "path"
								? "Path relative to the agent directory"
								: "Literal text in the system prompt to replace",
						);
					else this.#showList();
					break;
				case "content":
					if (index !== undefined) this.#showContentEditor(index, this.#doc.entries[index]?.builtin);
					else this.#showList();
					break;
				default:
					this.#showList();
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
		this.#pendingDelete = null;
		this.#closeArmed = false;
	}
}
