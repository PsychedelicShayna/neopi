import { afterEach, describe, expect, test, vi } from "bun:test";
import { X509Certificate } from "node:crypto";
import type { AuthStorage, OAuthAccess } from "@oh-my-pi/pi-ai";
import type { ApiKeyCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { OAuthRefreshUnavailableError } from "@oh-my-pi/pi-ai/error";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import {
	buildLiveSessionPayload,
	buildLiveSessionUpdate,
	DEFAULT_LIVE_MODEL,
} from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import {
	buildLiveSidebandUrl,
	type LiveEndpoint,
	LiveTransport,
	type LiveTransportOptions,
	liveEndpointCallsUrl,
	liveEndpointHeaders,
	liveEndpointSidebandUrl,
	parseLiveEndpointCallId,
	resolveLiveEndpoint,
} from "@oh-my-pi/pi-coding-agent/live/transport";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "../helpers/fetch-mock";

/** Headers only Codex calls carry besides {@link OPENAI_HEADERS}; a custom endpoint must never see any. */
const CODEX_ONLY_HEADERS = ["x-oai-attestation", "openai-alpha", "x-session-id"];

/** Auth storage that fails the test if a custom-endpoint call asks for a Codex login. */
const noCodexLogin = {
	oauth: {
		access: () => {
			throw new Error("a custom live endpoint must not use Codex OAuth");
		},
	},
} as unknown as AuthStorage;

const callbacks = { onEvent: () => {}, onOutputLevel: () => {} };

/** A local OpenAI Realtime WebRTC-shaped server recording what it receives. */
function realtimeServer(liveApiKey?: string) {
	const calls: Request[] = [];
	const offers: string[] = [];
	const upgrades: Request[] = [];
	const messages: string[] = [];
	const message = Promise.withResolvers<string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (liveApiKey && request.method === "GET" && url.pathname === "/v1/live") {
				return Response.json({ available: request.headers.get("authorization") === `Bearer ${liveApiKey}` });
			}
			if (request.method === "POST" && url.pathname === "/v1/realtime/calls") {
				calls.push(request);
				offers.push(await request.text());
				return new Response("v=0 answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_local" } });
			}
			if (url.pathname === "/v1/realtime") {
				const snapshot = new Request(request.url, { headers: request.headers });
				if (srv.upgrade(request)) {
					upgrades.push(snapshot);
					return undefined;
				}
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(_socket, data) {
				messages.push(String(data));
				message.resolve(String(data));
			},
		},
	});
	return { server, calls, offers, upgrades, messages, firstMessage: message.promise };
}

function endpointTransport(endpoint: LiveEndpoint): LiveTransport {
	return new LiveTransport({
		authStorage: noCodexLogin,
		endpoint,
		sessionId: "s1",
		instructions: "Be brief.",
		voice: "marin",
		model: "gpt-realtime",
		sdpOffer: "v=0 offer",
		callbacks,
	});
}

