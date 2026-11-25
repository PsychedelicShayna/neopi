/**
 * Web search CLI command handlers.
 *
 * Handles the `q`/`web-search` subcommands for testing web search models.
 */

import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { Settings } from "../config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { renderSearchResult } from "@oh-my-pi/pi-tui/tools/web-search";
import { runSearchQuery, type SearchQueryParams } from "../web/search/index";

export interface SearchCommandArgs {
	query: string;
	model?: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
}

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];

/**
 * Parse web search subcommand arguments.
 * Returns undefined if not a web search command.
 */
export function parseSearchArgs(args: string[]): SearchCommandArgs | undefined {
	if (args.length === 0 || (args[0] !== "q" && args[0] !== "web-search")) {
		return undefined;
	}

	const result: SearchCommandArgs = {
		query: "",
		expanded: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model") {
			result.model = args[++i];
		} else if (arg.startsWith("--model=")) {
			result.model = arg.slice("--model=".length);
		} else if (arg === "--recency") {
			result.recency = args[++i] as SearchCommandArgs["recency"];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = Number.parseInt(args[++i], 10);
		} else if (arg === "--compact") {
			result.expanded = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length > 0) {
		result.query = positional.join(" ");
	}

	return result;
}

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red(t("cli.commands.webSearch.missingQuery"))}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(t("cli.commands.webSearch.invalidRecency", { recency: cmd.recency }))}\n`);
		process.stderr.write(
			`${chalk.dim(t("cli.commands.webSearch.validRecency", { values: RECENCY_OPTIONS.join(", ") }))}\n`,
		);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red(t("cli.commands.webSearch.invalidLimit"))}\n`);
		process.exit(1);
	}

	await Settings.init({ cwd: getProjectDir() });

	await initTheme();

	const params: SearchQueryParams = {
		query: cmd.query,
		model: cmd.model,
		recency: cmd.recency,
		limit: cmd.limit,
	};

	const result = await runSearchQuery(params);
	const component = renderSearchResult(result, { expanded: cmd.expanded, isPartial: false }, theme, {
		query: cmd.query,
		maxAnswerLines: cmd.expanded ? undefined : 6,
	});

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${component.render(width).join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}

export function printSearchHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} q`)} - ${t("cli.commands.webSearch.helpDescription")}

${chalk.bold(t("cli.commands.grep.helpUsage"))}
  ${APP_NAME} q [options] <query>
  ${APP_NAME} web-search [options] <query>

${chalk.bold(t("cli.commands.grep.helpArguments"))}
  query      ${t("cli.commands.webSearch.helpQuery")}

${chalk.bold(t("cli.config.help.options"))}
  --model <selector>  ${t("cli.commands.webSearch.helpModel")}
  --recency <value>   ${t("cli.commands.webSearch.helpRecency", { values: RECENCY_OPTIONS.join(", ") })}
  -l, --limit <n>     ${t("cli.commands.webSearch.helpLimit")}
  --compact           ${t("cli.commands.webSearch.helpCompact")}
  -h, --help          ${t("cli.commands.grep.helpFlag")}

${chalk.bold(t("cli.commands.webSearch.helpDirectives"))}
  site:/-site:  after:/before: (YYYY-MM-DD)  inurl:  intitle:  filetype:
  "exact phrase"  -term  OR
${t("cli.commands.webSearch.helpFilters")}

${chalk.bold(t("cli.config.help.examples"))}
  ${APP_NAME} q --model=web/duckduckgo "what's the color of the sky"
  ${APP_NAME} q --model=openrouter/google/gemini-2.5-flash --recency=week "latest TypeScript changes"
  ${APP_NAME} q 'transformer scaling site:arxiv.org after:2024 -site:reddit.com'
`);
}
