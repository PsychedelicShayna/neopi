/**
 * Display-only transcript card for one mixture trace event: a collapsible
 * block headed `◆ <mixture> · hop N · <member> (<model>) ← <edge> · $cost · 12s`,
 * collapsed by default and expanded with the tool-output toggle. The body is
 * the hop's output when it is visible; header-only cards (hidden output, the
 * terminal hop whose output is the answer) still carry the run totals.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Disclosure } from "../components/disclosure";
import type { MixtureTraceDetails } from "../overlays/mixture-types";
import { Ellipsis, truncateToWidth } from "../render";
import { replaceTabs, wrapTextWithAnsi } from "../render/render-utils";
import type { Theme } from "../theme";
import type { Component } from "../tui";

const BODY_WIDTH = 110;

function formatCost(usd: number): string {
	return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** The card's one-line header text (no styling). */
export function mixtureTraceTitle(details: MixtureTraceDetails): string {
	switch (details.kind) {
		case "hop":
		case "branch": {
			const parts = [
				details.mixture,
				`hop ${details.hop}`,
				`${details.memberId} (${details.model})${details.edgeInId ? ` ← ${details.edgeInId}` : ""}`,
				formatCost(details.usage.cost.total),
				formatElapsed(details.elapsedMs),
			];
			if (details.status !== "done") parts.push(details.status);
			return parts.join(" · ");
		}
		case "decision":
			return `${details.mixture} · hop ${details.hop} · ${details.decision.kind} (${details.decision.judge})`;
		case "steering":
			return `${details.mixture} · steering → ${details.targetMemberId}`;
		case "limit":
			return `${details.mixture} · ${details.limit} limit ${details.value} · ${details.action}`;
		case "checkpoint":
			return `${details.mixture} · checkpoint (${details.reason})${details.note ? ` · ${details.note}` : ""}`;
		case "run_start":
			return `${details.mixture} · run started`;
		case "run_end":
			return `${details.mixture} · run ended (${details.endReason})`;
	}
}

function bodyText(details: MixtureTraceDetails): string | undefined {
	if (details.kind === "hop" || details.kind === "branch") return details.visible ? details.output : undefined;
	if (details.kind === "steering") return details.text;
	return undefined;
}

class TraceHeader implements Component {
	readonly #details: MixtureTraceDetails;
	readonly #uiTheme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(details: MixtureTraceDetails, uiTheme: Theme) {
		this.#details = details;
		this.#uiTheme = uiTheme;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const uiTheme = this.#uiTheme;
		const glyph = this.#details.kind === "checkpoint" ? "⏸" : "◆";
		const tag = uiTheme.fg("customMessageLabel", uiTheme.bold(glyph));
		const lines = [
			truncateToWidth(
				`${tag} ${uiTheme.fg("dim", replaceTabs(sanitizeText(mixtureTraceTitle(this.#details))))}`,
				width,
				Ellipsis.Unicode,
			),
		];
		this.#cache = { width, lines };
		return lines;
	}
}

class TraceBody implements Component {
	readonly #text: string;
	readonly #uiTheme: Theme;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(text: string, uiTheme: Theme) {
		// Member output is model text: strip escape and control sequences before it reaches the terminal.
		this.#text = replaceTabs(sanitizeText(text));
		this.#uiTheme = uiTheme;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const wrapWidth = Math.max(10, Math.min(BODY_WIDTH, width) - 2);
		const lines: string[] = [];
		for (const paragraph of this.#text.split("\n")) {
			const wrapped = paragraph ? wrapTextWithAnsi(paragraph, wrapWidth) : [""];
			for (const line of wrapped) {
				lines.push(truncateToWidth(`  ${this.#uiTheme.fg("customMessageText", line)}`, width, Ellipsis.Unicode));
			}
		}
		this.#cache = { width, lines };
		return lines;
	}
}

class EmptyBody implements Component {
	invalidate(): void {}
	render(): readonly string[] {
		return [];
	}
}

export function createMixtureTraceCard(
	details: MixtureTraceDetails,
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const text = bodyText(details);
	const disclosure = new Disclosure({
		summary: new TraceHeader(details, uiTheme),
		body: () => (text ? new TraceBody(text, uiTheme) : new EmptyBody()),
		expanded: getExpanded(),
		paddingX: 1,
	});
	// The tool-output toggle owns expansion state; synchronize on every render.
	return {
		render(width: number): readonly string[] {
			disclosure.setExpanded(getExpanded());
			return disclosure.render(width);
		},
		invalidate(): void {
			disclosure.invalidate();
		},
		dispose(): void {
			disclosure.dispose();
		},
		setIgnoreTight(ignore: boolean): void {
			disclosure.setIgnoreTight(ignore);
		},
	};
}
