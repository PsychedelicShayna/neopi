/**
 * Pure planning of the derived temporal hierarchy.
 *
 * root → year → month → month-clamped week → day → hour → [minute spans] → [minute pages]
 *
 * Only non-empty buckets exist. A terminal bucket must fit both the atom
 * budget and the per-hop token ceiling; oversized hours split at minute
 * midpoints, and an indivisible minute is paginated. Every atom appears in
 * exactly one terminal node — nothing is dropped to fit a budget. Nodes with
 * more children than one hop can route are grouped into bounded fan-out groups.
 */
import * as path from "node:path";
import {
	dayName,
	type LocalParts,
	localParts,
	localStamp,
	monthName,
	monthWeek,
	pad2,
	type TimeSpan,
} from "./calendar";
import type { ChronicleAtom } from "./corpus";

export type NodeLevel = "root" | "year" | "month" | "week" | "day" | "hour" | "span" | "page" | "group";

/** Levels a recall `resolution` may stop at, coarse to fine. */
export const RESOLUTION_LEVELS = ["year", "month", "week", "day", "hour", "atom"] as const;
export type Resolution = (typeof RESOLUTION_LEVELS)[number];

export interface IndexConfig {
	timeZone: string;
	summaryTokens: number;
	hopTokens: number;
	terminalAtoms: number;
	leadTokens: number;
	shortNames: boolean;
}

/** Floor for one routing entry (key, label, period, count, description). */
export const MIN_ROUTE_TOKENS = 48;
const TITLE_ROUTE_CHARS = 160;
const MAX_SLUG = 60;

/** One atom as a terminal bucket enumerates it: bounded routing text plus its full locator. */
export interface AtomEntry {
	id: string;
	/** Derived stub filename inside the terminal node directory. */
	stub: string;
	title: string;
	kind: string;
	eventTime: string;
	capturedAt: string;
	localTime: string;
	project: string;
	sessionId: string;
	topics: string[];
	lead: string;
	/** Characters of canonical body text not shown in `lead`. */
	leadRemainder: number;
	bodyChars: number;
	beatFile: string;
	chroniclerRoot: string;
	batchId: string;
	transcriptPath: string;
	sources: string[];
	fingerprint: string;
	/** Bounded enumeration text: never omits the id or stub locator. */
	route: string;
}

export interface PlanNode {
	key: string;
	segment: string;
	level: NodeLevel;
	label: string;
	span: TimeSpan;
	atomCount: number;
	projects: string[];
	sessions: string[];
	children: PlanNode[];
	/** Terminal nodes only. */
	entries: AtomEntry[];
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function clipText(text: string, maxChars: number): { text: string; remainder: number } {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= maxChars) return { text: clean, remainder: 0 };
	const cut = clean.slice(0, Math.max(0, maxChars));
	const boundary = cut.lastIndexOf(" ");
	const kept = (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).trimEnd();
	return { text: kept, remainder: clean.length - kept.length };
}

export function overviewTokens(config: IndexConfig): number {
	return Math.max(40, Math.min(Math.floor(config.summaryTokens * 0.3), Math.floor(config.hopTokens / 3)));
}

export function maxFanout(config: IndexConfig): number {
	return Math.max(2, Math.floor((config.hopTokens - overviewTokens(config)) / MIN_ROUTE_TOKENS));
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "atom";
}

