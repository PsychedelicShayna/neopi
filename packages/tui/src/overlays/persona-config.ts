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
import { HookEditorComponent } from "./hook-editor";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";

export type PersonaConfigVariant = "persona" | "live";
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

export interface PersonaConfigEntry {
	name: string;
	/** Name the entry has on disk; undefined for entries created in this overlay. */
	originalName?: string;
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
}

export interface PersonaConfigDoc {
	entries: PersonaConfigEntry[];
	/** Name of the active entry; undefined means none (live: the built-in default). */
	active?: string;
}

export interface PersonaConfigCallbacks {
	/**
	 * Persist the doc and apply the active selection. Resolves to a confirmation
	 * shown in the footer; throw to report a failure there instead.
	 */
	save: (doc: PersonaConfigDoc) => Promise<string>;
	close: () => void;
	requestRender: () => void;
}

export interface PersonaConfigDeps {
	variant: PersonaConfigVariant;
	externalEditor?: (text: string) => Promise<string | null>;
	/** Instructions a new entry starts from (live: the built-in default). */
	newEntryContent?: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREVIEW_WIDTH = 60;

function previewLineOrNone(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

type Screen = "list" | "detail" | "name" | "content" | "path" | "literal" | "mode";

export class PersonaConfigOverlayComponent implements Component {
	#tui: TUI;
	#deps: PersonaConfigDeps;
	#cb: PersonaConfigCallbacks;
	#doc: PersonaConfigDoc;
	#dirty = false;
	/** First Esc on a dirty list arms close; the second discards. */
	#closeArmed = false;
	/** Entry row awaiting a second Delete/Backspace before it is removed. */
	#pendingDelete: number | null = null;

	#screen: Screen = "list";
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footerHint = "";
	/** One-shot message (save result, validation error) shown until the next screen change. */
	#footerNote: { text: string; tone: "success" | "warning" } | undefined;
	#previewScroll = 0;

	#bodyRowsLast = 3;
	#renderActivePane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRowsLast));
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

	constructor(tui: TUI, deps: PersonaConfigDeps, doc: PersonaConfigDoc, callbacks: PersonaConfigCallbacks) {
		this.#tui = tui;
		this.#deps = deps;
		this.#cb = callbacks;
		this.#doc = doc;
		this.#showList();
	}

	get #noun(): string {
		return this.#deps.variant === "live" ? "live persona" : "persona";
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		this.#bodyRowsLast = bodyRows;
		const heading = this.#deps.variant === "live" ? "Live personas" : "Personas";
		const title = `${heading} · active: ${this.#activeLabel()}${this.#dirty ? "  ● unsaved" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([isSplit ? topBorderSplit(width, title, leftWidth) : topBorder(width, title)]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		const footer = this.#footerNote
			? theme.fg(this.#footerNote.tone, this.#footerNote.text)
			: theme.fg("dim", this.#footerHint);
		this.#frameFooter.setLines([row(footer, width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(bodyRows + 4);
		return this.#frame.render(width);
	}

	#activeLabel(): string {
		if (this.#doc.active) return this.#doc.active;
		return this.#deps.variant === "live" ? "default" : "off";
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		this.#active.handleInput?.(data);
	}

	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (hit && hit.index === 1) {
			const pane = this.#split.locate(hit.line, hit.col);
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
		const maxScroll = Math.max(0, lines.length - rows);
		const start = Math.min(this.#previewScroll, maxScroll);
		const window = lines.slice(start, start + rows);
		if (lines.length > rows) {
			window[rows - 1] =
				start + rows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - rows - start} more`)
					: theme.fg("dim", "  (end)");
		}
		return window;
	}

	#previewContent(bodyWidth: number): string[] {
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		const match = /^entry:(\d+)$/.exec(value);
		const entry = match ? this.#doc.entries[Number(match[1])] : undefined;
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
			lines.push(theme.fg("dim", "Built-in default · read-only · clone to customize"), "");
		}
		if (this.#deps.variant === "live" || entry.sourceKind === "inline") {
			lines.push(...(entry.content.trim() ? wrap(entry.content, bodyWidth) : [theme.fg("muted", "(empty)")]));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	// ───────────────────────────── helpers ───────────────────────────

	#setScreen(screen: Screen, active: Component, footerHint: string): void {
		this.#screen = screen;
		this.#active = active;
		this.#footerHint = footerHint;
		this.#footerNote = undefined;
		this.#previewScroll = 0;
		this.#cb.requestRender();
	}

	/**
	 * The fullscreen overlay hides the host's status toasts, so messages land in
	 * the footer until the next screen change.
	 */
	#flash(text: string, tone: "success" | "warning" = "warning"): void {
		this.#footerNote = { text, tone };
		this.#cb.requestRender();
	}

	#isActive(entry: PersonaConfigEntry): boolean {
		if (this.#doc.active === undefined) return this.#deps.variant === "live" && entry.builtin === true;
		return this.#doc.active === entry.name;
	}

	/** Space on an entry: make it active, or deactivate it when it already is. */
	#toggleActive(entry: PersonaConfigEntry): void {
		this.#doc.active = this.#isActive(entry) || entry.builtin ? undefined : entry.name;
		this.#dirty = true;
	}

	#entrySummary(entry: PersonaConfigEntry): string {
		if (entry.builtin) return "built-in default";
		if (this.#deps.variant === "live") return `${entry.content.length} chars`;
		return `${entry.mode} · ${entry.sourceKind === "file" ? entry.path || "(no path)" : "inline"}`;
	}

	#validationError(): string | null {
		const seen = new Set<string>();
		for (const entry of this.#doc.entries) {
			if (!NAME_PATTERN.test(entry.name))
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
		void this.#cb.save(this.#doc).then(
			message => {
				for (const entry of this.#doc.entries) if (!entry.builtin) entry.originalName = entry.name;
				this.#dirty = false;
				reshow();
				this.#flash(message, "success");
			},
			err => this.#flash(`Not saved — ${err instanceof Error ? err.message : String(err)}`),
		);
	}

	// ───────────────────────────── list ──────────────────────────────

	#showList(selectedValue?: string): void {
		const items: SelectItem[] = this.#doc.entries.map((entry, index) => ({
			value: `entry:${index}`,
			label:
				this.#pendingDelete === index
					? `⚠ Delete "${entry.name}"?`
					: `${this.#isActive(entry) ? "●" : "○"} ${entry.name}`,
			description: this.#pendingDelete === index ? undefined : this.#entrySummary(entry),
		}));
		items.push({ value: "add", label: `+ New ${this.#noun}` });
		items.push({ value: "save", label: "Save & apply" });
		items.push({ value: "close", label: "Close" });

		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		if (selectedValue)
			list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex(item => item.value === selectedValue),
				),
			);
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (!matchesKey(data, "escape")) this.#closeArmed = false;
			const selected = list.getSelectedItem()?.value ?? "";
			const match = /^entry:(\d+)$/.exec(selected);
			if (match && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
				this.#onDelete(Number(match[1]));
				return;
			}
			if (this.#pendingDelete !== null) {
				// Any other key abandons the pending removal; Esc only does that.
				this.#pendingDelete = null;
				this.#showList(selected);
				if (!matchesKey(data, "escape")) this.#active.handleInput?.(data);
				return;
			}
			if (matchesKey(data, "space")) {
				const entry = match ? this.#doc.entries[Number(match[1])] : undefined;
				if (!entry) {
					this.#onListSelect(selected);
					return;
				}
				this.#toggleActive(entry);
				this.#showList(selected);
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
			this.#cb.requestRender();
		};
		list.onSelect = item => this.#onListSelect(item.value);
		list.onCancel = () => this.#requestClose();
		this.#setScreen(
			"list",
			list,
			this.#pendingDelete !== null
				? "Delete again to confirm removal · any other key cancels"
				: "↑↓ move · Space activate/deactivate, else select · Enter / click edit · Delete removes · s save & apply · Esc close",
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
			this.#flash("The built-in default cannot be deleted.");
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

	#showNewEntryEditor(content = this.#deps.newEntryContent ?? "", from?: string): void {
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
				mode: "replace",
				sourceKind: "inline",
				content,
				path: "",
				literal: "",
				inheritToTasks: false,
			});
			this.#dirty = true;
			this.#showDetail(this.#doc.entries.length - 1);
		};
		input.onEscape = () => this.#showList("add");
		this.#setScreen("name", input, `Name the new ${this.#noun} · Enter create · Esc cancel`);
	}

	// ───────────────────────────── detail ────────────────────────────

	#showDetail(index: number, selectedField?: string): void {
		const entry = this.#doc.entries[index];
		if (!entry) {
			this.#showList();
			return;
		}
		const items: SelectItem[] = [];
		if (entry.builtin) {
			items.push(
				{ value: "active", label: "Active", description: this.#isActive(entry) ? "● on" : "○ off" },
				{ value: "view", label: "Instructions", description: "read-only · Enter to view" },
				{ value: "clone", label: "Clone to customize" },
				{ value: "back", label: "Back" },
			);
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
					items.push({ value: "path", label: "File path", description: entry.path || "(none)" });
				} else {
					items.push({ value: "content", label: "Content", description: previewLineOrNone(entry.content) });
				}
				if (entry.mode === "literal-substitute") {
					items.push({ value: "literal", label: "Literal", description: entry.literal || "(none)" });
				}
				items.push({
					value: "inherit",
					label: "Inherit to tasks",
					description: entry.inheritToTasks ? "● on" : "○ off",
				});
			} else {
				items.push({ value: "content", label: "Instructions", description: previewLineOrNone(entry.content) });
			}
			items.push(
				{ value: "clone", label: "Clone" },
				{ value: "delete", label: `Delete this ${this.#noun}` },
				{ value: "back", label: "Back" },
			);
		}
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		if (selectedField)
			list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex(item => item.value === selectedField),
				),
			);
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			if (matchesKey(data, "space")) {
				// Space flips on/off rows; on any other row it is Enter.
				const value = list.getSelectedItem()?.value;
				if (value) this.#onDetailSelect(index, value);
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
			case "path":
				this.#showFieldEditor(index, "path", "Path relative to the agent directory");
				return;
			case "literal":
				this.#showFieldEditor(index, "literal", "Literal text in the system prompt to replace");
				return;
			case "clone":
				this.#showNewEntryEditor(entry.content, entry.name);
				return;
			case "delete":
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
		const list = new SelectList(items, items.length, getSelectListTheme());
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
			{ externalEditor: this.#deps.externalEditor },
		);
		this.#setScreen("content", editor, "");
	}
}
