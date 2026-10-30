/**
 * Create a daemon-hosted session and attach to it. Arguments after `--` are
 * ordinary launch arguments for the hosted session (`--model`, `--resume`, ...).
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { newHelp as commandHelp } from "../cli/command-help";
import { runNewCommand } from "../daemon/hub-cli";

export default class New extends Command {
	static description = commandHelp.description;
	static strict = false;
	static examples = [`${APP_NAME} new`, `${APP_NAME} new -- --model anthropic/claude-sonnet-4-5`];

	async run(): Promise<void> {
		const { argv } = await this.parse(New);
		await runNewCommand(argv.filter((arg): arg is string => typeof arg === "string" && arg !== "--"));
	}
}
