import { setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { predictHelp as commandHelp } from "../cli/command-help";
import { runPredictCompare } from "../cli/predict-cli";
import { Settings } from "../config/settings";
import { cfgTuiVimMode } from "../modes/settings";

export default class Predict extends Command {
	static description = commandHelp.description;

	static examples = [`${APP_NAME} predict`];

	async run(): Promise<void> {
		await this.parse(Predict);
		if (!process.stdin.isTTY || !process.stdout.isTTY)
			throw new CliUsageError(`${APP_NAME} predict needs an interactive terminal`);
		const settings = await Settings.loadReadOnly({ cwd: getProjectDir() });
		setMenuSearchVimMode(cfgTuiVimMode.get(settings));
		await runPredictCompare();
	}
}
