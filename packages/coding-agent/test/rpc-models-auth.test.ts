import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	registerOAuthProvider,
	unregisterOAuthProvider,
	type ApiKeyLoginResult,
	type OAuthLoginCallbacks,
} from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcModelsCommands } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-models-commands";
import { RpcModelsConfiguration } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-models-configuration";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	requestRpcConfirm,
	requestRpcInput,
	RpcPendingExtensionRequests,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const loginFixtureId = "rpc-private-login-fixture";
const memberKey = "secret-member-key-not-in-rpc-output";

describe("native provider and account RPC contracts", () => {
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession;
	let manager: SessionManager;
	let commands: RpcModelsCommands;

	beforeEach(() => {
		auth = createInMemoryAuthStorage();
		registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing native test model");
		vi.spyOn(registry, "getAll").mockReturnValue([model]);
		vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
		manager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		commands = new RpcModelsCommands({ session, output: () => {}, pending: new Map(), input: async () => undefined });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProvider(loginFixtureId);
		await session.dispose();
		auth.close();
	});

	async function saveAccount(provider: string, accountId: string): Promise<number> {
		const entries = await auth.credentials.upsert(provider, {
			type: "oauth",
			access: `secret-access-${accountId}`,
			refresh: `secret-refresh-${accountId}`,
			expires: Date.now() + 3_600_000,
			accountId,
			email: `${accountId}@example.com`,
		});
		const entry = entries.find(
			entry =>
				entry.provider === provider &&
				entry.credential.type === "oauth" &&
				entry.credential.accountId === accountId,
		);
		if (!entry) throw new Error("Missing saved test account");
		return entry.id;
	}

	function registerPrivateLogin(
		login?: (callbacks: OAuthLoginCallbacks) => Promise<string | ApiKeyLoginResult>,
	): void {
		registerOAuthProvider({
			id: loginFixtureId,
			name: "Private assigned-key fixture",
			loginKind: "custom",
			login:
				login ??
				(async callbacks => {
					const origin = await callbacks.onPrompt({ message: "Server URL" });
					if (origin !== "https://private.example") throw new Error("Unexpected fixture origin");
					if (
						!callbacks.onConfirm ||
						!(await callbacks.onConfirm({
							title: "Trust private server?",
							message:
								"https://private.example; server SHA256:fixture; CA SHA256:fixture; provider credential only",
						}))
					)
						throw new Error("Confirmation required");
					return {
						type: "api_key",
						key: await callbacks.onPrompt({ message: "Administrator-assigned member key", secret: true }),
					};
				}),
		});
	}

	function privateLoginCommands(
		answers: Array<{ value: string } | { confirmed: boolean } | { cancelled: true }>,
		frames: RpcExtensionUIRequest[],
	): { commands: RpcModelsCommands; pending: RpcPendingExtensionRequests; confirmation: Promise<void> } {
		const pending = new RpcPendingExtensionRequests();
		const confirmation = Promise.withResolvers<void>();
		const output = (frame: object): void => {
			const request = frame as RpcExtensionUIRequest;
			frames.push(request);
			if (request.method === "confirm") confirmation.resolve();
			if (request.method !== "input" && request.method !== "confirm") return;
			const answer = answers.shift();
			if (answer) pending.get(request.id)?.resolve({ type: "extension_ui_response", id: request.id, ...answer });
		};
		return {
			pending,
			confirmation: confirmation.promise,
			commands: new RpcModelsCommands({
				session,
				pending,
				output,
				input: (title, placeholder, secret, loginId, signal) =>
					requestRpcInput(pending, frame => output({ ...frame, loginId }), title, placeholder, { secret, signal }),
				confirm: (title, message, loginId, signal) =>
					requestRpcConfirm(pending, frame => output({ ...frame, loginId }), title, message, { signal }),
			}),
		};
	}

	test("private login saves the assigned key through native credentials only after boolean trust consent", async () => {
		registerPrivateLogin();
		const refresh = vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
		const frames: RpcExtensionUIRequest[] = [];
		const { commands: login } = privateLoginCommands(
			[{ value: "https://private.example" }, { confirmed: true }, { value: memberKey }],
			frames,
		);
		const response = await login.handle({
			type: "login",
			id: "private-login",
			providerId: loginFixtureId,
			allowSecretInput: true,
			allowTrustConfirmation: true,
		});
		expect(response).toMatchObject({ success: true, data: { providerId: loginFixtureId } });
		expect(
			auth.credentials
				.list(loginFixtureId)
				.some(row => row.credential.type === "api_key" && row.credential.key === memberKey),
		).toBe(true);
		expect(refresh).toHaveBeenCalledWith(loginFixtureId, "online");
		expect(frames.map(frame => frame.method)).toEqual(["input", "confirm", "input"]);
		expect(frames[0]).toMatchObject({ loginId: "private-login", title: "Server URL" });
		expect(frames[1]).toMatchObject({ loginId: "private-login", method: "confirm" });
		expect(frames[2]).toMatchObject({ loginId: "private-login", secret: true });
		expect(JSON.stringify([response, frames])).not.toContain(memberKey);
	});

	test("missing UI capabilities fail before emitting their protected dialog or saving credentials", async () => {
		registerPrivateLogin();
		const refresh = vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
		for (const capability of ["secret", "trust"] as const) {
			const frames: RpcExtensionUIRequest[] = [];
			const { commands: login } = privateLoginCommands(
				[{ value: "https://private.example" }, { confirmed: true }, { value: memberKey }],
				frames,
			);
			const response = await login.handle({
				type: "login",
				id: `unsupported-${capability}`,
				providerId: loginFixtureId,
				allowSecretInput: capability !== "secret",
				allowTrustConfirmation: capability !== "trust",
			});
			expect(response).toMatchObject({ success: false, code: "login_ui_unsupported" });
			expect(frames.some(frame => frame.method === "input" && frame.secret)).toBe(false);
			if (capability === "trust") expect(frames.some(frame => frame.method === "confirm")).toBe(false);
		}
		expect(auth.credentials.list(loginFixtureId)).toEqual([]);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("decline, cancellation and text yes are not certificate trust consent", async () => {
		registerPrivateLogin();
		for (const answer of [{ confirmed: false }, { cancelled: true }, { value: "yes" }] satisfies Array<
			Partial<RpcExtensionUIResponse>
		>) {
			const frames: RpcExtensionUIRequest[] = [];
			const { commands: login } = privateLoginCommands([{ value: "https://private.example" }, answer], frames);
			expect(
				await login.handle({
					type: "login",
					id: "declined",
					providerId: loginFixtureId,
					allowSecretInput: true,
					allowTrustConfirmation: true,
				}),
			).toMatchObject({ success: false, code: "login_cancelled" });
			expect(frames.some(frame => frame.method === "input" && frame.secret)).toBe(false);
			expect(auth.credentials.list(loginFixtureId)).toEqual([]);
		}
	});

	test("provider errors and notifications redact values entered into secret login prompts", async () => {
		registerPrivateLogin(async callbacks => {
			const key = await callbacks.onPrompt({ message: "Member key", secret: true });
			callbacks.onProgress?.(`Rejected ${key}`);
			throw new Error(`Invalid key: ${key}`);
		});
		const frames: RpcExtensionUIRequest[] = [];
		const { commands: login } = privateLoginCommands([{ value: memberKey }], frames);
		const response = await login.handle({
			type: "login",
			id: "bad-key",
			providerId: loginFixtureId,
			allowSecretInput: true,
		});
		expect(response).toMatchObject({ success: false, error: "Invalid key: [redacted]" });
		expect(JSON.stringify([response, frames])).not.toContain(memberKey);
		expect(auth.credentials.list(loginFixtureId)).toEqual([]);
	});

	test("cancelling an outstanding trust dialog closes it and never requests a key", async () => {
		registerPrivateLogin();
		const frames: RpcExtensionUIRequest[] = [];
		const {
			commands: login,
			pending,
			confirmation,
		} = privateLoginCommands([{ value: "https://private.example" }], frames);
		const response = login.handle({
			type: "login",
			id: "cancel-trust",
			providerId: loginFixtureId,
			allowSecretInput: true,
			allowTrustConfirmation: true,
		});
		await confirmation;
		expect(await login.handle({ type: "cancel_login", loginId: "cancel-trust" })).toMatchObject({ success: true });
		expect(await response).toMatchObject({ success: false, code: "login_cancelled" });
		expect(frames.at(-1)).toMatchObject({ method: "cancel", loginId: "cancel-trust" });
		expect(pending.size).toBe(0);
		expect(auth.credentials.list(loginFixtureId)).toEqual([]);
	});

	test("login metadata follows declarative and custom device flows and keeps credential aliases", async () => {
		auth.keys.setRuntime("openai-codex", "secret-runtime-key");
		const response = await commands.handle({ type: "get_login_providers" });
		if (!response.success || response.command !== "get_login_providers") throw new Error("Missing login providers");
		expect(response.data.providers.find(provider => provider.id === "charm-hyper")).toMatchObject({
			loginKind: "api-key",
			deviceCode: false,
		});
		expect(response.data.providers.find(provider => provider.id === "anthropic")).toMatchObject({
			loginKind: "oauth-code",
			deviceCode: false,
			acceptsKeys: true,
		});
		expect(response.data.providers.find(provider => provider.id === "kimi-code")).toMatchObject({
			loginKind: "device-code",
			deviceCode: true,
		});
		expect(response.data.providers.find(provider => provider.id === "github-copilot")).toMatchObject({
			loginKind: "custom",
			deviceCode: true,
		});
		expect(response.data.providers.find(provider => provider.id === "openai-codex-device")).toMatchObject({
			loginKind: "custom",
			deviceCode: true,
			storeCredentialsAs: "openai-codex",
			authenticated: true,
			acceptsKeys: true,
		});
		expect(response.data.providers.find(provider => provider.id === "exa")).toMatchObject({ acceptsKeys: false });
		const configuration = await new RpcModelsConfiguration(session).read();
		const codex = configuration.providers.find(provider => provider.id === "openai-codex");
		expect(codex?.loginProviders.find(provider => provider.id === "openai-codex-device")).toMatchObject({
			loginKind: "custom",
			deviceCode: true,
			storeCredentialsAs: "openai-codex",
		});
		for (const provider of configuration.providers)
			expect(provider.acceptsKeys).toBe(registry.hasProvider(provider.id));
		expect(JSON.stringify([response, configuration])).not.toContain("secret-runtime-key");
	});

	test("login forwards the structured user verification code without credential material", async () => {
		const frames: object[] = [];
		vi.spyOn(auth.oauth, "login").mockImplementation(async (_provider, ctrl) => {
			ctrl.onAuth({
				url: "https://example.com/verify",
				instructions: "Complete verification",
				userCode: "REAL-CODE",
			});
			return { type: "oauth", accountId: "signed-in-account" };
		});
		vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
		const login = new RpcModelsCommands({
			session,
			output: frame => frames.push(frame),
			pending: new Map(),
			input: async () => undefined,
		});
		expect(
			await login.handle({ type: "login", providerId: "openai-codex-device", id: "device-login" }),
		).toMatchObject({ success: true, data: { providerId: "openai-codex-device" } });
		expect(frames).toEqual([
			{
				type: "extension_ui_request",
				id: expect.any(String),
				method: "open_url",
				url: "https://example.com/verify",
				instructions: "Complete verification",
				userCode: "REAL-CODE",
				loginId: "device-login",
			},
		]);
	});

	test("activation pins a noncurrent provider only for this session and journals its identity hash once", async () => {
		const first = await saveAccount("openai-codex", "first");
		const second = await saveAccount("openai-codex", "second");
		expect(auth.sessions.pin("openai-codex", "other-session", first)).toBe(true);
		const before = session.model;
		const response = await commands.handle({
			id: "activate",
			type: "activate_account",
			providerId: "openai-codex",
			credentialId: second,
		});
		expect(response).toEqual({ id: "activate", type: "response", command: "activate_account", success: true });
		expect(auth.oauth.accounts("openai-codex", session.sessionId).find(account => account.active)?.credentialId).toBe(
			second,
		);
		expect(auth.oauth.accounts("openai-codex", "other-session").find(account => account.active)?.credentialId).toBe(
			first,
		);
		expect(session.model).toBe(before);
		expect(manager.getCredentialPins().get("openai-codex")?.hash).toBe(
			credentialPinHash("openai-codex", { accountId: "second", email: "second@example.com" }),
		);
		await commands.handle({ type: "activate_account", providerId: "openai-codex", credentialId: second });
		expect(manager.getBranch().filter(entry => entry.type === "credential_pin")).toHaveLength(1);
		const serialized = JSON.stringify([
			response,
			manager.getBranch(),
			await commands.handle({ type: "get_logout_accounts", providerId: "openai-codex" }),
		]);
		expect(serialized).not.toContain("secret-access-");
		expect(serialized).not.toContain("secret-refresh-");
	});

	test("unknown providers, foreign accounts, API keys and malformed activation never change the pin", async () => {
		const account = await saveAccount("openai-codex", "active");
		const foreign = await saveAccount("anthropic", "foreign");
		const keyEntries = await auth.credentials.upsert("openai-codex", { type: "api_key", key: "secret-stored-key" });
		const key = keyEntries.find(entry => entry.provider === "openai-codex" && entry.credential.type === "api_key");
		if (!key) throw new Error("Missing stored test key");
		await commands.handle({ type: "activate_account", providerId: "openai-codex", credentialId: account });
		const pin = manager.getCredentialPins().get("openai-codex");
		const invalid = [
			{ providerId: "unknown-provider", credentialId: account },
			{ providerId: "openai-codex", credentialId: foreign },
			{ providerId: "openai-codex", credentialId: key.id },
			{ providerId: "openai-codex", credentialId: Number.MAX_SAFE_INTEGER },
			{ providerId: "openai-codex", credentialId: "secret-malformed-id" },
			{ providerId: "openai-codex", credentialId: 0 },
			{ providerId: null, credentialId: account },
		];
		for (const params of invalid) {
			const command = { type: "activate_account", ...params } as Extract<RpcCommand, { type: "activate_account" }>;
			const response = await commands.handle(command);
			expect(response).toMatchObject({ success: false, code: "invalid_value" });
			expect(JSON.stringify(response)).not.toContain("secret-");
			expect(
				auth.oauth.accounts("openai-codex", session.sessionId).find(account => account.active)?.credentialId,
			).toBe(account);
			expect(manager.getCredentialPins().get("openai-codex")).toEqual(pin);
		}
	});

	test("busy activation and runtime auth overrides do not create a journal pin", async () => {
		const account = await saveAccount("openai-codex", "candidate");
		session.agent.state.isStreaming = true;
		try {
			expect(
				await commands.handle({ type: "activate_account", providerId: "openai-codex", credentialId: account }),
			).toMatchObject({ success: false, code: "session_busy" });
		} finally {
			session.agent.state.isStreaming = false;
		}
		auth.keys.setRuntime("openai-codex", "secret-override");
		expect(
			await commands.handle({ type: "activate_account", providerId: "openai-codex", credentialId: account }),
		).toMatchObject({ success: false, code: "invalid_value" });
		expect(manager.getCredentialPins().size).toBe(0);
	});
});
