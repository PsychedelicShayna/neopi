import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { expandCodexVariants } from "@oh-my-pi/pi-catalog/model-variants";
import { unionAccountCatalogs } from "@oh-my-pi/pi-catalog/provider-models/account-access";
import type { Model, ModelAccountAccess } from "@oh-my-pi/pi-catalog/types";

function base(
	serviceTiers?: readonly string[],
	accountAccess?: Record<string, ModelAccountAccess>,
): Model<"openai-codex-responses"> {
	return buildModel({
		id: "future-model",
		name: "Future Model",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 272_000,
		maxContextWindow: 872_000,
		maxTokens: 128_000,
		serviceTiers,
		accountAccess,
	});
}

describe("Codex selectable slugs", () => {
	test("adds all advertised tier/context combinations for a future model without changing wire identity", () => {
		const original = base(["priority", "ultrafast"]);
		const models = expandCodexVariants([original]);
		expect(models.map(model => model.id)).toEqual([
			"future-model",
			"future-model-900k",
			"future-model-fast",
			"future-model-fast-900k",
			"future-model-ultra",
			"future-model-ultra-900k",
		]);
		for (const model of models.slice(1)) {
			expect(model.requestModelId).toBe("future-model");
			expect(model.contextWindow).toBe(model.id.endsWith("-900k") ? 872_000 : 272_000);
		}
		expect(original.codexVariant).toBeUndefined();
		expect(original.contextWindow).toBe(272_000);
	});

	test.each([{ tiers: undefined }, { tiers: [] }])("keeps implicit Priority for unreported tiers %j", ({ tiers }) => {
		const models = expandCodexVariants([base(tiers)]);
		expect(models.some(model => model.id === "future-model-fast")).toBe(true);
		expect(models.some(model => model.id.includes("-ultra"))).toBe(false);
	});

	test("does not invent unsupported tiers, larger windows, or duplicate existing selectors", () => {
		const original = { ...base(["default"]), maxContextWindow: undefined };
		expect(expandCodexVariants([original])).toEqual([original]);
		const custom = { ...base(), id: "future-model-fast", requestModelId: "custom-wire" };
		const models = expandCodexVariants([base(), custom]);
		expect(models.filter(model => model.id === custom.id)).toEqual([custom]);
		expect(models.find(model => model.id === custom.id)?.requestModelId).toBe("custom-wire");
	});

	test.each([false, true])(
		"routes Ultra only to explicitly entitled accounts regardless of discovery order: %j",
		reverse => {
			const standard = base(["priority"], { standard: { serviceTiers: ["priority"] } });
			const ultra = base(["priority", "ultrafast"], { ultra: { serviceTiers: ["priority", "ultrafast"] } });
			const unknown = base(undefined, { unknown: {} });
			const catalogs = [[standard], [ultra], [unknown]];
			const merged = unionAccountCatalogs(reverse ? catalogs.toReversed() : catalogs);
			const models = expandCodexVariants(merged);
			expect(Object.keys(models.find(model => model.id === "future-model-ultra-900k")!.accountAccess!)).toEqual([
				"ultra",
			]);
			expect(Object.keys(models.find(model => model.id === "future-model-fast")!.accountAccess!).sort()).toEqual([
				"standard",
				"ultra",
				"unknown",
			]);
		},
	);

	test.each([false, true])("retains implicit Priority when another account advertises only Ultra: %j", reverse => {
		const implicit = base([], { implicit: { serviceTiers: [] } });
		const ultra = base(["ultrafast"], { ultra: { serviceTiers: ["ultrafast"] } });
		const catalogs = [[implicit], [ultra]];
		const models = expandCodexVariants(unionAccountCatalogs(reverse ? catalogs.toReversed() : catalogs));
		const fast = models.find(model => model.id === "future-model-fast")!;
		expect(Object.keys(fast.accountAccess!)).toEqual(["implicit"]);
		expect(fast.serviceTiers).toContain("priority");
	});
});
