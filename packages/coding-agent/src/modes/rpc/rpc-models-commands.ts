import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { listLogoutAccounts, logoutCredential } from "../../slash-commands/helpers/logout";
import type { RpcCommand, RpcResponse, RpcExtensionUIResponse } from "./rpc-types";
import { RpcModelsConfiguration, RpcModelsConfigurationError } from "./rpc-models-configuration";

type ModelsCommand = Extract<
	RpcCommand,
	{
		type:
			| "get_models_configuration"
			| "set_model_role_configuration"
			| "set_model_role_fallbacks"
			| "set_model_role_description"
			| "delete_model_role"
			| "set_model_role_storage"
			| "set_effort_rules"
			| "set_provider_api_key"
			| "cancel_login"
			| "get_login_providers"
			| "login"
			| "get_logout_accounts"
			| "activate_account"
			| "logout";
	}
>;
const COMMANDS = new Set([
	"get_models_configuration",
	"set_model_role_configuration",
	"set_model_role_fallbacks",
	"set_model_role_description",
	"delete_model_role",
	"set_model_role_storage",
	"set_effort_rules",
	"set_provider_api_key",
	"cancel_login",
	"get_login_providers",
	"login",
	"get_logout_accounts",
	"activate_account",
	"logout",
]);

interface PendingLogin {
	resolve(response: RpcExtensionUIResponse): void;
	reject(error: Error): void;
}

export interface RpcModelsCommandsOptions {
	session: AgentSession;
	output(frame: object): void;
	pending: { set(id: string, value: PendingLogin): unknown; delete(id: string): unknown };
	input(
		message: string,
		placeholder: string | undefined,
		secret: boolean | undefined,
		loginId: string,
		signal: AbortSignal,
	): Promise<string | undefined>;
	confirm?(title: string, message: string, loginId: string, signal: AbortSignal): Promise<boolean>;
}

/** Per-connection auth lifetimes. Other clients cannot answer or cancel this connection's login. */
export class RpcModelsCommands {
	readonly #configuration: RpcModelsConfiguration;
	readonly #logins = new Map<string, AbortController>();
	constructor(readonly options: RpcModelsCommandsOptions) {
		this.#configuration = new RpcModelsConfiguration(options.session);
	}

	accepts(command: RpcCommand): command is ModelsCommand {
		return COMMANDS.has(command.type);
	}

