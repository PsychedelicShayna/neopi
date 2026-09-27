import { Stack } from "../components/layout/stack";
import { type KeyId, matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { theme } from "../theme/index";
import type { Component } from "../tui";
import { PanelRows } from "./overlay-box";
import type { SidePanel } from "./side-panel";

/** Construction options for {@link SidePanelFullscreenComponent}. */
export interface SidePanelFullscreenOptions {
	/** The same panel instance the dock shows; both forms share sections and scroll. */
	readonly panel: SidePanel;
	/** Close request (Escape or a toggle key); the owner hides exactly this overlay. */
	readonly onClose: () => void;
	/** Keys bound to `app.sidebar.toggle`; they close the form like Escape. */
	readonly toggleKeys: readonly KeyId[];
	/** Terminal rows available to the form (the overlay has no height input of its own). */
	readonly rows: () => number;
}

/**
 * Narrow-terminal form of the side panel: the shared {@link SidePanel} at full
 * width between a title row and a key-hint footer, shown as a fullscreen
 * overlay when the terminal is below the dock threshold.
 */
export class SidePanelFullscreenComponent implements Component {
	readonly #options: SidePanelFullscreenOptions;
	readonly #title = new PanelRows();
	readonly #footer = new PanelRows();
	readonly #stack: Stack;

	constructor(options: SidePanelFullscreenOptions) {
		this.#options = options;
		this.#stack = new Stack({
			children: [
				{ content: this.#title, height: 1 },
				{ content: options.panel, grow: 1 },
				{ content: this.#footer, height: 1 },
			],
		});
	}

	render(width: number): readonly string[] {
		const rows = Math.max(3, this.#options.rows());
		this.#title.setLines([theme.bold(theme.fg("accent", "Side panel"))]);
		const toggle = this.#options.toggleKeys[0];
		const close = toggle === undefined ? "esc" : `esc / ${toggle}`;
		this.#footer.setLines([theme.fg("dim", `${close} close · ↑↓ scroll`)]);
		this.#stack.setHeight(rows);
		return this.#stack.render(width);
	}

	handleInput(data: string): void {
		const panel = this.#options.panel;
		const handledMouse = routeSgrMouseInput(data, event => {
			const bodyRows = Math.max(1, this.#options.rows()) - 2;
			// Title and footer rows are consumed; body rows are panel-local after the title.
			if (event.row >= 1 && event.row <= bodyRows) panel.routeMouse(event, event.row - 1, event.col);
			return true;
		});
		if (handledMouse) return;
		if (matchesKey(data, "escape") || this.#options.toggleKeys.some(key => matchesKey(data, key))) {
			this.#options.onClose();
			return;
		}
		const page = Math.max(1, this.#options.rows() - 2);
		if (matchesKey(data, "up")) panel.scrollBy(-1);
		else if (matchesKey(data, "down")) panel.scrollBy(1);
		else if (matchesKey(data, "pageUp")) panel.scrollBy(-page);
		else if (matchesKey(data, "pageDown")) panel.scrollBy(page);
	}

	invalidate(): void {
		this.#title.invalidate();
		this.#footer.invalidate();
		this.#options.panel.invalidate();
	}
}
