/**
 * `npi chronicle index` and `npi chronicle recall`: build the derived temporal
 * view over every session's committed atoms, and query it.
 */
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { cfgChroniclerRecallRanker } from "../chronicler/settings";
import { parseTimeBound, type TimeBound } from "../chronicler/temporal/calendar";
import {
	indexConfigFromSettings,
	recallDefaultsFromSettings,
	resolveRanker,
	resolveViewRoot,
} from "../chronicler/temporal/config";
import { formatRecallResult } from "../chronicler/temporal/format";
import { type IndexReport, indexChronicle } from "../chronicler/temporal/indexer";
import { resolveChronicleModelClient } from "../chronicler/temporal/model";
import { recallChronicle } from "../chronicler/temporal/recall";
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

export function formatIndexReport(report: IndexReport): string {
	const n = report.nodes;
	const lines = [
		`Chronicle view ${report.dryRun ? "(dry run) " : ""}at ${report.root}`,
		`${report.atoms} atoms from ${report.sessions} sessions in ${report.projects} projects (${report.stores} stores)`,
		`summary model: ${report.summaryModel ?? "unresolved"}`,
		`nodes: ${n.total} total, ${n.fresh} fresh, ${n.generated} regenerated (${n.enumerated} enumerations, ${n.singleChild} single-child), ${n.stale} stale, ${n.blocked} blocked, ${n.outsideWindow} outside window, ${n.failed} failed, ${n.pruned} pruned`,
		`complete: ${report.complete ? "yes" : "no"}`,
	];
	const pending = report.changes.filter(change => change.outcome !== "generated");
	if (pending.length > 0) {
		lines.push("", "Not regenerated:");
		for (const change of pending.slice(0, 50)) {
			lines.push(
				`- ${change.key || "root"} (${change.level}): ${change.outcome}${change.reason ? ` [${change.reason}]` : ""}${change.detail ? ` — ${change.detail}` : ""}`,
			);
		}
		if (pending.length > 50) lines.push(`  … ${pending.length - 50} more (use --json)`);
	}
	if (report.canonical.length > 0) {
		lines.push("", `Canonical diagnostics (${report.canonical.length}; atoms untouched):`);
		for (const diagnostic of report.canonical.slice(0, 50)) {
			lines.push(
				`- ${diagnostic.kind}: ${diagnostic.atomId ? `${diagnostic.atomId} ` : ""}${diagnostic.path} — ${diagnostic.detail}`,
			);
		}
		if (report.canonical.length > 50) lines.push(`  … ${report.canonical.length - 50} more (use --json)`);
	}
	if (report.derived.length > 0) {
		lines.push("", `Derived view problems (${report.derived.length}):`);
		for (const problem of report.derived.slice(0, 50)) lines.push(`- ${problem.key || "root"}: ${problem.detail}`);
	}
	return lines.join("\n");
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
			summarizer: client ? createSummarizer(client) : undefined,
			rebuild: flags.rebuild,
			dryRun: flags.dryRun,
			since,
			until,
			onProgress: flags.json ? undefined : message => process.stderr.write(`\r\x1b[2K${message}`),
		});
	});
	if (!flags.json) process.stderr.write("\r\x1b[2K");
	process.stdout.write(`${flags.json ? JSON.stringify(report, null, 2) : formatIndexReport(report)}\n`);
	return report.nodes.failed > 0 ? 1 : 0;
}

export async function runChronicleRecall(flags: ChronicleRecallFlags): Promise<number> {
	if (!flags.query.trim()) throw new CliUsageError("recall needs a query");
	if (flags.resolution !== undefined && !(RESOLUTION_LEVELS as readonly string[]).includes(flags.resolution)) {
		throw new CliUsageError(`--resolution must be one of ${RESOLUTION_LEVELS.join(", ")}`);
	}
	if (flags.ranker !== undefined && flags.ranker !== "model" && flags.ranker !== "lexical") {
		throw new CliUsageError("--ranker must be model or lexical");
	}
	const agentDir = flags.agentDir ?? getAgentDir();
	const settings = await Settings.init({ cwd: getProjectDir(), agentDir });
	const defaults = recallDefaultsFromSettings(settings);
	const from = bound(flags.from, "from");
	const to = bound(flags.to, "to");
	const run = async (registry: ModelRegistry | undefined) =>
		recallChronicle({
			root: resolveViewRoot(settings, agentDir),
			query: flags.query,
			from,
			to,
			project: flags.project,
			session: flags.session,
			hint: flags.hint,
			resolution: flags.resolution as Resolution | undefined,
			node: flags.node,
			budget: flags.budget ?? defaults.budget,
			beam: flags.beam ?? defaults.beam,
			neighborhoodMinutes: defaults.neighborhoodMinutes,
			ranker: resolveRanker(settings, registry, flags.ranker as "model" | "lexical" | undefined),
		});
	const wantsModel = (flags.ranker ?? cfgChroniclerRecallRanker.get(settings)) === "model";
	const result = wantsModel ? await withRegistry(settings, agentDir, run) : await run(undefined);
	process.stdout.write(
		`${flags.json ? JSON.stringify(result, null, 2) : formatRecallResult(result, { traceLimit: 200 })}\n`,
	);
	return 0;
}
