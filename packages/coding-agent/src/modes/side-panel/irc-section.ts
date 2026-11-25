import type { MouseRoutable, SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { PanelSelectionTarget } from "@oh-my-pi/pi-tui/chrome";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { clockTime } from "@oh-my-pi/pi-tui/overlays/irc-viewer";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { IrcLogEntry, IrcLogSource } from "@oh-my-pi/pi-tui/tools/irc";
import type { SidePanelViewSection } from "../controllers/side-panel-controller";
import { RowSelection, selectedRow } from "./row-selection";

/** Newest messages the panel lists; the full history stays in the IRC viewer. */
const IRC_PANEL_ENTRIES = 100;

/** What the IRC section needs from its host. */
export interface IrcSectionHost {
	/** The operator IRC history the `app.irc.viewer` overlay reads. */
	readonly source: IrcLogSource;
	/** Open the full IRC viewer, at `messageId` when given. */
	openViewer(messageId?: string): void;
	requestRender(): void;
}

class IrcContent implements MouseRoutable {
	readonly #host: IrcSectionHost;
	readonly #unsubscribe: () => void;
	readonly selection: RowSelection;
	/** Message id per rendered body row, from the last render. */
	#rowIds: string[] = [];

	constructor(host: IrcSectionHost) {
		this.#host = host;
		this.selection = new RowSelection(() => host.requestRender());
		this.#unsubscribe = host.source.subscribe(() => host.requestRender());
	}

	render(width: number): readonly string[] {
		const entries = this.#host.source.entries();
		this.selection.begin();
		this.#rowIds = [];
		const lines: string[] = [];
		// Newest first, so the top of the panel is the latest traffic without scrolling.
		for (let index = entries.length - 1; index >= Math.max(0, entries.length - IRC_PANEL_ENTRIES); index--) {
			const entry = entries[index]!;
			const top = lines.length;
			let rows = this.#entryLines(entry, width);
			if (this.selection.add(entry.message.id, top, top + rows.length)) {
				rows = rows.map(row => selectedRow(row, width));
			}
			lines.push(...rows);
			for (const _ of rows) this.#rowIds.push(entry.message.id);
		}
		this.selection.finish();
		return lines;
	}

	#entryLines(entry: IrcLogEntry, width: number): string[] {
		const { message } = entry;
		const names = `${sanitizeDisplaySingleLine(message.from)} ${theme.fg("accent", theme.nav.selected)} ${sanitizeDisplaySingleLine(message.to)}`;
		const failed = entry.outcome === "failed" ? theme.fg("error", " failed") : "";
		const head = `${theme.fg("dim", clockTime(message.ts))} ${names}${failed}`;
		const body = sanitizeDisplaySingleLine(message.body);
		return [
			truncateToWidth(head, width, ""),
			truncateToWidth(` ${theme.fg("dim", theme.md.quoteBorder)} ${theme.fg("toolOutput", body)}`, width),
		];
	}

	itemIdAtRow(row: number): string | undefined {
		return this.#rowIds[row];
	}

	routeMouse(event: SgrMouseEvent, line: number): void {
		if (event.leftClick) this.#host.openViewer(this.#rowIds[line]);
	}

	invalidate(): void {}

	dispose(): void {
		this.#unsubscribe();
	}
}

/**
 * The IRC view of the side panel: the newest agent-to-agent messages from the
 * operator IRC history, newest first, one header and one body line each. It
 * reads the same history as the `app.irc.viewer` overlay; clicking a message,
 * or Right/Enter on the selected one, opens that viewer for the full log,
 * filtering and replies.
 */
export class IrcSection implements SidePanelViewSection {
	readonly id = "irc";
	readonly title = "IRC";
	readonly order = 10;
	collapsed?: boolean;
	readonly content: IrcContent;
	readonly #host: IrcSectionHost;

	constructor(host: IrcSectionHost) {
		this.#host = host;
		this.content = new IrcContent(host);
	}

	selectionTarget(): PanelSelectionTarget | undefined {
		return this.content.selection.target();
	}

	itemIdAtRow(row: number): string | undefined {
		return this.content.itemIdAtRow(row);
	}

	moveSelection(delta: number): boolean {
		return this.content.selection.move(delta);
	}

	selectEdge(edge: "first" | "last"): boolean {
		return this.content.selection.edge(edge);
	}

	clearSelection(): void {
		this.content.selection.clear();
	}

	expand(): void {
		this.#host.openViewer(this.content.selection.id);
	}
}
