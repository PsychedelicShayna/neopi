/**
 * `omp login [provider]` — the terminal counterpart of the in-session `/login`.
 *
 * Authenticates against the same credential store sessions read (local
 * `agent.db`, or the configured auth broker), including OAuth providers
 * contributed by extensions, then re-runs that provider's model discovery so
 * the next session sees the models the credential unlocked.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import { APP_NAME, getAgentDbPath, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { registerNeoProxyLogin } from "../neopi/neoproxy-connect";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { createLoginReadline, formatLoginIdentity, pickOAuthProvider, runTerminalOAuthLogin } from "./oauth-terminal";

/**
 * Log in to `provider`, or to one picked interactively when omitted.
 *
 * An unknown/unavailable provider, a cancelled selection or prompt, and a
 * failed OAuth flow print `Login failed: …` to stderr and set exit code 1.
 */
export async function runLoginCommand(provider: string | undefined, options: { url?: string } = {}): Promise<void> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const rl = createLoginReadline();
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		if (options.url) registerNeoProxyLogin(modelRegistry, options.url);
		// Extensions may register OAuth providers; load them so they are listed.
		await loadCliExtensionProviders(modelRegistry, settings, cwd);

		const providers = getOAuthProviders().filter(p => p.available);
		const providerId = provider ?? (await pickOAuthProvider(rl, providers));
		if (options.url && providerId !== "neoproxy") throw new Error(t("cli.commands.login.url_neoproxy_only"));
		const info = providers.find(p => p.id === providerId);
		if (!info) {
			throw new Error(t("cli.commands.login.unknown_provider", { provider: providerId, app: APP_NAME }));
		}

		const identity = await runTerminalOAuthLogin(rl, authStorage, info.id, { openBrowser: true });
		if (!identity) {
			process.stdout.write(chalk.yellow(`${t("cli.commands.login.no_credentials", { provider: info.name })}\n`));
			return;
		}
		// A provider-scoped online refresh re-runs discovery with the new
		// credential; a fresh cache row fetched before login would otherwise hide
		// the unlocked models until its TTL expires (#5780).
		await modelRegistry.refreshProvider(info.storeCredentialsAs ?? info.id, "online");

		const who = formatLoginIdentity(identity);
		const signedIn = who
			? t("cli.commands.login.logged_in_as", { provider: info.name, identity: who })
			: t("cli.commands.login.logged_in", { provider: info.name });
		process.stdout.write(chalk.green(`\n${signedIn}\n`));
		const broker = await resolveAuthBrokerConfig();
		const saved = broker
			? t("cli.commands.login.credentials_broker", { url: broker.url })
			: t("cli.commands.login.credentials_path", { path: getAgentDbPath() });
		process.stdout.write(chalk.dim(`${saved}\n`));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(chalk.red(`${t("cli.commands.login.failed", { message })}\n`));
		process.exitCode = 1;
	} finally {
		rl.close();
		authStorage.close();
	}
}
