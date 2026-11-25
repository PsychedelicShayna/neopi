import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { predictHelp as commandHelp } from "../cli/command-help";
import { runPredictCompare } from "../cli/predict-cli";

export default class Predict extends Command {
	static description = commandHelp.description;

	static examples = [`${APP_NAME} predict`];

	async run(): Promise<void> {
		await this.parse(Predict);
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new CliUsageError(t("cli.commands.predict.interactive", { app: APP_NAME }));
		}
		await runPredictCompare();
	}
}
