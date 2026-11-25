/**
 * Manage bundled task agents.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: AgentsAction[] = ["unpack"];

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.omp/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.omp/agents" }),
	};

	static get examples(): string[] {
		return [
			`# ${t("cli.commands.agents.example.user")}\n  ${APP_NAME} agents unpack`,
			`# ${t("cli.commands.agents.example.project")}\n  ${APP_NAME} agents unpack --project`,
			`# ${t("cli.commands.agents.example.force")}\n  ${APP_NAME} agents unpack --project --force`,
			`# ${t("cli.commands.agents.example.directory")}\n  ${APP_NAME} agents unpack --dir ./tmp/agents --json`,
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			await this.showHelp("agents", Agents);
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
