import { expect, test } from "bun:test";
import * as path from "node:path";
import { resolveImplicitEffort } from "@oh-my-pi/pi-coding-agent/config/effort-policy";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveCliModel, resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgModelVariants } from "@oh-my-pi/pi-coding-agent/config/model-variant-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { TempDir } from "@oh-my-pi/pi-utils";

const OPENAI_BASE = "openai/gpt-4o-mini";
const ANTHROPIC_BASE = "anthropic/claude-sonnet-4-5";

async function withRegistry(exercise: (settings: Settings, registry: ModelRegistry) => Promise<void>): Promise<void> {
	const directory = TempDir.createSync("@pi-model-variant-");
	const auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
	try {
		auth.keys.setRuntime("openai", "openai-key");
		auth.keys.setRuntime("anthropic", "anthropic-key");
		const settings = Settings.isolated();
		const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"), { settings });
		await exercise(settings, registry);
	} finally {
		auth.close();
		directory.removeSync();
	}
}

test("scope-owned Model Variants resolve in catalog, name selectors and roles; rename and rebase retain assignments", async () => {
	await withRegistry(async (settings, registry) => {
		const source = createModelBrowserSource(settings, undefined, "project", registry);
		await source.onSaveModelVariant?.({
			name: "Concise GPT",
			baseModel: OPENAI_BASE,
			overrides: { contextWindow: 64000, maxTokens: 2048, temperature: 0.2, "tier.openai": "flex" },
		});
		const definition = source.modelVariants?.[0];
		if (!definition) throw new Error("Expected project Model Variant");
		expect(settings.readScopeValue(cfgModelVariants, "global")).toBeUndefined();
		const id = definition.id;
		const assigned = `openai/${id}`;
		settings.setModelRole("smol", assigned);
		const named = resolveCliModel({ cliModel: "Concise GPT", modelRegistry: registry, settings }).model;
		expect(named).toMatchObject({
			id,
			provider: "openai",
			contextWindow: 64000,
			maxTokens: 2048,
			requestModelId: "gpt-4o-mini",
			variant: { request: { temperature: 0.2, serviceTier: "flex" } },
		});
		expect(registry.getProviderModels("openai").map(model => model.id)).toContain(id);
		expect(registry.getAvailableForProviders(new Set(["openai"])).map(model => model.id)).toContain(id);
		expect(resolveModelRoleValue("@smol", registry.getAvailable(), { settings }).model?.id).toBe(id);

		await source.onSaveModelVariant?.({
			id,
			name: "Careful Claude",
			baseModel: ANTHROPIC_BASE,
			overrides: { defaultThinkingLevel: "low", "effort.allowed": ["low"], "compaction.thresholdTokens": 12000 },
		});
		const rebased = registry.find("openai", id);
		if (!rebased) throw new Error("Old assignment must resolve after rebase");
		expect(rebased).toMatchObject({
			name: "Careful Claude",
			provider: "anthropic",
			requestModelId: "claude-sonnet-4-5",
		});
		expect(await registry.getApiKey(rebased)).toBe("anthropic-key");
		expect(resolveModelRoleValue("@smol", registry.getAvailable(), { settings }).model).toBe(rebased);
		expect(resolveImplicitEffort(settings, rebased)).toMatchObject({ level: "low", candidates: ["low"] });
		expect(resolveModelCompactionSettings(settings, rebased).thresholdTokens).toBe(12000);
		expect(rebased.variant?.request.temperature).toBeUndefined();

		await source.onDeleteModelVariant?.(id);
		expect(registry.find("openai", id)).toBeUndefined();
		expect(registry.getAvailable().some(model => model.id === id)).toBe(false);
		expect(registry.find("anthropic", "claude-sonnet-4-5")?.variant).toBeUndefined();
	});
});

test("Model Variant writes reject unsupported settings and variants as bases", async () => {
	await withRegistry(async (settings, registry) => {
		const source = createModelBrowserSource(settings, undefined, "global", registry);
		await expect(
			source.onSaveModelVariant!({ name: "Bad", baseModel: OPENAI_BASE, overrides: { unknown: true } }),
		).rejects.toThrow("cannot be overridden");
		await source.onSaveModelVariant?.({ name: "Real", baseModel: OPENAI_BASE, overrides: {} });
		const id = source.modelVariants?.[0]?.id;
		await expect(
			source.onSaveModelVariant!({ name: "Nested", baseModel: `openai/${id}`, overrides: {} }),
		).rejects.toThrow("ordinary base model");
		expect(source.modelVariants?.map(variant => variant.name)).toEqual(["Real"]);
	});
});

test("persisted variant settings retain their sparse dotted overrides across reload", async () => {
	const directory = TempDir.createSync("@pi-model-variant-persisted-");
	const options = { agentDir: directory.path(), cwd: directory.path() };
	const auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
	try {
		const settings = await Settings.loadIsolated(options);
		const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"), { settings });
		const source = createModelBrowserSource(settings, undefined, "global", registry);
		await source.onSaveModelVariant!({
			name: "Lowered",
			baseModel: OPENAI_BASE,
			overrides: { "tier.openai": "none", topP: -1, "thinkingBudgets.high": 500 },
		});
		const id = source.modelVariants?.[0]?.id;
		if (!id) throw new Error("Expected saved Model Variant ID");
		const loaded = await Settings.loadReadOnly(options);
		expect(cfgModelVariants.get(loaded)).toEqual([
			{
				id,
				name: "Lowered",
				baseModel: OPENAI_BASE,
				overrides: { "tier.openai": "none", topP: -1, "thinkingBudgets.high": 500 },
			},
		]);
	} finally {
		auth.close();
		directory.removeSync();
	}
});
