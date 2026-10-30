/**
 * Open the session hub: list daemon-hosted sessions and attach to one.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { hubHelp as commandHelp } from "../cli/command-help";
import { runHubCommand } from "../daemon/hub-cli";

export default class Hub extends Command {
	static description = commandHelp.description;
	static examples = [`${APP_NAME} hub`];

	async run(): Promise<void> {
		await this.parse(Hub);
		await runHubCommand();
	}
}
