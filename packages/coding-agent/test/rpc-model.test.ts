import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import { serializeRpcModel } from "../src/modes/rpc/rpc-model";
import { buildRpcSessionState } from "../src/modes/rpc/rpc-session-state";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

function model<TApi extends Api>(provider: string, api: TApi, id: string, serviceTiers?: string[]): Model<TApi> {
	return buildModel({
		id,
		name: id,
		provider,
		api,
		baseUrl: "https://provider.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		...(serviceTiers === undefined ? {} : { serviceTiers }),
	});
}

const cases: [string, Model, boolean][] = [
	["OpenAI Responses", model("openai", "openai-responses", "gpt-5.5"), true],
	["OpenAI Completions", model("openai", "openai-completions", "gpt-5.5"), true],
	["Codex unreported tiers", model("openai-codex", "openai-codex-responses", "gpt-5.5"), true],
	["Codex empty tiers", model("openai-codex", "openai-codex-responses", "gpt-5.5", []), true],
	["Codex priority", model("openai-codex", "openai-codex-responses", "gpt-5.5", ["priority"]), true],
	["Codex default only", model("openai-codex", "openai-codex-responses", "gpt-5.5", ["default"]), false],
	["Codex Ultrafast only", model("openai-codex", "openai-codex-responses", "gpt-5.5", ["ultrafast"]), false],
	["Anthropic", model("anthropic", "anthropic-messages", "claude-opus-4-6"), true],
	["Bedrock Claude", model("amazon-bedrock", "anthropic-messages", "claude-opus-4-6"), false],
	["Vertex Claude", model("google-vertex", "anthropic-messages", "claude-opus-4-6"), false],
	["Gemini", model("google", "google-generative-ai", "gemini-3-flash"), true],
	["Vertex Gemini", model("google-vertex", "google-vertex", "gemini-3-flash"), true],
	["OpenRouter OpenAI", model("openrouter", "openai-completions", "openai/gpt-5.5"), true],
	["OpenRouter Gemini", model("openrouter", "openai-completions", "google/gemini-3-flash"), true],
	["OpenRouter Claude", model("openrouter", "openai-completions", "anthropic/claude-opus-4-6"), false],
	["OpenRouter other model", model("openrouter", "openai-completions", "z-ai/glm-4.7"), false],
	["custom OpenAI Responses", model("custom-relay", "openai-responses", "gpt-5.5"), true],
	["custom OpenAI Completions", model("custom-relay", "openai-completions", "gpt-5.5"), true],
	["custom Codex empty tiers", model("custom-relay", "openai-codex-responses", "gpt-5.5", []), true],
	["custom Codex without priority", model("custom-relay", "openai-codex-responses", "gpt-5.5", ["flex"]), false],
	["custom non-OpenAI model", model("custom-relay", "openai-completions", "qwen3"), false],
	["Copilot OpenAI model", model("github-copilot", "openai-responses", "gpt-5.5"), false],
	["Fireworks dedicated priority control", model("fireworks", "openai-completions", "gpt-oss-120b"), false],
];

/** The state builder only reads these session fields; no runtime or provider is started. */
function sessionFor(selectedModel: Model | undefined, fastModeEnabled: boolean, fastModeActive: boolean): AgentSession {
	const session = {
		settings: Settings.isolated(),
		model: selectedModel,
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		interruptMode: "immediate",
		sessionId: "rpc-model-test",
		sessionFile: undefined,
		chroniclerHealth: undefined,
		chatMode: undefined,
		autoCompactionEnabled: true,
		queuedMessageCount: 0,
		hasAdmittedSubmission: false,
		messages: [],
		getApprovalMode: () => "always-ask",
		getAdvisorCost: () => 0,
		advisorCostRestoreState: "ready",
		sessionManager: SessionManager.inMemory(),
		getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
		hasPendingAsyncWork: () => false,
		getRunningBackgroundJobCount: () => 0,
		getTodoPhases: () => [],
		getActiveTimeMs: () => 0,
		isFastModeEnabled: () => fastModeEnabled,
		isFastModeActive: () => fastModeActive,
		isSlowModeSupported: () => false,
		isSlowModeEnabled: () => false,
		getSlowModeScope: () => undefined,
		getUsageLimitState: () => undefined,
		getContextUsage: () => undefined,
		getPlanModeState: () => undefined,
		getGoalModeState: () => undefined,
		systemPrompt: ["preserve the prompt"],
		agent: { state: { tools: [] } },
	};
	return session as unknown as AgentSession;
}

describe("RPC model serialization", () => {
	it.each(cases)("projects native Fast support for %s", (_name, source, expected) => {
		const frozen = Object.freeze(source);
		const projected = serializeRpcModel(frozen);
		expect(projected.supportsFastMode).toBe(expected);
		expect(source).not.toHaveProperty("supportsFastMode");
	});

	it("does not infer Fast support from a fast-SKU hint", () => {
		const base = model("custom-relay", "openai-completions", "qwen3");
		const source: Model = {
			...base,
			compat: { ...base.compat, fastMode: true },
		};
		expect(serializeRpcModel(source).supportsFastMode).toBe(false);
	});

	it("keeps supported capability separate from an off session toggle", () => {
		const source = model("openai", "openai-responses", "gpt-5.5");
		const state = buildRpcSessionState(sessionFor(source, false, false), { includeDump: true });
		expect(state.model?.supportsFastMode).toBe(true);
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(false);
		expect(state.systemPrompt).toEqual(["preserve the prompt"]);
	});

	it("keeps no-model state absent on the wire and preserves realized Fast state", () => {
		const state = buildRpcSessionState(sessionFor(undefined, true, true), { includeDump: false });
		expect(state.model).toBeUndefined();
		expect(JSON.parse(JSON.stringify(state))).not.toHaveProperty("model");
		expect(state.fastModeEnabled).toBe(true);
		expect(state.fastModeActive).toBe(true);
		expect(state).not.toHaveProperty("systemPrompt");
		expect(state).not.toHaveProperty("dumpTools");
		expect(state.sessionUsage?.cost).toBe(0);
	});
});
