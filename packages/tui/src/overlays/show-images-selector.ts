import { t } from "@oh-my-pi/pi-utils/i18n";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

/**
 * Component that renders a show images selector with borders
 */
export class ShowImagesSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super(t("overlays.show_images_selector.show_images_title"), "omp.overlay.show-images");

		const items: SelectItem[] = [
			{
				value: "yes",
				label: t("overlays.show_images_selector.yes"),
				description: t("overlays.show_images_selector.show_inline_description"),
			},
			{
				value: "no",
				label: t("overlays.show_images_selector.no"),
				description: t("overlays.show_images_selector.text_placeholder_description"),
			},
		];

		// Create selector
		this.#selectList = new SelectList(items, 5, getSelectListTheme(), { search: "always" });

		// Preselect current value
		this.#selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.#selectList.onSelect = item => {
			onSelect(item.value === "yes");
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, {
			title: t("overlays.show_images_selector.show_images_title_2"),
			icon: "image",
			noun: "options",
			current: [currentValue ? "yes" : "no"],
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
