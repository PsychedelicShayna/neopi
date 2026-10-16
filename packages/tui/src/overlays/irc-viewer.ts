/**
 * Fullscreen IRC communications viewer: the operator's history of every
 * agent-to-agent message in this session, which the transcript's live IRC
 * cards (capped, auto-retiring) cannot hold. Read-only; it never changes what
 * any agent can see.
 */
import { formatKeyHint, type KeyId } from "../app-keybindings";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { matchesSelectDown, matchesSelectPageDown, matchesSelectPageUp, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { theme } from "../theme/theme";
import type { IrcLogEntry, IrcLogSource } from "../tools/irc";
import type { Component } from "../tui";
import { Ellipsis, replaceTabs, truncateToWidth, wrapTextWithAnsi } from "../utils";
import { filterInput, filterText } from "./agent-hub";
import { sanitizeDisplaySingleLine, sanitizeDisplayText } from "./extensions/display-text";

/** Body lines a collapsed entry shows before its "+N more" line. */
const COLLAPSED_BODY_LINES = 2;
/** Rows of chrome around the message list: top border, status row, two dividers, footer row, bottom border. */
const CHROME_ROWS = 6;

export interface IrcViewerOptions {
	readonly source: IrcLogSource;
	/** Keys that opened the viewer; pressing one again closes it. */
	readonly viewerKeys: readonly KeyId[];
	/** Keys that expand or collapse the selected message (Enter always does). */
	readonly expandKeys: readonly KeyId[];
	/** Screen rows the viewer fills. */
	readonly rows: () => number;
	readonly onClose: () => void;
	readonly requestRender: () => void;
	/** The operator's IRC id: replying to her own message answers its recipient. */
	readonly operatorId?: string;
	/** Sends as the operator; with it, `r` replies to the selected message. Resolves with the delivery summary. */
	readonly reply?: (to: string, message: string, replyTo: string) => Promise<{ text: string; isError: boolean }>;
}

/** `HH:MM:SS` in local time. */
function clockTime(ts: number): string {
	const date = new Date(ts);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

function matchesParticipant(entry: IrcLogEntry, query: string): boolean {
	if (!query) return true;
	const needle = query.toLowerCase();
	return entry.message.from.toLowerCase().includes(needle) || entry.message.to.toLowerCase().includes(needle);
}

export class IrcViewerComponent implements Component {
	readonly #options: IrcViewerOptions;
	readonly #unsubscribe: () => void;
	readonly #filter = filterInput();
	#filterEditing = false;
	/** Index into the filtered entries; the last entry while following. */
	#selected = 0;
	/** Keep the newest message selected as traffic arrives. */
	#follow = true;
	/** First list row on screen. */
	#top = 0;
	/** List rows the last frame had room for. */
	#listRows = 1;
	/** List-row span of the selected entry in the last frame. */
	#selectedSpan = { start: 0, end: 0 };
	readonly #expanded = new Set<string>();
	/** The reply being written, and to whom. */
	#compose: { to: string; replyTo: string } | undefined;
	readonly #draft = filterInput();
	/** Outcome of the last reply, shown in the status row until the next key. */
	#notice: { text: string; isError: boolean } | undefined;

	constructor(options: IrcViewerOptions) {
		this.#options = options;
		this.#unsubscribe = options.source.subscribe(() => options.requestRender());
	}

	dispose(): void {
		this.#unsubscribe();
	}

	invalidate(): void {}

	#visible(): readonly IrcLogEntry[] {
		const query = this.#filter.getValue().trim();
		const entries = this.#options.source.entries();
		return query ? entries.filter(entry => matchesParticipant(entry, query)) : entries;
	}

	#header(entry: IrcLogEntry, selected: boolean): string {
		const { message } = entry;
		const from = sanitizeDisplaySingleLine(message.from);
		const to = sanitizeDisplaySingleLine(message.to);
		const names = `${from} ${theme.fg("accent", theme.nav.selected)} ${to}`;
		const meta: string[] = [];
		if (entry.broadcast) meta.push("broadcast");
		if (message.replyTo) meta.push("reply");
		if (message.wakeRelay) meta.push("relay");
		if (entry.outcome === "queued") meta.push("queued");
		const failed =
			entry.outcome === "failed"
				? `  ${theme.fg("error", `failed${entry.error ? `: ${sanitizeDisplaySingleLine(entry.error)}` : ""}`)}`
				: "";
		const gutter = selected ? theme.fg("accent", "▍") : " ";
		return `${gutter}${theme.fg("dim", clockTime(message.ts))}  ${selected ? theme.bold(names) : names}${
			meta.length > 0 ? theme.fg("dim", `  ${meta.join(" · ")}`) : ""
		}${failed}`;
	}

	#bodyLines(entry: IrcLogEntry, width: number, selected: boolean): string[] {
		const gutter = selected ? theme.fg("accent", "▍") : " ";
		const quote = theme.fg("dim", theme.md.quoteBorder);
		const lineWidth = Math.max(1, width - 4);
		const wrapped = replaceTabs(sanitizeDisplayText(entry.message.body))
			.split("\n")
			.flatMap(line => (line.trim() ? wrapTextWithAnsi(line, lineWidth) : [""]));
		while (wrapped.length > 0 && !wrapped[wrapped.length - 1]?.trim()) wrapped.pop();
		const expanded = this.#expanded.has(entry.message.id);
		const shown = expanded ? wrapped : wrapped.slice(0, COLLAPSED_BODY_LINES);
		const lines = shown.map(line => `${gutter} ${quote} ${theme.fg("toolOutput", line)}`);
		const hidden = wrapped.length - shown.length;
		if (hidden > 0) {
			lines.push(`${gutter} ${quote} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
		}
		return lines;
	}

	render(width: number): readonly string[] {
		const height = Math.max(CHROME_ROWS + 1, this.#options.rows());
		const inner = Math.max(1, width - 4);
		const all = this.#options.source.entries();
		const visible = this.#visible();
		if (this.#follow || this.#selected >= visible.length) this.#selected = Math.max(0, visible.length - 1);

		const list: string[] = [];
		let selectedStart = 0;
		let selectedEnd = 0;
		visible.forEach((entry, index) => {
			const selected = index === this.#selected;
			if (selected) selectedStart = list.length;
			list.push(this.#header(entry, selected), ...this.#bodyLines(entry, inner, selected));
			if (selected) selectedEnd = list.length;
		});

		this.#listRows = height - CHROME_ROWS;
		this.#selectedSpan = { start: selectedStart, end: selectedEnd };
		if (this.#follow) this.#top = Math.max(0, list.length - this.#listRows);
		else if (selectedEnd - selectedStart > this.#listRows)
			// Taller than the screen (an expanded long message): keep the viewport inside it, wherever line scrolling left it.
			this.#top = Math.max(selectedStart, Math.min(this.#top, selectedEnd - this.#listRows));
		else if (selectedStart < this.#top) this.#top = selectedStart;
		else if (selectedEnd > this.#top + this.#listRows) this.#top = selectedEnd - this.#listRows;
		this.#top = Math.max(0, Math.min(this.#top, Math.max(0, list.length - this.#listRows)));

		const body =
			visible.length === 0
				? [
						theme.fg(
							"dim",
							all.length === 0 ? "No agent messages in this session yet." : "No messages match the filter.",
						),
					]
				: list.slice(this.#top, this.#top + this.#listRows);
		while (body.length < this.#listRows) body.push("");

		const participants = new Set(all.flatMap(entry => [entry.message.from, entry.message.to])).size;
		const broadcasts = all.filter(entry => entry.broadcast).length;
		const counts = `${all.length} ${all.length === 1 ? "message" : "messages"} · ${broadcasts} broadcast · ${participants} ${participants === 1 ? "participant" : "participants"}`;
		const query = this.#filter.getValue();
		const status = this.#compose
			? theme.fg("accent", `reply to ${sanitizeDisplaySingleLine(this.#compose.to)}: ${filterText(this.#draft)}`)
			: this.#notice
				? theme.fg(this.#notice.isError ? "error" : "success", sanitizeDisplaySingleLine(this.#notice.text))
				: this.#filterEditing
					? theme.fg("accent", `filter: ${filterText(this.#filter)}`)
					: query
						? `${theme.fg("accent", `filter: ${query}`)}${theme.fg("dim", `  ${visible.length} shown · ${counts}`)}`
						: theme.fg("dim", counts);

		const hints = this.#compose
			? "enter send · esc cancel"
			: this.#filterEditing
				? "enter apply · esc clear"
				: `↑↓ select · enter expand${this.#options.reply ? " · r reply" : ""} · / filter · end follow · ${[
						"esc",
						...this.#options.viewerKeys.map(key => formatKeyHint(key)),
					].join("/")} close`;

		const frame = [
			topBorder(width, "IRC"),
			row(status, width),
			divider(width),
			...body.map(line => row(truncateToWidth(line, inner, Ellipsis.Unicode), width)),
			divider(width),
			row(theme.fg("muted", truncateToWidth(hints, inner, Ellipsis.Unicode)), width),
			bottomBorder(width),
		];
		return frame;
	}

	#select(index: number): void {
		const count = this.#visible().length;
		if (count === 0) return;
		this.#selected = Math.max(0, Math.min(count - 1, index));
		this.#follow = this.#selected === count - 1;
		this.#options.requestRender();
	}

	/**
	 * Scroll by `delta` lines inside the selected entry when it is taller than
	 * the screen; false when it fits or the edge is already showing, so the
	 * key moves the selection instead.
	 */
	#scrollWithinSelected(delta: number): boolean {
		const { start, end } = this.#selectedSpan;
		if (end - start <= this.#listRows) return false;
		const next = Math.max(start, Math.min(this.#top + delta, end - this.#listRows));
		if (next === this.#top) return false;
		this.#top = next;
		this.#follow = false;
		this.#options.requestRender();
		return true;
	}

	#step(lines: number, entries: number): void {
		if (!this.#scrollWithinSelected(lines)) this.#select(this.#selected + entries);
	}

	#toggleExpanded(): void {
		const entry = this.#visible()[this.#selected];
		if (!entry) return;
		const { id } = entry.message;
		if (!this.#expanded.delete(id)) this.#expanded.add(id);
		this.#follow = false;
		this.#options.requestRender();
	}

	#handleFilterInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.#filter.setValue("");
			this.#filterEditing = false;
		} else if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			this.#filterEditing = false;
		} else if (!this.#filter.handleInput(data)) {
			return;
		}
		this.#follow = true;
		this.#options.requestRender();
	}

	#startReply(): void {
		const entry = this.#visible()[this.#selected];
		if (!entry || !this.#options.reply) return;
		const { message } = entry;
		const to = message.from === this.#options.operatorId ? message.to : message.from;
		this.#compose = { to, replyTo: message.id };
		this.#draft.setValue("");
		this.#options.requestRender();
	}

	#handleComposeInput(data: string): void {
		const compose = this.#compose;
		const reply = this.#options.reply;
		if (!compose || !reply) return;
		if (matchesKey(data, "escape")) {
			this.#compose = undefined;
		} else if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			const body = this.#draft.getValue().trim();
			if (!body) return;
			this.#compose = undefined;
			this.#follow = true;
			void reply(compose.to, body, compose.replyTo).then(
				result => {
					this.#notice = result;
					this.#options.requestRender();
				},
				(error: unknown) => {
					this.#notice = { text: error instanceof Error ? error.message : String(error), isError: true };
					this.#options.requestRender();
				},
			);
		} else if (!this.#draft.handleInput(data)) {
			return;
		}
		this.#options.requestRender();
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#step(event.wheel * 3, event.wheel);
				return true;
			})
		) {
			return;
		}
		if (this.#compose) {
			this.#handleComposeInput(data);
			return;
		}
		this.#notice = undefined;
		if (this.#filterEditing) {
			this.#handleFilterInput(data);
			return;
		}
		if (matchesKey(data, "escape") || this.#options.viewerKeys.some(key => matchesKey(data, key))) {
			this.#options.onClose();
			return;
		}
		if (data === "/") {
			this.#filterEditing = true;
			this.#options.requestRender();
			return;
		}
		if (data === "r" && this.#options.reply) {
			this.#startReply();
			return;
		}
		if (matchesKey(data, "enter") || this.#options.expandKeys.some(key => matchesKey(data, key))) {
			this.#toggleExpanded();
			return;
		}
		const page = Math.max(1, Math.floor(this.#listRows / 3));
		if (matchesSelectUp(data)) this.#step(-1, -1);
		else if (matchesSelectDown(data)) this.#step(1, 1);
		else if (matchesSelectPageUp(data)) this.#step(-Math.max(1, this.#listRows - 1), -page);
		else if (matchesSelectPageDown(data)) this.#step(Math.max(1, this.#listRows - 1), page);
		else if (matchesKey(data, "home")) this.#select(0);
		else if (matchesKey(data, "end")) this.#select(Number.MAX_SAFE_INTEGER);
	}
}
