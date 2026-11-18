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
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import { sanitizeDisplayWarnings } from "../render/render-utils";
import { getSelectListTheme, theme } from "../theme";
import { sanitizeDisplayLine } from "./extensions/display-text";
import { HookEditorComponent } from "./hook-editor";
import { buildBrowserItems, ModelBrowser, type ModelBrowserSource, sortModelItems } from "./model-browser";
import {
	isFanoutEdge,
	mixtureEdgeId,
	TRANSIT_PART_NAMES,
	type MixtureConfigScope,
	type MixtureDefinition,
	type MixturesConfigDoc,
	type MixtureMember,
	type VerdictMember,
	type ModelMember,
	type SequentialEdge,
	type TransitPartName,
} from "./mixture-types";
import { extractPrintableText } from "../keys";
import { isMenuHistoryParticipant, MenuKeyReader, type MenuNavAction } from "../components/menu-navigation";
import type { SelectListNavigationState } from "../components/select-list";

export interface MixtureConfigDeps {
	getAvailableModels: () => Model[];
	browserSource: ModelBrowserSource;
	externalEditor?: (text: string) => Promise<string | null>;
	availableToolNames: readonly string[];
	activeName: () => string | undefined;
}

export interface MixtureConfigCallbacks {
	loadDoc: (scope: MixtureConfigScope) => Promise<MixturesConfigDoc>;
	/** Save only: do not change the running catalog. */
	save: (scope: MixtureConfigScope, doc: MixturesConfigDoc) => Promise<void>;
	/** Install the saved, discovered roster in this workspace. */
	apply: () => Promise<void>;
	activate: (name: string) => Promise<void>;
	close: () => void;
	requestRender: () => void;
	notify: (message: string) => void;
	warn: (message: string) => void;
}

function preview(text: string | undefined, width: number): string {
	const first = sanitizeDisplayLine(text?.trim().split("\n", 1)[0] ?? "");
	return first ? truncateToWidth(first, width) : "(none)";
}

const DECISION_PARTS = ["output", "input", "toolTrace"] as const;

type MixturePageContext =
	| { page: "list" }
	| { page: "mixture" | "members" | "edges" | "limits"; index: number }
	| {
			page:
				| "member"
				| "verdict"
				| "choice-criteria"
				| "score-criteria"
				| "route"
				| "terminate"
				| "model"
				| "tools"
				| "edge"
				| "transit"
				| "transcript";
			index: number;
			position: number;
	  }
	| { page: "choice-option"; index: number; position: number; name: string }
	| { page: "presets"; index: number; kind: "roles" | "envelopes" }
	| { page: "preset"; index: number; kind: "roles" | "envelopes"; name: string }
	| { page: "thinking"; index: number; position: number; selector: string; efforts: readonly string[] };

type MixtureNavigationContext = MixturePageContext | { page: "field"; parent: MixturePageContext; key: string };

interface MixtureListState {
	navigation?: SelectListNavigationState;
	browser?: unknown;
	previewScroll: number;
	previewFocused: boolean;
}

interface MixtureNavigationSnapshot {
	context: MixtureNavigationContext;
	scope: MixtureConfigScope;
	doc: MixturesConfigDoc;
	dirty: boolean;
	pendingApply: boolean;
	previewScroll: number;
	previewFocused: boolean;
	lists: Array<[string, MixtureListState]>;
	content: unknown;
}

interface MixturePageOpener {
	open: (value: string) => void;
	accepts?: (value: string) => boolean;
	navigable?: (value: string) => boolean;
}

type MixtureMenuShortcut = (data: string, list: SelectList) => boolean;

