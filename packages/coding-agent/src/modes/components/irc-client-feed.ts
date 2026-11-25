import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { clockTime } from "@oh-my-pi/pi-tui/overlays/irc-viewer";
import { sanitizeDisplaySingleLine, sanitizeDisplayText } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { IrcLogEntry } from "@oh-my-pi/pi-tui/tools/irc";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { ircEntryId } from "../../irc/client-model";

/** Full message rows, with a stable scroll anchor independent of delivery settlement and cursor movement. */
export class IrcClientFeed {
	#cache = new WeakMap<IrcLogEntry, readonly string[]>();
	#width = 0;
	#height = 1;
	#follow = true;
	#selection: string | undefined;
	#reveal = false;
	#anchor: { id: string; line: number } | undefined;
	#offset = 0;
	#page = 0;

	get following(): boolean {
		return this.#follow && this.#page >= 0;
	}

	reset(entryId?: string): void {
		this.#follow = !entryId;
		this.#selection = entryId;
		this.#reveal = !!entryId;
		this.#anchor = undefined;
		this.#offset = 0;
		this.#page = 0;
	}

	selected(entries: readonly IrcLogEntry[]): IrcLogEntry | undefined {
		return (
			(this.#selection && entries.find(entry => ircEntryId(entry) === this.#selection || entry.message.id === this.#selection)) ||
			entries.at(-1)
		);
	}

	page(delta: -1 | 1): void {
		this.#page += delta * Math.max(1, this.#height - 1);
	}

	scroll(delta: -1 | 1): void {
		this.#page += delta;
	}

	move(entries: readonly IrcLogEntry[], delta: number): void {
		const selected = this.selected(entries);
		const index = selected ? entries.indexOf(selected) + delta : entries.length - 1;
		this.select(entries, index);
	}

	select(entries: readonly IrcLogEntry[], index: number): void {
		const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
		if (!entry) return;
		if (index >= entries.length - 1) this.reset();
		else {
			this.#selection = ircEntryId(entry);
			this.#follow = false;
			this.#reveal = true;
		}
	}

	render(
		entries: readonly IrcLogEntry[],
		width: number,
		height: number,
		showCursor: boolean,
		name: (id: string) => string,
		traffic: boolean,
	): string[] {
		if (width !== this.#width) {
			this.#width = width;
			this.#cache = new WeakMap();
		}
		this.#height = height;
		const starts = [0];
		const bodies = entries.map(entry => {
			let body = this.#cache.get(entry);
			if (!body) {
				const text = sanitizeDisplayText(entry.message.groupText ?? entry.message.body);
				body = text.split("\n").flatMap(line => (line ? wrapTextWithAnsi(line, Math.max(1, width - 2)) : [""]));
				this.#cache.set(entry, body);
			}
			starts.push(starts[starts.length - 1]! + 1 + body.length);
			return body;
		});
		const maxTop = Math.max(0, starts.at(-1)! - height);
		const anchor = this.#anchor ? entries.findIndex(entry => ircEntryId(entry) === this.#anchor?.id) : -1;
		let top = this.#follow ? maxTop : anchor >= 0 ? starts[anchor]! + this.#anchor!.line : this.#offset;
		let selected = this.selected(entries);
		if (this.#reveal && selected) {
			const index = entries.indexOf(selected);
			const start = starts[index]!;
			const end = starts[index + 1]!;
			if (start < top || end > top + height) top = start;
			this.#selection = ircEntryId(selected);
		}
		this.#reveal = false;
		const page = this.#page;
		this.#page = 0;
		top = Math.max(0, Math.min(maxTop, top + page));
		if (page !== 0) this.#follow = top === maxTop;
		if (page && traffic) {
			const index = starts.findIndex((start, index) => start < top + height && starts[index + 1]! > top);
			selected = this.#follow ? entries.at(-1) : entries[index];
			this.#selection = !this.#follow && selected ? ircEntryId(selected) : undefined;
		}
		this.#offset = top;
		const output: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (starts[index + 1]! <= top) continue;
			if (output.length >= height) break;
			const entry = entries[index]!;
			const line = Math.max(0, top - starts[index]!);
			if (output.length === 0) this.#anchor = { id: ircEntryId(entry), line };
			if (line === 0) {
				const { message, outcome, error } = entry;
				const to = traffic ? ` → ${sanitizeDisplaySingleLine(message.group ? `#${message.group}` : entry.broadcast ? "all" : name(message.to))}` : "";
				const sender = sanitizeDisplaySingleLine(name(message.from));
				const state = outcome === "failed" ? `  ${theme.fg("error", t("overlays.irc_client.delivery.failed", { error: sanitizeDisplaySingleLine(error ?? "") }))}` : outcome === "queued" ? `  ${theme.fg("dim", t("overlays.irc_viewer.irc_viewer_queued"))}` : "";
				const gutter = showCursor && entry === selected ? theme.fg("accent", "▍") : " ";
				output.push(`${gutter}${theme.fg("dim", clockTime(message.ts))}  ${theme.bold(sender)}${to}${state}`);
			}
			const body = bodies[index]!;
			for (let bodyLine = Math.max(0, line - 1); bodyLine < body.length && output.length < height; bodyLine++) {
				output.push(`  ${body[bodyLine]}`);
			}
		}
		return output;
	}
}
