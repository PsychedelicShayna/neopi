import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker";
import { buildGatewayApiKeyResolver, hashAuthGatewayToken, resolveGatewayApiKey, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayAccount, AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl, Model, Api } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { completionsChunks } from "./helpers/factory-droid";

const GATEWAY_TOKEN = "gateway-account-source-test";
const BROKER_TOKEN = "broker-account-source-test";
const HEADERS = { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "application/json" };
const PRIVATE_HEADER = "X-Neopi-Credential-Id";

interface Attempt {
	headers: Headers;
	body: Record<string, unknown>;
}

function chatModel(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://account-source.test/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function completed(): Response {
	return new Response(
		`${completionsChunks("account selected", "pool-chat")
			.map(chunk => `data: ${chunk}`)
			.join("\n\n")}\n\ndata: [DONE]\n\n`,
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function oauth(accountId: string): OAuthCredential {
	return {
		type: "oauth",
		accountId,
		email: `${accountId}@example.test`,
		access: `sk-ant-oat01-initial-${accountId}`,
		refresh: `private-refresh-${accountId}`,
		expires: Date.now() + 3_600_000,
	};
}

interface Fixture {
	broker: AuthBrokerServerHandle;
	brokerStorage: AuthStorage;
	storage: AuthStorage;
	gateway: AuthGatewayServerHandle;
	attempts: Attempt[];
	refreshes: number[];
	models: Model<Api>[];
	respond: (attempt: Attempt) => Response | Promise<Response>;
	addOAuth(): Promise<number[]>;
	close(): Promise<void>;
}

async function boot(bearerTokens = [GATEWAY_TOKEN]): Promise<Fixture> {
	const refreshes: number[] = [];
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const brokerStorage = new AuthStorage(store, {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
		refreshOAuthCredential: async (_provider, id, credential) => {
			refreshes.push(id);
			return {
				...credential,
				access: `sk-ant-oat01-renewed-${id}`,
				refresh: `private-rotated-${id}`,
				expires: Date.now() + 3_600_000,
			};
		},
	});
	await brokerStorage.credentials.set("openai", [
		{ type: "api_key", key: "private-key-first", source: "login" },
		{ type: "api_key", key: "private-key-second", source: "login" },
	]);
	brokerStorage.usage.setProvider("anthropic", {
		id: "anthropic",
		fetchUsage: async ({ credential }) => ({
			provider: "anthropic",
			fetchedAt: Date.now(),
			metadata: { accountId: credential.accountId, email: credential.email, secret: "private-metadata-token" },
			raw: { token: "private-raw-token" },
			limits: [
				{
					id: "five_hour",
					label: "5 Hour",
					scope: { provider: "anthropic", shared: true },
					amount: { unit: "percent", used: credential.accountId === "oauth-a" ? 25 : 75 },
					window: { id: "5h", label: "5 Hour", resetsAt: Date.now() + 18_000_000 },
				},
				{
					id: "monthly",
					label: "Monthly",
					scope: { provider: "anthropic", shared: true },
					amount: { unit: "unknown" },
				},
			],
		}),
	});
	const broker = startAuthBroker({
		storage: brokerStorage,
		bind: "127.0.0.1:0",
		bearerTokens: [BROKER_TOKEN],
		disableRefresher: true,
	});
	const storage = new AuthStorage(
		new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: broker.url, token: BROKER_TOKEN }),
			streamSnapshots: false,
		}),
		{ usageProviderResolver: () => undefined, rankingStrategyResolver: () => undefined },
	);
	await storage.credentials.revalidate();
	const chat = chatModel("openai", "pool-chat");
	const oauthChat = chatModel("anthropic", "oauth-chat");
	const entitled = { ...chatModel("anthropic", "entitled-chat"), accountAccess: { "oauth-a": {} } };
	const embedding: Model<Api> = { ...chat, id: "pool-embedding", api: "openai-embeddings", kind: "embedding" };
	const models: Model<Api>[] = [chat, oauthChat, entitled, embedding, chatModel("devin", "disabled-chat")];
	const attempts: Attempt[] = [];
	let fixture: Fixture;
	const transport: FetchImpl = async (_input, init) => {
		const attempt = {
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		};
		attempts.push(attempt);
		return fixture.respond(attempt);
	};
	const gateway = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens,
		clients: bearerTokens.length > 0 ? [{ name: "scoped-source", tokenSha256: hashAuthGatewayToken("scoped-source-token"), models: ["openai/*"] }] : undefined,
		version: "test",
		fetch: transport,
		resolveModel: id => models.find(model => id === `${model.provider}/${model.id}`),
		listModels: () => [...models, chat],
		excludeProviders: new Set(["devin"]),
	});
	fixture = {
		broker,
		brokerStorage,
		storage,
		gateway,
		attempts,
		refreshes,
		models,
		respond: () => completed(),
		addOAuth: async () => {
			await brokerStorage.credentials.set("anthropic", [oauth("oauth-a"), oauth("oauth-b")]);
			await storage.credentials.revalidate();
			return storage.credentials.list("anthropic").map(row => row.id);
		},
		close: async () => {
			await gateway.close();
			storage.close();
			await broker.close();
			brokerStorage.close();
		},
	};
	return fixture;
}

