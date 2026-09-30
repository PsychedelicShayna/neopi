/**
 * Build or refresh the derived temporal view from canonical atoms.
 *
 * Freshness is decided bottom-up. A node's desired identity is computed from
 * the corpus and config alone (atom fingerprints, budgets, timezone, prompt
 * version, resolved summary model); its stored content hash must match its
 * files, and the child identities/content it consumed must match the children
 * on disk now. Only stale nodes are regenerated, children before parents.
 * Canonical atoms are only read.
 */
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { spanWithin, type TimeBound } from "./calendar";
import { type CorpusDiagnostic, hashText, loadChronicleCorpus } from "./corpus";
import { type ChronicleSummarizer, SUMMARY_PROMPT_VERSION, type SummaryChildInput } from "./summarize";
import { buildPlan, clipText, estimateTokens, type IndexConfig, overviewTokens, type PlanNode, walkPlan } from "./tree";
import {
	assertOwnedViewRoot,
	computeContentHash,
	findOrphanDirs,
	type IdentityParts,
	readViewManifest,
	readViewNode,
	removeNodeDir,
	routeLinePrefix,
	routingText,
	VIEW_FORMAT_VERSION,
	type ViewChildRef,
	type ViewNode,
	verifyRenders,
	writeViewManifest,
	writeViewNode,
} from "./view";

export type StaleReason =
	| "missing"
	| "corrupt"
	| "rebuild"
	| "config-changed"
	| "model-changed"
	| "inputs-changed"
	| "child-changed"
	| "drift";

export type NodeOutcome = "fresh" | "generated" | "stale" | "blocked" | "outside-window" | "failed";

export interface IndexNodeReport {
	key: string;
	level: string;
	outcome: NodeOutcome;
	reason?: StaleReason;
	detail?: string;
}

export interface IndexReport {
	root: string;
	dryRun: boolean;
	atoms: number;
	stores: number;
	sessions: number;
	projects: number;
	summaryModel?: string;
	nodes: {
		total: number;
		fresh: number;
		stale: number;
		generated: number;
		singleChild: number;
		enumerated: number;
		blocked: number;
		outsideWindow: number;
		failed: number;
		pruned: number;
	};
	/** Every node that was not fresh on entry, with why and what happened. */
	changes: IndexNodeReport[];
	canonical: CorpusDiagnostic[];
	/** Derived-view problems found while checking freshness (drift, corrupt files, orphans). */
	derived: { key: string; detail: string }[];
	complete: boolean;
}

export interface IndexOptions {
	agentDir: string;
	root: string;
	config: IndexConfig;
	/** Omit to plan without a model: interior nodes that need generation are reported failed. */
	summarizer?: ChronicleSummarizer;
	rebuild?: boolean;
	dryRun?: boolean;
	since?: TimeBound;
	until?: TimeBound;
	/** Parallel summary calls. */
	concurrency?: number;
	signal?: AbortSignal;
	onProgress?(message: string): void;
	/** Override for tests; defaults to the agent dir's sessions directory. */
	sessionsDir?: string;
}

const ROUTE_OVERHEAD_TOKENS = 24;
const MIN_DESCRIPTION_TOKENS = 8;

function terminalConfigHash(config: IndexConfig): string {
	return hashText(
		JSON.stringify([
			"terminal",
			VIEW_FORMAT_VERSION,
			config.timeZone,
			config.leadTokens,
			config.terminalAtoms,
			config.hopTokens,
			config.shortNames,
		]),
	);
}

function interiorConfigHash(config: IndexConfig): string {
	return hashText(
		JSON.stringify([
			"interior",
			VIEW_FORMAT_VERSION,
			SUMMARY_PROMPT_VERSION,
			config.timeZone,
			config.summaryTokens,
			config.hopTokens,
			config.terminalAtoms,
		]),
	);
}

function combineIdentity(parts: IdentityParts): string {
	return hashText(JSON.stringify([parts.config, parts.model, parts.inputs]));
}

interface Processed {
	plan: PlanNode;
	outcome: NodeOutcome;
	/** Current node on disk after this run (fresh or regenerated); undefined otherwise. */
	node?: ViewNode;
	identity: string;
}

