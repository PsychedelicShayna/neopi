import { provenanceSuffix } from "../theme/provenance";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Container,
	FuzzyCorpus,
	getSettingItemFilterText,
	type ImageBudget,
	Input,
	matchesKey,
	routeSelectListMouse,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	type Tab,
	TabBar,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { MenuHelp, menuHintLines } from "../components/menu-hints";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";
import type {
	ContextLineMode,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../status-line/schema";
import {
	numberSteps,
	numericOption,
	SETTING_TABS,
	type SubmenuOption,
	TAB_LEADS,
	TAB_METADATA,
	type SettingTab,
	type SettingsHost,
	type SettingsDisplayEntry,
} from "./settings-defs";
import type { TspPrefsControl, TspPrefsProps } from "@oh-my-pi/pi-wire";
import { prefsSectionId, type SettingsListNavigationState } from "../components/settings-list";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import { getTabBarTheme } from "../chrome/shared";
import { type ComposerPreviewStatusSource, ComposerShapePreview } from "./composer-shape-preview";
import { getComposerShapeOptions } from "./composer-shape-registry";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { PluginSettingsComponent, type PluginSettingsHost } from "./plugin-settings";
import { getSettingDef, getSettingsForTab, type SettingDef } from "./settings-defs";
import { SnapcompactShapePreview } from "./snapcompact-shape-preview";
import { themePickerOptions } from "./theme-selector";
import type { SelectPickerOptions } from "../native/picker";
import { getPreset } from "../status-line/presets";
import { FormField, SelectFormField, TextFormField } from "../components/form";
import { formTheme } from "../chrome/form-theme";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { col, node, span, text } from "../native/describe";
import { actionHint, hintsRow, type NativeHint, overlayCard } from "../native/overlay";
import { styledSpans } from "../native/spans";
import { sameItems } from "../native/memo";
import {
	MenuKeyReader,
	MenuSearchField,
	isMenuHistoryLeaver,
	isMenuHistoryParticipant,
} from "../components/menu-navigation";
import { compileMenuRegex } from "../menu-search";
import type { KeyName } from "../key-hint-format";

/** The native page id of the plugins tab. */
const PLUGINS_PAGE = "plugins";
/** Role of the status-line preview child: the page places it after the status-line section. */
const PREFS_STATUS_ROLE = "omp.prefs.preview.status";
/** Role of a sub-editor child without a native control: the page shows it in a card over itself. */
const PREFS_EDITOR_ROLE = "omp.prefs.editor";
/** Most choices a native popup menu lists; larger submenus open as a picker over the page. */
const PREFS_MENU_MAX = 12;
/** Text settings whose values are paths, ids or commands (drawn in mono). */
const MONO_TEXT_SETTING = /(path|dir|url|endpoint|host|command|model|id)$/i;
/** Submenus whose choices preview live while highlighted (the branches of `#createSubmenu`). */
const PREVIEWED_SETTINGS = new Set([
	"theme.dark",
	"theme.light",
	"statusLine.preset",
	"statusLine.separator",
	"statusLine.contextLine",
	"snapcompact.shape",
	"composer.shape",
]);
/** The byte a cancel key sends: native menu closes go through the same cancel handling as the key. */
const ESCAPE = "\x1b";

/** Footer hint set of the settings overlay, by what currently owns the keys. */
type SettingsHintMode = "search" | "plugins" | "sections" | "rows" | "rows-sections";

/** The settings tab strip; muted tabs (no search matches) keep their place, dimmed. */
function settingsTabsNode(tabs: readonly Tab[], active: string | undefined): NativeNode {
	return node(
		"tabs",
		{
			items: tabs.map(tab => ({ id: tab.id, label: tab.muted ? [span(tab.label, "muted")] : tab.label })),
			active,
		},
		undefined,
		"tabs",
	);
}

/** Footer hints for `mode`, mirroring the ANSI footer line. */
function settingsHintsNode(mode: SettingsHintMode): NativeNode {
	const confirmKeys: readonly KeyName[] = actionHint("tui.select.confirm", "")?.keys ?? [];
	const close = actionHint("tui.select.cancel", "close");
	const switchTabs: NativeHint = { keys: ["left", "right"], label: "switch tabs" };
	let hints: (NativeHint | undefined)[];
	switch (mode) {
		case "search":
			hints = [
				actionHint("tui.select.confirm", "change"),
				{ keys: ["tab"], label: "jump tabs" },
				actionHint("tui.select.cancel", "exit search"),
			];
			break;
		case "plugins":
			hints = [{ keys: ["tab"], label: "switch tabs" }, close];
			break;
		case "sections":
			hints = [
				actionHint(["tui.select.up", "tui.select.down"], "jump sections"),
				{ keys: ["tab", ...confirmKeys], label: "to settings" },
				switchTabs,
				close,
			];
			break;
		case "rows":
		case "rows-sections":
			hints = [
				{ keys: [...confirmKeys, "space"], label: "change" },
				...(mode === "rows-sections"
					? [{ keys: ["tab"], label: "jump sections" } satisfies NativeHint, switchTabs]
					: [{ keys: ["tab"], label: "switch tabs" } satisfies NativeHint]),
				{ keys: [], label: "type to search" },
				close,
			];
			break;
	}
	return hintsRow(hints);
}

interface SettingsNativeMemo {
	prefs?: { signature: string; children: readonly NativeChild[]; node: NativeNode };
	prefsPreview?: { source: string; node: NativeNode };
	tabs?: { tabs: readonly Tab[]; active: string | undefined; node: NativeNode };
	search?: { input: Input; count: number; node: NativeNode };
	preview?: { source: string; node: NativeNode };
	hints: Partial<Record<SettingsHintMode, NativeNode>>;
	root?: { children: readonly NativeChild[]; node: NativeNode };
}

/**
 * Free-text string setting field backed by the shared text form field.
 * Current values prefill, including secrets retained behind Input masking;
 * submitting an empty string clears the setting and validation errors stay inline.
 */
function createSettingsTextField(
	label: string,
	description: string,
	currentValue: string,
	secret: boolean,
	onSubmit: (value: string) => void | Promise<void>,
	onCancel: () => void,
	requestRender?: () => void,
): TextFormField {
	return new TextFormField({
		theme: formTheme,
		label,
		description: description || undefined,
		secret,
		initialValue: currentValue || undefined,
		empty: "submit",
		hint: `  ${editorKey("tui.input.submit")} to save · ${editorKey("tui.select.cancel")} to cancel · Clear field to unset`,
		onSubmit,
		onCancel,
		requestRender,
	});
}

const CUSTOM_NUMBER_OPTION = "__custom_number__";

/** A numeric preset picker with an explicit free-entry choice. */
class NumericSettingsField extends Container {
	#field: SelectFormField | TextFormField;

	constructor(
		def: SettingDef & { type: "submenu" },
		options: readonly SubmenuOption[],
		currentValue: string,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		requestRender?: () => void,
	) {
		super();
		this.#field = createSettingsSelectField(
			def.label,
			def.description,
			options,
			options.some(option => option.value === currentValue) ? currentValue : CUSTOM_NUMBER_OPTION,
			value => {
				if (value !== CUSTOM_NUMBER_OPTION) {
					onSubmit(value);
					return;
				}
				this.#field = createSettingsTextField(
					def.label,
					"Enter a token count, such as 120000. Clear the field to inherit the default.",
					Number(currentValue) > 0 ? currentValue : "",
					false,
					input => {
						if (input.trim() && !Number.isFinite(Number(input))) throw new Error("Enter a finite number.");
						onSubmit(input.trim());
					},
					onCancel,
					requestRender,
				);
				this.clear();
				this.addChild(this.#field);
				requestRender?.();
			},
			onCancel,
			undefined,
			undefined,
			undefined,
			requestRender,
		);
		this.addChild(this.#field);
	}

	select(value: string): void {
		if (this.#field instanceof SelectFormField)
			this.#field.selectList.handleNativeEvent({ type: "activate", key: "", item: value });
	}

	handleInput(data: string): void {
		this.#field.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#field instanceof SelectFormField) this.#field.routeMouse(event, line, col);
	}
}

/**
 * Single-choice setting field backed by the shared select form field.
 * Preserves the current selection, live async previews, footer previews,
 * and select/cancel dispatch of the bespoke submenu it replaces.
 */
function createSettingsSelectField(
	title: string,
	description: string,
	options: ReadonlyArray<SelectItem>,
	currentValue: string,
	onSelect: (value: string) => void,
	onCancel: () => void,
	onSelectionChange?: (value: string) => void | Promise<void>,
	getPreview?: () => string,
	footer?: Component,
	requestRender?: () => void,
	picker?: SelectPickerOptions,
	onLeaveMenu?: () => void,
): SelectFormField {
	const field = new SelectFormField({
		theme: formTheme,
		label: title,
		description: description || undefined,
		items: options,
		currentValue,
		maxVisible: 10,
		selectTheme: getSelectListTheme(),
		getPreview,
		onSelectionChange,
		onSubmit: onSelect,
		onCancel,
		onLeaveMenu,
		hint: `  ${editorKey("tui.select.confirm")} to select · ${editorKey("tui.select.cancel")} to go back`,
		footer,
		requestRender,
		picker,
	});
	const keys = new MenuKeyReader();
	const handleInput = field.handleInput.bind(field);
	field.handleInput = data => {
		if (field.filterFocused) {
			keys.reset();
			handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			keys.reset();
			onCancel();
			return;
		}
		const action = keys.read(data);
		if (action === "pending") return;
		if (action?.kind === "horizontal") {
			if (action.delta < 0) onCancel();
			return;
		}
		if (action) field.selectList.handleNavigation(action);
		else handleInput(data);
	};
	return field;
}

/**
 * Submenu for array-of-enum settings: every option is a toggle row. Enter or
 * Space flips membership; ordered lists render 1-based positions and reorder
 * the highlighted member with ←/→. Changes apply live; Esc goes back.
 */
class MultiSelectSubmenu extends Container {
	#selectList!: SelectList;
	#field!: FormField;
	#value: string[];
	#cursor = 0;
	readonly #keys = new MenuKeyReader();
	#pressedItemId: string | undefined;
	#dropItemId: string | undefined;
	readonly #title: string;
	readonly #description: string;
	readonly #options: ReadonlyArray<SelectItem>;
	readonly #ordered: boolean;
	readonly #onApply: (value: string[]) => void;
	readonly #onClose: () => void;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		initial: readonly string[],
		ordered: boolean,
		onApply: (value: string[]) => void,
		onClose: () => void,
	) {
		super();
		this.#title = title;
		this.#description = description;
		this.#options = options;
		this.#ordered = ordered;
		this.#onApply = onApply;
		this.#onClose = onClose;
		// Drop stale ids (renamed/removed providers) so positions stay contiguous.
		this.#value = initial.filter(id => options.some(option => option.value === id));
		this.#rebuild();
	}

	#rebuild(): void {
		const navigation = this.#selectList?.navigationState();
		this.clear();

		const items = this.#options.map((option): SelectItem => {
			const position = this.#value.indexOf(option.value);
			const mark =
				position === -1
					? theme.fg("dim", this.#ordered ? " · " : " ○ ")
					: this.#ordered
						? theme.fg("accent", `${String(position + 1).padStart(2)}.`)
						: theme.fg("accent", " ● ");
			return { value: option.value, label: `${mark} ${option.label}`, description: option.description };
		});
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme(), { search: "always" });
		this.#selectList.setSelectedIndex(this.#cursor);
		if (navigation)
			this.#selectList.restoreNavigation({
				...navigation,
				selectedValue: this.#options[this.#cursor]?.value,
			});
		this.#selectList.onSelect = item => this.#toggle(item.value);
		this.#selectList.onSelectionChange = item => {
			this.#cursor = this.#options.findIndex(option => option.value === item.value);
		};
		this.#selectList.onCancel = this.#onClose;
		const back = `${editorKey("tui.select.cancel")} to go back`;
		const hint = this.#ordered
			? `  Click to toggle · drag selected items to reorder · h/l move · 1-9 place · / search · ${back}`
			: `  Click/${editorKey("tui.select.confirm")}/${formatKeyHint("space")} to toggle · ${back}`;
		this.#field = new FormField(this.#selectList, {
			theme: formTheme,
			label: this.#title,
			description: this.#description || undefined,
			hint,
		});
		this.addChild(this.#field);
	}

	/** The highlighted option (a native settings page rings it). */
	get prefsOption(): string | undefined {
		return this.#selectList.getSelectedItem()?.value;
	}

	/** Applies a whole new selection (a native page's chip toggle or drag), as a key toggle or move does. */
	setValues(next: readonly string[]): void {
		this.#apply(next.filter(id => this.#options.some(option => option.value === id)));
	}

	#apply(next: string[]): void {
		this.#value = next;
		this.#onApply([...next]);
		this.#rebuild();
	}

	#toggle(id: string): void {
		const next = this.#value.includes(id) ? this.#value.filter(v => v !== id) : [...this.#value, id];
		this.#apply(next);
	}

	#move(id: string, delta: -1 | 1): void {
		const from = this.#value.indexOf(id);
		if (from === -1) return;
		const to = from + delta;
		if (to < 0 || to >= this.#value.length) return;
		const next = [...this.#value];
		next[from] = next[to]!;
		next[to] = id;
		this.#apply(next);
	}

	/** Move a selected item before another selected item, retaining every other preference. */
	#moveBefore(id: string, beforeId: string): void {
		if (id === beforeId) return;
		const next = this.#value.filter(value => value !== id);
		const target = next.indexOf(beforeId);
		if (target === -1) return;
		next.splice(target, 0, id);
		this.#apply(next);
	}

	/** Splice the option into the 1-based `position` of the selection (adding it if unselected). */
	#placeAt(id: string, position: number): void {
		const next = this.#value.filter(v => v !== id);
		next.splice(Math.min(position - 1, next.length), 0, id);
		this.#apply(next);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		this.#keys.reset();
		const controlLine = this.#field.controlLineAt(line);
		if (controlLine === undefined) return;
		const itemIndex = this.#selectList.hitTest(controlLine);
		if (event.wheel !== null) {
			routeSelectListMouse(this.#selectList, event, controlLine);
			return;
		}
		if (event.motion) {
			this.#selectList.setHoverIndex(itemIndex ?? null);
			const target = itemIndex === undefined ? undefined : this.#selectList.pickerView().items[itemIndex]?.value;
			if (
				this.#ordered &&
				this.#pressedItemId !== undefined &&
				target !== undefined &&
				target !== this.#pressedItemId &&
				this.#value.includes(target)
			) {
				this.#dropItemId = target;
			}
			return;
		}
		if (event.leftClick && itemIndex !== undefined) {
			const item = this.#selectList.pickerView().items[itemIndex];
			if (!item) return;
			this.#cursor = this.#options.findIndex(option => option.value === item.value);
			this.#selectList.setSelectedIndex(itemIndex);
			this.#pressedItemId = item.value;
			this.#dropItemId = item.value;
			return;
		}
		if (!event.release) return;

		const pressedItemId = this.#pressedItemId;
		const dropItemId = this.#dropItemId;
		this.#pressedItemId = undefined;
		this.#dropItemId = undefined;
		if (!pressedItemId) return;
		if (this.#ordered && dropItemId !== undefined && dropItemId !== pressedItemId) {
			this.#moveBefore(pressedItemId, dropItemId);
			return;
		}
		this.#toggle(pressedItemId);
	}

	handleInput(data: string): void {
		if (this.#selectList.filterFocused) {
			this.#keys.reset();
			this.#selectList.handleInput(data);
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		const current = this.#selectList.getSelectedItem()?.value;
		if (action?.kind === "toggle" && current !== undefined) {
			this.#toggle(current);
			return;
		}
		if (action?.kind === "horizontal") {
			if (this.#ordered && current !== undefined) this.#move(current, action.delta);
			else if (!this.#ordered && action.delta < 0) this.#onClose();
			return;
		}
		if (this.#ordered && current !== undefined && data.length === 1 && data >= "1" && data <= "9") {
			this.#placeAt(current, Number(data));
			return;
		}
		if (action) this.#selectList.handleNavigation(action);
		else this.#selectList.handleInput(data);
	}

	get filterFocused(): boolean {
		return this.#selectList.filterFocused;
	}

	navigationSnapshot(): unknown {
		return { list: this.#selectList.navigationSnapshot(), value: [...this.#value] };
	}

	restoreNavigation(snapshot: unknown): void {
		this.#keys.reset();
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as { list?: unknown; value?: string[] };
		if (Array.isArray(state.value))
			this.#value = state.value.filter(value => this.#options.some(option => option.value === value));
		this.#rebuild();
		this.#selectList.restoreNavigation(state.list);
		this.#cursor = this.#options.findIndex(option => option.value === this.#selectList.getSelectedItem()?.value);
	}
}

class ProviderLimitsSubmenu extends Container {
	#listField: SelectFormField | undefined;
	readonly #settings: SettingsHost;
	readonly #providers: readonly string[];
	readonly #onChange: (value: Record<string, number>) => void;
	readonly #onCancel: () => void;
	readonly #requestRender: (() => void) | undefined;
	#editingProvider: string | undefined;
	#restoringNavigation = false;
	#listNavigation: unknown;
	readonly #keys = new MenuKeyReader();
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;

	constructor(
		settings: SettingsHost,
		providers: readonly string[],
		onChange: (value: Record<string, number>) => void,
		onCancel: () => void,
		requestRender?: () => void,
	) {
		super();
		this.#settings = settings;
		this.#providers = providers;
		this.#onChange = onChange;
		this.#onCancel = onCancel;
		this.#requestRender = requestRender;
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = this.#settings.normalizeProviderLimits(this.#settings.get("providers.maxInFlightRequests"));
		return [...new Set([...this.#providers, ...Object.keys(limits)])].sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		const previous = this.navigationSnapshot();
		const changedPage = this.#editingProvider !== undefined;
		this.#keys.reset();
		if (!this.#restoringNavigation && this.#listField) this.#listNavigation = this.#listField.navigationSnapshot();
		this.#editingProvider = undefined;
		this.clear();

		const limits = this.#settings.normalizeProviderLimits(this.#settings.get("providers.maxInFlightRequests"));
		const providerItems = this.#providerIds().map((provider): SelectItem => {
			const limit = limits[provider];
			return {
				value: provider,
				label: provider,
				description: limit === undefined ? "Unlimited" : `Limit: ${limit}`,
			};
		});
		const clearItem: SelectItem[] =
			Object.keys(limits).length === 0
				? []
				: [{ value: "__clear_all", label: "Clear all limits", description: "Make every provider unlimited" }];
		const items = [...providerItems, ...clearItem];
		this.#listField = new SelectFormField({
			theme: formTheme,
			label: "Max In-Flight Requests",
			description:
				"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: `  ${editorKey("tui.select.confirm")} to edit provider · ${editorKey("tui.select.cancel")} to go back`,
			onSubmit: value => {
				if (value === "__clear_all") {
					this.#settings.set("providers.maxInFlightRequests", {});
					this.#onChange({});
					this.#requestRender?.();
					return;
				}
				this.#showProviderEditor(value);
			},
			onCancel: this.#onCancel,
			requestRender: this.#requestRender,
		});
		this.addChild(this.#listField);
		if (this.#listNavigation !== undefined) this.#listField.restoreNavigation(this.#listNavigation);
		if (changedPage && !this.#restoringNavigation) this.onNavigationVisit?.("", previous);
	}

	#showProviderEditor(provider: string): void {
		const previous = this.navigationSnapshot();
		this.#keys.reset();
		if (!this.#restoringNavigation && this.#listField) this.#listNavigation = this.#listField.navigationSnapshot();
		this.#editingProvider = provider;
		const limits = this.#settings.normalizeProviderLimits(this.#settings.get("providers.maxInFlightRequests"));
		this.clear();
		this.#listField = undefined;
		this.addChild(
			new TextFormField({
				theme: formTheme,
				label: `Max In-Flight Requests: ${provider}`,
				description:
					"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
				initialValue: limits[provider]?.toString() ?? undefined,
				empty: "submit",
				hint: `  ${editorKey("tui.input.submit")} to save · ${editorKey("tui.select.cancel")} to cancel · Clear field to unset`,
				validate: value => {
					if (value.trim() === "") return undefined;
					const limit = Number(value.trim());
					if (!Number.isFinite(limit) || limit <= 0) return "Limit must be a positive number.";
					return undefined;
				},
				onSubmit: value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error("Limit must be a positive number.");
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = this.#settings.validateProviderLimits(next);
					this.#settings.set("providers.maxInFlightRequests", normalized);
					this.#onChange(normalized);
					this.#requestRender?.();
				},
				onCancel: () => {
					this.#showProviderList();
					this.#requestRender?.();
				},
				requestRender: this.#requestRender,
			}),
		);
		if (!this.#restoringNavigation) this.onNavigationVisit?.(provider, previous);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#keys.reset();
		this.#listField?.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		if (this.#listField) {
			const list = this.#listField.selectList;
			if (list.filterFocused) {
				this.#keys.reset();
				this.#listField.handleInput(data);
				return;
			}
			const action = this.#keys.read(data);
			if (action === "pending") return;
			const selected = list.getSelectedItem();
			if (action?.kind === "horizontal") {
				if (action.delta < 0) this.#onCancel();
				else if (selected && selected.value !== "__clear_all") list.onSelect?.(selected);
				return;
			}
			if (action?.kind === "toggle" && selected?.value === "__clear_all") return;
			if (action) list.handleNavigation(action);
			else this.#listField.handleInput(data);
			return;
		}
		this.#keys.reset();
		this.children[0]?.handleInput?.(data);
	}

	get filterFocused(): boolean {
		const child = this.children[0];
		return child instanceof FormField ? child.filterFocused : false;
	}

	navigationSnapshot(): unknown {
		const child = this.children[0];
		return {
			provider: this.#editingProvider,
			list: this.#listField?.navigationSnapshot() ?? this.#listNavigation,
			content: isMenuHistoryParticipant(child) ? child.navigationSnapshot() : undefined,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as { provider?: string; list?: unknown; content?: unknown };
		this.#restoringNavigation = true;
		try {
			this.#keys.reset();
			this.#listNavigation = state.list;
			if (state.provider !== undefined) this.#showProviderEditor(state.provider);
			else this.#showProviderList();
			const child = this.children[0];
			if (isMenuHistoryParticipant(child)) child.restoreNavigation(state.content);
		} finally {
			this.#restoringNavigation = false;
		}
	}
}

/** Stable sidebar width derived from the host's complete schema. */
function settingsSidebarWidth(entries: readonly SettingsDisplayEntry[]): number {
	let nameWidth = 0;
	for (const tab of SETTING_TABS) {
		for (const def of getSettingsForTab(entries, tab)) {
			if (def.group) nameWidth = Math.max(nameWidth, visibleWidth(def.group));
		}
	}
	return Math.min(22, nameWidth) + 4;
}

function getSettingsTabs(): Tab[] {
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon);
			return { id, label: `${icon} ${meta.label}`, short: icon };
		}),
		{ id: "plugins", label: `${theme.icon.package} Plugins`, short: theme.icon.package },
	];
}

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not Settings.
 */
export interface SettingsRuntimeContext {
	settings: SettingsHost;
	plugins: PluginSettingsHost;
	/** Available thinking levels (from session) */
	availableThinkingLevels: Effort[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Provider/source ids shown in /model. */
	providers: string[];
	/** Active model (api + id); resolves what the snapcompact `auto` shape maps to. */
	model?: ShapeTarget;
	/** Shared TUI image budget (graphics ids + transmit-once) for image previews. */
	imageBudget?: ImageBudget;
	/** Schedules a re-render after async preview work completes. */
	requestRender?: () => void;
	/** Live status renderer for composer-shape previews (the session's status line). */
	composerPreviewStatus?: ComposerPreviewStatusSource;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	contextLine?: ContextLineMode;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	sessionAccent?: boolean;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
}

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: string, newValue: unknown) => void;
	/** Called for theme preview while browsing */
	onThemePreview?: (theme: string) => void | Promise<void>;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Native status bar for the inline preview (TSP terminals dock the bar; its ANSI border geometry doesn't apply) */
	describeStatusLinePreview?: () => NativeNode;
	/** Called when plugins change */
	onPluginsChanged?: () => void | Promise<void>;
	/** Called when settings panel is closed */
	onCancel: () => void;
	/** Edit the persisted settings file, then re-read it before resolving. */
	onOpenConfigFile?: () => Promise<void>;
	/** Persist and apply the selected scope to other sessions through the host's reload mechanism. */
	onApply?: (scope: "global" | "project" | "session") => Promise<string>;
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	/** The tab bar's current tab list (the bar keeps no public getter). */
	#tabs: Tab[];
	readonly #native: SettingsNativeMemo = { hints: {} };
	/** Changed-setting counts per tab for the native page nav, cleared whenever the items rebuild. */
	readonly #changedCounts = new Map<SettingTab, number>();
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#pendingPluginWrites = 0;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#preSearchTabId: SettingTab | "plugins" = "appearance";
	#preSearchList: SettingsListNavigationState | undefined;
	#searchQuery = "";
	/** Single-line editor backing the search banner (cursor, word ops, paste). */
	readonly #search = new MenuSearchField();
	#searchMatchCount = 0;
	/** First matching item id per tab id, for Tab-key jumps while searching. */
	#searchFirstMatch = new Map<string, string>();
	/**
	 * Per-tab search candidates prepared once per search session. Dropped on
	 * search start/end and whenever a value or condition may have changed
	 * (`#refreshItems`, `#onSearchSettingChange`); rebuilt lazily by `#setSearchQuery`.
	 */
	#searchCorpora: { tab: SettingTab; corpus: FuzzyCorpus<SettingItem> }[] | null = null;
	#textInputActive = false;
	#restoringNavigation = false;
	#externalEditPending = false;
	#applyPending = false;
	#applyFeedback = "";
	#stopReload?: () => void;
	#editingSetting?: { path: string; baseline: string | undefined; changedElsewhere: boolean };
	readonly #menuKeys = new MenuKeyReader();
	readonly #help = new MenuHelp();
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	#hasSectionJump = false;
	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;
	#sidebarWidth: number;
	readonly #context: SettingsRuntimeContext;
	readonly #callbacks: SettingsCallbacks;

	constructor(context: SettingsRuntimeContext, callbacks: SettingsCallbacks) {
		this.#context = context;
		this.#callbacks = callbacks;
		this.#sidebarWidth = settingsSidebarWidth(context.settings.entries);
		// No label prefix (the frame title already says Settings) and no
		// "(tab to cycle)" hint (folded into the footer hint line).
		const tabs = getSettingsTabs();
		this.#tabs = tabs;
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingTab | "plugins";
			if (this.#searchList) {
				// While searching, tabs act as jump targets into the result list.
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};

		// Initialize with first tab
		this.#switchToTab("appearance");
		this.#stopReload = context.settings.onReload?.(() => this.#refreshReloadedSettings());
	}

	dispose(): void {
		this.#stopReload?.();
		this.#stopReload = undefined;
	}

	/** Refresh existing lists: setItems preserves their cursor, filter, viewport and open editor. */
	#refreshReloadedSettings(): void {
		const edit = this.#editingSetting;
		if (edit && JSON.stringify(this.#context.settings.get(edit.path)) !== edit.baseline)
			edit.changedElsewhere = true;
		this.#changedCounts.clear();
		// An empty global search still displays the underlying tab.
		if (this.#searchList && this.#currentTabId !== "plugins")
			this.#refreshCurrentTabItems(getSettingsForTab(this.#context.settings.entries, this.#currentTabId));
		this.#refreshItems();
		this.#context.requestRender?.();
	}

	#editSetting(path: string, done: (value?: string) => void, build: (finish: (value?: string) => void) => Component): Component {
		this.#editingSetting = {
			path,
			baseline: JSON.stringify(this.#context.settings.get(path)),
			changedElsewhere: false,
		};
		return build(value => {
			this.#editingSetting = undefined;
			done(value);
			this.#refreshItems();
		});
	}

	#getReloadConflict(): string | undefined {
		const edit = this.#editingSetting;
		if (!edit?.changedElsewhere) return undefined;
		const label = getSettingDef(this.#context.settings.entries, edit.path)?.label ?? edit.path;
		return `${label}: changed elsewhere — your edit is preserved`;
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
	}

	/** Swap the active content (per-tab list, search list, or plugins). */
	#setContent(build: () => void): void {
		this.#menuKeys.reset();
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
		this.#wireNavigation();
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else {
				this.#showSettingsTab(tabId);
			}
		});
	}

	#footerHintText(): string {
		const confirm = editorKey("tui.select.confirm");
		const cancel = editorKey("tui.select.cancel");
		const tab = formatKeyHint("tab");
		if (this.#searchList) {
			return this.#search.focused
				? `${confirm} confirm search · ${cancel} clear search`
				: `/ search · ${tab} jump tabs · ${cancel} clear search · ? help`;
		}
		if (this.#currentTabId === "plugins") {
			return this.#pluginComponent?.atRoot
				? `${tab} tabs · / search · ${cancel} close · ? help`
				: `${tab} tabs · / search · ${cancel} back · ? help`;
		}
		if (this.#currentList?.sectionFocused) {
			return `${tab}/${confirm} settings · ${cancel} close · ? help`;
		}
		const nav = this.#hasSectionJump ? `${tab} sections` : `${tab} tabs`;
		return `${confirm}/${formatKeyHint("space")} change · ${nav} · Ctrl+S scope${this.#callbacks.onApply ? " · F6 Apply" : ""} · / search · ${cancel} close${this.#callbacks.onOpenConfigFile ? " · Ctrl+G config file" : ""} · ? help${this.#applyFeedback ? ` · ${this.#applyFeedback}` : ""}`;
	}

	#scopeTitle(styled = false): string {
		const active = this.#context.settings.scope ?? "global";
		const scopes = ["global", "project", "session"].map(scope => scope === active
			? styled ? theme.bold(theme.fg("accent", `[${scope.toUpperCase()}]`)) : `[${scope.toUpperCase()}]`
			: scope);
		return `Settings · ${scopes.join(" / ")} · Ctrl+S cycle scope`;
	}

	/** Single-line search banner: accent icon, editable query with live cursor, right-aligned match count. */
	#renderSearchBanner(width: number): string {
		const icon = theme.symbol("icon.search");
		const countText = this.#searchMatchCount === 1 ? "1 match" : `${this.#searchMatchCount} matches`;
		const rightWidth = visibleWidth(countText) + 1; // trailing margin
		const prefix = ` ${theme.fg("accent", icon)} `;
		// The input pads itself to exactly this width and keeps the cursor in view.
		const inputWidth = Math.max(4, width - visibleWidth(prefix) - rightWidth - 1);
		const inputLine = this.#search.render(inputWidth, { muted: text => theme.fg("muted", text) });
		const count = theme.fg(this.#searchMatchCount > 0 ? "dim" : "warning", countText);
		return truncateToWidth(`${prefix}${theme.bold(inputLine)} ${count} `, width);
	}

	get #hasSearchResults(): boolean {
		return this.#searchList !== null && this.#searchQuery.length > 0 && this.#search.value.length > 0;
	}

	get #displayList(): SettingsList | null {
		return this.#hasSearchResults ? this.#searchList : this.#currentList;
	}

	/**
	 * Fullscreen frame: title border, tab row, divider, optional search banner,
	 * the active content sized to fill the terminal, the appearance preview,
	 * then a footer hint pinned above the bottom border.
	 */
	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(1, width - 4);
		const hints = menuHintLines(
			this.#getReloadConflict() ?? this.#footerHintText(),
			innerWidth,
			this.#search.focused || this.#textInputActive ? "" : undefined,
		);

		const tabLines = this.#tabBar.render(innerWidth);
		const searching = this.#hasSearchResults;
		const showSearch = searching || this.#search.focused;
		const showPreview = !searching && this.#currentTabId === "appearance";
		const previewLines = showPreview ? ["", theme.fg("muted", "Preview:"), this.#getStatusPreviewString()] : [];

		// Fixed chrome: top border, tabs, divider, [search row], divider, hint, bottom border.
		const fixedRows = 1 + tabLines.length + 1 + (showSearch ? 1 : 0) + 1 + hints.length + 1;
		const contentRows = Math.max(7, height - fixedRows - previewLines.length);

		const list = this.#displayList;
		let contentLines: readonly string[];
		if (list) {
			// SettingsList pads itself to viewport + blank + 3 description rows.
			list.setMaxVisible(contentRows - 4);
			contentLines = list.render(innerWidth);
		} else if (this.#pluginComponent) {
			contentLines = this.#pluginComponent.render(innerWidth);
		} else {
			contentLines = [];
		}

		const out: string[] = [];
		out.push(topBorder(width, this.#scopeTitle(true)));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		if (showSearch) {
			out.push(row(this.#renderSearchBanner(innerWidth), width));
		}
		this.#contentRowStart = out.length;
		this.#contentRowCount = contentRows;
		for (let i = 0; i < contentRows; i++) {
			out.push(row(contentLines[i] ?? "", width));
		}
		for (const line of previewLines) {
			out.push(row(line, width));
		}
		out.push(divider(width));
		for (const hint of hints) out.push(row(theme.fg("dim", hint), width));
		out.push(bottomBorder(width));
		return this.#help.render(out, width);
	}

	/**
	 * Over a live session the native page is its own sheet: the backend puts
	 * it in `layer`, where a terminal with the `aside` feature docks it at the
	 * pane's right edge with the transcript beside it. Without `aside` it
	 * fills a screen surface instead.
	 */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	/**
	 * The native settings page (`prefs`) when the terminal draws it, else the
	 * root card of today's generic composition.
	 */
	describe(cx: DescribeContext): NativeNode {
		if (this.#help.open) return this.#help.describe();
		return cx.supports("prefs") ? this.#describePrefs() : this.#describeCard();
	}

	/**
	 * The settings as a native page: every tab (and the plugins page) in the
	 * nav with its changed count, the current tab's sections (or the search
	 * results grouped by tab), the keyboard focus and open editor, the
	 * status-line preview on Appearance, and editors without a native control
	 * (large choice pickers, provider limits) as children over the page.
	 */
	#describePrefs(): NativeNode {
		const memo = this.#native;
		const searching = this.#hasSearchResults;
		const list = this.#displayList;
		const entries = this.#context.settings.entries;
		const plugins = this.#currentTabId === "plugins" ? this.#pluginComponent : null;
		const pluginPage = plugins?.prefsPage();
		const tab = this.#currentTabId === "plugins" ? undefined : this.#currentTabId;

		const pages: TspPrefsProps["pages"][number][] = SETTING_TABS.map(id => {
			const changed = this.#changedCount(id);
			return { id, label: TAB_METADATA[id].label, icon: id, changed: changed > 0 ? changed : undefined };
		});
		pages.push({ id: PLUGINS_PAGE, label: "Installed", icon: "plugins", group: "Plugins" });

		let sections: TspPrefsProps["sections"] = [];
		let focus: string | null = null;
		let editing: TspPrefsProps["editing"] = null;
		const children: NativeChild[] = [];
		if (pluginPage) {
			sections = pluginPage.sections;
			focus = pluginPage.focus;
			editing = pluginPage.editing;
			if (pluginPage.editor) children.push(pluginPage.editor);
		} else if (list) {
			sections = list.prefsSections(
				item => {
					const def = getSettingDef(entries, item.id);
					const group = def?.group ?? "General";
					const id = prefsSectionId(group);
					return searching && def ? { id: `${def.tab}/${id}`, title: group, page: def.tab } : { id, title: group };
				},
				item => this.#prefsControl(item.id, item.currentValue),
			);
			const at = list.prefsFocus();
			focus = at.row ?? (at.section ? prefsSectionId(at.section) : null);
			editing = list.prefsEditing(id => this.#inlineMenu(id));
			const open = list.openSubmenu;
			if (open && !editing) {
				// Pickers describe themselves as a sheet; anything else sits in a card over the page.
				children.push(
					open.component instanceof SelectFormField
						? open.component
						: col([open.component], { role: PREFS_EDITOR_ROLE }),
				);
			}
		}

		if (tab === "appearance" && !searching) {
			const source = this.#getStatusPreviewString();
			if (memo.prefsPreview?.source !== source) {
				memo.prefsPreview = {
					source,
					node: node(
						"col",
						{ role: PREFS_STATUS_ROLE },
						[
							this.#callbacks.describeStatusLinePreview?.() ??
								text(styledSpans(source), { wrap: "none", truncate: "end" }),
						],
						"status-preview",
					),
				};
			}
			children.push(memo.prefsPreview.node);
		}

		const searchError = searching ? compileMenuRegex(this.#searchQuery)?.error : undefined;
		const props: TspPrefsProps = {
			title: this.#scopeTitle(),
			pages,
			page: searching ? this.#preSearchTabId : this.#currentTabId,
			lead: [
				searchError ? `Invalid regex: ${searchError}`
					: searching ? undefined : (pluginPage?.lead ?? (tab ? TAB_LEADS[tab] : undefined)),
				`Ctrl+S cycle scope${this.#callbacks.onApply ? " · F6 Apply" : ""}`,
				this.#applyFeedback,
				this.#getReloadConflict(),
			].filter(Boolean).join(" · "),
			query: searching || this.#search.focused ? this.#search.value : pluginPage?.query,
			cursor: searching || this.#search.focused ? this.#search.input.getCursor() : pluginPage?.cursor,
			sections,
			focus,
			editing,
		};
		const signature = JSON.stringify(props);
		if (memo.prefs && memo.prefs.signature === signature && sameItems(memo.prefs.children, children)) {
			return memo.prefs.node;
		}
		const root = node("prefs", props, children);
		memo.prefs = { signature, children, node: root };
		return root;
	}

	/** Settings changed from their default on `tab` (visible ones only); cached until the items rebuild. */
	#changedCount(tab: SettingTab): number {
		const cached = this.#changedCounts.get(tab);
		if (cached !== undefined) return cached;
		let count = 0;
		for (const def of getSettingsForTab(this.#context.settings.entries, tab)) {
			if (def.condition && !def.condition()) continue;
			if (this.#isChanged(def, this.#getCurrentValue(def))) count++;
		}
		this.#changedCounts.set(tab, count);
		return count;
	}

	/** Whether row `id`'s choices fit its popup menu (else the submenu opens as a picker over the page). */
	#inlineMenu(id: string): boolean {
		const def = getSettingDef(this.#context.settings.entries, id);
		return def?.type !== "submenu" || this.#submenuOptions(def).length <= PREFS_MENU_MAX;
	}

	/** Setting `id`'s typed control for the native page; `shown` is the list's display value. */
	#prefsControl(id: string, shown: string): TspPrefsControl | undefined {
		const def = getSettingDef(this.#context.settings.entries, id);
		if (!def) return undefined;
		const value = this.#getCurrentValue(def);
		switch (def.type) {
			case "boolean":
				return { k: "switch", on: value === true };
			case "enum":
				return { k: "choice", value: shown, options: def.values.map(v => ({ value: v, label: v })) };
			case "submenu": {
				const labels = numberSteps(def);
				if (labels) {
					const n = Number(value);
					return { k: "number", value: Number.isFinite(n) ? n : -1, labels };
				}
				const options = this.#submenuOptions(def).map(o => ({
					value: o.value,
					label: o.label,
					detail: o.description,
				}));
				// Few short plain choices segment; described ones and live-previewed ones
				// (hovering the menu previews, see #createSubmenu) keep the menu.
				return {
					k: "choice",
					value: shown,
					options,
					style: PREVIEWED_SETTINGS.has(def.path) || options.some(o => o.detail) ? "menu" : "auto",
					mono: options.every(o => o.label === o.value),
				};
			}
			case "text":
				return {
					k: "text",
					value: shown,
					secret: def.secret || undefined,
					mono: !def.secret && MONO_TEXT_SETTING.test(def.path) ? true : undefined,
				};
			case "providerLimits":
				return { k: "action", label: "Edit…", act: "edit" };
			case "multiselect":
				return {
					k: "multi",
					values: Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
					options: def.options.map(o => ({ value: o.value, label: o.label, detail: o.description })),
					ordered: def.ordered || undefined,
				};
		}
	}

	/** The default of `def` as its control names it (the changed dot's title). */
	#defaultLabel(def: SettingDef): string {
		const value: unknown = def.defaultValue;
		switch (def.type) {
			case "boolean":
				return value ? "On" : "Off";
			case "submenu": {
				const raw = this.#getSubmenuCurrentValue(def.path, value);
				return this.#submenuOptions(def).find(o => o.value === raw)?.label ?? raw;
			}
			case "multiselect":
				return this.#formatMultiSelectValue(def, value);
			case "text":
				return def.secret ? "" : this.#formatTextInputEditValue(def.path, value);
			default:
				return value === undefined || value === null ? "" : String(value);
		}
	}

	/**
	 * Pointer actions on the native page, each through the code the keys use:
	 * a page click switches tabs (leaving a search), a row click moves the
	 * selection, a value change goes through the row's cycle, submenu or text
	 * field (`null` unsets the setting), menu hovers preview, and closing an
	 * open menu cancels it (reverting its preview).
	 */
	#handlePrefsEvent(event: NativeUiEvent): void {
		this.#menuKeys.reset();
		if (event.type === "action" && event.act === "close" && event.value === undefined) {
			const list = this.#searchList ?? this.#currentList;
			if (
				(this.#searchList && (this.#search.focused || this.#searchQuery.length > 0)) ||
				list?.filterFocused ||
				list?.hasSearchQuery() ||
				this.#pluginComponent?.filterFocused ||
				this.#pluginComponent?.prefsPage()?.query
			) {
				this.handleInput(ESCAPE);
				return;
			}
		}
		if (this.#currentTabId === "plugins" && this.#pluginComponent) {
			if (event.type === "action" && event.act === "page" && event.value === PLUGINS_PAGE) {
				this.#switchToTab("plugins");
				return;
			}
			if (
				!(event.type === "action" && (event.act === "page" || (event.act === "close" && event.value === undefined)))
			) {
				this.#pluginComponent.handlePrefsEvent(event);
				return;
			}
		}
		const list = this.#searchList ?? this.#currentList;
		switch (event.type) {
			case "action":
				if (event.act === "page" && event.value) {
					this.#showPage(event.value);
				} else if (event.act === "close") {
					if (event.value === undefined) this.#callbacks.onCancel();
					else if (list?.openSubmenu?.id === event.value) list.handleInput(ESCAPE);
				} else if (event.act === "edit" && event.value) {
					list?.openSubmenuFor(event.value);
				}
				return;
			case "select": {
				if (!list) return;
				const eq = event.item.indexOf("=");
				if (eq >= 0) {
					const open = list.openSubmenu;
					if (open?.id !== event.item.slice(0, eq) || !(open.component instanceof SelectFormField)) return;
					const select = open.component.selectList;
					select.setSelectedValue(event.item.slice(eq + 1));
					const item = select.getSelectedItem();
					if (item) select.onSelectionChange?.(item);
					return;
				}
				if (list.openSubmenu) list.handleInput(ESCAPE);
				list.selectItem(event.item);
				return;
			}
			case "activate":
				list?.openSubmenuFor(event.item);
				return;
			case "change":
				if (list) this.#applyPrefsChange(list, event.item, event.value);
				return;
			case "toggle":
				return;
		}
	}

	/** Shows page `id` (a tab or the plugins page), leaving a search. */
	#showPage(id: string): void {
		if (this.#searchList) this.#endSearch(false);
		if (id !== this.#currentTabId) this.#tabBar.selectTab(id);
	}

	/** A pointer value change on row `id`, through the path its keys take (see {@link #handlePrefsEvent}). */
	#applyPrefsChange(
		list: SettingsList,
		id: string,
		value: boolean | number | string | readonly string[] | null,
	): void {
		const def = getSettingDef(this.#context.settings.entries, id);
		if (!def) return;
		if (value === null) {
			if (list.openSubmenu) list.handleInput(ESCAPE);
			this.#context.settings.unset(def.path);
			this.#callbacks.onChange(def.path, this.#context.settings.get(def.path));
			if (def.tab === "appearance") this.#triggerStatusLinePreview();
			this.#refreshItems();
			return;
		}
		switch (def.type) {
			case "boolean":
				if (typeof value === "boolean") list.applyValue(id, String(value));
				return;
			case "enum":
				if (typeof value === "string") list.applyValue(id, value);
				return;
			case "submenu": {
				const choice =
					typeof value === "number"
						? this.#submenuOptions(def).find(o => numericOption(o.value) === value)?.value
						: typeof value === "string"
							? value
							: undefined;
				if (choice === undefined) return;
				const field = list.openSubmenuFor(id);
				if (field instanceof SelectFormField) {
					field.selectList.handleNativeEvent({ type: "activate", key: "", item: choice });
				} else if (field instanceof NumericSettingsField) {
					field.select(choice);
				}
				return;
			}
			case "text": {
				if (typeof value !== "string") return;
				const field = list.openSubmenuFor(id);
				if (field instanceof TextFormField) {
					field.setValue(value);
					field.submit();
				}
				return;
			}
			case "multiselect": {
				if (!Array.isArray(value)) return;
				const open = list.openSubmenu;
				if (open?.id === id && open.component instanceof MultiSelectSubmenu) {
					open.component.setValues(value);
					// The native page applies a chip toggle without closing its
					// editor, so the row and its tab badge only update here.
					this.#refreshItems();
					return;
				}
				const next = [...value];
				this.#context.settings.set(def.path, next);
				this.#callbacks.onChange(def.path, next);
				list.updateValue(id, this.#formatMultiSelectValue(def, next));
				this.#refreshItems();
				return;
			}
			case "providerLimits":
				return;
		}
	}

	/** Rebuilds the visible items after a change made outside a list's own `onChange` (changed flags, conditions). */
	#refreshItems(): void {
		if (this.#searchList) {
			this.#searchCorpora = null;
			this.#setSearchQuery(this.#searchQuery);
		} else if (this.#currentTabId !== "plugins")
			this.#refreshCurrentTabItems(getSettingsForTab(this.#context.settings.entries, this.#currentTabId));
	}

	/**
	 * Root card: tab strip, search field while searching, the active content
	 * component (settings list, search results, or plugins), the appearance
	 * status-line preview, and the footer hints.
	 */
	#describeCard(): NativeNode {
		const memo = this.#native;
		const searching = this.#hasSearchResults;
		const children: NativeChild[] = [];

		const active = this.#tabBar.getActiveTab()?.id;
		if (memo.tabs?.tabs !== this.#tabs || memo.tabs.active !== active) {
			memo.tabs = { tabs: this.#tabs, active, node: settingsTabsNode(this.#tabs, active) };
		}
		children.push(memo.tabs.node);

		if (searching || this.#search.focused) {
			const count = this.#searchMatchCount;
			if (memo.search?.input !== this.#search.input || memo.search.count !== count) {
				const countText = count === 1 ? "1 match" : `${count} matches`;
				memo.search = {
					input: this.#search.input,
					count,
					node: node(
						"row",
						{ gap: "xs", align: "center", role: "omp.settings.search" },
						[
							text([span(theme.symbol("icon.search"), "accent")]),
							col([this.#search.input], { grow: 1 }),
							text([span(countText, count > 0 ? "dim" : "warning")], { wrap: "none" }),
						],
						"search",
					),
				};
			}
			children.push(memo.search.node);
		}

		const content = this.#displayList ?? this.#pluginComponent;
		if (content) children.push(content);

		if (!searching && this.#currentTabId === "appearance") {
			const source = this.#getStatusPreviewString();
			if (memo.preview?.source !== source) {
				memo.preview = {
					source,
					node: node(
						"col",
						{ gap: "xs" },
						[
							text([span("Preview:", "muted")]),
							this.#callbacks.describeStatusLinePreview?.() ??
								text(styledSpans(source), { wrap: "none", truncate: "end" }),
						],
						"preview",
					),
				};
			}
			children.push(memo.preview.node);
		}

		const mode: SettingsHintMode = searching
			? "search"
			: this.#currentTabId === "plugins"
				? "plugins"
				: this.#currentList?.sectionFocused
					? "sections"
					: this.#hasSectionJump
						? "rows-sections"
						: "rows";
		memo.hints[mode] ??= settingsHintsNode(mode);
		children.push(memo.hints[mode]);

		if (memo.root && sameItems(memo.root.children, children)) return memo.root.node;
		const root = overlayCard("omp.overlay.settings", "Settings", children);
		memo.root = { children, node: root };
		return root;
	}

	/**
	 * Native page events (the root node, see {@link #handlePrefsEvent}); in the
	 * generic composition a tab pick does what a tab click does: switch tabs (or
	 * jump, while searching), unless an open submenu owns the pointer.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#menuKeys.reset();
		if (event.key === "") {
			this.#handlePrefsEvent(event);
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || event.key !== "tabs") return;
		if ((this.#searchList ?? this.#currentList)?.hasOpenSubmenu()) return;
		this.#tabBar.selectTab(event.item);
	}

	/**
	 * Route an SGR mouse report against the frame geometry of the last render.
	 * Wheel scrolls the focused list, motion drives the hover highlights (tabs
	 * and rows), and a left click activates: tabs switch (or jump, while
	 * searching), a row click selects, and a click on the already-selected row
	 * activates it (toggle / open submenu).
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const list = this.#displayList;
		// row() insets content by the border column plus a space.
		const contentColInset = 2;
		const innerCol = event.col - contentColInset;
		const contentLine = event.row - this.#contentRowStart;

		// An open submenu owns the pointer: wheel, hover, and clicks route into
		// it (text-input submenus ignore routed events).
		if (list?.hasOpenSubmenu()) {
			list.routeSubmenuMouse(event, contentLine, innerCol);
			return true;
		}

		const tabLine = event.row - this.#tabRowStart;
		const overTabs = tabLine >= 0 && tabLine < this.#tabRowCount;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;

		if (event.wheel !== null) {
			if (overContent) {
				list?.handleWheelAt(event.wheel, contentLine, innerCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			// hoverTest: never light up pane rows while the pointer is on the
			// sidebar — only rows the pointer is actually on.
			list?.setHoverItem(overContent ? (list.hoverTest(contentLine, innerCol) ?? null) : null);
			return true;
		}
		if (!event.leftClick) return true;

		if (overTabs) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) this.#tabBar.selectTab(tab.id);
			return true;
		}
		if (overContent && list) {
			const itemId = list.hoverTest(contentLine, innerCol);
			const id = itemId ?? list.hitTest(contentLine, innerCol);
			if (id !== undefined) {
				const wasSelected = list.getSelectedItem()?.id === id;
				list.selectItem(id);
				// Only repeated setting-row clicks activate. Sidebar section clicks navigate.
				if (wasSelected && itemId !== undefined) list.handleInput("\n");
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Global search (type-to-search across every tab)
	// ═══════════════════════════════════════════════════════════════════════

	/** Swap the tab content for the global search result list. */
	#startSearch(initialQuery: string): void {
		this.#preSearchTabId = this.#currentTabId;
		this.#preSearchList = this.#currentList?.navigationSnapshot();
		this.#searchCorpora = null;
		this.#search.setValue(initialQuery);
		this.#search.focused = true;
		const list = new SettingsList(
			[],
			10,
			getSettingsListTheme(),
			(id, newValue) => this.#onSearchSettingChange(id, newValue),
			() => this.#endSearch(false),
			{
				layout: "flat",
				typeToSearch: false,
				emptyText: "No matching settings",
				hint: "",
			},
		);
		// Keep the footer tab highlight on the tab owning the selected result.
		list.onSelectionChange = item => this.#syncTabBarToSelection(item);
		const currentList = this.#currentList;
		this.#setContent(() => {
			// Empty drafts show the original sectioned list, not all global results.
			this.#currentList = currentList;
			this.#searchList = list;
		});
		this.#setSearchQuery(initialQuery);
	}

	/**
	 * Recompute matches across every settings tab. Results render as one flat
	 * list with a heading row per tab; the footer tab bar reorders to show
	 * matching tabs (with counts) first and the rest muted at the end.
	 */
	#setSearchQuery(query: string): void {
		if (!this.#searchList) return;
		this.#searchQuery = query;
		this.#changedCounts.clear();

		const counts = new Map<SettingTab, number>();
		const items: SettingItem[] = [];
		const tabResults: { tab: SettingTab; matched: SettingItem[]; bestScore: number; order: number }[] = [];
		this.#searchFirstMatch.clear();
		let total = 0;
		this.#searchCorpora ??= SETTING_TABS.map(tab => {
			const candidates: SettingItem[] = [];
			for (const def of getSettingsForTab(this.#context.settings.entries, tab)) {
				const item = this.#defToItem(def);
				if (item) candidates.push(item);
			}
			return { tab, corpus: new FuzzyCorpus(candidates, getSettingItemFilterText) };
		});
		for (let order = 0; order < this.#searchCorpora.length; order++) {
			const { tab, corpus } = this.#searchCorpora[order]!;
			const ranked = corpus.rank(query);
			const matched = ranked.map(result => result.item);
			counts.set(tab, matched.length);
			if (matched.length === 0) continue;
			total += matched.length;
			tabResults.push({
				tab,
				matched,
				bestScore: ranked[0]?.score ?? 0,
				order,
			});
		}

		tabResults.sort((a, b) => a.bestScore - b.bestScore || a.order - b.order);
		for (const result of tabResults) {
			const meta = TAB_METADATA[result.tab];
			items.push({
				id: `__tab:${result.tab}`,
				label: `${theme.symbol(meta.icon)} ${meta.label}`,
				currentValue: "",
				heading: true,
			});
			this.#searchFirstMatch.set(result.tab, result.matched[0]?.id ?? "");
			items.push(...result.matched);
		}

		this.#searchList.setItems(items);
		this.#searchMatchCount = total;
		if (this.#hasSearchResults) {
			this.#tabs = this.#buildSearchTabs(
				counts,
				tabResults.map(result => result.tab),
			);
			this.#tabBar.setTabs(this.#tabs);
			this.#syncTabBarToSelection(this.#searchList.getSelectedItem());
		} else {
			this.#tabs = getSettingsTabs();
			this.#tabBar.setTabs(this.#tabs, this.#preSearchTabId);
		}
	}

	/**
	 * Leave search mode. With `jumpToSelection`, land on the tab containing
	 * the selected result and keep it selected there — search doubles as
	 * navigation. Otherwise restore the pre-search tab.
	 */
	#endSearch(jumpToSelection: boolean): void {
		if (!this.#searchList) return;
		const selected = jumpToSelection ? this.#searchList.getSelectedItem() : undefined;
		const selectedDef = selected ? getSettingDef(this.#context.settings.entries, selected.id) : undefined;
		const targetTab: SettingTab | "plugins" = selectedDef?.tab ?? this.#preSearchTabId;
		const previousList = this.#preSearchList;
		this.#preSearchList = undefined;

		this.#searchQuery = "";
		this.#search.setValue("");
		this.#search.focused = false;
		this.#searchCorpora = null;
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabs = getSettingsTabs();
		this.#tabBar.setTabs(this.#tabs, targetTab);
		this.#switchToTab(targetTab);
		if (!jumpToSelection && previousList) this.#currentList?.restoreNavigation(previousList);
		if (selectedDef) {
			this.#currentList?.selectItem(selectedDef.path);
		}
	}

	/** Matching tabs first (counts attached), ordered by best result score; the rest stay muted at the end. */
	#buildSearchTabs(counts: Map<SettingTab, number>, matchedTabOrder: readonly SettingTab[]): Tab[] {
		const matched: Tab[] = [];
		const empty: Tab[] = [];
		const matchedIds = new Set<SettingTab>(matchedTabOrder);
		for (const id of matchedTabOrder) {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon);
			const count = counts.get(id) ?? 0;
			if (count > 0) {
				matched.push({ id, label: `${icon} ${meta.label} (${count})`, short: `${icon} ${count}` });
			}
		}
		for (const id of SETTING_TABS) {
			if (matchedIds.has(id)) continue;
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon);
			empty.push({ id, label: `${icon} ${meta.label}`, short: icon, muted: true });
		}
		// Plugins hosts its own UI; it is not part of the schema-backed search.
		empty.push({
			id: "plugins",
			label: `${theme.icon.package} Plugins`,
			short: theme.icon.package,
			muted: true,
		});
		return [...matched, ...empty];
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#hasSearchResults || !item) return;
		const def = getSettingDef(this.#context.settings.entries, item.id);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

	/** Value-change dispatch for the search result list (any tab's setting). */
	#onSearchSettingChange(path: string, newValue: string): void {
		const def = getSettingDef(this.#context.settings.entries, path);
		if (!def) return;
		if (def.type === "boolean") {
			const boolValue = newValue === "true";
			this.#context.settings.set(path, boolValue);
			this.#callbacks.onChange(path, boolValue);
		} else if (def.type === "enum") {
			this.#context.settings.set(path, newValue);
			this.#callbacks.onChange(path, newValue);
		}
		// Submenu/text types already persisted inside their own done callbacks.
		if (def.tab === "appearance") {
			this.#triggerStatusLinePreview();
		}
		// Values feed the searchable text and condition gates may have flipped:
		// recompute results in place (selection is preserved by item id).
		this.#searchCorpora = null;
		this.#setSearchQuery(this.#searchQuery);
	}

	/**
	 * Convert a setting definition to a SettingItem for the UI.
	 */
	#defToItem(def: SettingDef): SettingItem | null {
		// Check condition: applies to every variant — booleans, enums, submenus, text inputs.
		if (def.condition && !def.condition()) {
			return null;
		}

		const currentValue = this.#getCurrentValue(def);
		const changed = this.#isChanged(def, currentValue);
		const item = {
			id: def.path,
			label: `${this.#context.settings.details?.(def.path).shadowed ? "󰈉 " : ""}${def.label}${provenanceSuffix(def.provenance)}`,
			description: [def.description, this.#context.settings.details?.(def.path).description].filter(Boolean).join("\n"),
			warning: [def.warning, this.#editingSetting?.path === def.path ? this.#getReloadConflict() : undefined].filter(Boolean).join("\n") || undefined,
			changed,
			defaultLabel: changed ? this.#defaultLabel(def) : undefined,
		};

		switch (def.type) {
			case "boolean":
				return { ...item, currentValue: currentValue ? "true" : "false", values: ["true", "false"] };

			case "enum":
				return { ...item, currentValue: String(currentValue ?? ""), values: [...def.values] };

			case "submenu":
				return {
					...item,
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
					submenu: (cv, done) => this.#editSetting(def.path, done, finish => this.#createSubmenu(def, cv, finish)),
				};

			case "text":
				return {
					...item,
					currentValue: this.#formatTextInputValue(def, currentValue),
					submenu: (cv, done) => this.#editSetting(def.path, done, finish => this.#createTextInput(def, cv, finish)),
				};

			case "providerLimits":
				return {
					...item,
					currentValue: this.#formatProviderLimitsValue(currentValue),
					submenu: (_cv, done) => this.#editSetting(def.path, done, finish => this.#createProviderLimitsInput(finish)),
				};

			case "multiselect":
				return {
					...item,
					currentValue: this.#formatMultiSelectValue(def, currentValue),
					submenu: (_cv, done) => this.#editSetting(def.path, done, finish => this.#createMultiSelect(def, finish)),
				};
		}
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		return this.#context.settings.get(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		const defaultValue: unknown = def.defaultValue;
		if (Array.isArray(currentValue) && Array.isArray(defaultValue)) {
			return (
				currentValue.length !== defaultValue.length ||
				currentValue.some((entry, index) => entry !== defaultValue[index])
			);
		}
		return !Object.is(currentValue, defaultValue);
	}

	#getSubmenuCurrentValue(path: string, value: unknown): string {
		const rawValue = String(value ?? "");
		const def = getSettingDef(this.#context.settings.entries, path);
		if (
			def?.schemaType === "number" &&
			def.type === "submenu" &&
			(rawValue === "-1" || rawValue === "") &&
			def.options.some(option => option.value === "default")
		)
			return "default";
		return rawValue;
	}

	/** A submenu's choices: the declared ones, or the runtime ones (thinking levels, themes, composer shapes). */
	#submenuOptions(def: SettingDef & { type: "submenu" }): readonly SubmenuOption[] {
		if (def.path === "defaultThinkingLevel") {
			// Prepend `auto`; the rest are the model's runtime-supported efforts.
			const levels: ConfiguredThinkingLevel[] = [AUTO_THINKING, ...this.#context.availableThinkingLevels];
			return levels.map(level => def.options.find(o => o.value === level) ?? { value: level, label: level });
		}
		if (def.path === "theme.dark" || def.path === "theme.light") {
			return this.#context.availableThemes.map(t => ({ value: t, label: t }));
		}
		if (def.path === "composer.shape") return getComposerShapeOptions();
		if (def.customInput)
			return [
				{ value: CUSTOM_NUMBER_OPTION, label: "Custom...", description: "Type an arbitrary number" },
				...def.options,
			];
		return def.options;
	}

	/**
	 * Create a submenu for a submenu-type setting.
	 */
	#createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Component {
		if (def.customInput) {
			return new NumericSettingsField(
				def,
				this.#submenuOptions(def),
				currentValue,
				value => {
					if (value === "") this.#context.settings.unset(def.path);
					else this.#setSettingValue(def.path, value);
					this.#callbacks.onChange(def.path, this.#context.settings.get(def.path));
					done(this.#getSubmenuCurrentValue(def.path, this.#context.settings.get(def.path)));
				},
				() => done(),
				this.#context.requestRender,
			);
		}
		const options = this.#submenuOptions(def);
		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;
		let footer: Component | undefined;

		const activeThemeBeforePreview = getCurrentThemeName() ?? currentValue;
		if (def.path === "theme.dark" || def.path === "theme.light") {
			onPreview = value => {
				if (!this.#context.settings.details?.(def.path).shadowed) return this.#callbacks.onThemePreview?.(value);
			};
			onPreviewCancel = () => {
				this.#callbacks.onThemePreview?.(activeThemeBeforePreview);
			};
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.#callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
			onPreviewCancel = () => {
				const currentPreset = this.#context.settings.get("statusLine.preset") as StatusLinePreset;
				const presetDef = getPreset(currentPreset);
				this.#callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
		} else if (def.path === "statusLine.separator") {
			onPreview = value => {
				this.#callbacks.onStatusLinePreview?.({ separator: value as StatusLineSeparatorStyle });
			};
			onPreviewCancel = () => {
				const separator = this.#context.settings.get("statusLine.separator") as StatusLineSeparatorStyle;
				this.#callbacks.onStatusLinePreview?.({ separator });
			};
		} else if (def.path === "statusLine.contextLine") {
			onPreview = value => {
				this.#callbacks.onStatusLinePreview?.({ contextLine: value as ContextLineMode });
			};
			onPreviewCancel = () => {
				this.#callbacks.onStatusLinePreview?.({
					contextLine: this.#context.settings.get("statusLine.contextLine") as ContextLineMode,
				});
			};
		} else if (def.path === "snapcompact.shape") {
			const shapePreview = new SnapcompactShapePreview(currentValue, {
				model: this.#context.model,
				imageBudget: this.#context.imageBudget,
				requestRender: this.#context.requestRender,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		} else if (def.path === "composer.shape") {
			const shapePreview = new ComposerShapePreview(String(currentValue ?? "band"), {
				requestRender: this.#context.requestRender,
				status: this.#context.composerPreviewStatus,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
		}
		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.#callbacks.getStatusLinePreview : undefined;

		return createSettingsSelectField(
			def.label,
			def.description,
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				this.#callbacks.onChange(def.path, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
			footer,
			this.#context.requestRender,
			isThemeSetting ? themePickerOptions(def.label, String(currentValue)) : undefined,
			onPreviewCancel,
		);
	}

	/**
	 * Create a text input submenu for a string or structured setting.
	 */
	#createTextInput(
		def: SettingDef & { type: "text" },
		_currentValue: string,
		done: (value?: string) => void,
	): Component {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return createSettingsTextField(
			def.label,
			def.description,
			this.#formatTextInputEditValue(def.path, this.#context.settings.get(def.path)),
			def.secret,
			value => {
				// An empty field removes the persisted value, so the default (or an
				// environment fallback) applies again instead of a pinned "".
				if (value === "") this.#context.settings.unset(def.path);
				else this.#setSettingValue(def.path, value);
				this.#callbacks.onChange(def.path, this.#context.settings.get(def.path));
				wrappedDone(this.#formatTextInputValue(def, this.#context.settings.get(def.path)));
			},
			() => wrappedDone(),
			this.#context.requestRender,
		);
	}

	#createProviderLimitsInput(done: (value?: string) => void): Container {
		return new ProviderLimitsSubmenu(
			this.#context.settings,
			this.#context.providers,
			value => {
				this.#callbacks.onChange("providers.maxInFlightRequests", value);
				done(this.#formatProviderLimitsValue(value));
			},
			() => done(),
			this.#context.requestRender,
		);
	}

	#formatProviderLimitsValue(value: unknown): string {
		const limits = this.#context.settings.normalizeProviderLimits(value);
		const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return "Unlimited";
		return entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}

	#createMultiSelect(def: SettingDef & { type: "multiselect" }, done: (value?: string) => void): Container {
		const current: unknown = this.#context.settings.get(def.path);
		const initial = Array.isArray(current)
			? current.filter((entry): entry is string => typeof entry === "string")
			: [];
		return new MultiSelectSubmenu(
			def.label,
			def.description,
			def.options,
			initial,
			def.ordered,
			value => {
				this.#context.settings.set(def.path, value);
				this.#callbacks.onChange(def.path, value);
			},
			() => done(this.#formatMultiSelectValue(def, this.#context.settings.get(def.path))),
		);
	}

	#formatMultiSelectValue(def: SettingDef & { type: "multiselect" }, value: unknown): string {
		const { options } = def;
		const labels = Array.isArray(value)
			? value.flatMap(entry => {
					if (typeof entry !== "string") return [];
					const option = options.find(candidate => candidate.value === entry);
					return option ? [option.label] : [];
				})
			: [];
		if (labels.length === 0) return def.ordered ? "default" : "none";
		return def.ordered ? labels.join(" → ") : labels.join(", ");
	}

	#formatTextInputValue(def: SettingDef & { type: "text" }, value: unknown): string {
		if (def.secret) return value ? "••••••••" : "";
		return this.#formatTextInputEditValue(def.path, value);
	}

	#formatTextInputEditValue(_path: string, value: unknown): string {
		if (value === undefined || value === null) return "";
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: string, value: string): void {
		const currentValue = this.#context.settings.get(path);
		const schemaType = getSettingDef(this.#context.settings.entries, path)?.schemaType;
		if (schemaType === "number") {
			this.#context.settings.set(path, value === "default" ? -1 : Number(value));
		} else if (schemaType === "array") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				throw new Error(`Invalid array JSON for ${path}`);
			}
			if (!Array.isArray(parsed)) throw new Error(`Invalid array JSON for ${path}`);
			this.#context.settings.set(path, parsed);
		} else if (schemaType === "record") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value || "{}");
			} catch {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = this.#context.settings.validateProviderLimits(parsed);
			}
			this.#context.settings.set(path, parsed);
		} else if (typeof currentValue === "number") {
			this.#context.settings.set(path, Number(value));
		} else if (typeof currentValue === "boolean") {
			this.#context.settings.set(path, value === "true");
		} else {
			this.#context.settings.set(path, value);
		}
	}

	/**
	 * Show a settings tab using definitions.
	 */
	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(this.#context.settings.entries, tabId);

		const items = this.#buildItemsForDefs(defs);
		// Mirror SettingsList's section detection (leading ungrouped items form
		// an implicit section) so the footer hint only advertises PgUp/PgDn
		// when the jump actually changes sections.
		const sectionCount = items.filter(item => item.heading).length + (items.length > 0 && !items[0].heading ? 1 : 0);
		this.#hasSectionJump = sectionCount >= 2;

		this.#currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const def = defs.find(d => d.path === id);
				if (!def) return;

				const path = def.path;

				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					this.#context.settings.set(path, boolValue);
					this.#callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					this.#context.settings.set(path, newValue);
					this.#callbacks.onChange(path, newValue);
				}
				// Submenu/text types already persisted the value inside their own
				// done callbacks before SettingsList re-dispatches here. Re-run the
				// definition-to-item mapping so condition-gated settings (e.g. the
				// Hindsight cluster guarded by memory.backend) appear/disappear
				// immediately instead of waiting for the next tab switch.
				this.#refreshCurrentTabItems(defs);
			},
			() => this.#callbacks.onCancel(),
			// The selector owns type-to-search and the footer hint; pin the
			// split sidebar width so the divider never jumps between tabs.
			{ typeToSearch: false, hint: "", sidebarWidth: this.#sidebarWidth },
		);
	}

	/**
	 * Map a definition list to UI items, dropping any whose condition is false.
	 * Inserts a heading row whenever the (group-sorted) definition list crosses
	 * into a new group; groups whose items are all condition-hidden emit none.
	 */
	#buildItemsForDefs(defs: SettingDef[]): SettingItem[] {
		this.#changedCounts.clear();
		const items: SettingItem[] = [];
		let lastGroup: string | undefined;
		for (const def of defs) {
			const item = this.#defToItem(def);
			if (!item) continue;
			if (def.group && def.group !== lastGroup) {
				items.push({ id: `__heading:${def.group}`, label: def.group, currentValue: "", heading: true });
				lastGroup = def.group;
			}
			items.push(item);
		}
		return items;
	}

	/** Re-evaluate condition gates against the current settings and refresh the active list. */
	#refreshCurrentTabItems(defs: SettingDef[]): void {
		if (this.#currentTabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs));
	}

	/**
	 * Get the status line preview string.
	 */
	#getStatusPreviewString(): string {
		if (this.#callbacks.getStatusLinePreview) {
			return this.#callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	#triggerStatusLinePreview(): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: this.#context.settings.get("statusLine.preset") as StatusLinePreset,
			leftSegments: this.#context.settings.get("statusLine.leftSegments") as StatusLineSegmentId[],
			rightSegments: this.#context.settings.get("statusLine.rightSegments") as StatusLineSegmentId[],
			separator: this.#context.settings.get("statusLine.separator") as StatusLineSeparatorStyle,
			sessionAccent: this.#context.settings.get("statusLine.sessionAccent") as boolean,
			transparent: this.#context.settings.get("statusLine.transparent") as boolean,
		};
		this.#callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.#context.plugins, {
			onClose: () => this.#callbacks.onCancel(),
			onPluginChanged: () => this.#callbacks.onPluginsChanged?.(),
			onPendingWrite: delta => {
				this.#pendingPluginWrites += delta;
			},
			requestRender: this.#context.requestRender,
		});
	}

	handleInput(data: string): void {
		if (
			(this.#help.open ||
				(!this.#search.focused &&
					!this.#textInputActive &&
					!this.#pluginComponent?.filterFocused &&
					!this.#displayList?.filterFocused)) &&
			this.#help.handleInput(data)
		)
			return;
		if (matchesKey(data, "ctrl+s") && !this.#textInputActive) {
			this.#context.settings.cycleScope?.();
			this.#refreshItems();
			this.#context.requestRender?.();
			return;
		}
		if (matchesKey(data, "ctrl+g") && !this.#menuKeys.read(data) && this.#callbacks.onOpenConfigFile) {
			if (!this.#externalEditPending) {
				this.#externalEditPending = true;
				void this.#callbacks.onOpenConfigFile().finally(() => {
					this.#externalEditPending = false;
					this.#refreshItems();
					this.#context.requestRender?.();
				});
			}
			return;
		}
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#menuKeys.reset();
			this.#handleMouse(data);
			return;
		}

		if (this.#searchList && this.#search.focused) {
			this.#menuKeys.reset();
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}
		// Text-input submenus take every byte: arrow keys must reach the
		// cursor and Tab must not switch tabs.
		if (this.#textInputActive) {
			this.#menuKeys.reset();
			(this.#searchList ?? this.#currentList)?.handleInput(data);
			return;
		}

		const activeList = this.#searchList ?? this.#currentList;
		if (this.#pluginComponent && (this.#pluginComponent.filterFocused || this.#pluginComponent.hasOpenSubmenu)) {
			this.#menuKeys.reset();
			this.#pluginComponent.handleInput(data);
			return;
		}
		if (activeList?.filterFocused) {
			this.#menuKeys.reset();
			activeList.handleInput(data);
			return;
		}

		// An open submenu owns input entirely — Tab/arrows/typing belong to it.
		if (activeList?.hasOpenSubmenu()) {
			this.#menuKeys.reset();
			activeList.handleInput(data);
			return;
		}
		if (matchesKey(data, "f6") && this.#callbacks.onApply) {
			if (!this.#applyPending) {
				this.#applyPending = true;
				this.#applyFeedback = "Applying…";
				void this.#callbacks.onApply(this.#context.settings.scope ?? "global")
					.then(message => { this.#applyFeedback = message; })
					.catch((error: unknown) => {
						this.#applyFeedback = `Apply failed: ${error instanceof Error ? error.message : String(error)}`;
					})
					.finally(() => {
						this.#applyPending = false;
						this.#refreshReloadedSettings();
					});
				this.#context.requestRender?.();
			}
			return;
		}

		const action = this.#menuKeys.read(data);
		if (action === "pending") return;
		if (action?.kind === "context") {
			if (this.#currentList?.hasSectionFocusTargets()) this.#currentList.toggleSectionFocus();
			else if (action.delta > 0) this.#tabBar.nextTab();
			else this.#tabBar.prevTab();
			return;
		}
		if (action?.kind === "horizontal") {
			if (this.#pluginComponent && !this.#pluginComponent.atRoot) this.#pluginComponent.handleNavigation(action);
			else if (action.delta > 0) this.#tabBar.nextTab();
			else this.#tabBar.prevTab();
			return;
		}
		if (action?.kind === "search" && this.#currentTabId !== "plugins") {
			if (this.#searchList) this.#search.focused = true;
			else this.#startSearch(this.#searchQuery);
			return;
		}
		if (activeList) {
			if (action) activeList.handleNavigation(action);
			else activeList.handleInput(data);
		} else if (this.#pluginComponent) {
			if (action) this.#pluginComponent.handleNavigation(action);
			else this.#pluginComponent.handleInput(data);
		}
	}

	#handleSearchModeInput(data: string, list: SettingsList): void {
		const hadPattern = this.#search.value.length > 0;
		const field = this.#search.handleInput(data);
		if (field !== "pass") {
			this.#menuKeys.reset();
			if (field === "exited" && !this.#search.query) {
				this.#endSearch(false);
				return;
			}
			if (this.#search.query !== this.#searchQuery || hadPattern !== this.#search.value.length > 0)
				this.#setSearchQuery(this.#search.query);
			return;
		}
		const action = this.#menuKeys.read(data);
		if (action === "pending") return;
		if (action?.kind === "context") {
			if (action.delta > 0) this.#tabBar.nextTab();
			else this.#tabBar.prevTab();
			return;
		}
		if (action?.kind === "horizontal") {
			if (action.delta > 0) this.#tabBar.nextTab();
			else this.#tabBar.prevTab();
			return;
		}
		if (action) list.handleNavigation(action);
		else list.handleInput(data);
	}

	/** A credential editor is open: its value is never snapshotted and it holds history until closed. */
	#secretSubmenuOpen(list: SettingsList | null | undefined): boolean {
		const submenuId = list?.openSubmenu?.id;
		if (submenuId === undefined) return false;
		const def = getSettingDef(this.#context.settings.entries, submenuId);
		return def?.type === "text" && def.secret;
	}

	get blocksMenuHistory(): boolean {
		const list = this.#searchList ?? this.#currentList;
		return (
			this.#externalEditPending ||
			list?.blocksMenuHistory === true ||
			this.#pendingPluginWrites > 0 ||
			this.#pluginComponent?.blocksMenuHistory === true ||
			this.#secretSubmenuOpen(list)
		);
	}

	navigationSnapshot(): unknown {
		const list = this.#searchList ?? this.#currentList;
		let listSnapshot = list?.navigationSnapshot();
		if (this.#secretSubmenuOpen(list) && typeof listSnapshot === "object" && listSnapshot !== null) {
			listSnapshot = { ...listSnapshot, submenu: undefined };
		}
		return {
			tab: this.#currentTabId,
			preSearchTab: this.#preSearchTabId,
			preSearchList: this.#preSearchList,
			searching: this.#searchList !== null,
			query: this.#searchQuery,
			search: this.#search.navigationSnapshot(),
			searchFocused: this.#search.focused,
			searchCursor: this.#search.input.getCursor(),
			list: listSnapshot,
			plugin: isMenuHistoryParticipant(this.#pluginComponent)
				? this.#pluginComponent.navigationSnapshot()
				: undefined,
		};
	}

	leaveMenu(): void {
		this.#search.focused = false;
		if (this.#searchList && this.#search.query !== this.#searchQuery) this.#setSearchQuery(this.#search.query);
		(this.#searchList ?? this.#currentList)?.leaveMenu();
		this.#editingSetting = undefined;
		if (isMenuHistoryLeaver(this.#pluginComponent)) this.#pluginComponent.leaveMenu();
	}

	restoreNavigation(snapshot: unknown): void {
		this.#menuKeys.reset();
		if (typeof snapshot !== "object" || snapshot === null) return;
		const state = snapshot as {
			tab?: string;
			preSearchTab?: string;
			preSearchList?: SettingsListNavigationState;
			searching?: boolean;
			query?: string;
			search?: unknown;
			searchFocused?: boolean;
			searchCursor?: number;
			list?: unknown;
			plugin?: unknown;
		};
		if (!this.#tabs.some(tab => tab.id === state.tab)) return;
		this.leaveMenu();
		this.#restoringNavigation = true;
		try {
			const tab = state.tab as SettingTab | "plugins";
			this.#tabs = getSettingsTabs();
			this.#tabBar.setTabs(this.#tabs, tab);
			this.#switchToTab(tab);
			if (state.searching) {
				this.#startSearch(state.query ?? "");
				if (typeof state.preSearchTab === "string")
					this.#preSearchTabId = state.preSearchTab as SettingTab | "plugins";
				if (state.preSearchList !== undefined) this.#preSearchList = state.preSearchList;
				this.#search.focused = state.searchFocused === true;
				if (typeof state.searchCursor === "number") this.#search.input.setCursor(state.searchCursor);
				if (state.search !== undefined) this.#search.restoreNavigation(state.search);
			}
			(this.#searchList ?? this.#currentList)?.restoreNavigation(state.list);
			if (isMenuHistoryParticipant(this.#pluginComponent)) this.#pluginComponent.restoreNavigation(state.plugin);
		} finally {
			this.#restoringNavigation = false;
		}
	}

	#wireNavigation(): void {
		const list = this.#searchList ?? this.#currentList;
		if (list)
			list.onNavigationVisit = (page, previousList) => {
				if (list !== (this.#searchList ?? this.#currentList)) return;
				if (!this.#restoringNavigation)
					this.onNavigationVisit?.(page ? `${this.#currentTabId}:${page}` : "", {
						...(this.navigationSnapshot() as object),
						list: previousList,
					});
			};
		const plugin = this.#pluginComponent;
		if (isMenuHistoryParticipant(plugin))
			plugin.onNavigationVisit = (page, previousPlugin) => {
				if (plugin !== this.#pluginComponent) return;
				if (!this.#restoringNavigation)
					this.onNavigationVisit?.(page ? `plugins:${page}` : "", {
						...(this.navigationSnapshot() as object),
						plugin: previousPlugin,
					});
			};
	}
}