/** Fullscreen, keyboard- and mouse-driven editor for the project or user MIXTURES.toml. */
export class MixtureConfigOverlayComponent implements Component {
	readonly #tui: TUI;
	readonly #deps: MixtureConfigDeps;
	readonly #cb: MixtureConfigCallbacks;
	#scope: MixtureConfigScope;
	#doc: MixturesConfigDoc;
	#dirty = false;
	#pendingApply = false;
	#pendingDelete: number | null = null;
	#screen = "list";
	#active!: Component;
	#footer = "";
	#previewScroll = 0;
	#bodyRows = 3;
	#previewFocused = false;
	#previewRows = 1;
	#previewMax = 0;
	readonly #keys = new MenuKeyReader();
	#navigationContext: MixtureNavigationContext = { page: "list" };
	#buildingContext: MixtureNavigationContext | undefined;
	#navigationScope: MixtureConfigScope;
	#restoringNavigation = false;
	#previousVisitSnapshot: MixtureNavigationSnapshot | undefined;
	readonly #listStates = new Map<string, MixtureListState>();
	readonly #openers = new Map<string, MixturePageOpener>();
	#shortcut: MixtureMenuShortcut | undefined;
	#pendingOperations = 0;
	#loadRevision = 0;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	readonly #split = new SplitPane({
		left: (width, height) => {
			const rows = Math.max(0, Math.floor(height ?? this.#bodyRows));
			if (this.#active instanceof SelectList) this.#active.setMaxVisible(Math.max(1, rows - 1));
			else if (this.#active instanceof ModelBrowser) this.#active.setMaxVisible(Math.max(1, rows - 5));
			const lines = [...this.#active.render(width)];
			while (lines.length < rows) lines.push("");
			return lines.slice(0, rows);
		},
		right: (width, height) => {
			const rows = Math.max(0, Math.floor(height ?? this.#bodyRows));
			const lines = this.#previewLines(width);
			this.#previewRows = rows;
			this.#previewMax = Math.max(0, lines.length - rows);
			const start = Math.min(this.#previewScroll, this.#previewMax);
			this.#previewScroll = start;
			const visible = lines.slice(start, start + rows);
			while (visible.length < rows) visible.push("");
			return visible;
		},
		leftSize: { ratio: 0.34, min: 22, max: 42 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #top = new PanelRows();
	readonly #divider = new PanelRows();
	readonly #footerRow = new PanelRows();
	readonly #bottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#top, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#divider, height: 1 },
			{ content: this.#footerRow, height: 1 },
			{ content: this.#bottom, height: 1 },
		],
	});

	constructor(
		tui: TUI,
		deps: MixtureConfigDeps,
		scope: MixtureConfigScope,
		doc: MixturesConfigDoc,
		callbacks: MixtureConfigCallbacks,
		selectedName?: string,
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#scope = scope;
		this.#doc = doc;
		this.#navigationScope = scope;
		this.#cb = callbacks;
		this.#showList(
			selectedName ? `mixture:${this.#doc.mixtures.findIndex(item => item.name === selectedName)}` : undefined,
		);
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		this.#bodyRows = Math.max(3, height - 4);
		const title = `Mixture configuration · ${this.#scope}${this.#dirty ? "  ● unsaved" : this.#pendingApply ? "  ◐ saved, not applied" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" && this.#previewFocused ? "right" : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(this.#bodyRows);
		const geometry = this.#split.measure(width);
		const left = geometry.left?.width ?? 0;
		this.#top.setLines([geometry.mode === "split" ? topBorderSplit(width, title, left) : topBorder(width, title)]);
		this.#divider.setLines([geometry.mode === "split" ? dividerSplit(width, left) : divider(width)]);
		const status = this.#dirty ? "● unsaved · " : this.#pendingApply ? "◐ saved, not applied · " : "";
		const pane = this.#screen === "list" ? `${this.#previewFocused ? "Preview" : "List"} · ` : "";
		this.#footerRow.setLines([row(theme.fg("dim", status + pane + sanitizeDisplayLine(this.#footer)), width)]);
		this.#bottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(this.#bodyRows + 4);
		return this.#frame.render(width);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#keys.reset();
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}
		const active = this.#active;
		if (
			active instanceof Input ||
			active instanceof HookEditorComponent ||
			((active instanceof SelectList || active instanceof ModelBrowser) && active.filterFocused)
		) {
			this.#keys.reset();
			const text = active instanceof Input ? extractPrintableText(data) : undefined;
			if (text !== undefined && active instanceof Input) active.insertText(text);
			else active.handleInput?.(data);
			return;
		}
		if (
			this.#screen === "list" &&
			this.#pendingDelete !== null &&
			active instanceof SelectList &&
			this.#shortcut?.(data, active)
		) {
			this.#keys.reset();
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action === undefined && active instanceof SelectList && this.#shortcut?.(data, active)) {
			this.#keys.reset();
			return;
		}
		if (action?.kind === "horizontal") {
			if (this.#screen === "list") this.#previewFocused = action.delta > 0;
			else if (this.#navigationContext.page === "thinking" && active instanceof SelectList) {
				const view = active.pickerView();
				const selected = view.items.findIndex(item => item.value === view.selected);
				active.setSelectedIndex(Math.max(0, Math.min(view.items.length - 1, selected + action.delta)));
			} else if (action.delta < 0) {
				if (active instanceof SelectList || active instanceof ModelBrowser) active.onCancel?.();
			} else if (
				active instanceof SelectList &&
				this.#navigationContext.page !== "field" &&
				this.#screen !== "discard"
			) {
				const value = active.getSelectedItem()?.value;
				if (value !== undefined) this.#openField(value, true);
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
			const value = active.getSelectedItem()?.value;
			if (this.#screen === "list") {
				if (value !== undefined) {
					const match = /^mixture:(\d+)$/.exec(value);
					void this.#onListSelect(match ? `activate:${match[1]}` : value).catch(error =>
						this.#cb.notify(String(error)),
					);
				}
				return;
			}
			if (
				(this.#screen === "discard" && value === "discard") ||
				((this.#screen === "route" || this.#screen === "terminate") && value === "remove")
			)
				return;
		}
		if (action && (active instanceof SelectList || active instanceof ModelBrowser)) active.handleNavigation(action);
		else active.handleInput?.(data);
	}

	#applyPreviewMotion(action: MenuNavAction): boolean {
		let next = this.#previewScroll;
		switch (action.kind) {
			case "move":
			case "scroll":
				next += action.delta;
				break;
			case "halfPage":
				next += action.delta * Math.max(1, Math.floor(this.#previewRows / 2));
				break;
			case "page":
				next += action.delta * this.#previewRows;
				break;
			case "boundary":
				next = action.edge === "first" ? 0 : this.#previewMax;
				break;
			default:
				return false;
		}
		this.#previewScroll = Math.max(0, Math.min(this.#previewMax, next));
		this.#cb.requestRender();
		return true;
	}

	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (!hit || hit.index !== 1) return false;
		const pane = this.#split.locate(hit.line, hit.col);
		if (pane?.pane === "right") {
			if (event.wheel !== null) {
				this.#previewScroll = Math.max(0, Math.min(this.#previewMax, this.#previewScroll + event.wheel));
				this.#cb.requestRender();
			}
			return true;
		}
		if (pane?.pane === "left" && isLayoutMouseRoutable(this.#active))
			this.#active.routeMouse(event, pane.line, pane.col);
		return true;
	}

	#previewLines(width: number): string[] {
		const warnings = (this.#doc.warnings?.length ? sanitizeDisplayWarnings(this.#doc.warnings) : []).map(warning =>
			theme.fg("warning", truncateToWidth(warning, width)),
		);
		const value = this.#active instanceof SelectList ? (this.#active.getSelectedItem()?.value ?? "") : "";
		const index = /^mixture:(\d+)$/.exec(value);
		const mixture = index ? this.#doc.mixtures[Number(index[1])] : undefined;
		if (!mixture) return [...warnings, theme.fg("muted", "Choose a mixture to see its members and graph.")];
		const lines = [
			theme.bold(sanitizeDisplayLine(mixture.name)),
			preview(mixture.description, width),
			"",
			`Entry: ${sanitizeDisplayLine(mixture.entry)}`,
			"",
			"Members:",
		];
		for (const member of mixture.members) {
			lines.push(
				`  ${sanitizeDisplayLine(member.id)} · ${member.kind === "verdict" ? "verdict" : sanitizeDisplayLine(member.model || "(choose model)")}`,
			);
		}
		lines.push("", "Flow:");
		for (const edge of mixture.edges) {
			const destination = isFanoutEdge(edge) ? `[${edge.to.join(", ")}] ⇢ ${edge.join}` : edge.to;
			const label = edge.id ? ` · ${edge.id}` : "";
			lines.push(
				`  ${sanitizeDisplayLine(edge.from)} → ${sanitizeDisplayLine(destination)}${sanitizeDisplayLine(label)}`,
			);
			lines.push(`    handoff: ${Object.keys(edge.x).join(", ") || "(no parts)"}`);
		}
		if (mixture.edges.length === 0) lines.push("  (no edges — the entry member ends the run)");
		return [...warnings, ...lines.map(line => truncateToWidth(line, width))];
	}

	#preparePage(context: MixturePageContext): void {
		if (JSON.stringify(context) !== JSON.stringify(this.#navigationContext)) this.#loadRevision++;
		this.#buildingContext = context;
		this.#openers.clear();
	}

	#pageKey(context: MixtureNavigationContext, scope: MixtureConfigScope): string {
		return `${scope}:${JSON.stringify(context)}`;
	}

	#openField(value: string, navigationOnly = false): boolean {
		if (this.#navigationContext.page === "field") return false;
		const opener = this.#openers.get(value);
		if (!opener || (navigationOnly && opener.navigable?.(value) === false)) return false;
		const context: MixtureNavigationContext = { page: "field", parent: this.#navigationContext, key: value };
		this.#loadRevision++;
		this.#buildingContext = context;
		opener.open(value);
		if (this.#buildingContext === context) this.#buildingContext = undefined;
		return true;
	}

	#setScreen(
		screen: string,
		active: Component,
		footer: string,
		shortcut?: MixtureMenuShortcut,
		selected?: string,
	): void {
		const context = this.#buildingContext ?? this.#navigationContext;
		this.#buildingContext = undefined;
		const changed = JSON.stringify(context) !== JSON.stringify(this.#navigationContext);
		if (
			!this.#restoringNavigation &&
			this.#screen !== "discard" &&
			(this.#active instanceof SelectList || this.#active instanceof ModelBrowser)
		) {
			this.#listStates.set(this.#pageKey(this.#navigationContext, this.#navigationScope), {
				navigation: this.#active instanceof SelectList ? this.#active.navigationState() : undefined,
				browser: this.#active instanceof ModelBrowser ? this.#active.navigationSnapshot() : undefined,
				previewScroll: this.#previewScroll,
				previewFocused: this.#previewFocused,
			});
		}
		const previous =
			changed && !this.#restoringNavigation ? (this.#previousVisitSnapshot ?? this.navigationSnapshot()) : undefined;
		this.#previousVisitSnapshot = undefined;
		const saved = this.#listStates.get(this.#pageKey(context, this.#scope));
		if (saved?.navigation && active instanceof SelectList && screen !== "discard") {
			active.restoreNavigation({ ...saved.navigation, selectedValue: selected ?? saved.navigation.selectedValue });
		} else if (saved?.browser !== undefined && active instanceof ModelBrowser)
			active.restoreNavigation(saved.browser);
		this.#keys.reset();
		this.#screen = screen;
		this.#active = active;
		this.#shortcut = shortcut;
		const navigation =
			screen === "list"
				? "←/→ panes · Tab pane"
				: screen === "discard"
					? "←/Esc keep editing"
					: context.page === "thinking"
						? "←/→ effort"
						: context.page !== "field" && this.#openers.size > 0
							? "← parent / → open"
							: "← parent";
		this.#footer = active instanceof SelectList ? `${navigation} · / search · ${footer}` : footer;
		this.#previewScroll = saved?.previewScroll ?? 0;
		this.#previewFocused = screen === "list" && (saved?.previewFocused ?? false);
		this.#navigationContext = context;
		this.#navigationScope = this.#scope;
		if (previous !== undefined)
			this.onNavigationVisit?.(context.page === "list" ? "" : this.#pageKey(context, this.#scope), previous);
		this.#cb.requestRender();
	}

	#menu(
		screen: string,
		items: SelectItem[],
		selected: string | undefined,
		footer: string,
		onSelect: ((value: string) => void | Promise<void>) | undefined,
		onCancel: () => void,
		onKey?: MixtureMenuShortcut,
		navigation?: MixturePageOpener,
	): void {
		const safeItems = items.map(item => ({
			...item,
			label: sanitizeDisplayLine(item.label),
			description: item.description === undefined ? undefined : sanitizeDisplayLine(item.description),
		}));
		const list = new SelectList(
			safeItems,
			Math.max(1, Math.min(items.length, this.#bodyRows - 1)),
			getSelectListTheme(),
			{ search: "always" },
		);
		if (selected && items.some(item => item.value === selected)) list.setSelectedValue(selected);
		if (navigation)
			for (const item of safeItems) {
				if (navigation.accepts ? navigation.accepts(item.value) : item.value !== "back")
					this.#openers.set(item.value, navigation);
			}
		list.onSelect = item => {
			if (this.#openField(item.value)) return;
			void Promise.resolve(onSelect ? onSelect(item.value) : onCancel()).catch(error =>
				this.#cb.notify(error instanceof Error ? error.message : String(error)),
			);
		};
		list.onCancel = onCancel;
		list.onSelectionChange = () => {
			if (screen === "list") this.#previewScroll = 0;
			this.#cb.requestRender();
		};
		this.#setScreen(screen, list, footer, onKey, selected);
	}

	#touch(): void {
		this.#loadRevision++;
		this.#dirty = true;
		this.#cb.requestRender();
	}

	#otherScope(): MixtureConfigScope {
		return this.#scope === "project" ? "user" : "project";
	}

	#showList(selected?: string): void {
		this.#preparePage({ page: "list" });
		this.#openers.set("new", { open: () => this.#newMixture(), navigable: () => false });
		const active = this.#deps.activeName();
		const items: SelectItem[] = this.#doc.mixtures.map((mixture, index) => ({
			value: `mixture:${index}`,
			label:
				this.#pendingDelete === index
					? `⚠ Delete ${mixture.name}?`
					: `${active === mixture.name ? "●" : "○"} ${mixture.name}`,
			description:
				this.#pendingDelete === index
					? "Delete again to confirm"
					: `${mixture.members.length} members · ${mixture.edges.length} edges`,
		}));
		items.push(
			{ value: "new", label: "+ Create mixture" },
			{ value: "scope", label: `Scope: ${this.#scope}`, description: `→ ${this.#otherScope()}` },
			{ value: "save", label: "Save only" },
			{ value: "apply", label: "Save & apply" },
			{ value: "close", label: "Close" },
		);
		this.#menu(
			"list",
			items,
			selected,
			this.#pendingDelete !== null
				? "Delete again to confirm · any other key cancels"
				: "Enter edit · Space activate · Del delete · s save · a apply · Esc close",
			value => this.#onListSelect(value),
			() => this.#close(),
			(data, list) => {
				const value = list.getSelectedItem()?.value ?? "";
				const match = /^mixture:(\d+)$/.exec(value);
				if (match && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
					this.#deleteMixture(Number(match[1]));
					return true;
				}
				if (this.#pendingDelete !== null) {
					this.#pendingDelete = null;
					this.#showList(value);
					return true;
				}
				if (matchesKey(data, "s") || matchesKey(data, "a")) {
					void this.#onListSelect(matchesKey(data, "s") ? "save" : "apply", value).catch(error =>
						this.#cb.notify(String(error)),
					);
					return true;
				}
				return false;
			},
		);
	}

	#close(): void {
		if (!this.#dirty) return this.#cb.close();
		this.#menu(
			"discard",
			[
				{ value: "keep", label: "Keep editing", description: "Return to the mixture list" },
				{ value: "discard", label: "Discard changes and close", description: "Unsaved changes will be lost" },
			],
			"keep",
			"Unsaved changes · Enter choose · Esc keep editing",
			value => {
				if (value === "discard") this.#cb.close();
				else this.#showList();
			},
			() => this.#showList(),
		);
	}

	#deleteMixture(index: number): void {
		if (this.#pendingDelete !== index) {
			this.#pendingDelete = index;
			this.#showList(`mixture:${index}`);
			return;
		}
		this.#doc.mixtures.splice(index, 1);
		this.#pendingDelete = null;
		this.#touch();
		this.#showList();
	}

	async #save(): Promise<void> {
		this.#pendingOperations++;
		try {
			await this.#cb.save(this.#scope, this.#doc);
			this.#doc.warnings = undefined;
			this.#dirty = false;
			this.#pendingApply = true;
		} finally {
			this.#pendingOperations--;
			this.#cb.requestRender();
		}
	}

	async #apply(): Promise<void> {
		if (!this.#dirty && !this.#pendingApply) {
			this.#cb.notify("Nothing new to apply.");
			return;
		}
		this.#pendingOperations++;
		try {
			if (this.#dirty) await this.#save();
			await this.#cb.apply();
			this.#pendingApply = false;
		} finally {
			this.#pendingOperations--;
			this.#cb.requestRender();
		}
	}

	async #onListSelect(value: string, selected?: string): Promise<void> {
		if (value === "new") {
			this.#openField("new");
			return;
		}
		if (value === "scope") {
			if (this.#dirty) {
				this.#cb.notify("Unsaved changes — save or close before switching scope.");
				return;
			}
			const scope = this.#otherScope();
			const revision = ++this.#loadRevision;
			const doc = await this.#cb.loadDoc(scope);
			if (revision !== this.#loadRevision) return;
			this.#scope = scope;
			this.#doc = doc;
			this.#pendingApply = false;
			if (doc.warnings?.length) this.#cb.warn(`MIXTURES.toml: ${sanitizeDisplayWarnings(doc.warnings).join("; ")}`);
			this.#showList();
			return;
		}
		if (value === "save") {
			await this.#save();
			this.#showList(selected);
			return;
		}
		if (value === "apply") {
			await this.#apply();
			this.#showList(selected);
			return;
		}
		if (value === "close") {
			this.#close();
			return;
		}
		const activate = /^activate:(\d+)$/.exec(value);
		if (activate) {
			const mixture = this.#doc.mixtures[Number(activate[1])];
			if (!mixture) return;
			this.#pendingOperations++;
			try {
				if (this.#dirty || this.#pendingApply) await this.#apply();
				await this.#cb.activate(mixture.name);
				this.#showList(`mixture:${activate[1]}`);
			} finally {
				this.#pendingOperations--;
				this.#cb.requestRender();
			}
			return;
		}
		const match = /^mixture:(\d+)$/.exec(value);
		if (match) this.#showMixture(Number(match[1]));
	}

	#newMixture(): void {
		this.#editText(
			"New mixture name",
			"",
			value => {
				const name = value.trim();
				if (!name) return;
				this.#doc.mixtures.push({
					name,
					entry: "writer",
					members: [{ id: "writer", model: "", tools: false }],
					edges: [],
				});
				this.#touch();
				this.#showMember(this.#doc.mixtures.length - 1, 0);
			},
			() => this.#showList(),
		);
	}

	#editText(label: string, current: string, save: (value: string) => boolean | void, cancel: () => void): void {
		const input = new Input();
		input.setValue(current);
		input.onSubmit = value => {
			const accepted = save(value);
			if (accepted !== false && this.#active === input) cancel();
		};
		input.onEscape = cancel;
		this.#setScreen("input", input, `${label} · Enter save · Esc cancel`);
	}

	#editLong(label: string, current: string, save: (value: string) => void, back: () => void): void {
		const editor = new HookEditorComponent(
			this.#tui,
			label,
			current,
			value => {
				save(value);
				back();
			},
			back,
			{ externalEditor: this.#deps.externalEditor, menuHistory: true },
		);
		this.#setScreen("editor", editor, "Ctrl+Q save · Ctrl+G external editor · Esc cancel");
	}

	#choose(
		label: string,
		values: SelectItem[],
		selected: string | undefined,
		save: (value: string) => void,
		back: () => void,
	): void {
		this.#menu(
			"choice",
			values,
			selected,
			`${label} · Enter choose · Esc cancel`,
			value => {
				save(value);
				back();
			},
			back,
		);
	}