class Limiter {
	#active = 0;
	#queue: (() => void)[] = [];
	constructor(readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#active >= this.max) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#queue.push(resolve);
			await promise;
		}
		this.#active++;
		try {
			return await fn();
		} finally {
			this.#active--;
			this.#queue.shift()?.();
		}
	}
}

export async function indexChronicle(options: IndexOptions): Promise<IndexReport> {
	const { root, config } = options;
	const dryRun = options.dryRun === true;
	const progress = options.onProgress ?? (() => {});
	const sessionsDir = options.sessionsDir ?? getSessionsDir(options.agentDir);
	await assertOwnedViewRoot(root, options.agentDir, sessionsDir);
	progress("reading canonical atoms");
	const corpus = await loadChronicleCorpus(sessionsDir, {
		checkTranscripts: true,
	});
	const plan = buildPlan(corpus.atoms, config);
	const modelIdentity = options.summarizer?.identity ?? "unresolved";
	const report: IndexReport = {
		root,
		dryRun,
		atoms: corpus.atoms.length,
		stores: corpus.stores,
		sessions: new Set(corpus.atoms.map(atom => atom.sessionId)).size,
		projects: new Set(corpus.atoms.map(atom => atom.project)).size,
		summaryModel: options.summarizer?.identity,
		nodes: {
			total: 0,
			fresh: 0,
			stale: 0,
			generated: 0,
			singleChild: 0,
			enumerated: 0,
			blocked: 0,
			outsideWindow: 0,
			failed: 0,
			pruned: 0,
		},
		changes: [],
		canonical: corpus.diagnostics,
		derived: [],
		complete: false,
	};

	const previous = await readViewManifest(root);
	const startedAt = new Date().toISOString();
	// One shared publication: every writer awaits the same incomplete-manifest write.
	let mutation: Promise<void> | undefined;
	const beginMutation = (): Promise<void> => {
		if (dryRun) return Promise.resolve();
		mutation ??= writeViewManifest(root, {
			format: "chronicle-view",
			version: VIEW_FORMAT_VERSION,
			timeZone: config.timeZone,
			config,
			complete: false,
			startedAt,
			atomCount: corpus.atoms.length,
			summaryModel: options.summarizer?.identity,
		});
		return mutation;
	};

	const limiter = new Limiter(Math.max(1, options.concurrency ?? 4));
	const inWindow = (node: PlanNode): boolean =>
		options.since === undefined && options.until === undefined
			? true
			: spanWithin(node.span, options.since, options.until);

	const process = async (planNode: PlanNode): Promise<Processed> => {
		options.signal?.throwIfAborted();
		const children = await Promise.all(planNode.children.map(child => process(child)));
		const isLeaf = planNode.children.length === 0;
		const parts: IdentityParts = isLeaf
			? {
					config: terminalConfigHash(config),
					model: "none",
					inputs: hashText(
						JSON.stringify([
							planNode.key,
							planNode.level,
							planNode.label,
							planNode.entries.map(entry => [entry.id, entry.fingerprint, entry.stub, entry.route]),
						]),
					),
				}
			: {
					config: interiorConfigHash(config),
					model: modelIdentity,
					inputs: hashText(
						JSON.stringify([
							planNode.key,
							planNode.level,
							planNode.label,
							children.map(child => [child.plan.key, child.identity]),
						]),
					),
				};
		const identity = combineIdentity(parts);
		report.nodes.total++;

		const stored = await readViewNode(root, planNode.key);
		let reason: StaleReason | undefined;
		let detail: string | undefined;
		if (stored.state === "missing") reason = "missing";
		else if (stored.state === "corrupt") {
			reason = "corrupt";
			detail = stored.reason;
			report.derived.push({ key: planNode.key, detail: stored.reason });
		} else {
			const node = stored.node;
			if (node.identityParts?.config !== parts.config) reason = "config-changed";
			else if (node.identityParts.model !== parts.model) reason = "model-changed";
			else if (node.identity !== identity) reason = "inputs-changed";
			else {
				const childMismatch = children.find((child, index) => {
					const ref = node.children[index];
					return (
						!child.node ||
						!ref ||
						ref.key !== child.plan.key ||
						ref.identity !== child.node.identity ||
						ref.contentHash !== child.node.contentHash
					);
				});
				if (childMismatch || node.children.length !== children.length) {
					reason = "child-changed";
				} else {
					const issues = await verifyRenders(root, node);
					if (issues.length > 0) {
						reason = "drift";
						detail = issues.join("; ");
						report.derived.push({ key: planNode.key, detail });
					}
				}
			}
			if (!reason && options.rebuild) reason = "rebuild";
			if (!reason) {
				report.nodes.fresh++;
				return { plan: planNode, outcome: "fresh", node, identity };
			}
		}

		const record = (outcome: NodeOutcome, extra?: string): Processed => {
			report.changes.push({
				key: planNode.key,
				level: planNode.level,
				outcome,
				reason,
				detail: extra ?? detail,
			});
			if (outcome === "stale") report.nodes.stale++;
			else if (outcome === "blocked") report.nodes.blocked++;
			else if (outcome === "outside-window") report.nodes.outsideWindow++;
			else if (outcome === "failed") report.nodes.failed++;
			return { plan: planNode, outcome, identity };
		};

		if (dryRun) return record("stale");
		const blockedBy = children.find(child => !child.node);
		if (blockedBy) return record("blocked", `child ${blockedBy.plan.key} is ${blockedBy.outcome}`);
		if (!inWindow(planNode)) return record("outside-window");

		const base = {
			format: "chronicle-node" as const,
			version: VIEW_FORMAT_VERSION,
			key: planNode.key,
			segment: planNode.segment,
			level: planNode.level,
			label: planNode.label,
			localStart: planNode.span.localStart,
			localEnd: planNode.span.localEnd,
			start: planNode.span.start,
			end: planNode.span.end,
			atomCount: planNode.atomCount,
			projects: planNode.projects,
			sessions: planNode.sessions,
			identity,
			identityParts: parts,
		};
		let built: ViewNode;
		try {
			if (isLeaf) {
				const draft: ViewNode = {
					...base,
					contentHash: "",
					children: [],
					atoms: planNode.entries,
					provenance: { kind: "enumeration", generatedAt: new Date().toISOString(), truncated: false },
				};
				draft.contentHash = computeContentHash(draft);
				built = draft;
				report.nodes.enumerated++;
			} else {
				built = await generateInterior(base, children, config, options, limiter, report);
			}
		} catch (error) {
			if (options.signal?.aborted) throw error;
			return record("failed", error instanceof Error ? error.message : String(error));
		}
		await beginMutation();
		for (const key of await writeViewNode(root, built, new Set(planNode.children.map(child => child.segment)))) {
			report.derived.push({ key, detail: "pruned: no atoms map here any more" });
			report.nodes.pruned++;
		}
		report.nodes.generated++;
		report.changes.push({ key: planNode.key, level: planNode.level, outcome: "generated", reason, detail });
		progress(`generated ${planNode.key || "root"}`);
		return { plan: planNode, outcome: "generated", node: built, identity };
	};

	let rootOutcome: Processed | undefined;
	if (plan) rootOutcome = await process(plan);

	const wanted = new Set<string>(plan ? [...walkPlan(plan)].map(node => node.key) : []);
	const orphans = await findOrphanDirs(root, wanted);
	for (const key of orphans) {
		report.derived.push({ key, detail: "orphan node directory (no atoms map here)" });
		if (!dryRun) {
			await beginMutation();
			await removeNodeDir(root, key);
		}
		report.nodes.pruned++;
	}
	if (!plan) {
		// No atoms: an empty corpus has no view.
		report.complete = !dryRun;
		if (!dryRun && previous) await removeNodeDir(root, "");
		return report;
	}

	const settled = rootOutcome?.outcome === "fresh" || rootOutcome?.outcome === "generated";
	const unsettled = report.nodes.stale + report.nodes.blocked + report.nodes.failed + report.nodes.outsideWindow;
	report.complete = !dryRun && settled && unsettled === 0;
	if (!dryRun) {
		await writeViewManifest(root, {
			format: "chronicle-view",
			version: VIEW_FORMAT_VERSION,
			timeZone: config.timeZone,
			config,
			complete: report.complete,
			startedAt,
			indexedAt: new Date().toISOString(),
			atomCount: corpus.atoms.length,
			summaryModel: options.summarizer?.identity,
		});
	}
	return report;
}

