/**
 * Plugin settings UI components.
 *
 * Provides a hierarchical settings interface:
 * - Plugin list (npm plugins + marketplace plugins)
 *   - Plugin details (enablement, manifest settings, and marketplace metadata)
 */
import { getLocale, type Locale, t } from "@oh-my-pi/pi-utils/i18n";
import {
	type Component,
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	type SgrMouseEvent,
	Spacer,
	Text,
} from "../index";
import { logger } from "@oh-my-pi/pi-utils";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { shortenPath } from "../render/render-utils";
import { OverlayPanel } from "../chrome/overlay-box";
import { FormField, SelectFormField, TextFormField } from "../components/form";
import { formTheme } from "../chrome/form-theme";
import { type PrefsEditing, SettingsFormField, type SettingsList } from "../components/settings-list";
import { editorKey } from "../chrome/keybinding-hints";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { col, node, span, text } from "../native/describe";
import type { TspPrefsControl, TspPrefsSection } from "@oh-my-pi/pi-wire";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { MenuKeyReader, isMenuHistoryParticipant, type MenuNavAction } from "../components/menu-navigation";

const PLUGIN_SETTINGS_ROLE = "omp.overlay.plugin-settings";
/** A plugin row's control on the native settings page: open the plugin's settings. */
const PLUGIN_CONFIGURE: TspPrefsControl = {
	k: "action",
	get label() {
		return t("overlays.plugin_settings.configure");
	},
	act: "open",
};

/** The plugins tab as a native settings page draws it (the settings selector puts it in its `prefs` node). */
export interface PluginPrefsPage {
	lead: string;
	sections: TspPrefsSection[];
	focus: string | null;
	editing: PrefsEditing | null;
	query?: string;
	cursor?: number;
	/** An open value editor without a native control, shown over the page. */
	editor?: NativeChild;
}

/**
 * A plugin detail list as native page sections: on/off rows as switches,
 * value rows as an edit button showing the value (the row's editor opens
 * over the page, see {@link prefsDetailEvent}).
 */
function prefsDetailPage(title: string, lead: string, list: SettingsList | undefined): PluginPrefsPage {
	if (!list) return { lead, sections: [], focus: null, editing: null };
	const sections = list.prefsSections(
		() => ({ id: "plugin", title }),
		(item): TspPrefsControl =>
			item.values?.length === 2 && item.values.includes("true") && item.values.includes("false")
				? { k: "switch", on: item.currentValue === "true" }
				: { k: "action", label: item.currentValue.trim() || t("settings.selector.edit"), act: "edit" },
	);
	const open = list.openSubmenu;
	const search = list.hasSearchQuery() || (!open && list.filterFocused) ? list.navigationSnapshot() : undefined;
	return {
		lead,
		sections: sections.map(section => ({
			...section,
			rows: section.rows.map(row => ({ ...row, label: row.label.trim() })),
		})),
		focus: list.prefsFocus().row ?? null,
		editing: null,
		query: search?.filterDraft ?? search?.filter,
		cursor: search?.filterCursor,
		editor: open ? col([open.component], { role: "omp.prefs.editor" }) : undefined,
	};
}

/** A native page event on a plugin detail list, through the keys' code paths. */
function prefsDetailEvent(list: SettingsList | undefined, event: NativeUiEvent): void {
	if (!list) return;
	switch (event.type) {
		case "change":
			if (typeof event.value === "boolean") list.applyValue(event.item, String(event.value));
			return;
		case "select":
			list.selectItem(event.item);
			return;
		case "activate":
			list.openSubmenuFor(event.item);
			return;
		case "action":
			if (event.act === "edit" && event.value) list.openSubmenuFor(event.value);
			else if (event.act === "close" && event.value && list.openSubmenu?.id === event.value)
				list.handleInput("\x1b");
			return;
		case "toggle":
			return;
	}
}

/** Setting metadata consumed by the plugin settings UI. */
export type PluginSettingSchema = {
	description?: string;
	secret?: boolean;
} & (
	| { type: "string"; default?: string }
	| { type: "number"; default?: number; min?: number; max?: number }
	| { type: "boolean"; default?: boolean }
	| { type: "enum"; default?: string; values: string[] }
);

/** Installed runtime plugin fields consumed by the settings UI. */
export interface InstalledPlugin {
	name: string;
	version: string;
	enabled: boolean;
	enabledFeatures: string[] | null;
	manifest: {
		description?: string;
		features?: Record<string, { description?: string; default?: boolean }>;
		settings?: Record<string, PluginSettingSchema>;
	};
}

/** Installed marketplace metadata consumed by the settings UI. */
export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	shadowedBy?: "project";
	entries: {
		installPath: string;
		version: string;
		installedAt: string;
		lastUpdated: string;
		gitCommitSha?: string;
		enabled?: boolean;
	}[];
}

/** Runtime plugin manager capabilities required by the settings UI. */
export interface PluginSettingsManager {
	list(): Promise<InstalledPlugin[]>;
	getPlugin(name: string, options?: { path?: string }): Promise<InstalledPlugin | undefined>;
	getPluginSettings(name: string): Promise<Record<string, unknown>>;
	setEnabled(name: string, enabled: boolean): Promise<void>;
	getEnabledFeatures(name: string): Promise<string[] | null>;
	setEnabledFeatures(name: string, features: string[] | null): Promise<void>;
	setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
}

/** Marketplace manager capabilities required by the settings UI. */
export interface PluginSettingsMarketplaceManager {
	listInstalledPlugins(): Promise<InstalledPluginSummary[]>;
	setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void>;
}

/** Host-owned managers and plugin identifier parsing. */
export interface PluginSettingsHost {
	manager: PluginSettingsManager;
	createMarketplaceManager(): Promise<PluginSettingsMarketplaceManager>;
	parsePluginId(id: string): { name: string } | null;
}

/**
 * Forwards a keystroke to `input`, but cancels via `onCancel` when the user presses Escape.
 *
 * Escape is decoded via `matchesKey` rather than a raw `\x1b` compare: inside the
 * fullscreen settings overlay the kitty keyboard protocol is active (ghostty/kitty),
 * where the Escape key arrives as the CSI-u sequence `\x1b[27u`, not a bare `\x1b`.
 * The literal fallbacks preserve legacy single/double-escape on terminals without it.
 */
