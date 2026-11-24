import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

function thinkingItems(levels: readonly ConfiguredThinkingLevel[]): SelectItem[] {
	return levels.map(value => ({
		value,
		label: t(`overlaysModel.thinkingSelector.level.${value}.label`),
		description: t(`overlaysModel.thinkingSelector.level.${value}.description`),
	}));
}

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;
	readonly #levels: readonly ConfiguredThinkingLevel[];
	#locale = getLocale();

	constructor(
		currentLevel: ConfiguredThinkingLevel | undefined,
		availableLevels: ConfiguredThinkingLevel[],
		onSelect: (level: ConfiguredThinkingLevel) => void,
		onCancel: () => void,
	) {
		super(t("overlaysModel.thinkingSelector.title.terminal"), "omp.overlay.thinking");
		this.#levels = availableLevels.slice();

		const thinkingLevels = thinkingItems(this.#levels);

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme(), {
			search: "always",
		});

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex(item => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as ConfiguredThinkingLevel);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, () => ({
			title: t("overlaysModel.thinkingSelector.title.picker"),
			icon: "brain",
			noun: t("overlaysModel.thinkingSelector.noun"),
			current: currentLevel ? [currentLevel] : [],
			// How hard each level thinks, as a meter from off (empty) to the deepest effort (full); auto has none.
			columns: [{ id: "depth", format: "bar" }],
			decorate: item => {
				if (item.value === AUTO_THINKING) return undefined;
				const effort = THINKING_EFFORTS.indexOf(item.value as (typeof THINKING_EFFORTS)[number]);
				return { facts: { depth: (effort + 1) / THINKING_EFFORTS.length } };
			},
		}));
	}

	#syncLocale(): void {
		const locale = getLocale();
		if (this.#locale === locale) return;
		this.#locale = locale;
		this.title = t("overlaysModel.thinkingSelector.title.terminal");
		this.#selectList.setItems(thinkingItems(this.#levels));
	}

	override render(width: number): readonly string[] {
		this.#syncLocale();
		return super.render(width);
	}

	override describe(cx: DescribeContext): NativeNode | null {
		this.#syncLocale();
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
