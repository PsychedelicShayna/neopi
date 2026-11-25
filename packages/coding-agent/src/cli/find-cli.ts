/**
 * Run the semantic `find` tool's cascade from the shell. Same search as the
 * tool, printed as a ranked, colored digest (or JSON).
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatBytes, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { cfgNoJudge, cfgNoSpotlight, cfgOffline } from "../config/auxiliary-model-policy";
import { InternalUrlFilesystem, isUrlPath } from "../internal-urls/url-filesystem";
import { openStandaloneJudge } from "../judgment/standalone";
import { standaloneFindSpotlight } from "../spotlight/session";
import { formatPathRelativeToCwd, resolveSearchResultPath } from "../tools/path-utils";
import { type CascadeResult, runCascade } from "../tools/jfind/cascade";
import { rankedHeat } from "../tools/jfind/passages";
import { resolveSearchRoot, type SearchRoot } from "../tools/jfind/tree";
import { cfgFindHitThreshold, cfgFindVerifyModel } from "../tools/settings";

export interface FindCommandArgs {
	query: string;
	path: string;
	keywords: string[];
	hidden: boolean;
	json: boolean;
	quiet: boolean;
	noJudge?: boolean;
	noSpotlight?: boolean;
	offline?: boolean;
}

/** Ranges printed per hit. */
const RANGES_SHOWN = 3;
/** Cells in the score gauge. */
const GAUGE_WIDTH = 6;

function scoreStyle(p: number): (text: string) => string {
	return p >= 0.7 ? chalk.green : p >= 0.4 ? chalk.yellow : chalk.dim;
}

function gauge(p: number): string {
	const filled = Math.round(p * GAUGE_WIDTH);
	return scoreStyle(p)("━".repeat(filled)) + chalk.dim("─".repeat(GAUGE_WIDTH - filled));
}

function printReport(cmd: FindCommandArgs, rel: string, result: CascadeResult, elapsedMs: number): void {
	const { hits, stats, threshold, coverage } = result;
	console.log("");
	if (coverage === "unavailable") {
		console.log(
			`${chalk.red(t("cli.commands.find.unavailable"))} ${chalk.dim(
				t("cli.commands.find.unavailableDetail", { query: cmd.query, path: rel, requests: stats.requests }),
			)}`,
		);
	} else if (hits.length === 0) {
		console.log(
			`${chalk.yellow(t("cli.commands.find.noHits"))} ${chalk.dim(
				t("cli.commands.find.noHitsDetail", { query: cmd.query, path: rel, threshold: threshold.toFixed(2) }),
			)}`,
		);
	} else {
		console.log(
			`${chalk.bold(t("cli.commands.find.hits", { count: hits.length }))} ${chalk.dim(
				t("cli.commands.find.hitsDetail", { query: cmd.query, path: rel, threshold: threshold.toFixed(2) }),
			)}`,
		);
		console.log("");
		for (const hit of hits) {
			const coverage = t(hit.truncated ? "cli.commands.find.linesPartial" : "cli.commands.find.lines", {
				count: hit.linesSeen,
			});
			console.log(
				`${gauge(hit.contentScore)} ${scoreStyle(hit.contentScore)(hit.contentScore.toFixed(2))} ${chalk.cyan(hit.rel)} ${chalk.dim(coverage)}`,
			);
			for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
				const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
				console.log(
					`  ${chalk.dim("└─")} ${chalk.cyan(`${hit.rel}:${span}`)} ${chalk.dim(range.p.toFixed(2))} ${range.snippet.trim()}`,
				);
			}
		}
	}
	if (coverage === "unavailable" && result.lexicalFallback.length > 0) {
		console.log(chalk.dim(t("cli.commands.find.literalFallback")));
		for (const match of result.lexicalFallback) {
			console.log(`  ${chalk.cyan(`${match.rel}:${match.line}`)}  ${match.snippet}`);
		}
	}
	if (coverage === "partial") {
		console.log(chalk.yellow(t("cli.commands.find.partial", { failed: stats.failed, requests: stats.requests })));
	}
	console.log("");
	console.log(
		chalk.dim(
			t("cli.commands.find.stats", {
				listed: stats.listed,
				judged: stats.judged,
				files: stats.filesRead,
				bytes: formatBytes(stats.fileBytes),
				requests: stats.requests,
				unanswered: stats.unanswered > 0 ? t("cli.commands.find.unanswered", { count: stats.unanswered }) : "",
				tokens: formatNumber(stats.inputTokens),
				cost: stats.cost.toFixed(4),
				elapsed: formatDuration(elapsedMs),
				api: formatDuration(stats.apiMs),
			}),
		),
	);
	for (const failure of stats.failures) console.log(chalk.yellow(failure));
}

/** Run one search and print it. Exits non-zero on a bad root or when every judge request failed. */
export async function runFindCommand(cmd: FindCommandArgs): Promise<void> {
	if (!cmd.query.trim()) {
		console.error(chalk.red(t("cli.commands.find.missingQuery")));
		process.exit(1);
	}
	const log = cmd.quiet ? () => {} : (message: string) => console.error(chalk.dim(message));
	const cwd = process.cwd();
	// Internal URLs (`omp://`, `local://`, …) are searched in place; `find` only reads.
	const filesystem = new InternalUrlFilesystem({ context: { cwd }, tier: "read" });
	let root: SearchRoot;
	try {
		root = await resolveSearchRoot(filesystem, cmd.path, cwd);
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		console.error(chalk.red(t("cli.commands.grep.error", { error: error.message })));
		process.exit(1);
	}

	// Settings and extensions belong to the searched project; a file or URL
	// scope has none of its own, so it keeps the caller's.
	const baseCwd = root.type === "directory" && !isUrlPath(root.path) ? root.path : cwd;
	log(t("cli.commands.find.resolvingJudge"));
	const { judge, settings, leadJudge, close } = await openStandaloneJudge(baseCwd, "find");
	if (cmd.noJudge) cfgNoJudge.override(settings, true);
	if (cmd.noSpotlight) cfgNoSpotlight.override(settings, true);
	if (cmd.offline) cfgOffline.override(settings, true);
	const verifyModel = cfgFindVerifyModel.get(settings)?.trim();
	const verifyJudge = verifyModel ? leadJudge(verifyModel) : undefined;
	const spotlight = standaloneFindSpotlight(settings);
	try {
		const started = performance.now();
		const raw = await runCascade({
			root,
			filesystem,
			query: cmd.query.trim(),
			extraKeywords: cmd.keywords,
			judge,
			verifyJudge,
			spotlight,
			includeHidden: cmd.hidden,
			threshold: cfgFindHitThreshold.get(settings),
			onProgress: log,
		});
		// Hits print as paths usable from the caller's cwd: relative files or URLs.
		const result: CascadeResult = {
			...raw,
			hits: raw.hits.map(hit => ({
				...hit,
				rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), cwd),
			})),
			lexicalFallback: raw.lexicalFallback.map(match => ({
				...match,
				rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, match.rel), cwd),
			})),
		};
		const elapsedMs = performance.now() - started;
		if (cmd.json) {
			console.log(JSON.stringify({ query: cmd.query, root: root.path, elapsedMs, ...result }, null, 2));
		} else {
			printReport(cmd, formatPathRelativeToCwd(root.path, cwd), result, elapsedMs);
		}
		// `exitCode`, not `exit`: process.exit skips the finally below, and with it close().
		if (result.coverage === "unavailable") process.exitCode = 1;
	} finally {
		spotlight?.client.close();
		close();
	}
}