export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
		onCancel();
		return;
	}
	input.handleInput(data);
}

// =============================================================================
// Plugin List Component
// =============================================================================

/**
 * One row in the unified plugin list. npm and marketplace plugins live in
 * separate registries with different shapes, so a tagged union keeps both
 * paths type-safe end-to-end (list rendering, value lookup, detail callback).
 */
export type PluginListEntry =
	| { kind: "npm"; plugin: InstalledPlugin }
	| { kind: "marketplace"; plugin: InstalledPluginSummary };

export interface PluginListCallbacks {
	onNpmSelect: (plugin: InstalledPlugin) => void;
	onMarketplaceSelect: (plugin: InstalledPluginSummary) => void;
	onCancel: () => void;
}

/**
 * True when the marketplace summary's first entry is not explicitly disabled.
 * Mirrors the `/plugins list` convention: a missing `enabled` flag means enabled.
 */
function marketplaceEnabled(summary: InstalledPluginSummary): boolean {
	return summary.entries[0]?.enabled !== false;
}

async function buildPluginConfigItems(
	plugin: InstalledPlugin,
	manager: PluginSettingsManager,
	onConfigChange: (key: string, value: unknown) => void | Promise<void>,
	requestRender?: () => void,
): Promise<SettingItem[]> {
	const schemaSettings = plugin.manifest.settings;
	if (!schemaSettings) return [];

	const settings = await manager.getPluginSettings(plugin.name);
	const items: SettingItem[] = [];
	for (const key in schemaSettings) {
		const schema = schemaSettings[key];
		const currentValue = settings[key] ?? schema.default;
		const displayValue = schema.secret && currentValue ? "••••••••" : String(currentValue ?? "(not set)");

		if (schema.type === "boolean") {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || t("overlays.plugin_settings.configure_key", { key: `${key}` }),
				currentValue: currentValue ? "true" : "false",
				values: ["true", "false"],
			});
		} else if (schema.type === "enum") {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || t("overlays.plugin_settings.configure_key", { key: `${key}` }),
				currentValue: String(currentValue ?? schema.default ?? ""),
				submenu: (cv, done) =>
					createConfigEnumPanel(
						key,
						schema.description || t("overlays.plugin_settings.select_value", { key: `${key}` }),
						schema.values,
						cv,
						value => {
							const result = onConfigChange(key, value);
							done(value);
							return result;
						},
						() => done(),
						requestRender,
					),
			});
		} else {
			items.push({
				id: `config:${key}`,
				label: `  ${key}`,
				description: schema.description || t("overlays.plugin_settings.configure_key", { key: `${key}` }),
				currentValue: displayValue,
				submenu: (cv, done) =>
					createConfigInputPanel(
						key,
						schema,
						cv === "(not set)" ? "" : cv,
						value => {
							const parsed = schema.type === "number" ? Number(value) : value;
							const result = onConfigChange(key, parsed);
							done(String(value));
							return result;
						},
						() => done(),
						requestRender,
					),
			});
		}
	}
	return items;
}

/**
 * Stable SelectList value, including scope so user and project installs with
 * the same plugin id retain distinct selection and native rows.
 */
function entryValue(entry: PluginListEntry): string {
	if (entry.kind === "npm") return `npm:${entry.plugin.name}`;
	return `mkt:${entry.plugin.scope}:${entry.plugin.id}`;
}

/**
 * Shows installed plugins from both registries (npm + marketplace) with
 * enable/disable status, scope tag, and shadow indicator. Selecting an entry
 * fans out to the kind-specific detail callback.
 */
export class PluginListComponent extends OverlayPanel {
	readonly #selectList: SelectList;
	#native: { locale: Locale; node: NativeNode } | undefined;
	readonly #keys = new MenuKeyReader();
	readonly #entriesByValue: ReadonlyMap<string, PluginListEntry>;

