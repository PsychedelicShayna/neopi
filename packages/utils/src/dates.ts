/** Behavior-compatible reimplementation of date-fns's used surface. */

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;
const SHORT_MONTHS: readonly string[] = MONTHS.map(month => month.slice(0, 3));
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const TOKENS = [
	"MMMM",
	"yyyy",
	"EEEE",
	"MMM",
	"EEE",
	"yy",
	"MM",
	"dd",
	"HH",
	"hh",
	"mm",
	"ss",
	"M",
	"d",
	"H",
	"h",
	"m",
	"s",
	"a",
] as const;

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

function tokenValue(date: Date, token: (typeof TOKENS)[number], shortMonths: readonly string[]): string {
	const month = date.getMonth();
	const weekday = date.getDay();
	const hours = date.getHours();
	const hours12 = hours % 12 || 12;

	switch (token) {
		case "yyyy":
			return pad(date.getFullYear(), 4);
		case "yy":
			return pad(date.getFullYear() % 100);
		case "MMMM":
			return MONTHS[month];
		case "MMM":
			return shortMonths[month];
		case "MM":
			return pad(month + 1);
		case "M":
			return String(month + 1);
		case "dd":
			return pad(date.getDate());
		case "d":
			return String(date.getDate());
		case "EEEE":
			return WEEKDAYS[weekday];
		case "EEE":
			return WEEKDAYS[weekday].slice(0, 3);
		case "HH":
			return pad(hours);
		case "H":
			return String(hours);
		case "hh":
			return pad(hours12);
		case "h":
			return String(hours12);
		case "mm":
			return pad(date.getMinutes());
		case "m":
			return String(date.getMinutes());
		case "ss":
			return pad(date.getSeconds());
		case "s":
			return String(date.getSeconds());
		case "a":
			return hours < 12 ? "AM" : "PM";
	}
}

function asDate(value: Date | number): Date {
	const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(date.getTime())) throw new RangeError("Invalid time value");
	return date;
}

/** Format a date with the supported date-fns v4 tokens and quoted literals. */
export function format(value: Date | number, pattern: string, shortMonths = SHORT_MONTHS): string {
	const date = asDate(value);
	let result = "";

	for (let index = 0; index < pattern.length;) {
		if (pattern[index] === "'") {
			if (pattern[index + 1] === "'") {
				result += "'";
				index += 2;
				continue;
			}

			index++;
			while (index < pattern.length) {
				if (pattern[index] !== "'") {
					result += pattern[index++];
					continue;
				}
				if (pattern[index + 1] === "'") {
					result += "'";
					index += 2;
					continue;
				}
				index++;
				break;
			}
			continue;
		}

		const rest = pattern.slice(index);
		const token = TOKENS.find(candidate => rest.startsWith(candidate));
		if (token) {
			result += tokenValue(date, token, shortMonths);
			index += token.length;
			continue;
		}

		const character = pattern[index++];
		if (/[A-Za-z]/.test(character)) {
			throw new RangeError(`Format string contains an unescaped latin alphabet character \`${character}\``);
		}
		result += character;
	}

	return result;
}

type DistanceUnit = "minute" | "hour" | "day" | "month" | "year";
type DistanceQualifier = "exact" | "less" | "about" | "over" | "almost";
type Distance = [amount: number, unit: DistanceUnit, qualifier: DistanceQualifier];

const DISTANCE_COPY = {
	en: {
		minute: ["minute", "minutes"],
		hour: ["hour", "hours"],
		day: ["day", "days"],
		month: ["month", "months"],
		year: ["year", "years"],
		exact: "{}",
		less: "less than a minute",
		about: "about {}",
		over: "over {}",
		almost: "almost {}",
		past: "{} ago",
		future: "in {}",
	},
	es: {
		minute: ["minuto", "minutos"],
		hour: ["hora", "horas"],
		day: ["día", "días"],
		month: ["mes", "meses"],
		year: ["año", "años"],
		exact: "{}",
		less: "menos de un minuto",
		about: "aproximadamente {}",
		over: "más de {}",
		almost: "casi {}",
		past: "hace {}",
		future: "dentro de {}",
	},
} as const;

function completedMonths(earlier: Date, later: Date): number {
	let months = (later.getFullYear() - earlier.getFullYear()) * 12 + later.getMonth() - earlier.getMonth();
	if (months === 0) return 0;

	const candidate = new Date(earlier);
	candidate.setDate(1);
	candidate.setFullYear(earlier.getFullYear(), earlier.getMonth() + months, 1);
	const lastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
	candidate.setDate(Math.min(earlier.getDate(), lastDay));
	if (candidate.getTime() > later.getTime()) months--;
	return months;
}

function distanceBetween(earlier: Date, later: Date): Distance {
	const seconds = (later.getTime() - earlier.getTime()) / 1_000;
	const timezoneOffset = (later.getTimezoneOffset() - earlier.getTimezoneOffset()) * 60;
	const minutes = Math.round((seconds - timezoneOffset) / 60);

	if (minutes < 2) return [1, "minute", minutes === 0 ? "less" : "exact"];
	if (minutes < 45) return [minutes, "minute", "exact"];
	if (minutes < 90) return [1, "hour", "about"];
	if (minutes < 1_440) return [Math.round(minutes / 60), "hour", "about"];
	if (minutes < 2_520) return [1, "day", "exact"];
	if (minutes < 43_200) return [Math.round(minutes / 1_440), "day", "exact"];
	if (minutes < 86_400) return [Math.round(minutes / 43_200), "month", "about"];

	const months = completedMonths(earlier, later);
	if (months < 12) return [Math.round(minutes / 43_200), "month", "exact"];

	const years = Math.trunc(months / 12);
	const remainingMonths = months % 12;
	if (remainingMonths < 3) return [years, "year", "about"];
	if (remainingMonths < 9) return [years, "year", "over"];
	return [years + 1, "year", "almost"];
}

/** Describe the distance from a date to now using date-fns's thresholds. */
export function formatDistanceToNow(
	value: Date | number,
	options: { addSuffix?: boolean; locale?: keyof typeof DISTANCE_COPY } = {},
): string {
	const date = asDate(value);
	const now = new Date(Date.now());
	const isFuture = date.getTime() > now.getTime();
	const [amount, unit, qualifier] = isFuture ? distanceBetween(now, date) : distanceBetween(date, now);
	const copy = DISTANCE_COPY[options.locale ?? "en"];
	const words = copy[qualifier].replace("{}", `${amount} ${copy[unit][amount === 1 ? 0 : 1]}`);
	return options.addSuffix ? copy[isFuture ? "future" : "past"].replace("{}", words) : words;
}
