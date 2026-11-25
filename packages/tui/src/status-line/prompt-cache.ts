/**
 * Prompt-cache text beyond the `cache` marker: the two lines of its hover card
 * (Tern) and the rows of `/session`'s Prompt Cache section.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { sanitizeStatusText } from "../chrome/shared";
import type { PromptCacheColdReason, PromptCacheStatus, PromptCacheWarming } from "./host";

/** One `label: value` line of the prompt-cache details. */
export interface PromptCacheDetailRow {
	label: string;
	value: string;
	tone?: "warning";
}

function sameDay(at: number, nowMs: number): boolean {
	return new Date(at).toDateString() === new Date(nowMs).toDateString();
}

/** `4:53 PM` on `nowMs`'s local day; `Oct 17, 5:12 PM` on any other, which a bare clock time would misdate. */
function when(at: number, nowMs: number): string {
	return sameDay(at, nowMs)
		? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
		: new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** ` (in 41 min)` / ` (3 h ago)` / ` (12 days ago)`. */
function relative(at: number, nowMs: number): string {
	const minutes = Math.round(Math.abs(at - nowMs) / 60_000);
	if (minutes === 0)
		return at >= nowMs ? t("status.cache.relative.under_minute") : t("status.cache.relative.just_now");
	const span =
		minutes < 60
			? `${minutes} min`
			: minutes < 48 * 60
				? `${Math.round(minutes / 60)} h`
				: t("status.cache.days", { count: Math.round(minutes / (24 * 60)) });
	return at >= nowMs
		? t("status.cache.relative.future", { time: span })
		: t("status.cache.relative.past", { time: span });
}

/**
 * Why the next message re-sends the prefix, as one phrase. With `nowMs` an expiry says when; the hover card
 * omits it, since the terminal shows the card later without repainting it.
 */
function coldReasonText(reason: PromptCacheColdReason, nowMs?: number): string {
	switch (reason.kind) {
		case "expired":
			if (nowMs === undefined) return t("status.cache.expired");
			return t(sameDay(reason.at, nowMs) ? "status.cache.expired_at" : "status.cache.expired_on", {
				time: when(reason.at, nowMs),
				relative: relative(reason.at, nowMs),
			});
		case "refresh-missed":
			return t("status.cache.refresh_missed");
		case "model":
			return t("status.cache.model_changed", {
				from: sanitizeStatusText(reason.from),
				to: sanitizeStatusText(reason.to),
			});
		case "thinking":
			return t("status.cache.thinking_changed", {
				from: sanitizeStatusText(reason.from),
				to: sanitizeStatusText(reason.to),
			});
		case "tools":
			return t("status.cache.tools_changed");
		case "system-prompt":
			return t("status.cache.prompt_changed");
		case "retention":
			return t("status.cache.retention_changed");
		case "compaction":
			return t("status.cache.compacted");
	}
}

function warmingText(warming: PromptCacheWarming, nowMs: number): string {
	switch (warming.state) {
		case "scheduled": {
			const next =
				warming.nextWarmAt === undefined
					? t("status.cache.refresh_scheduled")
					: t("status.cache.next_refresh", { time: when(warming.nextWarmAt, nowMs) });
			return warming.stopsAt === undefined
				? next
				: t("status.cache.refresh_until", { next, time: when(warming.stopsAt, nowMs) });
		}
		case "refreshing":
			return t("status.cache.refreshing");
		case "inactive": {
			const reason = warming.reason === undefined ? "" : sanitizeStatusText(warming.reason);
			return reason ? t("status.cache.off_reason", { reason }) : t("status.cache.off");
		}
	}
}

/**
 * What the next message re-sends uncached. A lapsed entry, a missed refresh, another
 * model or another tool set (the first cached block) leaves nothing to read. Any
 * other change keeps the cached blocks ahead of it (tools, then the system prompt),
 * whose share omp cannot see, so the whole prompt is only the most it re-sends.
 */
function resendText(status: PromptCacheStatus): string {
	const tokens = `~${formatNumber(status.nextTokens)}`;
	switch (status.reason?.kind) {
		case "expired":
		case "refresh-missed":
		case "model":
		case "tools":
			return t("status.cache.resends", { tokens });
		default:
			return t("status.cache.resends_up_to", { tokens });
	}
}

/**
 * The hover card's two lines: whether the next message reads the cache (until when, or why not), then what it
 * sends. The terminal shows the card later without repainting it, so it names no time relative to now.
 */
export function promptCacheBrief(status: PromptCacheStatus, nowMs: number): readonly [string, string] {
	if (status.state === "cold") {
		const why = status.reason ? ` — ${coldReasonText(status.reason)}` : "";
		return [
			t("status.cache.cold_header", { why }),
			t("status.cache.next_message_resend", { resend: resendText(status) }),
		];
	}
	const cached = status.inferred ? t("status.cache.likely_cached") : t("status.cache.cached");
	const until =
		status.ttlMs === undefined
			? t("status.cache.no_expiry_suffix")
			: t("status.cache.until", { time: when(status.touchedAt + status.ttlMs, nowMs) });
	const reads = formatNumber(Math.min(status.cachedTokens, status.nextTokens));
	return [`${cached}${until}`, t("status.cache.next_read", { reads })];
}

/** The `/session` rows, in display order; times say how long ago or ahead of `nowMs` they are. */
export function promptCacheDetails(status: PromptCacheStatus, nowMs: number): PromptCacheDetailRow[] {
	const tier: PromptCacheDetailRow = {
		label: t("status.cache.tier"),
		value: status.ttlMs === undefined ? t("status.cache.no_expiry") : formatDuration(status.ttlMs),
	};
	const warming: PromptCacheDetailRow[] = status.warming
		? [{ label: t("status.cache.warming"), value: warmingText(status.warming, nowMs) }]
		: [];
	if (status.state === "cold") {
		return [
			{ label: t("status.cache.state"), value: t("status.cache.not_cached"), tone: "warning" },
			...(status.reason
				? [
						{
							label: t("status.cache.why_not_cached"),
							value: coldReasonText(status.reason, nowMs),
							tone: "warning" as const,
						},
					]
				: []),
			tier,
			...warming,
			{
				label: t("status.cache.next_message"),
				value: t("status.cache.resend_uncached", { resend: resendText(status) }),
			},
		];
	}
	const expiresAt = status.ttlMs === undefined ? undefined : status.touchedAt + status.ttlMs;
	const reads = Math.min(status.cachedTokens, status.nextTokens);
	return [
		{
			label: t("status.cache.state"),
			value: status.inferred ? t("status.cache.likely_cached") : t("status.cache.cached"),
		},
		{
			label: t("status.cache.expires"),
			value:
				expiresAt === undefined
					? t("status.cache.never")
					: `${when(expiresAt, nowMs)}${relative(expiresAt, nowMs)}`,
		},
		tier,
		...warming,
		{
			label: t("status.cache.next_message"),
			value: t("status.cache.read_send", {
				reads: formatNumber(reads),
				newTokens: formatNumber(status.nextTokens - reads),
			}),
		},
	];
}
