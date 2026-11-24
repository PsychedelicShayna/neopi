import { type Component } from "../tui";
import { Box } from "../components/box";
import { Disclosure } from "../components/disclosure";
import { visibleWidth } from "../utils";
import type { AdvisorMessageDetails, AdvisorNote, AdvisorSeverity } from "./messages";
import { chatTranscriptDisplayPreferences } from "./display-preferences";
import { formatBadge, replaceTabs, type ToolUIColor, wrapTextWithAnsi } from "../render/render-utils";
import { Ellipsis, truncateToWidth } from "../render";
import type { Theme } from "../theme";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { card, node, span, text } from "../native/describe";
import { type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { plainText } from "../native/spans";
import { Memo } from "../native/memo";

const COLLAPSED_NOTES = 3;

function wrapVarying(text: string, w1: number, w2: number): string[] {
	if (text.length === 0) return [];
	const firstWrap = wrapTextWithAnsi(text, w1);
	if (firstWrap.length <= 1) {
		return firstWrap;
	}
	const firstLine = firstWrap[0];
	const idx = text.indexOf(firstLine);
	if (idx === -1) {
		return wrapTextWithAnsi(text, w2);
	}
	const remainder = text.slice(idx + firstLine.length).trimStart();
	const restWrap = wrapTextWithAnsi(remainder, w2);
	return [firstLine, ...restWrap];
}

function severityColor(severity: AdvisorSeverity | undefined): ToolUIColor {
	switch (severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

/** Always-visible header: `<severity icon> Advisor <n> notes [· <k> blockers]`, the tag in the card's severity colour. */
class AdvisorHeader implements Component {
	readonly #meta: readonly string[];
	readonly #severity: AdvisorSeverity | undefined;
	readonly #uiTheme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(meta: readonly string[], severity: AdvisorSeverity | undefined, uiTheme: Theme) {
		this.#meta = meta;
		this.#severity = severity;
		this.#uiTheme = uiTheme;
	}

	releaseRenderCaches(): void {
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const uiTheme = this.#uiTheme;
		const icon =
			this.#severity === "blocker"
				? uiTheme.status.error
				: this.#severity === "concern"
					? uiTheme.status.warning
					: uiTheme.status.info;
		const tag = uiTheme.fg(severityColor(this.#severity), uiTheme.bold(`${icon} Advisor`));
		const lines = [
			truncateToWidth(`${tag} ${uiTheme.fg("dim", this.#meta.join(uiTheme.sep.dot))}`, width, Ellipsis.Unicode),
		];
		this.#cache = { width, lines };
		return lines;
	}
}

/** One branch of advisor notes: the entries plus an optional hidden-note count. */
class AdvisorNotes implements Component {
	readonly #entries: readonly AdvisorNote[];
	readonly #hidden: number;
	readonly #uiTheme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(entries: readonly AdvisorNote[], hidden: number, uiTheme: Theme) {
		this.#entries = entries;
		this.#hidden = hidden;
		this.#uiTheme = uiTheme;
	}

	releaseRenderCaches(): void {
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines: string[] = [];
		for (const entry of this.#entries) lines.push(...renderAdvisorNote(entry, width, this.#uiTheme));
		if (this.#hidden > 0) {
			const uiTheme = this.#uiTheme;
			const rail = uiTheme.fg("dim", uiTheme.symbol("advisor.rail"));
			const hidden = this.#hidden;
			lines.push(`${rail} ${uiTheme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`);
		}
		const rendered = lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		this.#cache = { width, lines: rendered };
		return rendered;
	}
}

/** The advisor a note came from; undefined for the implicit single ("default") advisor, which goes unlabeled. */
function sourceOf(entry: AdvisorNote): string | undefined {
	return entry.advisor && entry.advisor !== "default" ? entry.advisor : undefined;
}

/** Wrapped, truncated rail rows for a single note; shared by both branches. */
function renderAdvisorNote(entry: AdvisorNote, width: number, uiTheme: Theme): string[] {
	const badge = entry.severity ? `${formatBadge(entry.severity, severityColor(entry.severity), uiTheme)} ` : "";
	const source = sourceOf(entry);
	const who = source ? `${uiTheme.fg("dim", `[${replaceTabs(source)}]`)} ` : "";
	const age = entry.turnsAgo !== undefined ? `${uiTheme.fg("dim", `T-${entry.turnsAgo}`)} ` : "";
	const railGlyph = uiTheme.symbol("advisor.rail");
	const rail = uiTheme.fg(severityColor(entry.severity), railGlyph);
	const quoteWidth = visibleWidth(`${railGlyph} `);
	const badgeWidth = visibleWidth(badge);
	const ageWidth = visibleWidth(age);
	const whoWidth = visibleWidth(who);
	const w1 = Math.max(10, width - quoteWidth - badgeWidth - ageWidth - whoWidth);
	const w2 = Math.max(10, width - quoteWidth);

	const paragraphs = entry.note.split("\n").filter(p => p.trim());
	const bodyLines: string[] = [];
	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i];
		if (i === 0) {
			bodyLines.push(...wrapVarying(p, w1, w2));
		} else {
			bodyLines.push(...wrapTextWithAnsi(p, w2));
		}
	}

	return bodyLines.map(
		(line, index) =>
			`${rail} ${index === 0 ? `${badge}${age}${who}` : ""}${uiTheme.fg("customMessageText", replaceTabs(line))}`,
	);
}

/** A note's rank in the native callout: its severity, `note` when it has none. */
type AdvisorRank = AdvisorSeverity | "note";

/** Ranks worst first: the callout wears the worst rank among its notes. */
const RANKS: readonly AdvisorRank[] = ["blocker", "concern", "nit", "note"];

/** Each rank's native look, GitHub-alert style: card/icon tone, Tern icon name, label and its span style. */
const RANK_LOOK: Record<AdvisorRank, { tone: TspTone; icon: string; label: string; style: string }> = {
	blocker: { tone: "error", icon: "octagon-alert", label: "Blocker", style: "error strong" },
	concern: { tone: "warning", icon: "warn", label: "Concern", style: "warning strong" },
	nit: { tone: "neutral", icon: "lightbulb", label: "Nit", style: "strong" },
	note: { tone: "neutral", icon: "info", label: "Note", style: "strong" },
};

function rankOf(entry: AdvisorNote): AdvisorRank {
	return entry.severity ?? "note";
}

/** The callout's title: one note's rank (`Concern`), else a tally worst first (`1 blocker · 2 concerns`). */
function tallySpans(notes: readonly AdvisorNote[]): TspSpan[] {
	if (notes.length === 1) {
		const { label, style } = RANK_LOOK[rankOf(notes[0]!)];
		return [span(label, style)];
	}
	const spans: TspSpan[] = [];
	for (const rank of RANKS) {
		const count = notes.filter(entry => rankOf(entry) === rank).length;
		if (count === 0) continue;
		if (spans.length > 0) spans.push(span(" · ", "dim"));
		spans.push(span(`${count} ${rank}${count === 1 ? "" : "s"}`, RANK_LOOK[rank].style));
	}
	return spans;
}

/** Native spans for one note: its advisor when the callout mixes several, then the text. */
function noteSpans(entry: AdvisorNote, attribute: boolean): TspSpan[] {
	const who = attribute ? sourceOf(entry) : undefined;
	const body = span(plainText(entry.note));
	return who ? [span(`${who} · `, "dim"), body] : [body];
}

/** The advisor card: shared by the controlled expansion getter and native toggles. */
export interface AdvisorMessageCard extends Component {
	/** Transcript-wide expansion; clears a toggle made in the terminal. */
	setExpanded(expanded: boolean): void;
	handleNativeEvent(event: NativeUiEvent): void;
}

/**
 * Display-only transcript card for advisor notes injected into the primary
 * session: the Chronicler's bubble (rounded outline, bold title, the notes
 * inside at the bubble's full width), with the outline and title in the colour
 * of the worst note: blocker red, concern yellow, nit or unrated grey. Each note
 * keeps its own severity badge and rail, so a mixed card still tells them apart.
 * Natively it is a callout tinted by its worst note: that severity's icon and
 * the tally head it, the advisor's name ends the head, and with several notes
 * each leads with its own severity icon.
 *
 * `getExpanded` owns expansion; a native toggle overrides it for this card
 * until the next transcript-wide change.
 */
export function createAdvisorMessageCard(
	details: AdvisorMessageDetails | undefined,
	getExpanded: () => boolean,
	uiTheme: Theme,
): AdvisorMessageCard {
	const notes = details?.notes ?? [];
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const meta: string[] = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers > 0) meta.push(uiTheme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`));
	let override: boolean | undefined;
	let lastGlobal = getExpanded();
	const expanded = (): boolean => {
		const global = getExpanded();
		if (global !== lastGlobal) {
			lastGlobal = global;
			override = undefined;
		}
		return override ?? global;
	};
	const nativeMemo = new Memo();
	const describeCard = (isExpanded: boolean): NativeNode => {
		const look = RANK_LOOK[RANKS.find(rank => notes.some(entry => rankOf(entry) === rank)) ?? "note"];
		const sources = new Set(notes.map(sourceOf));
		const [sole] = sources;
		const head = node(
			"row",
			{ gap: "sm", align: "center", role: "omp.advisor.head" },
			[
				node("icon", { name: look.icon, tone: look.tone }),
				text(tallySpans(notes), { grow: 1 }),
				text([span(sources.size === 1 && sole ? sole : "Advisor", "dim")], { role: "omp.advisor.source" }),
			],
			"head",
		);
		const attribute = sources.size > 1;
		const body = notes.map((entry, index) => {
			const spans = noteSpans(entry, attribute);
			if (notes.length === 1) return text(spans, { wrap: "word", role: "omp.advisor.note", key: `n${index}` });
			const { tone, icon, label } = RANK_LOOK[rankOf(entry)];
			return node(
				"row",
				{ gap: "sm", align: "start", role: "omp.advisor.note", tone },
				[node("icon", { name: icon, tone, aria: label }), text(spans, { wrap: "word", grow: 1, shrink: 1 })],
				`n${index}`,
			);
		});
		return card(
			{
				role: "omp.advisor",
				tone: look.tone,
				collapsible: notes.length > COLLAPSED_NOTES,
				collapsed: notes.length > COLLAPSED_NOTES ? !isExpanded : undefined,
				preview: notes.length > COLLAPSED_NOTES ? "auto" : undefined,
			},
			[head, ...body],
		);
	};

	const worst: AdvisorSeverity | undefined =
		blockers > 0 ? "blocker" : notes.some(note => note.severity === "concern") ? "concern" : undefined;
	const shown = notes.slice(0, COLLAPSED_NOTES);
	const disclosure = new Disclosure({
		summary: new AdvisorHeader(meta, worst, uiTheme),
		collapsedBody: () => new AdvisorNotes(shown, notes.length - shown.length, uiTheme),
		body: () => new AdvisorNotes(notes, 0, uiTheme),
		expanded: getExpanded(),
		maxCollapsedRows: chatTranscriptDisplayPreferences.advisorCollapsedLines || undefined,
	});
	const bubble = new Box(1, 0, undefined, {
		chars: uiTheme.boxRound,
		color: value => uiTheme.fg(severityColor(worst), value),
	});
	bubble.setIgnoreTight(true);
	bubble.addChild(disclosure);
	// The tool-output toggle owns expansion state; synchronize the controlled
	// disclosure from the callback on every render.
	return {
		render(width: number): readonly string[] {
			disclosure.setExpanded(expanded());
			return bubble.render(width);
		},
		describe(): NativeNode {
			const isExpanded = expanded();
			return nativeMemo.get([isExpanded], () => describeCard(isExpanded));
		},
		setExpanded(value: boolean): void {
			lastGlobal = value;
			override = undefined;
		},
		handleNativeEvent(event: NativeUiEvent): void {
			const toggled = rootToggleExpanded(event);
			if (toggled !== undefined) override = toggled;
		},
		invalidate(): void {
			bubble.invalidate();
		},
		releaseRenderCaches(): void {
			bubble.releaseRenderCaches();
		},
		dispose(): void {
			disclosure.dispose();
		},
	};
}
