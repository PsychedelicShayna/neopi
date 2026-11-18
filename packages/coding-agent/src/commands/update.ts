/**
 * Check for and install updates.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import { runNeoPiUpdate } from "../cli/neopi-updater";
import { resolveNpiUpdateArgv } from "../cli/npi-update";
import { runCli } from "../cli-main";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		check: Flags.boolean({
			char: "c",
			description: "Only check plugin updates when used with --plugins",
			default: false,
		}),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	static examples = [
		`${APP_NAME} update`,
		`${APP_NAME} update stable`,
		`${APP_NAME} update nightly`,
		`${APP_NAME} update rollback 2`,
		`${APP_NAME} update source`,
		`${APP_NAME} update --plugins --check`,
	];

	async run(): Promise<void> {
		if (this.argv.includes("--plugins") || this.argv.includes("-l")) {
			const { flags } = await this.parse(Update);
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: flags.check ? { dryRun: true } : {} });
			return;
		}
		if (this.argv.length === 1 && this.argv[0] === "source") {
			await runCli(resolveNpiUpdateArgv(["update", "source"], "npi"));
			return;
		}
		await runNeoPiUpdate(this.argv);
	}
}
