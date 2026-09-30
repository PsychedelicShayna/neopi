import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ModelKind } from "@oh-my-pi/pi-catalog/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
	validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function createContext(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string> = {},
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("google", "gemini-2.5-flash"),
		getBundledModel("google-vertex", "gemini-2.5-flash"),
		getBundledModel("openrouter", "google/gemini-2.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
			getAll: () => models,
		},
	};
}

describe("retry fallback selector resolution", () => {
	it("resolves chain keys by exact model, longest wildcard, role, then default", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const exactContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
				[selector]: ["google/gemini-2.5-flash"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(exactContext, selector, undefined, "task")).toBe(selector);

		const wildcardContext = createContext(
			{
				default: ["openai/gpt-4o-mini"],
				task: ["google/gemini-2.5-flash"],
				"openrouter/*": ["openai/gpt-4o-mini"],
				"openrouter/google/*": ["google-vertex/*"],
			},
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(wildcardContext, selector, undefined, "task")).toBe("openrouter/google/*");

		const roleContext = createContext(
			{ default: ["openai/gpt-4o-mini"], task: ["google/gemini-2.5-flash"] },
			{ task: selector },
		);
		expect(resolveRetryFallbackChainKey(roleContext, selector, undefined, "task")).toBe("task");

		const defaultContext = createContext({ default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(defaultContext, selector)).toBe("default");
	});

	it("preserves literal and longest-wildcard behavior when regex keys are absent", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({
			"openrouter/*": ["openai/gpt-4o-mini"],
			"openrouter/google/*": ["google-vertex/*"],
			"openai/gpt-4o-mini": ["google/gemini-2.5-flash"],
		});
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("openrouter/google/*");
		expect(findRetryFallbackCandidates(context, "openrouter/google/*", selector).map(item => item.raw)).toEqual([
			"google-vertex/gemini-2.5-flash",
		]);
		expect(resolveRetryFallbackChainKey(context, "openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
	});

	it("selects regex keys after exact keys and before wildcards, including effort suffixes", () => {
		const selector = "openrouter/google/gemini-2.5-flash:high";
		const first = "re:^openrouter/google/gemini-2\\.5-flash:high$";
		const second = "re:^openrouter/.*:high$";
		const context = createContext({
			"openrouter/google/*": ["google-vertex/*"],
			[first]: ["openai/gpt-4o-mini"],
			[second]: ["google/gemini-2.5-flash"],
			task: ["google-vertex/*"],
		}, { task: selector });
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "task")).toBe(first);
		expect(findRetryFallbackCandidates(context, first, selector).map(item => item.raw)).toEqual(["openai/gpt-4o-mini"]);
		expect(resolveRetryFallbackChainKey(createContext({ ...context.chains, [selector]: [] }), selector)).toBe(selector);
		expect(resolveRetryFallbackChainKey(context, "openrouter/google/gemini-2.5-flash:low")).toBe("openrouter/google/*");
	});

	it("resolves regex entries against the catalog, retaining glob entries", () => {
		const context = createContext({
			default: ["re:^(google|google-vertex)/gemini-2\\.5-flash$", "openrouter/google/*"],
		});
		expect(findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini").map(item => item.raw)).toEqual([
			"google/gemini-2.5-flash",
			"openrouter/google/gpt-4o-mini",
		]);
	});

	it("ignores invalid regex keys and entries without throwing", () => {
		const context = createContext({
			"re:(": ["openai/gpt-4o-mini"],
			"openrouter/*": ["re:(", "google/gemini-2.5-flash"],
		});
		expect(resolveRetryFallbackChainKey(context, "openrouter/google/gemini-2.5-flash")).toBe("openrouter/*");
		expect(findRetryFallbackCandidates(context, "openrouter/*", "openrouter/google/gemini-2.5-flash").map(item => item.raw)).toEqual([
			"google/gemini-2.5-flash",
		]);
	});

	it("does not let a later shared-assignment role steal the default chain", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				vision: ["openai/gpt-4o-mini"],
				default: ["google/gemini-2.5-flash"],
			},
			{ default: selector, vision: selector },
		);
		expect(resolveRetryFallbackChainKey(context, selector)).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "default")).toBe("default");
		expect(resolveRetryFallbackChainKey(context, selector, undefined, "vision")).toBe("vision");
	});

	it("uses a hinted role chain when its unqualified primary cannot resolve", () => {
		const context = createContext({ task: ["openai/gpt-4o-mini"] });
		const chainKey = resolveRetryFallbackChainKey(context, "missing-model:high", undefined, "task");
		expect(chainKey).toBe("task");
		if (!chainKey) throw new Error("Expected hinted role fallback chain");
		expect(
			findRetryFallbackCandidates(context, chainKey, "missing-model:high", undefined, {
				allowMissingPrimary: true,
			}),
		).toEqual([
			{
				raw: "openai/gpt-4o-mini",
				provider: "openai",
				id: "gpt-4o-mini",
				thinkingLevel: undefined,
			},
		]);
	});

	it("stops a role chain when its primary assignment is removed at runtime", () => {
		const context = createContext({
			slow: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
		});
		expect(findRetryFallbackCandidates(context, "slow", "google/gemini-2.5-flash")).toEqual([]);
	});

	it("expands wildcard candidates from the current selector", () => {
		const selector = "openrouter/google/gemini-2.5-flash";
		const context = createContext({ "openrouter/google/*": ["google-vertex/*"] });
		const candidates = findRetryFallbackCandidates(context, "openrouter/google/*", selector);
		expect(candidates).toEqual([
			{
				raw: "google-vertex/gemini-2.5-flash",
				provider: "google-vertex",
				id: "gemini-2.5-flash",
				thinkingLevel: undefined,
			},
		]);
	});

	it("carries per-entry thinking levels while bare entries inherit", () => {
		const context = createContext({ default: ["openai/gpt-4o-mini:low", "google/gemini-2.5-flash"] });
		const candidates = findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini");
		expect(candidates.map(candidate => candidate.raw)).toEqual(["openai/gpt-4o-mini:low", "google/gemini-2.5-flash"]);
		expect(candidates[0]?.thinkingLevel).toBe(ThinkingLevel.Low);
		// Bare entries carry no level so the failing turn's effort applies at switch time.
		expect(candidates[1]?.thinkingLevel).toBeUndefined();
	});

	it("inherits the default chain only for chat roles and preserves explicit empty kind chains", () => {
		const defaultChain = ["openai/gpt-4o-mini"];
		const expanded = expandDefaultRetryFallbackChains(
			{ default: defaultChain, slow: ["google/gemini-2.5-flash"], judge: [] },
			["default", "task", "slow", "judge", "image", "web"],
		);
		expect(expanded.task).toBe(defaultChain);
		expect(expanded.slow).toEqual(["google/gemini-2.5-flash"]);
		expect(expanded.judge).toEqual([]);
		expect(expanded.image).toBeUndefined();
		expect(expanded.web).toBeUndefined();
	});

	it("prefers an exact model+effort key over a different-effort key regardless of object order", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const low = "google/gemini-2.5-flash:low";
		const max = "google/gemini-2.5-flash:max";

		const maxFirst = createContext({ [max]: ["openai/gpt-4o-mini:max"], [low]: ["openai/gpt-4o-mini:low"] });
		expect(resolveRetryFallbackChainKey(maxFirst, low, model)).toBe(low);
		expect(findRetryFallbackCandidates(maxFirst, low, low, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini:low",
		]);

		const lowFirst = createContext({ [low]: ["openai/gpt-4o-mini:low"], [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(lowFirst, low, model)).toBe(low);
	});

	it("lets a suffixless key match any effort but an exact effort key still wins", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const low = "google/gemini-2.5-flash:low";
		const suffixless = "google/gemini-2.5-flash";

		const baseOnly = createContext({ [suffixless]: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(baseOnly, low, model)).toBe(suffixless);

		const suffixlessFirst = createContext({
			[suffixless]: ["openai/gpt-4o-mini"],
			[low]: ["openai/gpt-4o-mini:low"],
		});
		expect(resolveRetryFallbackChainKey(suffixlessFirst, low, model)).toBe(low);
	});

	it("never escalates to a different-effort chain when no matching effort is configured", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const low = "google/gemini-2.5-flash:low";
		const max = "google/gemini-2.5-flash:max";

		const maxOnly = createContext({ [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, low, model)).toBeUndefined();

		const maxWithDefault = createContext({ [max]: ["openai/gpt-4o-mini:max"], default: ["openai/gpt-4o-mini"] });
		expect(resolveRetryFallbackChainKey(maxWithDefault, low, model)).toBe("default");

		const maxWithHint = createContext({ [max]: ["openai/gpt-4o-mini:max"], smol: ["openai/gpt-4o-mini:medium"] });
		expect(resolveRetryFallbackChainKey(maxWithHint, low, model, "smol")).toBe("smol");
	});

	it("treats effort aliases as equivalent to their canonical form when matching keys", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const canonicalHigh = "google/gemini-2.5-flash:high";
		const aliasKey = "google/gemini-2.5-flash:hi";

		const context = createContext({ [aliasKey]: ["openai/gpt-4o-mini:high"] });
		expect(resolveRetryFallbackChainKey(context, canonicalHigh, model)).toBe(aliasKey);
		expect(
			findRetryFallbackCandidates(context, aliasKey, canonicalHigh, model).map(candidate => candidate.raw),
		).toEqual(["openai/gpt-4o-mini:high"]);
	});

	it("matches a requested effort key to the active model's clamped effort", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");
		const high = "google/gemini-2.5-flash:high";
		const max = "google/gemini-2.5-flash:max";

		const maxOnly = createContext({ [max]: ["openai/gpt-4o-mini:max"] });
		expect(resolveRetryFallbackChainKey(maxOnly, high, model)).toBe(max);
		expect(findRetryFallbackCandidates(maxOnly, max, high, model).map(candidate => candidate.raw)).toEqual([
			"openai/gpt-4o-mini:max",
		]);

		const exactHigh = createContext({
			[max]: ["openai/gpt-4o-mini:max"],
			[high]: ["openai/gpt-4o-mini:high"],
		});
		expect(resolveRetryFallbackChainKey(exactHigh, high, model)).toBe(high);
	});

	it("uses the default chain when the live model matches no role primary (#12421)", () => {
		const live = "openrouter/google/gemini-2.5-flash";
		const context = createContext(
			{
				default: ["openai/gpt-4o-mini", "google/gemini-2.5-flash"],
				slow: ["openai/gpt-4o-mini"],
			},
			{ default: "google/gemini-2.5-flash", slow: "openai/gpt-4o-mini" },
		);
		expect(resolveRetryFallbackChainKey(context, live)).toBe("default");
		// The effective chain leads with `default`'s primary, then the configured entries.
		expect(findRetryFallbackCandidates(context, "default", live).map(candidate => candidate.raw)).toEqual([
			"google/gemini-2.5-flash",
			"openai/gpt-4o-mini",
		]);
	});
});

