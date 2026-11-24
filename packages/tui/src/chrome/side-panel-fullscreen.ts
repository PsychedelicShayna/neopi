import { t } from "@oh-my-pi/pi-utils/i18n";
import { Stack } from "../components/layout/stack";
import { isRightPress, routeSgrMouseInput } from "../mouse";
import { theme } from "../theme/index";
import type { Component } from "../tui";
import { PanelRows } from "./overlay-box";
import type { SidePanel } from "./side-panel";

/** Construction options for {@link SidePanelFullscreenComponent}. */
export interface SidePanelFullscreenOptions {
	/** The same panel instance the dock shows; both forms share sections and scroll. */
	readonly panel: SidePanel;
	/** Terminal rows available to the form (the overlay has no height input of its own). */
	readonly rows: () => number;
}

/**
 * Narrow-terminal form of the side panel: the shared {@link SidePanel} at full
 * width below a title row, shown as a fullscreen overlay when the terminal is
 * below the dock threshold.
 */
export class SidePanelFullscreenComponent implements Component {
	readonly #options: SidePanelFullscreenOptions;
	readonly #title = new PanelRows();
	readonly #stack: Stack;

	constructor(options: SidePanelFullscreenOptions) {
		this.#options = options;
		this.#stack = new Stack({
			children: [
				{ content: this.#title, height: 1 },
				{ content: options.panel, grow: 1 },
			],
		});
	}

	render(width: number): readonly string[] {
		const rows = Math.max(2, this.#options.rows());
		this.#title.setLines([theme.bold(theme.fg("accent", t("overlays.side_panel.title")))]);
		this.#stack.setHeight(rows);
		return this.#stack.render(width);
	}

	handleInput(data: string): void {
		const panel = this.#options.panel;
		const handledMouse = routeSgrMouseInput(data, event => {
			const bodyRows = Math.max(2, this.#options.rows()) - 1;
			// The title row has no section target, but still belongs to the panel.
			if (event.row >= 1 && event.row <= bodyRows) panel.routeMouse(event, event.row - 1, event.col);
			else if (event.motion) panel.pointerLeave();
			else if (isRightPress(event)) panel.routeMouse(event, -1, event.col);
			return true;
		});
		if (handledMouse) return;
		panel.handleInput(data);
	}

	capturesInput(data: string): boolean {
		return this.#options.panel.capturesInput(data);
	}

	invalidate(): void {
		this.#title.invalidate();
		this.#options.panel.invalidate();
	}
}
