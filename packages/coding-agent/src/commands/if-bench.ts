import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { ifBenchHelp as commandHelp } from "../cli/command-help";
import { runIfBenchCommand } from "../if-bench";

export default class IfBench extends Command {
	static description = commandHelp.description;
	static args = {
		models: Args.string({
			description: "Model selectors (provider/model or fuzzy id, e.g. opus)",
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		turns: Flags.integer({ description: "Maximum turns per model; turn N issues N actions (default: 24)" }),
		length: Flags.integer({ description: "Character-array length, even, 8-26 (default: 24)" }),
		"max-tokens": Flags.integer({ description: "Max output tokens per turn (default: 32768)" }),
		"nya-max": Flags.integer({ description: "Longest accepted cat sound in nya{1,N} (default: 8)" }),
		par: Flags.integer({ description: "Models benchmarked concurrently (default: 4)" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static get examples(): string[] {
		return [
			`# ${t("cli.commands.if-bench.example.compare")}\n  ${APP_NAME} if-bench opus sonnet gpt-5.2`,
			`# ${t("cli.commands.if-bench.example.turns")}\n  ${APP_NAME} if-bench opus --turns 40 --par 1`,
			`# ${t("cli.commands.if-bench.example.length")}\n  ${APP_NAME} if-bench sonnet --length 12 --nya-max 2`,
			`# ${t("cli.commands.if-bench.example.json")}\n  ${APP_NAME} if-bench opus --json`,
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(IfBench);
		await runIfBenchCommand({
			models: args.models ?? [],
			flags: {
				turns: flags.turns,
				length: flags.length,
				maxTokens: flags["max-tokens"],
				nyaMax: flags["nya-max"],
				par: flags.par,
				json: flags.json,
			},
		});
	}
}