	#mixture(index: number): MixtureDefinition | undefined {
		return this.#doc.mixtures[index];
	}

	#showMixture(index: number, selected?: string): void {
		this.#preparePage({ page: "mixture", index });
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const items: SelectItem[] = [
			{ value: "name", label: "Name", description: mixture.name },
			{ value: "description", label: "Description", description: preview(mixture.description, 55) },
			{ value: "entry", label: "Entry member", description: mixture.entry },
			{
				value: "members",
				label: `Members (${mixture.members.length})`,
				description: mixture.members.map(member => member.id).join(" → "),
			},
			{
				value: "edges",
				label: `Edges (${mixture.edges.length})`,
				description: mixture.edges.map(mixtureEdgeId).join(", "),
			},
			{
				value: "limits",
				label: "Limits",
				description: mixture.limits ? `${mixture.limits.maxHops ?? "default"} hops` : "defaults",
			},
			{ value: "roles", label: "Role presets", description: `${Object.keys(mixture.roles ?? {}).length} local` },
			{
				value: "envelopes",
				label: "Envelope presets",
				description: `${Object.keys(mixture.envelopes ?? {}).length} local`,
			},
			{ value: "back", label: "Back to mixtures" },
		];
		this.#menu(
			"mixture",
			items,
			selected,
			`Editing ${mixture.name} · Enter select · Esc back`,
			undefined,
			() => this.#showList(`mixture:${index}`),
			undefined,
			{
				open: value => {
					switch (value) {
						case "name":
							this.#editText(
								"Mixture name",
								mixture.name,
								text => {
									if (text.trim()) {
										mixture.name = text.trim();
										this.#touch();
									}
								},
								() => this.#showMixture(index, value),
							);
							break;
						case "description":
							this.#editText(
								"Description",
								mixture.description ?? "",
								text => {
									mixture.description = text.trim() || undefined;
									this.#touch();
								},
								() => this.#showMixture(index, value),
							);
							break;
						case "entry":
							this.#choose(
								"Entry member",
								mixture.members
									.filter(member => member.kind !== "verdict")
									.map(member => ({ value: member.id, label: member.id })),
								mixture.entry,
								id => {
									mixture.entry = id;
									this.#touch();
								},
								() => this.#showMixture(index, value),
							);
							break;
						case "members":
							this.#showMembers(index);
							break;
						case "edges":
							this.#showEdges(index);
							break;
						case "limits":
							this.#showLimits(index);
							break;
						case "roles":
						case "envelopes":
							this.#showPresets(index, value);
							break;
						default:
							this.#showList(`mixture:${index}`);
					}
				},
			},
		);
	}

	#showMembers(index: number, selected?: string): void {
		this.#preparePage({ page: "members", index });
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const items: SelectItem[] = mixture.members.map((member, position) => ({
			value: `member:${position}`,
			label: `${mixture.entry === member.id ? "◆" : "○"} ${member.id}`,
			description: member.kind === "verdict" ? "verdict" : member.model || "select a model",
		}));
		items.push(
			{ value: "add", label: "+ Add model member" },
			{ value: "verdict", label: "+ Add verdict member" },
			{ value: "back", label: "Back to mixture" },
		);
		this.#menu(
			"members",
			items,
			selected,
			"Enter edit · Delete remove member and its edges · Alt+↑↓ reorder · Esc back",
			undefined,
			() => this.#showMixture(index, "members"),
			(data, list) => {
				const match = /^member:(\d+)$/.exec(list.getSelectedItem()?.value ?? "");
				if (!match) return false;
				const position = Number(match[1]);
				if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
					const member = mixture.members[position];
					if (!member) return true;
					mixture.edges = mixture.edges.filter(edge => {
						const keep =
							edge.from !== member.id &&
							(isFanoutEdge(edge)
								? edge.join !== member.id && !edge.to.includes(member.id)
								: edge.to !== member.id);
						if (!keep) this.#syncFallback(mixture, mixtureEdgeId(edge), undefined);
						return keep;
					});
					if (mixture.entry === member.id)
						mixture.entry = mixture.members.find(next => next.kind !== "verdict")?.id ?? "";
					this.#touch();
					this.#showMembers(index);
					return true;
				}
				const delta =
					matchesKey(data, "alt+up") || data === "[" ? -1 : matchesKey(data, "alt+down") || data === "]" ? 1 : 0;
				if (!delta || position + delta < 0 || position + delta >= mixture.members.length) return false;
				const [member] = mixture.members.splice(position, 1);
				if (member) mixture.members.splice(position + delta, 0, member);
				this.#touch();
				this.#showMembers(index, `member:${position + delta}`);
				return true;
			},
			{
				open: value => {
					const match = /^member:(\d+)$/.exec(value);
					if (match) {
						const position = Number(match[1]);
						if (mixture.members[position]?.kind === "verdict") this.#showVerdict(index, position);
						else this.#showMember(index, position);
					} else if (value === "add")
						this.#editText(
							"Member id",
							"",
							text => {
								const id = text.trim();
								if (!id) return;
								mixture.members.push({ id, model: "", tools: false });
								this.#touch();
								this.#showMember(index, mixture.members.length - 1);
							},
							() => this.#showMembers(index),
						);
					else if (value === "verdict")
						this.#editText(
							"Verdict member id",
							"",
							text => {
								const id = text.trim();
								if (!id) return false;
								mixture.members.push({ id, kind: "verdict", question: { type: "noul", instructions: "" } });
								this.#touch();
								this.#showVerdict(index, mixture.members.length - 1);
							},
							() => this.#showMembers(index),
						);
					else this.#showMixture(index, "members");
				},
				navigable: value => value !== "add" && value !== "verdict",
			},
		);
	}

	#modelMember(index: number, position: number): ModelMember | undefined {
		const member = this.#mixture(index)?.members[position];
		return member && member.kind !== "verdict" ? member : undefined;
	}

	#syncFallback(mixture: MixtureDefinition, oldId: string, newId: string | undefined): void {
		if (oldId === newId) return;
		for (const member of mixture.members) {
			if (member.kind !== "verdict" && member.route?.fallback === oldId) member.route.fallback = newId;
		}
	}

	#renameMember(mixture: MixtureDefinition, member: MixtureMember, id: string): void {
		if (!id || id === member.id) return;
		if (mixture.entry === member.id) mixture.entry = id;
		if (mixture.limits?.limitTarget === member.id) mixture.limits.limitTarget = id;
		for (const edge of mixture.edges) {
			const oldId = mixtureEdgeId(edge);
			if (edge.from === member.id) edge.from = id;
			if (isFanoutEdge(edge)) {
				edge.to = edge.to.map(target => (target === member.id ? id : target));
				if (edge.join === member.id) edge.join = id;
			} else if (edge.to === member.id) edge.to = id;
			this.#syncFallback(mixture, oldId, mixtureEdgeId(edge));
		}
		member.id = id;
		this.#touch();
	}

	#showMember(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "member", index, position });
		const member = this.#modelMember(index, position);
		if (!member) return this.#showMembers(index);
		const items: SelectItem[] = [
			{ value: "id", label: "Member id", description: member.id },
			{ value: "model", label: "Model", description: member.model || "(select model)" },
			{ value: "description", label: "Description", description: preview(member.description, 50) },
			{ value: "role", label: "Role prompt", description: preview(member.systemPrompt, 50) },
			{ value: "rolePreset", label: "Role preset", description: member.role ?? "(none)" },
			{
				value: "inherit",
				label: "Inherit outer instructions",
				description: member.inherit === undefined ? "automatic" : member.inherit ? "yes" : "no",
			},
			{
				value: "tools",
				label: "Tools",
				description: member.tools === true ? "all" : Array.isArray(member.tools) ? member.tools.join(", ") : "off",
			},
			{ value: "show", label: "Show", description: member.show ?? "default" },
			{
				value: "maxTokens",
				label: "Maximum output tokens",
				description: String(member.maxTokens ?? "model default"),
			},
			{ value: "route", label: "Route instructions", description: preview(member.route?.instructions, 50) },
			{
				value: "terminate",
				label: "Termination instructions",
				description: preview(member.terminate?.instructions, 50),
			},
			{ value: "back", label: "Back to members" },
		];
		this.#menu(
			"member",
			items,
			selected,
			`Member ${member.id} · Enter edit · Esc back`,
			undefined,
			() => this.#showMembers(index, `member:${position}`),
			undefined,
			{
				open: value => {
					const back = () => this.#showMember(index, position, value);
					switch (value) {
						case "id":
							this.#editText(
								"Member id",
								member.id,
								text => this.#renameMember(this.#mixture(index)!, member, text.trim()),
								back,
							);
							break;
						case "model":
							this.#showModelPicker(index, position);
							break;
						case "description":
							this.#editText(
								"Member description",
								member.description ?? "",
								text => {
									member.description = text.trim() || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "role":
							this.#editLong(
								"Role prompt",
								member.systemPrompt ?? "",
								text => {
									member.systemPrompt = text || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "rolePreset":
							this.#editText(
								"Role preset name",
								member.role ?? "",
								text => {
									member.role = text.trim() || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "inherit":
							this.#choose(
								"Inherit outer instructions",
								[
									{ value: "default", label: "Automatic" },
									{ value: "yes", label: "Yes" },
									{ value: "no", label: "No" },
								],
								member.inherit === undefined ? "default" : member.inherit ? "yes" : "no",
								choice => {
									member.inherit = choice === "default" ? undefined : choice === "yes";
									this.#touch();
								},
								back,
							);
							break;
						case "tools":
							this.#showTools(index, position);
							break;
						case "show":
							this.#choose(
								"Show hop",
								["default", "always", "never", "final"].map(choice => ({ value: choice, label: choice })),
								member.show ?? "default",
								choice => {
									member.show = choice === "default" ? undefined : (choice as "always" | "never" | "final");
									this.#touch();
								},
								back,
							);
							break;
						case "maxTokens":
							this.#editNumber(
								"Maximum output tokens",
								member.maxTokens,
								number => {
									member.maxTokens = number;
									this.#touch();
								},
								back,
							);
							break;
						case "route":
							this.#showRoute(index, position);
							break;
						case "terminate":
							this.#showTerminate(index, position);
							break;
						default:
							this.#showMembers(index, `member:${position}`);
					}
				},
			},
		);
	}

	#verdictMember(index: number, position: number): VerdictMember | undefined {
		const member = this.#mixture(index)?.members[position];
		return member?.kind === "verdict" ? member : undefined;
	}

	#showVerdict(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "verdict", index, position });
		const member = this.#verdictMember(index, position);
		const mixture = this.#mixture(index);
		if (!member || !mixture) return this.#showMembers(index);
		const question = member.question;
		const items: SelectItem[] = [
			{ value: "id", label: "Member id", description: member.id },
			{ value: "description", label: "Description", description: preview(member.description, 50) },
			{ value: "show", label: "Show", description: member.show ?? "default" },
			{ value: "type", label: "Question type", description: question.type },
			{ value: "instructions", label: "Question instructions", description: preview(question.instructions, 50) },
			{
				value: "state",
				label: "Judge context",
				description: member.state?.join(", ") || "topic + available transit",
			},
			{ value: "render", label: "Answer template", description: preview(member.render, 50) },
		];
		if (question.type === "choice" || question.type === "score")
			items.push({
				value: "criteria",
				label: question.type === "choice" ? "Options and rubrics" : "Ordered score levels",
				description: String(
					question.type === "choice" ? Object.keys(question.criteria).length : question.criteria.length,
				),
			});
		else
			items.push(
				{ value: "true", label: "Yes criterion", description: preview(question.criteria?.true, 50) },
				{ value: "false", label: "No criterion", description: preview(question.criteria?.false, 50) },
			);
		items.push({ value: "back", label: "Back to members" });
		this.#menu(
			"verdict",
			items,
			selected,
			`Verdict ${member.id} · Enter edit · Esc back`,
			undefined,
			() => this.#showMembers(index, `member:${position}`),
			undefined,
			{
				open: value => {
					const back = () => this.#showVerdict(index, position, value);
					switch (value) {
						case "id":
							this.#editText(
								"Verdict id",
								member.id,
								text => this.#renameMember(mixture, member, text.trim()),
								back,
							);
							break;
						case "description":
							this.#editText(
								"Verdict description",
								member.description ?? "",
								text => {
									member.description = text.trim() || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "show":
							this.#choose(
								"Show verdict",
								["default", "always", "never", "final"].map(option => ({
									value: option,
									label: option,
								})),
								member.show ?? "default",
								option => {
									member.show = option === "default" ? undefined : (option as "always" | "never" | "final");
									this.#touch();
								},
								back,
							);
							break;
						case "type":
							this.#choose(
								"Question type",
								["noul", "choice", "score"].map(option => ({
									value: option,
									label: option,
								})),
								question.type,
								option => {
									if (option === question.type) return;
									const instructions = question.instructions;
									member.question =
										option === "choice"
											? { type: "choice", instructions, criteria: {} }
											: option === "score"
												? { type: "score", instructions, criteria: ["", ""] }
												: { type: "noul", instructions };
									this.#touch();
								},
								back,
							);
							break;
						case "instructions":
							this.#editLong(
								"Verdict question",
								question.instructions,
								text => {
									member.question.instructions = text.trim();
									this.#touch();
								},
								back,
							);
							break;
						case "state":
							this.#showDecisionState(
								"Verdict judge context",
								TRANSIT_PART_NAMES,
								member.state,
								state => {
									member.state = state;
									this.#touch();
								},
								back,
							);
							break;
						case "render":
							this.#editLong(
								"Verdict answer template",
								member.render ?? "",
								text => {
									member.render = text || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "criteria":
							if (question.type === "choice") this.#showChoiceCriteria(index, position);
							else if (question.type === "score") this.#showScoreCriteria(index, position);
							break;
						case "true":
						case "false":
							if (question.type !== "noul") break;
							this.#editLong(
								`${value === "true" ? "Yes" : "No"} criterion`,
								question.criteria?.[value] ?? "",
								text => {
									if (member.question.type !== "noul") return;
									member.question.criteria = {
										...member.question.criteria,
										[value]: text.trim() || undefined,
									};
									this.#touch();
								},
								back,
							);
							break;
						default:
							this.#showMembers(index, `member:${position}`);
					}
				},
			},
		);
	}

	#showChoiceCriteria(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "choice-criteria", index, position });
		const member = this.#verdictMember(index, position);
		if (!member || member.question.type !== "choice") return this.#showVerdict(index, position);
		const criteria = member.question.criteria;
		this.#menu(
			"choice-criteria",
			[
				...Object.entries(criteria).map(([name, rubric]) => ({
					value: name,
					label: name,
					description: preview(rubric ?? undefined, 50),
				})),
				{ value: "__add", label: "+ Add option" },
				{ value: "__back", label: "Back to verdict" },
			],
			selected,
			"Choice options · Enter edit · Delete remove · Esc back",
			undefined,
			() => this.#showVerdict(index, position, "criteria"),
			(data, list) => {
				const name = list.getSelectedItem()?.value;
				if (!name || name.startsWith("__") || (!matchesKey(data, "delete") && !matchesKey(data, "backspace")))
					return false;
				delete criteria[name];
				this.#touch();
				this.#showChoiceCriteria(index, position);
				return true;
			},
			{
				open: value => {
					if (value === "__back") return this.#showVerdict(index, position, "criteria");
					if (value === "__add")
						this.#editText(
							"Choice option name",
							"",
							text => {
								const name = text.trim();
								if (!name || Object.hasOwn(criteria, name)) {
									this.#cb.notify("Enter a new, unique option name");
									return false;
								}
								criteria[name] = null;
								this.#touch();
								this.#showChoiceOption(index, position, name);
							},
							() => this.#showChoiceCriteria(index, position),
						);
					else this.#showChoiceOption(index, position, value);
				},
				accepts: value => value !== "__back",
				navigable: value => value !== "__add",
			},
		);
	}

	#showChoiceOption(index: number, position: number, name: string): void {
		this.#preparePage({ page: "choice-option", index, position, name });
		const member = this.#verdictMember(index, position);
		if (!member || member.question.type !== "choice") return this.#showVerdict(index, position);
		const criteria = member.question.criteria;
		this.#menu(
			"choice-option",
			[
				{ value: "name", label: "Option name", description: name },
				{ value: "rubric", label: "Rubric", description: preview(criteria[name] ?? undefined, 50) },
				{ value: "back", label: "Back to options" },
			],
			undefined,
			`Option ${name} · Enter edit · Esc back`,
			undefined,
			() => this.#showChoiceCriteria(index, position, name),
			undefined,
			{
				open: value => {
					if (value === "name")
						this.#editText(
							"Choice option name",
							name,
							text => {
								const updated = text.trim();
								if (!updated || (updated !== name && Object.hasOwn(criteria, updated))) {
									this.#cb.notify("Enter a new, unique option name");
									return false;
								}
								if (updated !== name) {
									this.#previousVisitSnapshot = this.navigationSnapshot();
									const rubric = criteria[name] ?? null;
									delete criteria[name];
									criteria[updated] = rubric;
									this.#touch();
								}
								this.#showChoiceOption(index, position, updated);
							},
							() => this.#showChoiceOption(index, position, name),
						);
					else if (value === "rubric")
						this.#editLong(
							"Choice rubric (empty uses the option name)",
							criteria[name] ?? "",
							text => {
								criteria[name] = text.trim() || null;
								this.#touch();
							},
							() => this.#showChoiceOption(index, position, name),
						);
					else this.#showChoiceCriteria(index, position, name);
				},
			},
		);
	}

	#showScoreCriteria(index: number, position: number): void {
		this.#preparePage({ page: "score-criteria", index, position });
		const member = this.#verdictMember(index, position);
		if (!member || member.question.type !== "score") return this.#showVerdict(index, position);
		const question = member.question;
		this.#menu(
			"score-criteria",
			[
				...question.criteria.map((level, number) => ({
					value: String(number),
					label: `Level ${number + 1}`,
					description: preview(level, 50),
				})),
				{ value: "add", label: "+ Add level" },
				{ value: "back", label: "Back to verdict" },
			],
			undefined,
			"Score levels · lowest to highest · Enter edit · Delete remove · Esc back",
			value => {
				if (value === "add") {
					question.criteria = [...question.criteria, ""];
					this.#touch();
					this.#showScoreCriteria(index, position);
				} else this.#showVerdict(index, position, "criteria");
			},
			() => this.#showVerdict(index, position, "criteria"),
			(data, list) => {
				const value = list.getSelectedItem()?.value;
				if (
					!value ||
					value === "add" ||
					value === "back" ||
					(!matchesKey(data, "delete") && !matchesKey(data, "backspace"))
				)
					return false;
				if (question.criteria.length <= 2) {
					this.#cb.notify("A score question needs at least two levels");
					return true;
				}
				question.criteria = question.criteria.filter((_, at) => at !== Number(value)) as [
					string,
					string,
					...string[],
				];
				this.#touch();
				this.#showScoreCriteria(index, position);
				return true;
			},
			{
				open: value => {
					const number = Number(value);
					this.#editLong(
						`Level ${number + 1}`,
						question.criteria[number] ?? "",
						text => {
							question.criteria = question.criteria.map((level, at) =>
								at === number ? text.trim() : level,
							) as [string, string, ...string[]];
							this.#touch();
						},
						() => this.#showScoreCriteria(index, position),
					);
				},
				accepts: value => value !== "add" && value !== "back",
			},
		);
	}

	#showDecisionState<T extends TransitPartName>(
		label: string,
		parts: readonly T[],
		state: readonly T[] | undefined,
		save: (selected: T[] | undefined) => void,
		back: () => void,
	): void {
		this.#menu(
			"decision-state",
			[
				...parts.map(part => ({ value: part, label: `${state?.includes(part) ? "[x]" : "[ ]"} ${part}` })),
				{ value: "back", label: "Done" },
			],
			undefined,
			`${label} · Space / Enter toggle · Esc back`,
			value => {
				if (value === "back") return back();
				const part = value as (typeof parts)[number];
				const next = parts.filter(candidate =>
					candidate === part ? !state?.includes(candidate) : state?.includes(candidate),
				);
				save(next.length ? next : undefined);
				this.#showDecisionState(label, parts, next, save, back);
			},
			back,
			undefined,
		);
	}

	#showRoute(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "route", index, position });
		const member = this.#modelMember(index, position);
		const mixture = this.#mixture(index);
		if (!member || !mixture) return this.#showMembers(index);
		const route = member.route;
		const back = () => this.#showMember(index, position, "route");
		this.#menu(
			"route",
			[
				{ value: "instructions", label: "Choice instructions", description: preview(route?.instructions, 50) },
				{ value: "state", label: "Judge context", description: route?.state?.join(", ") || "topic + output" },
				{
					value: "confidence",
					label: "Native confidence floor",
					description: String(route?.minConfidence ?? "setting default"),
				},
				{ value: "fallback", label: "Fallback", description: route?.fallback ?? "none" },
				{ value: "remove", label: "Remove route condition" },
				{ value: "back", label: "Back to member" },
			],
			selected,
			`Route from ${member.id} · Enter edit · Esc back`,
			value => {
				if (value === "remove") {
					this.#previousVisitSnapshot = this.navigationSnapshot();
					member.route = undefined;
					this.#touch();
				}
				back();
			},
			back,
			undefined,
			{
				open: value => {
					const again = () => this.#showRoute(index, position, value);
					switch (value) {
						case "instructions":
							this.#editLong(
								"Choice instructions",
								route?.instructions ?? "",
								text => {
									member.route = { ...(member.route ?? { instructions: "" }), instructions: text.trim() };
									this.#touch();
								},
								again,
							);
							break;
						case "state":
							this.#showDecisionState(
								"Route judge context",
								DECISION_PARTS,
								route?.state,
								state => {
									member.route = { ...(member.route ?? { instructions: "" }), state };
									this.#touch();
								},
								again,
							);
							break;
						case "confidence":
							this.#editNumber(
								"Native confidence floor (0–1)",
								route?.minConfidence,
								number => {
									if (number !== undefined && number > 1) {
										this.#cb.notify("Confidence floor must be between 0 and 1");
										return false;
									}
									member.route = { ...(member.route ?? { instructions: "" }), minConfidence: number };
									this.#touch();
								},
								again,
							);
							break;
						case "fallback":
							this.#choose(
								"Route fallback",
								[
									{ value: "", label: "None" },
									{ value: "pause", label: "Pause" },
									...mixture.edges
										.filter(edge => edge.from === member.id)
										.map(edge => ({
											value: mixtureEdgeId(edge),
											label: mixtureEdgeId(edge),
										})),
								],
								route?.fallback,
								fallback => {
									member.route = {
										...(member.route ?? { instructions: "" }),
										fallback: fallback || undefined,
									};
									this.#touch();
								},
								again,
							);
							break;
						default:
							back();
					}
				},
				accepts: value => value !== "remove" && value !== "back",
			},
		);
	}

	#showTerminate(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "terminate", index, position });
		const member = this.#modelMember(index, position);
		if (!member) return this.#showMembers(index);
		const terminate = member.terminate;
		const back = () => this.#showMember(index, position, "terminate");
		this.#menu(
			"terminate",
			[
				{
					value: "instructions",
					label: "Termination condition",
					description: preview(terminate?.instructions, 50),
				},
				{ value: "state", label: "Judge context", description: terminate?.state?.join(", ") || "topic + output" },
				{
					value: "threshold",
					label: "Yes-probability threshold",
					description: String(terminate?.threshold ?? "0.5"),
				},
				{ value: "true", label: "Yes criterion", description: preview(terminate?.criteria?.true, 50) },
				{ value: "false", label: "No criterion", description: preview(terminate?.criteria?.false, 50) },
				{ value: "remove", label: "Remove termination condition" },
				{ value: "back", label: "Back to member" },
			],
			selected,
			`Termination at ${member.id} · Enter edit · Esc back`,
			value => {
				if (value === "remove") {
					this.#previousVisitSnapshot = this.navigationSnapshot();
					member.terminate = undefined;
					this.#touch();
				}
				back();
			},
			back,
			undefined,
			{
				open: value => {
					const again = () => this.#showTerminate(index, position, value);
					if (value === "instructions")
						this.#editLong(
							"Termination condition",
							terminate?.instructions ?? "",
							text => {
								member.terminate = { ...(member.terminate ?? { instructions: "" }), instructions: text.trim() };
								this.#touch();
							},
							again,
						);
					else if (value === "state")
						this.#showDecisionState(
							"Termination judge context",
							DECISION_PARTS,
							terminate?.state,
							state => {
								member.terminate = { ...(member.terminate ?? { instructions: "" }), state };
								this.#touch();
							},
							again,
						);
					else if (value === "threshold")
						this.#editNumber(
							"Yes-probability threshold (0–1)",
							terminate?.threshold,
							number => {
								if (number !== undefined && number > 1) {
									this.#cb.notify("Termination threshold must be between 0 and 1");
									return false;
								}
								member.terminate = { ...(member.terminate ?? { instructions: "" }), threshold: number };
								this.#touch();
							},
							again,
						);
					else if (value === "true" || value === "false")
						this.#editLong(
							`${value === "true" ? "Yes" : "No"} criterion`,
							terminate?.criteria?.[value] ?? "",
							text => {
								member.terminate = {
									...(member.terminate ?? { instructions: "" }),
									criteria: { ...member.terminate?.criteria, [value]: text.trim() || undefined },
								};
								this.#touch();
							},
							again,
						);
					else back();
				},
				accepts: value => value !== "remove" && value !== "back",
			},
		);
	}

	#editNumber(
		label: string,
		current: number | undefined,
		save: (value: number | undefined) => boolean | void,
		back: () => void,
	): void {
		this.#editText(
			label,
			current === undefined ? "" : String(current),
			text => {
				const value = text.trim();
				if (!value) return save(undefined);
				const number = Number(value);
				if (!Number.isFinite(number) || number < 0) {
					this.#cb.notify(`${label}: enter a non-negative number`);
					return false;
				}
				return save(number);
			},
			back,
		);
	}

	#showModelPicker(index: number, position: number): void {
		this.#preparePage({ page: "model", index, position });
		const source = this.#deps.browserSource;
		const models = this.#deps.getAvailableModels().filter(model => model.api !== "mixture");
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder: source.mruOrder });
		const browser = new ModelBrowser(source, {});
		browser.setMruOrder(source.mruOrder);
		browser.setPerfStats(source.modelPerf);
		browser.setItems(items);
		browser.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			if (efforts.length) this.#showThinking(index, position, item.selector, efforts);
			else {
				this.#assignMemberModel(index, position, item.selector, "");
				this.#showMember(index, position, "model");
			}
		};
		browser.onCancel = () => this.#showMember(index, position, "model");
		this.#setScreen("model", browser, "/ search · Enter choose · ←/Esc back");
	}

	#assignMemberModel(index: number, position: number, selector: string, effort: string): void {
		const member = this.#modelMember(index, position);
		if (!member) return;
		this.#previousVisitSnapshot = this.navigationSnapshot();
		member.model = effort ? `${selector}:${effort}` : selector;
		this.#touch();
	}

	#showThinking(index: number, position: number, selector: string, efforts: readonly string[]): void {
		this.#preparePage({ page: "thinking", index, position, selector, efforts });
		this.#choose(
			"Thinking effort",
			[{ value: "", label: "Model default" }, ...efforts.map(effort => ({ value: effort, label: effort }))],
			"",
			effort => this.#assignMemberModel(index, position, selector, effort),
			() => this.#showModelPicker(index, position),
		);
	}

	#showTools(index: number, position: number, cursor = 0): void {
		this.#preparePage({ page: "tools", index, position });
		const member = this.#modelMember(index, position);
		if (!member) return this.#showMembers(index);
		const all = this.#deps.availableToolNames;
		const selected = new Set(member.tools === true ? all : Array.isArray(member.tools) ? member.tools : []);
		const items: SelectItem[] = [
			{ value: "off", label: `${member.tools === false ? "[x]" : "[ ]"} Off` },
			{ value: "all", label: `${member.tools === true ? "[x]" : "[ ]"} All` },
			...all.map(name => ({
				value: name,
				label: `${selected.has(name) && member.tools !== false ? "[x]" : "[ ]"} ${name}`,
			})),
			{ value: "done", label: "Done" },
		];
		this.#menu(
			"tools",
			items,
			items[Math.min(cursor, items.length - 1)]?.value,
			"Space / Enter toggle · Done or Esc return",
			value => {
				if (value === "done") return this.#showMember(index, position, "tools");
				if (value === "off") member.tools = false;
				else if (value === "all") member.tools = true;
				else {
					if (selected.has(value)) selected.delete(value);
					else selected.add(value);
					member.tools = all.filter(name => selected.has(name));
				}
				this.#touch();
				this.#showTools(
					index,
					position,
					items.findIndex(item => item.value === value),
				);
			},
			() => this.#showMember(index, position, "tools"),
			undefined,
		);
	}

	#showEdges(index: number, selected?: string): void {
		this.#preparePage({ page: "edges", index });
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const items: SelectItem[] = mixture.edges.map((edge, position) => ({
			value: `edge:${position}`,
			label: mixtureEdgeId(edge),
			description: Object.keys(edge.x).join(", "),
		}));
		items.push({ value: "add", label: "+ Add edge" }, { value: "back", label: "Back to mixture" });
		this.#menu(
			"edges",
			items,
			selected,
			"Enter edit · Delete remove · Alt+↑↓ reorder · Esc back",
			value => {
				if (value !== "add") {
					this.#showMixture(index, "edges");
					return;
				}
				const from = mixture.members[0]?.id;
				const to = mixture.members[1]?.id;
				if (!from || !to) return this.#cb.notify("Add at least two members before connecting them.");
				mixture.edges.push({ from, to, x: { output: true } });
				this.#touch();
				this.#showEdge(index, mixture.edges.length - 1);
			},
			() => this.#showMixture(index, "edges"),
			(data, list) => {
				const match = /^edge:(\d+)$/.exec(list.getSelectedItem()?.value ?? "");
				if (!match) return false;
				const position = Number(match[1]);
				if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
					const [removed] = mixture.edges.splice(position, 1);
					if (removed) this.#syncFallback(mixture, mixtureEdgeId(removed), undefined);
					this.#touch();
					this.#showEdges(index);
					return true;
				}
				const delta =
					matchesKey(data, "alt+up") || data === "[" ? -1 : matchesKey(data, "alt+down") || data === "]" ? 1 : 0;
				if (!delta || position + delta < 0 || position + delta >= mixture.edges.length) return false;
				const [edge] = mixture.edges.splice(position, 1);
				if (edge) mixture.edges.splice(position + delta, 0, edge);
				this.#touch();
				this.#showEdges(index, `edge:${position + delta}`);
				return true;
			},
			{
				open: value => {
					const match = /^edge:(\d+)$/.exec(value);
					if (match) this.#showEdge(index, Number(match[1]));
					else this.#showMixture(index, "edges");
				},
				accepts: value => value.startsWith("edge:"),
			},
		);
	}

	#edge(index: number, position: number): SequentialEdge | undefined {
		const edge = this.#mixture(index)?.edges[position];
		return edge && !isFanoutEdge(edge) ? edge : undefined;
	}

	#showEdge(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "edge", index, position });
		const edge = this.#edge(index, position);
		const mixture = this.#mixture(index);
		if (!edge || !mixture) return this.#showEdges(index);
		const items: SelectItem[] = [
			{ value: "id", label: "Edge id", description: edge.id ?? "(derived from endpoints)" },
			{ value: "from", label: "From", description: edge.from },
			{ value: "to", label: "To", description: edge.to },
			{ value: "x", label: "Transit parts", description: Object.keys(edge.x).join(", ") },
			{ value: "envelope", label: "Envelope", description: preview(edge.envelope, 50) },
			{ value: "when", label: "When", description: preview(edge.when, 50) },
			{ value: "show", label: "Show source hop", description: edge.show ?? "member default" },
			{ value: "maxTraversals", label: "Maximum traversals", description: String(edge.maxTraversals ?? "default") },
			{ value: "back", label: "Back to edges" },
		];
		this.#menu(
			"edge",
			items,
			selected,
			`Edge ${mixtureEdgeId(edge)} · Enter edit · Esc back`,
			undefined,
			() => this.#showEdges(index, `edge:${position}`),
			undefined,
			{
				open: value => {
					const back = () => this.#showEdge(index, position, value);
					switch (value) {
						case "id":
							this.#editText(
								"Edge id (blank derives from endpoints)",
								edge.id ?? "",
								text => {
									const oldId = mixtureEdgeId(edge);
									edge.id = text.trim() || undefined;
									this.#syncFallback(mixture, oldId, mixtureEdgeId(edge));
									this.#touch();
								},
								back,
							);
							break;
						case "from":
						case "to":
							this.#choose(
								`${value} member`,
								mixture.members.map(member => ({ value: member.id, label: member.id })),
								edge[value],
								id => {
									const oldId = mixtureEdgeId(edge);
									edge[value] = id;
									this.#syncFallback(mixture, oldId, mixtureEdgeId(edge));
									this.#touch();
								},
								back,
							);
							break;
						case "x":
							this.#showTransit(index, position);
							break;
						case "envelope":
							this.#editLong(
								"Envelope template or preset name",
								edge.envelope ?? "",
								text => {
									edge.envelope = text.trim() || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "when":
							this.#editLong(
								"Edge condition",
								edge.when ?? "",
								text => {
									edge.when = text.trim() || undefined;
									this.#touch();
								},
								back,
							);
							break;
						case "show":
							this.#choose(
								"Show source hop",
								["default", "always", "never"].map(choice => ({ value: choice, label: choice })),
								edge.show ?? "default",
								choice => {
									edge.show = choice === "default" ? undefined : (choice as "always" | "never");
									this.#touch();
								},
								back,
							);
							break;
						case "maxTraversals":
							this.#editNumber(
								"Maximum traversals",
								edge.maxTraversals,
								number => {
									edge.maxTraversals = number;
									this.#touch();
								},
								back,
							);
							break;
						default:
							this.#showEdges(index, `edge:${position}`);
					}
				},
			},
		);
	}

	#showTransit(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "transit", index, position });
		const edge = this.#edge(index, position);
		if (!edge) return this.#showEdges(index);
		const items: SelectItem[] = TRANSIT_PART_NAMES.map(part => ({
			value: part,
			label: `${edge.x[part] ? "[x]" : "[ ]"} ${part}${part === "transcript" && edge.x.transcript && edge.x.transcript !== true ? ` (${edge.x.transcript.optimize ?? "verbatim"})` : ""}`,
		}));
		items.push({ value: "back", label: "Done" });
		this.#menu(
			"transit",
			items,
			selected,
			"Space / Enter toggle parts · Transcript opens optimization settings · Esc back",
			value => {
				if (value === "back") return this.#showEdge(index, position, "x");
				const part = value as Exclude<TransitPartName, "transcript">;
				if (edge.x[part]) delete edge.x[part];
				else edge.x[part] = true;
				this.#touch();
				this.#showTransit(index, position, value);
			},
			() => this.#showEdge(index, position, "x"),
			undefined,
			{ open: () => this.#showTranscript(index, position), accepts: value => value === "transcript" },
		);
	}

	#showTranscript(index: number, position: number, selected?: string): void {
		this.#preparePage({ page: "transcript", index, position });
		const edge = this.#edge(index, position);
		if (!edge) return this.#showEdges(index);
		const spec = edge.x.transcript;
		const optimize = spec && spec !== true ? (spec.optimize ?? "verbatim") : "verbatim";
		const budget = spec && spec !== true ? spec.budgetTokens : undefined;
		this.#menu(
			"transcript",
			[
				{ value: "mode", label: "Optimization", description: spec ? optimize : "off" },
				{ value: "budget", label: "Token budget", description: String(budget ?? "setting default") },
				{ value: "back", label: "Back to transit parts" },
			],
			selected,
			"Transcript transit · Enter edit · Esc back",
			undefined,
			() => this.#showTransit(index, position, "transcript"),
			undefined,
			{
				open: value => {
					const back = () => this.#showTranscript(index, position, value);
					if (value === "mode")
						this.#choose(
							"Transcript optimization",
							[
								{ value: "off", label: "Off" },
								{ value: "verbatim", label: "Verbatim; omit older hops" },
								{ value: "compact", label: "Compact; summarize older hops" },
								{ value: "snapcompact", label: "Snapcompact; preserve history frames" },
							],
							spec ? optimize : "off",
							mode => {
								if (mode === "off") delete edge.x.transcript;
								else
									edge.x.transcript = {
										optimize: mode as "verbatim" | "compact" | "snapcompact",
										budgetTokens: budget,
									};
								this.#touch();
							},
							back,
						);
					else if (value === "budget")
						this.#editNumber(
							"Transcript token budget",
							budget,
							number => {
								if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
									this.#cb.notify("Transcript budget must be a positive integer");
									return false;
								}
								edge.x.transcript = { optimize, budgetTokens: number };
								this.#touch();
							},
							back,
						);
					else this.#showTransit(index, position, "transcript");
				},
			},
		);
	}

	#showLimits(index: number, selected?: string): void {
		this.#preparePage({ page: "limits", index });
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const limits = mixture.limits ?? {};
		const items: SelectItem[] = [
			{ value: "maxHops", label: "Maximum hops", description: String(limits.maxHops ?? "default") },
			{ value: "budgetUsd", label: "Budget (USD)", description: String(limits.budgetUsd ?? "setting default") },
			{
				value: "wallClockMinutes",
				label: "Wall clock (minutes)",
				description: String(limits.wallClockMinutes ?? "setting default"),
			},
			{ value: "onLimit", label: "On limit", description: limits.onLimit ?? "setting default" },
			{ value: "limitTarget", label: "Limit judge member", description: limits.limitTarget ?? "none" },
			{ value: "back", label: "Back to mixture" },
		];
		this.#menu(
			"limits",
			items,
			selected,
			"Enter edit · Esc back",
			undefined,
			() => this.#showMixture(index, "limits"),
			undefined,
			{
				open: value => {
					if (value === "back") return this.#showMixture(index, "limits");
					const back = () => this.#showLimits(index, value);
					if (value === "onLimit")
						this.#choose(
							"On limit",
							[
								{ value: "default", label: "Setting default" },
								...["stop", "pause", "judge"].map(choice => ({ value: choice, label: choice })),
							],
							limits.onLimit ?? "default",
							choice => {
								(mixture.limits ??= {}).onLimit =
									choice === "default" ? undefined : (choice as "stop" | "pause" | "judge");
								this.#touch();
							},
							back,
						);
					else if (value === "limitTarget")
						this.#choose(
							"Limit target",
							[
								{ value: "", label: "None" },
								...mixture.members
									.filter(member => member.kind !== "verdict")
									.map(member => ({ value: member.id, label: member.id })),
							],
							limits.limitTarget,
							id => {
								(mixture.limits ??= {}).limitTarget = id || undefined;
								this.#touch();
							},
							back,
						);
					else if (value === "maxHops" || value === "budgetUsd" || value === "wallClockMinutes")
						this.#editNumber(
							value,
							limits[value],
							number => {
								(mixture.limits ??= {})[value] = number;
								this.#touch();
							},
							back,
						);
				},
			},
		);
	}

	#showPresets(index: number, kind: "roles" | "envelopes", selected?: string): void {
		this.#preparePage({ page: "presets", index, kind });
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const presets = mixture[kind] ?? {};
		const names = Object.keys(presets);
		const items: SelectItem[] = names.map(name => ({
			value: name,
			label: name,
			description: preview(presets[name], 50),
		}));
		items.push({ value: "__add", label: "+ Add preset" }, { value: "__back", label: "Back" });
		this.#menu(
			"presets",
			items,
			selected,
			"Enter edit text · Delete remove · Esc back",
			undefined,
			() => this.#showMixture(index, kind),
			(data, list) => {
				const value = list.getSelectedItem()?.value;
				if (!value || value.startsWith("__") || (!matchesKey(data, "delete") && !matchesKey(data, "backspace")))
					return false;
				delete presets[value];
				this.#touch();
				this.#showPresets(index, kind);
				return true;
			},
			{
				open: value => {
					if (value === "__back") return this.#showMixture(index, kind);
					if (value === "__add")
						this.#editText(
							"Preset name",
							"",
							text => {
								const name = text.trim();
								if (!name) return;
								(mixture[kind] ??= {})[name] = "";
								this.#touch();
								this.#showPresetEditor(index, kind, name);
							},
							() => this.#showPresets(index, kind),
						);
					else this.#showPresetEditor(index, kind, value);
				},
				accepts: value => value !== "__back",
				navigable: value => value !== "__add",
			},
		);
	}

	#showPresetEditor(index: number, kind: "roles" | "envelopes", name: string): void {
		this.#preparePage({ page: "preset", index, kind, name });
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		this.#editLong(
			`${kind} / ${name}`,
			mixture[kind]?.[name] ?? "",
			content => {
				(mixture[kind] ??= {})[name] = content;
				this.#touch();
			},
			() => this.#showPresets(index, kind, name),
		);
	}

	get blocksMenuHistory(): boolean {
		return (
			this.#pendingOperations > 0 || (this.#active instanceof HookEditorComponent && this.#active.blocksMenuHistory)
		);
	}

	navigationSnapshot(): MixtureNavigationSnapshot {
		const list =
			this.#screen === "discard"
				? this.#listStates.get(this.#pageKey(this.#navigationContext, this.#navigationScope))
				: undefined;
		return {
			context: structuredClone(this.#navigationContext),
			scope: this.#scope,
			doc: structuredClone(this.#doc),
			dirty: this.#dirty,
			pendingApply: this.#pendingApply,
			previewScroll: list?.previewScroll ?? this.#previewScroll,
			previewFocused: list?.previewFocused ?? this.#previewFocused,
			lists: structuredClone([...this.#listStates]),
			content:
				list?.navigation ??
				(this.#active instanceof Input
					? { value: this.#active.getValue(), cursor: this.#active.getCursor() }
					: isMenuHistoryParticipant(this.#active)
						? this.#active.navigationSnapshot()
						: undefined),
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as MixtureNavigationSnapshot;
		if (
			!state.context ||
			!state.doc ||
			!Array.isArray(state.doc.mixtures) ||
			(state.scope !== "project" && state.scope !== "user")
		)
			return;
		this.#keys.reset();
		this.#loadRevision++;
		this.#restoringNavigation = true;
		try {
			this.#scope = state.scope;
			this.#doc = structuredClone(state.doc);
			this.#dirty = state.dirty;
			this.#pendingApply = state.pendingApply;
			this.#pendingDelete = null;
			this.#previousVisitSnapshot = undefined;
			this.#listStates.clear();
			for (const [key, list] of state.lists ?? []) this.#listStates.set(key, structuredClone(list));
			if (state.context.page === "field") {
				this.#buildPage(state.context.parent);
				this.#openField(state.context.key);
			} else this.#buildPage(state.context);
			if (this.#active instanceof Input && typeof state.content === "object" && state.content !== null) {
				const field = state.content as { value?: string; cursor?: number };
				if (typeof field.value === "string") this.#active.setValue(field.value);
				if (typeof field.cursor === "number") this.#active.setCursor(field.cursor);
			} else if (isMenuHistoryParticipant(this.#active)) this.#active.restoreNavigation(state.content);
			this.#previewScroll = state.previewScroll;
			this.#previewFocused = state.context.page === "list" && state.previewFocused;
		} finally {
			this.#restoringNavigation = false;
		}
		this.#cb.requestRender();
	}

	#buildPage(context: MixturePageContext): void {
		switch (context.page) {
			case "list":
				this.#showList();
				break;
			case "mixture":
				this.#showMixture(context.index);
				break;
			case "members":
				this.#showMembers(context.index);
				break;
			case "member":
				this.#showMember(context.index, context.position);
				break;
			case "verdict":
				this.#showVerdict(context.index, context.position);
				break;
			case "choice-criteria":
				this.#showChoiceCriteria(context.index, context.position);
				break;
			case "choice-option":
				this.#showChoiceOption(context.index, context.position, context.name);
				break;
			case "score-criteria":
				this.#showScoreCriteria(context.index, context.position);
				break;
			case "route":
				this.#showRoute(context.index, context.position);
				break;
			case "terminate":
				this.#showTerminate(context.index, context.position);
				break;
			case "model":
				this.#showModelPicker(context.index, context.position);
				break;
			case "thinking":
				this.#showThinking(context.index, context.position, context.selector, context.efforts);
				break;
			case "tools":
				this.#showTools(context.index, context.position);
				break;
			case "edges":
				this.#showEdges(context.index);
				break;
			case "edge":
				this.#showEdge(context.index, context.position);
				break;
			case "transit":
				this.#showTransit(context.index, context.position);
				break;
			case "transcript":
				this.#showTranscript(context.index, context.position);
				break;
			case "limits":
				this.#showLimits(context.index);
				break;
			case "presets":
				this.#showPresets(context.index, context.kind);
				break;
			case "preset":
				this.#showPresetEditor(context.index, context.kind, context.name);
				break;
		}
	}

	leaveMenu(): void {
		this.#keys.reset();
		this.#loadRevision++;
		this.#pendingDelete = null;
		this.#buildingContext = undefined;
		this.#previousVisitSnapshot = undefined;
	}

	dispose(): void {
		this.leaveMenu();
		if (this.#active instanceof HookEditorComponent) this.#active.dispose();
	}
}
