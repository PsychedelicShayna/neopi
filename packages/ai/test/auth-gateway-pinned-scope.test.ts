import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import {
	buildGatewayApiKeyResolver,
	resolveGatewayApiKey,
	startAuthGateway,
	type AuthGatewayServerHandle,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ProviderTlsTrust } from "@oh-my-pi/pi-utils";
import { completionsChunks } from "./helpers/factory-droid";

const origin = "https://pinned-scope.test";
const model: Model<Api> = buildModel({
	provider: "openai",
	id: "scope-chat",
	name: "scope-chat",
	api: "openai-completions",
	baseUrl: `${origin}/v1`,
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
let storage: AuthStorage;
let gateway: AuthGatewayServerHandle | undefined;
afterEach(async () => {
	await gateway?.close();
	gateway = undefined;
	storage?.close();
});
async function seed(requestOrigin: string, tlsTrust?: ProviderTlsTrust): Promise<number> {
	storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
	});
	await storage.credentials.set("openai", { type: "api_key", key: "fake-scope-key", requestOrigin, tlsTrust });
	return storage.credentials.list("openai")[0].id;
}
async function request(id: number, transport: FetchImpl): Promise<Response> {
	gateway = startAuthGateway({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: ["fake-gateway-token"],
		version: "test",
		fetch: transport,
		resolveModel: () => model,
	});
	return fetch(`${gateway.url}/v1/chat/completions`, {
		method: "POST",
		headers: {
			authorization: "Bearer fake-gateway-token",
			"content-type": "application/json",
			"X-Neopi-Credential-Id": String(id),
		},
		body: JSON.stringify({ model: "openai/scope-chat", messages: [{ role: "user", content: "scope test" }] }),
	});
}
function completed(): Response {
	return new Response(
		`${completionsChunks("scoped", "scope-chat")
			.map(chunk => `data: ${chunk}`)
			.join("\n\n")}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

test("gateway bearer pin refuses a different origin before the first provider send", async () => {
	const id = await seed("https://other-origin.test");
	let calls = 0;
	const response = await request(id, async () => {
		calls++;
		return completed();
	});
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(await response.text()).toContain("origin");
	expect(calls).toBe(0);
});

test("pinned first send and provider transient retry retain CA-only verified TLS and refuse redirects", async () => {
	const caPem = await Bun.file(
		new URL("../../coding-agent/test/fixtures/neoproxy-tls/ca.pem", import.meta.url),
	).text();
	const trust = { origin, caPem, caFingerprint256: new X509Certificate(caPem).fingerprint256 };
	const id = await seed(origin, trust);
	const attempts: RequestInit[] = [];
	const response = await request(id, async (_input, init) => {
		attempts.push(init!);
		return attempts.length === 1
			? Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 })
			: new Response(null, { status: 302, headers: { location: "https://other-origin.test/leak" } });
	});
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(await response.text()).toContain("redirect");
	expect(attempts).toHaveLength(2);
	for (const init of attempts) {
		expect(init.redirect).toBe("manual");
		expect(init.credentials).toBe("omit");
		expect((init as RequestInit & { tls?: unknown }).tls).toEqual({ ca: caPem, rejectUnauthorized: true });
	}
});

test("initial and recovery pin resolutions retain scope and refuse a changed final row", async () => {
	const id = await seed(origin);
	const signal = new AbortController().signal;
	const initial = await resolveGatewayApiKey({ storage }, model, "scope-session", signal, "test", String(id));
	if ("status" in initial) throw new Error("pin unexpectedly rejected");
	expect(initial.requestOrigin).toBe(origin);
	const resolver = buildGatewayApiKeyResolver({ storage }, model, "scope-session", initial, signal, "test", "test");
	for (const error of [undefined, new Error("forced auth recovery")]) {
		const resolved = await resolver({ error, signal, lastChance: false, previousKey: initial.apiKey });
		expect(resolved).toMatchObject({ apiKey: "fake-scope-key", requestOrigin: origin });
	}
	const getPinned = storage.keys.getPinned.bind(storage.keys);
	const race = spyOn(storage.keys, "getPinned").mockImplementation(async (...args) => {
		const key = await getPinned(...args);
		const row = storage.credentials.list("openai")[0];
		if (row.credential.type === "api_key") row.credential.requestOrigin = "https://changed-scope.test";
		return key;
	});
	try {
		expect(
			await resolver({
				error: new Error("forced recovery"),
				signal,
				lastChance: false,
				previousKey: initial.apiKey,
			}),
		).toBeUndefined();
	} finally {
		race.mockRestore();
	}
});
