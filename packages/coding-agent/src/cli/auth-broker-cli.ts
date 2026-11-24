/**
 * `npi auth-broker` command handlers.
 *
 * Sub-verbs:
 *   - `serve [--bind=…] [--trust-proxy-headers]` — boots the broker against the local SQLite store.
 *   - `token` / `token --regenerate` — manages the bearer token file.
 *   - `login <provider> [--via=user@host]` — logs into a provider locally, or
 *     via SSH tunnel into a remote broker host.
 *   - `import <file|dir>` — imports CLIProxyAPI-style JSON credentials into
 *     the local SQLite store (typical use: `import ~/.cliproxy/auth`).
 *   - `migrate --from-local [--include-env] [--include-oauth] [--dry-run]` —
 *     uploads local SQLite + env API keys to the broker, skipping anything
 *     the broker already has.
 *   - `status` — health-pings the configured remote broker.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
	type AuthCredential,
	type AuthCredentialSnapshotEntry,
	AuthStorage,
	getEnvApiKey,
	getOAuthProviders,
	isSameOAuthAccount,
	listProvidersWithEnvKey,
	matchesReplacementCredential,
	type OAuthCredential,
	type OAuthProvider,
	PROVIDER_REGISTRY,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, DEFAULT_AUTH_BROKER_BIND, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { refreshOAuthToken } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { $which, APP_NAME, getAgentDbPath, getConfigRootDir, logger, postmortem, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { getLocale, type Locale, t } from "@oh-my-pi/pi-utils/i18n";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import { $ } from "bun";
import { refreshManagedMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isManagedMCPOAuthCredentialId, mcpOAuthServerUrlFromCredentialId } from "../mcp/oauth-flow";
import {
	applyUnpausedProviders,
	resolveAuthBrokerConfig,
	resolveEffectiveSettings,
} from "../session/auth-broker-config";
import { pickIndex, pickOAuthProvider, runTerminalOAuthLogin } from "./oauth-terminal";
import { generateToken, readTokenFile, writeTokenFile } from "./token-file";

export type AuthBrokerAction = "serve" | "token" | "login" | "logout" | "status" | "import" | "migrate" | "list";

export interface AuthBrokerCommandArgs {
	action: AuthBrokerAction;
	flags: {
		json?: boolean;
		bind?: string;
		trustProxyHeaders?: boolean;
		regenerate?: boolean;
		via?: string;
		provider?: string;
		dryRun?: boolean;
		/** `login`/`logout`: provider id. `import`: filesystem path. */
		source?: string;
		/** `import`: keep credentials whose JSON had `disabled: true`. */
		includeDisabled?: boolean;
		/** `migrate`: also upload local OAuth (default: api_key only, since OAuth is via cliproxy import). */
		includeOauth?: boolean;
		/** `migrate`: also capture env-var API keys for providers not yet on broker. */
		includeEnv?: boolean;
		/** `migrate`: required `--from-local` source. Reserved for future sources. */
		fromLocal?: boolean;
	};
}

const ACTIONS: readonly AuthBrokerAction[] = [
	"serve",
	"token",
	"login",
	"logout",
	"import",
	"migrate",
	"status",
	"list",
];

/** Callback ports baked from the per-provider OAuth flow modules. */
const CALLBACK_PORTS: Record<string, number> = Object.fromEntries(
	PROVIDER_REGISTRY.flatMap(provider =>
		provider.callbackPort != null ? [[provider.id, provider.callbackPort] as [string, number]] : [],
	),
);

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

async function ensureToken(): Promise<string> {
	const existing = await readTokenFile(getTokenFilePath());
	if (existing) return existing;
	const token = generateToken();
	await writeTokenFile(getTokenFilePath(), token);
	return token;
}

/**
 * OAuth refresh handler for `npi auth-broker serve`'s {@link AuthStorage}.
 *
 * The vault holds provider OAuth rows AND NeoPi-managed `mcp_oauth:*` rows.
 * Provider rows refresh through the per-provider registry. MCP rows are
 * self-describing — the embedded token endpoint and client credentials are the
 * only refresh material — so they refresh with a generic `refresh_token` grant.
 * The serve process never loads the MCP manager, so this is the only place that
 * teaches the broker to refresh MCP tokens; without it
 * `POST /v1/credential/:id/refresh` fails with "Unknown OAuth provider" and the
 * background refresher lets MCP access tokens expire (issue #8933).
 */
