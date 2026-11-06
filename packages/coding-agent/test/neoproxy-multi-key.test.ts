import { stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FetchImpl, streamSimple } from "@oh-my-pi/pi-ai";
import { apiKeyAccountKey } from "@oh-my-pi/pi-ai/auth-storage";
import {
	getOAuthProvider,
	type OAuthLoginCallbacks,
	type OAuthPrompt,
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "@oh-my-pi/pi-ai/oauth";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelString, resolveModelFromString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { describeNeoProxy, withNeoProxyLoginUrl } from "@oh-my-pi/pi-coding-agent/neopi/neoproxy-connect";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

const KEY_A = "test-neoproxy-key-a";
const KEY_B = "test-neoproxy-key-b";
// NeoProxy advertises its served names under its own `neoproxy/` prefix.
const GRANTS: Record<string, string[]> = {
	[KEY_A]: ["neoproxy/shared-model", "neoproxy/only-a"],
	[KEY_B]: ["neoproxy/shared-model", "neoproxy/only-b"],
};

describe("NeoProxy multi-key aggregation", () => {
	let tempDir: TempDir;
	let configPath: string;
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let server: Bun.Server<undefined>;
	let origin: string;
	let revoked: Set<string>;
	let offline: boolean;
	let modelRequests: string[];
	let inference: { key: string; model: string | undefined }[];
	let previousProvider: OAuthProviderInterface | undefined;
	let prompts: OAuthPrompt[];

	const fetchImpl: FetchImpl = async (input, init) => {
		if (offline) throw new TypeError("fetch failed: connection refused");
		return fetch(input, init);
	};

	beforeEach(async () => {
		previousProvider = getOAuthProvider("neoproxy");
		tempDir = await TempDir.create("@neoproxy-multi-key-");
		configPath = tempDir.join("models.toml");
		await Bun.write(configPath, stringifySettingsToml({ providers: {} }));
		storage = await AuthStorage.create(tempDir.join("agent.db"));
		await storage.credentials.reload();
		revoked = new Set();
		offline = false;
		modelRequests = [];
		inference = [];
		prompts = [];
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
				const grants = GRANTS[key];
				if (!grants || revoked.has(key)) return new Response("invalid key", { status: 401 });
				const pathname = new URL(request.url).pathname;
				if (pathname === "/v1/models") {
					modelRequests.push(key);
					return Response.json({ data: grants.map(id => ({ id, supported_endpoint_types: ["openai"] })) });
				}
				if (pathname === "/v1/chat/completions") {
					const { model } = (await request.json()) as { model?: string };
					inference.push({ key, model });
					if (!model || !grants.includes(model)) return new Response("unknown model", { status: 400 });
					const chunk = (delta: object, finish: string | null) =>
						`data: ${JSON.stringify({ id: "chatcmpl-neoproxy", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
					return new Response(
						`${chunk({ role: "assistant", content: "routed" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		origin = `http://127.0.0.1:${server.port}`;
		registry = new ModelRegistry(storage, configPath, { fetch: fetchImpl });
	});

	afterEach(async () => {
		server.stop(true);
		storage.close();
		if (previousProvider) registerOAuthProvider(previousProvider);
		else unregisterOAuthProvider("neoproxy");
		await tempDir.remove();
	});

	function callbacks(answers: string[]): OAuthLoginCallbacks {
		return {
			onAuth() {
				throw new Error("NeoProxy key login never opens an authorization URL");
			},
			onPrompt: async prompt => {
				prompts.push(prompt);
				const answer = answers.shift();
				if (answer === undefined) throw new Error(`Unexpected prompt: ${prompt.message}`);
				return answer;
			},
			fetch: fetchImpl,
		};
	}

	async function loginKey(key: string, extraAnswers: string[] = []): Promise<void> {
		await withNeoProxyLoginUrl(registry, origin, () =>
			storage.oauth.login("neoproxy", callbacks([key, ...extraAnswers])),
		);
	}

	function storedKeys(): string[] {
		return storage.credentials
			.list("neoproxy")
			.map(row => (row.credential.type === "api_key" ? row.credential.key : ""));
	}

	function accessOf(modelId: string): string[] {
		const model = registry.find("neoproxy", modelId);
		return model?.accountAccess ? Object.keys(model.accountAccess).sort() : [];
	}

	const idA = () => apiKeyAccountKey({ key: KEY_A, requestOrigin: origin });
	const idB = () => apiKeyAccountKey({ key: KEY_B, requestOrigin: origin });

	async function connectBothKeys(): Promise<void> {
		await loginKey(KEY_A);
		// Enter at the add/replace prompt keeps the first key.
		await loginKey(KEY_B, [""]);
		await registry.refreshProvider("neoproxy", "online");
	}

	test("a second key for the same server is added and discovery unions both rosters", async () => {
		await connectBothKeys();
		expect(storedKeys().sort()).toEqual([KEY_A, KEY_B]);
		expect(prompts.map(prompt => prompt.message).join("\n")).toContain("1 other NeoProxy key(s)");
		expect(
			registry
				.getProviderModels("neoproxy")
				.map(model => model.id)
				.sort(),
		).toEqual(["only-a", "only-b", "shared-model"]);
		expect(accessOf("only-a")).toEqual([idA()]);
		expect(accessOf("only-b")).toEqual([idB()]);
		expect(accessOf("shared-model")).toEqual([idA(), idB()].sort());
		const cacheIds = JSON.stringify(registry.getProviderModels("neoproxy").map(model => model.accountAccess));
		expect(cacheIds).not.toContain(KEY_A);
		expect(cacheIds).not.toContain(KEY_B);
		expect(describeNeoProxy(registry)).toContain(`NeoProxy server: ${origin}`);
		expect(describeNeoProxy(registry)).not.toContain(KEY_A);
	});

	test("requests use a key that grants the selected model", async () => {
		await connectBothKeys();
		for (let attempt = 0; attempt < 4; attempt++) {
			expect(await registry.getApiKey(registry.find("neoproxy", "only-a")!)).toBe(KEY_A);
			expect(await registry.getApiKey(registry.find("neoproxy", "only-b")!)).toBe(KEY_B);
			expect(await registry.getApiKeyForProvider("neoproxy", undefined, { modelId: "only-b" })).toBe(KEY_B);
		}
		const shared = new Set<string | undefined>();
		for (let attempt = 0; attempt < 4; attempt++)
			shared.add(await registry.getApiKey(registry.find("neoproxy", "shared-model")!));
		expect([...shared].every(key => key === KEY_A || key === KEY_B)).toBe(true);
	});

	test("selectors carry one neoproxy/ prefix and requests send the advertised name", async () => {
		await connectBothKeys();
		const models = registry.getProviderModels("neoproxy");
		expect(models.map(formatModelString).sort()).toEqual([
			"neoproxy/only-a",
			"neoproxy/only-b",
			"neoproxy/shared-model",
		]);
		const selected = resolveModelFromString("neoproxy/only-b", models);
		expect(selected?.id).toBe("only-b");
		expect(selected?.requestModelId).toBe("neoproxy/only-b");
		const result = await streamSimple(
			selected!,
			{ messages: [{ role: "user", content: "Route me.", timestamp: 0 }] },
			{ apiKey: registry.resolver(selected!), fetch: fetchImpl, maxTokens: 8 },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(inference).toEqual([{ key: KEY_B, model: "neoproxy/only-b" }]);
	});

	test("a revoked key drops only its own models", async () => {
		await connectBothKeys();
		revoked.add(KEY_A);
		await registry.refreshProvider("neoproxy", "online");
		expect(
			registry
				.getProviderModels("neoproxy")
				.map(model => model.id)
				.sort(),
		).toEqual(["only-b", "shared-model"]);
		expect(accessOf("shared-model")).toEqual([idB()]);
		expect(await registry.getApiKey(registry.find("neoproxy", "shared-model")!)).toBe(KEY_B);
	});

	test("the last-known union stays selectable and routed while the proxy is unreachable", async () => {
		await connectBothKeys();
		offline = true;
		const restarted = new ModelRegistry(storage, configPath, { fetch: fetchImpl });
		expect(
			restarted
				.getProviderModels("neoproxy")
				.map(model => model.id)
				.sort(),
		).toEqual(["only-a", "only-b", "shared-model"]);
		await restarted.refreshProvider("neoproxy", "online");
		expect(restarted.getProviderDiscoveryState("neoproxy")?.status).toBe("cached");
		const onlyB = restarted.find("neoproxy", "only-b");
		expect(onlyB?.accountAccess && Object.keys(onlyB.accountAccess)).toEqual([idB()]);
		expect(onlyB?.requestModelId).toBe("neoproxy/only-b");
		expect(await restarted.getApiKey(onlyB!)).toBe(KEY_B);
	});

	test("replace on request removes the other keys; re-entering a stored key does not prompt", async () => {
		await loginKey(KEY_A);
		await loginKey(KEY_A);
		expect(storedKeys()).toEqual([KEY_A]);
		await loginKey(KEY_B, ["replace"]);
		expect(storedKeys()).toEqual([KEY_B]);
	});

	test("switching to another server replaces keys bound to the previous origin", async () => {
		await loginKey(KEY_A);
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ data: [{ id: "elsewhere" }] }),
		});
		try {
			const otherOrigin = `http://127.0.0.1:${other.port}`;
			await withNeoProxyLoginUrl(registry, otherOrigin, () => storage.oauth.login("neoproxy", callbacks([KEY_B])));
			expect(storage.credentials.list("neoproxy").map(row => row.credential)).toEqual([
				expect.objectContaining({ key: KEY_B, requestOrigin: otherOrigin }),
			]);
			expect(ModelsConfigFile.relocate(configPath).load()?.providers?.neoproxy?.baseUrl).toBe(`${otherOrigin}/v1`);
		} finally {
			other.stop(true);
		}
	});

	test("/login neoproxy <url> supplies the URL for that login only", async () => {
		let pending: Promise<unknown> | undefined;
		const ctx = {
			oauthManualInput: new OAuthManualInputManager(),
			editor: { setText: () => {} } as unknown as InteractiveModeContext["editor"],
			session: { modelRegistry: registry } as unknown as InteractiveModeContext["session"],
			showStatus: () => {},
			showWarning: () => {},
			showOAuthSelector: async (_mode: "login" | "logout", providerId?: string) => {
				pending = storage.oauth.login(providerId as "neoproxy", callbacks([KEY_A]));
				await pending;
			},
		} as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand(`/login neoproxy ${origin}`, { ctx })).toBe(true);
		await pending;
		await Bun.sleep(0);
		expect(prompts.map(prompt => prompt.secret === true)).toEqual([true]);
		expect(ModelsConfigFile.relocate(configPath).load()?.providers?.neoproxy?.baseUrl).toBe(`${origin}/v1`);
		// The next plain login prompts for the URL again, defaulting to the configured one.
		await storage.oauth.login("neoproxy", callbacks(["", KEY_A]));
		expect(prompts[1]).toMatchObject({ placeholder: `${origin}/v1`, allowEmpty: true });
	});
});
