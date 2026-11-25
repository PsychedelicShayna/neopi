import { type DefaultTextStyle, Markdown, type MarkdownTheme } from "../components/markdown";
import { card, md, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { styledSpans } from "../native/spans";
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
	id?: string;
	/** The deliveries visible to the session that owns this transcript. */
	deliveredRecipientIds?: string[];
	fanoutId?: string;
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
	kind: "incoming" | "operator" | "both" | "outgoing" | "relay";
	from?: string;
	to?: string | readonly string[];
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
		to: Array.isArray(details?.deliveredRecipientIds) ? details.deliveredRecipientIds : details?.to,
		body: details?.groupText ?? details?.message ?? details?.body,
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

const DIRECTION: Record<IrcMessageView["kind"], string> = {
	incoming: "⇠ Agent",
	operator: "⇠ You",
	both: "⇠ Both",
	outgoing: "⇢ Sent",
	relay: "◇ Relay",
};

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
 * colour runs down its body. The opening rule carries the direction, route,
 * markers and time; the closing rule repeats only the name. The body is Markdown in the primary
 * agent's prose colour at the transcript's full width.
 */
export class IrcMessageBlock implements Component {
	#view: IrcMessageView;
	/** Sender id as registered: the key of its Agent Hub colour. */
	readonly #fromId: string;
	readonly #from: string;
	#body = "";
	#markdown: { theme: MarkdownTheme; component: Markdown } | undefined;
	#cache:
		| { width: number; body: readonly string[]; colour: string; epoch: number; lines: readonly string[] }
		| undefined;
	#native: NativeNode | undefined;

	constructor(view: IrcMessageView) {
		this.#view = view;
		this.#fromId = typeof view.from === "string" ? view.from.trim() : "";
		this.#from = lineLabel(view.from) || "?";
		this.#setBody(view.body);
	}

	#setBody(body: string | undefined): void {
		const sanitized = sanitizeDisplayText(typeof body === "string" ? body : "")
			.replace(/^(?:[ \t]*\n)+/, "")
			.trimEnd();
		if (this.#body !== sanitized) {
			this.#body = sanitized;
			this.#markdown = undefined;
		}
	}

	/** Fold the two actual deliveries in either order, keeping the agent leg's envelope metadata. */
	mergeDelivery(view: IrcMessageView): void {
		const existing = this.#view;
		if (existing.kind === "both" || view.kind === existing.kind) return;
		if (view.kind !== "both" && (existing.kind === "relay" || view.kind === "relay")) return;
		const agent = view.kind === "incoming" || view.kind === "both" ? view : existing;
		const operator = view.kind === "operator" ? view : existing;
		const to = view.kind === "both" ? view.to : [...recipientIds(agent), ...recipientIds(operator)];
		this.#view = { ...agent, kind: "both", to };
		this.#setBody(agent.body);
		this.#cache = undefined;
		this.#native = undefined;
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

	#route(): { recipients: { id: string; name: string }[]; group: string } {
		const view = this.#view;
		const group = view.sentToGroup ? lineLabel(view.group) : "";
		const recipients = recipientIds(view)
			.map(id => ({ id, name: lineLabel(id) }))
			.filter(({ name }) => name.length > 0);
		return { recipients, group };
	}

	#openingLabel(): string {
		let label = `${theme.fg("dim", DIRECTION[this.#view.kind])} ${this.#paint(theme.bold(this.#from))}`;
		const { recipients, group } = this.#route();
		const to = recipients.map(({ id, name }) => agentColored(theme, id, theme.bold(name))).join(", ");
		if (to || group) {
			label += ` ${theme.fg("dim", theme.nav.selected)} ${to || theme.bold(`#${group}`)}`;
			if (to && group) label += theme.fg("dim", `${theme.sep.dot}#${group}`);
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
		const head: TspSpan[] = [
			span(`${DIRECTION[this.#view.kind]} `, "muted"),
			...styledSpans(this.#paint(theme.bold(this.#from))),
		];
		const { recipients, group } = this.#route();
		if (recipients.length > 0 || group) head.push(span(` ${theme.nav.selected} `, "muted"));
		for (const [index, { id, name }] of recipients.entries()) {
			if (index > 0) head.push(span(", ", "muted"));
			head.push(...styledSpans(agentColored(theme, id, theme.bold(name))));
		}
		if (group) head.push(span(`${recipients.length > 0 ? theme.sep.dot : ""}#${group}`, "muted"));
		for (const marker of this.#markers()) head.push(span(`${theme.sep.dot}${marker}`, "muted"));
		if (this.#view.timestamp) head.push(span(`${theme.sep.dot}${clockTime(this.#view.timestamp)}`, "dim"));
		this.#native = card(
			{ role: `omp.irc.${this.#view.kind}`, tone: "info", head },
			this.#body ? [md(this.#body)] : [],
		);
		return this.#native;
	}
}

function recipientIds(view: IrcMessageView): readonly string[] {
	return typeof view.to === "string" ? [view.to] : (view.to ?? []);
}