export function refreshBrokerOAuthCredential(
	provider: string,
	credential: OAuthCredential,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (isManagedMCPOAuthCredentialId(provider)) {
		return refreshManagedMcpOAuthCredential(credential, {
			serverUrl: mcpOAuthServerUrlFromCredentialId(provider),
			signal,
		});
	}
	// Non-MCP rows: same per-provider path AuthStorage would take by default
	// (the serve process registers no custom OAuth providers).
	return refreshOAuthToken(provider as OAuthProvider, credential, signal);
}

/** The `omp auth-broker serve` vault: tokens refresh in this process through {@link refreshBrokerOAuthCredential}. */
export function createBrokerAuthStorage(store: SqliteAuthCredentialStore): AuthStorage {
	return new AuthStorage(store, {
		refreshOAuthCredential: (provider, _credentialId, credential, signal) =>
			refreshBrokerOAuthCredential(provider, credential, signal),
		refreshOAuthCredentialMints: true,
	});
}

async function runServe(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	// The broker is a long-running headless service: route structured logs to
	// stdout so a process supervisor (pm2, journald, k8s) captures them, and
	// skip the rotating ~/.omp/logs/ file the TUI default would have used.
	setLoggerTransports({ console: true, file: false });
	// SIGTERM/SIGINT are a supervisor's stop or restart, not a failure: exit 0 once
	// the cleanup pass (which saves an in-flight token refresh) finishes.
	postmortem.exitCleanlyOnStopSignals();

	const bind = flags.bind ?? DEFAULT_AUTH_BROKER_BIND;
	const token = await ensureToken();
	const dbPath = getAgentDbPath();
	applyUnpausedProviders(await resolveEffectiveSettings());
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const storage = createBrokerAuthStorage(store);
	await storage.credentials.reload();
	const handle = startAuthBroker({
		storage,
		bind,
		bearerTokens: [token],
		trustProxyHeaders: flags.trustProxyHeaders,
		version: VERSION,
	});
	logger.info("auth-broker listening", { url: handle.url });
	logger.info("auth-broker bearer token loaded", { path: getTokenFilePath(), mode: "0600" });

	// Stopping returns from `serve` and leaves the exit to the process signal handler, which first
	// waits for a refresh still saving a token the provider already rotated. Exiting here would
	// drop that save and leave the store with a spent refresh token.
	const stopped = Promise.withResolvers<void>();
	const shutdown = (signal: NodeJS.Signals): void => {
		logger.info("auth-broker shutting down", { signal });
		void handle
			.close()
			.finally(() => storage.close())
			.then(stopped.resolve, stopped.reject);
	};
	const onSigint = (): void => shutdown("SIGINT");
	const onSigterm = (): void => shutdown("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	try {
		await stopped.promise;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

async function runToken(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	if (flags.regenerate) {
		const next = generateToken();
		await writeTokenFile(getTokenFilePath(), next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: getTokenFilePath() })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureToken();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: getTokenFilePath() })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function runLogin(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	if (flags.via && !flags.provider) {
		throw new Error(t("cli.commands.auth-broker.remoteLoginUsage", { app: APP_NAME }));
	}
	applyUnpausedProviders(await resolveEffectiveSettings());
	const providers = getOAuthProviders();
	// One interface for picker + login prompts; closed before `--via` hands
	// stdin to ssh.
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	let providerArg: string;
	try {
		providerArg = flags.provider ?? (await pickOAuthProvider(rl, providers));
		if (!providers.some(p => p.id === providerArg)) {
			throw new Error(
				t("cli.commands.auth-broker.unknownProvider", {
					provider: providerArg,
					providers: providers
						.map(p => p.id)
						.sort()
						.join(", "),
				}),
			);
		}
		if (!flags.via) {
			await runLocalLogin(rl, providerArg);
			return;
		}
	} finally {
		rl.close();
	}
	await runRemoteLogin(providerArg, flags.via, flags.dryRun ?? false);
}

async function runLocalLogin(rl: readline.Interface, provider: string): Promise<void> {
	// Drive the per-provider OAuth dance in-process. Persists into the same
	// SQLite store the broker uses.
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.credentials.reload();
	try {
		await runTerminalOAuthLogin(rl, storage, provider);
		process.stdout.write(`\n${t("cli.commands.auth-broker.saved", { path: getAgentDbPath() })}\n`);
	} finally {
		store.close();
	}
}

async function runRemoteLogin(provider: string, via: string, dryRun: boolean): Promise<void> {
	const port = CALLBACK_PORTS[provider];
	if (port === undefined) {
		throw new Error(t("cli.commands.auth-broker.unknownCallbackPort", { provider }));
	}
	const sshArgs = [
		"-L",
		`${port}:127.0.0.1:${port}`,
		"-o",
		"ExitOnForwardFailure=yes",
		via,
		`${APP_NAME} auth-broker login ${provider}`,
	];
	if (dryRun) {
		process.stdout.write(`ssh ${sshArgs.map(a => (a.includes(" ") ? `'${a}'` : a)).join(" ")}\n`);
		return;
	}
	const sshBin = $which("ssh");
	if (!sshBin) {
		throw new Error(t("cli.commands.auth-broker.sshMissing"));
	}
	const proc = Bun.spawn({
		cmd: [sshBin, ...sshArgs],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(t("cli.commands.auth-broker.sshExit", { code: exitCode }));
	}
}

async function runLogout(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	let providerArg = flags.provider;
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		if (!providerArg) {
			const stored = store.listProviders();
			if (stored.length === 0) {
				process.stdout.write(`${t("cli.commands.auth-broker.noCredentials")}\n`);
				return;
			}
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			try {
				providerArg = stored[await pickIndex(rl, t("cli.commands.auth-broker.logoutSelection"), stored)];
			} finally {
				rl.close();
			}
		}
		await store.deleteAuthCredentials(providerArg, "logged out by user");
		process.stdout.write(`${t("cli.commands.auth-broker.loggedOut", { provider: providerArg })}\n`);
	} finally {
		store.close();
	}
}

async function runList(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	applyUnpausedProviders(await resolveEffectiveSettings());
	const providers = getOAuthProviders();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(providers.map(p => ({ id: p.id, name: p.name })))}\n`);
		return;
	}
	process.stdout.write(`${t("cli.commands.auth-broker.availableProviders")}\n\n`);
	for (const p of providers) {
		process.stdout.write(`  ${p.id.padEnd(20)} ${p.name}\n`);
	}
}

// ─── CLIProxyAPI import ─────────────────────────────────────────────────

/**
 * Maps the `type` field of a CLIProxyAPI credential JSON to the NeoPi provider id.
 * The filename also encodes the type (e.g. `claude-foo@bar.json`), but the
 * in-file `type` is authoritative — we only fall back to filename if absent.
 */
const CLIPROXY_TYPE_TO_PROVIDER: Record<string, string> = {
	claude: "anthropic",
	codex: "openai-codex",
	gemini: "google-gemini-cli",
	antigravity: "google-antigravity",
	"gemini-cli": "google-gemini-cli",
};

interface CliProxyCredentialJson {
	type?: string;
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expired?: string;
	last_refresh?: string;
	email?: string;
	account_id?: string;
	disabled?: boolean;
}

interface ImportPlanEntry {
	sourceFile: string;
	provider: string;
	email: string | null;
	accountId: string | null;
	expiresAt: number;
	disabled: boolean;
	credential: OAuthCredential;
}

function resolveCliProxyProvider(json: CliProxyCredentialJson, filename: string, overrideId?: string): string | null {
	if (overrideId && overrideId.length > 0) return overrideId;
	const typeField = json.type?.trim().toLowerCase();
	if (typeField && CLIPROXY_TYPE_TO_PROVIDER[typeField]) return CLIPROXY_TYPE_TO_PROVIDER[typeField];
	// Fall back to filename prefix: `<type>-<email>.json`
	const base = path.basename(filename, ".json").toLowerCase();
	for (const prefix in CLIPROXY_TYPE_TO_PROVIDER) {
		const providerId = CLIPROXY_TYPE_TO_PROVIDER[prefix];
		if (base.startsWith(`${prefix}-`) || base === prefix) return providerId;
	}
	return null;
}

function parseCliProxyExpiry(raw: string | undefined): number | null {
	if (!raw) return null;
	// CLIProxyAPI writes RFC3339-ish dates. `Date.parse` handles both `Z` and offsets.
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms)) return null;
	return ms;
}

async function collectImportSources(target: string): Promise<string[]> {
	const stat = await fs.stat(target);
	if (stat.isFile()) return [target];
	if (!stat.isDirectory()) {
		throw new Error(t("cli.commands.auth-broker.importInvalidSource", { path: target }));
	}
	const entries = await fs.readdir(target, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		files.push(path.join(target, entry.name));
	}
	files.sort();
	return files;
}

async function loadImportPlan(
	target: string,
	overrideProvider: string | undefined,
	includeDisabled: boolean,
	outputLocale: Locale,
): Promise<{ entries: ImportPlanEntry[]; skipped: Array<{ file: string; reason: string }> }> {
	const files = await collectImportSources(target);
	const entries: ImportPlanEntry[] = [];
	const skipped: Array<{ file: string; reason: string }> = [];
	for (const file of files) {
		let json: CliProxyCredentialJson;
		try {
			json = JSON.parse(await fs.readFile(file, "utf8")) as CliProxyCredentialJson;
		} catch (err) {
			skipped.push({
				file,
				reason: t(outputLocale, "cli.commands.auth-broker.importUnreadable", { error: String(err) }),
			});
			continue;
		}
		if (json.disabled === true && !includeDisabled) {
			skipped.push({ file, reason: t(outputLocale, "cli.commands.auth-broker.importDisabled") });
			continue;
		}
		const provider = resolveCliProxyProvider(json, file, overrideProvider);
		if (!provider) {
			skipped.push({
				file,
				reason: t(outputLocale, "cli.commands.auth-broker.importUnknownType", { type: json.type ?? "?" }),
			});
			continue;
		}
		if (!json.access_token || !json.refresh_token) {
			skipped.push({ file, reason: t(outputLocale, "cli.commands.auth-broker.importMissingFields") });
			continue;
		}
		const expiresAt = parseCliProxyExpiry(json.expired);
		if (expiresAt === null) {
			skipped.push({
				file,
				reason: t(outputLocale, "cli.commands.auth-broker.importInvalidExpiry", { value: json.expired ?? "?" }),
			});
			continue;
		}
		const email = typeof json.email === "string" && json.email.length > 0 ? json.email : null;
		const accountId = typeof json.account_id === "string" && json.account_id.length > 0 ? json.account_id : null;
		const credential: OAuthCredential = {
			type: "oauth",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: expiresAt,
			...(email !== null ? { email } : {}),
			...(accountId !== null ? { accountId } : {}),
		};
		entries.push({
			sourceFile: file,
			provider,
			email,
			accountId,
			expiresAt,
			disabled: json.disabled === true,
			credential,
		});
	}
	return { entries, skipped };
}

function describeImportEntry(entry: ImportPlanEntry): string {
	const ident = entry.email ?? entry.accountId ?? t("cli.commands.auth-broker.importNoIdentity");
	const stale = entry.expiresAt < Date.now() ? t("cli.commands.auth-broker.importExpired") : "";
	const disabled = entry.disabled ? t("cli.commands.auth-broker.importDisabledBadge") : "";
	return t("cli.commands.auth-broker.importEntry", {
		provider: entry.provider,
		identity: ident,
		stale,
		disabled,
		path: entry.sourceFile,
	});
}

async function runImport(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const target = flags.source;
	if (!target) {
		throw new Error(t("cli.commands.auth-broker.importUsage", { app: APP_NAME }));
	}
	const resolvedTarget = path.resolve(target.startsWith("~") ? target.replace(/^~/, os.homedir()) : target);
	const { entries, skipped } = await loadImportPlan(
		resolvedTarget,
		flags.provider,
		flags.includeDisabled === true,
		flags.json ? "en" : getLocale(),
	);

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				imported: flags.dryRun
					? []
					: entries.map(e => ({ provider: e.provider, email: e.email, file: e.sourceFile })),
				plan: entries.map(e => ({
					provider: e.provider,
					email: e.email,
					accountId: e.accountId,
					expiresAt: e.expiresAt,
					disabled: e.disabled,
					file: e.sourceFile,
				})),
				skipped,
			})}\n`,
		);
	}

	if (!flags.json) {
		for (const skip of skipped) {
			process.stdout.write(`${chalk.yellow(t("cli.commands.auth-broker.skip"))} ${skip.file}: ${skip.reason}\n`);
		}
	}

	if (entries.length === 0) {
		if (!flags.json) process.stdout.write(`${t("cli.commands.auth-broker.importEmpty", { path: resolvedTarget })}\n`);
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`${t("cli.commands.auth-broker.importDryRun", { count: entries.length })}\n`);
			for (const entry of entries) process.stdout.write(`  ${describeImportEntry(entry)}\n`);
		}
		return;
	}

	const brokerConfig = await resolveAuthBrokerConfig();
	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		for (const entry of entries) {
			try {
				await client.uploadCredential(entry.provider, entry.credential);
				if (!flags.json) {
					process.stdout.write(
						`${chalk.green(t("cli.commands.auth-broker.uploaded"))} ${describeImportEntry(entry)} → ${brokerConfig.url}\n`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ error: message, file: entry.sourceFile })}\n`);
				} else {
					process.stdout.write(
						`${chalk.red(t("cli.commands.auth-broker.failed"))} ${describeImportEntry(entry)}: ${message}\n`,
					);
				}
				process.exitCode = 1;
			}
		}
		return;
	}

	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		for (const entry of entries) {
			await store.upsertAuthCredential(entry.provider, entry.credential);
			if (!flags.json)
				process.stdout.write(
					`${chalk.green(t("cli.commands.auth-broker.imported"))} ${describeImportEntry(entry)}\n`,
				);
		}
	} finally {
		store.close();
	}
}

// ─── Migrate: local SQLite + env → broker ──────────────────────────────

interface MigratePlanEntry {
	source: "local-sqlite" | "env";
	provider: string;
	credential: AuthCredential;
	identity: string;
}

interface MigrateSkip {
	source: "local-sqlite" | "env";
	provider: string;
	identity: string;
	reason: string;
}

function credentialIdentity(provider: string, credential: AuthCredential, outputLocale: Locale): string {
	if (credential.type === "api_key") return t(outputLocale, "cli.commands.auth-broker.apiKey");
	const base = credential.email ?? credential.accountId ?? credential.projectId ?? `<${provider} oauth>`;
	return credential.orgId ? `${base} (${credential.orgName ?? credential.orgId})` : base;
}

/**
 * Whether the broker already holds this credential, so re-runs are idempotent.
 * An OAuth row is held when uploading it would replace a broker row (the store's
 * own identity match), so no upload overwrites the broker's newer refresh token,
 * or when a broker row is the same account stored under another identity key, so
 * no upload duplicates it. API keys collapse to a single one per provider.
 */
function brokerAlreadyHas(
	existing: readonly AuthCredentialSnapshotEntry[],
	provider: string,
	credential: AuthCredential,
): boolean {
	return existing.some(entry => {
		if (entry.provider !== provider) return false;
		if (credential.type === "api_key") return entry.credential.type === "api_key";
		return (
			entry.credential.type === "oauth" &&
			(matchesReplacementCredential(provider, entry.credential, entry.identityKey, credential) ||
				isSameOAuthAccount(entry.credential, credential))
		);
	});
}

async function runMigrate(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(t("cli.commands.auth-broker.migrateBrokerRequired"));
	}
	if (flags.fromLocal !== true) {
		throw new Error(t("cli.commands.auth-broker.migrateSourceRequired", { app: APP_NAME }));
	}

	const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
	const snapshotResult = await client.fetchSnapshot();
	if (snapshotResult.status !== 200) throw new Error(t("cli.commands.auth-broker.migrateNoSnapshot"));
	const existing = snapshotResult.snapshot.credentials;

	const plan: MigratePlanEntry[] = [];
	const skipped: MigrateSkip[] = [];
	const outputLocale = flags.json ? "en" : getLocale();

	// 1. Local SQLite rows.
	const localDbPath = getAgentDbPath();
	const localStore = await SqliteAuthCredentialStore.open(localDbPath);
	const plannedApiKeyProviders = new Set<string>();
	try {
		for (const row of localStore.listAuthCredentials()) {
			// Skip placeholder sentinels that pi-ai treats as "authenticated via
			// out-of-band mechanism" (Bedrock/Vertex `<authenticated>`). They
			// aren't real keys and uploading them would store garbage on the
			// broker. Mirrors the env-var path's guard below.
			if (row.credential.type === "api_key" && row.credential.key === "<authenticated>") {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity: t(outputLocale, "cli.commands.auth-broker.apiKey"),
					reason: t(outputLocale, "cli.commands.auth-broker.migrateSentinel"),
				});
				continue;
			}
			const identity = credentialIdentity(row.provider, row.credential, outputLocale);
			if (row.credential.type === "oauth" && flags.includeOauth !== true) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: t(outputLocale, "cli.commands.auth-broker.migrateSkipOauth"),
				});
				continue;
			}
			if (brokerAlreadyHas(existing, row.provider, row.credential)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: t(outputLocale, "cli.commands.auth-broker.migrateAlreadyOnBroker"),
				});
				continue;
			}
			if (row.credential.type === "api_key" && plannedApiKeyProviders.has(row.provider)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: t(outputLocale, "cli.commands.auth-broker.migrateDuplicateLocalKey"),
				});
				continue;
			}
			if (row.credential.type === "api_key") plannedApiKeyProviders.add(row.provider);
			plan.push({ source: "local-sqlite", provider: row.provider, credential: row.credential, identity });
		}
	} finally {
		localStore.close();
	}

	// 2. Env-var API keys (opt-in).
	if (flags.includeEnv === true) {
		for (const provider of listProvidersWithEnvKey()) {
			const envValue = getEnvApiKey(provider);
			if (!envValue) continue;
			if (envValue === "<authenticated>") continue; // Bedrock/Vertex sentinels — not literal keys.
			const credential: AuthCredential = { type: "api_key", key: envValue };
			if (brokerAlreadyHas(existing, provider, credential)) {
				skipped.push({
					source: "env",
					provider,
					identity: t(outputLocale, "cli.commands.auth-broker.apiKey"),
					reason: t(outputLocale, "cli.commands.auth-broker.migrateExistingBrokerKey"),
				});
				continue;
			}
			// Also skip if local SQLite already produced an entry for this provider in this batch.
			if (plan.some(p => p.provider === provider && p.credential.type === "api_key")) {
				skipped.push({
					source: "env",
					provider,
					identity: t(outputLocale, "cli.commands.auth-broker.apiKey"),
					reason: t(outputLocale, "cli.commands.auth-broker.migrateExistingLocalKey"),
				});
				continue;
			}
			plan.push({
				source: "env",
				provider,
				credential,
				identity: t(outputLocale, "cli.commands.auth-broker.apiKey"),
			});
		}
	}

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				plan: plan.map(p => ({ source: p.source, provider: p.provider, identity: p.identity })),
				skipped,
			})}\n`,
		);
	} else {
		for (const skip of skipped) {
			process.stdout.write(
				`${chalk.yellow(t("cli.commands.auth-broker.skip"))} [${skip.source}] ${skip.provider} ${skip.identity}: ${skip.reason}\n`,
			);
		}
	}

	if (plan.length === 0) {
		if (!flags.json) process.stdout.write(`${t("cli.commands.auth-broker.migrateEmpty")}\n`);
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`${t("cli.commands.auth-broker.migrateDryRun", { count: plan.length })}\n`);
			for (const entry of plan) {
				process.stdout.write(`  [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		}
		return;
	}

	for (const entry of plan) {
		try {
			await client.uploadCredential(entry.provider, entry.credential);
			if (!flags.json) {
				process.stdout.write(
					`${chalk.green(t("cli.commands.auth-broker.uploaded"))} [${entry.source}] ${entry.provider} ${entry.identity}\n`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ error: message, provider: entry.provider })}\n`);
			} else {
				process.stdout.write(
					`${chalk.red(t("cli.commands.auth-broker.migrateFailed"))} [${entry.source}] ${entry.provider}: ${message}\n`,
				);
			}
			process.exitCode = 1;
		}
	}
}

