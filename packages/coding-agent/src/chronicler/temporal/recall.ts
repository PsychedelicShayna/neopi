/**
 * Coarse-to-fine recall over the derived temporal view.
 *
 * Best-first search with a bounded frontier: each expansion ranks the node's
 * in-scope children and keeps the best `beam` of them (plus near-ties while
 * the frontier bound allows). Nothing already in the frontier is discarded
 * when a branch collapses, so moving to a retained runner-up — a backtrack —
 * falls out of the ordering and is recorded in the trace. Selected atoms are
 * resolved against their canonical committed batch before they are returned.
 */
import * as path from "node:path";
import { localParts, localStamp, spanWithin, type TimeBound, type TimeSpan } from "./calendar";
import { type CanonicalAtomResult, type ChronicleAtom, readCanonicalAtom } from "./corpus";
import type { NodeRanker, RankCandidate } from "./rank";
import { type AtomEntry, clipText, estimateTokens, type NodeLevel, type Resolution } from "./tree";
import { nodeDir, readViewManifest, readViewNode, type ViewChildRef, type ViewNode } from "./view";

/** Best child below this fraction of its parent's score (and not confident) marks a collapsed branch. */
const DROP_RATIO = 0.5;
/** Absolute score at which an atom is a confident match. */
export const CONFIDENT = 0.6;
/** Minimum score for a descent atom to be returned at all. */
const ATOM_MIN = 0.25;
/** Children within this margin of the best are retained beyond the beam while the frontier bound allows. */
const TIE_MARGIN = 0.1;
const FRONTIER_FACTOR = 4;
const MAX_HOPS = 32;
const MAX_EVIDENCE_CHARS = 12_000;
const MAX_NEIGHBORS = 6;
const MAX_CANDIDATE_PERIODS = 5;

export interface RecallOptions {
	root: string;
	query: string;
	from?: TimeBound;
	to?: TimeBound;
	/** Substring of the project (session cwd) path. */
	project?: string;
	/** Session id or id prefix. */
	session?: string;
	/** A remembered adjacent event used as a temporal anchor. */
	hint?: string;
	/** Stop at this level and return candidate periods instead of atoms. */
	resolution?: Resolution;
	/** Start below this node key (from a previous call's candidates) instead of the root. */
	node?: string;
	budget: number;
	beam: number;
	neighborhoodMinutes: number;
	ranker: NodeRanker;
	signal?: AbortSignal;
}

export type TraceAction =
	| "rank"
	| "terminal"
	| "collapse"
	| "backtrack"
	| "evict"
	| "candidate"
	| "anchor"
	| "adjacent"
	| "view-drift"
	| "ranker-fallback"
	| "atom-missing"
	| "stale-atom"
	| "moved-out-of-scope"
	| "query-clipped";

export interface TraceStep {
	search: "query" | "hint";
	hop: number;
	node: string;
	action: TraceAction;
	candidates?: { key: string; label: string; score: number }[];
	note?: string;
}

export interface RecallNeighbor {
	id: string;
	title: string;
	eventTime: string;
	project: string;
	sessionId: string;
}

export interface RecallAtom {
	id: string;
	title: string;
	kind: string;
	eventTime: string;
	project: string;
	sessionId: string;
	score: number;
	confident: boolean;
	via: "descent" | "adjacent";
	/** Hint anchor atom id for adjacency results. */
	anchor?: string;
	/** Canonical beat file. */
	beat: string;
	/** Derived stub in the view. */
	stub: string;
	transcript: { path: string; entryIds: string[] };
	body: string;
	bodyTruncated: boolean;
	/** The canonical atom changed since the view was indexed; fields are current canonical values. */
	stale: boolean;
	neighbors: RecallNeighbor[];
}

export interface CandidatePeriod {
	key: string;
	level: NodeLevel;
	label: string;
	localStart: string;
	localEnd: string;
	atomCount: number;
	projects: string[];
	description: string;
	score: number;
}

