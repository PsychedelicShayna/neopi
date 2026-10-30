/**
 * Manage plugins (install, uninstall, list, etc.).
 */

import { Args, Command, type CommandCtor, Flags, type ParseOutput } from "@oh-my-pi/pi-utils/cli";
import { pluginHelp as commandHelp } from "../cli/command-help";
import { type PluginAction, runPluginCommand } from "../cli/plugin-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

export default class Plugin extends Command {
	static description = commandHelp.description;
	static aliases = ["plugins"];
	static args = {
		action: Args.string({
			description: "Plugin action",
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: "Packages, paths, or plugin names",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		fix: Flags.boolean({ description: "Attempt to fix issues (doctor)" }),
		force: Flags.boolean({ description: "Force install" }),
		"dry-run": Flags.boolean({
			description:
				"Show actions without applying changes (install, uninstall, link, upgrade of marketplace plugins)",
		}),
		local: Flags.boolean({ char: "l", description: "Operate on local plugin directory" }),
		enable: Flags.string({ description: "Enable a feature" }),
		disable: Flags.string({ description: "Disable a feature" }),
		set: Flags.string({ description: "Set plugin config (key=value)" }),
		scope: Flags.string({
			description: 'Install scope: "user" (default) or "project"',
			options: ["user", "project"],
		}),
	};

	static subcommands: Record<string, () => Promise<CommandCtor>> = {
		marketplace: async () => PluginMarketplace,
		config: async () => PluginConfig,
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Plugin);
		const action = (args.action ?? "list") as PluginAction;

		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		await executePlugin(action, targets, flags);
	}
}

async function executePlugin(
	action: PluginAction,
	args: string[],
	flags: ParseOutput<typeof Plugin.flags>["flags"],
): Promise<void> {
	await initTheme();
	await runPluginCommand({
		action,
		args,
		flags: {
			json: flags.json,
			fix: flags.fix,
			force: flags.force,
			dryRun: flags["dry-run"],
			local: flags.local,
			enable: flags.enable,
			disable: flags.disable,
			set: flags.set,
			scope: flags.scope as "user" | "project" | undefined,
		},
	});
}

class PluginMarketplace extends Command {
	static description = "Manage configured plugin marketplaces";
	static flags = Plugin.flags;
	static args = {
		action: Args.string({
			description: "Marketplace action (default: list)",
			options: ["add", "remove", "rm", "update", "list"],
		}),
		target: Args.string({ description: "Marketplace source (add) or name (remove/update)" }),
	};

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(PluginMarketplace);
		await executePlugin("marketplace", argv, flags);
	}
}

class PluginConfig extends Command {
	static description = "Read, change, or validate plugin configuration";
	static flags = Plugin.flags;
	static args = {
		action: Args.string({
			description: "Configuration action",
			options: ["list", "get", "set", "delete", "validate"],
			required: true,
		}),
		plugin: Args.string({ description: "Plugin name (except validate)" }),
		key: Args.string({ description: "Setting key (get/set/delete)" }),
		value: Args.string({ description: "Setting value (set)", multiple: true }),
	};

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(PluginConfig);
		await executePlugin("config", argv, flags);
	}
}
