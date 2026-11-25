/**
 * Show provider usage limits for every authenticated account.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { usageHelp as commandHelp } from "../cli/command-help";
import { runUsageCommand } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Optional subcommand to execute",
			required: false,
			options: ["invalidate", "clients", "accounts", "reset"],
		}),
		target: Args.string({
			description: "Saved reset to spend with `reset`: <provider>/<credential id> as `omp usage reset` lists it",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output usage reports as JSON", default: false }),
		provider: Flags.string({ char: "p", description: "Only show usage for this provider id (e.g. anthropic)" }),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
		history: Flags.boolean({
			description: "Show recorded usage-limit history (hourly snapshots) instead of a live snapshot",
			default: false,
		}),
		days: Flags.integer({ char: "d", description: "History window in days (with --history or clients)", default: 7 }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before fetching usage (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
	};

	static get examples(): string[] {
		const values = { bin: APP_NAME };
		return [
			t("cli.commands.usage.exampleBreakdown", values),
			t("cli.commands.usage.exampleProvider", values),
			t("cli.commands.usage.exampleRedact", values),
			t("cli.commands.usage.exampleJson", values),
			t("cli.commands.usage.exampleHistory", values),
			t("cli.commands.usage.exampleClients", values),
			t("cli.commands.usage.exampleAccounts", values),
			t("cli.commands.usage.exampleResetList", values),
			t("cli.commands.usage.exampleReset", values),
			t("cli.commands.usage.exampleInvalidateAll", values),
			t("cli.commands.usage.exampleInvalidateProvider", values),
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Usage);
		await runUsageCommand({
			action: args.action,
			json: flags.json,
			provider: flags.provider,
			target: args.target,
			redact: flags.redact,
			history: flags.history,
			days: flags.days,
			extensions: flags.extension,
			noExtensions: flags["no-extensions"],
		});
	}
}
