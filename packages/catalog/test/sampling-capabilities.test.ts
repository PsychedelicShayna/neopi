import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec<TApi extends Api>(provider: string, api: TApi): ModelSpec<TApi> {
	return {
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		provider,
		api,
		baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://proxy.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("endpoint sampling parameter capabilities", () => {
	it("keeps temperature available but rejects unsupported OpenAI Chat Completions extensions", () => {
		const model = buildModel(spec("openai", "openai-completions"));
		expect(model.compat.supportsSamplingParams).toBe(true);
		expect(model.compat.unsupportedSamplingParams).toEqual(["topK", "minP", "repetitionPenalty"]);
	});

	it("also withholds penalty fields on first-party Responses", () => {
		const model = buildModel(spec("openai", "openai-responses"));
		expect(model.compat.supportsSamplingParams).toBe(true);
		expect(model.compat.unsupportedSamplingParams).toEqual([
			"topK",
			"minP",
			"presencePenalty",
			"repetitionPenalty",
			"frequencyPenalty",
		]);
	});

	it("does not apply first-party restrictions to a compatible proxy", () => {
		const model = buildModel(spec("custom-proxy", "openai-completions"));
		expect(model.compat.supportsSamplingParams).toBe(true);
		expect(model.compat.unsupportedSamplingParams).toBeUndefined();
	});

	it("honors explicit endpoint capability overrides", () => {
		const model = buildModel({
			...spec("openai", "openai-completions"),
			compat: { unsupportedSamplingParams: [] },
		});
		expect(model.compat.unsupportedSamplingParams).toEqual([]);
	});

	it.each([
		["muse-code", "muse-wonder-full-1.0-contributor"],
		["meta", "muse-spark-1.3"],
		["opencode-go", "muse-spark-1.3-contributor"],
		["opencode-go", "muse-spark-1.2-contributor"],
		["custom-proxy", "compatible-model"],
	])("resolves the base Responses contract for %s/%s", (provider, id) => {
		const model = buildModel({ ...spec(provider, "openai-responses"), id });
		expect(model.compat.supportsSamplingParams).toBe(true);
		expect(model.compat.unsupportedSamplingParams).toEqual([
			"topK",
			"minP",
			"presencePenalty",
			"repetitionPenalty",
			"frequencyPenalty",
		]);
	});

	it("preserves documented extensions for OpenRouter Responses", () => {
		const model = buildModel(spec("openrouter", "openai-responses"));
		expect(model.compat.unsupportedSamplingParams).toEqual(["minP", "repetitionPenalty"]);
	});

	it("limits Go's speculative-decoding restriction to its V4.1 Flash lanes", () => {
		for (const id of ["deepseek-v4.1-flash", "deepseek-flash"]) {
			const model = buildModel({ ...spec("opencode-go", "openai-completions"), id });
			expect(model.compat.supportsSamplingParams).toBe(true);
			expect(model.compat.unsupportedSamplingParams).toEqual(["minP"]);
		}
		for (const [provider, id] of [
			["opencode-go", "deepseek-v4-pro"],
			["custom-proxy", "deepseek-v4.1-flash"],
		] as const) {
			const model = buildModel({ ...spec(provider, "openai-completions"), id });
			expect(model.compat.unsupportedSamplingParams).toBeUndefined();
		}
	});
});