async function runStatus(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const cfg = await resolveAuthBrokerConfig();
	if (!cfg) {
		if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: "not_configured" })}\n`);
		else process.stdout.write(`${chalk.yellow(t("cli.commands.auth-broker.statusNotConfigured"))}\n`);
		return;
	}
	const client = new AuthBrokerClient({ url: cfg.url, token: cfg.token });
	try {
		const health = await client.healthz();
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ url: cfg.url, ...health })}\n`);
		} else {
			process.stdout.write(
				`${chalk.green("OK")} ${cfg.url} (version=${health.version ?? t("cli.commands.auth-broker.unknownVersion")})\n`,
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, url: cfg.url, error: message })}\n`);
		} else {
			process.stdout.write(`${chalk.red(t("cli.commands.auth-broker.statusFailed"))} ${cfg.url}: ${message}\n`);
		}
		process.exitCode = 1;
	}
}

export async function runAuthBrokerCommand(cmd: AuthBrokerCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "login":
			await runLogin(cmd.flags);
			return;
		case "logout":
			await runLogout(cmd.flags);
			return;
		case "import":
			await runImport(cmd.flags);
			return;
		case "migrate":
			await runMigrate(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "list":
			await runList(cmd.flags);
			return;
		default: {
			// Exhaustive check.
			const _exhaustive: never = cmd.action;
			throw new Error(t("cli.commands.auth-broker.unknownAction", { action: String(_exhaustive) }));
		}
	}
}

export { ACTIONS as AUTH_BROKER_ACTIONS };

// Touch `$` so Bun's tree-shaker keeps the shell helper imported (used by future verbs).
void $;
