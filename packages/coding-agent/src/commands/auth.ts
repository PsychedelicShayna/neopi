/**
 * Copy stored provider credentials between machines.
 *
 * `omp auth export` prints every active credential in the local credential
 * store (`agent.db`) as JSON — API keys and OAuth logins, refresh tokens
 * included. `omp auth import <file>` merges such a file into the local store:
 * an imported OAuth login replaces the stored login of the same provider
 * account, an imported API key replaces the provider's stored API key, and
 * everything else is kept.
 */
import {
	type AuthCredential,
	type AuthCredentialStore,
	isSameOAuthAccount,
	matchesReplacementCredential,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	resolveCredentialIdentityKey,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { getAgentDbPath, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { authHelp as commandHelp } from "../cli/command-help";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";

/** Format version of the `omp auth export` document. */
export const AUTH_EXPORT_VERSION = 1;

/** One stored credential in an `omp auth export` document. */
export interface AuthExportEntry {
	/** Provider id the credential authenticates (e.g. `anthropic`). */
	provider: string;
	/** The credential exactly as stored, OAuth refresh token included. */
	credential: AuthCredential;
}

/** The document `omp auth export` prints and `omp auth import` reads. */
export interface AuthExport {
	version: typeof AUTH_EXPORT_VERSION;
	credentials: AuthExportEntry[];
}

/** Result of {@link importAuthCredentials}. */
export interface AuthImportSummary {
	/** Number of credentials written. */
	imported: number;
	/** Providers that received credentials, in first-seen order. */
	providers: string[];
}

/** A malformed or unsupported credential export. */
export class AuthTransferError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthTransferError";
	}
}

/** Every active credential in `store`, in storage order. */
export function exportAuthCredentials(store: Pick<AuthCredentialStore, "listAuthCredentials">): AuthExport {
	return {
		version: AUTH_EXPORT_VERSION,
		credentials: store.listAuthCredentials().map(row => ({ provider: row.provider, credential: row.credential })),
	};
}

function parseCredential(value: unknown, where: string): AuthCredential {
	if (!isRecord(value)) throw new AuthTransferError(t("cli.commands.auth.invalid.credential_object", { where }));
	if (value.type === "api_key") {
		if (typeof value.key !== "string" || value.key.length === 0) {
			throw new AuthTransferError(t("cli.commands.auth.invalid.api_key", { where }));
		}
		return value.source === "login"
			? { type: "api_key", key: value.key, source: "login" }
			: { type: "api_key", key: value.key };
	}
	if (value.type === "oauth") {
		if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
			throw new AuthTransferError(t("cli.commands.auth.invalid.oauth_fields", { where }));
		}
		if (value.refresh === REMOTE_REFRESH_SENTINEL) {
			throw new AuthTransferError(t("cli.commands.auth.invalid.oauth_refresh", { where }));
		}
		// Required fields are checked above; the optional identity fields are
		// carried as stored so the target store derives the same account identity.
		return value as OAuthCredential;
	}
	throw new AuthTransferError(
		t("cli.commands.auth.invalid.credential_type", { where, type: String(JSON.stringify(value.type)) }),
	);
}

/**
 * Parse and validate an `omp auth export` document. Throws
 * {@link AuthTransferError} naming the first offending entry.
 */
export function parseAuthExport(text: string, source = t("cli.commands.auth.credential_file")): AuthExport {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AuthTransferError(t("cli.commands.auth.invalid.json", { source }));
	}
	if (!isRecord(value)) throw new AuthTransferError(t("cli.commands.auth.invalid.document", { source }));
	if (value.version !== AUTH_EXPORT_VERSION) {
		throw new AuthTransferError(
			t("cli.commands.auth.invalid.version", {
				source,
				version: String(JSON.stringify(value.version)),
				expected: AUTH_EXPORT_VERSION,
			}),
		);
	}
	if (!Array.isArray(value.credentials)) {
		throw new AuthTransferError(t("cli.commands.auth.invalid.credentials", { source }));
	}
	const credentials = value.credentials.map((entry: unknown, index): AuthExportEntry => {
		const where = `${source}: credentials[${index}]`;
		if (!isRecord(entry) || typeof entry.provider !== "string" || entry.provider.length === 0) {
			throw new AuthTransferError(t("cli.commands.auth.invalid.provider", { where }));
		}
		return {
			provider: entry.provider,
			credential: parseCredential(entry.credential, `${where} (${entry.provider})`),
		};
	});
	return { version: AUTH_EXPORT_VERSION, credentials };
}

