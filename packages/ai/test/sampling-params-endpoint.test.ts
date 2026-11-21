import { describe, expect, it } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildParams as buildResponsesParams, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { StreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { captureFetch, type CapturedRequest, completionsChunks, responsesChunks } from "./helpers/factory-droid";

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
const options: StreamOptions = {
	apiKey: "test-key",
	temperature: 0.2,
	topP: 0.8,
	topK: 40,
	minP: 0.05,
	presencePenalty: 0.5,
	repetitionPenalty: 1.1,
	frequencyPenalty: 0.4,
};

function modelSpec(provider: string) {
	return {
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} satisfies ModelSpec<"openai-completions">;
}

async function payload(spec: ModelSpec<"openai-completions">, simple: boolean): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const requestOptions: StreamOptions = {
		...options,
		fetch: async () => new Response(new Uint8Array(), { status: 200 }),
		onPayload: body => {
			captured = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
		},
	};
	const model = buildModel(spec);
	await (simple ? streamSimple(model, context, requestOptions) : stream(model, context, requestOptions)).result();
	if (!captured) throw new Error("No request payload was built");
	return captured;
}

describe.each([true, false])("endpoint sampling capability filtering, simple=%s", simple => {
	it("drops only unsupported fields and leaves caller options untouched", async () => {
		const body = await payload(modelSpec("openai"), simple);
		expect(body.temperature).toBe(0.2);
		expect(body.top_p).toBe(0.8);
		expect(body.presence_penalty).toBe(0.5);
		if (!simple) expect(body.frequency_penalty).toBe(0.4);
		for (const key of ["top_k", "min_p", "repetition_penalty"]) expect(body).not.toHaveProperty(key);
		expect(options.topK).toBe(40);
		expect(options.minP).toBe(0.05);
		expect(options.repetitionPenalty).toBe(1.1);
	});

	it("preserves supported proxy parameters", async () => {
		const body = await payload(modelSpec("custom-proxy"), simple);
		expect(body.top_k).toBe(40);
		expect(body.min_p).toBe(0.05);
		expect(body.repetition_penalty).toBe(1.1);
	});

	it("lets an explicit capability override enable endpoint extensions", async () => {
		const body = await payload({ ...modelSpec("openai"), compat: { unsupportedSamplingParams: [] } }, simple);
		expect(body.top_k).toBe(40);
		expect(body.min_p).toBe(0.05);
		expect(body.repetition_penalty).toBe(1.1);
	});
});

describe("provider request sampling capabilities", () => {
	it.each([
		["muse-code", "muse-wonder-full-1.0-contributor"],
		["opencode-go", "muse-spark-1.3-contributor"],
		["opencode-go", "muse-spark-1.2-contributor"],
	])("filters the direct Responses builder for %s/%s", (provider, id) => {
		const model = buildModel<"openai-responses">({ ...modelSpec(provider), api: "openai-responses", id });
		const { params } = buildResponsesParams(
			model,
			context,
			{ ...options, extraBody: { min_p: 0.1, frequency_penalty: 0.5 } },
			undefined,
		);
		expect(params).toMatchObject({ temperature: 0.2, top_p: 0.8 });
		for (const key of ["top_k", "min_p", "presence_penalty", "repetition_penalty", "frequency_penalty"]) {
			expect(params).not.toHaveProperty(key);
		}
	});

	it("preserves the OpenRouter Responses extensions the adapter emits", () => {
		const model = buildModel<"openai-responses">({ ...modelSpec("openrouter"), api: "openai-responses" });
		const { params } = buildResponsesParams(model, context, options, undefined);
		expect(params).toMatchObject({ temperature: 0.2, top_p: 0.8, top_k: 40, presence_penalty: 0.5 });
		expect(params).not.toHaveProperty("min_p");
		expect(params).not.toHaveProperty("repetition_penalty");
	});

	it("enforces the Go Chat restriction for direct streaming and payload replacement", async () => {
		const model = buildModel({ ...modelSpec("opencode-go"), id: "deepseek-v4.1-flash" });
		const captured: CapturedRequest[] = [];
		const result = await streamOpenAICompletions(model, context, {
			...options,
			fetch: captureFetch(captured, completionsChunks("ok", model.id)),
			onPayload: body => {
				expect(body).not.toHaveProperty("min_p");
				return { ...(body as object), min_p: 0.1 };
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.body).toMatchObject({
			temperature: 0.2,
			top_p: 0.8,
			top_k: 40,
			presence_penalty: 0.5,
			repetition_penalty: 1.1,
			frequency_penalty: 0.4,
		});
		expect(captured[0]?.body).not.toHaveProperty("min_p");
	});

	it("enforces the Responses capability after a payload callback mutates the body", async () => {
		const model = buildModel<"openai-responses">({
			...modelSpec("muse-code"),
			api: "openai-responses",
			id: "muse-wonder-full-1.0-contributor",
		});
		const captured: CapturedRequest[] = [];
		const result = await streamOpenAIResponses(model, context, {
			...options,
			fetch: captureFetch(captured, responsesChunks("ok")),
			onPayload: body => {
				Object.assign(body as object, { min_p: 0.1 });
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.body).toMatchObject({ temperature: 0.2, top_p: 0.8 });
		expect(captured[0]?.body).not.toHaveProperty("min_p");
	});

	it("does not forward rejected Go sampling through the pi-native auth gateway", async () => {
		const model = buildModel({ ...modelSpec("opencode-go"), id: "deepseek-v4.1-flash" });
		const captured: CapturedRequest[] = [];
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		storage.keys.setRuntime(model.provider, "test-key");
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: () => model,
			fetch: captureFetch(captured, completionsChunks("ok", model.id)),
		});
		try {
			const request = new Request("http://gateway.test/v1/pi/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: `${model.provider}/${model.id}`,
					context,
					options: { temperature: 0.2, topK: 40, minP: 0.05 },
					stream: false,
				}),
			});
			const response = await router.route(request, "sampling-test");
			expect(response.status).toBe(200);
			expect(captured).toHaveLength(1);
			expect(captured[0]?.body).toMatchObject({ temperature: 0.2, top_k: 40 });
			expect(captured[0]?.body).not.toHaveProperty("min_p");
		} finally {
			router.close();
			storage.close();
		}
	});
});
