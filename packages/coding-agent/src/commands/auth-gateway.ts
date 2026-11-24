/**
 * `npi auth-gateway` — run a forward proxy that injects auth from the broker.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { authGatewayHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class AuthGateway extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status/check/link)" }),
		bind: Flags.string({
			description: "Bind address for `serve` (host:port); for `link`, the gateway to describe",
			char: "b",
		}),
		host: Flags.string({
			description:
				"For `link`: address other machines use to reach the gateway (default: the bind host, or this machine's LAN address when bound to 0.0.0.0)",
		}),
		name: Flags.string({ description: "For `link`: gateway label carried in the link (default: hostname)" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token (token)" }),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed.",
		}),
		"trust-proxy-headers": Flags.boolean({
			description: "Trust forwarded peer IP headers from a reverse proxy (serve); off by default.",
		}),
		clients: Flags.string({
			description:
				"JSON file of scoped client tokens (serve), each limited to its own models and broker accounts; re-read while serving",
		}),
		strict: Flags.boolean({
			description:
				"For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential.",
		}),
	};

	static get examples(): string[] {
		return [
			`# ${t("cli.commands.auth-gateway.example.serve")}\n  ${APP_NAME} auth-gateway serve`,
			`# ${t("cli.commands.auth-gateway.example.stdio")}\n  echo '{"id":1,"path":"/v1/chat/completions","body":{"model":"@smol","messages":[{"role":"user","content":"hi"}]}}' | ${APP_NAME} auth-gateway stdio`,
			`# ${t("cli.commands.auth-gateway.example.port")}\n  ${APP_NAME} auth-gateway serve --bind=127.0.0.1:4000`,
			`# ${t("cli.commands.auth-gateway.example.trust_proxy")}\n  ${APP_NAME} auth-gateway serve --trust-proxy-headers`,
			`# ${t("cli.commands.auth-gateway.example.token")}\n  ${APP_NAME} auth-gateway token`,
			`# ${t("cli.commands.auth-gateway.example.rotate_token")}\n  ${APP_NAME} auth-gateway token --regenerate`,
			`# ${t("cli.commands.auth-gateway.example.no_auth")}\n  ${APP_NAME} auth-gateway serve --no-auth`,
			`# ${t("cli.commands.auth-gateway.example.clients")}\n  ${APP_NAME} auth-gateway serve --clients=/etc/omp/gateway-clients.json`,
			`# ${t("cli.commands.auth-gateway.example.link")}\n  ${APP_NAME} auth-gateway link`,
			`# ${t("cli.commands.auth-gateway.example.link_host")}\n  ${APP_NAME} auth-gateway link --host=192.168.1.31`,
			`# ${t("cli.commands.auth-gateway.example.status")}\n  ${APP_NAME} auth-gateway status`,
			`# ${t("cli.commands.auth-gateway.example.check")}\n  ${APP_NAME} auth-gateway check`,
			`# ${t("cli.commands.auth-gateway.example.check_json")}\n  ${APP_NAME} auth-gateway check --json`,
			`# ${t("cli.commands.auth-gateway.example.check_strict")}\n  ${APP_NAME} auth-gateway check --strict`,
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthGateway);
		if (!args.action) {
			await this.showHelp("auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				noAuth: flags["no-auth"],
				trustProxyHeaders: flags["trust-proxy-headers"],
				strict: flags.strict,
				clients: flags.clients,
				host: flags.host,
				name: flags.name,
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
