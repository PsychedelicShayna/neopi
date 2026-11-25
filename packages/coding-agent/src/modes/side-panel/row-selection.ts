import type { PanelSelectionTarget } from "@oh-my-pi/pi-tui/chrome";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

/**
 * Keyboard selection over a side-panel view's entries, by stable id. The
 * view's render reports each entry's body rows in order; the selection drops
 * an id that no longer renders and tells the panel which rows to reveal.
 */
export class RowSelection {
	readonly #requestRender: () => void;
	#selected: string | undefined;
	#order: string[] = [];
	#span: { start: number; end: number } | undefined;

	constructor(requestRender: () => void) {
		this.#requestRender = requestRender;
	}

	get id(): string | undefined {
		return this.#selected;
	}

	/** Start a render pass. */
	begin(): void {
		this.#order = [];
		this.#span = undefined;
	}

	/** Record an entry's body rows `[start, end)`; true when it is the selected one. */
	add(id: string, start: number, end: number): boolean {
		this.#order.push(id);
		if (id !== this.#selected) return false;
		this.#span = { start, end };
		return true;
	}

	/** End a render pass: a selected entry that no longer renders is no longer selected. */
	finish(): void {
		if (this.#span === undefined) this.#selected = undefined;
	}

	/** Step through the entries; nothing selected starts at the first (down) or last (up). False when there are none. */
	move(delta: number): boolean {
		const count = this.#order.length;
		if (count === 0) return false;
		const index = this.#selected === undefined ? -1 : this.#order.indexOf(this.#selected);
		const next = index < 0 ? (delta > 0 ? 0 : count - 1) : Math.max(0, Math.min(count - 1, index + delta));
		this.select(this.#order[next]);
		return true;
	}

	edge(edge: "first" | "last"): boolean {
		if (this.#order.length === 0) return false;
		this.select(edge === "first" ? this.#order[0] : this.#order.at(-1));
		return true;
	}

	select(id: string | undefined): void {
		if (id === this.#selected) return;
		this.#selected = id;
		this.#requestRender();
	}

	clear(): void {
		this.select(undefined);
	}

	/** The selected rows for the panel to reveal; the revision changes when the selection or its rows move. */
	target(): PanelSelectionTarget | undefined {
		const span = this.#span;
		if (this.#selected === undefined || span === undefined) return undefined;
		return { ...span, revision: `${this.#selected}:${span.start}` };
	}
}

/** Paint an already-fitted row with the selection band across the full width. */
export function selectedRow(fitted: string, width: number): string {
	return theme.bgFill("selectedBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))));
}
