/** Chronicler settings, in settings-panel order. */
import { register } from "../config/registry";

export * from "./capture-settings";
export * from "./backfill-settings";

function numberSetting(id: string, value: number, label: string, description: string, min = 1, max?: number) {
	return register({
		id,
		type: "number",
		default: value,
		validate(raw) {
			if (raw === undefined) return;
			if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || (max !== undefined && raw > max)) {
				throw new Error(`${id} must be a finite number >= ${min}${max === undefined ? "" : ` and <= ${max}`}`);
			}
		},
		ui: {
			tab: "memory",
			group: "Chronicler",
			label,
			description,
			options: [{ value: String(value), label: `${value} (default)` }],
			customInput: true,
		},
	});
}

export const cfgChroniclerEnabled = register({
	id: "chronicler.enabled",
	type: "boolean",
	allowAsk: true,
	default: false,
	ui: {
		tab: "memory",
		group: "Chronicler",
		label: "Chronicler capture",
		description:
			"Continuously capture semantic beats using the @chronicler role. Ask requests consent for each session. Independent of Memory Backend; both may be on.",
	},
});
export const cfgChroniclerRecallEnabled = register({
	id: "chronicler.recall.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Chronicler",
		label: "Chronicler recall tool",
		description:
			"Grant top-level sessions chronicle_recall over the view built on demand by npi chronicle index. Subagents need an explicit tool grant. Nothing is injected at session start.",
	},
});
export const cfgChroniclerIndexDir = register({
	id: "chronicler.index.dir",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Chronicler",
		label: "Index directory",
		description: "Derived temporal view directory. Empty uses the agent directory's chronicle folder.",
	},
});
export const cfgChroniclerIndexTimezone = register({
	id: "chronicler.index.timezone",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Chronicler",
		label: "Index timezone",
		description: "IANA timezone for calendar buckets. Empty uses the system timezone.",
	},
});
export const cfgChroniclerIndexSummaryTokens = numberSetting(
	"chronicler.index.summaryTokens",
	500,
	"Summary target tokens",
	"Target token size of each generated index summary.",
	50,
);
export const cfgChroniclerIndexHopTokens = numberSetting(
	"chronicler.index.hopTokens",
	1000,
	"Traversal hop tokens",
	"Maximum routing or ranking tokens per traversal hop.",
	200,
);
export const cfgChroniclerIndexTerminalAtoms = numberSetting(
	"chronicler.index.terminalAtoms",
	8,
	"Atoms per terminal bucket",
	"Atom budget before a terminal bucket splits into smaller periods.",
);
export const cfgChroniclerIndexLeadTokens = numberSetting(
	"chronicler.index.leadTokens",
	120,
	"Atom lead tokens",
	"Token budget for each atom's leading description in terminal buckets.",
	20,
);
export const cfgChroniclerIndexShortNames = register({
	id: "chronicler.index.shortNames",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Chronicler",
		label: "Short index filenames",
		description: "Omit title slugs from derived atom filenames for restrictive filesystems.",
	},
});
export const cfgChroniclerIndexConcurrency = numberSetting(
	"chronicler.index.concurrency",
	4,
	"Index summary concurrency",
	"Maximum parallel model calls while explicitly indexing the Chronicle.",
);
export const cfgChroniclerIndexTitleChars = numberSetting(
	"chronicler.index.titleChars",
	160,
	"Routing title characters",
	"Maximum title characters included in an atom's routing text.",
);
export const cfgChroniclerIndexSlugChars = numberSetting(
	"chronicler.index.slugChars",
	60,
	"Index filename slug characters",
	"Maximum title slug characters in derived atom filenames.",
);
export const cfgChroniclerIndexOverviewShare = numberSetting(
	"chronicler.index.overviewShare",
	0.3,
	"Summary overview share",
	"Fraction of the summary target reserved for the node overview.",
	0,
	1,
);
export const cfgChroniclerIndexOverviewHopShare = numberSetting(
	"chronicler.index.overviewHopShare",
	1 / 3,
	"Overview hop share",
	"Maximum fraction of a traversal hop reserved for the overview.",
	0,
	1,
);
export const cfgChroniclerIndexOverviewMinTokens = numberSetting(
	"chronicler.index.overviewMinTokens",
	40,
	"Minimum overview tokens",
	"Minimum overview budget, subject to the traversal hop ceiling.",
);
export const cfgChroniclerIndexSummaryWordsPerToken = numberSetting(
	"chronicler.index.summaryWordsPerToken",
	0.7,
	"Summary words per target token",
	"Convert summary token targets to the word limits requested from the model.",
	0.01,
);
export const cfgChroniclerIndexSummaryMinWords = numberSetting(
	"chronicler.index.summaryMinWords",
	8,
	"Minimum summary words",
	"Minimum word limit requested for each overview and child description.",
);
export const cfgChroniclerRecallBeam = numberSetting(
	"chronicler.recall.beam",
	2,
	"Recall beam width",
	"Branches retained per expansion, including the best branch.",
);
export const cfgChroniclerRecallResults = numberSetting(
	"chronicler.recall.results",
	5,
	"Recall result limit",
	"Default maximum number of canonical atoms returned per recall.",
);
export const cfgChroniclerRecallRanker = register({
	id: "chronicler.recall.ranker",
	type: "enum",
	values: ["model", "lexical"] as const,
	default: "model",
	ui: {
		tab: "memory",
		group: "Chronicler",
		label: "Recall ranker",
		description:
			"Rank branches with the chronicler-recall model or deterministic lexical coverage. Model ranking falls back to lexical when unavailable.",
	},
});
export const cfgChroniclerRecallNeighborhoodMinutes = numberSetting(
	"chronicler.recall.neighborhoodMinutes",
	90,
	"Recall neighborhood minutes",
	"Temporal window around an anchor or confident atom for adjacency and neighbors.",
);
export const cfgChroniclerRecallDropRatio = numberSetting(
	"chronicler.recall.dropRatio",
	0.5,
	"Recall relevance drop ratio",
	"Mark a non-confident branch collapsed when its best child scores below this fraction of its parent.",
	0,
	1,
);
export const cfgChroniclerRecallConfidence = numberSetting(
	"chronicler.recall.confidence",
	0.6,
	"Recall confidence threshold",
	"Minimum absolute score for a confident atom match.",
	0,
	1,
);
export const cfgChroniclerRecallAtomMin = numberSetting(
	"chronicler.recall.atomMin",
	0.25,
	"Recall minimum atom score",
	"Minimum score for descent results and temporal hint anchors.",
	0,
	1,
);
export const cfgChroniclerRecallTieMargin = numberSetting(
	"chronicler.recall.tieMargin",
	0.1,
	"Recall tie margin",
	"Keep near-tied branches and report ambiguity within this score margin.",
	0,
	1,
);
export const cfgChroniclerRecallFrontierFactor = numberSetting(
	"chronicler.recall.frontierFactor",
	4,
	"Recall frontier multiplier",
	"Multiply the beam width by this value to bound retained search branches.",
);
export const cfgChroniclerRecallMaxHops = numberSetting(
	"chronicler.recall.maxHops",
	32,
	"Recall maximum hops",
	"Maximum node expansions per query or adjacent-event search.",
);
export const cfgChroniclerRecallEvidenceChars = numberSetting(
	"chronicler.recall.evidenceChars",
	12000,
	"Recall evidence characters",
	"Maximum canonical body characters returned for each atom.",
);
export const cfgChroniclerRecallMaxNeighbors = numberSetting(
	"chronicler.recall.maxNeighbors",
	6,
	"Recall neighbor limit",
	"Maximum neighboring atom references returned per confident or adjacent result. Zero omits neighbors.",
	0,
);
export const cfgChroniclerRecallCandidatePeriods = numberSetting(
	"chronicler.recall.candidatePeriods",
	5,
	"Recall candidate period limit",
	"Maximum candidate periods returned for narrowing or ambiguous recall.",
);
export const cfgChroniclerRecallQueryShare = numberSetting(
	"chronicler.recall.queryShare",
	0.25,
	"Recall query hop share",
	"Maximum fraction of each ranking hop occupied by the recollection or hint.",
	0.01,
	0.9,
);
export const cfgChroniclerRecallLabelShare = numberSetting(
	"chronicler.recall.labelShare",
	0.5,
	"Recall candidate label share",
	"Maximum fraction of candidate space occupied by its label, leaving room for its text.",
	0.01,
	0.9,
);
export const cfgChroniclerRecallAdjacentShare = numberSetting(
	"chronicler.recall.adjacentShare",
	0.5,
	"Recall adjacent result share",
	"Fraction of results initially reserved for events near a matched hint anchor.",
	0,
	1,
);
export const cfgChroniclerRecallConcurrency = numberSetting(
	"chronicler.recall.concurrency",
	2,
	"Recall ranking concurrency",
	"Maximum parallel ranking requests shared by the query and hint searches.",
);
export const cfgChroniclerRecallTraceLimit = numberSetting(
	"chronicler.recall.traceLimit",
	24,
	"Recall tool trace steps",
	"Maximum trace steps shown in recall tool output. Zero hides trace steps.",
	0,
);
export const cfgChroniclerRecallCliTraceLimit = numberSetting(
	"chronicler.recall.cliTraceLimit",
	200,
	"Recall CLI trace steps",
	"Maximum trace steps shown by npi chronicle recall. Zero hides trace steps.",
	0,
);
export const cfgChroniclerRecallTraceCandidates = numberSetting(
	"chronicler.recall.traceCandidates",
	8,
	"Recall trace candidate limit",
	"Maximum ranked candidates shown per trace step.",
);
export const cfgChroniclerIndexDiagnosticLimit = numberSetting(
	"chronicler.index.diagnosticLimit",
	50,
	"Index diagnostic display limit",
	"Maximum pending-node and canonical-diagnostic entries shown in the index report. Derived-view diagnostics and JSON output remain complete.",
);
export const cfgChroniclerIndexSummaryResponseMinTokens = numberSetting(
	"chronicler.index.summaryResponseMinTokens",
	512,
	"Minimum summary response tokens",
	"Minimum completion-token allowance for each generated summary.",
);
export const cfgChroniclerIndexSummaryResponseMultiplier = numberSetting(
	"chronicler.index.summaryResponseMultiplier",
	2,
	"Summary response budget multiplier",
	"Multiply the overview and child-description token ceilings to allow for the model's response.",
	0.01,
);
export const cfgChroniclerIndexSummaryResponsePaddingTokens = numberSetting(
	"chronicler.index.summaryResponsePaddingTokens",
	256,
	"Summary response padding tokens",
	"Additional completion tokens above the multiplied summary budget.",
	0,
);
export const cfgChroniclerRecallResponseMinTokens = numberSetting(
	"chronicler.recall.responseMinTokens",
	256,
	"Minimum ranking response tokens",
	"Minimum completion-token allowance for each model-ranking request.",
);
export const cfgChroniclerRecallResponseTokensPerCandidate = numberSetting(
	"chronicler.recall.responseTokensPerCandidate",
	24,
	"Ranking response tokens per candidate",
	"Completion tokens reserved for each ranked candidate before response padding.",
);
export const cfgChroniclerRecallResponsePaddingTokens = numberSetting(
	"chronicler.recall.responsePaddingTokens",
	64,
	"Ranking response padding tokens",
	"Additional completion tokens above the per-candidate ranking budget.",
	0,
);
