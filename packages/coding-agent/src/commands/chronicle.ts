/**
 * `npi chronicle <subcommand>`: operator surface over Chronicler atoms.
 *
 * Each subcommand is its own `Command` in `./chronicle-<name>.ts`, registered
 * in {@link Chronicle.subcommands}; the CLI runner dispatches to it and renders
 * its help, so this parent only handles a missing or unknown subcommand.
 */
import { type CommandCtor, Command, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { chronicleHelp } from "../cli/command-help";

export default class Chronicle extends Command {
	static description = chronicleHelp.description;
	static strict = false;

	static subcommands: Record<string, () => Promise<CommandCtor>> = {
		backfill: () => import("./chronicle-backfill").then(m => m.default),
		index: () => import("./chronicle-index").then(m => m.default),
		recall: () => import("./chronicle-recall").then(m => m.default),
	};

	async run(): Promise<void> {
		const name = this.argv[0];
		if (name !== undefined) {
			process.stderr.write(`Unknown chronicle subcommand: ${name}\n\n`);
			process.exitCode = 1;
		}
		renderCommandHelp(this.config.bin, "chronicle", Chronicle);
	}
}
