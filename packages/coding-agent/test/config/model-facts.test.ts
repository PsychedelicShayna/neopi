import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts, resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model, ModelCost } from "@oh-my-pi/pi-catalog/types";
import {
	applyModelFacts,
	cfgModelFactsEnabled,
	cfgModelFactsOverrides,
	cfgModelFactsSources,
	DEFAULT_MODEL_FACT_CONFIG,
	getModelFactConfig,
	resolveModelFacts,
	validateModelFactOverrides,
	validateModelFactSources,
	type ModelFactConfig,
	type ModelFactSourceSnapshot,
} from "@oh-my-pi/pi-coding-agent/config/model-facts";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const zeroCost: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const openrouterCost: ModelCost = { input: 1.6, output: 4.8, cacheRead: 0.4, cacheWrite: 0 };
const stencilCost: ModelCost = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };

function model(provider = "custom", id = "grok-4.7", facts: Partial<Model<Api>> = {}): Model<Api> {
	return {
		...buildModel({
			id,
			name: id,
			provider,
			api: "openai-completions",
			baseUrl: `https://${provider}.example/v1`,
			reasoning: false,
			input: ["text"],
			cost: zeroCost,
			contextWindow: null,
			maxTokens: null,
		}),
		reasoning: false,
		thinking: undefined,
		...facts,
	};
}

function sources(): ModelFactSourceSnapshot[] {
	return [
		{
			source: "openrouter",
			models: [model("openrouter", "x-ai/grok-4.7", { cost: openrouterCost, reasoning: true, input: [] })],
		},
		{
			source: "stencil",
			models: [
				model("xai", "grok-4.7", {
					cost: stencilCost,
					contextWindow: 500_000,
					maxTokens: 64_000,
					input: ["text", "image"],
					reasoning: true,
					thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
				}),
			],
		},
	];
}

function config(overrides: ModelFactConfig["overrides"] = {}): ModelFactConfig {
	return { enabled: true, sources: ["openrouter", "stencil"], overrides };
}

