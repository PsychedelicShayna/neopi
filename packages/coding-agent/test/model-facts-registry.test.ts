import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Api, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyChatCompletionsCompatPolicy, resolveOpenAICompatPolicy } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { cfgModelFactsEnabled, cfgModelFactsSources, cfgModelFactsOverrides } from "../src/config/model-facts";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { cfgModelRoles } from "../src/config/model-settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { AuthStorage } from "../src/session/auth-storage";

const neutral: ModelSpec<Api> = {
	id: "fresh-model",
	name: "Fresh model",
	provider: "fact-target",
	api: "openai-completions",
	baseUrl: "https://target.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: null,
	maxTokens: null,
};

function reasoningRequest(model: Model<Api>) {
	const params: Parameters<typeof applyChatCompletionsCompatPolicy>[0] = {
		model: model.id,
		messages: [],
		stream: true,
	};
	applyChatCompletionsCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, { endpoint: "chat-completions", reasoning: Effort.High }),
	);
	return params;
}

describe("registry model fact projection", () => {
	let dir: string;
	let auth: AuthStorage;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-facts-"));
		auth = await AuthStorage.create(":memory:");
		await Bun.write(
			path.join(dir, "models.toml"),
			stringifySettingsToml({
				providers: {
					"fact-target": {
						api: "openai-completions",
						baseUrl: neutral.baseUrl,
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
	});
	afterEach(async () => {
		auth.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	function createRegistry(enabled = true, reported: Record<string, unknown> = {}) {
		const requests: string[] = [];
		const scope = Settings.isolated();
		cfgModelFactsEnabled.set(scope, enabled);
		cfgModelFactsSources.set(scope, ["fact-source"]);
		const registry = new ModelRegistry(auth, path.join(dir, "models.toml"), {
			settings: scope,
			fetch: async input => {
				requests.push(String(input));
				if (String(input).startsWith(`${neutral.baseUrl}/models`))
					return Response.json({ data: [{ id: neutral.id, ...reported }] });
				throw new Error("unexpected network");
			},
		});
		registry.registerProvider("fact-source", {
			api: "openai-completions",
			baseUrl: "https://source.example/v1",
			auth: "none",
			fetchDynamicModels: async () => [
				{
					...neutral,
					provider: "fact-source",
					input: ["text", "image"],
					contextWindow: 500_000,
					maxTokens: 32_000,
					cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
					reasoning: true,
					thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
				},
			],
		});
		return { registry, scope, requests };
	}

	test("uses extension provider facts and exposes their field provenance", async () => {
		const { registry } = createRegistry();
		await registry.refreshProvider("fact-target", "online");
		const model = registry.find("fact-target", neutral.id);
		expect(model?.contextWindow).toBe(500_000);
		expect(model?.maxTokens).toBe(32_000);
		expect(model?.cost.input).toBe(2);
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(registry.getModelFactResolution("fact-target", neutral.id)?.provenance.contextWindow).toMatchObject({
			kind: "source",
			source: "fact-source",
		});
		if (!model) throw new Error("target model missing");
		expect(reasoningRequest(model).reasoning_effort).toBe("high");
	});

	test("disabled feature preserves provider facts despite configured sources and overrides", async () => {
		const { registry, scope } = createRegistry(false);
		cfgModelFactsOverrides.set(scope, { "fact-target/fresh-model": { contextWindow: 123_000 } });
		await registry.refreshProvider("fact-target", "online");
		expect(registry.find("fact-target", neutral.id)?.contextWindow).toBe(128_000);
		expect(registry.find("fact-target", neutral.id)?.reasoning).toBe(false);
		const model = registry.find("fact-target", neutral.id);
		if (!model) throw new Error("target model missing");
		expect(reasoningRequest(model).reasoning_effort).toBeUndefined();
	});

	for (const reasoning of [false, true]) {
		test(`preserves paired nightly compat snapshots without resolved facts, reasoning ${reasoning}`, async () => {
			const id = "unknown-hunt-model";
			await Bun.write(
				path.join(dir, "models.toml"),
				stringifySettingsToml({
					providers: {
						"hunt-neutral": {
							api: "openai-completions",
							baseUrl: "https://neutral.invalid/v1",
							auth: "none",
							discovery: { type: "openai-models-list" },
							...(reasoning ? { modelOverrides: { [id]: { reasoning: true } } } : {}),
						},
					},
				}),
			);
			// c7f0c532e4's generic discovery supplies these sparse compat defaults.
			const baseline = buildModel({
				...neutral,
				id,
				provider: "hunt-neutral",
				baseUrl: "https://neutral.invalid/v1",
				reasoning,
				compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
			});
			const snapshot = (model: Model<Api>): string =>
				JSON.stringify({ compatConfig: model.compatConfig, compat: model.compat });
			for (const enabled of [false, true]) {
				const scope = Settings.isolated();
				cfgModelFactsEnabled.set(scope, enabled);
				cfgModelFactsSources.set(scope, []);
				const registry = new ModelRegistry(auth, path.join(dir, "models.toml"), {
					settings: scope,
					fetch: async () => Response.json({ data: [{ id }] }),
				});
				await registry.refreshProvider("hunt-neutral", "online");
				const discovered = registry.find("hunt-neutral", id);
				if (!discovered) throw new Error("discovered hunt model missing");
				expect(snapshot(discovered)).toBe(snapshot(baseline));
				expect(reasoningRequest(discovered)).toEqual({ model: id, messages: [], stream: true });
				if (!enabled) {
					expect(discovered).not.toHaveProperty("discoveryMissingInput");
					expect(discovered).not.toHaveProperty("discoveryMissingContextWindow");
					expect(discovered).not.toHaveProperty("discoveryMissingMaxTokens");
					expect(discovered).not.toHaveProperty("discoveryMissingReasoningEffort");
				}
			}
		});
	}

	for (const level of ["provider", "model"]) {
		test(`preserves the operator's ${level}-level effort policy when source facts resolve`, async () => {
			const compat = { supportsReasoningEffort: false };
			await Bun.write(
				path.join(dir, "models.toml"),
				stringifySettingsToml({
					providers: {
						"fact-target": {
							api: "openai-completions",
							baseUrl: neutral.baseUrl,
							auth: "none",
							discovery: { type: "openai-models-list" },
							...(level === "provider" ? { compat } : { modelOverrides: { [neutral.id]: { compat } } }),
						},
					},
				}),
			);
			const { registry } = createRegistry();
			await registry.refreshProvider("fact-target", "online");
			const resolved = registry.find("fact-target", neutral.id);
			if (!resolved) throw new Error("fact target missing");
			expect(resolved.contextWindow).toBe(500_000);
			expect(resolved.thinking?.efforts).toContain(Effort.High);
			expect(reasoningRequest(resolved).reasoning_effort).toBeUndefined();
		});
	}

	test("enabling fact resolution refreshes pre-feature discovery defaults without invalidating the disabled cache", async () => {
		const { registry, scope, requests } = createRegistry(false);
		await registry.refreshProvider("fact-target", "online");
		const before = requests.filter(url => url.startsWith(`${neutral.baseUrl}/models`)).length;
		cfgModelFactsEnabled.set(scope, true);
		await registry.refreshProvider("fact-target", "online-if-uncached");
		expect(requests.filter(url => url.startsWith(`${neutral.baseUrl}/models`))).toHaveLength(before + 1);
		expect(registry.find("fact-target", neutral.id)?.contextWindow).toBe(500_000);
		cfgModelFactsEnabled.set(scope, false);
		await registry.refreshProvider("fact-target", "offline");
		expect(requests.filter(url => url.startsWith(`${neutral.baseUrl}/models`))).toHaveLength(before + 1);
		expect(registry.find("fact-target", neutral.id)?.contextWindow).toBe(128_000);
	});

	test("keeps a reported provider window while filling other missing facts", async () => {
		const { registry } = createRegistry(true, { context_length: 64_000 });
		await registry.refreshProvider("fact-target", "online");
		const model = registry.find("fact-target", neutral.id);
		expect(model?.contextWindow).toBe(64_000);
		expect(model?.cost.input).toBe(2);
		expect(registry.getModelFactResolution("fact-target", neutral.id)?.provenance.contextWindow?.kind).toBe(
			"provider",
		);
	});

	test("preserves existing models.toml fact pins instead of treating them as discovery placeholders", async () => {
		await Bun.write(
			path.join(dir, "models.toml"),
			stringifySettingsToml({
				providers: {
					"fact-target": {
						api: "openai-completions",
						baseUrl: neutral.baseUrl,
						auth: "none",
						discovery: { type: "openai-models-list" },
						modelOverrides: { [neutral.id]: { contextWindow: 64_000, maxTokens: 4096, input: ["text"] } },
					},
				},
			}),
		);
		const { registry } = createRegistry();
		await registry.refreshProvider("fact-target", "online");
		const model = registry.find("fact-target", neutral.id);
		expect(model?.contextWindow).toBe(64_000);
		expect(model?.maxTokens).toBe(4096);
		expect(model?.input).toEqual(["text"]);
		expect(model?.cost.input).toBe(2);
	});

	test("creates an absent model with target transport and updates overrides offline", async () => {
		const { registry, scope } = createRegistry();
		cfgModelFactsOverrides.set(scope, { "fact-target/unlisted": { contextWindow: 96_000, maxTokens: 4096 } });
		await registry.reapplyModelPolicies();
		const added = registry.find("fact-target", "unlisted");
		expect(added?.contextWindow).toBe(96_000);
		expect(added?.baseUrl).toBe(neutral.baseUrl);
		expect(added?.api).toBe("openai-completions");
		cfgModelFactsOverrides.set(scope, { "fact-target/unlisted": { contextWindow: 128_000 } });
		await registry.reapplyModelPolicies();
		expect(registry.find("fact-target", "unlisted")?.contextWindow).toBe(128_000);
	});

	test("refreshing fact settings rebinds active metadata without authoring a model role", async () => {
		const { registry, scope } = createRegistry();
		const model = buildModel(neutral);
		const roles = structuredClone(cfgModelRoles.get(scope));
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.Medium },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: scope,
			modelRegistry: registry,
		});
		try {
			await session.refreshModelFacts();
			expect(session.model?.contextWindow).toBe(500_000);
			expect(session.model?.cost.input).toBe(2);
			expect(session.model?.reasoning).toBe(true);
			expect(cfgModelRoles.get(scope)).toEqual(roles);
		} finally {
			await session.dispose();
		}
	});
});
