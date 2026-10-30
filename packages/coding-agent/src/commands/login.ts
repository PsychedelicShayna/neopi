/**
 * Log in to a model provider from the terminal.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
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

	static examples = [
		`# Pick a provider interactively\n  ${APP_NAME} login`,
		`# Log in to a specific provider\n  ${APP_NAME} login anthropic`,
		`# Connect to NeoProxy with a username and hidden password\n  ${APP_NAME} login neoproxy --url https://proxy.example.com`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Login);
		await runLoginCommand(args.provider, { url: flags.url });
	}
}
