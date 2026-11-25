/**
 * Grep CLI command handlers.
 *
 * Handles `npi grep` subcommand for testing grep tool on Windows.
 */
import * as path from "node:path";
import { GrepOutputMode, grep } from "@oh-my-pi/pi-natives";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { expandPath } from "../tools/path-utils";

export interface GrepCommandArgs {
	pattern: string;
	path: string;
	glob?: string;
	limit: number;
	context: number;
	mode: GrepOutputMode;
	gitignore: boolean;
}

/**
 * Parse grep subcommand arguments.
 * Returns undefined if not a grep command.
 */
export function parseGrepArgs(args: string[]): GrepCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "grep") {
		return undefined;
	}

	const result: GrepCommandArgs = {
		pattern: "",
		path: ".",
		limit: 20,
		context: 2,
		mode: GrepOutputMode.Content,
		gitignore: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--glob" || arg === "-g") {
			result.glob = args[++i];
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = parseInt(args[++i], 10);
		} else if (arg === "--context" || arg === "-C") {
			result.context = parseInt(args[++i], 10);
		} else if (arg === "--files" || arg === "-f") {
			result.mode = GrepOutputMode.FilesWithMatches;
		} else if (arg === "--count" || arg === "-c") {
			result.mode = GrepOutputMode.Count;
		} else if (arg === "--no-gitignore") {
			result.gitignore = false;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}

	if (positional.length >= 1) {
		result.pattern = positional[0];
	}
	if (positional.length >= 2) {
		result.path = positional[1];
	}

	return result;
}

export async function runGrepCommand(cmd: GrepCommandArgs): Promise<void> {
	if (!cmd.pattern) {
		console.error(chalk.red(t("cli.commands.grep.missingPattern")));
		process.exit(1);
	}

	const searchPath = path.resolve(expandPath(cmd.path));
	console.log(chalk.dim(t("cli.commands.grep.searching", { path: searchPath })));
	console.log(chalk.dim(t("cli.commands.grep.pattern", { pattern: cmd.pattern })));
	console.log(
		chalk.dim(
			t("cli.commands.grep.parameters", {
				mode: cmd.mode,
				limit: cmd.limit,
				context: cmd.context,
				gitignore: String(cmd.gitignore),
			}),
		),
	);

	console.log("");

	try {
		const result = await grep({
			pattern: cmd.pattern,
			path: searchPath,
			glob: cmd.glob,
			mode: cmd.mode,
			maxCount: cmd.limit,
			context: cmd.mode === GrepOutputMode.Content ? cmd.context : undefined,
			hidden: true,
			gitignore: cmd.gitignore,
		});

		console.log(chalk.green(t("cli.commands.grep.totalMatches", { count: result.totalMatches })));
		console.log(chalk.green(t("cli.commands.grep.filesWithMatches", { count: result.filesWithMatches })));
		console.log(chalk.green(t("cli.commands.grep.filesSearched", { count: result.filesSearched })));
		if (result.limitReached) {
			console.log(chalk.yellow(t("cli.commands.grep.limitReached")));
		}
		console.log("");

		for (const match of result.matches) {
			const displayPath = match.path.replace(/\\/g, "/");

			if (cmd.mode === GrepOutputMode.Content) {
				if (match.contextBefore) {
					for (const ctx of match.contextBefore) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log(`${chalk.cyan(displayPath)}:${chalk.yellow(String(match.lineNumber))}: ${match.line}`);
				if (match.contextAfter) {
					for (const ctx of match.contextAfter) {
						console.log(chalk.dim(`${displayPath}-${ctx.lineNumber}- ${ctx.line}`));
					}
				}
				console.log("");
			} else if (cmd.mode === GrepOutputMode.Count) {
				console.log(`${chalk.cyan(displayPath)}: ${match.matchCount ?? 0} matches`);
			} else {
				console.log(chalk.cyan(displayPath));
			}
		}
	} catch (err) {
		console.error(
			chalk.red(t("cli.commands.grep.error", { error: err instanceof Error ? err.message : String(err) })),
		);
		process.exit(1);
	}
}

export function printGrepHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} grep`)} - ${t("cli.commands.grep.helpDescription")}

${chalk.bold(t("cli.commands.grep.helpUsage"))}
  ${APP_NAME} grep <pattern> [path] [options]

${chalk.bold(t("cli.commands.grep.helpArguments"))}
  pattern   ${t("cli.commands.grep.helpPattern")}
  path      ${t("cli.commands.grep.helpPath")}

${chalk.bold(t("cli.config.help.options"))}
  -g, --glob <pattern>  ${t("cli.commands.grep.helpGlob")}
  -l, --limit <n>       ${t("cli.commands.grep.helpLimit")}
  -C, --context <n>     ${t("cli.commands.grep.helpContext")}
  -f, --files           ${t("cli.commands.grep.helpFiles")}
  -c, --count           ${t("cli.commands.grep.helpCount")}
  -h, --help            ${t("cli.commands.grep.helpFlag")}
  --no-gitignore        ${t("cli.commands.grep.helpGitignore")}

${chalk.bold(t("cli.commands.grep.helpEnvironment"))}
  PI_WALK_WORKERS=N    ${t("cli.commands.grep.helpWalkerWorkers")}

${chalk.bold(t("cli.config.help.examples"))}
  ${APP_NAME} grep "import" src/
  ${APP_NAME} grep "TODO" . --glob "*.ts"
  ${APP_NAME} grep "function" --files
`);
}
