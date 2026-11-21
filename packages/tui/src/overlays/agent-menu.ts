import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import { type SelectItem, SelectList } from "../components/select-list";
import { matchesAppDismiss } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import type { SgrMouseEvent } from "../mouse";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";
import { uiProvenanceSuffix } from "../theme/provenance";
import { getSelectListTheme } from "../theme/theme";

export class AgentMenuComponent extends OverlayPanel {
	readonly #list: SelectList;
	readonly #sheet: SelectListSheet;

	constructor(actions: { shutdown: () => void; restart?: () => void; forceShutdown: () => void; close: () => void }) {
		super(`Agent Menu${uiProvenanceSuffix("features", "agent-menu", true)}`, "omp.overlay.agent-menu");
		const items: SelectItem[] = [
			{ value: "detach", label: "Detach from Agent", disabled: true },
			{ value: "reattach", label: "Reattach to Agent", disabled: true },
			{ value: "shutdown", label: "Shutdown Agent" },
			{ value: "restart", label: "Restart Agent", disabled: !actions.restart },
			{ value: "force", label: "Force Shutdown" },
		];
		this.#list = new SelectList(items, items.length, getSelectListTheme(), {
			search: "never",
			activateOnSpace: false,
		});
		this.#list.setSelectedValue("shutdown");
		this.#list.onCancel = actions.close;
		this.#list.onSelect = item => {
			actions.close();
			switch (item.value) {
				case "shutdown":
					actions.shutdown();
					break;
				case "restart":
					actions.restart?.();
					break;
				case "force":
					actions.forceShutdown();
					break;
			}
		};
		this.addChild(this.#list);
		this.#sheet = new SelectListSheet(
			this.#list,
			{
				title: `Agent Menu${uiProvenanceSuffix("features", "agent-menu")}`,
				noun: "actions",
			},
			{ docked: false },
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesAppDismiss(data)) this.#list.onCancel?.();
		else this.#list.handleInput(data);
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#list, event, line, col);
	}

	navigationSnapshot(): unknown {
		return this.#list.navigationState();
	}

	restoreNavigation(snapshot: unknown): void {
		this.#list.restoreNavigation(snapshot);
	}
}
