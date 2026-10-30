/**
 * Manage configuration settings.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { configHelp as commandHelp } from "../cli/command-help";
import { type ConfigAction, type ConfigCommandArgs, type ConfigScope, runConfigCommand } from "../cli/config-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg", "dump-toml", "to-toml"];

export default class Config extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ACTIONS,
		}),
		key: Args.string({
			description: "Setting key",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		force: Flags.boolean({ description: "Allow to-toml to replace existing config.toml files" }),
		scope: Flags.string({
			description:
				'With list: only the keys the "global" (config.yml in the agent dir) or "project" (<cwd>/.omp) layer sets, as written',
			options: ["global", "project"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
				force: flags.force,
				scope: flags.scope as ConfigScope | undefined,
			},
		};

		if (action !== "dump-toml" && action !== "to-toml") await initTheme();
		await runConfigCommand(cmd);
	}
}
