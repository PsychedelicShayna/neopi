import { t } from "@oh-my-pi/pi-utils/i18n";
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
	return first ? truncateToWidth(first, width) : t("overlaysModel.mixtureConfig.none");
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
		const title = t("overlaysModel.mixtureConfig.heading", {
			scope:
				this.#scope === "user"
					? t("overlaysModel.mixtureConfig.scope.user")
					: t("overlaysModel.mixtureConfig.scope.project"),
			state: this.#dirty
				? t("overlaysModel.mixtureConfig.unsavedSuffix")
				: this.#pendingApply
					? t("overlaysModel.mixtureConfig.pendingApplySuffix")
					: "",
		});
		this.#split.setNarrowPane(this.#screen === "list" && this.#previewFocused ? "right" : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(this.#bodyRows);
		const geometry = this.#split.measure(width);
		const left = geometry.left?.width ?? 0;
		this.#top.setLines([geometry.mode === "split" ? topBorderSplit(width, title, left) : topBorder(width, title)]);
		this.#divider.setLines([geometry.mode === "split" ? dividerSplit(width, left) : divider(width)]);
		const status = this.#dirty
			? t("overlaysModel.mixtureConfig.unsavedStatus")
			: this.#pendingApply
				? t("overlaysModel.mixtureConfig.pendingApplyStatus")
				: "";
		const pane =
			this.#screen === "list"
				? `${this.#previewFocused ? t("overlaysModel.mixtureConfig.preview") : t("overlaysModel.mixtureConfig.list")} · `
				: "";
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
		if (!mixture) return [...warnings, theme.fg("muted", t("overlaysModel.mixtureConfig.chooseMixture"))];
		const lines = [
			theme.bold(sanitizeDisplayLine(mixture.name)),
			preview(mixture.description, width),
			"",
			t("overlaysModel.mixtureConfig.entry", { member: sanitizeDisplayLine(mixture.entry) }),
			"",
			t("overlaysModel.mixtureConfig.membersHeading"),
		];
		for (const member of mixture.members) {
			lines.push(
				`  ${sanitizeDisplayLine(member.id)} · ${member.kind === "verdict" ? t("overlaysModel.mixtureConfig.verdict") : sanitizeDisplayLine(member.model || t("overlaysModel.mixtureConfig.chooseModel"))}`,
			);
		}
		lines.push("", t("overlaysModel.mixtureConfig.flow"));
		for (const edge of mixture.edges) {
			const destination = isFanoutEdge(edge) ? `[${edge.to.join(", ")}] ⇢ ${edge.join}` : edge.to;
			const label = edge.id ? ` · ${edge.id}` : "";
			lines.push(
				`  ${sanitizeDisplayLine(edge.from)} → ${sanitizeDisplayLine(destination)}${sanitizeDisplayLine(label)}`,
			);
			lines.push(
				t("overlaysModel.mixtureConfig.handoff", {
					parts: Object.keys(edge.x).join(", ") || t("overlaysModel.mixtureConfig.noParts"),
				}),
			);
		}
		if (mixture.edges.length === 0) lines.push(t("overlaysModel.mixtureConfig.noEdges"));
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
				? t("overlaysModel.mixtureConfig.paneNavigation")
				: screen === "discard"
					? t("overlaysModel.mixtureConfig.keepEditingNavigation")
					: context.page === "thinking"
						? t("overlaysModel.mixtureConfig.effortNavigation")
						: context.page !== "field" && this.#openers.size > 0
							? t("overlaysModel.mixtureConfig.parentOpenNavigation")
							: t("overlaysModel.mixtureConfig.parentNavigation");
		this.#footer =
			active instanceof SelectList
				? t("overlaysModel.mixtureConfig.navigationHint", { navigation, footer })
				: footer;
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
					? t("overlaysModel.mixtureConfig.deleteMixture", { name: mixture.name })
					: `${active === mixture.name ? "●" : "○"} ${mixture.name}`,
			description:
				this.#pendingDelete === index
					? t("overlaysModel.mixtureConfig.confirmDelete")
					: t("overlaysModel.mixtureConfig.mixtureSummary", {
							members: mixture.members.length,
							edges: mixture.edges.length,
						}),
		}));
		items.push(
			{ value: "new", label: t("overlaysModel.mixtureConfig.createMixture") },
			{
				value: "scope",
				label: t("overlaysModel.mixtureConfig.scopeLabel", {
					scope:
						this.#scope === "user"
							? t("overlaysModel.mixtureConfig.scope.user")
							: t("overlaysModel.mixtureConfig.scope.project"),
				}),
				description: `→ ${this.#otherScope() === "user" ? t("overlaysModel.mixtureConfig.scope.user") : t("overlaysModel.mixtureConfig.scope.project")}`,
			},
			{ value: "save", label: t("overlaysModel.mixtureConfig.saveOnly") },
			{ value: "apply", label: t("overlaysModel.mixtureConfig.saveApply") },
			{ value: "close", label: t("overlaysModel.mixtureConfig.close") },
		);
		this.#menu(
			"list",
			items,
			selected,
			this.#pendingDelete !== null
				? t("overlaysModel.mixtureConfig.deleteHint")
				: t("overlaysModel.mixtureConfig.listHint"),
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
				{
					value: "keep",
					label: t("overlaysModel.mixtureConfig.keepEditing"),
					description: t("overlaysModel.mixtureConfig.returnToList"),
				},
				{
					value: "discard",
					label: t("overlaysModel.mixtureConfig.discardClose"),
					description: t("overlaysModel.mixtureConfig.changesLost"),
				},
			],
			"keep",
			t("overlaysModel.mixtureConfig.discardHint"),
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
			this.#cb.notify(t("overlaysModel.mixtureConfig.nothingToApply"));
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
				this.#cb.notify(t("overlaysModel.mixtureConfig.saveBeforeScope"));
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
			t("overlaysModel.mixtureConfig.newMixtureName"),
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
		this.#setScreen("input", input, t("overlaysModel.mixtureConfig.editTextHint", { label }));
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
		this.#setScreen("editor", editor, t("overlaysModel.mixtureConfig.editorHint"));
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
			t("overlaysModel.mixtureConfig.chooseHint", { label }),
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
			{ value: "name", label: t("overlaysModel.mixtureConfig.name"), description: mixture.name },
			{
				value: "description",
				label: t("overlaysModel.mixtureConfig.description"),
				description: preview(mixture.description, 55),
			},
			{ value: "entry", label: t("overlaysModel.mixtureConfig.entryMember"), description: mixture.entry },
			{
				value: "members",
				label: t("overlaysModel.mixtureConfig.membersLabel", { count: mixture.members.length }),
				description: mixture.members.map(member => member.id).join(" → "),
			},
			{
				value: "edges",
				label: t("overlaysModel.mixtureConfig.edgesLabel", { count: mixture.edges.length }),
				description: mixture.edges.map(mixtureEdgeId).join(", "),
			},
			{
				value: "limits",
				label: t("overlaysModel.mixtureConfig.limits"),
				description: mixture.limits
					? t("overlaysModel.mixtureConfig.limitHops", {
							count: mixture.limits.maxHops ?? t("overlaysModel.mixtureConfig.defaultLower"),
						})
					: t("overlaysModel.mixtureConfig.defaults"),
			},
			{
				value: "roles",
				label: t("overlaysModel.mixtureConfig.rolePresets"),
				description: t("overlaysModel.mixtureConfig.localPresets", {
					count: Object.keys(mixture.roles ?? {}).length,
				}),
			},
			{
				value: "envelopes",
				label: t("overlaysModel.mixtureConfig.envelopePresets"),
				description: t("overlaysModel.mixtureConfig.localPresets", {
					count: Object.keys(mixture.envelopes ?? {}).length,
				}),
			},
			{ value: "back", label: t("overlaysModel.mixtureConfig.backToMixtures") },
		];
		this.#menu(
			"mixture",
			items,
			selected,
			t("overlaysModel.mixtureConfig.editMixtureHint", { name: mixture.name }),
			undefined,
			() => this.#showList(`mixture:${index}`),
			undefined,
			{
				open: value => {
					switch (value) {
						case "name":
							this.#editText(
								t("overlaysModel.mixtureConfig.mixtureName"),
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
								t("overlaysModel.mixtureConfig.description"),
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
								t("overlaysModel.mixtureConfig.entryMember"),
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
			description:
				member.kind === "verdict"
					? t("overlaysModel.mixtureConfig.verdict")
					: member.model || t("overlaysModel.mixtureConfig.modelMissing"),
		}));
		items.push(
			{ value: "add", label: t("overlaysModel.mixtureConfig.addModelMember") },
			{ value: "verdict", label: t("overlaysModel.mixtureConfig.addVerdictMember") },
			{ value: "back", label: t("overlaysModel.mixtureConfig.backToMixture") },
		);
		this.#menu(
			"members",
			items,
			selected,
			t("overlaysModel.mixtureConfig.membersHint"),
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
							t("overlaysModel.mixtureConfig.memberId"),
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
							t("overlaysModel.mixtureConfig.verdictMemberId"),
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
			{ value: "id", label: t("overlaysModel.mixtureConfig.memberId"), description: member.id },
			{
				value: "model",
				label: t("overlaysModel.mixtureConfig.model"),
				description: member.model || t("overlaysModel.mixtureConfig.selectModel"),
			},
			{
				value: "description",
				label: t("overlaysModel.mixtureConfig.description"),
				description: preview(member.description, 50),
			},
			{
				value: "role",
				label: t("overlaysModel.mixtureConfig.rolePrompt"),
				description: preview(member.systemPrompt, 50),
			},
			{
				value: "rolePreset",
				label: t("overlaysModel.mixtureConfig.rolePreset"),
				description: member.role ?? t("overlaysModel.mixtureConfig.none"),
			},
			{
				value: "inherit",
				label: t("overlaysModel.mixtureConfig.inherit"),
				description:
					member.inherit === undefined
						? t("overlaysModel.mixtureConfig.automaticLower")
						: member.inherit
							? t("overlaysModel.mixtureConfig.yesLower")
							: t("overlaysModel.mixtureConfig.noLower"),
			},
			{
				value: "tools",
				label: t("overlaysModel.mixtureConfig.tools"),
				description:
					member.tools === true
						? t("overlaysModel.mixtureConfig.allLower")
						: Array.isArray(member.tools)
							? member.tools.join(", ")
							: t("overlaysModel.mixtureConfig.offLower"),
			},
			{
				value: "show",
				label: t("overlaysModel.mixtureConfig.show"),
				description: member.show ?? t("overlaysModel.mixtureConfig.defaultLower"),
			},
			{
				value: "maxTokens",
				label: t("overlaysModel.mixtureConfig.maximumOutputTokens"),
				description: String(member.maxTokens ?? t("overlaysModel.mixtureConfig.modelDefaultLower")),
			},
			{
				value: "route",
				label: t("overlaysModel.mixtureConfig.routeInstructions"),
				description: preview(member.route?.instructions, 50),
			},
			{
				value: "terminate",
				label: t("overlaysModel.mixtureConfig.terminationInstructions"),
				description: preview(member.terminate?.instructions, 50),
			},
			{ value: "back", label: t("overlaysModel.mixtureConfig.backToMembers") },
		];
		this.#menu(
			"member",
			items,
			selected,
			t("overlaysModel.mixtureConfig.memberHint", { id: member.id }),
			undefined,
			() => this.#showMembers(index, `member:${position}`),
			undefined,
			{
				open: value => {
					const back = () => this.#showMember(index, position, value);
					switch (value) {
						case "id":
							this.#editText(
								t("overlaysModel.mixtureConfig.memberId"),
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
								t("overlaysModel.mixtureConfig.memberDescription"),
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
								t("overlaysModel.mixtureConfig.rolePrompt"),
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
								t("overlaysModel.mixtureConfig.rolePresetName"),
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
								t("overlaysModel.mixtureConfig.inherit"),
								[
									{ value: "default", label: t("overlaysModel.mixtureConfig.automatic") },
									{ value: "yes", label: t("overlaysModel.mixtureConfig.yes") },
									{ value: "no", label: t("overlaysModel.mixtureConfig.no") },
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
								t("overlaysModel.mixtureConfig.showHop"),
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
								t("overlaysModel.mixtureConfig.maximumOutputTokens"),
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
			{ value: "id", label: t("overlaysModel.mixtureConfig.memberId"), description: member.id },
			{
				value: "description",
				label: t("overlaysModel.mixtureConfig.description"),
				description: preview(member.description, 50),
			},
			{
				value: "show",
				label: t("overlaysModel.mixtureConfig.show"),
				description: member.show ?? t("overlaysModel.mixtureConfig.defaultLower"),
			},
			{ value: "type", label: t("overlaysModel.mixtureConfig.questionType"), description: question.type },
			{
				value: "instructions",
				label: t("overlaysModel.mixtureConfig.questionInstructions"),
				description: preview(question.instructions, 50),
			},
			{
				value: "state",
				label: t("overlaysModel.mixtureConfig.judgeContext"),
				description: member.state?.join(", ") || t("overlaysModel.mixtureConfig.topicTransit"),
			},
			{
				value: "render",
				label: t("overlaysModel.mixtureConfig.answerTemplate"),
				description: preview(member.render, 50),
			},
		];
		if (question.type === "choice" || question.type === "score")
			items.push({
				value: "criteria",
				label:
					question.type === "choice"
						? t("overlaysModel.mixtureConfig.optionsRubrics")
						: t("overlaysModel.mixtureConfig.orderedScoreLevels"),
				description: String(
					question.type === "choice" ? Object.keys(question.criteria).length : question.criteria.length,
				),
			});
		else
			items.push(
				{
					value: "true",
					label: t("overlaysModel.mixtureConfig.yesCriterion"),
					description: preview(question.criteria?.true, 50),
				},
				{
					value: "false",
					label: t("overlaysModel.mixtureConfig.noCriterion"),
					description: preview(question.criteria?.false, 50),
				},
			);
		items.push({ value: "back", label: t("overlaysModel.mixtureConfig.backToMembers") });
		this.#menu(
			"verdict",
			items,
			selected,
			t("overlaysModel.mixtureConfig.verdictHint", { id: member.id }),
			undefined,
			() => this.#showMembers(index, `member:${position}`),
			undefined,
			{
				open: value => {
					const back = () => this.#showVerdict(index, position, value);
					switch (value) {
						case "id":
							this.#editText(
								t("overlaysModel.mixtureConfig.verdictId"),
								member.id,
								text => this.#renameMember(mixture, member, text.trim()),
								back,
							);
							break;
						case "description":
							this.#editText(
								t("overlaysModel.mixtureConfig.verdictDescription"),
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
								t("overlaysModel.mixtureConfig.showVerdict"),
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
								t("overlaysModel.mixtureConfig.questionType"),
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
								t("overlaysModel.mixtureConfig.verdictQuestion"),
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
								t("overlaysModel.mixtureConfig.verdictJudgeContext"),
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
								t("overlaysModel.mixtureConfig.verdictAnswerTemplate"),
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
								value === "true"
									? t("overlaysModel.mixtureConfig.yesCriterion")
									: t("overlaysModel.mixtureConfig.noCriterion"),
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
				{ value: "__add", label: t("overlaysModel.mixtureConfig.addOption") },
				{ value: "__back", label: t("overlaysModel.mixtureConfig.backToVerdict") },
			],
			selected,
			t("overlaysModel.mixtureConfig.optionsHint"),
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
							t("overlaysModel.mixtureConfig.choiceOptionName"),
							"",
							text => {
								const name = text.trim();
								if (!name || Object.hasOwn(criteria, name)) {
									this.#cb.notify(t("overlaysModel.mixtureConfig.uniqueOption"));
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
				{ value: "name", label: t("overlaysModel.mixtureConfig.optionName"), description: name },
				{
					value: "rubric",
					label: t("overlaysModel.mixtureConfig.rubric"),
					description: preview(criteria[name] ?? undefined, 50),
				},
				{ value: "back", label: t("overlaysModel.mixtureConfig.backToOptions") },
			],
			undefined,
			t("overlaysModel.mixtureConfig.optionHint", { name }),
			undefined,
			() => this.#showChoiceCriteria(index, position, name),
			undefined,
			{
				open: value => {
					if (value === "name")
						this.#editText(
							t("overlaysModel.mixtureConfig.choiceOptionName"),
							name,
							text => {
								const updated = text.trim();
								if (!updated || (updated !== name && Object.hasOwn(criteria, updated))) {
									this.#cb.notify(t("overlaysModel.mixtureConfig.uniqueOption"));
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
							t("overlaysModel.mixtureConfig.rubricHint"),
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
					label: t("overlaysModel.mixtureConfig.level", { number: number + 1 }),
					description: preview(level, 50),
				})),
				{ value: "add", label: t("overlaysModel.mixtureConfig.addLevel") },
				{ value: "back", label: t("overlaysModel.mixtureConfig.backToVerdict") },
			],
			undefined,
			t("overlaysModel.mixtureConfig.scoreLevelsHint"),
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
					this.#cb.notify(t("overlaysModel.mixtureConfig.twoScoreLevels"));
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
						t("overlaysModel.mixtureConfig.level", { number: number + 1 }),
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
				{ value: "back", label: t("overlaysModel.mixtureConfig.done") },
			],
			undefined,
			t("overlaysModel.mixtureConfig.stateHint", { label }),
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
				{
					value: "instructions",
					label: t("overlaysModel.mixtureConfig.choiceInstructions"),
					description: preview(route?.instructions, 50),
				},
				{
					value: "state",
					label: t("overlaysModel.mixtureConfig.judgeContext"),
					description: route?.state?.join(", ") || t("overlaysModel.mixtureConfig.topicOutput"),
				},
				{
					value: "confidence",
					label: t("overlaysModel.mixtureConfig.nativeConfidenceFloor"),
					description: String(route?.minConfidence ?? t("overlaysModel.mixtureConfig.settingDefaultLower")),
				},
				{
					value: "fallback",
					label: t("overlaysModel.mixtureConfig.fallback"),
					description: route?.fallback ?? t("overlaysModel.mixtureConfig.noneLower"),
				},
				{ value: "remove", label: t("overlaysModel.mixtureConfig.removeRouteCondition") },
				{ value: "back", label: t("overlaysModel.mixtureConfig.backToMember") },
			],
			selected,
			t("overlaysModel.mixtureConfig.routeHint", { id: member.id }),
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
								t("overlaysModel.mixtureConfig.choiceInstructions"),
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
								t("overlaysModel.mixtureConfig.routeJudgeContext"),
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
								t("overlaysModel.mixtureConfig.confidenceFloorRange"),
								route?.minConfidence,
								number => {
									if (number !== undefined && number > 1) {
										this.#cb.notify(t("overlaysModel.mixtureConfig.confidenceRangeError"));
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
								t("overlaysModel.mixtureConfig.routeFallback"),
								[
									{ value: "", label: t("overlaysModel.mixtureConfig.noneCaps") },
									{ value: "pause", label: t("overlaysModel.mixtureConfig.pause") },
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
					label: t("overlaysModel.mixtureConfig.terminateCondition"),
					description: preview(terminate?.instructions, 50),
				},
				{
					value: "state",
					label: t("overlaysModel.mixtureConfig.judgeContext"),
					description: terminate?.state?.join(", ") || t("overlaysModel.mixtureConfig.topicOutput"),
				},
				{
					value: "threshold",
					label: t("overlaysModel.mixtureConfig.yesProbabilityThreshold"),
					description: String(terminate?.threshold ?? "0.5"),
				},
				{
					value: "true",
					label: t("overlaysModel.mixtureConfig.yesCriterion"),
					description: preview(terminate?.criteria?.true, 50),
				},
				{
					value: "false",
					label: t("overlaysModel.mixtureConfig.noCriterion"),
					description: preview(terminate?.criteria?.false, 50),
				},
				{ value: "remove", label: t("overlaysModel.mixtureConfig.removeTerminateCondition") },
				{ value: "back", label: t("overlaysModel.mixtureConfig.backToMember") },
			],
			selected,
			t("overlaysModel.mixtureConfig.terminationHint", { id: member.id }),
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
							t("overlaysModel.mixtureConfig.terminateCondition"),
							terminate?.instructions ?? "",
							text => {
								member.terminate = { ...(member.terminate ?? { instructions: "" }), instructions: text.trim() };
								this.#touch();
							},
							again,
						);
					else if (value === "state")
						this.#showDecisionState(
							t("overlaysModel.mixtureConfig.terminateJudgeContext"),
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
							t("overlaysModel.mixtureConfig.yesProbabilityRange"),
							terminate?.threshold,
							number => {
								if (number !== undefined && number > 1) {
									this.#cb.notify(t("overlaysModel.mixtureConfig.terminateThresholdRangeError"));
									return false;
								}
								member.terminate = { ...(member.terminate ?? { instructions: "" }), threshold: number };
								this.#touch();
							},
							again,
						);
					else if (value === "true" || value === "false")
						this.#editLong(
							value === "true"
								? t("overlaysModel.mixtureConfig.yesCriterion")
								: t("overlaysModel.mixtureConfig.noCriterion"),
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
					this.#cb.notify(t("overlaysModel.mixtureConfig.nonNegativeNumber", { label }));
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
		this.#setScreen("model", browser, t("overlaysModel.mixtureConfig.modelHint"));
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
			t("overlaysModel.mixtureConfig.thinkingEffort"),
			[
				{ value: "", label: t("overlaysModel.mixtureConfig.modelDefault") },
				...efforts.map(effort => ({ value: effort, label: effort })),
			],
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
			{
				value: "off",
				label: t("overlaysModel.mixtureConfig.toolOff", { mark: member.tools === false ? "[x]" : "[ ]" }),
			},
			{
				value: "all",
				label: t("overlaysModel.mixtureConfig.toolAll", { mark: member.tools === true ? "[x]" : "[ ]" }),
			},
			...all.map(name => ({
				value: name,
				label: `${selected.has(name) && member.tools !== false ? "[x]" : "[ ]"} ${name}`,
			})),
			{ value: "done", label: t("overlaysModel.mixtureConfig.done") },
		];
		this.#menu(
			"tools",
			items,
			items[Math.min(cursor, items.length - 1)]?.value,
			t("overlaysModel.mixtureConfig.toolsHint"),
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
		items.push(
			{ value: "add", label: t("overlaysModel.mixtureConfig.addEdge") },
			{ value: "back", label: t("overlaysModel.mixtureConfig.backToMixture") },
		);
		this.#menu(
			"edges",
			items,
			selected,
			t("overlaysModel.mixtureConfig.edgesHint"),
			value => {
				if (value !== "add") {
					this.#showMixture(index, "edges");
					return;
				}
				const from = mixture.members[0]?.id;
				const to = mixture.members[1]?.id;
				if (!from || !to) return this.#cb.notify(t("overlaysModel.mixtureConfig.twoMembersForEdge"));
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
			{
				value: "id",
				label: t("overlaysModel.mixtureConfig.edgeId"),
				description: edge.id ?? t("overlaysModel.mixtureConfig.derivedId"),
			},
			{ value: "from", label: t("overlaysModel.mixtureConfig.from"), description: edge.from },
			{ value: "to", label: t("overlaysModel.mixtureConfig.to"), description: edge.to },
			{
				value: "x",
				label: t("overlaysModel.mixtureConfig.transitParts"),
				description: Object.keys(edge.x).join(", "),
			},
			{
				value: "envelope",
				label: t("overlaysModel.mixtureConfig.envelope"),
				description: preview(edge.envelope, 50),
			},
			{ value: "when", label: t("overlaysModel.mixtureConfig.when"), description: preview(edge.when, 50) },
			{
				value: "show",
				label: t("overlaysModel.mixtureConfig.showSourceHop"),
				description: edge.show ?? t("overlaysModel.mixtureConfig.memberDefault"),
			},
			{
				value: "maxTraversals",
				label: t("overlaysModel.mixtureConfig.maximumTraversals"),
				description: String(edge.maxTraversals ?? t("overlaysModel.mixtureConfig.defaultLower")),
			},
			{ value: "back", label: t("overlaysModel.mixtureConfig.backToEdges") },
		];
		this.#menu(
			"edge",
			items,
			selected,
			t("overlaysModel.mixtureConfig.edgeHint", { id: mixtureEdgeId(edge) }),
			undefined,
			() => this.#showEdges(index, `edge:${position}`),
			undefined,
			{
				open: value => {
					const back = () => this.#showEdge(index, position, value);
					switch (value) {
						case "id":
							this.#editText(
								t("overlaysModel.mixtureConfig.edgeIdHint"),
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
								value === "from"
									? t("overlaysModel.mixtureConfig.fromMember")
									: t("overlaysModel.mixtureConfig.toMember"),
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
								t("overlaysModel.mixtureConfig.envelopeTemplate"),
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
								t("overlaysModel.mixtureConfig.edgeCondition"),
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
								t("overlaysModel.mixtureConfig.showSourceHop"),
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
								t("overlaysModel.mixtureConfig.maximumTraversals"),
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
		items.push({ value: "back", label: t("overlaysModel.mixtureConfig.done") });
		this.#menu(
			"transit",
			items,
			selected,
			t("overlaysModel.mixtureConfig.transitHint"),
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
				{
					value: "mode",
					label: t("overlaysModel.mixtureConfig.optimization"),
					description: spec ? optimize : t("overlaysModel.mixtureConfig.offLower"),
				},
				{
					value: "budget",
					label: t("overlaysModel.mixtureConfig.tokenBudget"),
					description: String(budget ?? t("overlaysModel.mixtureConfig.settingDefaultLower")),
				},
				{ value: "back", label: t("overlaysModel.mixtureConfig.backToTransitParts") },
			],
			selected,
			t("overlaysModel.mixtureConfig.transcriptHint"),
			undefined,
			() => this.#showTransit(index, position, "transcript"),
			undefined,
			{
				open: value => {
					const back = () => this.#showTranscript(index, position, value);
					if (value === "mode")
						this.#choose(
							t("overlaysModel.mixtureConfig.transcriptOptimization"),
							[
								{ value: "off", label: t("overlaysModel.mixtureConfig.off") },
								{ value: "verbatim", label: t("overlaysModel.mixtureConfig.verbatim") },
								{ value: "compact", label: t("overlaysModel.mixtureConfig.compact") },
								{ value: "snapcompact", label: t("overlaysModel.mixtureConfig.snapcompact") },
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
							t("overlaysModel.mixtureConfig.transcriptBudget"),
							budget,
							number => {
								if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
									this.#cb.notify(t("overlaysModel.mixtureConfig.transcriptBudgetError"));
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
			{
				value: "maxHops",
				label: t("overlaysModel.mixtureConfig.maximumHops"),
				description: String(limits.maxHops ?? t("overlaysModel.mixtureConfig.defaultLower")),
			},
			{
				value: "budgetUsd",
				label: t("overlaysModel.mixtureConfig.budgetUsd"),
				description: String(limits.budgetUsd ?? t("overlaysModel.mixtureConfig.settingDefaultLower")),
			},
			{
				value: "wallClockMinutes",
				label: t("overlaysModel.mixtureConfig.wallClock"),
				description: String(limits.wallClockMinutes ?? t("overlaysModel.mixtureConfig.settingDefaultLower")),
			},
			{
				value: "onLimit",
				label: t("overlaysModel.mixtureConfig.onLimit"),
				description: limits.onLimit ?? t("overlaysModel.mixtureConfig.settingDefaultLower"),
			},
			{
				value: "limitTarget",
				label: t("overlaysModel.mixtureConfig.judgeMember"),
				description: limits.limitTarget ?? t("overlaysModel.mixtureConfig.noneLower"),
			},
			{ value: "back", label: t("overlaysModel.mixtureConfig.backToMixture") },
		];
		this.#menu(
			"limits",
			items,
			selected,
			t("overlaysModel.mixtureConfig.editBackHint"),
			undefined,
			() => this.#showMixture(index, "limits"),
			undefined,
			{
				open: value => {
					if (value === "back") return this.#showMixture(index, "limits");
					const back = () => this.#showLimits(index, value);
					if (value === "onLimit")
						this.#choose(
							t("overlaysModel.mixtureConfig.onLimit"),
							[
								{ value: "default", label: t("overlaysModel.mixtureConfig.settingDefault") },
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
							t("overlaysModel.mixtureConfig.limitTarget"),
							[
								{ value: "", label: t("overlaysModel.mixtureConfig.noneCaps") },
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
							value === "maxHops"
								? t("overlaysModel.mixtureConfig.field.maxHops")
								: value === "budgetUsd"
									? t("overlaysModel.mixtureConfig.field.budgetUsd")
									: t("overlaysModel.mixtureConfig.field.wallClockMinutes"),
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
		items.push(
			{ value: "__add", label: t("overlaysModel.mixtureConfig.addPreset") },
			{ value: "__back", label: t("overlaysModel.mixtureConfig.back") },
		);
		this.#menu(
			"presets",
			items,
			selected,
			t("overlaysModel.mixtureConfig.presetsHint"),
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
							t("overlaysModel.mixtureConfig.presetName"),
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
			t("overlaysModel.mixtureConfig.presetHeading", {
				kind:
					kind === "roles"
						? t("overlaysModel.mixtureConfig.presets.roles")
						: t("overlaysModel.mixtureConfig.presets.envelopes"),
				name,
			}),
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
