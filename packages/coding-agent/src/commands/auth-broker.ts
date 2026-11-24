/**
 * `npi auth-broker` — manage the npi credential vault.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import {
	AUTH_BROKER_ACTIONS,
	type AuthBrokerAction,
	type AuthBrokerCommandArgs,
	runAuthBrokerCommand,
} from "../cli/auth-broker-cli";
import { authBrokerHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class AuthBroker extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_BROKER_ACTIONS],
		}),
		// Second positional: provider id (login/logout) or filesystem path (import).
		source: Args.string({
			description: "OAuth provider id (login/logout) or path (import)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the bearer token" }),
		via: Flags.string({
			description: "SSH user@host for remote login (login --via=user@host)",
		}),
		provider: Flags.string({
			description: "Override provider id for `import` (e.g. when JSON `type` is unrecognized)",
		}),
		"include-disabled": Flags.boolean({
			description: "Import credentials whose JSON has `disabled: true` (import)",
		}),
		"from-local": Flags.boolean({
			description: "migrate source: local SQLite + env vars (required for `migrate`)",
		}),
		"include-env": Flags.boolean({
			description: "Capture env-var API keys for providers not yet on broker (migrate)",
		}),
		"include-oauth": Flags.boolean({
			description: "Also upload OAuth from local SQLite during migrate (default skips them)",
		}),
		"dry-run": Flags.boolean({ description: "Print actions without executing (import / login --via / migrate)" }),
		"trust-proxy-headers": Flags.boolean({
			description: "Trust forwarded peer IP headers from a reverse proxy (serve); off by default.",
		}),
	};

	static get examples(): string[] {
		return [
			`# ${t("cli.commands.auth-broker.example.serve")}\n  ${APP_NAME} auth-broker serve`,
			`# ${t("cli.commands.auth-broker.example.port")}\n  ${APP_NAME} auth-broker serve --bind=127.0.0.1:9000`,
			`# ${t("cli.commands.auth-broker.example.trust_proxy")}\n  ${APP_NAME} auth-broker serve --trust-proxy-headers`,
			`# ${t("cli.commands.auth-broker.example.token")}\n  ${APP_NAME} auth-broker token`,
			`# ${t("cli.commands.auth-broker.example.rotate_token")}\n  ${APP_NAME} auth-broker token --regenerate`,
			`# ${t("cli.commands.auth-broker.example.list")}\n  ${APP_NAME} auth-broker list`,
			`# ${t("cli.commands.auth-broker.example.login_local")}\n  ${APP_NAME} auth-broker login anthropic`,
			`# ${t("cli.commands.auth-broker.example.login_interactive")}\n  ${APP_NAME} auth-broker login`,
			`# ${t("cli.commands.auth-broker.example.login_ssh")}\n  ${APP_NAME} auth-broker login anthropic --via=user@broker`,
			`# ${t("cli.commands.auth-broker.example.logout")}\n  ${APP_NAME} auth-broker logout anthropic`,
			`# ${t("cli.commands.auth-broker.example.import_directory")}\n  ${APP_NAME} auth-broker import ~/.cliproxy/auth`,
			`# ${t("cli.commands.auth-broker.example.import_file")}\n  ${APP_NAME} auth-broker import ~/.cliproxy/auth/claude-foo.json --provider anthropic`,
			`# ${t("cli.commands.auth-broker.example.preview_migration")}\n  ${APP_NAME} auth-broker migrate --from-local --include-env --dry-run`,
			`# ${t("cli.commands.auth-broker.example.migrate")}\n  ${APP_NAME} auth-broker migrate --from-local --include-env`,
			`# ${t("cli.commands.auth-broker.example.status")}\n  ${APP_NAME} auth-broker status`,
		];
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthBroker);
		if (!args.action) {
			await this.showHelp("auth-broker", AuthBroker);
			return;
		}
		const action = args.action as AuthBrokerAction;
		const cmd: AuthBrokerCommandArgs = {
			action,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				via: flags.via,
				// `login`/`logout` reuse the legacy `provider` slot; `import` keeps `source` separate
				// so `provider` flag (used as an override) is unambiguous.
				provider: action === "import" ? flags.provider : (args.source ?? flags.provider),
				source: args.source,
				includeDisabled: flags["include-disabled"],
				fromLocal: flags["from-local"],
				includeEnv: flags["include-env"],
				includeOauth: flags["include-oauth"],
				dryRun: flags["dry-run"],
				trustProxyHeaders: flags["trust-proxy-headers"],
			},
		};
		await initTheme();
		await runAuthBrokerCommand(cmd);
	}
}
