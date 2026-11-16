import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertToLlm } from "../../src/session/messages";

export const codexTestToken = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toBase64()}.bbb`;

/** Real Codex adapter, with only the non-Codex target stubbed. */
export function codexModelSwitchAgent(model: Model): Agent {
	const parameters = type({});
	const probe: AgentTool<typeof parameters, undefined> = {
		name: "probe",
		label: "Probe",
		description: "Continue to the next provider request",
		parameters,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
	return new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [probe] },
		getApiKey: () => codexTestToken,
		convertToLlm,
		streamFn: (requested, context, options) =>
			requested.api === "openai-codex-responses"
				? streamOpenAICodexResponses(requested as Model<"openai-codex-responses">, context, {
						...options,
						apiKey: codexTestToken,
					})
				: createMockModel({
						id: requested.id,
						provider: requested.provider,
						handler: () => ({ content: ["target completed"] }),
					}).stream(requested, context, options),
	});
}