describe("retry fallback kind-role validation", () => {
	const chatModel = getBundledModel("openai", "gpt-4o-mini");
	if (!chatModel) throw new Error("Expected bundled OpenAI test model");
	const judgeModel: Model = { ...chatModel, id: "test-judge", name: "Test Judge", kind: "judge" };
	const imageModel: Model = { ...chatModel, id: "test-image", name: "Test Image", kind: "image" };
	const models = [chatModel, judgeModel, imageModel];
	const registry = {
		getAll: (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
		getAvailable: (kind: ModelKind | "all" = "chat") =>
			kind === "all" ? models : models.filter(model => (model.kind ?? "chat") === kind),
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
		hasProvider: (provider: string) => models.some(model => model.provider === provider),
		getProviderModels: (provider: string) => models.filter(model => model.provider === provider),
	};

	it("accepts aliases and fuzzy patterns that resolve to the role's model kind", () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${judgeModel.provider}/${judgeModel.id}` },
			"retry.fallbackChains": { judge: ["@judge", "test-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));

		expect(warnings).toEqual([]);
	});

	it("validates compatibility without requiring provider credentials or availability", () => {
		const settings = Settings.isolated({
			modelRoles: { image: `${imageModel.provider}/${imageModel.id}` },
			"retry.fallbackChains": { image: ["@image", "test-image"] },
		});
		const warnings: string[] = [];

		const unavailableRegistry = { ...registry, getAvailable: () => [] };
		validateRetryFallbackChains(settings, unavailableRegistry, warning => warnings.push(warning));

		expect(warnings).toEqual([]);
	});

	it("warns when kind-role entries resolve to the wrong kind or no model", () => {
		const wrongKindSelector = `${imageModel.provider}/${imageModel.id}`;
		const missingSelector = `${chatModel.provider}/missing-judge`;
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: [wrongKindSelector, missingSelector] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));

		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain(wrongKindSelector);
		expect(warnings[1]).toContain(missingSelector);
	});

	it("validates provider-qualified kind-role entries without composing the full catalog", () => {
		let fullCatalogReads = 0;
		const countingRegistry = {
			...registry,
			getAll: (kind: ModelKind | "all" = "chat") => {
				fullCatalogReads++;
				return registry.getAll(kind);
			},
		};
		const warnings: string[] = [];

		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { judge: [`${judgeModel.provider}/${judgeModel.id}`] } }),
			countingRegistry,
			warning => warnings.push(warning),
		);
		expect(warnings).toEqual([]);
		expect(fullCatalogReads).toBe(0);

		// A provider-less pattern has no provider slice to check; it must still resolve.
		validateRetryFallbackChains(
			Settings.isolated({ "retry.fallbackChains": { judge: ["test-judge"] } }),
			countingRegistry,
			warning => warnings.push(warning),
		);
		expect(warnings).toEqual([]);
		expect(fullCatalogReads).toBe(1);
	});

	it("keeps pending-discovery suppression for unresolved kind-role entries", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": { judge: ["litellm/pending-judge"] },
		});
		const warnings: string[] = [];

		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning), {
			isDiscoveryPending: provider => provider === "litellm",
		});

		expect(warnings).toEqual([]);
	});
});

describe("retry fallback regex diagnostics", () => {
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled OpenAI test model");
	const registry = {
		getAll: () => [model],
		getProviderModels: (provider: string) => provider === model.provider ? [model] : [],
		find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		hasProvider: (provider: string) => provider === model.provider,
	};

	it("reports one warning for an invalid regex entry and skips it", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { default: ["re:(", "openai/gpt-4o-mini"] } });
		const warnings: string[] = [];
		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));
		expect(warnings).toEqual(["Invalid regex fallback entry in retry.fallbackChains for 'default': re:("]);
	});

	it("reports one warning for an invalid regex key without misclassifying it as a role", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { "re:(": ["openai/gpt-4o-mini"] } });
		const warnings: string[] = [];
		validateRetryFallbackChains(settings, registry, warning => warnings.push(warning));
		expect(warnings).toEqual(["Invalid regex key in retry.fallbackChains: re:("]);
	});
});