function compactUtc(iso: string): string {
	return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** `<UTC time>-<slug>-<id tail>.md`; the id tail is the random end of the atom id. */
export function stubName(atom: Pick<ChronicleAtom, "id" | "title" | "eventTime">, shortNames: boolean): string {
	const tail = atom.id.replace(/[^0-9A-Za-z]/g, "").slice(-12) || "atom";
	return shortNames
		? `${compactUtc(atom.eventTime)}-${tail}.md`
		: `${compactUtc(atom.eventTime)}-${slugify(atom.title)}-${tail}.md`;
}

function leadOf(body: string, maxChars: number): { lead: string; remainder: number } {
	const paragraphs = body
		.split(/\n\s*\n/)
		.map(paragraph => paragraph.trim())
		.filter(paragraph => paragraph.length > 0 && !paragraph.startsWith("#"));
	const clipped = clipText(paragraphs.join(" "), maxChars);
	return { lead: clipped.text, remainder: clipped.remainder };
}

export function atomEntry(atom: ChronicleAtom, parts: LocalParts, config: IndexConfig): AtomEntry {
	const stub = stubName(atom, config.shortNames);
	const title = clipText(atom.title, TITLE_ROUTE_CHARS);
	const header = `- \`${atom.id}\` ${pad2(parts.hour)}:${pad2(parts.minute)} ${atom.kind} — ${title.text}${
		title.remainder > 0 ? "…" : ""
	} (${path.basename(atom.project) || atom.project || "?"}, session ${atom.sessionId.slice(0, 8)}) [${stub}]`;
	const leadBudget = Math.max(80, Math.min(config.leadTokens * 4, (config.hopTokens - 8) * 4 - header.length));
	const { lead, remainder } = leadOf(atom.body, leadBudget);
	const route = `${header}\n  ${lead}${remainder > 0 ? ` … [+${remainder} chars in canonical atom]` : ""}`;
	return {
		id: atom.id,
		stub,
		title: atom.title,
		kind: atom.kind,
		eventTime: atom.eventTime,
		capturedAt: atom.capturedAt,
		localTime: localStamp(parts),
		project: atom.project,
		sessionId: atom.sessionId,
		topics: [...atom.topics],
		lead,
		leadRemainder: remainder,
		bodyChars: atom.body.length,
		beatFile: atom.beatFile,
		chroniclerRoot: atom.chroniclerRoot,
		batchId: atom.batchId,
		transcriptPath: atom.transcriptPath,
		sources: [...atom.sources],
		fingerprint: atom.fingerprint,
		route,
	};
}

interface Placed {
	entry: AtomEntry;
	parts: LocalParts;
}

function aggregate(items: readonly Placed[]): Pick<PlanNode, "span" | "atomCount" | "projects" | "sessions"> {
	let first = items[0]!;
	let last = items[0]!;
	for (const item of items) {
		if (item.entry.eventTime < first.entry.eventTime) first = item;
		if (item.entry.eventTime > last.entry.eventTime) last = item;
	}
	return {
		span: {
			start: first.entry.eventTime,
			end: last.entry.eventTime,
			localStart: first.entry.localTime,
			localEnd: last.entry.localTime,
		},
		atomCount: items.length,
		projects: [...new Set(items.map(item => item.entry.project))].sort(),
		sessions: [...new Set(items.map(item => item.entry.sessionId))].sort(),
	};
}

function aggregateNodes(children: readonly PlanNode[]): Pick<PlanNode, "span" | "atomCount" | "projects" | "sessions"> {
	const first = children.reduce((a, b) => (b.span.start < a.span.start ? b : a));
	const last = children.reduce((a, b) => (b.span.end > a.span.end ? b : a));
	return {
		span: {
			start: first.span.start,
			end: last.span.end,
			localStart: first.span.localStart,
			localEnd: last.span.localEnd,
		},
		atomCount: children.reduce((sum, child) => sum + child.atomCount, 0),
		projects: [...new Set(children.flatMap(child => child.projects))].sort(),
		sessions: [...new Set(children.flatMap(child => child.sessions))].sort(),
	};
}

function join(parent: string, segment: string): string {
	return parent ? `${parent}/${segment}` : segment;
}

function groupBy<K>(items: readonly Placed[], keyOf: (item: Placed) => K): Map<K, Placed[]> {
	const out = new Map<K, Placed[]>();
	for (const item of items) {
		const key = keyOf(item);
		const list = out.get(key);
		if (list) list.push(item);
		else out.set(key, [item]);
	}
	return out;
}

function fits(items: readonly Placed[], config: IndexConfig): boolean {
	if (items.length > config.terminalAtoms) return false;
	let tokens = 0;
	for (const item of items) tokens += estimateTokens(item.entry.route);
	return tokens <= config.hopTokens;
}

function terminal(key: string, segment: string, level: NodeLevel, label: string, items: Placed[]): PlanNode {
	const sorted = [...items].sort(
		(a, b) => a.entry.eventTime.localeCompare(b.entry.eventTime) || a.entry.id.localeCompare(b.entry.id),
	);
	return {
		key,
		segment,
		level,
		label,
		...aggregate(sorted),
		children: [],
		entries: sorted.map(item => item.entry),
	};
}

function hourPrefix(parts: LocalParts): string {
	return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}`;
}

/** Losslessly paginate one indivisible minute into budget-sized pages. */
function paginate(parentKey: string, minute: number, items: Placed[], config: IndexConfig): PlanNode[] {
	const sorted = [...items].sort(
		(a, b) => a.entry.eventTime.localeCompare(b.entry.eventTime) || a.entry.id.localeCompare(b.entry.id),
	);
	const pages: Placed[][] = [];
	let current: Placed[] = [];
	let tokens = 0;
	for (const item of sorted) {
		const cost = estimateTokens(item.entry.route);
		if (current.length > 0 && (current.length >= config.terminalAtoms || tokens + cost > config.hopTokens)) {
			pages.push(current);
			current = [];
			tokens = 0;
		}
		current.push(item);
		tokens += cost;
	}
	if (current.length > 0) pages.push(current);
	const prefix = hourPrefix(sorted[0]!.parts);
	return pages.map((page, index) => {
		const segment = `${pad2(minute)}-p${pad2(index + 1)}`;
		return terminal(
			join(parentKey, segment),
			segment,
			"page",
			`${prefix}:${pad2(minute)} (page ${index + 1} of ${pages.length})`,
			page,
		);
	});
}

/** Split an over-budget minute range at its midpoint; flattened into sibling spans. */
function splitMinutes(parentKey: string, items: Placed[], lo: number, hi: number, config: IndexConfig): PlanNode[] {
	if (lo === hi) {
		if (fits(items, config)) {
			const segment = pad2(lo);
			return [
				terminal(join(parentKey, segment), segment, "span", `${hourPrefix(items[0]!.parts)}:${segment}`, items),
			];
		}
		return paginate(parentKey, lo, items, config);
	}
	const mid = Math.floor((lo + hi) / 2);
	const out: PlanNode[] = [];
	for (const [from, to] of [
		[lo, mid],
		[mid + 1, hi],
	] as const) {
		const half = items.filter(item => item.parts.minute >= from && item.parts.minute <= to);
		if (half.length === 0) continue;
		if (fits(half, config)) {
			const segment = from === to ? pad2(from) : `${pad2(from)}-${pad2(to)}`;
			const prefix = hourPrefix(half[0]!.parts);
			out.push(
				terminal(
					join(parentKey, segment),
					segment,
					"span",
					from === to
						? `${prefix}:${pad2(from)}`
						: `${prefix}:${pad2(from)}–${pad2(half[0]!.parts.hour)}:${pad2(to)}`,
					half,
				),
			);
		} else {
			out.push(...splitMinutes(parentKey, half, from, to, config));
		}
	}
	return out;
}

function interior(
	key: string,
	segment: string,
	level: NodeLevel,
	label: string,
	children: PlanNode[],
	config: IndexConfig,
): PlanNode {
	return {
		key,
		segment,
		level,
		label,
		...aggregateNodes(children),
		children: boundFanout(key, children, config),
		entries: [],
	};
}

/** Insert contiguous fan-out groups until every node's children fit one routing hop. */
function boundFanout(parentKey: string, children: PlanNode[], config: IndexConfig): PlanNode[] {
	const limit = maxFanout(config);
	if (children.length <= limit) return children;
	let level = children;
	let depth = 0;
	while (level.length > limit) {
		depth++;
		const groups: PlanNode[] = [];
		for (let index = 0; index < level.length; index += limit) {
			const members = level.slice(index, index + limit);
			const segment = `g${depth}-${pad2(groups.length + 1)}`;
			groups.push({
				key: "",
				segment,
				level: "group",
				label: `${members[0]!.label} … ${members[members.length - 1]!.label}`,
				...aggregateNodes(members),
				children: members,
				entries: [],
			});
		}
		level = groups;
	}
	for (const node of level) rekey(node, parentKey);
	return level;
}

function rekey(node: PlanNode, parentKey: string): void {
	node.key = join(parentKey, node.segment);
	for (const child of node.children) rekey(child, node.key);
}

function buildHour(key: string, segment: string, items: Placed[], config: IndexConfig): PlanNode {
	const parts = items[0]!.parts;
	const label = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:00–${pad2(parts.hour)}:59`;
	if (fits(items, config)) return terminal(key, segment, "hour", label, items);
	return interior(key, segment, "hour", label, splitMinutes(key, items, 0, 59, config), config);
}

