/**
 * `npi chronicle index` and `npi chronicle recall`: build the derived temporal
 * view over every session's committed atoms, and query it.
 */
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { cfgChroniclerIndexDiagnosticLimit, cfgChroniclerRecallRanker } from "../chronicler/settings";
import { parseTimeBound, type TimeBound } from "../chronicler/temporal/calendar";
import {
	indexConfigFromSettings,
	indexConcurrencyFromSettings,
	recallDefaultsFromSettings,
	recallFormatFromSettings,
	resolveRanker,
	resolveViewRoot,
	summaryPolicyFromSettings,
} from "../chronicler/temporal/config";
import { formatIndexReport, formatRecallResult } from "../chronicler/temporal/format";
import { indexChronicle } from "../chronicler/temporal/indexer";
import { resolveChronicleModelClient } from "../chronicler/temporal/model";
import { recallChronicle } from "../chronicler/temporal/recall";
import { parseKeywords, type RecallScope, resolveRecallSessions } from "../chronicler/temporal/prefilter";
import { createSummarizer } from "../chronicler/temporal/summarize";
import { RESOLUTION_LEVELS, type Resolution } from "../chronicler/temporal/tree";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

export interface ChronicleIndexFlags {
	rebuild?: boolean;
	dryRun?: boolean;
	since?: string;
	until?: string;
	json?: boolean;
	agentDir?: string;
}

export interface ChronicleRecallFlags {
	query: string;
	from?: string;
	to?: string;
	project?: string;
	session?: string;
	scope?: RecallScope;
	sessions?: string[];
	keywords?: string;
	keywordCaseSensitive?: boolean;
	hint?: string;
	resolution?: string;
	node?: string;
	budget?: number;
	beam?: number;
	ranker?: string;
	json?: boolean;
	agentDir?: string;
}

function bound(value: string | undefined, flag: string): TimeBound | undefined {
	if (value === undefined) return undefined;
	try {
		return parseTimeBound(value);
	} catch {
		throw new CliUsageError(`--${flag} must be an ISO time or a YYYY[-MM[-DD]] prefix: ${value}`);
	}
}

async function withRegistry<T>(settings: Settings, agentDir: string, run: (registry: ModelRegistry) => Promise<T>) {
	const authStorage = await discoverAuthStorage(agentDir, { settings, cwd: settings.getCwd() });
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, settings.getCwd());
		return await run(registry);
	} finally {
		authStorage.close();
	}
}

export async function runChronicleIndex(flags: ChronicleIndexFlags): Promise<number> {
	const agentDir = flags.agentDir ?? getAgentDir();
	const settings = await Settings.init({ cwd: getProjectDir(), agentDir });
	const config = indexConfigFromSettings(settings);
	const since = bound(flags.since, "since");
	const until = bound(flags.until, "until");
	const report = await withRegistry(settings, agentDir, async registry => {
		const client = resolveChronicleModelClient(settings, registry);
		return indexChronicle({
			agentDir,
			root: resolveViewRoot(settings, agentDir),
			config,
			summarizer: client ? createSummarizer(client, summaryPolicyFromSettings(settings)) : undefined,
			concurrency: indexConcurrencyFromSettings(settings),
			rebuild: flags.rebuild,
			dryRun: flags.dryRun,
			since,
			until,
			onProgress: flags.json ? undefined : message => process.stderr.write(`\r\x1b[2K${message}`),
		});
	});
	if (!flags.json) process.stderr.write("\r\x1b[2K");
	process.stdout.write(
		`${flags.json ? JSON.stringify(report, null, 2) : formatIndexReport(report, cfgChroniclerIndexDiagnosticLimit.get(settings))}\n`,
	);
	return report.nodes.failed > 0 ? 1 : 0;
}

export async function runChronicleRecall(flags: ChronicleRecallFlags): Promise<number> {
	if (!flags.query.trim()) throw new CliUsageError("recall needs a query");
	if (flags.resolution !== undefined && !(RESOLUTION_LEVELS as readonly string[]).includes(flags.resolution)) {
		throw new CliUsageError(`--resolution must be one of ${RESOLUTION_LEVELS.join(", ")}`);
	}
	if (
		flags.ranker !== undefined &&
		flags.ranker !== "model" &&
		flags.ranker !== "lexical" &&
		flags.ranker !== "judge"
	) {
		throw new CliUsageError("--ranker must be model, lexical or judge");
	}
	const agentDir = flags.agentDir ?? getAgentDir();
	const settings = await Settings.init({ cwd: getProjectDir(), agentDir });
	const defaults = recallDefaultsFromSettings(settings);
	const from = bound(flags.from, "from");
	const to = bound(flags.to, "to");
	if (flags.keywords !== undefined) parseKeywords(flags.keywords);
	const sessions = resolveRecallSessions({
		...flags,
		scope: flags.scope ?? "all",
		currentSessionId: process.env.PI_SESSION_ID,
	});
	const run = async (registry: ModelRegistry | undefined) =>
		recallChronicle({
			root: resolveViewRoot(settings, agentDir),
			query: flags.query,
			from,
			to,
			project: flags.project,
			sessions,
			keywords: flags.keywords,
			keywordCaseSensitive: flags.keywordCaseSensitive,
			sessionsDir: path.join(agentDir, "sessions"),
			hint: flags.hint,
			resolution: flags.resolution as Resolution | undefined,
			node: flags.node,
			budget: flags.budget ?? defaults.budget,
			beam: flags.beam ?? defaults.beam,
			neighborhoodMinutes: defaults.neighborhoodMinutes,
			policy: defaults.policy,
			ranker: await resolveRanker(settings, registry, flags.ranker as "model" | "lexical" | "judge" | undefined),
		});
	const wantsRegistry = (flags.ranker ?? cfgChroniclerRecallRanker.get(settings)) !== "lexical";
	const result = wantsRegistry ? await withRegistry(settings, agentDir, run) : await run(undefined);
	process.stdout.write(
		`${flags.json ? JSON.stringify(result, null, 2) : formatRecallResult(result, recallFormatFromSettings(settings, true))}\n`,
	);
	return 0;
}
