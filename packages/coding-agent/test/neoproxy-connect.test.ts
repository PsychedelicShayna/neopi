import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import * as path from "node:path";
import { streamSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { pinnedCredential } from "@oh-my-pi/pi-ai/switch/credential";
import {
	getOAuthProvider,
	type OAuthLoginCallbacks,
	type OAuthPrompt,
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "@oh-my-pi/pi-ai/oauth";
import { discoverProxyModels } from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import type { ModelsConfig } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { registerNeoProxyLogin } from "@oh-my-pi/pi-coding-agent/neopi/neoproxy-connect";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir, type ProviderTlsTrust } from "@oh-my-pi/pi-utils";

const assignedKey = "test-admin-assigned-inference-key";

/** Match normal profile initialization: open the real store, then load its credential snapshot. */
async function openLoadedAuthStorage(dbPath: string): Promise<AuthStorage> {
	const storage = await AuthStorage.create(dbPath);
	await storage.credentials.reload();
	return storage;
}
const initialConfig = {
	providers: {
		neoproxy: {
			baseUrl: "http://localhost:41111/v1",
			auth: "apiKey",
			apiKey: "LEGACY_NEOPROXY_KEY",
			discovery: { type: "proxy" },
			headers: { "X-Team": "office" },
		},
		unrelated: { baseUrl: "https://unrelated.example/v1", auth: "none", discovery: { type: "proxy" } },
	},
} satisfies ModelsConfig;

const catalogue = () => Response.json({ data: [{ id: "neoproxy/office-cheap" }] });
const offlineFetch: FetchImpl = async () => {
	throw new Error("Unexpected discovery request");
};

describe("NeoProxy assigned-key connection", () => {
	let tempDir: TempDir;
	let configPath: string;
	let originalConfig: string;
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let previousProvider: OAuthProviderInterface | undefined;
	let prompts: OAuthPrompt[];
	let progress: string[];

	beforeEach(async () => {
		previousProvider = getOAuthProvider("neoproxy");
		tempDir = await TempDir.create("@neoproxy-connect-");
		configPath = path.join(tempDir.path(), "models.yml");
		originalConfig = JSON.stringify(initialConfig);
		await Bun.write(configPath, originalConfig);
		storage = await openLoadedAuthStorage(":memory:");
		await storage.credentials.set("neoproxy", { type: "api_key", key: "old-working-key", source: "login" });
		registry = new ModelRegistry(storage, configPath, { fetch: offlineFetch });
		prompts = [];
		progress = [];
	});

	afterEach(async () => {
		if (previousProvider) registerOAuthProvider(previousProvider);
		else unregisterOAuthProvider("neoproxy");
		storage.close();
		await tempDir.remove();
	});

	function callbacks(answers: string[], fetch: FetchImpl, signal?: AbortSignal): OAuthLoginCallbacks {
		return {
			onAuth() {
				throw new Error("Assigned-key login must not open a provider authorization flow");
			},
			onPrompt: async prompt => {
				prompts.push(prompt);
				const answer = answers.shift();
				if (answer === undefined) throw new Error("Unexpected extra login prompt");
				return answer;
			},
			onProgress: message => progress.push(message),
			fetch,
			signal,
		};
	}

	async function expectUnchanged(): Promise<void> {
		expect(await Bun.file(configPath).text()).toBe(originalConfig);
		expect(storage.credentials.list("neoproxy").map(row => row.credential)).toEqual([
			expect.objectContaining({ type: "api_key", key: "old-working-key" }),
		]);
	}

	test("validates only the supplied key and saves nonsecret settings through the existing login store", async () => {
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const controller = new AbortController();
		registerNeoProxyLogin(registry, "http://localhost:41112/team/neo/");
		const identity = await storage.oauth.login(
			"neoproxy",
			callbacks(
				[assignedKey],
				async (input, init) => {
					requests.push({ url: String(input), init });
					return catalogue();
				},
				controller.signal,
			),
		);

		expect(identity).toEqual({ type: "api_key" });
		expect(prompts).toHaveLength(1);
		expect(prompts[0].secret).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("http://localhost:41112/team/neo/v1/models");
		expect(requests[0].init).toEqual({
			method: "GET",
			headers: { Authorization: `Bearer ${assignedKey}` },
			signal: controller.signal,
			redirect: "error",
			credentials: "omit",
		});
		const saved = ModelsConfigFile.relocate(configPath).load();
		expect(saved?.providers?.neoproxy).toEqual({
			baseUrl: "http://localhost:41112/team/neo/v1",
			auth: "apiKey",
			discovery: { type: "proxy" },
			headers: { "X-Team": "office" },
		});
		expect(saved?.providers?.unrelated).toEqual(initialConfig.providers.unrelated);
		expect(await Bun.file(configPath).text()).not.toContain(assignedKey);
		expect(progress.join("\n")).not.toContain(assignedKey);
		expect(storage.credentials.list("neoproxy").map(row => row.credential)).toContainEqual(
			expect.objectContaining({ type: "api_key", key: assignedKey, source: "login" }),
		);
	});

	test("in-session prompts reuse the configured URL and accept an empty granted catalogue", async () => {
		const urls: string[] = [];
		await storage.oauth.login(
			"neoproxy",
			callbacks(["", assignedKey], async input => {
				urls.push(String(input));
				return Response.json({ data: [] });
			}),
		);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toMatchObject({ placeholder: "http://localhost:41111/v1", allowEmpty: true });
		expect(prompts[0].secret).not.toBe(true);
		expect(prompts[1].secret).toBe(true);
		expect(urls).toEqual(["http://localhost:41111/v1/models"]);
		expect(storage.credentials.list("neoproxy").map(row => row.credential)).toContainEqual(
			expect.objectContaining({ type: "api_key", key: assignedKey, source: "login" }),
		);
	});

	for (const [name, response] of [
		["unauthorized key", () => new Response("do not display response bodies", { status: 401 })],
		["redirect", () => Response.redirect("https://elsewhere.example/v1/models")],
		["invalid JSON", () => new Response("not JSON")],
		["missing catalogue", () => Response.json({})],
		["malformed model", () => Response.json({ data: [{ id: 42 }] })],
	] as const) {
		test(`${name} preserves the old connection and credential`, async () => {
			registerNeoProxyLogin(registry, "http://localhost:41112");
			await expect(
				storage.oauth.login(
					"neoproxy",
					callbacks([assignedKey], async () => response()),
				),
			).rejects.toThrow();
			await expectUnchanged();
		});
	}

	test("cancellation during catalogue validation preserves the old connection and credential", async () => {
		const controller = new AbortController();
		registerNeoProxyLogin(registry, "http://localhost:41112");
		await expect(
			storage.oauth.login(
				"neoproxy",
				callbacks(
					[assignedKey],
					async () => {
						controller.abort();
						return catalogue();
					},
					controller.signal,
				),
			),
		).rejects.toThrow();
		await expectUnchanged();
	});

	test("cancelling the key prompt does not send a request or alter the old connection", async () => {
		registerNeoProxyLogin(registry, "http://localhost:41112");
		const loginCallbacks = callbacks([], offlineFetch);
		loginCallbacks.onPrompt = async () => {
			throw new Error("Login cancelled");
		};
		await expect(storage.oauth.login("neoproxy", loginCallbacks)).rejects.toThrow("Login cancelled");
		await expectUnchanged();
	});

	for (const url of [
		"http://office.example:18766",
		"http://192.168.1.10:18766",
		"https://user:secret@proxy.example",
		"https://proxy.example?key=not-allowed",
		"https://proxy.example#not-allowed",
		"file:///etc/passwd",
	]) {
		test(`rejects unsafe URL ${url} before asking for the key`, async () => {
			registerNeoProxyLogin(registry, url);
			await expect(storage.oauth.login("neoproxy", callbacks([], offlineFetch))).rejects.toThrow();
			expect(prompts).toEqual([]);
			await expectUnchanged();
		});
	}

	for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
		test(`permits loopback HTTP on ${host} without dashboard traffic`, async () => {
			registerNeoProxyLogin(registry, `http://${host}:18766`);
			const urls: string[] = [];
			await storage.oauth.login(
				"neoproxy",
				callbacks([assignedKey], async input => {
					urls.push(String(input));
					return catalogue();
				}),
			);
			expect(urls).toEqual([`http://${host}:18766/v1/models`]);
		});
	}
});