/** Plan the full hierarchy. Returns null for an empty corpus. */
export function buildPlan(atoms: readonly ChronicleAtom[], config: IndexConfig): PlanNode | null {
	if (atoms.length === 0) return null;
	const placed: Placed[] = atoms.map(atom => {
		const parts = localParts(atom.eventTime, config.timeZone);
		return { entry: atomEntry(atom, parts, config), parts };
	});
	const years: PlanNode[] = [];
	for (const [year, yearItems] of [...groupBy(placed, item => item.parts.year)].sort((a, b) => a[0] - b[0])) {
		const yearKey = String(year);
		const months: PlanNode[] = [];
		for (const [month, monthItems] of [...groupBy(yearItems, item => item.parts.month)].sort((a, b) => a[0] - b[0])) {
			const monthKey = join(yearKey, pad2(month));
			const weeks: PlanNode[] = [];
			for (const [week, weekItems] of [
				...groupBy(monthItems, item => monthWeek(year, month, item.parts.day).week),
			].sort((a, b) => a[0] - b[0])) {
				const weekKey = join(monthKey, `w${week}`);
				const { firstDay, lastDay } = monthWeek(year, month, weekItems[0]!.parts.day);
				const days: PlanNode[] = [];
				for (const [day, dayItems] of [...groupBy(weekItems, item => item.parts.day)].sort((a, b) => a[0] - b[0])) {
					const dayKey = join(weekKey, pad2(day));
					const hours: PlanNode[] = [];
					for (const [hour, hourItems] of [...groupBy(dayItems, item => item.parts.hour)].sort(
						(a, b) => a[0] - b[0],
					)) {
						hours.push(buildHour(join(dayKey, pad2(hour)), pad2(hour), hourItems, config));
					}
					days.push(
						interior(
							dayKey,
							pad2(day),
							"day",
							`${dayName(year, month, day)} ${year}-${pad2(month)}-${pad2(day)}`,
							hours,
							config,
						),
					);
				}
				weeks.push(
					interior(
						weekKey,
						`w${week}`,
						"week",
						`${monthName(month)} ${year} week ${week} (${dayName(year, month, firstDay)} ${firstDay} – ${dayName(year, month, lastDay)} ${lastDay})`,
						days,
						config,
					),
				);
			}
			months.push(interior(monthKey, pad2(month), "month", `${monthName(month)} ${year}`, weeks, config));
		}
		years.push(interior(yearKey, yearKey, "year", yearKey, months, config));
	}
	return interior("", "", "root", "All Chronicler atoms", years, config);
}

/** Pre-order walk. */
export function* walkPlan(node: PlanNode): Generator<PlanNode> {
	yield node;
	for (const child of node.children) yield* walkPlan(child);
}