describe("model fact resolution", () => {
	it("fills each missing fact from its first source without a bundled catalog row", () => {
		const target = model("xai-oauth");
		const resolved = resolveModelFacts(target, sources());
		expect(resolved.model.cost).toEqual(openrouterCost);
		expect(resolved.model.contextWindow).toBe(500_000);
		expect(resolved.model.maxTokens).toBe(64_000);
		expect(resolved.model.input).toEqual(["text"]);
		expect(resolved.model.reasoning).toBe(true);
		expect(getSupportedEfforts(resolved.model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(resolved.provenance.cost).toEqual({
			kind: "source",
			source: "openrouter",
			provider: "openrouter",
			model: "x-ai/grok-4.7",
		});
		expect(resolved.provenance.efforts?.source).toBe("stencil");
		expect(resolved.provenance.input?.kind).toBe("provider");
		expect(target.cost).toEqual(zeroCost);
		expect(target.reasoning).toBe(false);
	});

	it("skips an unavailable first source represented by an empty snapshot", () => {
		const snapshots = sources();
		snapshots[0] = { source: "openrouter", models: [] };
		const resolved = resolveModelFacts(model("xai-oauth"), snapshots);
		expect(resolved.model.cost).toEqual(stencilCost);
		expect(resolved.model.contextWindow).toBe(500_000);
		expect(resolved.provenance.cost?.source).toBe("stencil");
	});

	it("keeps the provider row unchanged when every source is unavailable", () => {
		const target = model();
		expect(
			resolveModelFacts(target, [
				{ source: "openrouter", models: [] },
				{ source: "stencil", models: [] },
			]).model,
		).toBe(target);
	});

	it("uses configured ordering and accepts an extension-only source name", () => {
		const extension = model("nous-portal", "grok-4.7", { cost: { ...stencilCost, input: 0.8 } });
		const ordered = { ...config(), sources: ["nous-portal", "stencil", "openrouter"] };
		const [resolved] = applyModelFacts(
			[model()],
			[...sources(), { source: "nous-portal", models: [extension] }],
			ordered,
		);
		expect(resolved?.model.cost.input).toBe(0.8);
		expect(resolved?.provenance.cost?.source).toBe("nous-portal");
		expect(resolved?.model.contextWindow).toBe(500_000);
		const [reversed] = applyModelFacts([model()], sources(), { ...config(), sources: ["stencil", "openrouter"] });
		expect(reversed?.model.cost).toEqual(stencilCost);
	});

	it("preserves positive provider facts and upgrades false reasoning from a listed ladder", () => {
		const providerCost = { input: 3, output: 8, cacheRead: 0, cacheWrite: 0 };
		const target = model("xai-oauth", "grok-4.7", {
			cost: providerCost,
			contextWindow: 256_000,
			maxTokens: 32_000,
			input: ["image"],
		});
		const ladderOnly = model("xai", "grok-4.7", {
			reasoning: false,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		const resolved = resolveModelFacts(target, [{ source: "stencil", models: [ladderOnly] }]);
		expect(resolved.model.cost).toBe(providerCost);
		expect(resolved.model.contextWindow).toBe(256_000);
		expect(resolved.model.maxTokens).toBe(32_000);
		expect(resolved.model.input).toEqual(["image"]);
		expect(resolved.model.reasoning).toBe(true);
		expect(getSupportedEfforts(resolved.model)).toEqual([Effort.Low, Effort.High]);
		expect(resolved.provenance.reasoning).toEqual(resolved.provenance.efforts);
	});

	it("fills input placeholders only when discovery marks the field missing", () => {
		const target = model("custom", "grok-4.7", { discoveryMissingInput: true });
		const snapshots = sources();
		snapshots[0] = {
			source: "openrouter",
			models: [model("openrouter", "x-ai/grok-4.7", { discoveryMissingInput: true })],
		};
		const resolved = resolveModelFacts(target, snapshots);
		expect(resolved.model.input).toEqual(["text", "image"]);
		expect(resolved.provenance.input?.source).toBe("stencil");
		expect(resolved.model.discoveryMissingInput).toBeUndefined();
	});

	it("fills a zero placeholder rate card despite an existing subscription label", () => {
		const target = model("custom", "grok-4.7", { pricingStatus: "included" });
		const resolved = resolveModelFacts(target, sources());
		expect(resolved.model.cost).toBe(openrouterCost);
		expect(resolved.model.pricingStatus).toBeUndefined();
		expect(resolved.provenance.cost?.kind).toBe("source");
	});

	it("applies literal pins after source facts, including a reasoning false pin", () => {
		const pinnedCost = { ...zeroCost, input: 0.2, output: 0.5 };
		const resolved = resolveModelFacts(model(), sources(), {
			"custom/grok-4.7": { cost: pinnedCost, contextWindow: 99_000, reasoning: false, efforts: [] },
		});
		expect(resolved.model.cost).toBe(pinnedCost);
		expect(resolved.model.contextWindow).toBe(99_000);
		expect(resolved.model.reasoning).toBe(false);
		expect(getSupportedEfforts(resolved.model)).toEqual([]);
		expect(resolved.model.maxTokens).toBe(64_000);
		expect(resolved.provenance.cost).toEqual({ kind: "override" });
	});

	it("borrows only the named field from an exact provider/model reference", () => {
		const foreign = model("discount", "vendor/unrelated-model", {
			cost: stencilCost,
			contextWindow: 999_000,
			maxTokens: 12_000,
			input: ["image"],
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.High], effortRouting: { high: "foreign-wire-id" } },
		});
		const target = model();
		const resolved = resolveModelFacts(
			target,
			[],
			{
				"custom/grok-4.7": { cost: { from: "discount/vendor/unrelated-model" } },
			},
			[foreign],
		);
		expect(resolved.model.cost).toBe(foreign.cost);
		expect(resolved.model.contextWindow).toBeNull();
		expect(resolved.model.maxTokens).toBeNull();
		expect(resolved.model.reasoning).toBe(false);
		expect(resolved.model.thinking).toBeUndefined();
		expect(resolved.model.input).toEqual(["text"]);
		expect(resolved.model.api).toBe(target.api);
		expect(resolved.model.baseUrl).toBe(target.baseUrl);
		expect(resolved.provenance.cost).toEqual({
			kind: "reference",
			provider: "discount",
			model: "vendor/unrelated-model",
			source: undefined,
		});
	});

	it("borrows a field from a loaded provider that is not in the automatic chain", () => {
		const [resolved] = applyModelFacts([model()], sources(), {
			enabled: true,
			sources: [],
			overrides: { "custom/grok-4.7": { cost: { from: "openrouter/x-ai/grok-4.7" } } },
		});
		expect(resolved?.model.cost).toEqual(openrouterCost);
		expect(resolved?.model.contextWindow).toBeNull();
		expect(resolved?.provenance.cost?.source).toBe("openrouter");
	});

	it("reports an unavailable reference without substituting another model", () => {
		const target = model();
		const resolved = resolveModelFacts(target, [], { "custom/grok-4.7": { cost: { from: "missing/model" } } });
		expect(resolved.model).toBe(target);
		expect(resolved.issues).toEqual(["custom/grok-4.7.cost: model reference missing/model was not found"]);
	});

	it("keeps target wire routing when borrowing a foreign effort ladder", () => {
		const target = model("custom", "grok-4.7", {
			reasoning: true,
			thinking: {
				mode: "budget",
				efforts: [Effort.Low],
				effortRouting: { low: "target-wire-id" },
				unverified: true,
			},
		});
		const foreign = model("foreign", "other", {
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], effortRouting: { low: "foreign-wire-id" } },
		});
		const resolved = resolveModelFacts(
			target,
			[],
			{
				"custom/grok-4.7": { efforts: { from: "foreign/other" } },
			},
			[foreign],
		);
		expect(resolved.model.thinking?.mode).toBe("budget");
		expect(getSupportedEfforts(resolved.model)).toEqual([Effort.Low, Effort.High]);
		expect(resolved.model.thinking?.unverified).toBeUndefined();
		expect(resolveWireModelId(resolved.model, Effort.Low)).toBe("target-wire-id");
	});

	it("does not match opaque gateway suffixes, but permits an explicit identity map", () => {
		const target = model("gateway", "@tenant/grok-4.7");
		expect(resolveModelFacts(target, sources()).model).toBe(target);
		const resolved = resolveModelFacts(target, sources(), {}, [], {
			matches: { "gateway/@tenant/grok-4.7": "openrouter/x-ai/grok-4.7" },
		});
		expect(resolved.model.cost).toEqual(openrouterCost);
	});

	it("adds an absent model with the provider's transport and per-field overrides", () => {
		const [resolved] = applyModelFacts(
			[],
			sources(),
			config({
				"custom/new-model": {
					cost: { from: "openrouter/x-ai/grok-4.7" },
					contextWindow: 128_000,
					reasoning: true,
					efforts: [Effort.Low, Effort.High],
				},
			}),
			{ createModel: (provider, id) => model(provider, id) },
		);
		expect(resolved?.model.id).toBe("new-model");
		expect(resolved?.model.provider).toBe("custom");
		expect(resolved?.model.baseUrl).toBe("https://custom.example/v1");
		expect(resolved?.model.cost).toEqual(openrouterCost);
		expect(resolved?.model.contextWindow).toBe(128_000);
		expect(resolved?.model.maxTokens).toBeNull();
		expect(resolved && getSupportedEfforts(resolved.model)).toEqual([Effort.Low, Effort.High]);
	});

	it("fills missing input on an override-only row without a separate missing-field map", () => {
		const [resolved] = applyModelFacts([], sources(), config({ "custom/grok-4.7": {} }), {
			createModel: (provider, id) => model(provider, id, { discoveryMissingInput: true }),
		});
		expect(resolved?.model.input).toEqual(["text", "image"]);
		expect(resolved?.model.discoveryMissingInput).toBeUndefined();
		expect(resolved?.provenance.input?.source).toBe("stencil");
	});

	it("does not resolve fields or add models when the feature is disabled", () => {
		const target = model();
		let created = false;
		const resolved = applyModelFacts(
			[target],
			sources(),
			{
				...config({ "custom/absent": { contextWindow: 1000 } }),
				enabled: false,
			},
			{
				createModel: () => {
					created = true;
					return model();
				},
			},
		);
		expect(resolved.map(entry => entry.model)).toEqual([target]);
		expect(resolved[0]?.model).toBe(target);
		expect(created).toBe(false);
	});
});

