/** Settings shared by the explicit indexing CLI and recall consumers. */
import * as path from "node:path";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { JudgeDeps } from "../../judgment";
import { DEFAULT_RECALL_BRANCH_FLOORS } from "../recall-policy";
import * as cfg from "../settings";
import { resolveTimeZone } from "./calendar";
import { resolveChronicleModelClient } from "./model";
import { createJudgeRanker } from "./judge-rank";
import { createModelRanker, lexicalRanker, type NodeRanker, type RankResponsePolicy } from "./rank";
import type { RecallPolicy } from "./recall";
import type { SummaryPolicy } from "./summarize";
import type { IndexConfig } from "./tree";

function positive(value: number | undefined, fallback: number, min = 1): number {
	return Number.isFinite(value) && (value ?? 0) >= min ? Math.floor(value!) : fallback;
}

export function resolveViewRoot(settings: Settings, agentDir: string): string {
	const configured = cfg.cfgChroniclerIndexDir.get(settings)?.trim();
	return configured ? path.resolve(configured) : path.join(agentDir, "chronicle");
}

export function indexConfigFromSettings(settings: Settings): IndexConfig {
	return {
		timeZone: resolveTimeZone(cfg.cfgChroniclerIndexTimezone.get(settings)),
		summaryTokens: positive(cfg.cfgChroniclerIndexSummaryTokens.get(settings), 500, 50),
		hopTokens: positive(cfg.cfgChroniclerIndexHopTokens.get(settings), 1000, 200),
		terminalAtoms: positive(cfg.cfgChroniclerIndexTerminalAtoms.get(settings), 8),
		leadTokens: positive(cfg.cfgChroniclerIndexLeadTokens.get(settings), 120, 20),
		shortNames: cfg.cfgChroniclerIndexShortNames.get(settings) === true,
		titleChars: positive(cfg.cfgChroniclerIndexTitleChars.get(settings), 160),
		slugChars: positive(cfg.cfgChroniclerIndexSlugChars.get(settings), 60),
		overviewShare: cfg.cfgChroniclerIndexOverviewShare.get(settings)!,
		overviewHopShare: cfg.cfgChroniclerIndexOverviewHopShare.get(settings)!,
		overviewMinTokens: positive(cfg.cfgChroniclerIndexOverviewMinTokens.get(settings), 40),
		summaryWordsPerToken: cfg.cfgChroniclerIndexSummaryWordsPerToken.get(settings)!,
		summaryMinWords: positive(cfg.cfgChroniclerIndexSummaryMinWords.get(settings), 8),
		summaryResponseMinTokens: positive(cfg.cfgChroniclerIndexSummaryResponseMinTokens.get(settings), 512),
		summaryResponseMultiplier: cfg.cfgChroniclerIndexSummaryResponseMultiplier.get(settings)!,
		summaryResponsePaddingTokens: positive(cfg.cfgChroniclerIndexSummaryResponsePaddingTokens.get(settings), 256, 0),
	};
}

export function indexConcurrencyFromSettings(settings: Settings): number {
	return positive(cfg.cfgChroniclerIndexConcurrency.get(settings), 4);
}

export function summaryPolicyFromSettings(settings: Settings): SummaryPolicy {
	return {
		wordsPerToken: cfg.cfgChroniclerIndexSummaryWordsPerToken.get(settings)!,
		minWords: positive(cfg.cfgChroniclerIndexSummaryMinWords.get(settings), 8),
		responseMinTokens: positive(cfg.cfgChroniclerIndexSummaryResponseMinTokens.get(settings), 512),
		responseMultiplier: cfg.cfgChroniclerIndexSummaryResponseMultiplier.get(settings)!,
		responsePaddingTokens: positive(cfg.cfgChroniclerIndexSummaryResponsePaddingTokens.get(settings), 256, 0),
	};
}

export interface RecallDefaults {
	beam: number;
	budget: number;
	neighborhoodMinutes: number;
	policy: RecallPolicy;
}

