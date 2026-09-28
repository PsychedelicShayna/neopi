import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { DIAL_NAMES, Fields } from "./validation";
import type { Decision, Dials } from "./wire";

const FIELDS = { effort: "effort", temp: "temp", top_p: "topP", top_k: "topK", min_p: "minP", max_tokens: "maxTokens", budget: "budget", verbosity: "verbosity", tier: "tier" } as const;
const ALIASES: Readonly<Record<string, string>> = { none: "off", min: "minimal", mid: "medium", med: "medium", ultra: "xhigh", "extra-high": "xhigh", extra_high: "xhigh", xh: "xhigh" };
const EFFORTS = ["off", ...THINKING_EFFORTS];
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export type ParsedSlug = ({ virtual: string; provider?: never; model?: never } | { virtual?: never; provider?: string; model: string }) & { dials: Dials; repairs: Decision["repairs"] };

/** Shared by the slug grammar, TOML defaults, and canonical JSON control inputs. */
export function decodeDials(fields: Fields, value: unknown, path: string, syntax: "snake" | "camel" = "camel"): Dials {
	const row = fields.object(value, path, syntax === "snake" ? DIAL_NAMES : Object.values(FIELDS));
	const result: Record<string, unknown> = {};
	for (const name of DIAL_NAMES) {
		const input = syntax === "snake" ? name : FIELDS[name];
		const raw = row[input];
		if (raw === undefined) continue;
		const location = `${path}.${input}`;
		if (name === "effort") {
			const effort = typeof raw === "string" ? Object.hasOwn(ALIASES, raw) ? ALIASES[raw] : raw : raw;
			fields.oneOf(effort, location, EFFORTS);
			result.effort = effort;
		} else if (name === "verbosity") {
			fields.oneOf(raw, location, ["low", "medium", "high"]); result.verbosity = raw;
		} else if (name === "tier") {
			fields.oneOf(raw, location, ["auto", "default", "flex", "priority", "fast"]); result.tier = raw;
		} else {
			const integer = name === "top_k" || name === "max_tokens" || name === "budget";
			const minimum = name === "top_k" || name === "max_tokens" ? 1 : 0;
			const maximum = name === "temp" ? 2 : name === "top_p" || name === "min_p" ? 1 : undefined;
			fields.number(raw, location, { min: minimum, integer, ...(maximum !== undefined ? { max: maximum } : {}), ...(name === "top_p" ? { exclusiveMin: true } : {}) });
			result[FIELDS[name]] = raw;
		}
	}
	return result as Dials;
}

function suffix(raw: string): { dials: Dials; repairs: Decision["repairs"] } | undefined {
	const values: Record<string, unknown> = {};
	const repairs: Decision["repairs"] = [];
	for (const part of raw.split(",")) {
		const equals = part.indexOf("=");
		let name: string;
		let value: string | number;
		if (equals < 0) { name = "effort"; value = part.trim(); }
		else {
			name = part.slice(0, equals).trim();
			const text = part.slice(equals + 1).trim();
			if (!DIAL_NAMES.includes(name as typeof DIAL_NAMES[number])) return undefined;
			if (name === "effort" || name === "verbosity" || name === "tier") value = text;
			else { if (!DECIMAL.test(text)) return undefined; value = Number(text); }
		}
		if (Object.hasOwn(values, name)) repairs.push({ id: "R-DIAL-DUP", detail: `Last ${name} control wins` });
		values[name] = value;
	}
	const fields = new Fields();
	const dials = decodeDials(fields, values, "dials", "snake");
	return fields.issues.length ? undefined : { dials, repairs };
}

export function parseSlug(raw: string, virtualIds: ReadonlySet<string>): ParsedSlug {
	let rest = raw.trim();
	let parsed: { dials: Dials; repairs: Decision["repairs"] } = { dials: {}, repairs: [] };
	if (virtualIds.has(rest)) return { virtual: rest, ...parsed };
	for (let colon = rest.lastIndexOf(":"); colon >= 0; colon = rest.lastIndexOf(":", colon - 1)) {
		const candidate = suffix(rest.slice(colon + 1));
		if (candidate) { parsed = candidate; rest = rest.slice(0, colon); break; }
		if (colon === 0) break;
	}
	if (virtualIds.has(rest)) return { virtual: rest, ...parsed };
	const slash = rest.indexOf("/");
	return slash < 0 ? { model: rest, ...parsed } : { provider: rest.slice(0, slash), model: rest.slice(slash + 1), ...parsed };
}

export function formatSlug(slug: ParsedSlug): string {
	const id = slug.virtual ?? (slug.provider === undefined ? slug.model : `${slug.provider}/${slug.model}`);
	const entries = DIAL_NAMES.flatMap(name => slug.dials[FIELDS[name]] === undefined ? [] : [`${name}=${slug.dials[FIELDS[name]]}`]);
	if (!entries.length) return id;
	if (entries.length === 1 && slug.dials.effort !== undefined) return `${id}:${slug.dials.effort}`;
	return `${id}:${entries.join(",")}`;
}