function expectNoCodexHeaders(request: Request): void {
	for (const name of CODEX_ONLY_HEADERS) expect(request.headers.has(name)).toBe(false);
	for (const key in OPENAI_HEADERS) {
		expect(request.headers.has(OPENAI_HEADERS[key as keyof typeof OPENAI_HEADERS])).toBe(false);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("live endpoint URLs", () => {
	test("hangs the realtime paths off the base, with or without a trailing slash", () => {
		for (const base of ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1/"]) {
			expect(liveEndpointCallsUrl(base)).toBe("http://127.0.0.1:8080/v1/realtime/calls");
			expect(liveEndpointSidebandUrl(base, "rtc_1")).toBe("ws://127.0.0.1:8080/v1/realtime?call_id=rtc_1");
		}
	});

	test("maps https to wss and keeps the base's query", () => {
		expect(liveEndpointSidebandUrl("https://voice.example.com", "abc")).toBe(
			"wss://voice.example.com/realtime?call_id=abc",
		);
		expect(liveEndpointCallsUrl("https://voice.example.com/openai?api-version=1")).toBe(
			"https://voice.example.com/openai/realtime/calls?api-version=1",
		);
		expect(liveEndpointSidebandUrl("https://voice.example.com/openai?api-version=1", "a b")).toBe(
			"wss://voice.example.com/openai/realtime?api-version=1&call_id=a+b",
		);
	});

	test("takes the call ID from the Location header's last path segment", () => {
		expect(parseLiveEndpointCallId("/v1/realtime/calls/rtc_abc")).toBe("rtc_abc");
		expect(parseLiveEndpointCallId("http://127.0.0.1:8080/v1/realtime/calls/call-9/?x=1")).toBe("call-9");
		expect(parseLiveEndpointCallId(null)).toBeUndefined();
		expect(parseLiveEndpointCallId("/")).toBeUndefined();
	});

	test("leaves the Codex sideband URL unchanged", () => {
		expect(buildLiveSidebandUrl("rtc_1")).toBe("wss://api.openai.com/v1/live/rtc_1");
	});
});

describe("live endpoint credentials", () => {
	test("sends only the endpoint's own bearer key", () => {
		expect(liveEndpointHeaders({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" })).toEqual({
			Authorization: "Bearer k",
		});
		expect(liveEndpointHeaders({ baseUrl: "http://127.0.0.1:8080/v1" })).toEqual({});
	});

	test("resolves live.apiKey like other configured secrets", async () => {
		expect(await resolveLiveEndpoint(Settings.isolated())).toBeUndefined();
		expect(await resolveLiveEndpoint(Settings.isolated({ "live.endpoint": "  " }))).toBeUndefined();
		process.env.OMP_LIVE_ENDPOINT_TEST_KEY = "from-env";
		try {
			const settings = Settings.isolated({
				"live.endpoint": " http://127.0.0.1:8080/v1 ",
				"live.apiKey": "OMP_LIVE_ENDPOINT_TEST_KEY",
			});
			expect(await resolveLiveEndpoint(settings)).toEqual({
				baseUrl: "http://127.0.0.1:8080/v1",
				apiKey: "from-env",
			});
		} finally {
			delete process.env.OMP_LIVE_ENDPOINT_TEST_KEY;
		}
		const literal = Settings.isolated({ "live.endpoint": "http://127.0.0.1:8080/v1", "live.apiKey": "sk-local" });
		expect(await resolveLiveEndpoint(literal)).toEqual({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-local" });
	});
});

describe("live transport on a custom endpoint", () => {
	test("signals the bare SDP and configures the session over the sideband without a Codex login", async () => {
		const local = realtimeServer();
		const transport = endpointTransport({
			baseUrl: `http://127.0.0.1:${local.server.port}/v1/`,
			apiKey: "local-key",
		});
		try {
			await transport.connect();
			expect(transport.sdpAnswer).toBe("v=0 answer");
			expect(local.offers).toEqual(["v=0 offer"]);
			const call = local.calls[0]!;
			expect(call.headers.get("content-type")).toBe("application/sdp");
			expect(call.headers.get("authorization")).toBe("Bearer local-key");
			expectNoCodexHeaders(call);
			const upgrade = local.upgrades[0]!;
			expect(new URL(upgrade.url).searchParams.get("call_id")).toBe("rtc_local");
			expect(upgrade.headers.get("authorization")).toBe("Bearer local-key");
			expectNoCodexHeaders(upgrade);
			expect(JSON.parse(await local.firstMessage)).toEqual(buildLiveSessionUpdate("Be brief.", "marin"));
		} finally {
			await transport.close();
			local.server.stop(true);
		}
	});

	test("sends no Authorization header without a key", async () => {
		const local = realtimeServer();
		const transport = endpointTransport({ baseUrl: `http://127.0.0.1:${local.server.port}/v1` });
		try {
			await transport.connect();
			expect(local.calls[0]!.headers.has("authorization")).toBe(false);
			expect(local.upgrades[0]!.headers.has("authorization")).toBe(false);
		} finally {
			await transport.close();
			local.server.stop(true);
		}
	});

	test("refuses a redirect to another origin without sending it the key", async () => {
		const elsewhere = realtimeServer();
		const redirecting = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(null, {
					status: 307,
					headers: { Location: `http://127.0.0.1:${elsewhere.server.port}/v1/realtime/calls` },
				}),
		});
		const transport = endpointTransport({ baseUrl: `http://127.0.0.1:${redirecting.port}/v1`, apiKey: "local-key" });
		try {
			await expect(transport.connect()).rejects.toThrow(/redirected \(307\)/);
			expect(elsewhere.calls).toEqual([]);
		} finally {
			await transport.close();
			redirecting.stop(true);
			elsewhere.server.stop(true);
		}
	});
});

describe("live transport without an endpoint", () => {
	test("still signals Codex with the openai-codex login", async () => {
		const providers: string[] = [];
		const authStorage = {
			oauth: {
				access: async (provider: string) => {
					providers.push(provider);
					return undefined;
				},
			},
		} as unknown as AuthStorage;
		const transport = new LiveTransport({
			authStorage,
			sessionId: "s1",
			instructions: "Be brief.",
			voice: "sol",
			model: "gpt-realtime",
			sdpOffer: "v=0 offer",
			callbacks,
		});
		await expect(transport.connect()).rejects.toThrow("No Codex OAuth credential is available for a live call.");
		expect(providers).toEqual(["openai-codex"]);
	});
});

describe("live transport on NeoProxy", () => {
	async function configuredProxy(
		temp: TempDir,
		baseUrl: string,
		keys: ApiKeyCredential[],
		options: Partial<LiveTransportOptions> = {},
	) {
		const configFile = temp.join("models.yml");
		await Bun.write(configFile, JSON.stringify({ providers: { neoproxy: { baseUrl, auth: "apiKey" } } }));
		const access = vi.fn(async (): Promise<OAuthAccess | undefined> => undefined);
		const list = vi.fn(() => keys.map(credential => ({ credential })));
		const transport = new LiveTransport({
			authStorage: { oauth: { access }, credentials: { list } } as unknown as AuthStorage,
			modelRegistry: { getConfigFile: () => configFile },
			sessionId: "s1",
			instructions: "Be brief.",
			voice: "sol",
			model: DEFAULT_LIVE_MODEL,
			sdpOffer: "v=0 offer",
			callbacks,
			...options,
		});
		return { transport, access, list };
	}

	test("probes only origin-bound keys and uses the same eligible key and CA for both call legs", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const tlsDir = new URL("../fixtures/neoproxy-tls/", import.meta.url);
		const [ca, leaf, key] = await Promise.all([
			Bun.file(new URL("ca.pem", tlsDir)).text(),
			Bun.file(new URL("server.pem", tlsDir)).text(),
			Bun.file(new URL("server-key.pem", tlsDir)).text(),
		]);
		const requests: Request[] = [];
		let offer: unknown;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert: leaf + ca, key },
			async fetch(request, srv) {
				requests.push(request);
				const { pathname } = new URL(request.url);
				const eligible = request.headers.get("authorization") === "Bearer eligible";
				if (pathname === "/gateway/v1/live") {
					// A truthy non-boolean is not an eligibility grant.
					return Response.json({ available: eligible ? true : "true" });
				}
				if (!eligible) return new Response(null, { status: 403 });
				if (pathname === "/gateway/v1/realtime/calls") {
					offer = await request.json();
					// Location names the call; it must not choose a destination.
					return new Response("v=0 answer", {
						status: 201,
						headers: { Location: "https://elsewhere.invalid/rtc_proxy" },
					});
				}
				if (pathname === "/gateway/v1/realtime" && srv.upgrade(request)) return undefined;
				return new Response(null, { status: 404 });
			},
			websocket: { message() {} },
		});
		const origin = `https://127.0.0.1:${server.port}`;
		const tlsTrust = { origin, caPem: ca, caFingerprint256: new X509Certificate(ca).fingerprint256 };
		const { transport, access } = await configuredProxy(temp, `${origin}/gateway/v1/`, [
			{ type: "api_key", key: "wrong-origin", requestOrigin: "https://elsewhere.invalid", tlsTrust },
			{ type: "api_key", key: "unbound" },
			{ type: "api_key", key: "not-eligible", requestOrigin: origin, tlsTrust },
			{ type: "api_key", key: "eligible", requestOrigin: origin, tlsTrust },
		]);
		try {
			await transport.connect();
			expect(access).toHaveBeenCalledTimes(1);
			expect(transport.provider).toBe("neoproxy");
			expect(transport.sdpAnswer).toBe("v=0 answer");
			expect(offer).toEqual({
				sdp: "v=0 offer",
				session: buildLiveSessionPayload("Be brief.", "sol", DEFAULT_LIVE_MODEL),
			});
			const routes = requests.map(request => {
				const url = new URL(request.url);
				return [request.method, url.pathname + url.search, request.headers.get("authorization")];
			});
			expect(routes).toEqual([
				["GET", "/gateway/v1/live", "Bearer not-eligible"],
				["GET", "/gateway/v1/live", "Bearer eligible"],
				["POST", "/gateway/v1/realtime/calls", "Bearer eligible"],
				["GET", "/gateway/v1/realtime?call_id=rtc_proxy", "Bearer eligible"],
			]);
			for (const request of requests) expectNoCodexHeaders(request);
		} finally {
			await transport.close();
			server.stop(true);
		}
	});

	test("falls back to an eligible NeoProxy key when the Codex OAuth refresh is unavailable", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const { server, calls, upgrades } = realtimeServer("eligible");
		const origin = server.url.origin;
		const { transport, access } = await configuredProxy(temp, `${origin}/v1`, [
			{ type: "api_key", key: "eligible", requestOrigin: origin },
		]);
		access.mockRejectedValue(new OAuthRefreshUnavailableError("openai-codex", new Error("refresh offline")));
		try {
			await transport.connect();
			expect(transport.provider).toBe("neoproxy");
			expect(transport.sdpAnswer).toBe("v=0 answer");
			expect(calls[0]?.headers.get("authorization")).toBe("Bearer eligible");
			expect(upgrades[0]?.headers.get("authorization")).toBe("Bearer eligible");
		} finally {
			await transport.close();
			server.stop(true);
		}
	});

	test("preserves the Codex refresh error when no eligible NeoProxy key is available", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const { transport, access, list } = await configuredProxy(temp, "http://127.0.0.1:1/v1", []);
		const error = new OAuthRefreshUnavailableError("openai-codex", new Error("refresh offline"));
		access.mockRejectedValue(error);
		await expect(transport.connect()).rejects.toBe(error);
		expect(list).toHaveBeenCalledWith("neoproxy");
	});

	test("aborts rather than falling back if cancellation coincides with a Codex refresh failure", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const origin = "http://127.0.0.1:1";
		const abort = new AbortController();
		const cancelled = new Error("Cancel live startup");
		const { transport, access, list } = await configuredProxy(
			temp,
			`${origin}/v1`,
			[{ type: "api_key", key: "eligible", requestOrigin: origin }],
			{ signal: abort.signal },
		);
		access.mockImplementation(async () => {
			abort.abort(cancelled);
			throw new OAuthRefreshUnavailableError("openai-codex", new Error("refresh offline"));
		});
		await expect(transport.connect()).rejects.toBe(cancelled);
		expect(list).not.toHaveBeenCalled();
	});

	test("propagates other Codex OAuth errors without probing NeoProxy", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const { transport, access, list } = await configuredProxy(temp, "http://127.0.0.1:1/v1", []);
		const error = new Error("Cannot read Codex credentials");
		access.mockRejectedValue(error);
		await expect(transport.connect()).rejects.toBe(error);
		expect(list).not.toHaveBeenCalled();
	});

	test("uses Codex first and never falls back after direct signaling begins", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(asGlobalFetch(() => new Response(null, { status: 418 })));
		const { transport, access, list } = await configuredProxy(temp, "http://127.0.0.1:1/v1", []);
		access.mockResolvedValue({ accessToken: "codex-oauth", accountId: "account" });
		await expect(transport.connect()).rejects.toThrow(/Codex live signaling failed \(418\)/);
		expect(transport.provider).toBe("openai-codex");
		expect(list).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer codex-oauth");
	});

	test("cancels an in-flight NeoProxy probe and does not try the next key", async () => {
		using temp = TempDir.createSync("@neoproxy-live-");
		const origin = "http://127.0.0.1:1";
		const abort = new AbortController();
		const entered = Promise.withResolvers<void>();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch((_input, init) => {
				const result = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () => result.reject(init.signal?.reason), { once: true });
				entered.resolve();
				return result.promise;
			}),
		);
		const { transport, access } = await configuredProxy(
			temp,
			`${origin}/v1`,
			["first", "second"].map(key => ({ type: "api_key", key, requestOrigin: origin })),
			{ signal: abort.signal, canUseProvider: provider => provider === "neoproxy" },
		);
		const cancelled = new Error("Cancel live startup");
		const settled = transport.connect().catch((error: unknown) => error);
		try {
			await Promise.race([entered.promise, settled]);
			abort.abort(cancelled);
			expect(await settled).toBe(cancelled);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(access).not.toHaveBeenCalled();
		} finally {
			abort.abort();
			await transport.close();
		}
	});
});