function inference(
	fixture: Fixture,
	path: string,
	pin?: string,
	model = "openai/pool-chat",
	stream = false,
): Promise<Response> {
	const content =
		path === "/v1/responses"
			? { input: "Which account?" }
			: path === "/v1/pi/stream"
				? {
						context: { messages: [{ role: "user", content: "Which account?", timestamp: 1 }] },
						options: { headers: { "X-Neopi-Credential-Id": "must-not-reach-upstream" } },
					}
				: { messages: [{ role: "user", content: "Which account?" }], max_tokens: 32 };
	return fetch(`${fixture.gateway.url}${path}`, {
		method: "POST",
		headers: { ...HEADERS, ...(pin !== undefined ? { [PRIVATE_HEADER]: pin } : {}) },
		body: JSON.stringify({ model, ...content, stream }),
	});
}

async function accounts(fixture: Fixture): Promise<AuthGatewayAccount[]> {
	const response = await fetch(`${fixture.gateway.url}/v1/neoproxy/accounts`, { headers: HEADERS });
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const body = (await response.json()) as { object: string; data: AuthGatewayAccount[] };
	expect(body.object).toBe("list");
	return body.data;
}

describe("NeoProxy authenticated account source", () => {
	let fixture: Fixture | undefined;
	afterEach(async () => {
		await fixture?.close();
		fixture = undefined;
	});

	test("inventory requires the gateway bearer even when legacy unauthenticated mode is enabled", async () => {
		fixture = await boot();
		for (const headers of [{}, { authorization: "Bearer wrong" }]) {
			const response = await fetch(`${fixture.gateway.url}/v1/neoproxy/accounts`, { headers });
			expect(response.status).toBe(401);
			expect(await response.text()).not.toContain("private-key");
		}
		await fixture.close();
		fixture = await boot([]);
		expect((await fetch(`${fixture.gateway.url}/v1/neoproxy/accounts`)).status).toBe(401);
		expect((await inference(fixture, "/v1/chat/completions", "1")).status).toBe(401);
		expect((await fetch(`${fixture.gateway.url}/v1/models`)).status).toBe(200);
	});

	test("scoped client tokens cannot enumerate or select gateway accounts", async () => {
		fixture = await boot();
		const headers = { ...HEADERS, authorization: "Bearer scoped-source-token" };
		const inventory = await fetch(`${fixture.gateway.url}/v1/neoproxy/accounts`, { headers });
		expect(inventory.status).toBe(403);
		expect(await inventory.text()).not.toContain("openai account");
		const selected = await fetch(`${fixture.gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { ...headers, [PRIVATE_HEADER]: "1" },
			body: JSON.stringify({ model: "openai/pool-chat", messages: [{ role: "user", content: "forbidden pin" }] }),
		});
		expect(selected.status).toBe(403);
		expect(fixture.attempts).toHaveLength(0);
		const native = await fetch(`${fixture.gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: "openai/pool-chat", messages: [{ role: "user", content: "ordinary scoped request" }] }),
		});
		expect(native.status).toBe(200);
		await native.text();
	});

	test("inventory exposes stable secret-free rows, exact catalogue entitlements and real per-account windows", async () => {
		fixture = await boot();
		const [firstOAuth, secondOAuth] = await fixture.addOAuth();
		await fixture.brokerStorage.credentials.set("devin", { type: "api_key", key: "disabled-provider-secret" });
		const rows = await accounts(fixture);
		expect(rows).toHaveLength(4);
		const first = rows.find(row => row.id === String(firstOAuth));
		const second = rows.find(row => row.id === String(secondOAuth));
		expect(first?.models).toEqual(["anthropic/oauth-chat", "anthropic/entitled-chat"]);
		expect(second?.models).toEqual(["anthropic/oauth-chat"]);
		expect(first?.windows).toEqual([
			{ kind: "five_hour", known: true, used: 0.25, resetsAt: expect.any(Number) },
			{ kind: "monthly", known: false },
		]);
		expect(second?.windows[0]?.used).toBe(0.75);
		for (const row of rows.filter(row => row.provider === "openai")) {
			expect(row.models).toEqual(["openai/pool-chat", "openai/pool-embedding"]);
			expect(row.windows).toEqual([]);
			expect(row.label).toBe(`openai account ${row.id}`);
		}
		const serialized = JSON.stringify(rows);
		for (const secret of [
			"private-key",
			"private-refresh",
			"sk-ant-oat01",
			"private-metadata",
			"private-raw",
			"@example.test",
			"disabled-provider-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
		const catalog = (await fetch(`${fixture.gateway.url}/v1/models`, { headers: HEADERS }).then(response =>
			response.json(),
		)) as { data: { id: string }[] };
		const catalogIds = new Set(catalog.data.map(row => row.id));
		for (const row of rows) for (const model of row.models) expect(catalogIds.has(model)).toBe(true);
	});

	test("stale native amounts stay unknown instead of appearing as available quota", async () => {
		fixture = await boot();
		fixture.storage.usage.setProvider("openai", {
			id: "openai",
			fetchUsage: async () => ({
				provider: "openai",
				fetchedAt: Date.now() - 86_400_000,
				limits: [
					{
						id: "five_hour",
						label: "Old usage",
						scope: { provider: "openai", shared: true },
						amount: { unit: "percent", used: 10 },
					},
				],
			}),
		});
		for (const row of await accounts(fixture)) {
			expect(row.windows).toEqual([{ kind: "five_hour", known: false }]);
		}
	});

	test("a pin removed after preflight cannot turn into keyless or ambient inference", async () => {
		fixture = await boot();
		await fixture.brokerStorage.credentials.set("opencode-zen", {
			type: "api_key",
			key: "private-keyless-provider-key",
		});
		await fixture.storage.credentials.revalidate();
		const model = chatModel("opencode-zen", "keyless-race");
		const id = fixture.storage.credentials.list("opencode-zen")[0].id;
		const signal = new AbortController().signal;
		const initial = await resolveGatewayApiKey({ storage: fixture.storage }, model, "revocation-race", signal, "test", String(id));
		if ("status" in initial) throw new Error("pin preflight unexpectedly failed");
		const resolver = buildGatewayApiKeyResolver(
			{ storage: fixture.storage },
			model,
			"revocation-race",
			initial,
			signal,
			"test",
			"test",
		);
		await fixture.brokerStorage.credentials.removeById("opencode-zen", id);
		let upstreamCalls = 0;
		await expect(
			completeSimple(
				model,
				{ messages: [{ role: "user", content: "must not dispatch", timestamp: 1 }] },
				{
					apiKey: resolver,
					signal,
					fetch: async () => {
						upstreamCalls += 1;
						return completed();
					},
				},
			),
		).rejects.toThrow("Selected credential became unavailable");
		expect(upstreamCalls).toBe(0);
	});

	for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/pi/stream"]) {
		test(`${path} uses the exact selected row and consumes the private selector`, async () => {
			fixture = await boot();
			fixture.storage.keys.setRuntime("openai", "native-runtime-key");
			const selected = fixture.storage.credentials.list("openai")[1];
			const response = await inference(fixture, path, String(selected.id));
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("account selected");
			expect(fixture.attempts.length).toBeGreaterThan(0);
			for (const attempt of fixture.attempts) {
				expect(attempt.headers.get("authorization")).toBe("Bearer private-key-second");
				expect(attempt.headers.has(PRIVATE_HEADER)).toBe(false);
			}
		});
	}

	test("streamed Responses keep the selected credential throughout provider dispatch", async () => {
		fixture = await boot();
		const id = fixture.storage.credentials.list("openai")[1].id;
		const response = await inference(fixture, "/v1/responses", String(id), undefined, true);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("account selected");
		expect(
			fixture.attempts.every(attempt => attempt.headers.get("authorization") === "Bearer private-key-second"),
		).toBe(true);
	});

	test("absent selector preserves native runtime-key precedence", async () => {
		fixture = await boot();
		fixture.storage.keys.setRuntime("openai", "native-runtime-key");
		const response = await inference(fixture, "/v1/chat/completions");
		expect(response.status).toBe(200);
		await response.text();
		expect(fixture.attempts[0].headers.get("authorization")).toBe("Bearer native-runtime-key");
	});

	test("invalid, unknown, mismatched and disabled selectors fail before provider traffic", async () => {
		fixture = await boot();
		const [oauthId] = await fixture.addOAuth();
		const openaiId = fixture.storage.credentials.list("openai")[0].id;
		for (const pin of ["", "0", "-1", "1.5", "1,2", "9007199254740992", "999999999", String(oauthId)]) {
			const response = await inference(fixture, "/v1/chat/completions", pin);
			expect(response.status).toBe(pin === "999999999" || pin === String(oauthId) ? 403 : 400);
			await response.text();
		}
		await fixture.brokerStorage.credentials.removeById("openai", openaiId);
		const removed = await inference(fixture, "/v1/responses", String(openaiId));
		expect(removed.status).toBe(403);
		expect(fixture.attempts).toEqual([]);
		expect((await accounts(fixture)).some(row => row.id === String(openaiId))).toBe(false);
	});

	test("blocked and disabled rows fail closed without changing a healthy sibling", async () => {
		fixture = await boot();
		const [blocked, healthy] = fixture.storage.credentials.list("openai");
		fixture.brokerStorage.blocks.upsert({
			credentialId: blocked.id,
			providerKey: "openai:api_key",
			blockScope: "",
			blockedUntilMs: Date.now() + 60_000,
		});
		const rows = await accounts(fixture);
		expect(rows.find(row => row.id === String(blocked.id))?.state).toBe("blocked");
		expect(rows.find(row => row.id === String(healthy.id))?.state).toBe("healthy");
		expect((await inference(fixture, "/v1/chat/completions", String(blocked.id))).status).toBe(403);
		await fixture.brokerStorage.credentials.disable(healthy.id, "disabled by test operator");
		expect((await inference(fixture, "/v1/chat/completions", String(healthy.id))).status).toBe(403);
		expect((await accounts(fixture)).some(row => row.id === String(healthy.id))).toBe(false);
		expect(fixture.attempts).toHaveLength(0);
	});

	test("provider disables cannot be bypassed with an otherwise valid row selector", async () => {
		fixture = await boot();
		await fixture.brokerStorage.credentials.set("devin", { type: "api_key", key: "private-disabled-provider" });
		const row = fixture.brokerStorage.credentials.list("devin")[0];
		const response = await inference(fixture, "/v1/chat/completions", String(row.id), "devin/disabled-chat");
		expect(response.status).toBe(404);
		expect(fixture.attempts).toHaveLength(0);
	});

	test("pinned inference does not repin the native session sharing its cache key", async () => {
		fixture = await boot();
		const [native, selected] = await fixture.addOAuth();
		expect(fixture.storage.sessions.pin("anthropic", "same-client-key", native)).toBe(true);
		const response = await fetch(`${fixture.gateway.url}/v1/chat/completions`, {
			method: "POST",
			headers: { ...HEADERS, [PRIVATE_HEADER]: String(selected) },
			body: JSON.stringify({
				model: "anthropic/oauth-chat",
				prompt_cache_key: "same-client-key",
				stream: false,
				messages: [{ role: "user", content: "Select the other row" }],
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(fixture.attempts[0].headers.get("authorization")).toBe("Bearer sk-ant-oat01-initial-oauth-b");
		expect(
			fixture.storage.oauth.accounts("anthropic", "same-client-key").find(account => account.active)?.credentialId,
		).toBe(native);
	});

	test("known account entitlement rejects a sibling even when it has valid auth", async () => {
		fixture = await boot();
		const [allowed, denied] = await fixture.addOAuth();
		const rejected = await inference(fixture, "/v1/messages", String(denied), "anthropic/entitled-chat");
		expect(rejected.status).toBe(403);
		expect(fixture.attempts).toHaveLength(0);
		const accepted = await inference(fixture, "/v1/messages", String(allowed), "anthropic/entitled-chat");
		expect(accepted.status).toBe(200);
		await accepted.text();
		expect(fixture.attempts[0].headers.get("authorization")).toBe("Bearer sk-ant-oat01-initial-oauth-a");
	});

	for (const status of [401, 403, 429]) {
		test(`upstream ${status} never falls through to a healthy sibling`, async () => {
			fixture = await boot();
			const id = fixture.storage.credentials.list("openai")[0].id;
			fixture.respond = attempt =>
				attempt.headers.get("authorization") === "Bearer private-key-first"
					? Response.json(
							{
								error: {
									message: status === 429 ? "usage_limit_reached" : "invalid API key",
									type: status === 429 ? "usage_limit_reached" : "authentication_error",
								},
							},
							// Exercise every normal 429 transport attempt without a wall-clock backoff.
							{ status, headers: status === 429 ? { "retry-after-ms": "0" } : {} },
						)
					: completed();
			const response = await inference(fixture, "/v1/chat/completions", String(id));
			expect(response.status).toBeGreaterThanOrEqual(400);
			await response.text();
			expect(fixture.attempts.length).toBeGreaterThan(0);
			if (status === 429) expect(fixture.attempts).toHaveLength(6);
			expect(
				fixture.attempts.every(attempt => attempt.headers.get("authorization") === "Bearer private-key-first"),
			).toBe(true);
		});
	}

	test("OAuth 401 refreshes the same broker row and keeps the inventory id stable", async () => {
		fixture = await boot();
		const [id] = await fixture.addOAuth();
		fixture.respond = attempt =>
			attempt.headers.get("authorization") === "Bearer sk-ant-oat01-initial-oauth-a"
				? Response.json({ error: { message: "invalid API key", type: "authentication_error" } }, { status: 401 })
				: completed();
		const response = await inference(fixture, "/v1/chat/completions", String(id), "anthropic/oauth-chat");
		expect(response.status).toBe(200);
		await response.text();
		expect(fixture.refreshes).toEqual([id]);
		expect(fixture.attempts.map(attempt => attempt.headers.get("authorization"))).toEqual([
			"Bearer sk-ant-oat01-initial-oauth-a",
			`Bearer sk-ant-oat01-renewed-${id}`,
		]);
		expect((await accounts(fixture)).find(row => row.id === String(id))?.provider).toBe("anthropic");
		const row = fixture.brokerStorage.credentials.list("anthropic").find(candidate => candidate.id === id);
		expect(row?.credential.type === "oauth" && row.credential.refresh).toBe(`private-rotated-${id}`);
	});

	test("failed same-account OAuth recovery never switches to a valid sibling", async () => {
		fixture = await boot();
		const [id] = await fixture.addOAuth();
		fixture.respond = attempt =>
			attempt.headers.get("authorization") === "Bearer sk-ant-oat01-initial-oauth-b"
				? completed()
				: Response.json({ error: { message: "invalid API key", type: "authentication_error" } }, { status: 401 });
		const response = await inference(fixture, "/v1/chat/completions", String(id), "anthropic/oauth-chat");
		expect(response.status).toBeGreaterThanOrEqual(400);
		await response.text();
		expect(fixture.refreshes).toEqual([id]);
		expect(fixture.attempts.map(attempt => attempt.headers.get("authorization"))).toEqual([
			"Bearer sk-ant-oat01-initial-oauth-a",
			`Bearer sk-ant-oat01-renewed-${id}`,
		]);
	});

	test("a row removed during provider failure cannot retry through its compacted sibling slot", async () => {
		fixture = await boot();
		const active = fixture;
		const id = active.storage.credentials.list("openai")[0].id;
		active.respond = async () => {
			await active.brokerStorage.credentials.removeById("openai", id);
			return Response.json({ error: { message: "invalid API key", type: "authentication_error" } }, { status: 401 });
		};
		const response = await inference(active, "/v1/chat/completions", String(id));
		expect(response.status).toBeGreaterThanOrEqual(400);
		await response.text();
		expect(active.attempts).toHaveLength(1);
		expect((await accounts(active)).some(row => row.id === String(id))).toBe(false);
	});

	test("shared embedding dispatch honors the same selector and rejects stale pins", async () => {
		fixture = await boot();
		const active = fixture;
		const id = active.storage.credentials.list("openai")[1].id;
		active.respond = () =>
			Response.json({
				object: "list",
				model: "pool-embedding",
				data: [{ object: "embedding", index: 0, embedding: [0.5] }],
				usage: { prompt_tokens: 1, total_tokens: 1 },
			});
		const request = () =>
			fetch(`${active.gateway.url}/v1/embeddings`, {
				method: "POST",
				headers: { ...HEADERS, [PRIVATE_HEADER]: String(id) },
				body: JSON.stringify({ model: "openai/pool-embedding", input: "account selection" }),
			});
		const response = await request();
		expect(response.status).toBe(200);
		await response.text();
		expect(active.attempts[0].headers.get("authorization")).toBe("Bearer private-key-second");
		expect(active.attempts[0].headers.has(PRIVATE_HEADER)).toBe(false);
		await active.brokerStorage.credentials.removeById("openai", id);
		expect((await request()).status).toBe(403);
		expect(active.attempts).toHaveLength(1);
	});
});
