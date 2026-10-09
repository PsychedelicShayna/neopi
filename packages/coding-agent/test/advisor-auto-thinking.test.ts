import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// The advisor's Auto selection is classified independently at every review.
// Neither the primary's effective effort nor its later changes choose the
// advisor's level; retry fallback models retain their own fixed selection.
describe("advisor auto thinking level", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		model = bundled;
	});

	let session: AgentSession | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	function newSession(
		streamFn?: Agent["streamFn"],
		settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
		advisorStreamFn?: Agent["streamFn"],
	): AgentSession {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			...(streamFn ? { streamFn } : {}),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, ...settingsOverrides });
		settings.setModelRole("advisor", `${model.provider}/${model.id}:${AUTO_THINKING}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
		});
		return session;
	}

	it("classifies each review independently of the primary and retunes the live advisor", async () => {
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel({ handler: { content: ["advisor ok"] } });
		const wire: string[] = [];
		const s = newSession(
			primary.stream,
			{
				"effort.rules": [{ selector: `${model.provider}/${model.id}`, allowed: [Effort.Low, Effort.High] }],
			},
			(m, context, options) => {
				wire.push(`${m.id}:${options?.reasoning}`);
				return advisorMock.stream(m, context, options);
			},
		);
		const classify = vi
			.spyOn(autoThinkingClassifier, "classifyDifficulty")
			.mockResolvedValueOnce(Effort.High)
			.mockResolvedValueOnce(Effort.Low);
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		const setModel = vi.spyOn(advisor, "setModel");
		const invalidate = advisor.appendOnlyContext
			? vi.spyOn(advisor.appendOnlyContext, "invalidateForModelChange")
			: undefined;

		await s.agent.prompt("first review");
		expect(await s.waitForAdvisorCatchup(2000)).toBe(true);
		expect(advisor.state.thinkingLevel).toBe(Effort.High);
		expect(wire).toEqual([`${model.id}:${Effort.High}`]);
		expect(classify.mock.calls[0]?.[1].model).toBe(model);
		expect(classify.mock.calls[0]?.[1].allowedEfforts).toEqual([Effort.Low, Effort.High]);

		s.setThinkingLevel(AUTO_THINKING);
		expect(advisor.state.thinkingLevel).toBe(Effort.High);
		await s.agent.prompt("second review");
		expect(await s.waitForAdvisorCatchup(2000)).toBe(true);
		expect(classify).toHaveBeenCalledTimes(2);
		expect(classify.mock.calls[1]?.[1].allowedEfforts).toEqual([Effort.Low, Effort.High]);
		expect(s.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBe(Effort.Low);
		expect(wire).toEqual([`${model.id}:${Effort.High}`, `${model.id}:${Effort.Low}`]);
		expect(setModel).not.toHaveBeenCalled();
		expect(invalidate?.mock.calls.length ?? 0).toBe(0);
		expect(s.formatAdvisorHistoryAsText()).toContain(`Thinking Level: ${Effort.Low}`);
	});

	it("isolates classifier failures from the review and uses the lowest permitted advisor effort", async () => {
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel({ handler: { content: ["advisor ok"] } });
		const wire: string[] = [];
		const s = newSession(
			primary.stream,
			{
				"effort.rules": [{ selector: `${model.provider}/${model.id}`, allowed: [Effort.High] }],
			},
			(m, context, options) => {
				wire.push(`${m.id}:${options?.reasoning}`);
				return advisorMock.stream(m, context, options);
			},
		);
		const classify = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("offline"));
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		await s.agent.prompt("review despite classifier outage");
		expect(await s.waitForAdvisorCatchup(2000)).toBe(true);
		expect(classify.mock.calls[0]?.[1].allowedEfforts).toEqual([Effort.High]);
		expect(wire).toEqual([`${model.id}:${Effort.High}`]);
		expect(s.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.High);
	});

	it("keeps a fixed retry-fallback effort isolated and reclassifies on return to the main model", async () => {
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel();
		const wire: string[] = [];
		let quotaFailed = false;
		const s = newSession(
			primary.stream,
			{
				"advisor.syncBacklog": "1",
				"retry.baseDelayMs": 5,
				"retry.fallbackChains": { advisor: ["google/gemini-2.5-flash:minimal"] },
				"effort.rules": [{ selector: `${model.provider}/${model.id}`, allowed: [Effort.Low, Effort.High] }],
			},
			(m, context, options) => {
				wire.push(`${m.id}:${options?.reasoning}`);
				if (m.id === model.id && !quotaFailed) {
					quotaFailed = true;
					advisorMock.push({
						throw: "Devin stream error failed_precondition: Your daily usage quota has been exhausted. Your quota will reset after 60s.",
					});
				} else {
					advisorMock.push({ content: ["advisor ok"] });
				}
				return advisorMock.stream(m, context, options);
			},
		);
		const classify = vi
			.spyOn(autoThinkingClassifier, "classifyDifficulty")
			.mockResolvedValueOnce(Effort.High)
			.mockResolvedValueOnce(Effort.Low);
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		const fellBack = Promise.withResolvers<void>();
		s.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fellBack.resolve();
		});
		const review = async (prompt: string) => {
			await s.agent.prompt(prompt);
			expect(await s.waitForAdvisorCatchup(5000)).toBe(true);
			return wire.at(-1);
		};

		await s.agent.prompt("quota fails over to the fallback");
		await fellBack.promise;
		expect(wire).toEqual([`${model.id}:${Effort.High}`, "gemini-2.5-flash:minimal"]);
		expect(classify).toHaveBeenCalledTimes(1);
		s.setThinkingLevel(Effort.High);
		expect(await review("primary now high")).toBe("gemini-2.5-flash:minimal");
		expect(classify).toHaveBeenCalledTimes(1);

		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
		expect(await review("cooldown expired")).toBe(`${model.id}:${Effort.Low}`);
		expect(classify).toHaveBeenCalledTimes(2);
		expect(classify.mock.calls[1]?.[1].model.id).toBe(model.id);
		expect(classify.mock.calls[1]?.[1].allowedEfforts).toEqual([Effort.Low, Effort.High]);
		expect(s.getAdvisorAgent()).toBe(advisor);
	});
});