export interface RecallResult {
	query: string;
	results: RecallAtom[];
	/** Candidate periods: requested resolution stops, or the best periods when recall is ambiguous. */
	candidates: CandidatePeriod[];
	ambiguous: boolean;
	/** The one hint that would discriminate best, when ambiguous. */
	ask?: "time-range" | "adjacent-event";
	trace: TraceStep[];
	ranker: "model" | "lexical";
	/** At least one model-ranked hop fell back to lexical scoring (see trace). */
	rankerFallback: boolean;
	evidenceErrors: { id: string; reason: string }[];
	view: { root: string; indexedAt?: string; complete: boolean; viewStale: boolean };
}

interface ScoredAtom {
	entry: AtomEntry;
	terminal: string;
	score: number;
}

interface SearchState {
	atoms: Map<string, ScoredAtom>;
	periods: CandidatePeriod[];
	pool: Map<string, CandidatePeriod>;
}

/** Estimated tokens of a rank request: the recollection plus each candidate's key, label, and text. */
export function rankPayloadTokens(query: string, candidates: readonly RankCandidate[]): number {
	let tokens = rankQueryTokens(query);
	for (const candidate of candidates) tokens += rankCandidateTokens(candidate);
	return tokens;
}

function rankQueryTokens(query: string): number {
	return estimateTokens(`Recollection: ${query}\n\n`);
}

function candidateHeader(candidate: Pick<RankCandidate, "key" | "label">): string {
	return `### Candidate \`${candidate.key}\` — ${candidate.label}\n`;
}

function rankCandidateTokens(candidate: RankCandidate): number {
	return estimateTokens(`${candidateHeader(candidate)}${candidate.text}\n\n`);
}

/** Share of one hop a recollection may take in a rank request; the rest is for candidates. */
const QUERY_SHARE = 0.25;

/** Clip `text` so that `prefix + text + suffix` estimates to at most `tokens`; marks the cut with `…`. */
function fitText(prefix: string, text: string, suffix: string, tokens: number): { text: string; clipped: boolean } {
	if (estimateTokens(`${prefix}${text}${suffix}`) <= tokens) return { text, clipped: false };
	const room = tokens * 4 - prefix.length - suffix.length - 1;
	const clipped = clipText(text, Math.max(0, room));
	return { text: `${clipped.text}…`, clipped: true };
}

export class ChronicleViewMissingError extends Error {
	constructor(root: string) {
		super(`No chronicle view at ${root}. Run \`npi chronicle index\` first.`);
		this.name = "ChronicleViewMissingError";
	}
}

function lower(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase();
	return trimmed ? trimmed : undefined;
}