describe("live session offline mode", () => {
	function controllerFor(settings: Settings, provider = "anthropic") {
		const endpoints: unknown[] = [];
		const optionsSeen: LiveTransportOptions[] = [];
		// bun's spyOn types a class export's implementation as `never`; a plain constructible function suffices.
		const transportSpy = vi.spyOn(liveTransport, "LiveTransport") as unknown as {
			mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
		};
		transportSpy.mockImplementation(function (options: LiveTransportOptions) {
			endpoints.push(options.endpoint);
			optionsSeen.push(options);
			return {
				connect: async () => {},
				setMuted: async () => {},
				send: async () => {},
				close: async () => {},
				sdpAnswer: "v=0 answer",
			};
		});
		const session = {
			modelRegistry: { authStorage: noCodexLogin },
			model: { provider },
			messages: [],
			sessionManager: { getCwd: () => process.cwd() },
			settings,
			sessionId: "s1",
			subscribe: () => () => {},
			sendCustomMessage: async () => {},
		} as unknown as LiveSessionControllerOptions["session"];
		const controller = new LiveSessionController({
			session,
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
		});
		return { controller, endpoints, optionsSeen };
	}

	test("allows an explicitly configured live endpoint", async () => {
		const settings = Settings.isolated({ "models.offline": true, "live.endpoint": "http://127.0.0.1:8080/v1" });
		const { controller, endpoints } = controllerFor(settings);
		await controller.start();
		expect(endpoints).toEqual([{ baseUrl: "http://127.0.0.1:8080/v1" }]);
		await controller.stop();
	});

	test("rejects automatic routing outside the active provider in offline mode", async () => {
		const { controller, endpoints } = controllerFor(Settings.isolated({ "models.offline": true }));
		await expect(controller.start()).rejects.toThrow("openai-codex or neoproxy session provider");
		expect(endpoints).toEqual([]);
	});

	test("allows automatic routing only through the active NeoProxy provider", async () => {
		const { controller, optionsSeen } = controllerFor(Settings.isolated({ "models.offline": true }), "neoproxy");
		await controller.start();
		try {
			expect(optionsSeen[0]?.canUseProvider?.("neoproxy")).toBe(true);
			expect(optionsSeen[0]?.canUseProvider?.("openai-codex")).toBe(false);
		} finally {
			await controller.stop();
		}
	});
});