describe("NeoProxy credential-local private CA", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let server: Bun.Server<undefined>;
	let previousProvider: OAuthProviderInterface | undefined;
	let origin: string;
	let configPath: string;
	let authPath: string;
	let caPem: string;
	let leafPem: string;
	let serverKey: string;
	let status: number;
	let acceptedKey: string;
	let invalidCatalogue: boolean;
	let redirectTo: string | undefined;
	let onCatalogue: (() => Promise<void>) | undefined;
	let requests: Array<{ path: string; authorization: string | null }>;
	let events: string[];
	let confirmations: Array<{ title: string; message: string }>;
	let keyPrompts: number;
	let localFetch: FetchImpl;

	beforeEach(async () => {
		previousProvider = getOAuthProvider("neoproxy");
		tempDir = await TempDir.create("@neoproxy-private-ca-");
		authPath = tempDir.join("auth.db");
		configPath = tempDir.join("models.yml");
		await Bun.write(configPath, JSON.stringify({ providers: {} }));
		storage = await openLoadedAuthStorage(authPath);
		caPem = await Bun.file(new URL("./fixtures/neoproxy-tls/ca.pem", import.meta.url)).text();
		leafPem = await Bun.file(new URL("./fixtures/neoproxy-tls/server.pem", import.meta.url)).text();
		serverKey = await Bun.file(new URL("./fixtures/neoproxy-tls/server-key.pem", import.meta.url)).text();
		status = 200;
		acceptedKey = assignedKey;
		invalidCatalogue = false;
		redirectTo = undefined;
		onCatalogue = undefined;
		requests = [];
		events = [];
		confirmations = [];
		keyPrompts = 0;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: leafPem + caPem, key: serverKey },
			async fetch(request) {
				const url = new URL(request.url);
				requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
				events.push("http");
				if (redirectTo) return Response.redirect(redirectTo);
				if (status !== 200) return new Response("Do not disclose upstream error bodies", { status });
				if (request.headers.get("authorization") !== `Bearer ${acceptedKey}`)
					return new Response("Invalid assigned key", { status: 401 });
				if (url.pathname.endsWith("/v1/models")) {
					await onCatalogue?.();
					return Response.json(
						invalidCatalogue
							? { data: [{ id: 42 }] }
							: { data: [{ id: "office-model", supported_endpoint_types: ["openai"] }] },
					);
				}
				if (url.pathname.endsWith("/v1/chat/completions")) {
					const body = (await request.json()) as { model?: string };
					if (body.model !== "office-model") return new Response("Unknown model", { status: 400 });
					const chunks = [
						{
							id: "chatcmpl-owned",
							object: "chat.completion.chunk",
							created: 0,
							model: "office-model",
							choices: [
								{
									index: 0,
									delta: { role: "assistant", content: "Trusted local inference" },
									finish_reason: null,
								},
							],
						},
						{
							id: "chatcmpl-owned",
							object: "chat.completion.chunk",
							created: 0,
							model: "office-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
						},
					];
					return new Response(
						`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response("Not found", { status: 404 });
			},
		});
		origin = `https://127.0.0.1:${server.port}`;
		localFetch = (input, init) => {
			if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin)
				throw new Error("Non-fixture network request blocked");
			return fetch(input, init);
		};
		registry = new ModelRegistry(storage, configPath, { fetch: localFetch });
	});

	afterEach(async () => {
		server.stop(true);
		storage.close();
		if (previousProvider) registerOAuthProvider(previousProvider);
		else unregisterOAuthProvider("neoproxy");
		await tempDir.remove();
	});

	function loginCallbacks(signal?: AbortSignal): OAuthLoginCallbacks {
		return {
			signal,
			fetch: localFetch,
			onAuth() {
				throw new Error("No upstream-provider authorization is permitted");
			},
			onPrompt: async prompt => {
				if (prompt.secret) {
					keyPrompts++;
					events.push("key");
					expect(confirmations).toHaveLength(1);
					expect(requests).toEqual([]);
					return assignedKey;
				}
				events.push("url");
				return `${origin}/gateway/neo/v1/`;
			},
			onConfirm: async prompt => {
				confirmations.push(prompt);
				events.push("confirm");
				expect(keyPrompts).toBe(0);
				expect(requests).toEqual([]);
				return true;
			},
		};
	}

	function storedTrust(): ProviderTlsTrust {
		const credential = storage.credentials.get("neoproxy");
		if (credential?.type !== "api_key" || !credential.tlsTrust) throw new Error("Expected persisted API-key trust");
		return credential.tlsTrust;
	}

	async function expectNoNewConnection(): Promise<void> {
		expect(storage.credentials.list("neoproxy")).toEqual([]);
		expect(ModelsConfigFile.relocate(configPath).load()).toEqual({ providers: {} });
	}

	test("native confirmation precedes key disclosure and reopened credentials discover and infer over verified TLS", async () => {
		await storage.oauth.login("neoproxy", loginCallbacks());
		expect(events).toEqual(["url", "confirm", "key", "http"]);
		const confirmation = confirmations[0];
		expect(confirmation.title).toContain(origin);
		expect(confirmation.message).toContain("Hostname: 127.0.0.1");
		expect(confirmation.message).toContain(new X509Certificate(leafPem).fingerprint256);
		expect(confirmation.message).toContain(new X509Certificate(caPem).fingerprint256);
		expect(confirmation.message).toContain("administrator");
		expect(confirmation.message).toContain("only beside this provider's credential");
		expect(confirmation.message).not.toContain("BEGIN CERTIFICATE");
		expect(confirmation.message).not.toContain(assignedKey);
		expect(storedTrust()).toEqual({ origin, caPem, caFingerprint256: new X509Certificate(caPem).fingerprint256 });
		const savedConfig = await Bun.file(configPath).text();
		expect(savedConfig).not.toContain("BEGIN CERTIFICATE");
		expect(savedConfig).not.toContain(assignedKey);
		expect(ModelsConfigFile.relocate(configPath).load()?.providers?.neoproxy?.baseUrl).toBe(
			`${origin}/gateway/neo/v1`,
		);

		storage.close();
		storage = await openLoadedAuthStorage(authPath);
		registry = new ModelRegistry(storage, configPath, { fetch: localFetch });
		await registry.refreshProvider("neoproxy", "online");
		const model = registry.find("neoproxy", "office-model");
		if (!model) throw new Error("Reopened provider did not discover its granted model");
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Reply locally.", timestamp: 0 }] },
			{
				apiKey: registry.resolver(model),
				fetch: localFetch,
				maxTokens: 16,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Trusted local inference" }));
		expect(requests.filter(request => request.path.endsWith("/v1/models")).length).toBeGreaterThanOrEqual(2);
		expect(requests).toContainEqual({
			path: "/gateway/neo/v1/chat/completions",
			authorization: `Bearer ${assignedKey}`,
		});
		expect(requests.every(request => request.authorization === `Bearer ${assignedKey}`)).toBe(true);
		expect(await storage.keys.getWithCredential("unrelated")).toBeUndefined();
	});

	test("refusal and cancelled native confirmation never ask for or send the key", async () => {
		const refused = loginCallbacks();
		refused.onConfirm = async prompt => {
			confirmations.push(prompt);
			return false;
		};
		await expect(storage.oauth.login("neoproxy", refused)).rejects.toThrow("declined");
		expect(keyPrompts).toBe(0);
		expect(requests).toEqual([]);
		await expectNoNewConnection();

		const controller = new AbortController();
		const cancelled = loginCallbacks(controller.signal);
		cancelled.onConfirm = async prompt => {
			confirmations.push(prompt);
			controller.abort();
			return true;
		};
		await expect(storage.oauth.login("neoproxy", cancelled)).rejects.toThrow();
		expect(keyPrompts).toBe(0);
		expect(requests).toEqual([]);
		await expectNoNewConnection();
	});

	test("CLI fallback requires literal affirmative consent before its secret prompt", async () => {
		const callbacks = loginCallbacks();
		delete callbacks.onConfirm;
		callbacks.onPrompt = async prompt => {
			if (prompt.secret) {
				keyPrompts++;
				return assignedKey;
			}
			return prompt.message.includes("Type yes") ? "" : origin;
		};
		await expect(storage.oauth.login("neoproxy", callbacks)).rejects.toThrow("declined");
		expect(keyPrompts).toBe(0);
		expect(requests).toEqual([]);
		await expectNoNewConnection();
	});

	for (const failure of ["invalid key", "invalid catalogue", "cancelled key prompt"] as const) {
		test(`${failure} cannot persist newly confirmed trust`, async () => {
			const controller = new AbortController();
			const callbacks = loginCallbacks(controller.signal);
			if (failure === "invalid key") status = 401;
			if (failure === "invalid catalogue") invalidCatalogue = true;
			if (failure === "cancelled key prompt") {
				const prompt = callbacks.onPrompt;
				callbacks.onPrompt = async input => {
					const value = await prompt(input);
					if (input.secret) controller.abort();
					return value;
				};
			}
			await expect(storage.oauth.login("neoproxy", callbacks)).rejects.toThrow();
			await expectNoNewConnection();
			if (failure === "cancelled key prompt") expect(requests).toEqual([]);
		});
	}

	test("a private server missing its CA chain fails honestly before confirmation or key entry", async () => {
		const incomplete = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: leafPem, key: serverKey },
			fetch: () => {
				throw new Error("Inspection must never send HTTP");
			},
		});
		try {
			registerNeoProxyLogin(registry, `https://127.0.0.1:${incomplete.port}`);
			await expect(storage.oauth.login("neoproxy", loginCallbacks())).rejects.toThrow("complete certificate chain");
			expect(confirmations).toEqual([]);
			expect(keyPrompts).toBe(0);
			await expectNoNewConnection();
		} finally {
			incomplete.stop(true);
		}
	});

	test("discovery and inference reject a different exact origin before sending a credential", async () => {
		await storage.oauth.login("neoproxy", loginCallbacks());
		const before = requests.length;
		const wrongOrigin = `${origin.replace("127.0.0.1", "localhost")}/gateway/neo/v1`;
		await expect(
			discoverProxyModels(
				{
					provider: "neoproxy",
					baseUrl: wrongOrigin,
					api: "openai-completions",
					discovery: { type: "proxy" },
				},
				{ fetch: localFetch, getBearerApiKeyResolver: async () => storage.keys.resolver("neoproxy") },
			),
		).rejects.toThrow("origin");
		await registry.refreshProvider("neoproxy", "online");
		const model = registry.find("neoproxy", "office-model");
		if (!model) throw new Error("Expected fixture model");
		const beforeInference = requests.length;
		const changed = { ...model, baseUrl: wrongOrigin };
		const result = await streamSimple(
			changed,
			{ messages: [{ role: "user", content: "No disclosure.", timestamp: 0 }] },
			{
				apiKey: registry.resolver(changed),
				fetch: localFetch,
				maxTokens: 8,
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("origin");
		expect(requests.length).toBe(beforeInference);
		expect(beforeInference).toBeGreaterThanOrEqual(before);
	});

	test("a mismatched CA fingerprint and an unrelated valid CA both fail closed", async () => {
		await storage.oauth.login("neoproxy", loginCallbacks());
		const trust = storedTrust();
		const otherCaPem = await Bun.file(new URL("./fixtures/neoproxy-tls/unrelated-ca.pem", import.meta.url)).text();
		for (const tlsTrust of [
			{ ...trust, caFingerprint256: "00:00" },
			{ origin, caPem: otherCaPem, caFingerprint256: new X509Certificate(otherCaPem).fingerprint256 },
		]) {
			await storage.credentials.set("neoproxy", { type: "api_key", key: assignedKey, source: "login", tlsTrust });
			const before = requests.length;
			await expect(
				discoverProxyModels(
					{
						provider: "neoproxy",
						baseUrl: `${origin}/v1`,
						api: "openai-completions",
						discovery: { type: "proxy" },
					},
					{ fetch: localFetch, getBearerApiKeyResolver: async () => storage.keys.resolver("neoproxy") },
				),
			).rejects.toThrow();
			expect(requests.length).toBe(before);
		}
	});

	test("a same-key origin restriction change invalidates the active credential snapshot before disclosure", async () => {
		await storage.oauth.login("neoproxy", loginCallbacks());
		const credential = storage.credentials.get("neoproxy");
		if (credential?.type !== "api_key") throw new Error("Expected the stored member key");
		const generation = storage.credentials.generation;
		const before = requests.length;
		await storage.credentials.set("neoproxy", {
			...credential,
			requestOrigin: origin.replace("127.0.0.1", "localhost"),
		});
		expect(storage.credentials.generation).toBeGreaterThan(generation);
		await expect(
			discoverProxyModels(
				{
					provider: "neoproxy",
					baseUrl: `${origin}/v1`,
					api: "openai-completions",
					discovery: { type: "proxy" },
				},
				{
					fetch: localFetch,
					getBearerApiKeyResolver: async () => storage.keys.resolver("neoproxy"),
				},
			),
		).rejects.toThrow("origin");
		expect(requests.length).toBe(before);
	});

	test("redirects never disclose the key to a second origin or save trust", async () => {
		const leaked: string[] = [];
		const destination = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				leaked.push(request.headers.get("authorization") ?? "");
				return Response.json({ data: [] });
			},
		});
		try {
			redirectTo = `http://127.0.0.1:${destination.port}/v1/models`;
			await expect(storage.oauth.login("neoproxy", loginCallbacks())).rejects.toThrow();
			expect(leaked).toEqual([]);
			await expectNoNewConnection();
		} finally {
			destination.stop(true);
		}
	});

	for (const fixture of ["wrong-host", "expired"] as const) {
		test(`${fixture} certificate is rejected before consent or secret entry`, async () => {
			const badLeaf = await Bun.file(new URL(`./fixtures/neoproxy-tls/${fixture}.pem`, import.meta.url)).text();
			const invalid = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				tls: { cert: badLeaf + caPem, key: serverKey },
				fetch: () => {
					throw new Error("Invalid TLS must never carry HTTP");
				},
			});
			try {
				registerNeoProxyLogin(registry, `https://127.0.0.1:${invalid.port}`);
				await expect(storage.oauth.login("neoproxy", loginCallbacks())).rejects.toThrow();
				expect(confirmations).toEqual([]);
				expect(keyPrompts).toBe(0);
				await expectNoNewConnection();
			} finally {
				invalid.stop(true);
			}
		});
	}

	test("a successful explicit reconnect replaces the prior endpoint key and trust", async () => {
		await storage.credentials.set("neoproxy", {
			type: "api_key",
			key: "prior-endpoint-key",
			source: "login",
			tlsTrust: {
				origin: "https://previous.invalid",
				caPem,
				caFingerprint256: new X509Certificate(caPem).fingerprint256,
			},
		});
		const priorId = storage.credentials.list("neoproxy")[0].id;
		await storage.oauth.login("neoproxy", loginCallbacks());
		expect(storage.credentials.list("neoproxy").map(row => row.credential)).toEqual([
			expect.objectContaining({ type: "api_key", key: assignedKey, tlsTrust: expect.objectContaining({ origin }) }),
		]);
		expect((await storage.keys.getWithCredential("neoproxy"))?.apiKey).toBe(assignedKey);
		const connectedId = storage.credentials.list("neoproxy")[0].id;
		expect(await storage.credentials.listDisabled("neoproxy")).toContainEqual(
			expect.objectContaining({ id: priorId, cause: "replaced by explicit connection" }),
		);

		// Same-key reconnect keeps the active row, and does not purge the prior key tombstone.
		requests = [];
		events = [];
		confirmations = [];
		keyPrompts = 0;
		await storage.oauth.login("neoproxy", loginCallbacks());
		expect(storage.credentials.list("neoproxy")[0].id).toBe(connectedId);
		expect(await storage.credentials.listDisabled("neoproxy")).toContainEqual(
			expect.objectContaining({ id: priorId }),
		);

		// Re-entering the old key after fresh certificate/key validation reactivates its original row.
		requests = [];
		events = [];
		confirmations = [];
		keyPrompts = 0;
		acceptedKey = "prior-endpoint-key";
		const reconnect = loginCallbacks();
		const prompt = reconnect.onPrompt;
		reconnect.onPrompt = async input => {
			const value = await prompt(input);
			return input.secret ? acceptedKey : value;
		};
		await storage.oauth.login("neoproxy", reconnect);
		expect(storage.credentials.list("neoproxy")[0]).toMatchObject({
			id: priorId,
			credential: { type: "api_key", key: acceptedKey, tlsTrust: { origin } },
		});
		expect(await storage.credentials.listDisabled("neoproxy")).toContainEqual(
			expect.objectContaining({ id: connectedId }),
		);
	});

	test("persisted private-CA discovery and inference also refuse cross-origin redirects", async () => {
		await storage.oauth.login("neoproxy", loginCallbacks());
		await registry.refreshProvider("neoproxy", "online");
		const model = registry.find("neoproxy", "office-model");
		if (!model) throw new Error("Expected granted model");
		const disclosed: string[] = [];
		const destination = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				disclosed.push(request.headers.get("authorization") ?? "");
				return Response.json({ data: [] });
			},
		});
		try {
			redirectTo = `http://127.0.0.1:${destination.port}/v1/models`;
			await expect(
				discoverProxyModels(
					{
						provider: "neoproxy",
						baseUrl: `${origin}/v1`,
						api: "openai-completions",
						discovery: { type: "proxy" },
					},
					{ fetch: localFetch, getBearerApiKeyResolver: async () => storage.keys.resolver("neoproxy") },
				),
			).rejects.toThrow();
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "Do not redirect.", timestamp: 0 }] },
				{
					apiKey: registry.resolver(model),
					fetch: localFetch,
					maxTokens: 8,
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(disclosed).toEqual([]);
		} finally {
			destination.stop(true);
		}
	});

	test("a normal pinned generation retains the credential's private CA for actual inference", async () => {
		await storage.oauth.login("neoproxy", loginCallbacks());
		await registry.refreshProvider("neoproxy", "online");
		const model = registry.find("neoproxy", "office-model");
		if (!model) throw new Error("Expected fixture model");
		const row = storage.credentials.list("neoproxy")[0];
		const fingerprint = await storage.keys.fingerprintPinned(row.id, "neoproxy");
		if (!fingerprint) throw new Error("Expected stored credential fingerprint");
		const controller = new AbortController();
		const selected = await pinnedCredential(
			storage,
			{
				provider: "neoproxy",
				credentialId: row.id,
				fingerprint,
			},
			model.id,
			"private-ca-generation",
			controller.signal,
		);
		if (!selected) throw new Error("Expected usable pinned credential");
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Use this generation.", timestamp: 0 }] },
			{
				apiKey: selected.resolver,
				fetch: localFetch,
				maxTokens: 8,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Trusted local inference" }));

		// A trust change is a different credential generation, even if the key bytes did not change.
		const generation = storage.credentials.generation;
		await storage.credentials.set("neoproxy", {
			type: "api_key",
			key: assignedKey,
			source: "login",
			tlsTrust: { ...storedTrust(), origin: "https://elsewhere.invalid" },
		});
		expect(storage.credentials.generation).toBeGreaterThan(generation);
		expect(
			await pinnedCredential(
				storage,
				{ provider: "neoproxy", credentialId: row.id, fingerprint },
				model.id,
				"private-ca-generation",
				controller.signal,
			),
		).toBeUndefined();
	});

	test("broker-backed credentials retain local CA trust and recoverable replacement through the real upload/snapshot path", async () => {
		await storage.credentials.set("neoproxy", { type: "api_key", key: "prior-member-key", source: "login" });
		const priorId = storage.credentials.list("neoproxy")[0].id;
		const unrelated = {
			type: "oauth" as const,
			access: "isolated-access",
			refresh: "isolated-refresh",
			expires: Date.now() + 60_000,
		};
		await storage.credentials.set("unrelated", unrelated);
		const handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: ["owned-fixture-broker"],
			disableRefresher: true,
		});
		const remoteStorage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: handle.url, token: "owned-fixture-broker" }),
				streamSnapshots: false,
			}),
		);
		try {
			await remoteStorage.credentials.reload();
			await remoteStorage.oauth.login("neoproxy", loginCallbacks());
			const rows = remoteStorage.credentials.list("neoproxy");
			expect(rows).toHaveLength(1);
			expect(rows[0].credential).toMatchObject({
				type: "api_key",
				key: assignedKey,
				tlsTrust: { origin, caFingerprint256: new X509Certificate(caPem).fingerprint256 },
			});
			expect(await remoteStorage.credentials.listDisabled("neoproxy")).toContainEqual(
				expect.objectContaining({ id: priorId, cause: "replaced by explicit connection" }),
			);
			expect(storage.credentials.get("unrelated")).toEqual(unrelated);

			const remoteRegistry = new ModelRegistry(remoteStorage, configPath, { fetch: localFetch });
			await remoteRegistry.refreshProvider("neoproxy", "online");
			expect(remoteRegistry.find("neoproxy", "office-model")).toBeDefined();
		} finally {
			remoteStorage.close();
			await handle.close();
		}
	});

	test("already-trusted inspection still pins the CA and reopens without ambient trust", async () => {
		// Isolate NODE_EXTRA_CA_CERTS at process startup, never in the test runner's environment.
		server.stop(true);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: leafPem, key: serverKey },
			fetch(request) {
				requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
				if (request.headers.get("authorization") !== `Bearer ${assignedKey}`)
					return new Response("Unauthorized", { status: 401 });
				return Response.json({ data: [{ id: "office-model", supported_endpoint_types: ["openai"] }] });
			},
		});
		origin = `https://127.0.0.1:${server.port}`;
		const caPath = path.join(import.meta.dir, "fixtures/neoproxy-tls/ca.pem");
		const script = `
			import * as tls from "node:tls";
			import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
			import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
			const origin = Bun.env.NPI_TEST_ORIGIN;
			const url = new URL(origin);
			const verified = Promise.withResolvers();
			const socket = tls.connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: true }, () => {
				if (!socket.authorized) verified.reject(new Error("Fixture was not already trusted"));
				else verified.resolve();
				socket.destroy();
			});
			socket.once("error", verified.reject);
			await verified.promise;
			const storage = await AuthStorage.create(Bun.env.NPI_TEST_AUTH);
			await storage.credentials.reload();
			const localFetch = (input, init) => {
				if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error("Non-fixture network blocked");
				return fetch(input, init);
			};
			new ModelRegistry(storage, Bun.env.NPI_TEST_CONFIG, { fetch: localFetch });
			let confirmations = 0;
			await storage.oauth.login("neoproxy", {
				onAuth() { throw new Error("Unexpected OAuth"); },
				onPrompt: async prompt => prompt.secret ? ${JSON.stringify(assignedKey)} : origin,
				onConfirm: async () => { confirmations++; return true; },
				fetch: localFetch,
			});
			if (confirmations !== 1) throw new Error("Already-trusted inspection still requires explicit confirmation");
			storage.close();
			process.exit(0);
		`;
		storage.close();
		try {
			const child = Bun.spawn([process.execPath, "--eval", script], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					NODE_EXTRA_CA_CERTS: caPath,
					NPI_TEST_ORIGIN: origin,
					NPI_TEST_AUTH: authPath,
					NPI_TEST_CONFIG: configPath,
				},
				stdout: "ignore",
				stderr: "pipe",
			});
			const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (code !== 0) throw new Error(`Isolated already-trusted login failed: ${stderr}`);
		} finally {
			storage = await openLoadedAuthStorage(authPath);
		}
		expect(storedTrust()).toMatchObject({ origin, caFingerprint256: new X509Certificate(caPem).fingerprint256 });
		registry = new ModelRegistry(storage, configPath, { fetch: localFetch });
		await registry.refreshProvider("neoproxy", "online");
		expect(registry.find("neoproxy", "office-model")).toBeDefined();
		expect(requests.length).toBeGreaterThanOrEqual(2);
		expect(requests.every(request => request.authorization === `Bearer ${assignedKey}`)).toBe(true);
	}, 30_000);

	test("credential-store failure never activates the new endpoint or sends an old unscoped key there", async () => {
		const oldKey = "previous-unscoped-member-key";
		const oldRequests: string[] = [];
		const oldServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				oldRequests.push(request.headers.get("authorization") ?? "");
				return Response.json({ data: [{ id: "previous-model" }] });
			},
		});
		const oldOrigin = `http://127.0.0.1:${oldServer.port}`;
		const previousConfig = JSON.stringify({
			providers: { neoproxy: { baseUrl: `${oldOrigin}/v1`, auth: "apiKey", discovery: { type: "proxy" } } },
		});
		await Bun.write(configPath, previousConfig);
		await storage.credentials.set("neoproxy", { type: "api_key", key: oldKey, source: "login" });
		const ownFetch: FetchImpl = (input, init) => {
			const target = new URL(input instanceof Request ? input.url : String(input)).origin;
			if (target !== oldOrigin && target !== origin) throw new Error("Non-fixture network blocked");
			return fetch(input, init);
		};
		registry = new ModelRegistry(storage, configPath, { fetch: ownFetch });
		// Lose the real SQLite writer after successful HTTP validation but before durable commit.
		onCatalogue = async () => storage.close();
		try {
			await expect(storage.oauth.login("neoproxy", loginCallbacks())).rejects.toThrow();
			expect(await Bun.file(configPath).text()).toBe(previousConfig);
			storage = await openLoadedAuthStorage(authPath);
			expect(storage.credentials.list("neoproxy").map(row => row.credential)).toEqual([
				{ type: "api_key", key: oldKey, source: "login" },
			]);
			registry = new ModelRegistry(storage, configPath, { fetch: ownFetch });
			await registry.refreshProvider("neoproxy", "online");
			expect(oldRequests).toContain(`Bearer ${oldKey}`);
			expect(requests).toHaveLength(1);
			expect(requests[0].authorization).toBe(`Bearer ${assignedKey}`);
		} finally {
			oldServer.stop(true);
		}
	});

	test("failed endpoint activation cannot send a newly stored cleartext-loopback key to the previous origin", async () => {
		const oldRequests: string[] = [];
		const oldServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				oldRequests.push(request.headers.get("authorization") ?? "");
				return Response.json({ data: [] });
			},
		});
		const oldOrigin = `http://127.0.0.1:${oldServer.port}`;
		const previous = {
			providers: { neoproxy: { baseUrl: `${oldOrigin}/v1`, auth: "apiKey", discovery: { type: "proxy" } } },
		};
		const concurrent = {
			providers: { neoproxy: { ...previous.providers.neoproxy, baseUrl: `${oldOrigin}/moved/v1` } },
		};
		await Bun.write(configPath, JSON.stringify(previous));
		await storage.credentials.set("neoproxy", { type: "api_key", key: "previous-key", source: "login" });
		const priorId = storage.credentials.list("neoproxy")[0].id;
		const newServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.headers.get("authorization") !== `Bearer ${assignedKey}`)
					return new Response("Unauthorized", { status: 401 });
				// An actual conflicting concurrent edit makes the normal config writer refuse activation.
				await Bun.write(configPath, JSON.stringify(concurrent));
				return Response.json({ data: [] });
			},
		});
		const requestedOrigin = `http://127.0.0.1:${newServer.port}`;
		const ownFetch: FetchImpl = (input, init) => {
			const target = new URL(input instanceof Request ? input.url : String(input)).origin;
			if (target !== oldOrigin && target !== requestedOrigin) throw new Error("Non-fixture network blocked");
			return fetch(input, init);
		};
		registerNeoProxyLogin(registry, requestedOrigin);
		try {
			await expect(
				storage.oauth.login("neoproxy", {
					onAuth() {
						throw new Error("Unexpected OAuth");
					},
					onPrompt: async prompt => {
						if (!prompt.secret) throw new Error("Unexpected nonsecret prompt");
						return assignedKey;
					},
					fetch: ownFetch,
				}),
			).rejects.toThrow("credential was stored");
			expect(await Bun.file(configPath).text()).toBe(JSON.stringify(concurrent));
			expect(storage.credentials.get("neoproxy")).toEqual({
				type: "api_key",
				key: assignedKey,
				source: "login",
				requestOrigin: requestedOrigin,
			});
			expect(await storage.credentials.listDisabled("neoproxy")).toContainEqual(
				expect.objectContaining({ id: priorId }),
			);
			await expect(
				discoverProxyModels(
					{
						provider: "neoproxy",
						api: "openai-completions",
						baseUrl: concurrent.providers.neoproxy.baseUrl,
						discovery: { type: "proxy" },
					},
					{ fetch: ownFetch, getBearerApiKeyResolver: async () => storage.keys.resolver("neoproxy") },
				),
			).rejects.toThrow("origin");
			expect(oldRequests).toEqual([]);
		} finally {
			oldServer.stop(true);
			newServer.stop(true);
		}
	});
});
