import { describe, expect, it } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression for #207: role-level `tier.*.flex` must not reach the Codex wire
 * (ChatGPT OAuth rejects `Unsupported service_tier: flex`) unless discovery
 * advertises it. First-party OpenAI API flex stays intact.
 */

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createCodexToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

const openaiModel: Model<"openai-responses"> = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

const codexModel: Model<"openai-codex-responses"> = buildModel({
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

function captureOpenAIPayload(serviceTier: "flex"): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(openaiModel, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		serviceTier,
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function captureCodexPayload(
	model: Model<"openai-codex-responses">,
	serviceTier: "flex",
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAICodexResponses(model, context, {
		apiKey: createCodexToken("acc_test"),
		signal: createAbortedSignal(),
		serviceTier,
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("Codex flex service_tier wire gating (#207)", () => {
	it("omits flex on openai-codex requests while still sending it on first-party openai", async () => {
		const [openaiBody, codexBody, codexWithFlexBody] = await Promise.all([
			captureOpenAIPayload("flex"),
			captureCodexPayload(codexModel, "flex"),
			captureCodexPayload(buildModel({ ...codexModel, serviceTiers: ["priority", "flex"] }), "flex"),
		]);

		// Provider that supports flex keeps the field.
		expect(openaiBody.service_tier).toBe("flex");
		// Bundled/discovered-without-flex Codex must omit it (#207).
		expect(codexBody.service_tier).toBeUndefined();
		// Discovery that lists flex is the only Codex path that may send it.
		expect(codexWithFlexBody.service_tier).toBe("flex");
	});
});
