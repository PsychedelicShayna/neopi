import type { Component, TUI } from "../tui";
import { SelectList, type SelectItem, type SelectListNavigationState } from "../components/select-list";
import { SplitPane } from "../components/layout/split-pane";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import {
	MenuKeyReader,
	MenuViewport,
	type MenuNavAction,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { routeSgrMouseInput } from "../mouse";
import { matchesKey } from "../keys";
import { getSelectListTheme, theme } from "../theme";
import { node, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { overlayCard } from "../native/overlay";
import {
	CLOSE_ACTION,
	picker,
	pickerAction,
	pickerEvent,
	routeSelectListPicker,
	selectListPicker,
} from "../native/picker";
import { sanitizeDisplayLine } from "./extensions/display-text";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigCallbacks,
	type AdvisorConfigDeps,
	type AdvisorConfigScope,
	type WatchdogConfigDoc,
} from "./advisor-config";

export interface AdvisorConfigFile {
	path: string;
	scope: AdvisorConfigScope;
	doc: WatchdogConfigDoc;
}

export interface AdvisorScopeCallbacks extends Omit<AdvisorConfigCallbacks, "loadDoc" | "save" | "openConfigFile"> {
	loadFile: (path: string) => Promise<WatchdogConfigDoc>;
	saveFile: (path: string, doc: WatchdogConfigDoc) => Promise<void>;
	/** Edit the exact discovered file, not a scope's default path. */
	openFile?: (path: string) => Promise<void>;
}

interface ScopeNavigationSnapshot {
	list: SelectListNavigationState;
	previewTop?: MenuViewportPosition;
	previewFocused: boolean;
	editor?: AdvisorConfigOverlayComponent;
	content?: unknown;
}

/** Select an exact discovered file before opening the existing per-advisor editor. */
export class AdvisorScopeOverlayComponent implements Component {
	readonly #tui: TUI;
	readonly #deps: AdvisorConfigDeps;
	readonly #files: AdvisorConfigFile[];
	readonly #cb: AdvisorScopeCallbacks;
	readonly #keys = new MenuKeyReader();
	readonly #help = new MenuHelp();
	readonly #previewViewport = new MenuViewport();
	#previewFocused = false;
	#list: SelectList;
	#editor: AdvisorConfigOverlayComponent | undefined;
	#busy = false;
	#pendingApply = false;
	#rows = 30;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	readonly #split = new SplitPane({
		left: (width, height) => {
			this.#list.setMaxVisible(Math.max(1, (height ?? this.#rows) - 1));
			return this.#list.render(width);
		},
		right: (width, height) => {
			const lines = this.#preview().flatMap(line => Bun.wrapAnsi(line, width, { hard: true }).split("\n"));
			const window = this.#previewViewport.layout(
				lines.map(() => 1),
				-1,
				height ?? this.#rows,
			);
			return lines.slice(window.startIndex, window.endIndex);
		},
		leftSize: { ratio: 0.65, min: 35 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});

	constructor(tui: TUI, deps: AdvisorConfigDeps, files: AdvisorConfigFile[], callbacks: AdvisorScopeCallbacks) {
		this.#tui = tui;
		this.#deps = deps;
		this.#files = files;
		this.#cb = callbacks;
		this.#list = this.#buildList();
	}

	#selectedFile(): AdvisorConfigFile | undefined {
		return this.#files.find(file => file.path === this.#list.getSelectedItem()?.value);
	}

	#buildList(state?: SelectListNavigationState): SelectList {
		const items: SelectItem[] = this.#files.map(file => ({
			value: file.path,
			label: `${file.doc.enabled === false ? "○" : "●"} ${file.scope}`,
			description: sanitizeDisplayLine(file.path),
		}));
		items.push(
			{ value: "divider", label: "────────────────", disabled: true },
			{ value: "disable", label: "Disable all active advisors" },
			{ value: "enable", label: "Enable all advisors" },
			{ value: "invert", label: "Invert enabled and disabled" },
			{ value: "apply", label: "Apply saved configuration" },
			{ value: "close", label: "Close" },
		);
		const list = new SelectList(items, this.#rows, getSelectListTheme(), {
			search: "always",
			activateOnSpace: false,
			wrapDescription: true,
			minPrimaryColumnWidth: 10,
		});
		if (state) list.restoreNavigation(state);
		list.onSelectionChange = () => {
			this.#previewViewport.setTop(0);
			this.#cb.requestRender();
		};
		list.onSelect = item => this.#run(() => this.#select(item.value));
		list.onCancel = () => this.#cb.close();
		return list;
	}

	#preview(): string[] {
		const file = this.#selectedFile();
		if (!file)
			return ["Select a file to preview its advisors.", "Space toggles a whole file. Enter edits that file."];
		return [
			sanitizeDisplayLine(file.path),
			file.doc.enabled === false ? "File disabled. Entries remain editable." : "File enabled",
			"",
			...file.doc.advisors.map(
				advisor => `${advisor.enabled === false ? "○ disabled" : "● enabled"} ${sanitizeDisplayLine(advisor.name)}`,
			),
			...(file.doc.advisors.length === 0 ? ["No explicit advisors"] : []),
			...(file.doc.warnings ?? []).map(sanitizeDisplayLine),
		];
	}

	#run(operation: () => Promise<void>): void {
		if (this.#busy) return;
		this.#busy = true;
		void operation()
			.catch(error => {
				this.#cb.notify(`Advisor config: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				this.#busy = false;
				if (!this.#editor) this.#list = this.#buildList(this.#list.navigationState());
				this.#cb.requestRender();
			});
	}

	async #write(file: AdvisorConfigFile, doc: WatchdogConfigDoc): Promise<void> {
		await this.#cb.saveFile(file.path, doc);
		file.doc = await this.#cb.loadFile(file.path);
		this.#pendingApply = true;
	}

	async #toggle(): Promise<void> {
		const file = this.#selectedFile();
		if (!file) return;
		const doc = await this.#cb.loadFile(file.path);
		doc.enabled = doc.enabled === false ? undefined : false;
		await this.#write(file, doc);
		this.#list = this.#buildList(this.#list.navigationState());
		this.#cb.notify("Saved file state. Press a to apply it to live advisors.");
	}

	async #openSelectedFile(): Promise<void> {
		const file = this.#selectedFile();
		if (!file || !this.#cb.openFile) return;
		await this.#cb.openFile(file.path);
		file.doc = await this.#cb.loadFile(file.path);
		this.#pendingApply = true;
	}

	async #select(value: string): Promise<void> {
		if (value === "close") {
			this.#cb.close();
			return;
		}
		if (value === "apply") {
			await this.#cb.apply();
			this.#pendingApply = false;
			return;
		}
		if (["enable", "disable", "invert"].includes(value)) {
			for (const file of this.#files) {
				const doc = await this.#cb.loadFile(file.path);
				const fileEnabled = doc.enabled !== false;
				doc.enabled =
					value === "disable" || (value === "invert" && doc.advisors.length === 0 && fileEnabled)
						? false
						: undefined;
				for (const advisor of doc.advisors) {
					advisor.enabled =
						value === "disable"
							? false
							: value === "enable" || !fileEnabled || advisor.enabled === false
								? undefined
								: false;
				}
				await this.#write(file, doc);
			}
			this.#list = this.#buildList(this.#list.navigationState());
			this.#cb.notify("Saved advisor states. Press a to apply them to live advisors.");
			return;
		}
		const file = this.#files.find(candidate => candidate.path === value);
		if (!file) return;
		const previous = this.navigationSnapshot();
		const doc = await this.#cb.loadFile(file.path);
		const editor = new AdvisorConfigOverlayComponent(
			this.#tui,
			{ ...this.#deps, effectiveRoster: [], filePath: file.path },
			file.scope,
			doc,
			{
				...this.#cb,
				openConfigFile: this.#cb.openFile
					? async () => {
							await this.#cb.openFile?.(file.path);
							this.#pendingApply = true;
						}
					: undefined,
				loadDoc: async () => {
					file.doc = await this.#cb.loadFile(file.path);
					return file.doc;
				},
				save: async (_scope, next) => {
					await this.#write(file, next);
				},
				apply: async () => {
					await this.#cb.apply();
					this.#pendingApply = false;
				},
				close: () => {
					const snapshot = this.navigationSnapshot();
					this.#editor = undefined;
					this.#list = this.#buildList(this.#list.navigationState());
					this.onNavigationVisit?.("advisor-scopes", snapshot);
					this.#cb.requestRender();
				},
			},
		);
		editor.onNavigationVisit = (page, snapshot) =>
			this.onNavigationVisit?.(page, {
				...this.navigationSnapshot(),
				editor,
				content: snapshot,
			} satisfies ScopeNavigationSnapshot);
		this.#editor = editor;
		this.onNavigationVisit?.(`advisor-file:${file.path}`, previous);
	}

	render(width: number): readonly string[] {
		if (this.#editor) return this.#editor.render(width);
		const hints = menuHintLines(
			`Tab panes · / filter · Space toggle file · Enter edit${this.#cb.openFile ? " · Ctrl-G edit config file" : ""} · a apply · Esc close · ? help`,
			Math.max(1, width - 4),
		);
		this.#rows = Math.max(10, (process.stdout.rows || 40) - 3 - hints.length);
		this.#split.setHeight(this.#rows);
		this.#split.setNarrowPane(this.#previewFocused ? "right" : "left");
		const title = `Advisor configuration · files${this.#busy ? " · saving" : this.#pendingApply ? " · saved, not applied" : ""}`;
		return this.#help.render(
			[
				topBorder(width, title),
				...this.#split.render(width),
				divider(width),
				...hints.map(line => row(theme.fg("dim", line), width)),
				bottomBorder(width),
			],
			width,
		);
	}

	nativeSheet(cx: DescribeContext): boolean {
		return this.#editor ? this.#editor.nativeSheet(cx) : cx.supports("picker");
	}

	describe(cx: DescribeContext): NativeNode {
		if (this.#editor) return this.#editor.describe(cx);
		if (this.#help.open) return this.#help.describe();
		const preview = this.#preview().map(line => text(line, { wrap: "word" }));
		if (cx.supports("picker"))
			return picker(
				{
					...selectListPicker(this.#list, { title: "Advisor configuration · files", searchable: true }),
					preview: "side",
					actions: [
						pickerAction("confirm", "Edit", "enter", { primary: true }),
						pickerAction("toggle", "Toggle file", "space"),
						pickerAction("apply", "Apply", "a"),
						...(this.#cb.openFile ? [pickerAction("edit-file", "Edit config file", "ctrl+g")] : []),
						CLOSE_ACTION,
					],
				},
				preview,
			);
		return overlayCard("omp.overlay.advisor-scopes", "Advisor configuration · files", [
			node("row", { gap: "md" }, [this.#list, node("col", undefined, preview)]),
		]);
	}

	handleInput(data: string): void {
		if (this.#editor) {
			this.#editor.handleInput(data);
			return;
		}
		if (this.#busy) return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				const local = this.#split.locate(event.row - 1, event.col);
				if (local?.pane === "right") {
					if (event.wheel !== null) this.#previewViewport.scroll(event.wheel);
					this.#cb.requestRender();
					return;
				}
				if (!local) return;
				const index = this.#list.hitTest(local.line);
				if (index !== undefined && event.motion) {
					const item = this.#list.pickerView().items[index];
					if (item && !item.disabled && item.value !== this.#list.getSelectedItem()?.value) {
						this.#list.setSelectedValue(item.value);
						this.#previewViewport.setTop(0);
					}
				}
				this.#list.routeMouse(event, local.line, local.col);
				this.#cb.requestRender();
			});
			return;
		}
		if (this.#list.filterFocused) {
			this.#keys.reset();
			this.#list.handleInput(data);
			return;
		}
		if (this.#help.handleInput(data)) {
			this.#keys.reset();
			this.#cb.requestRender();
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (!action && this.#cb.openFile && matchesKey(data, "ctrl+g")) {
			this.#run(() => this.#openSelectedFile());
			return;
		}
		if (action?.kind === "horizontal" || action?.kind === "context") {
			this.#previewFocused = action.kind === "horizontal" ? action.delta > 0 : !this.#previewFocused;
			this.#cb.requestRender();
			return;
		}
		if (action?.kind === "search") this.#previewFocused = false;
		if (this.#previewFocused && action && this.#scrollPreview(action)) return;
		if (action?.kind === "toggle") this.#run(() => this.#toggle());
		else if (data === "a") this.#run(() => this.#select("apply"));
		else if (action) this.#list.handleNavigation(action);
		else this.#list.handleInput(data);
	}

	#scrollPreview(action: MenuNavAction): boolean {
		switch (action.kind) {
			case "move":
			case "scroll":
				this.#previewViewport.scroll(action.delta);
				break;
			case "halfPage":
				this.#previewViewport.scroll(action.delta * Math.max(1, Math.floor(this.#rows / 2)));
				break;
			case "page":
				this.#previewViewport.scroll(action.delta * this.#rows);
				break;
			case "boundary":
				this.#previewViewport.setTop(action.edge === "first" ? 0 : Number.MAX_SAFE_INTEGER);
				break;
			default:
				return false;
		}
		this.#cb.requestRender();
		return true;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#editor) {
			this.#editor.handleNativeEvent(event);
			return;
		}
		if (this.#busy) return;
		const picked = pickerEvent(event);
		if (picked?.kind === "action") {
			if (picked.act === "toggle") this.#run(() => this.#toggle());
			else if (picked.act === "apply") this.#run(() => this.#select("apply"));
			else if (picked.act === "edit-file" && this.#cb.openFile) this.#run(() => this.#openSelectedFile());
			else routeSelectListPicker(this.#list, event);
		} else if (picked) routeSelectListPicker(this.#list, event);
		else this.#list.handleNativeEvent(event);
		this.#cb.requestRender();
	}

	get blocksMenuHistory(): boolean {
		return this.#busy || this.#editor?.blocksMenuHistory === true;
	}
	leaveMenu(): void {
		this.#keys.reset();
		this.#editor?.leaveMenu();
	}
	navigationSnapshot(): ScopeNavigationSnapshot {
		return {
			list: this.#list.navigationState(),
			previewTop: this.#previewViewport.top,
			previewFocused: this.#previewFocused,
			editor: this.#editor,
			content: this.#editor?.navigationSnapshot(),
		};
	}
	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object" || !("list" in snapshot)) return;
		const state = snapshot as ScopeNavigationSnapshot;
		this.#list = this.#buildList(state.list);
		this.#previewViewport.setTop(state.previewTop);
		this.#previewFocused = state.previewFocused;
		this.#editor = state.editor;
		if (this.#editor) this.#editor.restoreNavigation(state.content);
		this.#keys.reset();
	}

	dispose(): void {
		this.#editor?.dispose();
	}
}
