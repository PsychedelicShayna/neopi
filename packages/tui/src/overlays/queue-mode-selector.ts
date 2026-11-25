import { t } from "@oh-my-pi/pi-utils/i18n";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

/**
 * Component that renders a queue mode selector with borders
 */
export class QueueModeSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(
		currentMode: "all" | "one-at-a-time",
		onSelect: (mode: "all" | "one-at-a-time") => void,
		onCancel: () => void,
	) {
		super(t("overlays.queue_mode_selector.queue_mode"), "omp.overlay.queue-mode");

		const queueModes: SelectItem[] = [
			{
				value: "one-at-a-time",
				label: "one-at-a-time",
				description: t("overlays.queue_mode_selector.one_description"),
			},
			{
				value: "all",
				label: t("overlays.queue_mode_selector.all_label"),
				description: t("overlays.queue_mode_selector.all_description"),
			},
		];

		// Create selector
		this.#selectList = new SelectList(queueModes, 2, getSelectListTheme(), { search: "always" });

		// Preselect current mode
		const currentIndex = queueModes.findIndex(item => item.value === currentMode);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as "all" | "one-at-a-time");
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, {
			title: t("overlays.queue_mode_selector.queue_mode_2"),
			subtitle: t("overlays.queue_mode_selector.queue_subtitle"),
			icon: "list",
			noun: "modes",
			current: [currentMode],
			// The terminal list shows the setting's values; the sheet names them for people.
			decorate: item =>
				item.value === "one-at-a-time"
					? {
							label: t("overlays.queue_mode_selector.one_at_a_time"),
							detail: t("overlays.queue_mode_selector.one_detail"),
							badges: [{ text: "recommended" }],
						}
					: {
							label: t("overlays.queue_mode_selector.all_at_once"),
							detail: t("overlays.queue_mode_selector.all_detail"),
						},
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
