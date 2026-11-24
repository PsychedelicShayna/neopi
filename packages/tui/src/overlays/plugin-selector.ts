/**
 * Interactive marketplace plugin selector.
 *
 * Shows available plugins from all configured marketplaces in a SelectList.
 * Enter installs or uninstalls the selected plugin. Space never uninstalls. Esc cancels.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";

export interface PluginSelectorCallbacks {
	onSelect: (pluginName: string, marketplace: string, scope?: "user" | "project") => void;
	onCancel: () => void;
}

export interface PluginItem {
	plugin: { name: string; version?: string; description?: string };
	marketplace: string;
	/** Scope of this entry. When set, appended to the label and forwarded to onSelect. */
	scope?: "user" | "project";
}

export class PluginSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(
		mode: "install" | "uninstall",
		marketplaceCount: number,
		plugins: PluginItem[],
		installedIds: Set<string>,
		callbacks: PluginSelectorCallbacks,
	) {
		super(t("settings.selector.plugins"), "omp.overlay.plugins");

		// The sheet draws version, install state and scope as badges instead of bracketed label text.
		const badgesByValue = new Map<string, NonNullable<TspPickerItem["badges"]>>();
		const items: SelectItem[] = plugins.map(({ plugin, marketplace, scope }) => {
			// Encode scope into the value so onSelect can recover it without a parallel Map.
			// Format: "name@marketplace" or "name@marketplace#scope"
			const id = scope ? `${plugin.name}@${marketplace}#${scope}` : `${plugin.name}@${marketplace}`;
			const installed = installedIds.has(`${plugin.name}@${marketplace}`);
			const version = plugin.version ? `@${plugin.version}` : "";
			const status = installed ? t("overlays.plugin_selector.installed_tag") : "";
			const scopeTag = scope ? ` [${scope}]` : "";
			badgesByValue.set(id, [
				...(plugin.version ? [{ text: plugin.version }] : []),
				...(installed ? [{ text: "installed", tone: "success" as const }] : []),
				...(scope ? [{ text: scope, tone: "accent" as const }] : []),
			]);

			return {
				value: id,
				label: `${plugin.name}${version}${status}${scopeTag}`,
				description: plugin.description,
				hint: marketplace,
			};
		});

		if (items.length === 0) {
			items.push({
				value: "__empty__",
				label: t("overlays.plugin_selector.no_plugins"),
				description:
					marketplaceCount === 0
						? t("overlays.plugin_selector.add_marketplace")
						: t("overlays.plugin_selector.marketplaces_empty"),
				disabled: true,
			});
		}

		this.#selectList = new SelectList(items, Math.min(items.length, 20), getSelectListTheme(), {
			search: "always",
			activateOnSpace: mode !== "uninstall",
		});

		this.#selectList.onSelect = item => {
			const [name, marketplace, scope] = splitPluginId(item.value);
			if (name && marketplace) {
				callbacks.onSelect(name, marketplace, scope);
			}
		};

		this.#selectList.onCancel = () => {
			callbacks.onCancel();
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, {
			title: t("settings.selector.plugins"),
			icon: "plus",
			noun: "plugins",
			confirm:
				mode === "uninstall" ? t("overlays.plugin_selector.uninstall") : t("overlays.plugin_selector.install"),
			decorate: item => {
				const [name] = splitPluginId(item.value);
				if (!name) return undefined;
				return {
					label: name,
					badges: badgesByValue.get(item.value) ?? [],
					...(item.hint ? { facts: { marketplace: item.hint } } : {}),
				};
			},
			columns: [{ id: "marketplace", format: "dim" }],
		});
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	/** Picker pointer events drive the list exactly as its keys do. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	navigationSnapshot(): unknown {
		return this.#selectList.navigationState();
	}

	restoreNavigation(snapshot: unknown): void {
		this.#selectList.restoreNavigation(snapshot);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}

function splitPluginId(id: string): [string, string, "user" | "project" | undefined] | [null, null, null] {
	// value format: "name@marketplace" or "name@marketplace#scope"
	const hashIdx = id.indexOf("#");
	const base = hashIdx >= 0 ? id.slice(0, hashIdx) : id;
	const scope = hashIdx >= 0 ? (id.slice(hashIdx + 1) as "user" | "project") : undefined;
	const atIdx = base.lastIndexOf("@");
	if (atIdx <= 0) return [null, null, null];
	return [base.slice(0, atIdx), base.slice(atIdx + 1), scope];
}