describe("model fact setting validation", () => {
	it("rejects malformed source chains and unsupported per-field values", () => {
		for (const value of [null, "stencil", [""], ["stencil", "stencil"], [" stencil"]]) {
			expect(() => validateModelFactSources(value)).toThrow("Invalid model facts");
		}
		for (const value of [
			null,
			{ model: {} },
			{ "provider/model": { typo: true } },
			{ "provider/model": { reasoning: "yes" } },
			{ "provider/model": { contextWindow: -1 } },
			{ "provider/model": { maxTokens: 1.5 } },
			{ "provider/model": { input: [] } },
			{ "provider/model": { efforts: ["high", "low"] } },
			{ "provider/model": { efforts: ["automatic"] } },
			{ "provider/model": { cost: { ...zeroCost, input: Number.NaN } } },
			{ "provider/model": { cost: { ...zeroCost, output: -1 } } },
			{ "provider/model": { cost: { from: "not-qualified" } } },
			{ "provider/model": { cost: { from: "provider/other", input: 1 } } },
		])
			expect(() => validateModelFactOverrides(value)).toThrow("Invalid model facts");
	});

	it("accepts an empty chain, add-only model, full rate card and exact references", () => {
		expect(() => validateModelFactSources([])).not.toThrow();
		expect(() =>
			validateModelFactOverrides({
				"provider/model": {},
				"provider/vendor/model": {
					cost: { ...openrouterCost, longContext: { ...stencilCost, inputThreshold: 200_000 } },
					contextWindow: null,
					maxTokens: 1000,
					input: ["text", "image"],
					reasoning: false,
					efforts: { from: "source/vendor/model" },
				},
			}),
		).not.toThrow();
	});
});

