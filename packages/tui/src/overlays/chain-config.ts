/**
 * Fullscreen `/chaining configure` overlay: a mouse- and keyboard-driven editor
 * for the `CHAINS.yml` post-processing chains at project or user level.
 *
 * It mirrors {@link ./advisor-config} one level deeper: the list screen is a
 * two-pane split (clickable chain sidebar on the left, a preview of the
 * highlighted chain's description and ordered steps on the right), a chain
 * detail screen edits the chain's name, description, and step order, and a step
 * detail screen edits one step's name, model, tools, and prompt.
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
	| "prompt";

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
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footerHint = "";
	#previewScroll = 0;

	// Persistent frame: top, growing two-pane body, divider, footer, bottom.
	// The frame paints from screen row 0, so SGR `event.row`/`event.col` —
	// already 0-based — index directly into the stack. The list screen splits
	// (sidebar + preview); every other screen forces the narrow left pane.
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
		const bodyRows = Math.max(3, height - 4);
		this.#bodyRowsLast = bodyRows;
		const title = `Chain configuration · ${this.#scope}${this.#dirty ? "  ● unsaved" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([isSplit ? topBorderSplit(width, title, leftWidth) : topBorder(width, title)]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		this.#frameFooter.setLines([row(theme.fg("dim", this.#footerHint), width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(bodyRows + 4);
		return this.#frame.render(width);
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		this.#active.handleInput?.(data);
	}

	/** Forward enhanced-paste transports into the multiline prompt editor. */
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
		const maxScroll = Math.max(0, lines.length - rows);
		const start = Math.min(this.#previewScroll, maxScroll);
		const window = lines.slice(start, start + rows);
		if (lines.length > rows) {
			const marker =
				start + rows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - rows - start} more`)
					: theme.fg("dim", "  (end)");
			window[rows - 1] = marker;
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
		lines.push("", theme.fg("dim", `Steps (${chain.steps.length}):`));
		if (chain.steps.length === 0) {
			lines.push(theme.fg("muted", "  (none — a chain needs at least one step)"));
		}
		for (const [index, step] of chain.steps.entries()) {
			lines.push(`  ${index + 1}. ${step.name || "(unnamed)"}`);
			lines.push(theme.fg("dim", `     ${this.#stepModelLabel(step)} · ${formatStepTools(step.tools)}`));
			lines.push(theme.fg("muted", `     ${previewLineOrNone(step.prompt)}`));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	// ───────────────────────────── screens ───────────────────────────

	#setScreen(screen: Screen, active: Component, footerHint: string): void {
		this.#screen = screen;
		this.#active = active;
		this.#footerHint = footerHint;
		this.#previewScroll = 0;
		this.#cb.requestRender();
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
		const count = `${chain.steps.length} step${chain.steps.length === 1 ? "" : "s"}`;
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

		// Show every row (no internal overflow-search); the split frame supplies height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		if (selectedValue) list.setSelectedValue(selectedValue);
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
			const selected = list.getSelectedItem()?.value ?? "";
			const match = /^chain:(\d+)$/.exec(selected);
			if (match && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
				this.#onDeleteChain(Number(match[1]));
				return;
			}
			if (this.#pendingDeleteChain !== null) {
				// Any other key abandons the pending removal; Esc only does that.
				this.#pendingDeleteChain = null;
				this.#showList(selected);
				if (!matchesKey(data, "escape")) this.#active.handleInput?.(data);
				return;
			}
			handleInput(data);
		};
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
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
				: "↑↓ move · Enter / click select · Delete removes a chain · scroll preview on the right · Esc close",
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
			const doc = await this.#cb.loadDoc(next);
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
			await this.#cb.save(this.#scope, this.#doc);
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
				label: `${stepIndex + 1}. ${step.name || "(unnamed)"} — ${this.#stepModelLabel(step)}`,
				description: `${formatStepTools(step.tools)} · ${previewLineOrNone(step.prompt)}`,
			});
		}
		items.push(
			{ value: "addStep", label: "+ Add step" },
			{ value: "delete", label: "Delete this chain" },
			{ value: "back", label: "Back" },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		if (selectedField) {
			const found = items.findIndex(item => item.value === selectedField);
			if (found >= 0) list.setSelectedIndex(found);
		}
		const handleInput = list.handleInput.bind(list);
		list.handleInput = data => {
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
			`Editing "${chain.name}" · Enter / click edit · Alt+↑↓ or [ ] reorder steps · Delete removes a step · Esc back`,
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
			{ value: "prompt", label: "Prompt", description: previewLineOrNone(step.prompt) },
			{ value: "delete", label: "Delete this step" },
			{ value: "back", label: "Back" },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		if (selectedField) {
			const found = items.findIndex(item => item.value === selectedField);
			if (found >= 0) list.setSelectedIndex(found);
		}
		list.onSelect = item => this.#onStepSelect(chainIndex, stepIndex, item.value);
		list.onCancel = () => this.#showChain(chainIndex, `step:${stepIndex}`);
		this.#setScreen(
			"step",
			list,
			`Step ${stepIndex + 1} "${step.name}" · Enter / click edit · Esc back to the chain`,
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
			case "prompt":
				this.#showPromptEditor(chainIndex, stepIndex);
				return;
			case "delete": {
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
		this.#setScreen("model", picker, "Type to search · Enter / click twice picks · Esc back");
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
		const items: SelectItem[] = [{ value: "", label: "(model default thinking)" }];
		for (const effort of efforts) items.push({ value: effort, label: effort });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelect = item => {
			// Values are supported efforts or the empty model-default choice.
			this.#setStepModel(chainIndex, stepIndex, item.value ? `${selector}:${item.value}` : selector);
		};
		list.onCancel = () => this.#showModelPicker(chainIndex, stepIndex);
		this.#setScreen("thinking", list, `Thinking effort for ${selector} · Enter / click pick · Esc back`);
	}

	#showToolsEditor(chainIndex: number, stepIndex: number, selected: Set<string>, cursor: number): void {
		const all = this.#availableToolNames;
		const items: SelectItem[] = all.map(name => ({
			value: name,
			label: `${selected.has(name) ? "[x]" : "[ ]"} ${name}`,
		}));
		items.push({ value: "__done", label: "Done" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(cursor);
		let cursorIndex = cursor;
		list.onSelectionChange = item => {
			cursorIndex = items.findIndex(i => i.value === item.value);
		};
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
			this.#showToolsEditor(chainIndex, stepIndex, selected, cursorIndex);
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
			{ externalEditor: this.#deps.externalEditor },
		);
		this.#setScreen("prompt", editor, "");
	}
}