export async function recallChronicle(options: RecallOptions): Promise<RecallResult> {
	const manifest = await readViewManifest(options.root);
	const trace: TraceStep[] = [];
	const cache = new Map<string, ViewNode | null>();
	let viewStale = false;
	const project = lower(options.project);
	const session = lower(options.session);
	const resolution = options.resolution ?? "atom";
	const budget = Math.max(1, Math.floor(options.budget));
	const beam = Math.max(1, Math.floor(options.beam));

	const inScopeSpan = (span: TimeSpan): boolean => spanWithin(span, options.from, options.to);
	const inScopeRef = (ref: ViewChildRef): boolean =>
		inScopeSpan(ref) &&
		(!project || ref.projects.some(value => value.toLowerCase().includes(project))) &&
		(!session || ref.sessions.some(value => value.toLowerCase().startsWith(session)));
	const inScopeAtom = (atom: { eventTime: string; localTime: string; project: string; sessionId: string }): boolean =>
		inScopeSpan({
			start: atom.eventTime,
			end: atom.eventTime,
			localStart: atom.localTime,
			localEnd: atom.localTime,
		}) &&
		(!project || atom.project.toLowerCase().includes(project)) &&
		(!session || atom.sessionId.toLowerCase().startsWith(session));

	const load = async (
		key: string,
		expected?: ViewChildRef,
		search: "query" | "hint" = "query",
	): Promise<ViewNode | null> => {
		let node = cache.get(key);
		if (node === undefined) {
			const stored = await readViewNode(options.root, key);
			node = stored.state === "ok" ? stored.node : null;
			cache.set(key, node);
			if (stored.state !== "ok" && key !== "") {
				viewStale = true;
				trace.push({ search, hop: 0, node: key, action: "view-drift", note: `node ${stored.state}` });
			}
		}
		if (node && expected && (node.identity !== expected.identity || node.contentHash !== expected.contentHash)) {
			viewStale = true;
			trace.push({
				search,
				hop: 0,
				node: key,
				action: "view-drift",
				note: "child differs from the edition its parent summarized",
			});
		}
		return node;
	};

	const startKey = options.node?.trim().replace(/^\/+|\/+$/g, "") ?? "";
	const start = await load(startKey);
	if (!start) {
		if (!startKey) throw new ChronicleViewMissingError(options.root);
		throw new Error(`No chronicle node ${startKey} in ${options.root}`);
	}

	let rankerFallback = false;
	const hopTokens = manifest?.config?.hopTokens ?? 1000;
	/**
	 * A recollection (query or hint) longer than its share of one hop is
	 * clipped for ranking, and the clip is recorded in the trace.
	 */
	const boundQuery = (text: string, search: "query" | "hint"): string => {
		const fitted = fitText("Recollection: ", text, "\n\n", Math.floor(hopTokens * QUERY_SHARE));
		if (fitted.clipped) {
			trace.push({
				search,
				hop: 0,
				node: "",
				action: "query-clipped",
				note: `${search} clipped to ${Math.floor(hopTokens * QUERY_SHARE)} tokens for ranking`,
			});
		}
		return fitted.text;
	};
	/**
	 * Rank in pages whose serialized request (recollection plus each
	 * candidate's key, label, and text) fits one hop. A candidate larger than
	 * the remaining room has its label and then its text clipped, visibly; no
	 * candidate is dropped, and every page is checked before it is sent.
	 */
	const rank = async (
		query: string,
		candidates: RankCandidate[],
		search: "query" | "hint",
		hop: number,
		key: string,
	): Promise<number[]> => {
		const base = rankQueryTokens(query);
		const room = hopTokens - base;
		const bounded = candidates.map(candidate => {
			// Keep the header to half the room so the text always has space.
			const label = fitText(
				`### Candidate \`${candidate.key}\` — `,
				candidate.label,
				"\n",
				Math.floor(room / 2),
			).text;
			const header = candidateHeader({ key: candidate.key, label });
			const text = fitText(header, candidate.text, "\n\n", room).text;
			return { ...candidate, label, text };
		});
		const scores: number[] = Array.from({ length: candidates.length }, () => 0);
		let page: number[] = [];
		let tokens = base;
		const flush = async (): Promise<void> => {
			if (page.length === 0) return;
			const request = page.map(index => bounded[index]!);
			const payload = rankPayloadTokens(query, request);
			if (payload > hopTokens) {
				throw new Error(`chronicle rank request of ${payload} tokens exceeds the ${hopTokens}-token hop ceiling`);
			}
			const outcome = await options.ranker.score(
				query,
				page.map(index => bounded[index]!),
				options.signal,
			);
			if (outcome.fallback) {
				rankerFallback = true;
				trace.push({ search, hop, node: key, action: "ranker-fallback", note: outcome.fallback });
			}
			page.forEach((index, position) => {
				scores[index] = outcome.scores[position] ?? 0;
			});
			page = [];
			tokens = base;
		};
		for (let index = 0; index < bounded.length; index++) {
			const cost = rankCandidateTokens(bounded[index]!);
			if (page.length > 0 && tokens + cost > hopTokens) await flush();
			page.push(index);
			tokens += cost;
		}
		await flush();
		return scores;
	};

	const toPeriod = (ref: ViewChildRef, score: number): CandidatePeriod => ({
		key: ref.key,
		level: ref.level,
		label: ref.label,
		localStart: ref.localStart,
		localEnd: ref.localEnd,
		atomCount: ref.atomCount,
		projects: ref.projects,
		description: ref.description,
		score,
	});

	const descend = async (query: string, search: "query" | "hint"): Promise<SearchState> => {
		const state: SearchState = { atoms: new Map(), periods: [], pool: new Map() };
		type Item = { key: string; score: number; parent: string | null; ref?: ViewChildRef };
		let frontier: Item[] = [{ key: start.key, score: 1, parent: null }];
		let lastExpanded: string | null = null;
		let lastCollapsed = false;
		let hops = 0;
		while (frontier.length > 0 && hops < MAX_HOPS) {
			options.signal?.throwIfAborted();
			frontier.sort((a, b) => b.score - a.score);
			const confident = [...state.atoms.values()]
				.map(atom => atom.score)
				.filter(score => score >= CONFIDENT)
				.sort((a, b) => b - a);
			// Enough confident atoms, and no retained branch scores close enough to hide an equal one.
			if (confident.length >= budget && frontier[0]!.score < confident[budget - 1]! - TIE_MARGIN) break;
			const item = frontier.shift()!;
			if (lastExpanded !== null && item.parent !== lastExpanded) {
				trace.push({
					search,
					hop: hops,
					node: item.key,
					action: "backtrack",
					note: `from ${lastExpanded || "root"} (${lastCollapsed ? "relevance dropped" : "branch exhausted"}) to ${item.key || "root"} at ${item.score.toFixed(2)}`,
				});
			}
			const node = await load(item.key, item.ref, search);
			if (!node) continue;
			hops++;
			lastExpanded = item.key;
			lastCollapsed = false;

			if (resolution !== "atom" && search === "query" && node.level === resolution && item.ref) {
				state.periods.push(toPeriod(item.ref, item.score));
				trace.push({ search, hop: hops, node: node.key, action: "candidate", note: node.label });
				continue;
			}

			if (node.atoms) {
				const entries = node.atoms.filter(inScopeAtom);
				const scores = await rank(
					query,
					entries.map(entry => ({ key: entry.id, label: entry.localTime, text: entry.route })),
					search,
					hops,
					node.key,
				);
				trace.push({
					search,
					hop: hops,
					node: node.key,
					action: "terminal",
					candidates: entries.map((entry, index) => ({
						key: entry.id,
						label: entry.title,
						score: scores[index]!,
					})),
				});
				let best = 0;
				entries.forEach((entry, index) => {
					const score = scores[index]!;
					best = Math.max(best, score);
					const previous = state.atoms.get(entry.id);
					if (!previous || previous.score < score) state.atoms.set(entry.id, { entry, terminal: node.key, score });
				});
				if (best < DROP_RATIO * item.score && best < CONFIDENT) {
					lastCollapsed = true;
					trace.push({
						search,
						hop: hops,
						node: node.key,
						action: "collapse",
						note: `best atom ${best.toFixed(2)}`,
					});
				}
				continue;
			}

			const children = node.children.filter(inScopeRef);
			if (children.length === 0) continue;
			const scores = await rank(
				query,
				children.map(child => ({
					key: child.key,
					label: child.label,
					text: child.description,
				})),
				search,
				hops,
				node.key,
			);
			trace.push({
				search,
				hop: hops,
				node: node.key,
				action: "rank",
				candidates: children.map((child, index) => ({ key: child.key, label: child.label, score: scores[index]! })),
			});
			const ranked = children
				.map((child, index) => ({ child, score: scores[index]! }))
				.sort((a, b) => b.score - a.score);
			for (const { child, score } of ranked) {
				if (child.level !== "group" && search === "query") state.pool.set(child.key, toPeriod(child, score));
			}
			const best = ranked[0]!.score;
			if (best < DROP_RATIO * item.score && best < CONFIDENT) {
				lastCollapsed = true;
				trace.push({
					search,
					hop: hops,
					node: node.key,
					action: "collapse",
					note: `best child ${best.toFixed(2)}`,
				});
			}
			const kept = ranked.filter((entry, index) => index < beam || best - entry.score <= TIE_MARGIN);
			for (const { child, score } of kept) frontier.push({ key: child.key, score, parent: node.key, ref: child });
			frontier.sort((a, b) => b.score - a.score);
			const bound = beam * FRONTIER_FACTOR;
			if (frontier.length > bound) {
				const evicted = frontier.slice(bound);
				frontier = frontier.slice(0, bound);
				trace.push({
					search,
					hop: hops,
					node: node.key,
					action: "evict",
					candidates: evicted.map(entry => ({
						key: entry.key,
						label: entry.ref?.label ?? entry.key,
						score: entry.score,
					})),
				});
			}
		}
		return state;
	};

	/** In-scope atoms within [startMs, endMs], found by walking only overlapping nodes. */
	const collectWindow = async (startMs: number, endMs: number, search: "query" | "hint"): Promise<ScoredAtom[]> => {
		const out: ScoredAtom[] = [];
		const walk = async (node: ViewNode): Promise<void> => {
			if (node.atoms) {
				for (const entry of node.atoms) {
					const at = Date.parse(entry.eventTime);
					if (at >= startMs && at <= endMs && inScopeAtom(entry))
						out.push({ entry, terminal: node.key, score: 0 });
				}
				return;
			}
			for (const child of node.children) {
				if (Date.parse(child.end) < startMs || Date.parse(child.start) > endMs || !inScopeRef(child)) continue;
				const loaded = await load(child.key, child, search);
				if (loaded) await walk(loaded);
			}
		};
		const root = await load("");
		if (root) await walk(root);
		return out;
	};

	const windowMs = Math.max(1, options.neighborhoodMinutes) * 60_000;
	const timeZone = manifest?.timeZone ?? "UTC";
	const evidenceErrors: { id: string; reason: string }[] = [];
	/** Canonical re-read of an atom the view points at; null (disclosed) when gone, changed out of scope, or unreadable. */
	const revalidate = async (
		entry: AtomEntry,
		terminal: string,
		search: "query" | "hint",
	): Promise<ChronicleAtom | null> => {
		let resolved: CanonicalAtomResult;
		try {
			resolved = await readCanonicalAtom(entry);
		} catch (error) {
			resolved = { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (!resolved.ok) {
			viewStale = true;
			trace.push({
				search,
				hop: 0,
				node: terminal,
				action: "atom-missing",
				note: `${entry.id}: ${resolved.reason}`,
			});
			return null;
		}
		const current = resolved.atom;
		if (current.fingerprint !== entry.fingerprint) {
			viewStale = true;
			trace.push({ search, hop: 0, node: terminal, action: "stale-atom", note: entry.id });
		}
		if (!inScopeAtom({ ...current, localTime: localStamp(localParts(current.eventTime, timeZone)) })) {
			trace.push({ search, hop: 0, node: terminal, action: "moved-out-of-scope", note: entry.id });
			return null;
		}
		return current;
	};
	const query = boundQuery(options.query, "query");
	const primary = await descend(query, "query");

	let adjacent: ScoredAtom[] = [];
	let anchor: ScoredAtom | undefined;
	let anchorWindowCenter = 0;
	if (options.hint?.trim() && resolution === "atom") {
		const hinted = await descend(boundQuery(options.hint, "hint"), "hint");
		anchor = [...hinted.atoms.values()].sort((a, b) => b.score - a.score)[0];
		let anchorTime = anchor ? Date.parse(anchor.entry.eventTime) : 0;
		if (anchor && anchor.score >= ATOM_MIN) {
			const current = await revalidate(anchor.entry, anchor.terminal, "hint");
			if (current) anchorTime = Date.parse(current.eventTime);
			else anchor = undefined;
		}
		if (anchor && anchor.score >= ATOM_MIN) {
			trace.push({
				search: "hint",
				hop: 0,
				node: anchor.terminal,
				action: "anchor",
				candidates: [{ key: anchor.entry.id, label: anchor.entry.title, score: anchor.score }],
			});
			const at = anchorTime;
			anchorWindowCenter = at;
			const nearby = (await collectWindow(at - windowMs, at + windowMs, "hint"))
				.filter(candidate => candidate.entry.id !== anchor!.entry.id)
				.sort(
					(a, b) => Math.abs(Date.parse(a.entry.eventTime) - at) - Math.abs(Date.parse(b.entry.eventTime) - at),
				);
			const scores = await rank(
				query,
				nearby.map(candidate => ({
					key: candidate.entry.id,
					label: candidate.entry.localTime,
					text: candidate.entry.route,
				})),
				"hint",
				0,
				anchor.terminal,
			);
			adjacent = nearby
				.map((candidate, index) => ({ ...candidate, score: scores[index]! }))
				.sort(
					(a, b) =>
						b.score - a.score ||
						Math.abs(Date.parse(a.entry.eventTime) - at) - Math.abs(Date.parse(b.entry.eventTime) - at),
				);
			trace.push({
				search: "hint",
				hop: 0,
				node: anchor.terminal,
				action: "adjacent",
				candidates: adjacent.map(candidate => ({
					key: candidate.entry.id,
					label: candidate.entry.title,
					score: candidate.score,
				})),
			});
		} else {
			anchor = undefined;
			trace.push({ search: "hint", hop: 0, node: "", action: "anchor", note: "no current atom matched the hint" });
		}
	}

	const selected: { atom: ScoredAtom; via: "descent" | "adjacent" }[] = [];
	const seen = new Set<string>();
	if (resolution === "atom") {
		const reserve = anchor ? Math.ceil(budget / 2) : 0;
		for (const candidate of adjacent.slice(0, reserve)) {
			selected.push({ atom: candidate, via: "adjacent" });
			seen.add(candidate.entry.id);
		}
		const descentAtoms = [...primary.atoms.values()]
			.filter(atom => atom.score >= ATOM_MIN && !seen.has(atom.entry.id))
			.sort((a, b) => b.score - a.score);
		for (const atom of descentAtoms) {
			if (selected.length >= budget) break;
			selected.push({ atom, via: "descent" });
			seen.add(atom.entry.id);
		}
		for (const candidate of adjacent.slice(reserve)) {
			if (selected.length >= budget) break;
			if (seen.has(candidate.entry.id)) continue;
			selected.push({ atom: candidate, via: "adjacent" });
			seen.add(candidate.entry.id);
		}
	}

	const results: RecallAtom[] = [];
	for (const { atom, via } of selected) {
		const entry = atom.entry;
		let resolved: CanonicalAtomResult;
		try {
			resolved = await readCanonicalAtom(entry);
		} catch (error) {
			resolved = { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (!resolved.ok) {
			viewStale = true;
			evidenceErrors.push({ id: entry.id, reason: resolved.reason });
			trace.push({
				search: "query",
				hop: 0,
				node: atom.terminal,
				action: "atom-missing",
				note: `${entry.id}: ${resolved.reason}`,
			});
			continue;
		}
		const current = resolved.atom;
		const stale = current.fingerprint !== entry.fingerprint;
		if (stale) {
			viewStale = true;
			trace.push({ search: "query", hop: 0, node: atom.terminal, action: "stale-atom", note: entry.id });
		}
		const localTime = localStamp(localParts(current.eventTime, timeZone));
		const at = Date.parse(current.eventTime);
		const leftWindow = via === "adjacent" && anchor !== undefined && Math.abs(at - anchorWindowCenter) > windowMs;
		if (!inScopeAtom({ ...current, localTime }) || leftWindow) {
			trace.push({ search: "query", hop: 0, node: atom.terminal, action: "moved-out-of-scope", note: entry.id });
			continue;
		}
		const neighbors: RecallNeighbor[] = [];
		if (atom.score >= CONFIDENT || via === "adjacent") {
			const nearby = (await collectWindow(at - windowMs, at + windowMs, "query"))
				.filter(candidate => candidate.entry.id !== current.id)
				.sort(
					(a, b) => Math.abs(Date.parse(a.entry.eventTime) - at) - Math.abs(Date.parse(b.entry.eventTime) - at),
				);
			for (const candidate of nearby) {
				if (neighbors.length >= MAX_NEIGHBORS) break;
				const neighbor = await revalidate(candidate.entry, candidate.terminal, "query");
				if (!neighbor || Math.abs(Date.parse(neighbor.eventTime) - at) > windowMs) continue;
				neighbors.push({
					id: neighbor.id,
					title: neighbor.title,
					eventTime: neighbor.eventTime,
					project: neighbor.project,
					sessionId: neighbor.sessionId,
				});
			}
		}
		const bodyTruncated = current.body.length > MAX_EVIDENCE_CHARS;
		results.push({
			id: current.id,
			title: current.title,
			kind: current.kind,
			eventTime: current.eventTime,
			project: current.project,
			sessionId: current.sessionId,
			score: atom.score,
			confident: atom.score >= CONFIDENT,
			via,
			...(via === "adjacent" && anchor ? { anchor: anchor.entry.id } : {}),
			beat: current.beatFile,
			stub: path.join(nodeDir(options.root, atom.terminal), entry.stub),
			transcript: { path: current.transcriptPath, entryIds: [...current.sources] },
			body: bodyTruncated ? current.body.slice(0, MAX_EVIDENCE_CHARS) : current.body,
			bodyTruncated,
			stale,
			neighbors,
		});
	}

	let candidates: CandidatePeriod[] = [];
	let ambiguous = false;
	let ask: RecallResult["ask"];
	const askFor = (periods: readonly CandidatePeriod[]): RecallResult["ask"] => {
		const [first, second] = periods;
		return first && second && first.localStart.slice(0, 7) !== second.localStart.slice(0, 7)
			? "time-range"
			: "adjacent-event";
	};
	if (resolution !== "atom") {
		candidates = primary.periods.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATE_PERIODS);
	} else if (
		!results.some(result => result.confident) &&
		!(anchor && anchor.score >= CONFIDENT && results.some(result => result.via === "adjacent"))
	) {
		ambiguous = true;
		candidates = [...primary.pool.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATE_PERIODS);
		ask = askFor(candidates);
	} else {
		// High scores do not mean discrimination: atoms just past the budget that
		// tie the last selected one in another period leave the choice open.
		const ranked = [...primary.atoms.values()].sort((a, b) => b.score - a.score);
		const chosen = selected.filter(item => item.via === "descent").map(item => item.atom);
		const last = chosen[chosen.length - 1];
		if (last && chosen.length >= budget) {
			const chosenTerminals = new Set(chosen.map(atom => atom.terminal));
			const tied = ranked.filter(
				atom =>
					!chosen.includes(atom) && last.score - atom.score <= TIE_MARGIN && !chosenTerminals.has(atom.terminal),
			);
			if (tied.length > 0) {
				ambiguous = true;
				const periods: CandidatePeriod[] = [];
				for (const atom of [last, ...tied]) {
					if (periods.some(period => period.key === atom.terminal)) continue;
					const node = cache.get(atom.terminal);
					if (!node) continue;
					periods.push({
						key: node.key,
						level: node.level,
						label: node.label,
						localStart: node.localStart,
						localEnd: node.localEnd,
						atomCount: node.atomCount,
						projects: node.projects,
						description: atom.entry.route,
						score: atom.score,
					});
				}
				candidates = periods.slice(0, MAX_CANDIDATE_PERIODS);
				ask = askFor(candidates);
			}
		}
	}

	return {
		query: options.query,
		results,
		candidates,
		ambiguous,
		...(ask ? { ask } : {}),
		trace,
		ranker: options.ranker.kind,
		rankerFallback,
		evidenceErrors,
		view: {
			root: options.root,
			indexedAt: manifest?.indexedAt,
			complete: manifest?.complete === true,
			viewStale,
		},
	};
}
