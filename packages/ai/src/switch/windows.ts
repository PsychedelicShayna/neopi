import { SwitchError } from "./error";
import type { Budget, GrantExpiry, Unit, WindowInstanceView } from "./wire";

const MINUTE = 60_000;
const DURATION_UNITS: Record<string, number> = {
	m: MINUTE,
	h: 60 * MINUTE,
	d: 24 * 60 * MINUTE,
	w: 7 * 24 * 60 * MINUTE,
};
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

export function parseDuration(value: string): number | undefined {
	const match = /^([1-9]\d*)(m|h|d|w)$/.exec(value);
	if (!match) return undefined;
	const duration = Number(match[1]) * DURATION_UNITS[match[2]];
	return Number.isSafeInteger(duration) ? duration : undefined;
}

export function roundOperatorAmount(value: number, unit: Unit): number {
	const scale = unit === "requests" || unit === "tokens" ? 1 : 10;
	return Math.floor(value * scale + 0.5) / scale;
}

function zonedParts(
	at: number,
	timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	let formatter = zonedFormatters.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		zonedFormatters.set(timezone, formatter);
	}
	const values: Record<string, number> = {};
	for (const part of formatter.formatToParts(at)) if (part.type !== "literal") values[part.type] = Number(part.value);
	return {
		year: values.year,
		month: values.month,
		day: values.day,
		hour: values.hour,
		minute: values.minute,
		second: values.second,
	};
}

function zonedMidnight(year: number, month: number, day: number, timezone: string): number {
	const normalized = new Date(Date.UTC(year, month - 1, day));
	const target = normalized.getTime();
	let candidate = target;
	let previous = Number.NaN;
	for (let pass = 0; pass < 6; pass++) {
		const local = zonedParts(candidate, timezone);
		const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
		const next = candidate + target - represented;
		if (next === candidate) return candidate;
		// A skipped local midnight starts at the first valid instant of that day.
		if (next === previous) return Math.max(candidate, next);
		previous = candidate;
		candidate = next;
	}
	throw new SwitchError(422, "validation", "Could not resolve calendar boundary in the configured timezone");
}

export function calendarWindow(now: number, period: "day" | "week" | "month", timezone: string): WindowInstanceView {
	const local = zonedParts(now, timezone);
	let day = local.day;
	if (period === "week") day -= (new Date(Date.UTC(local.year, local.month - 1, day)).getUTCDay() + 6) % 7;
	if (period === "month") day = 1;
	const startedAt = zonedMidnight(local.year, local.month, day, timezone);
	const resetsAt = zonedMidnight(
		local.year,
		local.month + (period === "month" ? 1 : 0),
		day + (period === "day" ? 1 : period === "week" ? 7 : 0),
		timezone,
	);
	return { id: `calendar:${timezone}:${period}:${startedAt}`, startedAt, resetsAt, endSource: "authoritative" };
}

export function rollingStart(now: number, ms: number): number {
	return Math.floor((now - ms) / MINUTE) * MINUTE;
}

export function resolveExpiry(
	until: string,
	now: number,
	instance: WindowInstanceView | undefined,
	budget: Budget,
): { canonical: string; expiry: GrantExpiry } {
	if (until === "window") {
		if (budget.window.kind === "rolling" || !instance)
			throw new SwitchError(
				422,
				"no_window_instance",
				"This Budget has no current window instance; choose a duration or instant",
			);
		return {
			canonical: "window",
			expiry: {
				kind: "instance",
				instanceId: instance.id,
				...(instance.endSource === "authoritative" && instance.resetsAt !== undefined
					? { expiresAt: instance.resetsAt }
					: {}),
			},
		};
	}
	const duration = parseDuration(until);
	const expiresAt = duration === undefined ? Date.parse(until) : now + duration;
	if (duration === undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(until)) {
		throw new SwitchError(
			422,
			"validation",
			"Until must be window, a positive m/h/d/w duration, or an ISO-8601 instant",
		);
	}
	if (!Number.isFinite(expiresAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
		throw new SwitchError(422, "validation", "Expiry must be a future instant");
	return { canonical: new Date(expiresAt).toISOString(), expiry: { kind: "instant", expiresAt } };
}

export function expiryDue(expiry: GrantExpiry, now: number, instance?: WindowInstanceView): boolean {
	if (expiry.expiresAt !== undefined && now >= expiry.expiresAt) return true;
	return expiry.kind === "instance" && instance !== undefined && expiry.instanceId !== instance.id;
}

export function gateLimit(gate: { ceiling?: number; reserve?: number }): number {
	return Math.min(gate.ceiling ?? 100, 100 - (gate.reserve ?? 0));
}

export function meterKey(plan: string, meter: string): string {
	return JSON.stringify([plan, meter]);
}

export function budgetKey(key: string, budget: string): string {
	return JSON.stringify([key, budget]);
}
