/**
 * Log in to a model provider from the terminal.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider id (e.g. anthropic, openai-codex, neoproxy); omit to pick interactively",
			required: false,
		}),
	};
	static flags = {
		url: Flags.string({ description: "NeoProxy server URL (HTTPS, or loopback HTTP)" }),
	};

	static get examples() {
		return [
			`# ${t("cli.commands.login.example.pick")}\n  ${APP_NAME} login`,
			`# ${t("cli.commands.login.example.provider")}\n  ${APP_NAME} login anthropic`,
			`# ${t("cli.commands.login.example.neoproxy")}\n  ${APP_NAME} login neoproxy --url https://proxy.example.com`,
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Login);
		await runLoginCommand(args.provider, { url: flags.url });
	}
}