/**
 * Whether importing `incoming` for `provider` replaces the stored `existing`
 * credential: an API key replaces the provider's API key; an OAuth login
 * replaces the stored login of the same account.
 */
function replacesCredential(provider: string, existing: AuthCredential, incoming: AuthCredential): boolean {
	if (incoming.type === "api_key") return existing.type === "api_key";
	if (existing.type !== "oauth") return false;
	return (
		matchesReplacementCredential(provider, existing, resolveCredentialIdentityKey(provider, existing), incoming) ||
		isSameOAuthAccount(existing, incoming)
	);
}

/**
 * Merge `data` into `store`, one provider at a time: stored credentials that
 * an imported one replaces (same provider and account) are swapped for it,
 * all others are kept. Each provider is written in one store transaction.
 */
export async function importAuthCredentials(
	store: Pick<AuthCredentialStore, "listAuthCredentials" | "replaceAuthCredentials">,
	data: AuthExport,
): Promise<AuthImportSummary> {
	const byProvider = new Map<string, AuthCredential[]>();
	for (const { provider, credential } of data.credentials) {
		const list = byProvider.get(provider);
		if (list) list.push(credential);
		else byProvider.set(provider, [credential]);
	}
	for (const [provider, incoming] of byProvider) {
		let merged = store.listAuthCredentials(provider).map(row => row.credential);
		for (const credential of incoming) {
			merged = merged.filter(existing => !replacesCredential(provider, existing, credential));
			merged.push(credential);
		}
		await store.replaceAuthCredentials(provider, merged);
	}
	return { imported: data.credentials.length, providers: [...byProvider.keys()] };
}

export default class Auth extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "export or import",
			required: true,
			options: ["export", "import"],
		}),
		file: Args.string({
			description: "File written by `omp auth export`, or - for stdin (import)",
			required: false,
		}),
	};

	static get examples(): string[] {
		return [
			`# ${t("cli.commands.auth.example.export")}\n  omp auth export > credentials.json`,
			`# ${t("cli.commands.auth.example.import")}\n  omp auth import credentials.json`,
			`# ${t("cli.commands.auth.example.ssh")}\n  omp auth export | ssh host omp auth import -`,
		];
	}

	async run(): Promise<void> {
		const { args, argv } = await this.parse(Auth);
		const action = args.action;
		if (action === "export" && argv.length > 1) {
			throw new CliUsageError(
				t("cli.commands.auth.error.unexpected_argument", { arg: String(argv[1]), usage: "omp auth export" }),
			);
		}
		if (action === "import" && !args.file) {
			throw new CliUsageError(t("cli.commands.auth.error.missing_file"));
		}
		if (action === "import" && argv.length > 2) {
			throw new CliUsageError(
				t("cli.commands.auth.error.unexpected_argument", {
					arg: String(argv[2]),
					usage: "omp auth import <file|->",
				}),
			);
		}

		const broker = await resolveAuthBrokerConfig();
		if (broker) {
			process.stderr.write(
				`${chalk.red(t("cli.commands.auth.error.broker_in_use", { url: broker.url }))}\n` +
					`${t("cli.commands.auth.error.broker_hint")}\n`,
			);
			process.exitCode = 1;
			return;
		}

		if (action === "export") {
			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			let data: AuthExport;
			try {
				data = exportAuthCredentials(store);
			} finally {
				store.close();
			}
			const oauthCount = data.credentials.filter(entry => entry.credential.type === "oauth").length;
			if (oauthCount > 0) {
				process.stderr.write(
					`${chalk.yellow(t("cli.commands.auth.warning.live_secrets", { count: oauthCount }))}\n`,
				);
			}
			process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
			return;
		}

		const file = args.file ?? "";
		let text: string;
		try {
			text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			process.stderr.write(`${chalk.red(t("cli.commands.auth.error.file_not_found", { file }))}\n`);
			process.exitCode = 1;
			return;
		}
		let data: AuthExport;
		try {
			data = parseAuthExport(text, file === "-" ? "stdin" : file);
		} catch (error) {
			if (!(error instanceof AuthTransferError)) throw error;
			process.stderr.write(
				`${chalk.red(t("cli.commands.auth.error.invalid_export", { message: error.message }))}\n`,
			);
			process.exitCode = 1;
			return;
		}
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const summary = await importAuthCredentials(store, data);
			process.stderr.write(
				summary.imported === 0
					? `${t("cli.commands.auth.import.empty")}\n`
					: `${t("cli.commands.auth.import.summary", {
							count: summary.imported,
							providers: summary.providers.join(", "),
						})}\n`,
			);
		} finally {
			store.close();
		}
	}
}
