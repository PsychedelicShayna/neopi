/**
 * Wall-clock calendar parts for temporal buckets.
 *
 * Buckets are keyed by local wall-clock parts in one configured IANA
 * timezone, never by UTC offsets: a DST fall-back hour holds both of its
 * instants in one hour bucket, and a spring-forward hour simply has none.
 */

export interface LocalParts {
	year: number;
	/** 1–12 */
	month: number;
	/** 1–31 */
	day: number;
	/** 0–23 */
	hour: number;
	/** 0–59 */
	minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The configured zone, or the system zone for an empty value. Throws RangeError for an unknown zone. */
export function resolveTimeZone(configured: string | undefined): string {
	const zone = configured?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	formatterFor(zone);
	return zone;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			hourCycle: "h23",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}

export function localParts(iso: string, timeZone: string): LocalParts {
	const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
	for (const part of formatterFor(timeZone).formatToParts(new Date(iso))) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts.year ?? 1970,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		hour: (parts.hour ?? 0) % 24,
		minute: parts.minute ?? 0,
	};
}

export function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** `YYYY-MM-DDTHH:MM` local wall-clock string; sorts chronologically within one zone. */
export function localStamp(parts: LocalParts): string {
	return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday = 0 … Sunday = 6 for a calendar date. */
export function weekdayIndex(year: number, month: number, day: number): number {
	return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/**
 * Month-clamped week: Monday-start calendar weeks intersected with the month.
 * Week 1 runs from the 1st to the first Sunday, so a week never crosses a
 * month boundary.
 */
export function monthWeek(
	year: number,
	month: number,
	day: number,
): { week: number; firstDay: number; lastDay: number } {
	const offset = weekdayIndex(year, month, 1);
	const week = Math.floor((day - 1 + offset) / 7) + 1;
	return {
		week,
		firstDay: Math.max(1, 7 * (week - 1) - offset + 1),
		lastDay: Math.min(daysInMonth(year, month), 7 * week - offset),
	};
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function monthName(month: number): string {
	return MONTH_NAMES[month - 1] ?? String(month);
}

export function dayName(year: number, month: number, day: number): string {
	return DAY_NAMES[weekdayIndex(year, month, day)] ?? "";
}

/**
 * Time bound accepted by recall and index windows: an instant (ISO with time)
 * or a local calendar prefix (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-MM-DDTHH`).
 * Prefix bounds compare against local wall-clock stamps, so `--to 2026-09`
 * includes all of September in the view's zone.
 */
export type TimeBound = { kind: "instant"; ms: number } | { kind: "local"; prefix: string };

const LOCAL_PREFIX_RE = /^\d{4}(-\d{2}(-\d{2}([T ]\d{2}(:\d{2})?)?)?)?$/;

export function parseTimeBound(value: string): TimeBound {
	const trimmed = value.trim();
	if (LOCAL_PREFIX_RE.test(trimmed)) return { kind: "local", prefix: trimmed.replace(" ", "T") };
	const ms = Date.parse(trimmed);
	if (Number.isNaN(ms)) throw new Error(`Invalid time bound: ${value}`);
	return { kind: "instant", ms };
}

/** A span of atoms: first/last instants and their local stamps. */
export interface TimeSpan {
	start: string;
	end: string;
	localStart: string;
	localEnd: string;
}

export function spanAfter(span: TimeSpan, bound: TimeBound): boolean {
	if (bound.kind === "instant") return Date.parse(span.end) >= bound.ms;
	return span.localEnd.slice(0, bound.prefix.length) >= bound.prefix;
}

export function spanBefore(span: TimeSpan, bound: TimeBound): boolean {
	if (bound.kind === "instant") return Date.parse(span.start) <= bound.ms;
	return span.localStart.slice(0, bound.prefix.length) <= bound.prefix;
}

export function spanWithin(span: TimeSpan, from: TimeBound | undefined, to: TimeBound | undefined): boolean {
	return (from === undefined || spanAfter(span, from)) && (to === undefined || spanBefore(span, to));
}
