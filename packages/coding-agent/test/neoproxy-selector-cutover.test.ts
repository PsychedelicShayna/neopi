import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { streamSimple, type Api, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	formatModelString,
	resolveCliModel,
	resolveModelFromString,
	resolveModelRoleValue,
	resolveProviderModelReference,
	resolveSessionModelSelector,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let dir: TempDir;
let storage: AuthStorage;
let server: Bun.Server<undefined>;
let registry: ModelRegistry;
let configPath: string;
let origin: string;
let offline = true;
let inference: string[];
const legacy = "neoproxy/neoproxy/office-cheap:high";
const ids = ["neoproxy/office-cheap", "neoproxy/office-cheap-sibling"];
const transport: FetchImpl = async (input, init) => {
	if (offline) throw new TypeError("isolated proxy offline");
	if (new URL(String(input)).origin !== origin) throw new Error("unexpected non-fixture request");
	return fetch(input, init);
};
function cached(id: string): Model<Api> {
	return buildModel({
		provider: "neoproxy",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `${origin}/v1`,
		reasoning: true,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}
beforeEach(async () => {
	dir = await TempDir.create("@neoproxy-selector-cutover-");
	offline = true;
	inference = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.headers.get("authorization") !== "Bearer fake-upgrade-key")
				return new Response(null, { status: 401 });
			if (new URL(request.url).pathname === "/v1/models")
				return Response.json({
					data: ids.map(id => ({
						id,
						supported_endpoint_types: ["openai"],
						supported_reasoning_levels: ["low", "high"],
						default_reasoning_level: "high",
					})),
				});
			const body = (await request.json()) as { model: string };
			inference.push(body.model);
			return new Response(
				`data: ${JSON.stringify({ id: "cutover", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "unchanged wire id" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
	configPath = dir.join("models.yml");
	await Bun.write(
		configPath,
		JSON.stringify({
			providers: { neoproxy: { baseUrl: origin, api: "openai-completions", discovery: { type: "proxy" } } },
		}),
	);
	storage = await AuthStorage.create(dir.join("auth.db"));
	await storage.credentials.set("neoproxy", { type: "api_key", key: "fake-upgrade-key", requestOrigin: origin });
	writeModelCache("neoproxy:proxy-v2-context-v6", Date.now(), ids.map(cached), true, "", dir.join("models.db"));
	registry = new ModelRegistry(storage, configPath, { fetch: transport });
});
afterEach(async () => {
	server.stop(true);
	storage.close();
	await dir.remove();
});
async function upgrade(): Promise<void> {
	expect(resolveSessionModelSelector(registry, legacy)?.model).toBeDefined();
	offline = false;
	await registry.refreshProvider("neoproxy", "online");
	registry = new ModelRegistry(storage, configPath, { fetch: transport });
}

test("legacy cached proxy ids become canonical offline without changing the advertised wire id", async () => {
	const restored = resolveSessionModelSelector(registry, legacy);
	expect(restored?.model.id).toBe("office-cheap");
	expect(restored?.model.requestModelId).toBe("neoproxy/office-cheap");
	expect(restored?.thinkingLevel).toBe(ThinkingLevel.High);
	expect(formatModelString(restored!.model)).toBe("neoproxy/office-cheap");
});

test("successful refresh preserves saved global/project roles, list selectors and CLI references", async () => {
	await upgrade();
	const cwd = dir.join("project");
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(
		dir.join("profile/config.yml"),
		JSON.stringify({
			modelRoles: { default: legacy, smol: `neoproxy/missing,${legacy}` },
			retry: { fallbackChains: { default: [legacy] } },
		}),
	);
	await Bun.write(
		`${getProjectAgentDir(cwd)}/config.yml`,
		JSON.stringify({ modelRoles: { default: legacy, slow: legacy } }),
	);
	for (const project of [cwd, dir.path()]) {
		const settings = await Settings.loadReadOnly({ cwd: project, agentDir: dir.join("profile") });
		for (const role of ["default", "smol"]) {
			const selected = resolveCliModel({ cliModel: `@${role}`, modelRegistry: registry, settings });
			expect(selected.error).toBeUndefined();
			expect(selected.model?.id).toBe("office-cheap");
			expect(selected.thinkingLevel).toBe(ThinkingLevel.High);
			expect(selected.selector).toBe("neoproxy/office-cheap");
		}
		expect(
			resolveModelRoleValue(settings.getModelRole("default"), registry.getProviderModels("neoproxy"), { settings })
				.model?.id,
		).toBe("office-cheap");
		const fallback = cfgRetryFallbackChains.get(settings).default[0];
		const restoredFallback = resolveSessionModelSelector(registry, fallback);
		expect(restoredFallback?.model.id).toBe("office-cheap");
		expect(restoredFallback?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(settings.getModelRole("smol")).toBe(`neoproxy/missing,${legacy}`);
	}
	const selected = resolveModelFromString(legacy, registry.getProviderModels("neoproxy"));
	expect(selected?.id).toBe("office-cheap");
	const result = await streamSimple(
		selected!,
		{ messages: [{ role: "user", content: "upgrade", timestamp: 0 }] },
		{ apiKey: registry.resolver(selected!), fetch: transport },
	).result();
	expect(result.stopReason).toBe("stop");
	expect(inference).toEqual(["neoproxy/office-cheap"]);
});

for (const mode of ["headless", "fallback-disabled", "retry-disabled"] as const) {
	test(`legacy session entries restore after refresh in ${mode} mode`, async () => {
		await upgrade();
		const timestamp = "2026-11-01T00:00:00.000Z";
		const file = dir.join(`${mode}.jsonl`);
		await Bun.write(
			file,
			[
				{ type: "session", version: 3, id: `upgrade-${mode}`, timestamp, cwd: dir.path() },
				{ type: "model_change", id: "old-default", parentId: null, timestamp, model: legacy, role: "default" },
				{ type: "model_change", id: "old-smol", parentId: "old-default", timestamp, model: legacy, role: "smol" },
			]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const sessionManager = await SessionManager.open(file, dir.join("sessions"));
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: storage,
			modelRegistry: registry,
			sessionManager,
			settings: Settings.isolated({
				modelRoles: { default: legacy, smol: legacy },
				retry: { modelFallback: false },
			}),
			hasUI: mode !== "headless",
			allowSessionModelFallback: mode !== "fallback-disabled",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});
		try {
			expect(session.model?.id).toBe("office-cheap");
			expect(session.model?.requestModelId).toBe("neoproxy/office-cheap");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
}

test("legacy mapping requires exact wire identity and never selects a sibling or unrelated provider", async () => {
	await upgrade();
	expect(registry.find("neoproxy", "neoproxy/office")).toBeUndefined();
	expect(registry.find("neoproxy", "neoproxy/office-cheap:unknown")).toBeUndefined();
	const models = registry.getProviderModels("neoproxy");
	const target = models.find(model => model.id === "office-cheap")!;
	expect(
		resolveProviderModelReference("other", "neoproxy/office-cheap", [{ ...target, provider: "other" }]),
	).toBeUndefined();
	expect(
		resolveProviderModelReference("neoproxy", "neoproxy/office-cheap", [{ ...target, requestModelId: undefined }]),
	).toBeUndefined();
	expect(resolveProviderModelReference("neoproxy", "neoproxy/office-cheap", [target, { ...target }])).toBeUndefined();
});
