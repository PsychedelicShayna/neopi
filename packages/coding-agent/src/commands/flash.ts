/**
 * Turn a USB stick into a bootable, LUKS-encrypted harness (issue #47).
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { flashHelp as commandHelp } from "../cli/command-help";
import { runFlashCommand } from "../cli/flash-cli";

export default class Flash extends Command {
	static description = commandHelp.description;
	static args = {
		device: Args.string({
			description: "Whole-disk block device to flash (e.g. /dev/sdc) — ALL DATA ON IT IS DESTROYED",
			required: true,
		}),
	};

	static flags = {
		slim: Flags.boolean({
			description: "Also exclude agent sessions and the python env so the payload fits 8 GB-class sticks",
			default: false,
		}),
		force: Flags.boolean({
			description: "Allow flashing a device that reports as non-removable",
			default: false,
		}),
		binary: Flags.string({
			description: "Harness binary to install on the stick (defaults to this executable)",
		}),
		user: Flags.string({
			description: "Payload owner whose ~/.omp and ~/.ssh are carried (defaults to $SUDO_USER)",
		}),
	};

	static examples = [
		"# Flash a stick with your harness, credentials, and the P2V toolkit\n  sudo omomp flash /dev/sdc",
		"# Fit an 8 GB stick: drop sessions and the recreatable python env\n  sudo omomp flash --slim /dev/sdc",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Flash);
		process.exitCode = await runFlashCommand({
			device: args.device ?? "",
			flags: {
				slim: flags.slim,
				force: flags.force,
				binary: flags.binary,
				user: flags.user,
			},
		});
	}
}