	async handle(command: ModelsCommand): Promise<RpcResponse> {
		const { session, output, pending, input } = this.options;
		const { id } = command;
		const success = (data?: object): RpcResponse =>
			({ id, type: "response", command: command.type, success: true, ...(data ? { data } : {}) }) as RpcResponse;
		try {
			switch (command.type) {
				case "get_models_configuration":
					return success(await this.#configuration.read());
				case "set_model_role_configuration":
					await this.#configuration.setRole(command);
					return success();
				case "set_model_role_fallbacks":
					await this.#configuration.setRoleFallbacks(command);
					return success();
				case "set_model_role_description":
					await this.#configuration.setRoleDescription(command);
					return success();
				case "delete_model_role":
					await this.#configuration.deleteRole(command);
					return success();
				case "set_model_role_storage":
					await this.#configuration.setRoleStorage(command);
					return success();
				case "set_effort_rules":
					await this.#configuration.setEffortRules(command);
					return success();
				case "set_provider_api_key": {
					if (typeof command.providerId !== "string" || !session.modelRegistry.hasProvider(command.providerId))
						throw new Error("Unknown native inference provider");
					if (typeof command.apiKey !== "string" || !command.apiKey.trim())
						throw new Error("An API key is required");
					await session.modelRegistry.authStorage.credentials.upsert(command.providerId, {
						type: "api_key",
						key: command.apiKey,
						source: "login",
					});
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success();
				}
				case "get_login_providers": {
					await session.modelRegistry.authStorage.credentials.reload();
					return success({
						providers: getOAuthProviders().map(provider => ({
							id: provider.id,
							name: provider.name,
							available: provider.available,
							loginKind: provider.loginKind,
							deviceCode: provider.deviceCode,
							...(provider.storeCredentialsAs ? { storeCredentialsAs: provider.storeCredentialsAs } : {}),
							acceptsKeys: session.modelRegistry.hasProvider(provider.storeCredentialsAs ?? provider.id),
							authenticated:
								session.modelRegistry.authStorage.keys.source(provider.storeCredentialsAs ?? provider.id) !==
								undefined,
						})),
					});
				}
				case "cancel_login": {
					const login = this.#logins.get(command.loginId);
					if (!login) throw new Error("This connection has no such active login");
					login.abort();
					return success();
				}
				case "login": {
					const provider = getOAuthProviders().find(provider => provider.id === command.providerId);
					if (!provider) throw new Error(`Unknown OAuth provider: ${command.providerId}`);
					if (!id || this.#logins.has(id)) throw new Error("Login requires a unique request id");
					const controller = new AbortController();
					let unsupportedUi: string | undefined;
					const secrets: string[] = [];
					const redact = (message: string): string =>
						secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), message);
					this.#logins.set(id, controller);
					const closeKey = `login:${id}`;
					pending.set(closeKey, { resolve: () => {}, reject: () => controller.abort() });
					try {
						const identity = await session.modelRegistry.authStorage.oauth.login(command.providerId, {
							signal: controller.signal,
							onAuth: info =>
								output({
									type: "extension_ui_request",
									id: Snowflake.next() as string,
									method: "open_url",
									...info,
									loginId: id,
								}),
							onProgress: message =>
								output({
									type: "extension_ui_request",
									id: Snowflake.next() as string,
									method: "notify",
									message: redact(message),
									notifyType: "info",
									loginId: id,
								}),
							onPrompt: async prompt => {
								if (controller.signal.aborted) throw new Error("Login cancelled");
								if (prompt.secret && command.allowSecretInput !== true) {
									unsupportedUi = "Secret login input requires allowSecretInput: true";
									throw new Error(unsupportedUi);
								}
								const answer = await input(
									prompt.message,
									prompt.placeholder,
									prompt.secret,
									id,
									controller.signal,
								);
								if (answer === undefined) {
									controller.abort();
									throw new Error("Login cancelled");
								}
								if (prompt.secret && answer) secrets.push(answer);
								return answer;
							},
							onConfirm: async prompt => {
								controller.signal.throwIfAborted();
								if (command.allowTrustConfirmation !== true || !this.options.confirm) {
									unsupportedUi = "Certificate confirmation requires allowTrustConfirmation: true";
									throw new Error(unsupportedUi);
								}
								const confirmed = await this.options.confirm(
									prompt.title,
									prompt.message,
									id,
									controller.signal,
								);
								if (!confirmed) {
									controller.abort();
									throw new Error("Login cancelled");
								}
								return true;
							},
						});
						controller.signal.throwIfAborted();
						if (!identity) throw new Error("No credential was saved");
						await session.modelRegistry.refreshProvider(provider.storeCredentialsAs ?? provider.id, "online");
						return success({ providerId: command.providerId });
					} catch (cause) {
						if (controller.signal.aborted)
							return {
								id,
								type: "response",
								command: "login",
								success: false,
								error: "Login cancelled",
								code: "login_cancelled",
							};
						if (unsupportedUi)
							return {
								id,
								type: "response",
								command: "login",
								success: false,
								error: unsupportedUi,
								code: "login_ui_unsupported",
							};
						throw new Error(redact(cause instanceof Error ? cause.message : String(cause)));
					} finally {
						this.#logins.delete(id);
						pending.delete(closeKey);
					}
				}
				case "get_logout_accounts": {
					if (typeof command.providerId !== "string") throw new Error("providerId must be a string");
					return success({
						accounts: await listLogoutAccounts(
							session.modelRegistry.authStorage,
							command.providerId,
							session.sessionId,
						),
					});
				}
				case "activate_account": {
					if (
						typeof command.providerId !== "string" ||
						!Number.isSafeInteger(command.credentialId) ||
						command.credentialId <= 0
					)
						throw new Error("providerId must be a string and credentialId a positive integer");
					if (!session.modelRegistry.hasProvider(command.providerId))
						throw new Error("Unknown native inference provider");
					await session.modelRegistry.authStorage.credentials.reload();
					if (session.isStreaming || session.isCompacting)
						throw new RpcModelsConfigurationError(
							"session_busy",
							"Cannot activate an account while the session is busy",
						);
					if (!session.pinProviderOAuthAccount(command.providerId, command.credentialId))
						throw new Error("This OAuth account is unavailable for the provider and session");
					return success();
				}
				case "logout": {
					if (typeof command.providerId !== "string" || !Number.isInteger(command.credentialId))
						throw new Error("providerId must be a string and credentialId an integer");
					const result = await logoutCredential(
						session.modelRegistry,
						command.providerId,
						command.credentialId,
						session.sessionId,
					);
					if (!result.removed) throw new Error("This credential is no longer stored for the provider");
					return success({ remainingSource: result.remainingSource });
				}
			}
		} catch (cause) {
			return {
				id,
				type: "response",
				command: command.type,
				success: false,
				error: cause instanceof Error ? cause.message : String(cause),
				code: cause instanceof RpcModelsConfigurationError ? cause.code : "invalid_value",
			};
		}
	}
}
