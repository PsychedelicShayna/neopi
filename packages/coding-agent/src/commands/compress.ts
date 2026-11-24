import { APP_NAME, postmortem } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { compressHelp as commandHelp } from "../cli/command-help";
import { CliUsageError } from "../cli/usage-error";
import { runCompressCommand } from "../compress";

export default class Compress extends Command {
	static description = commandHelp.description;
	static args = {
		files: Args.string({ description: "Files or glob patterns to compress", required: true, multiple: true }),
	};
	static flags = {
		out: Flags.string({ char: "o", description: "Write the approved text here instead of stdout (single file)" }),
		inPlace: Flags.boolean({ char: "i", description: "Overwrite each source file with its approved text" }),
		rounds: Flags.integer({ char: "r", description: "Maximum drafts per file before giving up", default: 3 }),
		agents: Flags.integer({ char: "n", description: "Files compressed concurrently", default: 4 }),
		model: Flags.string({ char: "m", description: "Model selector" }),
	};

	static examples = [
		`${APP_NAME} compress prompts/tools/read.md`,
		`${APP_NAME} compress notes.md -o notes.compressed.md`,
		`${APP_NAME} compress 'src/prompts/**/*.md' -i`,
		`${APP_NAME} compress a.md b.md c.md -i -n 8`,
		`${APP_NAME} compress spec.md -r 5 -m opus`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Compress);
		const files = args.files ?? [];
		if (files.length === 0) throw new CliUsageError(t("cli.commands.compress.noFiles"));
		if (flags.rounds <= 0) throw new CliUsageError(t("cli.commands.compress.invalidRounds"));
		if (flags.agents <= 0) throw new CliUsageError(t("cli.commands.compress.invalidAgents"));
		if (flags.inPlace && flags.out) throw new CliUsageError(t("cli.commands.compress.conflictingOutput"));
		const result = await runCompressCommand({
			files,
			model: flags.model,
			maxRounds: flags.rounds,
			concurrency: flags.agents,
			output: flags.out,
			inPlace: flags.inPlace,
		});
		await postmortem.quit(result.exitCode);
	}
}
