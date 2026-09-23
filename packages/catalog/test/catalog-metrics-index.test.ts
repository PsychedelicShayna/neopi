import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyCatalogMetrics, applyRefreshedExactScores, CatalogMetricsIndex } from "@oh-my-pi/pi-catalog/identity/metrics";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function model(provider: string, id: string, metrics?: { int?: number; tps?: number }): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...metrics,
	} as ModelSpec<Api>);
}

const scored = new CatalogMetricsIndex([
	model("anthropic", "claude-fable-5-1", { int: 65.7, tps: 66.2 }),
	model("anthropic", "claude-opus-4-1-20250805", { int: 50.2, tps: 40 }),
	model("anthropic", "claude-opus-4", { int: 44.1, tps: 42 }),
	model("openai", "gpt-5.6-sol", { int: 60.9, tps: 70.4 }),
	model("openai", "gpt-5.6-terra", { int: 56.6, tps: 97.7 }),
	model("openai", "gpt-5.5", { int: 56.3, tps: 79.4 }),
]);

describe("CatalogMetricsIndex", () => {
	test.each([
		["dot-spelled revision", "github-copilot", "claude-fable-5.1", 65.7],
		["bedrock region and vendor prefixes", "amazon-bedrock", "global.anthropic.claude-fable-5-1", 65.7],
		[
			"bedrock version suffix keeps the dated snapshot",
			"amazon-bedrock",
			"us.anthropic.claude-opus-4-1-20250805-v1:0",
			50.2,
		],
		["mantle vendor prefix with dotted revision", "bedrock-mantle", "openai.gpt-5.5", 56.3],
		["effort lane collapses to its base id", "cursor", "claude-fable-5-1-high", 65.7],
		["namespaced gateway id", "openrouter", "openai/gpt-5.6-terra", 56.6],
	])("resolves %s", (_label, provider, id, int) => {
		expect(scored.resolve(model(provider, id))?.int).toBe(int);
	});

	test("does not cross product lines that share a revision", () => {
		expect(scored.resolve(model("openai", "gpt-5.6-luna"))).toBeUndefined();
		expect(scored.resolve(model("openai", "gpt-5.5-pro"))).toBeUndefined();
	});

	test("does not strip a dated snapshot down to a sibling revision", () => {
		// `claude-opus-4-1-...` must never fall through to `claude-opus-4`.
		expect(scored.resolve(model("amazon-bedrock", "anthropic.claude-opus-4-1-20250805-v1:0"))?.int).toBe(50.2);
		expect(scored.resolve(model("anthropic", "claude-opus-4-1"))).toBeUndefined();
	});

	test("exact id wins over dialect matching and merges partial rows", () => {
		const index = new CatalogMetricsIndex([
			model("a", "gpt-5.5", { int: 10 }),
			model("b", "gpt-5.5", { tps: 20 }),
			model("c", "openai/gpt-5.5", { int: 99, tps: 99 }),
		]);
		expect(index.resolve(model("d", "GPT-5.5"))).toEqual({ int: 10, tps: 20 });
	});
});

describe("applyCatalogMetrics", () => {
	test("fills only unscored models and preserves array identity when nothing changes", () => {
		const already = model("openai", "gpt-5.5", { int: 1, tps: 2 });
		const unknown = model("ollama", "lfm2.5:2.6b");
		const untouched = [already, unknown];
		expect(applyCatalogMetrics(untouched, scored)).toBe(untouched);

		const filled = applyCatalogMetrics([already, model("openai-codex", "gpt-5.6-terra")], scored);
		expect(filled[0]).toBe(already);
		expect(filled[1].int).toBe(56.6);
		expect(filled[1].tps).toBe(97.7);
	});

	test("replace writes an exact-id catalog score over a score the model already has", () => {
		const stale = model("xai", "grok-4.6", { int: 60.9, tps: 61.3 });
		const index = new CatalogMetricsIndex([model("xai", "grok-4.6", { int: 44.3, tps: 60.4 })]);
		const replaced = applyCatalogMetrics([stale], index, { replace: true });
		expect(replaced[0].int).toBe(44.3);
		expect(replaced[0].tps).toBe(60.4);
	});

	test("replace leaves the field the catalog row omitted", () => {
		const intOnly = new CatalogMetricsIndex([model("xai", "grok-4.6", { int: 44.3 })]);
		const keptTps = applyCatalogMetrics([model("xai", "grok-4.6", { int: 60.9, tps: 61.3 })], intOnly, {
			replace: true,
		});
		expect(keptTps[0].int).toBe(44.3);
		expect(keptTps[0].tps).toBe(61.3);

		const tpsOnly = new CatalogMetricsIndex([model("xai", "grok-4.6", { tps: 60.4 })]);
		const keptInt = applyCatalogMetrics([model("xai", "grok-4.6", { int: 60.9, tps: 61.3 })], tpsOnly, {
			replace: true,
		});
		expect(keptInt[0].int).toBe(60.9);
		expect(keptInt[0].tps).toBe(60.4);
	});

	test("replace does not copy a canonical sibling onto a scored model", () => {
		const dotted = model("anthropic", "claude-fable-5.1", { int: 99, tps: 1 });
		const index = new CatalogMetricsIndex([model("anthropic", "claude-fable-5-1", { int: 53.4, tps: 65.8 })]);
		const replaced = applyCatalogMetrics([dotted], index, { replace: true });
		expect(replaced[0]).toBe(dotted);
		expect(replaced[0].int).toBe(99);
		expect(replaced[0].tps).toBe(1);
	});
});

describe("applyRefreshedExactScores", () => {
	const bundled = (provider: string, id: string) => (id === "gpt-5.6-sol" || id === "grok-4.6" ? 60.9 : undefined);

	test("copies a score that left the bundled catalog onto the stale provider rows", () => {
		const openai = model("openai", "gpt-5.6-sol", { int: 47, tps: 84.2 });
		const codex = model("openai-codex", "gpt-5.6-sol", { int: 60.9, tps: 76.5 });
		const oauth = model("xai-oauth", "grok-4.6", { int: 60.9, tps: 61.3 });
		const paid = model("xai", "grok-4.6", { int: 44.3, tps: 60.4 });
		const updated = applyRefreshedExactScores([openai, codex, oauth, paid], bundled);
		expect(updated[1].int).toBe(47);
		expect(updated[1].tps).toBe(84.2);
		expect(updated[2].int).toBe(44.3);
		expect(updated[2].tps).toBe(60.4);
		expect(updated[0].int).toBe(47);
		expect(updated[3].int).toBe(44.3);
	});

	test("leaves rows alone when refreshed scores disagree or none left the bundle", () => {
		const same = [model("openai", "gpt-5.6-sol", { int: 60.9, tps: 1 }), model("openai-codex", "gpt-5.6-sol", { int: 60.9, tps: 2 })];
		expect(applyRefreshedExactScores(same, bundled)).toBe(same);
		const split = [model("openai", "gpt-5.6-sol", { int: 47, tps: 1 }), model("azure", "gpt-5.6-sol", { int: 44, tps: 2 })];
		const left = applyRefreshedExactScores(split, bundled);
		expect(left[0].int).toBe(47);
		expect(left[1].int).toBe(44);
	});
});