	constructor(
		private readonly entries: ReadonlyArray<PluginListEntry>,
		callbacks: PluginListCallbacks,
	) {
		super(t("settings.selector.plugins"), PLUGIN_SETTINGS_ROLE);
		this.#entriesByValue = new Map(entries.map(entry => [entryValue(entry), entry]));
		this.addChild(new Spacer(1));

		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", t("overlays.plugin_settings.no_plugins")), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					theme.fg("dim", t("overlays.plugin_settings.install_npm_hint", { APP_NAME: `${APP_NAME}` })),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg("dim", t("overlays.plugin_settings.install_marketplace_hint", { APP_NAME: `${APP_NAME}` })),
					0,
					0,
				),
			);
			this.addChild(new Spacer(1));

			// Empty list still handles Escape so the user can leave the panel.
			this.#selectList = new SelectList([], 1, getSelectListTheme(), { search: "always" });
			this.#selectList.onCancel = callbacks.onCancel;
			this.addChild(this.#selectList);
			return;
		}

		const items: SelectItem[] = entries.map(entry => this.#renderItem(entry));

		// Marketplace plugin ids (`name@marketplace`) routinely run past the
		// SelectList default primary column (32 chars). Widen the bound so the
		// id remains readable; the description gets whatever width is left.
		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme(), {
			search: "always",
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
		});

		this.#selectList.onSelect = item => {
			const found = this.#entriesByValue.get(item.value);
			if (!found) return;
			if (found.kind === "npm") callbacks.onNpmSelect(found.plugin);
			else callbacks.onMarketplaceSelect(found.plugin);
		};

		this.#selectList.onCancel = callbacks.onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					t("overlays.plugin_settings.configure_hint", { editorKey: `${editorKey("tui.select.confirm")}` }),
				),
				0,
				0,
			),
		);
	}

	/** The installed plugins as one native page section: a row per plugin with its status and a Configure button. */
	prefsPage(): PluginPrefsPage {
		const picker = this.#selectList.pickerView();
		const rows = picker.items.map(item => {
			const entry = this.#entriesByValue.get(item.value)!;
			const id = entryValue(entry);
			if (entry.kind === "npm") {
				const p = entry.plugin;
				const features = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
				const parts = [
					p.enabled ? t("overlays.plugin_settings.enabled") : t("settings.option.ask.timeout.0.label"),
					"npm",
					`v${p.version}`,
				];
				if (features > 0)
					parts.push(
						t("overlays.plugin_settings.feature_count", {
							length: `${p.enabledFeatures?.length ?? features}`,
							features: `${features}`,
						}),
					);
				return { id, label: p.name, hint: parts.join(" · "), control: PLUGIN_CONFIGURE };
			}
			const s = entry.plugin;
			const parts = [
				marketplaceEnabled(s) ? t("overlays.plugin_settings.enabled") : t("settings.option.ask.timeout.0.label"),
				"marketplace",
				s.scope,
			];
			parts.push(`v${s.entries[0]?.version ?? "?"}`);
			return {
				id,
				label: s.id,
				hint: parts.join(" · "),
				warning: s.shadowedBy
					? t("overlays.plugin_settings.shadowed_install", { shadowedBy: `${s.shadowedBy}` })
					: undefined,
				control: PLUGIN_CONFIGURE,
			};
		});
		return {
			lead:
				this.entries.length > 0
					? t("overlays.plugin_settings.plugins_description")
					: t("overlays.plugin_settings.no_plugins_hint", { APP_NAME: `${APP_NAME}` }),
			sections: rows.length > 0 ? [{ id: "installed", title: t("settings.selector.installed"), rows }] : [],
			focus: this.#selectList.getSelectedItem()?.value ?? null,
			editing: null,
			query: this.#selectList.filterFocused || picker.query ? picker.query : undefined,
			cursor: picker.cursor,
		};
	}

	/** A native page event: a row click moves the selection, Configure (or a double click) opens the plugin. */
	handlePrefsEvent(event: NativeUiEvent): void {
		this.#keys.reset();
		if (event.type === "select") this.#selectList.setSelectedValue(event.item);
		else if (event.type === "activate") this.#selectList.handleNativeEvent(event);
		else if (event.type === "action" && event.act === "open" && event.value) {
			this.#selectList.handleNativeEvent({ type: "activate", key: event.key, item: event.value });
		}
	}

	/** The plugin list (the select list describes itself) and its hints, or install guidance when empty. */
	override describe(_cx: DescribeContext): NativeNode {
		const locale = getLocale();
		if (this.#native?.locale === locale) return this.#native.node;
		const body =
			this.entries.length === 0
				? [
						text([span(t("overlays.plugin_settings.no_plugins"), "muted")]),
						node("kv", {
							items: [
								{
									k: t("overlays.plugin_settings.install_npm"),
									v: [span(`${APP_NAME} plugin install <package>`, "code")],
								},
								{
									k: t("overlays.plugin_settings.install_marketplace"),
									v: [span(`${APP_NAME} plugin install <name>@<marketplace>`, "code")],
								},
							],
						}),
						this.#selectList,
						hintsRow([actionHint("tui.select.cancel", t("overlays.plugin_settings.go_back"))]),
					]
				: [
						this.#selectList,
						hintsRow([
							actionHint("tui.select.confirm", t("overlays.native_hint.configure")),
							actionHint("tui.select.cancel", t("overlays.plugin_settings.go_back")),
						]),
					];
		const result = overlayCard(PLUGIN_SETTINGS_ROLE, this.title, body);
		this.#native = { locale, node: result };
		return result;
	}

	#renderItem(entry: PluginListEntry): SelectItem {
		const kindBadge = theme.fg("dim", entry.kind === "npm" ? "[npm]" : "[marketplace]");

		if (entry.kind === "npm") {
			const p = entry.plugin;
			const status = p.enabled
				? theme.fg("success", theme.status.enabled)
				: theme.fg("muted", theme.status.disabled);
			const featureCount = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
			const enabledCount = p.enabledFeatures?.length ?? featureCount;

			let details = `${kindBadge} ${theme.sep.dot} v${p.version}`;
			if (featureCount > 0) {
				details += t("overlays.plugin_settings.feature_details", {
					dot: `${theme.sep.dot}`,
					enabledCount: `${enabledCount}`,
					featureCount: `${featureCount}`,
				});
			}

			return {
				value: entryValue(entry),
				label: `${status} ${p.name}`,
				description: details,
			};
		}

		const summary = entry.plugin;
		const enabled = marketplaceEnabled(summary);
		const status = enabled ? theme.fg("success", theme.status.enabled) : theme.fg("muted", theme.status.disabled);
		const scopeTag = theme.fg("dim", `[${summary.scope}]`);
		const shadowMarker = summary.shadowedBy ? ` ${theme.fg("warning", theme.status.shadowed)}` : "";
		const version = summary.entries[0]?.version ?? "?";

		let details = `${kindBadge} ${scopeTag} ${theme.sep.dot} v${version}`;
		if (summary.shadowedBy) {
			details += t("overlays.plugin_settings.shadowed_details", {
				dot: `${theme.sep.dot}`,
				shadowedBy: `${summary.shadowedBy}`,
			});
		}

		return {
			value: entryValue(entry),
			label: `${status} ${summary.id}${shadowMarker}`,
			description: details,
		};
	}

	handleInput(data: string): void {
		if (this.#selectList.filterFocused) {
			this.#keys.reset();
			this.#selectList.handleInput(data);
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action) this.handleNavigation(action);
		else this.#selectList.handleInput(data);
	}

	handleNavigation(action: MenuNavAction): void {
		this.#keys.reset();
		if (action.kind === "horizontal") {
			const item = this.#selectList.getSelectedItem();
			if (action.delta > 0 && item) this.#selectList.onSelect?.(item);
			return;
		}
		this.#selectList.handleNavigation(action);
	}

	get filterFocused(): boolean {
		return this.#selectList.filterFocused;
	}
	navigationSnapshot(): unknown {
		return this.#selectList.navigationSnapshot();
	}
	restoreNavigation(snapshot: unknown): void {
		this.#keys.reset();
		this.#selectList.restoreNavigation(snapshot);
	}
}