async function generateInterior(
	base: Omit<ViewNode, "contentHash" | "children" | "provenance" | "overview" | "atoms">,
	children: readonly Processed[],
	config: IndexConfig,
	options: IndexOptions,
	limiter: Limiter,
	report: IndexReport,
): Promise<ViewNode> {
	const current = children.map(child => child.node!);
	const overviewBudget = overviewTokens(config);
	// Every routing line spends tokens on its label and key before the description.
	const overhead = current.reduce((sum, child) => sum + estimateTokens(routeLinePrefix(child)), 0);
	const childBudget = Math.max(
		MIN_DESCRIPTION_TOKENS,
		Math.floor((config.hopTokens - overviewBudget - overhead) / current.length),
	);
	const refs = (descriptions: readonly string[]): ViewChildRef[] =>
		current.map((child, index) => ({
			key: child.key,
			segment: child.segment,
			level: child.level,
			label: child.label,
			localStart: child.localStart,
			localEnd: child.localEnd,
			start: child.start,
			end: child.end,
			atomCount: child.atomCount,
			projects: child.projects,
			sessions: child.sessions,
			identity: child.identity,
			contentHash: child.contentHash,
			description: descriptions[index]!,
		}));

	if (current.length === 1) {
		// A single child's whole routing text is reused verbatim when it fits
		// the description budget; otherwise a non-terminal child's own overview
		// (already within budget) stands in. Only an oversized terminal child
		// needs the model.
		const only = current[0]!;
		const whole = routingText(only);
		const reuse = estimateTokens(whole) <= childBudget ? whole : only.atoms ? undefined : (only.overview ?? "");
		if (reuse !== undefined) {
			const titles = only.atoms
				? clipText(
						`${only.atomCount} atom(s): ${only.atoms.map(atom => atom.title).join("; ")}`,
						overviewBudget * 4,
					)
				: undefined;
			const node: ViewNode = {
				...base,
				contentHash: "",
				overview: titles ? `${titles.text}${titles.remainder > 0 ? "…" : ""}` : (only.overview ?? ""),
				children: refs([reuse]),
				provenance: { kind: "single-child", generatedAt: new Date().toISOString(), truncated: false },
			};
			node.contentHash = computeContentHash(node);
			report.nodes.singleChild++;
			return node;
		}
	}

	const summarizer = options.summarizer;
	if (!summarizer) throw new Error("no chronicler-summary model resolved");
	const inputs: SummaryChildInput[] = current.map(child => ({
		key: child.key,
		label: child.label,
		level: child.level,
		localStart: child.localStart,
		localEnd: child.localEnd,
		atomCount: child.atomCount,
		projects: child.projects,
		text: routingText(child),
	}));
	const output = await limiter.run(() =>
		summarizer.summarize(
			{
				key: base.key,
				label: base.label,
				level: base.level,
				localStart: base.localStart,
				localEnd: base.localEnd,
				atomCount: base.atomCount,
				projects: base.projects,
			},
			inputs,
			{
				overviewTokens: overviewBudget,
				childTokens: Math.min(
					childBudget,
					Math.max(MIN_DESCRIPTION_TOKENS, Math.floor((config.summaryTokens - overviewBudget) / current.length)),
				),
				childCeilingTokens: childBudget,
			},
			options.signal,
		),
	);
	const node: ViewNode = {
		...base,
		contentHash: "",
		overview: output.overview,
		children: refs(output.descriptions),
		provenance: {
			kind: "generated",
			model: summarizer.identity,
			promptVersion: SUMMARY_PROMPT_VERSION,
			generatedAt: new Date().toISOString(),
			truncated: output.truncated,
			inputTokens: inputs.reduce((sum, input) => sum + estimateTokens(input.text) + ROUTE_OVERHEAD_TOKENS, 0),
		},
	};
	node.contentHash = computeContentHash(node);
	return node;
}
