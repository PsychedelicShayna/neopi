import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	buildXaiOAuthStaticSeed,
	xaiOAuthModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyPricingPeerFallback } from "../scripts/generated-policies";

const seed = buildXaiOAuthStaticSeed();

function seedModel(id: string): ModelSpec<Api> {
	const model = seed.find(candidate => candidate.id === id);
	if (!model) throw new Error(`Missing xai-oauth seed ${id}`);
	return model;
}

function builtSeedModel(id: string) {
	return buildModel(seedModel(id));
}

describe("xai-oauth catalog seed", () => {
	it("builds curated chat rows on the OAuth Responses dialect", () => {
		expect(builtSeedModel("grok-4.20-0309-reasoning")).toMatchObject({
			provider: "xai-oauth",
			api: "openai-responses",
			baseUrl: "https://api.x.ai/v1",
			contextWindow: 2_000_000,
			maxTokens: 2_000_000,
			reasoning: true,
			input: ["text", "image"],
			compat: {
				supportsReasoningEffort: false,
				omitReasoningEffort: true,
			},
		});
	});

	it("filters versioned video SKUs from the discovered chat roster", async () => {
		const fetchMock: FetchImpl = async (_input, _init) =>
			Response.json({
				object: "list",
				data: [{ id: "grok-imagine-video-1.5-lite" }, { id: "grok-4.7" }],
			});
		const options = xaiOAuthModelManagerOptions({ apiKey: "xai-oauth-test", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models?.some(model => model.id === "grok-imagine-video-1.5-lite")).toBe(false);
		expect(models?.find(model => model.id === "grok-4.7")).toMatchObject({
			api: "openai-responses",
			contextWindow: 500_000,
		});
	});

	it("preserves dedicated runner transports and kinds", () => {
		const tts = builtSeedModel("grok-tts");
		expect(tts).toMatchObject({ api: "xai-tts", kind: "tts" });
		expect(tts.compat).toBeUndefined();
		const image = builtSeedModel("grok-imagine-image");
		expect(image).toMatchObject({ api: "openai-images", kind: "image" });
		expect(image.compat).toBeUndefined();
	});

	it("prices the multi-agent SuperGrok alias from its public xAI equivalent", () => {
		const subscription = seedModel("grok-4.20-multi-agent-0309");
		const publicPeer: ModelSpec<Api> = {
			...subscription,
			id: "grok-4.20-multi-agent-beta-latest",
			provider: "xai",
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.2,
				cacheWrite: 0,
				longContext: {
					inputThreshold: 200_000,
					inputThresholdInclusive: true,
					input: 4,
					output: 12,
					cacheRead: 0.4,
					cacheWrite: 0,
				},
			},
		};
		const [priced] = applyPricingPeerFallback([subscription, publicPeer]);
		expect(priced?.cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.2,
			cacheWrite: 0,
			longContext: {
				inputThreshold: 200_000,
				inputThresholdInclusive: true,
				input: 4,
				output: 12,
				cacheRead: 0.4,
				cacheWrite: 0,
			},
		});
	});

	it("keeps each curated Responses output ceiling at its context limit", () => {
		for (const model of seed) {
			if (model.api !== "openai-responses") continue;
			expect(model.maxTokens, `seed ${model.id} maxTokens`).toBe(model.contextWindow);
		}
	});
});
