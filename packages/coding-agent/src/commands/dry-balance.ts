import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { dryBalanceHelp as commandHelp } from "../cli/command-help";
import { runDryBalanceCommand } from "../cli/dry-balance-cli";

export default class DryBalance extends Command {
	static description = commandHelp.description;
	static args = {
		model: Args.string({
			description: "Model selector (provider/model or fuzzy id). Defaults to the configured default model.",
			required: false,
		}),
	};

	static flags = {
		model: Flags.string({ description: `Model selector (same syntax as --model on ${APP_NAME})` }),
		count: Flags.integer({ description: "Number of random session ids to try", default: 100 }),
		concurrency: Flags.integer({ description: "Maximum concurrent credential resolutions", default: 32 }),
		json: Flags.boolean({ description: "Output JSON" }),
		bench: Flags.boolean({ description: "Send one live benchmark request per OAuth account" }),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	static get examples(): string[] {
		return [
			`# ${t("cli.commands.dry-balance.example.default")}\n  ${APP_NAME} dry-balance`,
			`# ${t("cli.commands.dry-balance.example.model")}\n  ${APP_NAME} dry-balance anthropic/claude-sonnet-4-5`,
			`# ${t("cli.commands.dry-balance.example.concurrency")}\n  ${APP_NAME} dry-balance --model openai-codex/gpt-5-codex --count 1000 --concurrency 64`,
			`# ${t("cli.commands.dry-balance.example.bench")}\n  ${APP_NAME} dry-balance --bench`,
			`# ${t("cli.commands.dry-balance.example.json")}\n  ${APP_NAME} dry-balance --json`,
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(DryBalance);
		await runDryBalanceCommand({
			model: args.model,
			flags: {
				model: flags.model,
				count: flags.count,
				concurrency: flags.concurrency,
				json: flags.json,
				bench: flags.bench,
				config: flags.config,
			},
		});
	}
}
