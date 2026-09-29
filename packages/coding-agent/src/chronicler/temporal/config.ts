/**
 * Settings → temporal view configuration shared by the CLI and the recall tool.
 */
import * as path from "node:path";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import {
	cfgChroniclerIndexDir,
	cfgChroniclerIndexHopTokens,
	cfgChroniclerIndexLeadTokens,
	cfgChroniclerIndexShortNames,
	cfgChroniclerIndexSummaryTokens,
	cfgChroniclerIndexTerminalAtoms,
	cfgChroniclerIndexTimezone,
	cfgChroniclerRecallBeam,
	cfgChroniclerRecallNeighborhoodMinutes,
	cfgChroniclerRecallRanker,
	cfgChroniclerRecallResults,
} from "../settings";
import { resolveTimeZone } from "./calendar";
import { resolveChronicleModelClient } from "./model";
import { createModelRanker, lexicalRanker, type NodeRanker } from "./rank";
import type { IndexConfig } from "./tree";

const MIN_HOP_TOKENS = 200;

function positive(value: number | undefined, fallback: number, min = 1): number {
	return Number.isFinite(value) && (value ?? 0) >= min ? Math.floor(value!) : fallback;
}

export function resolveViewRoot(settings: Settings, agentDir: string): string {
	const configured = cfgChroniclerIndexDir.get(settings)?.trim();
	return configured ? path.resolve(configured) : path.join(agentDir, "chronicle");
}

export function indexConfigFromSettings(settings: Settings): IndexConfig {
	return {
		timeZone: resolveTimeZone(cfgChroniclerIndexTimezone.get(settings)),
		summaryTokens: positive(cfgChroniclerIndexSummaryTokens.get(settings), 500, 50),
		hopTokens: positive(cfgChroniclerIndexHopTokens.get(settings), 1000, MIN_HOP_TOKENS),
		terminalAtoms: positive(cfgChroniclerIndexTerminalAtoms.get(settings), 8),
		leadTokens: positive(cfgChroniclerIndexLeadTokens.get(settings), 120, 20),
		shortNames: cfgChroniclerIndexShortNames.get(settings) === true,
	};
}

export interface RecallDefaults {
	beam: number;
	budget: number;
	neighborhoodMinutes: number;
}

export function recallDefaultsFromSettings(settings: Settings): RecallDefaults {
	return {
		beam: positive(cfgChroniclerRecallBeam.get(settings), 2),
		budget: positive(cfgChroniclerRecallResults.get(settings), 5),
		neighborhoodMinutes: positive(cfgChroniclerRecallNeighborhoodMinutes.get(settings), 90),
	};
}

/** The configured ranker; a model ranker falls back to lexical when no summary model resolves. */
export function resolveRanker(
	settings: Settings,
	modelRegistry: ModelRegistry | undefined,
	override?: "model" | "lexical",
): NodeRanker {
	const kind = override ?? cfgChroniclerRecallRanker.get(settings);
	if (kind === "lexical" || !modelRegistry) return lexicalRanker;
	const client = resolveChronicleModelClient(settings, modelRegistry);
	return client ? createModelRanker(client) : lexicalRanker;
}