export function recallDefaultsFromSettings(settings: Settings): RecallDefaults {
	return {
		beam: positive(cfg.cfgChroniclerRecallBeam.get(settings), 2),
		budget: positive(cfg.cfgChroniclerRecallResults.get(settings), 5),
		neighborhoodMinutes: positive(cfg.cfgChroniclerRecallNeighborhoodMinutes.get(settings), 90),
		policy: {
			dropRatio: cfg.cfgChroniclerRecallDropRatio.get(settings)!,
			confidence: cfg.cfgChroniclerRecallConfidence.get(settings)!,
			atomMin: cfg.cfgChroniclerRecallAtomMin.get(settings)!,
			tieMargin: cfg.cfgChroniclerRecallTieMargin.get(settings)!,
			frontierFactor: positive(cfg.cfgChroniclerRecallFrontierFactor.get(settings), 4),
			maxHops: positive(cfg.cfgChroniclerRecallMaxHops.get(settings), 32),
			evidenceChars: positive(cfg.cfgChroniclerRecallEvidenceChars.get(settings), 12000),
			maxNeighbors: positive(cfg.cfgChroniclerRecallMaxNeighbors.get(settings), 6, 0),
			candidatePeriods: positive(cfg.cfgChroniclerRecallCandidatePeriods.get(settings), 5),
			queryShare: cfg.cfgChroniclerRecallQueryShare.get(settings)!,
			labelShare: cfg.cfgChroniclerRecallLabelShare.get(settings)!,
			adjacentShare: cfg.cfgChroniclerRecallAdjacentShare.get(settings)!,
			concurrency: positive(cfg.cfgChroniclerRecallConcurrency.get(settings), 2),
			branchFloor: { ...DEFAULT_RECALL_BRANCH_FLOORS, ...cfg.cfgChroniclerRecallBranchFloor.get(settings) },
		},
	};
}

export function recallFormatFromSettings(settings: Settings, cli = false) {
	return {
		traceLimit: positive(
			(cli ? cfg.cfgChroniclerRecallCliTraceLimit : cfg.cfgChroniclerRecallTraceLimit).get(settings),
			cli ? 200 : 24,
			0,
		),
		traceCandidates: positive(cfg.cfgChroniclerRecallTraceCandidates.get(settings), 8),
	};
}

export function rankResponsePolicyFromSettings(settings: Settings): RankResponsePolicy {
	return {
		minTokens: positive(cfg.cfgChroniclerRecallResponseMinTokens.get(settings), 256),
		tokensPerCandidate: positive(cfg.cfgChroniclerRecallResponseTokensPerCandidate.get(settings), 24),
		paddingTokens: positive(cfg.cfgChroniclerRecallResponsePaddingTokens.get(settings), 64, 0),
	};
}

/** Resolve explicit ranking policy; unavailable judges fall back visibly on each request. */
export async function resolveRanker(
	settings: Settings,
	modelRegistry: ModelRegistry | undefined,
	override?: "model" | "lexical" | "judge",
	context?: Pick<JudgeDeps, "sessionId" | "onUsage" | "telemetry" | "costGate">,
): Promise<NodeRanker> {
	const kind = override ?? cfg.cfgChroniclerRecallRanker.get(settings);
	if (kind === "judge") {
		if (!modelRegistry) return createJudgeRanker(undefined);
		// The judge resolver's dependency graph must not load during CLI discovery.
		const { judgeRoleChain, resolveJudge, sharedJudgmentCache } = await import("../../judgment");
		const judge =
			judgeRoleChain(settings, modelRegistry).length > 0
				? resolveJudge({
						settings,
						registry: modelRegistry,
						...context,
						purpose: "chronicle-recall",
						cache: sharedJudgmentCache(),
					})
				: undefined;
		return createJudgeRanker(judge);
	}
	if (kind === "lexical" || !modelRegistry) return lexicalRanker;
	const client = resolveChronicleModelClient(settings, modelRegistry, "chronicler-recall");
	return client ? createModelRanker(client, rankResponsePolicyFromSettings(settings)) : lexicalRanker;
}
