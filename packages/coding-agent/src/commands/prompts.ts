import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { promptsHelp } from "../cli/command-help";
import { PROMPT_ACTIONS, runPromptsCommand } from "../cli/prompts-cli";

export default class Prompts extends Command {
	static description = promptsHelp.description;
	static args = {
		action: Args.string({ description: "Prompt action", options: PROMPT_ACTIONS }),
		targets: Args.string({
			description: "Prompt ids, source-relative paths or globs; check also accepts files",
			multiple: true,
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Emit structured JSON" }),
		user: Flags.boolean({ description: "Use profile-aware user builtin-prompts; exclusive with --project/--dir" }),
		project: Flags.boolean({ description: "Use exact cwd .omp/builtin-prompts; exclusive with --user/--dir" }),
		dir: Flags.string({ description: "Use this exact builtin-prompts directory; exclusive with --user/--project" }),
		force: Flags.boolean({ char: "f", description: "unpack: overwrite existing templates; default skips them" }),
		only: Flags.string({ description: "unpack: include only ids or relative paths matching this glob" }),
		include: Flags.string({
			description: "unpack: asset group, core by default",
			options: ["core", "feature", "compaction", "dialects", "all"],
		}),
		helpers: Flags.boolean({ description: "lexicon: show helpers only, or combine with --vars" }),
		vars: Flags.boolean({ description: "lexicon: show variables only; show: include the context contract" }),
		scope: Flags.string({ description: "lexicon: filter context scope; check: override the inferred scope" }),
		used: Flags.boolean({ description: "lexicon: only identifiers used by shipped prompts" }),
		unused: Flags.boolean({ description: "lexicon: only valid identifiers unused by shipped prompts" }),
		all: Flags.boolean({ description: "reset: remove all catalogued overrides; lexicon: show used and unused" }),
		strict: Flags.boolean({ description: "check: enable strict validation without changing runtime rendering" }),
		"strict-warnings": Flags.boolean({ description: "check: return exit 1 for warnings as well as errors" }),
		runtime: Flags.boolean({ description: "check: require required runtime-only context values" }),
		fixture: Flags.string({
			description: "check: inline JSON object or JSON file to merge into the canned dry-render context",
		}),
		installed: Flags.boolean({ description: "check: include installed override files, the default without targets" }),
		agents: Flags.boolean({
			description: "check: include user/project agents; bodies are inspected, not runtime overrides",
		}),
	};
	static examples = [
		`${APP_NAME} prompts unpack`,
		`${APP_NAME} prompts unpack --project --only 'system/system-prompt.md'`,
		`${APP_NAME} prompts unpack --force --include core`,
		`${APP_NAME} prompts list --json`,
		`${APP_NAME} prompts show tools/bash.md --vars`,
		`${APP_NAME} prompts diff 'tools/*.md'`,
		`${APP_NAME} prompts lexicon --unused --scope system`,
		`${APP_NAME} prompts keys live/prompts/live-instructions.md`,
		`${APP_NAME} prompts check --installed --strict --runtime`,
		`${APP_NAME} prompts check .omp/agents/scout.md --scope agent-body`,
		`${APP_NAME} prompts reset tools/bash.md`,
		`${APP_NAME} prompts reset --all --user`,
		"Templates stay dynamic. SYSTEM.md, APPEND_SYSTEM.md, TITLE_SYSTEM.md and PERSONALITY.md remain plain text.",
		"check exits 0 for success, 1 for validation errors, 2 for usage errors, and 3 for internal failures.",
	];

	async run(): Promise<void> {
		try {
			const { args, flags } = await this.parse(Prompts);
			if (!args.action) {
				renderCommandHelp(APP_NAME, "prompts", Prompts);
				return;
			}
			process.exitCode = await runPromptsCommand({ action: args.action, targets: args.targets, flags });
		} catch (error) {
			if (!(error instanceof CliUsageError)) throw error;
			process.stderr.write(`prompts: ${error.message}\n`);
			process.exitCode = 2;
		}
	}
}