// =============================================================================
// Plugin Detail Component
// =============================================================================

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void | Promise<void>;
	/** Schedules a frame after an asynchronous config submission settles. */
	requestRender?: () => void;
	onBack: () => void;
}

/**
 * Shows detail settings for a single plugin:
 * - Enable/disable toggle
 * - Feature toggles
 * - Config settings
 */
export class PluginDetailComponent extends OverlayPanel {
	#settingsList!: SettingsFormField;
	#pendingNavigation: unknown;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;

	constructor(
		private plugin: InstalledPlugin,
		private readonly manager: PluginSettingsManager,
		private readonly callbacks: PluginDetailCallbacks,
	) {
		super(plugin.name, PLUGIN_SETTINGS_ROLE);

		void this.#rebuild();
	}

	async #rebuild(): Promise<void> {
		this.clear();

		const plugin = this.plugin;
		const manifest = plugin.manifest;

		this.title = plugin.name;

		const items: SettingItem[] = [];

		// Enable/disable toggle
		items.push({
			id: "__enabled__",
			label: t("overlays.plugin_settings.enabled"),
			description: t("overlays.plugin_settings.enable_plugin"),
			currentValue: plugin.enabled ? "true" : "false",
			values: ["true", "false"],
		});

		// Feature toggles
		if (manifest.features && Object.keys(manifest.features).length > 0) {
			const enabledSet = new Set(plugin.enabledFeatures ?? []);
			const defaultFeatures = Object.entries(manifest.features)
				.filter(([_featureName, f]) => f.default)
				.map(([name]) => name);

			// If enabledFeatures is null, use defaults
			const effectiveEnabled = plugin.enabledFeatures === null ? new Set(defaultFeatures) : enabledSet;

			for (const [featName, feat] of Object.entries(manifest.features)) {
				const isEnabled = effectiveEnabled.has(featName);
				items.push({
					id: `feature:${featName}`,
					label: `  ${featName}`,
					description:
						feat.description || t("overlays.plugin_settings.enable_feature", { featName: `${featName}` }),
					currentValue: isEnabled ? "true" : "false",
					values: ["true", "false"],
				});
			}
		}

		items.push(
			...(await buildPluginConfigItems(
				plugin,
				this.manager,
				this.callbacks.onConfigChange,
				this.callbacks.requestRender,
			)),
		);

