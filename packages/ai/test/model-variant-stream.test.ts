import { describe, expect, it } from "bun:test";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { captureFetch, responsesChunks } from "./helpers/factory-droid";

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const base = getBundledModel<"openai-responses">("openai", "gpt-4o-mini")!;
const variant: Model<"openai-responses"> = {
	...base,
	id: "test-named-profile",
	requestModelId: "gpt-4o-mini-2024-07-18",
	variant: { baseModelId: base.id, settings: {}, request: { temperature: 0, topP: -1 } },
};

function responseMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: base.api,
		provider: base.provider,
		model: base.id,
		content: [{ type: "text", text: "Hello back" }],
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("model variant request dispatch", () => {
	it.each([
		["raw", stream],
		["simple", streamSimple],
	] as const)(
		"%s streaming applies sampling locally and preserves the provider's wire routing",
		async (_name, run) => {
			let payload: Record<string, unknown> | undefined;
			let callbackModel: Model | undefined;
			const result = await run(variant, context, {
				apiKey: "test-key",
				maxTokens: 16,
				temperature: 0.8,
				topP: 0.9,
				fetch: async () => new Response(new Uint8Array(), { status: 200 }),
				onPayload: (body, model) => {
					payload = JSON.parse(JSON.stringify(body));
					callbackModel = model;
				},
			}).result();
			expect(payload).toMatchObject({ model: variant.requestModelId, temperature: 0 });
			expect(payload).not.toHaveProperty("top_p");
			expect(callbackModel?.id).toBe(variant.id);
			expect(result.model).toBe(variant.id);
		},
	);

	it("uses the base selector for auth-gateway and restores the variant on events and result", async () => {
		const previous = { ...responseMessage(), model: variant.id };
		const message = responseMessage();
		let request: { modelId: string; context: Context; options: Record<string, unknown> } | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			request = JSON.parse(String(init?.body));
			return new Response(
				`data: ${JSON.stringify({ type: "start", partial: message })}\n\ndata: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const output = streamSimple(
			{ ...variant, transport: "pi-native", baseUrl: "https://gateway.test" },
			{ messages: [...context.messages, previous] },
			{ apiKey: "gateway-test-key", temperature: 0.8, topP: 0.9, fetch: fetchImpl },
		);
		const seen: string[] = [];
		for await (const event of output) {
			if (event.type === "start") seen.push(event.partial.model);
			if (event.type === "done") seen.push(event.message.model);
		}
		expect(seen).toEqual([variant.id, variant.id]);
		expect((await output.result()).model).toBe(variant.id);
		expect(request?.modelId).toBe(`${base.provider}/${base.id}`);
		expect(request?.options.temperature).toBe(0);
		expect(request?.options).not.toHaveProperty("topP");
		expect(request?.context.messages[1]).toMatchObject({ model: base.id });
		expect(previous.model).toBe(variant.id);
	});

	it("clears a built-in Codex fast tier when a named variant selects the default", async () => {
		const codexBase = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6-luna")!;
		const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } };
		const token = `aaa.${Buffer.from(JSON.stringify(claims)).toBase64()}.bbb`;
		const profile = {
			...codexBase,
			id: "named-standard",
			requestModelId: codexBase.id,
			codexVariant: { baseModelId: codexBase.id, serviceTier: "priority", contextWindow: 900_000 },
			serviceTiers: ["priority"],
			variant: {
				baseModelId: `${codexBase.id}-fast`,
				settings: {},
				request: { serviceTier: "none" },
			},
		} satisfies Model<"openai-codex-responses">;
		let payload: Record<string, unknown> | undefined;
		const result = await streamSimple(profile, context, {
			apiKey: token,
			preferWebsockets: false,
			serviceTier: "priority",
			fetch: captureFetch([], responsesChunks("Hello back"), { "content-type": "text/event-stream" }),
			onPayload: body => {
				payload = JSON.parse(JSON.stringify(body));
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(payload).toMatchObject({ model: codexBase.id });
		expect(payload).not.toHaveProperty("service_tier");
	});
});