describe("model fact settings initialization", () => {
	let state: SettingsTestState | undefined;
	let temp: TempDir;
	let warningSpy: { mockRestore(): void } | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		temp = await TempDir.create(path.join(scratch, "model-facts-test-"));
		await fs.mkdir(temp.join("project"));
	});

	afterEach(async () => {
		warningSpy?.mockRestore();
		warningSpy = undefined;
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		await temp.remove();
	});

	it("loads a real empty configuration with the feature absent and disabled", async () => {
		const settings = await Settings.init({ cwd: temp.join("project"), agentDir: temp.join("agent") });
		expect(getModelFactConfig(settings)).toEqual(DEFAULT_MODEL_FACT_CONFIG);
		expect(cfgModelFactsEnabled.isConfigured(settings)).toBe(false);
		const target = model();
		expect(applyModelFacts([target], sources(), getModelFactConfig(settings))[0]?.model).toBe(target);
	});

	it("loads a replaceable extension chain and typed override record", async () => {
		await Bun.write(
			temp.join("agent", "config.yml"),
			YAML.stringify({
				modelFacts: {
					enabled: true,
					sources: ["nous-portal"],
					overrides: {
						"custom/new-model": { cost: { from: "nous-portal/grok-4.7" }, contextWindow: 500_000 },
					},
				},
			}),
		);
		const settings = await Settings.init({ cwd: temp.join("project"), agentDir: temp.join("agent") });
		expect(cfgModelFactsSources.get(settings)).toEqual(["nous-portal"]);
		expect(cfgModelFactsOverrides.get(settings)["custom/new-model"]?.contextWindow).toBe(500_000);
		expect(cfgModelFactsEnabled.get(settings)).toBe(true);
	});

	for (const enabled of [false, true]) {
		it(`loads invalid persisted fields with warnings when model facts are ${enabled ? "enabled" : "disabled"}`, async () => {
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			warningSpy = warn;
			await Bun.write(
				temp.join("agent", "config.yml"),
				YAML.stringify({
					modelFacts: {
						enabled,
						sources: ["openrouter", 12, "stencil"],
						overrides: {
							"custom/grok-4.7": { contextWindow: "nope", maxTokens: 2048, reasoning: "yes" },
							"custom/other": { contextWindow: 8192 },
						},
					},
				}),
			);
			const settings = await Settings.init({ cwd: temp.join("project"), agentDir: temp.join("agent") });
			const parsed = getModelFactConfig(settings);
			expect(parsed.enabled).toBe(enabled);
			expect(parsed.sources).toEqual(["openrouter", "stencil"]);
			expect(parsed.overrides).toEqual({
				"custom/grok-4.7": { maxTokens: 2048 },
				"custom/other": { contextWindow: 8192 },
			});
			const target = model("custom", "grok-4.7", { contextWindow: 4096 });
			const [resolved] = applyModelFacts([target], [], parsed);
			expect(resolved?.model.contextWindow).toBe(4096);
			expect(resolved?.model.maxTokens).toBe(enabled ? 2048 : null);
			expect(resolved?.issues).toContain(
				"Invalid model facts: custom/grok-4.7.contextWindow must be a positive integer or null",
			);
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid model fact", {
				issue: "Invalid model facts: custom/grok-4.7.contextWindow must be a positive integer or null",
			});
		});
	}

	it("loads malformed fact containers and enable flags without preventing startup", async () => {
		warningSpy = spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(
			temp.join("agent", "config.yml"),
			YAML.stringify({ modelFacts: { enabled: "yes", sources: "stencil", overrides: [] } }),
		);
		const settings = await Settings.init({ cwd: temp.join("project"), agentDir: temp.join("agent") });
		const parsed = getModelFactConfig(settings);
		expect(parsed.enabled).toBe(false);
		expect(parsed.sources).toEqual(["openrouter", "stencil"]);
		expect(parsed.overrides).toEqual({});
		expect(parsed.issues).toBeUndefined();
		const configPath = temp.join("agent", "config.yml");
		expect(settings.startupWarnings).toEqual([
			`Settings: ${configPath}: modelFacts.enabled: expected a boolean; using the default`,
			`Settings: ${configPath}: modelFacts.sources: expected a array; using the default`,
			`Settings: ${configPath}: modelFacts.overrides: expected a record; using the default`,
		]);
	});

	it("rejects invalid editor writes before changing the effective override record", () => {
		const settings = Settings.isolated();
		expect(() =>
			cfgModelFactsOverrides.set(settings, cfgModelFactsOverrides.parse('{"custom/model":{"contextWindow":-1}}')),
		).toThrow("Invalid model facts");
		expect(cfgModelFactsOverrides.get(settings)).toEqual({});
	});
});