		this.#settingsList = new SettingsFormField({
			fieldTheme: formTheme,
			description: manifest.description || undefined,
			items,
			maxVisible: Math.min(items.length, 10),
			settingsTheme: getSettingsListTheme(),
			hint: t("overlays.plugin_settings.edit_hint", {
				editorKey: `${editorKey("tui.select.confirm")}`,
				editorKey2: `${editorKey("tui.select.cancel")}`,
			}),
			onChange: (id, newValue) => {
				if (id === "__enabled__") {
					this.callbacks.onEnabledChange(newValue === "true");
					this.plugin = { ...this.plugin, enabled: newValue === "true" };
				} else if (id.startsWith("feature:")) {
					const featName = id.slice(8);
					this.callbacks.onFeatureChange(featName, newValue === "true");
					// Update local state
					const current = new Set(this.plugin.enabledFeatures ?? []);
					if (newValue === "true") {
						current.add(featName);
					} else {
						current.delete(featName);
					}
					this.plugin = { ...this.plugin, enabledFeatures: [...current] };
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					const schema = this.plugin.manifest.settings?.[key];
					if (schema?.type === "boolean") {
						this.callbacks.onConfigChange(key, newValue === "true");
					}
				}
			},
			onCancel: this.callbacks.onBack,
		});
		this.#settingsList.settingsList.onNavigationVisit = (page, previousSnapshot) =>
			this.onNavigationVisit?.(page, previousSnapshot);
		if (this.#pendingNavigation !== undefined) {
			this.#settingsList.restoreNavigation(this.#pendingNavigation);
			this.#pendingNavigation = undefined;
		}

		this.addChild(this.#settingsList);
		this.callbacks.requestRender?.();
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}

	handleNavigation(action: MenuNavAction): void {
		this.#settingsList?.settingsList.handleNavigation(action);
	}
	get hasOpenSubmenu(): boolean {
		return this.#settingsList?.settingsList.hasOpenSubmenu() ?? false;
	}

	get filterFocused(): boolean {
		return this.#settingsList?.filterFocused ?? false;
	}
	get blocksMenuHistory(): boolean {
		return this.#settingsList?.blocksMenuHistory ?? false;
	}
	navigationSnapshot(): unknown {
		return this.#settingsList?.navigationSnapshot() ?? this.#pendingNavigation;
	}
	restoreNavigation(snapshot: unknown): void {
		if (this.#settingsList) this.#settingsList.restoreNavigation(snapshot);
		else this.#pendingNavigation = snapshot;
	}
	navigateParent(): boolean {
		return this.#settingsList?.settingsList.navigateParent() ?? false;
	}
	navigateChild(): void {
		const list = this.#settingsList?.settingsList;
		const item = list?.getSelectedItem();
		if (item?.submenu) list?.openSubmenuFor(item.id);
	}

	/** This plugin's settings as a native page section. */
	prefsPage(): PluginPrefsPage {
		return prefsDetailPage(
			this.plugin.name,
			this.plugin.manifest.description || t("overlays.plugin_settings.plugin_settings_description"),
			this.#settingsList?.settingsList,
		);
	}

	/** A native page event on this plugin's settings. */
	handlePrefsEvent(event: NativeUiEvent): void {
		prefsDetailEvent(this.#settingsList?.settingsList, event);
	}
}

// =============================================================================
// Marketplace Plugin Detail Component
// =============================================================================

export interface MarketplacePluginDetailCallbacks {
	parsePluginId: PluginSettingsHost["parsePluginId"];
	onEnabledChange: (enabled: boolean) => void;
	onConfigChange: (pluginName: string, key: string, value: unknown) => void;
	/** Schedules a TUI frame after asynchronous manifest settings load. */
	requestRender?: () => void;
	onBack: () => void;
}

/**
 * Detail view for a marketplace plugin, including settings declared by its
 * runtime package and metadata from the installed-plugins registry.
 */
export class MarketplacePluginDetailComponent extends OverlayPanel {
	#settingsList!: SettingsFormField;
	#pendingNavigation: unknown;
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;
	#configLoaded = false;

	constructor(
		private plugin: InstalledPluginSummary,
		private readonly manager: PluginSettingsManager,
		private readonly callbacks: MarketplacePluginDetailCallbacks,
	) {
		super(plugin.id, PLUGIN_SETTINGS_ROLE);
		this.#render(undefined, []);
		void this.#loadConfig();
	}

	async #loadConfig(): Promise<void> {
		const entry = this.plugin.entries[0];
		if (!entry) return;

		const fallbackName = this.callbacks.parsePluginId(this.plugin.id)?.name ?? this.plugin.id;
		try {
			const runtimePlugin = await this.manager.getPlugin(fallbackName, { path: entry.installPath });
			if (!runtimePlugin) return;
			const configItems = await buildPluginConfigItems(
				runtimePlugin,
				this.manager,
				(key, value) => this.callbacks.onConfigChange(runtimePlugin.name, key, value),
				this.callbacks.requestRender,
			);
			this.#render(runtimePlugin, configItems);
			this.callbacks.requestRender?.();
		} catch (err) {
			logger.error("Settings → Plugins: failed to load marketplace plugin settings", {
				pluginId: this.plugin.id,
				path: entry.installPath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#render(runtimePlugin: InstalledPlugin | undefined, configItems: SettingItem[]): void {
		const previousNavigation = this.#pendingNavigation ?? this.#settingsList?.navigationSnapshot();
		this.#configLoaded = runtimePlugin !== undefined;
		this.clear();

		const plugin = this.plugin;
		const entry = plugin.entries[0];
		this.title = plugin.id;
		const subtitleParts = [`[${plugin.scope}]`];
		if (plugin.shadowedBy)
			subtitleParts.push(
				t("overlays.plugin_settings.shadowed_by", {
					shadowed: `${theme.status.shadowed}`,
					shadowedBy: `${plugin.shadowedBy}`,
				}),
			);

		const items: SettingItem[] = [
			{
				id: "__enabled__",
				label: t("overlays.plugin_settings.enabled"),
				description: t("overlays.plugin_settings.enable_marketplace_plugin"),
				currentValue: marketplaceEnabled(plugin) ? "true" : "false",
				values: ["true", "false"],
			},
			...configItems,
		];
		const summary: Component[] = [
			new Text(
				theme.fg("dim", t("overlays.plugin_settings.version", { version: `${entry?.version ?? "(unknown)"}` })),
				0,
				0,
			),
			new Text(theme.fg("dim", t("overlays.plugin_settings.scope", { scope: `${plugin.scope}` })), 0, 0),
			new Text(
				theme.fg(
					"dim",
					t("overlays.plugin_settings.install_path", {
						installPath: `${entry?.installPath ? shortenPath(entry.installPath) : "(unknown)"}`,
					}),
				),
				0,
				0,
			),
			new Text(
				theme.fg(
					"dim",
					t("overlays.plugin_settings.installed_at", { installedAt: `${entry?.installedAt ?? "(unknown)"}` }),
				),
				0,
				0,
			),
			new Text(
				theme.fg(
					"dim",
					t("overlays.plugin_settings.last_updated", { lastUpdated: `${entry?.lastUpdated ?? "(unknown)"}` }),
				),
				0,
				0,
			),
		];
		if (entry?.gitCommitSha) {
			summary.push(
				new Text(
					theme.fg("dim", t("overlays.plugin_settings.git_sha", { gitCommitSha: `${entry.gitCommitSha}` })),
					0,
					0,
				),
			);
		}
		summary.push(new Spacer(1));
		this.#settingsList = new SettingsFormField({
			fieldTheme: formTheme,
			description: subtitleParts.join(" ") || undefined,
			items,
			maxVisible: Math.min(items.length, 10),
			settingsTheme: getSettingsListTheme(),
			summary,
			hint: t("overlays.plugin_settings.edit_hint", {
				editorKey: `${editorKey("tui.select.confirm")}`,
				editorKey2: `${editorKey("tui.select.cancel")}`,
			}),
			onChange: (id, newValue) => {
				if (id === "__enabled__") {
					const next = newValue === "true";
					this.callbacks.onEnabledChange(next);
					this.plugin = {
						...this.plugin,
						entries: this.plugin.entries.map(e => ({ ...e, enabled: next })),
					};
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					if (runtimePlugin?.manifest.settings?.[key]?.type === "boolean") {
						this.callbacks.onConfigChange(runtimePlugin.name, key, newValue === "true");
					}
				}
			},
			onCancel: this.callbacks.onBack,
		});
		this.#settingsList.settingsList.onNavigationVisit = (page, previousSnapshot) =>
			this.onNavigationVisit?.(page, previousSnapshot);
		if (previousNavigation !== undefined) {
			this.#settingsList.restoreNavigation(previousNavigation);
			this.#pendingNavigation = this.#configLoaded ? undefined : previousNavigation;
		}

		this.addChild(this.#settingsList);
	}

	handleInput(data: string): void {
		this.#settingsList.handleInput(data);
	}

	handleNavigation(action: MenuNavAction): void {
		this.#settingsList?.settingsList.handleNavigation(action);
	}
	get hasOpenSubmenu(): boolean {
		return this.#settingsList?.settingsList.hasOpenSubmenu() ?? false;
	}

	get filterFocused(): boolean {
		return this.#settingsList?.filterFocused ?? false;
	}
	get blocksMenuHistory(): boolean {
		return this.#settingsList?.blocksMenuHistory ?? false;
	}
	navigationSnapshot(): unknown {
		return this.#pendingNavigation ?? this.#settingsList?.navigationSnapshot();
	}
	restoreNavigation(snapshot: unknown): void {
		this.#settingsList?.restoreNavigation(snapshot);
		this.#pendingNavigation = this.#configLoaded ? undefined : snapshot;
	}
	navigateParent(): boolean {
		return this.#settingsList?.settingsList.navigateParent() ?? false;
	}
	navigateChild(): void {
		const list = this.#settingsList?.settingsList;
		const item = list?.getSelectedItem();
		if (item?.submenu) list?.openSubmenuFor(item.id);
	}

	/** This plugin's settings as a native page section, with its install facts as the lead. */
	prefsPage(): PluginPrefsPage {
		const entry = this.plugin.entries[0];
		const facts = [
			t("overlays.plugin_settings.install_scope", { scope: `${this.plugin.scope}` }),
			`v${entry?.version ?? "?"}`,
		];
		if (entry?.installPath) facts.push(shortenPath(entry.installPath));
		if (this.plugin.shadowedBy)
			facts.push(t("overlays.plugin_settings.shadowed_install_2", { shadowedBy: `${this.plugin.shadowedBy}` }));
		return prefsDetailPage(this.plugin.id, facts.join(" · "), this.#settingsList?.settingsList);
	}

	/** A native page event on this plugin's settings. */
	handlePrefsEvent(event: NativeUiEvent): void {
		prefsDetailEvent(this.#settingsList?.settingsList, event);
	}
}

// =============================================================================
// Config Submenus
// =============================================================================

/**
 * Thin OverlayPanel boundary around a shared form field. The panel title stays
 * the setting key; input, paste, focus, and mouse all forward to the field.
 */
class ConfigFieldPanel extends OverlayPanel {
	#field: FormField;
	readonly #keys = new MenuKeyReader();

	constructor(key: string, field: FormField) {
		super(key, `${PLUGIN_SETTINGS_ROLE}.field`);
		this.#field = field;
		this.addChild(field);
	}

	get focused(): boolean {
		return this.#field.focused;
	}

	set focused(value: boolean) {
		this.#field.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#field.setUseTerminalCursor(useTerminalCursor);
	}

	handleInput(data: string): void {
		if (!(this.#field instanceof SelectFormField) || this.#field.filterFocused) {
			this.#keys.reset();
			this.#field.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#keys.reset();
			this.#field.selectList.onCancel?.();
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action?.kind === "horizontal") {
			if (action.delta < 0) this.#field.selectList.onCancel?.();
			return;
		}
		if (action) this.#field.selectList.handleNavigation(action);
		else this.#field.handleInput(data);
	}

	get filterFocused(): boolean {
		return this.#field.filterFocused;
	}
	get blocksMenuHistory(): boolean {
		return this.#field.blocksMenuHistory;
	}
	navigationSnapshot(): unknown {
		return this.#field.navigationSnapshot();
	}
	restoreNavigation(snapshot: unknown): void {
		this.#keys.reset();
		this.#field.restoreNavigation(snapshot);
	}

	pasteText(text: string): void {
		this.#field.pasteText(text);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#keys.reset();
		// OverlayPanel contributes one top-border row and a two-column body inset.
		this.#field.routeMouse(event, line - 1, col - 2);
	}
}

/** Enum setting submenu backed by a shared select field. */
function createConfigEnumPanel(
	key: string,
	description: string,
	values: string[],
	currentValue: string,
	onSelect: (value: string) => void | Promise<void>,
	onCancel: () => void,
	requestRender?: () => void,
): Component {
	const field = new SelectFormField({
		theme: formTheme,
		description: description || undefined,
		leadingSpace: true,
		items: values.map(v => ({ value: v, label: v })),
		currentValue,
		maxVisible: 8,
		selectTheme: getSelectListTheme(),
		hint: t("overlays.plugin_settings.select_hint", {
			editorKey: `${editorKey("tui.select.confirm")}`,
			editorKey2: `${editorKey("tui.select.cancel")}`,
		}),
		onSubmit: onSelect,
		onCancel,
		requestRender,
	});
	return new ConfigFieldPanel(key, field);
}

/** String/number setting submenu backed by a shared text field. */
function createConfigInputPanel(
	key: string,
	schema: PluginSettingSchema,
	currentValue: string,
	onSubmit: (value: string) => void | Promise<void>,
	onCancel: () => void,
	requestRender?: () => void,
): Component {
	let typeHint = t("overlays.plugin_settings.type", { type: `${schema.type}` });
	if (schema.type === "number" && (schema.min !== undefined || schema.max !== undefined)) {
		typeHint += ` (${schema.min ?? ""}..${schema.max ?? ""})`;
	}
	const field = new TextFormField({
		theme: formTheme,
		description: schema.description || undefined,
		details: [...(schema.description ? [new Spacer(1)] : []), new Text(theme.fg("dim", typeHint), 0, 0)],
		leadingSpace: true,
		secret: schema.secret,
		initialValue: !schema.secret ? currentValue : undefined,
		empty: "cancel",
		hint: t("overlays.plugin_settings.save_hint", {
			editorKey: `${editorKey("tui.input.submit")}`,
			editorKey2: `${editorKey("tui.select.cancel")}`,
		}),
		onSubmit,
		onCancel,
		requestRender,
	});
	return new ConfigFieldPanel(key, field);
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void | Promise<void>;
	/** Keeps the owning settings overlay blocked even when its tab changes. */
	onPendingWrite?: (delta: 1 | -1) => void;
	/** Schedules a TUI frame after asynchronous plugin data loads. */
	requestRender?: () => void;
}

/**
 * Top-level plugin settings component.
 * Manages navigation between plugin list and plugin detail views.
 */
export class PluginSettingsComponent extends Container {
	readonly #host: PluginSettingsHost;
	#manager: PluginSettingsManager;
	#viewComponent: PluginListComponent | PluginDetailComponent | MarketplacePluginDetailComponent | null = null;
	#currentView: "list" | "npm-detail" | "marketplace-detail" = "list";
	#currentPlugin: InstalledPlugin | null = null;
	#currentMarketplacePlugin: InstalledPluginSummary | null = null;
	#entries: readonly PluginListEntry[] = [];
	#pendingNavigation: unknown;
	#listNavigation: unknown;
	#restoringNavigation = false;
	#pendingOperations = 0;
	readonly #keys = new MenuKeyReader();
	onNavigationVisit?: (page: string, previousSnapshot: unknown) => void;

	constructor(
		host: PluginSettingsHost,
		private readonly callbacks: PluginSettingsCallbacks,
	) {
		super();
		this.#host = host;
		this.#manager = host.manager;
		this.#showPluginList();
	}

	async #showPluginList(): Promise<void> {
		this.#keys.reset();
		const changedPage = this.#currentView !== "list";
		const previous = this.navigationSnapshot();
		this.#currentView = "list";
		this.#currentPlugin = null;
		this.#currentMarketplacePlugin = null;
		this.clear();
		this.#viewComponent = null;

		// Surface registry failures without taking the whole tab down — either
		// registry can fail to load (corrupt JSON, missing project root) and the
		// user still benefits from the other half. An uncaught rejection here
		// would also leave the tab permanently blank: this method is invoked
		// fire-and-forget from the constructor, so nothing awaits it.
		const [npmPlugins, marketplacePlugins] = await Promise.all([
			this.#manager.list().catch((err): InstalledPlugin[] => {
				logger.error("Settings → Plugins: failed to list npm plugins", {
					error: err instanceof Error ? err.message : String(err),
				});
				return [];
			}),
			this.#host
				.createMarketplaceManager()
				.then(mgr => mgr.listInstalledPlugins())
				.catch((err): InstalledPluginSummary[] => {
					logger.error("Settings → Plugins: failed to list marketplace plugins", {
						error: err instanceof Error ? err.message : String(err),
					});
					return [];
				}),
		]);

		const entries: PluginListEntry[] = [
			...npmPlugins.map((plugin): PluginListEntry => ({ kind: "npm", plugin })),
			...marketplacePlugins.map((plugin): PluginListEntry => ({ kind: "marketplace", plugin })),
		];
		this.#entries = entries;

		this.#viewComponent = new PluginListComponent(entries, {
			onNpmSelect: plugin => this.#showPluginDetail(plugin),
			onMarketplaceSelect: plugin => this.#showMarketplaceDetail(plugin),
			onCancel: () => this.callbacks.onClose(),
		});
		if (isMenuHistoryParticipant(this.#viewComponent)) this.#viewComponent.restoreNavigation(this.#listNavigation);

		this.addChild(this.#viewComponent);
		if (this.#pendingNavigation !== undefined) {
			const pending = this.#pendingNavigation;
			this.#pendingNavigation = undefined;
			this.restoreNavigation(pending);
		} else if (changedPage && !this.#restoringNavigation) this.onNavigationVisit?.("", previous);

		// The list mounts after the first frame (npm + marketplace listing is
		// async and this method runs fire-and-forget), so ask for a repaint —
		// otherwise the tab stays blank until an unrelated event forces a
		// render, e.g. reopening /settings (issue #9526).
		this.callbacks.requestRender?.();
	}

	/** The current view (list or a plugin's settings) as a native settings page. */
	prefsPage(): PluginPrefsPage {
		const view = this.#viewComponent;
		if (
			view instanceof PluginListComponent ||
			view instanceof PluginDetailComponent ||
			view instanceof MarketplacePluginDetailComponent
		) {
			return view.prefsPage();
		}
		return { lead: t("overlays.plugin_settings.loading_plugins"), sections: [], focus: null, editing: null };
	}

	/** Routes a native page event to the current view. */
	handlePrefsEvent(event: NativeUiEvent): void {
		this.#keys.reset();
		const view = this.#viewComponent;
		if (
			view instanceof PluginListComponent ||
			view instanceof PluginDetailComponent ||
			view instanceof MarketplacePluginDetailComponent
		) {
			view.handlePrefsEvent(event);
		}
	}

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.#keys.reset();
		const previous = this.navigationSnapshot();
		if (!this.#restoringNavigation && this.#currentView === "list" && isMenuHistoryParticipant(this.#viewComponent)) {
			this.#listNavigation = this.#viewComponent.navigationSnapshot();
		}
		this.#currentView = "npm-detail";
		this.#currentPlugin = plugin;
		this.#currentMarketplacePlugin = null;
		this.clear();

		this.#viewComponent = new PluginDetailComponent(plugin, this.#manager, {
			onEnabledChange: async enabled => {
				this.#pendingOperations++;
				this.callbacks.onPendingWrite?.(1);
				try {
					await this.#manager.setEnabled(plugin.name, enabled);
					await this.callbacks.onPluginChanged();
				} finally {
					this.#pendingOperations--;
					this.callbacks.onPendingWrite?.(-1);
					this.callbacks.requestRender?.();
				}
			},
			onFeatureChange: async (feature, enabled) => {
				this.#pendingOperations++;
				this.callbacks.onPendingWrite?.(1);
				try {
					const current = new Set((await this.#manager.getEnabledFeatures(plugin.name)) ?? []);
					if (enabled) current.add(feature);
					else current.delete(feature);
					await this.#manager.setEnabledFeatures(plugin.name, [...current]);
					await this.callbacks.onPluginChanged();
				} finally {
					this.#pendingOperations--;
					this.callbacks.onPendingWrite?.(-1);
					this.callbacks.requestRender?.();
				}
			},
			onConfigChange: async (key, value) => {
				this.#pendingOperations++;
				this.callbacks.onPendingWrite?.(1);
				try {
					await this.#manager.setPluginSetting(plugin.name, key, value);
					await this.callbacks.onPluginChanged();
				} finally {
					this.#pendingOperations--;
					this.callbacks.onPendingWrite?.(-1);
					this.callbacks.requestRender?.();
				}
			},
			onBack: () => this.#showPluginList(),
			requestRender: this.callbacks.requestRender,
		});

		this.addChild(this.#viewComponent);
		this.#wireNavigation();
		if (!this.#restoringNavigation) this.onNavigationVisit?.(`npm:${plugin.name}`, previous);
	}

	#showMarketplaceDetail(plugin: InstalledPluginSummary): void {
		this.#keys.reset();
		const previous = this.navigationSnapshot();
		if (!this.#restoringNavigation && this.#currentView === "list" && isMenuHistoryParticipant(this.#viewComponent)) {
			this.#listNavigation = this.#viewComponent.navigationSnapshot();
		}
		this.#currentView = "marketplace-detail";
		this.#currentPlugin = null;
		this.#currentMarketplacePlugin = plugin;
		this.clear();

		this.#viewComponent = new MarketplacePluginDetailComponent(plugin, this.#manager, {
			parsePluginId: id => this.#host.parsePluginId(id),
			onEnabledChange: async enabled => {
				this.#pendingOperations++;
				this.callbacks.onPendingWrite?.(1);
				try {
					const mgr = await this.#host.createMarketplaceManager();
					await mgr.setPluginEnabled(plugin.id, enabled, plugin.scope);
					await this.callbacks.onPluginChanged();
				} catch (err) {
					logger.error("Settings → Plugins: failed to toggle marketplace plugin", {
						pluginId: plugin.id,
						scope: plugin.scope,
						enabled,
						error: err instanceof Error ? err.message : String(err),
					});
				} finally {
					this.#pendingOperations--;
					this.callbacks.onPendingWrite?.(-1);
					this.callbacks.requestRender?.();
				}
			},
			onConfigChange: async (pluginName, key, value) => {
				this.#pendingOperations++;
				this.callbacks.onPendingWrite?.(1);
				try {
					await this.#manager.setPluginSetting(pluginName, key, value);
					await this.callbacks.onPluginChanged();
				} finally {
					this.#pendingOperations--;
					this.callbacks.onPendingWrite?.(-1);
					this.callbacks.requestRender?.();
				}
			},
			onBack: () => this.#showPluginList(),
			requestRender: this.callbacks.requestRender,
		});

		this.addChild(this.#viewComponent);
		this.#wireNavigation();
		if (!this.#restoringNavigation) this.onNavigationVisit?.(`marketplace:${plugin.id}:${plugin.scope}`, previous);
	}

	handleInput(data: string): void {
		const view = this.#viewComponent;
		if (this.filterFocused || this.hasOpenSubmenu) {
			this.#keys.reset();
			view?.handleInput(data);
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action) this.handleNavigation(action);
		else if (view) view.handleInput(data);
		else if (data === "\x1b" || data === "\x1b\x1b") this.callbacks.onClose();
	}

	handleNavigation(action: MenuNavAction): void {
		this.#keys.reset();
		const view = this.#viewComponent;
		if (action.kind === "cancel" && this.prefsPage().query) {
			view?.handleNavigation(action);
			return;
		}
		if (action.kind === "cancel" || (action.kind === "horizontal" && action.delta < 0)) {
			if (this.atRoot) {
				if (action.kind === "cancel") this.callbacks.onClose();
			} else if (
				!(
					(view instanceof PluginDetailComponent || view instanceof MarketplacePluginDetailComponent) &&
					view.navigateParent()
				)
			) {
				void this.#showPluginList();
			}
			return;
		}
		if (
			action.kind === "horizontal" &&
			action.delta > 0 &&
			(view instanceof PluginDetailComponent || view instanceof MarketplacePluginDetailComponent)
		) {
			view.navigateChild();
			return;
		}
		view?.handleNavigation(action);
	}

	get atRoot(): boolean {
		return this.#currentView === "list";
	}
	get hasOpenSubmenu(): boolean {
		const view = this.#viewComponent;
		return (
			(view instanceof PluginDetailComponent || view instanceof MarketplacePluginDetailComponent) &&
			view.hasOpenSubmenu
		);
	}

	get filterFocused(): boolean {
		const view = this.#viewComponent;
		return view instanceof PluginListComponent ||
			view instanceof PluginDetailComponent ||
			view instanceof MarketplacePluginDetailComponent
			? view.filterFocused
			: false;
	}

	get blocksMenuHistory(): boolean {
		return (
			this.#pendingOperations > 0 ||
			(isMenuHistoryParticipant(this.#viewComponent) && this.#viewComponent.blocksMenuHistory === true)
		);
	}

	navigationSnapshot(): unknown {
		return {
			view: this.#currentView,
			plugin: this.#currentPlugin?.name,
			marketplace: this.#currentMarketplacePlugin
				? { id: this.#currentMarketplacePlugin.id, scope: this.#currentMarketplacePlugin.scope }
				: undefined,
			list: this.#listNavigation,
			content: isMenuHistoryParticipant(this.#viewComponent) ? this.#viewComponent.navigationSnapshot() : undefined,
		};
	}

	restoreNavigation(snapshot: unknown): void {
		this.#keys.reset();
		if (typeof snapshot !== "object" || snapshot === null) return;
		if (!this.#viewComponent) {
			this.#pendingNavigation = snapshot;
			return;
		}
		const state = snapshot as {
			view?: string;
			plugin?: string;
			marketplace?: { id: string; scope: string };
			content?: unknown;
			list?: unknown;
		};
		this.#listNavigation = state.list;
		this.#restoringNavigation = true;
		try {
			if (state.view === "npm-detail") {
				const entry = this.#entries.find(entry => entry.kind === "npm" && entry.plugin.name === state.plugin);
				if (entry?.kind === "npm") this.#showPluginDetail(entry.plugin);
			} else if (state.view === "marketplace-detail") {
				const entry = this.#entries.find(
					entry =>
						entry.kind === "marketplace" &&
						entry.plugin.id === state.marketplace?.id &&
						entry.plugin.scope === state.marketplace.scope,
				);
				if (entry?.kind === "marketplace") this.#showMarketplaceDetail(entry.plugin);
			} else if (this.#currentView !== "list") {
				this.#pendingNavigation = snapshot;
				void this.#showPluginList();
				return;
			}
			if (isMenuHistoryParticipant(this.#viewComponent)) this.#viewComponent.restoreNavigation(state.content);
		} finally {
			this.#restoringNavigation = false;
		}
	}

	#wireNavigation(): void {
		const view = this.#viewComponent;
		if (!isMenuHistoryParticipant(view)) return;
		view.onNavigationVisit = (page, previousContent) => {
			if (view !== this.#viewComponent) return;
			const previous = { ...(this.navigationSnapshot() as object), content: previousContent };
			if (!this.#restoringNavigation) this.onNavigationVisit?.(`${this.#currentView}:${page}`, previous);
		};
	}
}
