import { getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	type Component,
	extractPrintableText,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { bottomBorder, divider, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { editorKey, interruptKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { Checklist } from "@oh-my-pi/pi-tui/components/checklist";
import { getKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { matchesAppFollowUp, matchesAppInterrupt } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { col, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import {
	bindingKeys,
	CLOSE_ACTION,
	picker,
	pickerAction,
	pickerEvent,
	routeSelectListPicker,
	selectListPicker,
} from "@oh-my-pi/pi-tui/native/picker";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserSource,
	sortModelItems,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { getSelectListTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { uiProvenanceSuffix } from "@oh-my-pi/pi-tui/theme/provenance";
import { formatModelStringWithRouting } from "../config/model-resolver";
import { isSpawnName, parseSpawnContextCap, type AgentLauncher, type SpawnDraft } from "../neopi/agent-launcher";

interface SpawnScreenDeps {
	launcher: AgentLauncher;
	getAvailableModels: () => readonly Model[];
	browserSource: ModelBrowserSource;
	workspace: string;
	externalEditor: (text: string) => Promise<string | null>;
	done: (draft: SpawnDraft | undefined) => void;
}

type FocusedEditor =
	| { kind: "choice"; title: string; list: SelectList }
	| { kind: "model"; title: string; browser: ModelBrowser; items: ModelBrowserItem[] }
	| { kind: "input"; title: string; input: Input }
	| { kind: "assignment"; editor: HookEditorComponent };

function item(value: string, label: string, description?: string): SelectItem {
	return {
		value,
		label: sanitizeDisplaySingleLine(label),
		description: description === undefined ? undefined : sanitizeDisplaySingleLine(description),
	};
}

/** One draft and one launch surface. Opening a picker never commits an unrelated field. */
export class SpawnScreen implements Component {
	readonly #root: SelectList;
	readonly #initial: SpawnDraft;
	#draft: SpawnDraft;
	#defaults: SpawnDraft;
	#tools: Checklist;
	#editor: FocusedEditor | undefined;
	#notice = "";
	#finished = false;
	#listRows = 0;
	#useTerminalCursor = false;

	constructor(
		private readonly tui: TUI,
		private readonly deps: SpawnScreenDeps,
	) {
		const first = deps.launcher.presets[0];
		if (!first) throw new Error("No agent types are available.");
		this.#initial = deps.launcher.resolveSpec(first.type);
		this.#defaults = this.#initial;
		this.#draft = { ...this.#defaults };
		this.#tools = this.#buildTools();
		this.#root = new SelectList([], 12, getSelectListTheme(), { activateOnSpace: false });
		this.#root.onSelect = entry => this.#activate(entry.value);
		this.#root.onCancel = () => {
			if (Bun.deepEquals(this.#draft, this.#initial)) this.#finish();
			else this.#notice = "This spawn has edits. Press Ctrl+C to discard it.";
		};
		this.#refresh();
	}

	get blocksMenuHistory(): boolean {
		return this.#editor?.kind === "input" || this.#editor?.kind === "assignment";
	}

	capturesInput(data: string): boolean {
		return matchesKey(data, "ctrl+c");
	}

	navigationSnapshot(): unknown {
		return {
			draft: {
				...this.#draft,
				tools: this.#draft.tools?.slice(),
				delegation: this.#draft.delegation === "*" ? "*" : this.#draft.delegation?.slice(),
			},
			list: this.#root.navigationSnapshot(),
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (typeof snapshot !== "object" || snapshot === null || !("draft" in snapshot)) return;
		const draft = snapshot.draft as SpawnDraft;
		if (!draft || !this.deps.launcher.presets.some(preset => preset.type === draft.type)) return;
		this.#defaults = this.deps.launcher.resolveSpec(draft.type);
		this.#draft = { ...draft };
		this.#tools = this.#buildTools();
		this.#back();
		if ("list" in snapshot) this.#root.restoreNavigation(snapshot.list);
	}

	leaveMenu(): void {
		this.#finish();
	}

	#finish(draft?: SpawnDraft): void {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#editor?.kind === "assignment") this.#editor.editor.dispose();
		this.deps.done(draft);
	}

	#buildTools(): Checklist {
		const available = this.deps.launcher.presets.find(preset => preset.type === this.#draft.type)?.tools ?? [];
		return new Checklist({
			entries: available.map(tool => ({ ...tool, ...item(tool.value, tool.label, tool.description) })),
			selected: this.#draft.tools ?? [],
			fixed: available.filter(tool => tool.disabled).map(tool => tool.value),
		});
	}

	#refresh(): void {
		const { type, name, model, context, prewalk, advisor, assignment, delegation } = this.#draft;
		const advisorSeat = this.deps.launcher.presets.some(preset => preset.type === type && preset.advisorSeat);
		const preview = assignment.trim().split("\n", 1)[0];
		this.#root.setItems([
			item("type", "Agent type", type),
			item("model", "Model + effort", model ?? "Choose a model"),
			item("context", "Context cap", context?.toLocaleString() ?? "Model limit"),
			...(!advisorSeat
				? [item("prewalk", "Prewalk", prewalk ?? "Off"), item("advisor", "Advisor", advisor ?? "Off")]
				: []),
			...(this.#tools.selected?.includes("task")
				? [
						item(
							"delegation",
							"Delegation",
							delegation === "*" ? "Any agent type" : delegation?.join(", ") || "None",
						),
					]
				: []),
			item("name", "Name", name),
			item("assignment", "Assignment", preview || "Required · opens multiline editor"),
			item("launch", "Launch", "Start this agent"),
			{
				value: "tools-heading",
				label: "Tools",
				description: `${this.#tools.current.length} enabled`,
				disabled: true,
			},
			...this.#tools.items(),
		]);
		this.tui.requestRender();
	}

	#back(): void {
		this.#editor = undefined;
		this.#notice = "";
		this.#refresh();
	}

	#selectType(type: string): void {
		if (type === this.#draft.type) return;
		const { name, assignment } = this.#draft;
		this.#defaults = this.deps.launcher.resolveSpec(type);
		this.#draft = { ...this.#defaults, name, assignment };
		this.#tools = this.#buildTools();
	}

	#activate(value: string): void {
		this.#notice = "";
		switch (value) {
			case "type":
				this.#choose(
					"Agent type",
					this.deps.launcher.presets.map(preset => item(preset.type, preset.type, preset.description)),
					this.#draft.type,
					type => this.#selectType(type),
				);
				break;
			case "model":
				this.#pickModel("Model + effort", this.#draft.model, model => {
					this.#draft.model = this.deps.launcher.resolveSpec(`${this.#draft.type}@${model}`).model;
				});
				break;
			case "context":
				this.#input(
					"Context cap (tokens; empty uses model limit)",
					this.#draft.context?.toString() ?? "",
					value => {
						this.#draft.context = value ? parseSpawnContextCap(value) : undefined;
					},
				);
				break;
			case "prewalk":
			case "advisor":
				this.#pickTarget(value);
				break;
			case "name":
				this.#input("Agent name", this.#draft.name, name => {
					if (!isSpawnName(name))
						throw new Error("Use a letter first, then up to 31 letters, digits, underscores, or hyphens.");
					this.#draft.name = name;
				});
				break;
			case "assignment":
				this.#editAssignment();
				break;
			case "delegation":
				this.#pickDelegation();
				break;
			case "launch":
				this.#launch();
				break;
			default:
				if (!value.startsWith("item:")) break;
				this.#tools.toggle(value);
				this.#draft.tools = this.#tools.selected;
				this.#refresh();
		}
	}

	#launch(): void {
		const assignment = this.#draft.assignment.trim();
		const invalid = !assignment
			? { field: "assignment", message: "Add an assignment before launching." }
			: !this.#draft.model
				? { field: "model", message: "Choose a model before launching." }
				: !isSpawnName(this.#draft.name)
					? { field: "name", message: "Enter a valid agent name before launching." }
					: undefined;
		if (invalid) {
			this.#root.setFilter("");
			this.#root.setSelectedValue(invalid.field);
			this.#notice = invalid.message;
		} else {
			this.#finish({
				...this.#draft,
				assignment,
				delegation: this.#draft.tools?.includes("task") ? this.#draft.delegation : [],
			});
		}
	}

	#input(title: string, value: string, apply: (value: string) => void, back = () => this.#back()): void {
		const input = new Input();
		input.focused = true;
		input.setUseTerminalCursor(this.#useTerminalCursor);
		input.setValue(value);
		input.onSubmit = value => {
			try {
				apply(value.trim());
				this.#back();
			} catch (error) {
				this.#notice = sanitizeDisplaySingleLine(error instanceof Error ? error.message : String(error));
			}
		};
		input.onEscape = back;
		input.onCancel = back;
		this.#editor = { kind: "input", title, input };
	}

	#editAssignment(): void {
		const save = (value: string) => {
			this.#draft.assignment = value;
			this.#back();
		};
		const editor = new HookEditorComponent(
			this.tui,
			"Spawn assignment",
			this.#draft.assignment,
			save,
			() => this.#back(),
			{ onBack: save, externalEditor: this.deps.externalEditor },
		);
		editor.focused = true;
		editor.setUseTerminalCursor(this.#useTerminalCursor);
		this.#editor = { kind: "assignment", editor };
	}

	#choose(
		title: string,
		items: readonly SelectItem[],
		initial: string,
		pick: (value: string) => void,
		back = () => this.#back(),
	): void {
		this.#notice = "";
		const list = new SelectList(items, 12, getSelectListTheme(), { activateOnSpace: false });
		list.setSelectedValue(initial);
		list.onSelect = entry => {
			const before = this.#editor;
			try {
				this.#notice = "";
				pick(entry.value);
				if (this.#editor === before) this.#back();
			} catch (error) {
				this.#notice = sanitizeDisplaySingleLine(error instanceof Error ? error.message : String(error));
			}
		};
		list.onCancel = back;
		this.#editor = { kind: "choice", title, list };
	}

	#pickModel(
		title: string,
		current: string | undefined,
		apply: (selector: string) => void,
		back = () => this.#back(),
	): void {
		const items = buildBrowserItems(this.deps.getAvailableModels());
		const source = this.deps.browserSource;
		sortModelItems(items, { mruOrder: source.mruOrder });
		const browser = new ModelBrowser(source, {});
		browser.setMruOrder(source.mruOrder);
		browser.setPerfStats(source.modelPerf);
		browser.setItems(items);
		if (current) {
			const match =
				items.find(entry => current === entry.selector) ??
				items.find(entry => {
					const selector = formatModelStringWithRouting(entry.model);
					return current === selector || current.startsWith(`${selector}:`);
				});
			if (match) browser.selectSelector(match.selector);
		}
		const page: FocusedEditor = { kind: "model", title, browser, items };
		browser.onActivate = entry => {
			const selector = formatModelStringWithRouting(entry.model);
			const efforts = getSupportedThinkingLevels(entry.model);
			if (!efforts.length) {
				try {
					apply(selector);
					this.#back();
				} catch (error) {
					this.#notice = sanitizeDisplaySingleLine(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			this.#choose(
				`Effort for ${sanitizeDisplaySingleLine(selector)}`,
				[
					item("", "Default effort"),
					...(efforts.some(effort => effort !== "off") ? [item("auto", "Auto")] : []),
					...efforts.map(effort => item(effort, effort)),
				],
				current?.startsWith(`${selector}:`) ? current.slice(selector.length + 1) : "",
				effort => apply(effort ? `${selector}:${effort}` : selector),
				() => {
					this.#editor = page;
				},
			);
		};
		browser.onCancel = back;
		this.#editor = page;
	}

	#pickTarget(field: "prewalk" | "advisor"): void {
		const title = field === "prewalk" ? "Prewalk" : "Advisor";
		const current = this.#draft[field];
		const apply = (selector: string | undefined) => {
			this.#draft[field] = selector;
		};
		const target = () => this.#pickTarget(field);
		this.#choose(
			title,
			[
				item("template", "Use type default", this.#defaults[field] ?? "Off"),
				item("off", "Off"),
				item("model", "Pick model + effort"),
				item("selector", "Edit selector", current),
			],
			current === this.#defaults[field] ? "template" : current === "off" ? "off" : "selector",
			action => {
				if (action === "template") apply(this.#defaults[field]);
				else if (action === "off") apply("off");
				else if (action === "model") this.#pickModel(title, current, apply, target);
				else
					this.#input(
						`${title} selector`,
						current ?? "",
						value => {
							if (!value) {
								apply(this.#defaults[field]);
								return;
							}
							if (value.includes(";")) throw new Error("Enter just one selector.");
							const key = field === "prewalk" ? "pre" : "advisor";
							apply(this.deps.launcher.resolveSpec(`${this.#draft.type};${key}=${value}`)[field]);
						},
						target,
					);
			},
		);
	}

	#pickDelegation(): void {
		const selected = this.#draft.delegation;
		const checklist = new Checklist({
			entries: this.deps.launcher.presets
				.filter(preset => !preset.advisorSeat)
				.map(preset => item(preset.type, preset.type, preset.description)),
			selected: selected === "*" ? [] : (selected ?? []),
			ordered: true,
		});
		const options = () => [item("all", "Any agent type"), item("none", "No delegation"), ...checklist.items()];
		const list = new SelectList(options(), 12, getSelectListTheme());
		list.setSelectedValue(selected === "*" ? "all" : (checklist.current[0] ?? "none"));
		list.onCancel = () => this.#back();
		list.onSelect = entry => {
			if (entry.value === "all" || entry.value === "none") {
				this.#draft.delegation = entry.value === "all" ? "*" : [];
				this.#back();
			} else {
				checklist.toggle(entry.value);
				this.#draft.delegation = checklist.selected ?? [];
				list.setItems(options());
			}
		};
		this.#editor = { kind: "choice", title: "Delegation", list };
	}

	#title(): string {
		return this.#editor && this.#editor.kind !== "assignment"
			? this.#editor.title
			: `Spawn agent${uiProvenanceSuffix("features", "spawn-screen")}`;
	}

	setUseTerminalCursor(enabled: boolean): void {
		this.#useTerminalCursor = enabled;
		if (this.#editor?.kind === "assignment") this.#editor.editor.setUseTerminalCursor(enabled);
		else if (this.#editor?.kind === "input") this.#editor.input.setUseTerminalCursor(enabled);
	}

	render(width: number): readonly string[] {
		const editor = this.#editor;
		if (editor?.kind === "assignment") return editor.editor.render(width);
		if (width < 5) return [];
		const inner = width - 4;
		const active =
			editor?.kind === "input"
				? editor.input
				: editor?.kind === "model"
					? editor.browser
					: (editor?.list ?? this.#root);
		if (!(active instanceof Input)) active.setMaxVisible(this.tui.terminal.rows - 8);
		const body = active.render(inner);
		this.#listRows = body.length;
		const hint =
			editor?.kind === "input"
				? "Enter apply  ·  Esc back if unchanged  ·  Ctrl+C discard edit"
				: editor
					? `Esc back  ·  ${interruptKey()} cancel spawn`
					: `Enter edit  ·  ${editorKey("tui.select.toggle")} toggle tool  ·  ${editorKey("app.message.followUp")} launch  ·  Ctrl+C cancel spawn`;
		const fit = (value: string) => row(truncateToWidth(value, inner), width);
		return [
			topBorder(width, this.#title()),
			...body.map(fit),
			divider(width),
			...(!editor ? [fit(theme.fg("muted", this.deps.workspace))] : []),
			...(this.#notice ? [fit(theme.fg("warning", this.#notice))] : []),
			fit(theme.fg("muted", hint)),
			bottomBorder(width),
		];
	}

	handleInput(data: string): void {
		if (this.#finished) return;
		const editor = this.#editor;
		const editingText = editor?.kind === "assignment" || editor?.kind === "input";
		const explicitCancel = matchesKey(data, "ctrl+c");
		if (
			explicitCancel
				? !editingText
				: !matchesKey(data, "escape") &&
					(!editingText || extractPrintableText(data) === undefined) &&
					matchesAppInterrupt(data)
		) {
			this.#finish();
			return;
		}
		if (editor?.kind === "assignment") editor.editor.handleInput(data);
		else if (editor?.kind === "input") editor.input.handleInput(data, true);
		else {
			const active = editor?.kind === "model" ? editor.browser : (editor?.list ?? this.#root);
			if (
				!routeSgrMouseInput(data, event => {
					if (event.row < 2 || event.row > this.#listRows + 1 || event.col < 3) return false;
					if (active instanceof ModelBrowser) active.routeMouse(event, event.row - 2);
					else active.routeMouse(event, event.row - 2, event.col - 3);
					return true;
				})
			) {
				if (!editor && !this.#root.filterFocused && matchesAppFollowUp(data)) this.#launch();
				else if (!editor && !this.#root.filterFocused && getKeybindings().matches(data, "tui.select.toggle")) {
					const value = this.#root.getSelectedItem()?.value;
					if (value?.startsWith("item:")) this.#activate(value);
				} else active.handleInput(data);
			}
		}
		this.tui.requestRender();
	}

	pasteText(value: string): void {
		if (this.#editor?.kind === "assignment") this.#editor.editor.pasteText(value);
		else if (this.#editor?.kind === "input") this.#editor.input.insertText(sanitizeDisplaySingleLine(value));
	}

	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker") && this.#editor?.kind !== "input" && this.#editor?.kind !== "assignment";
	}

	describe(cx: DescribeContext): NativeNode {
		const editor = this.#editor;
		if (editor?.kind === "assignment") return editor.editor.describe(cx);
		const notices = this.#notice ? [text(this.#notice, { tone: "warning" })] : [];
		if (editor?.kind === "input") return col([text(editor.title), editor.input, ...notices]);
		if (!cx.supports("picker")) return text(Bun.stripANSI(this.render(this.tui.terminal.columns).join("\n")));
		if (editor?.kind === "model") {
			const browser = editor.browser;
			const order = browser.pickerOrder({ providers: false, rest: browser.query.trim() ? "Matches" : "All" });
			const catalogue = browser.pickerItems(editor.items);
			return picker(
				{
					title: editor.title,
					icon: "model",
					noun: "models",
					size: "lg",
					layout: "rows",
					preview: "below",
					placeholder: "Search models…",
					...browser.pickerRows(catalogue, order, undefined),
					actions: [
						pickerAction("use", "Use model", "enter", { primary: true }),
						{ ...CLOSE_ACTION, label: browser.filterFocused ? "Back to list" : "Back" },
					],
				},
				[...notices, ...browser.pickerPreview("compact")],
			);
		}
		const props = selectListPicker(editor?.list ?? this.#root, {
			title: this.#title(),
			subtitle: editor ? undefined : this.deps.workspace,
			noun: editor ? "choices" : "settings and tools",
			confirm: editor ? "Choose" : "Select",
			current: editor ? undefined : this.#tools.current,
		});
		const actions = (props.actions ?? []).map(action =>
			editor && action.id === "close" && !(editor.list.filterFocused || editor.list.getFilter())
				? { ...action, label: "Back" }
				: action,
		);
		if (!editor) {
			actions.splice(1, 0, pickerAction("launch", "Launch", bindingKeys("app.message.followUp"), { primary: true }));
			actions.push(pickerAction("discard-spawn", "Cancel spawn", "ctrl+c"));
		}
		return picker({ ...props, actions, size: "lg", preview: this.#notice ? "below" : "none" }, notices);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#finished) return;
		const editor = this.#editor;
		if (editor?.kind === "assignment") editor.editor.handleNativeEvent(event);
		else if (editor?.kind === "input") editor.input.handleNativeEvent(event);
		else if (editor?.kind === "model") {
			const picked = pickerEvent(event);
			if (picked?.kind === "action") {
				if (picked.act === "close") editor.browser.handleCancel();
				else if (picked.act === "use" && editor.browser.pickerSelected)
					editor.browser.routePickerItem(editor.browser.pickerSelected, true);
			} else if (picked) editor.browser.routePickerItem(picked.item, picked.kind === "activate");
		} else if (!editor && event.type === "action" && event.act === "launch") this.#launch();
		else if (!editor && event.type === "action" && event.act === "discard-spawn") this.#finish();
		else routeSelectListPicker(editor?.list ?? this.#root, event);
		this.tui.requestRender();
	}
}
