import { type DefaultTextStyle, Markdown, type MarkdownTheme } from "../components/markdown";
import { card, compact, elapsed, md, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { agentColored, agentColorHex } from "../overlays/agent-identity";
import { sanitizeDisplaySingleLine, sanitizeDisplayText } from "../overlays/extensions/display-text";
import { clockTime } from "../overlays/irc-viewer";
import { getMarkdownTheme, getThemeEpoch, theme } from "../theme";
import type { Component } from "../tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";

/** What an `irc:incoming` or `irc:relay` transcript entry keeps in `details` for its block. */
export interface IrcMessageDetails {
	from?: string;
	to?: string;
	/** The delivered body: `irc:incoming` keeps it in `message`, `irc:relay` in `body`. */
	message?: string;
	body?: string;
	replyTo?: string;
	wakeRelay?: boolean;
	broadcast?: boolean;
	progress?: boolean;
	/** Group named by the message when it was sent; later membership changes never rewrite it. */
	group?: string;
	/** The sender's own text of a group send, without the heading the delivered body opens with. */
	groupText?: string;
	/** Other groups sender and recipient shared when it was sent. */
	sharedGroups?: string[];
}

/** One peer message as the transcript shows it. */
export interface IrcMessageView {
	/** `incoming`: delivered here; `outgoing`: sent from here; `relay`: observed between others. */
	kind: "incoming" | "outgoing" | "relay";
	from?: string;
	/** The recipient of an outgoing or relayed message. */
	to?: string;
	body?: string;
	timestamp?: number;
	replyTo?: string;
	wakeRelay?: boolean;
	broadcast?: boolean;
	progress?: boolean;
	group?: string;
	/** True when `group` is where the message was sent; false when the message is a notice about it. */
	sentToGroup?: boolean;
	sharedGroups?: readonly string[];
}

/** The view of a stored `irc:incoming` / `irc:relay` entry. */
export function ircMessageView(
	kind: IrcMessageView["kind"],
	details: IrcMessageDetails | undefined,
	timestamp: number | undefined,
): IrcMessageView {
	return {
		kind,
		from: details?.from,
		to: details?.to,
		body: details?.groupText ?? (kind === "incoming" ? details?.message : details?.body),
		timestamp,
		replyTo: details?.replyTo,
		wakeRelay: details?.wakeRelay,
		broadcast: details?.broadcast,
		progress: details?.progress,
		group: details?.group,
		sentToGroup: typeof details?.groupText === "string",
		sharedGroups: Array.isArray(details?.sharedGroups) ? details.sharedGroups : undefined,
	};
}

/**
 * Whether `message` is the operator's own copy of an IRC message: a DM to her,
 * or her leg of a group send. The bus shows it on her UI as a display-only
 * `irc:relay` record addressed to her id; nothing stores it in a transcript.
 */
export function isOperatorIrcNotice(
	message: { customType?: string; details?: unknown },
	operatorId: string | undefined,
): boolean {
	if (operatorId === undefined || message.customType !== "irc:relay") return false;
	const details = message.details;
	return typeof details === "object" && details !== null && Reflect.get(details, "to") === operatorId;
}

const NO_ROWS: readonly string[] = [];

function lineLabel(value: string | undefined): string {
	return sanitizeDisplaySingleLine(typeof value === "string" ? value : "").trim();
}

/** Prose in the primary agent's own text colour, so the body reads like a message, not like tool output. */
function proseStyle(): DefaultTextStyle | undefined {
	if (!theme.hasColor("assistantMessageText")) return undefined;
	return { color: value => theme.fg("assistantMessageText", value), proseFg: true };
}

/**
 * `corner─ label ───── tail` across exactly `width` columns: the tail goes first
 * when the row is too narrow for both, then the label is cut.
 */
function ruleRow(corner: string, label: string, tail: string, width: number, paint: (value: string) => string): string {
	const dash = theme.boxRound.horizontal;
	const lead = `${corner}${dash} `;
	const room = width - visibleWidth(lead);
	if (room <= 0) return paint(truncateToWidth(`${corner}${dash}`, width, ""));
	const shownTail = tail && visibleWidth(label) + visibleWidth(tail) + 4 <= room ? tail : "";
	const shownLabel = visibleWidth(label) > room ? truncateToWidth(label, room, Ellipsis.Unicode) : label;
	const fill = room - visibleWidth(shownLabel) - 1 - (shownTail ? visibleWidth(shownTail) + 1 : 0);
	return `${paint(lead)}${shownLabel}${fill > 0 ? ` ${paint(dash.repeat(fill))}` : ""}${shownTail ? ` ${shownTail}` : ""}`;
}

/**
 * A peer's IRC message in the transcript, shown whole: no preview, no expiry.
 * Two rules in the sender's Agent Hub colour bracket it and a rail of the same
 * colour runs down the body, so any row of a long message says whose it is. The
 * opening rule alone carries the envelope, the route (`➤ #group`, or the
 * recipient of an observed message), the markers and the time; the closing rule
 * repeats only the name, so the two never look alike. The body is Markdown in
 * the primary agent's prose colour at the transcript's full width.
 */
export class IrcMessageBlock implements Component {
	readonly #view: IrcMessageView;
	/** Sender id as registered: the key of its Agent Hub colour. */
	readonly #fromId: string;
	readonly #from: string;
	readonly #body: string;
	#markdown: { theme: MarkdownTheme; component: Markdown } | undefined;
	#cache:
		| { width: number; body: readonly string[]; colour: string; epoch: number; lines: readonly string[] }
		| undefined;
	#native: NativeNode | undefined;

	constructor(view: IrcMessageView) {
		this.#view = view;
		this.#fromId = typeof view.from === "string" ? view.from.trim() : "";
		this.#from = lineLabel(view.from) || "?";
		this.#body = sanitizeDisplayText(typeof view.body === "string" ? view.body : "")
			.replace(/^(?:[ \t]*\n)+/, "")
			.trimEnd();
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#markdown?.component.invalidate();
	}

	releaseRenderCaches(): void {
		this.#cache = undefined;
		this.#markdown?.component.releaseRenderCaches();
	}

	#paint(value: string): string {
		return this.#fromId ? agentColored(theme, this.#fromId, value) : theme.fg("dim", value);
	}

	/** Dim facts after the route: what kind of message it is and the groups both ends share. */
	#markers(): string[] {
		const view = this.#view;
		const group = lineLabel(view.group);
		const markers: string[] = [];
		if (view.replyTo) markers.push("reply");
		if (view.progress) markers.push("progress");
		if (view.wakeRelay) markers.push("relay");
		if (group && !view.sentToGroup) markers.push(`#${group}`);
		if (view.broadcast && !group) markers.push("broadcast");
		const shared = (view.sharedGroups ?? []).map(lineLabel).filter(name => name.length > 0);
		if (shared.length > 0) markers.push(`shared ${shared.map(name => `#${name}`).join(" ")}`);
		return markers;
	}

	/** Where the message went, when that is not simply this session: a group or a recipient. */
	#route(): { group: string } | { to: string; toId: string } | undefined {
		const view = this.#view;
		const group = lineLabel(view.group);
		if (group && view.sentToGroup) return { group };
		const toId = view.kind !== "incoming" && typeof view.to === "string" ? view.to.trim() : "";
		// A notice an agent's own action sent it (added to a group) is not a message to someone else.
		if (!toId || toId === this.#fromId) return undefined;
		return { to: lineLabel(toId), toId };
	}

	#openingLabel(): string {
		let label = `${this.#paint(theme.symbol("tool.irc"))} ${this.#paint(theme.bold(this.#from))}`;
		const route = this.#route();
		if (route) {
			const target =
				"group" in route ? theme.bold(`#${route.group}`) : agentColored(theme, route.toId, theme.bold(route.to));
			label += ` ${theme.fg("dim", theme.nav.selected)} ${target}`;
		}
		for (const marker of this.#markers()) label += theme.fg("dim", `${theme.sep.dot}${marker}`);
		return label;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		const markdownTheme = getMarkdownTheme();
		if (this.#markdown?.theme !== markdownTheme) {
			this.#markdown = {
				theme: markdownTheme,
				component: new Markdown(this.#body, 0, 0, markdownTheme, proseStyle(), 0),
			};
		}
		const body = this.#body ? this.#markdown.component.render(Math.max(1, width - 2)) : NO_ROWS;
		const colour = this.#fromId ? agentColorHex(theme, this.#fromId) : "";
		const epoch = getThemeEpoch();
		const cached = this.#cache;
		if (
			cached !== undefined &&
			cached.width === width &&
			cached.body === body &&
			cached.colour === colour &&
			cached.epoch === epoch
		) {
			return cached.lines;
		}

		const paint = (value: string) => this.#paint(value);
		const box = theme.boxRound;
		const time = this.#view.timestamp ? theme.fg("dim", clockTime(this.#view.timestamp)) : "";
		const rail = `${paint(box.vertical)} `;
		let lines = [ruleRow(box.topLeft, this.#openingLabel(), time, width, paint)];
		for (const line of body) lines.push(`${rail}${line}`);
		lines.push(ruleRow(box.bottomLeft, paint(this.#from), "", width, paint));
		// The rail needs two columns of its own; below that, nothing may overflow the row.
		if (width < 4) lines = lines.map(line => truncateToWidth(line, width, ""));
		this.#cache = { width, body, colour, epoch, lines };
		return lines;
	}

	/** Natively a card headed by the sender and route, holding the whole message as Markdown. */
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const head: TspSpan[] = [span(this.#from, "toolTitle strong")];
		const route = this.#route();
		if (route) head.push(span(` ${theme.nav.selected} ${"group" in route ? `#${route.group}` : route.to}`, "strong"));
		for (const marker of this.#markers()) head.push(span(` ${marker}`, "muted"));
		const timestamp = this.#view.timestamp;
		this.#native = card(
			{ role: `omp.irc.${this.#view.kind}`, tone: "info", head },
			compact([
				timestamp ? row([elapsed(Date.now() - timestamp), text([span("ago", "dim")])], { gap: "xs" }) : undefined,
				this.#body ? md(this.#body) : undefined,
			]),
		);
		return this.#native;
	}
}
