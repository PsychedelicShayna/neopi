import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	compileModelFolderRules,
	createModelFolderMatcher,
	type ModelFolderCondition,
	type ModelFolderFacts,
} from "../src/overlays/model-folder-rules";

const facts: ModelFolderFacts = {
	slug: "openai-codex/gpt-test",
	contextWindow: 500_000,
	provider: "openai-codex",
	reasoning: true,
};

function matches(
	operator: ModelFolderCondition["operator"],
	attribute: ModelFolderCondition["attribute"],
	value: string,
	model = facts,
	invert = false,
): boolean {
	return compileModelFolderRules([[{ attribute, operator, value, invert }]])(model);
}

describe("model folder rules", () => {
	test.each([
		[">=", "contextWindow", "500000", "500001"],
		["<=", "contextWindow", "500000", "499999"],
		[">", "contextWindow", "499999", "500000"],
		["<", "contextWindow", "500001", "500000"],
		["==", "reasoning", "true", "false"],
		["!=", "provider", "anthropic", "openai-codex"],
		["~=", "slug", "^OPENAI-.*/gpt-[a-z]+$", "^gpt"],
		["in", "provider", "anthropic, OPENAI-CODEX", "anthropic, google"],
		["*=", "slug", "openai-codex/*", "anthropic/*"],
	] as const)("%s matches and inverts, but never matches an unknown fact", (operator, attribute, hit, miss) => {
		expect(matches(operator, attribute, hit)).toBe(true);
		expect(matches(operator, attribute, miss)).toBe(false);
		expect(matches(operator, attribute, hit, facts, true)).toBe(false);
		expect(matches(operator, attribute, miss, facts, true)).toBe(true);
		expect(matches(operator, attribute, hit, { ...facts, [attribute]: null }, true)).toBe(false);
	});

	test("in accepts a case-insensitive substring, plus numeric membership", () => {
		expect(matches("in", "slug", "GPT-TEST")).toBe(true);
		expect(matches("in", "contextWindow", "500000, 600000")).toBe(true);
	});

	test("invalid regex is rejected and missing TTFT does not count as zero", () => {
		expect(() => matches("~=", "slug", "[")).toThrow("Invalid regular expression");
		expect(matches("<=", "ttftMs", "1000", { ttftMs: 900 })).toBe(true);
		expect(matches("<=", "ttftMs", "1000", { ttftMs: NaN })).toBe(false);
		expect(matches("<=", "ttftMs", "1000", {})).toBe(false);
	});

	test("matches either whole clause in the owner's example", () => {
		const match = compileModelFolderRules([
			[
				{ attribute: "slug", operator: "*=", value: "openai-codex/*" },
				{ attribute: "contextWindow", operator: ">=", value: "500000" },
			],
			[
				{ attribute: "provider", operator: "==", value: "anthropic" },
				{ attribute: "outputPrice", operator: "<=", value: "25" },
			],
		]);
		expect(match(facts)).toBe(true);
		expect(match({ provider: "anthropic", outputPrice: 20 })).toBe(true);
		expect(match({ ...facts, contextWindow: 499_999 })).toBe(false);
		expect(match({ provider: "anthropic", outputPrice: 26 })).toBe(false);
		expect(match({ outputPrice: 20 })).toBe(false);
		expect(compileModelFolderRules([])(facts)).toBe(false);
	});

	test("catalog placeholders never satisfy rules, and only measured TTFT is eligible", () => {
		const model = buildModel({
			provider: "fixture",
			id: "reported",
			name: "Reported",
			api: "openai-completions",
			baseUrl: "http://fixture.test/v1",
			contextWindow: 500_000,
			maxTokens: 20_000,
			input: ["text", "image"],
			reasoning: false,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		const placeholder: typeof model = {
			...model,
			id: "placeholder",
			discoveryMissingContextWindow: true,
			discoveryMissingMaxTokens: true,
			discoveryMissingInput: true,
			discoveryMissingReasoningEffort: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const measured = createModelFolderMatcher(
			() => new Map([["fixture/reported@fast", { samples: 5, tps: 140, ttftMs: 800 }]]),
		);
		const catalog = [model, placeholder];
		expect(
			measured(
				{
					ingest: true,
					clauses: [
						[
							{ attribute: "ttftMs", operator: "<=", value: "1000" },
							{ attribute: "tps", operator: ">=", value: "100" },
							{ attribute: "vision", operator: "==", value: "true" },
							{ attribute: "maxOutput", operator: ">=", value: "20000" },
						],
					],
				},
				catalog,
				[],
			),
		).toEqual(["fixture/reported"]);
		expect(
			measured(
				{
					ingest: false,
					clauses: [
						[{ attribute: "contextWindow", operator: "<", value: "300000", invert: true }],
						[{ attribute: "outputPrice", operator: "==", value: "0" }],
						[{ attribute: "vision", operator: "==", value: "false" }],
						[{ attribute: "reasoning", operator: "!=", value: "true" }],
					],
				},
				catalog,
				[],
			),
		).toEqual(["fixture/reported"]);
	});
});
