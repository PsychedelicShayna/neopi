import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { saveCustomPersonality } from "../../src/neopi/personality-settings";
import type { AgentSession } from "../../src/session/agent-session";
import { cfgPersonality } from "../../src/session/settings";
import { describePersonalityCacheImpact, personalityCacheImpact } from "../../src/neopi/personality-cache";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "../../src/slash-commands/builtin-registry";

function fakeSession(options: { cached?: number; prompt?: string; cache?: boolean } = {}): AgentSession {
	const model = {
		provider: "test",
		id: "test-model",
		cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 },
		promptCache: options.cache ? {} : undefined,
	};
	const messages =
		options.cached === undefined
			? []
			: [
					{
						role: "assistant",
						provider: "test",
						model: "test-model",
						stopReason: "stop",
						usage: { cacheRead: options.cached, cacheWrite: 0 },
					},
				];
	return {
		model,
		messages,
		baseSystemPrompt: ["old prompt"],
		previewPersonalityPrompt: async () => [options.prompt ?? "new prompt"],
	} as unknown as AgentSession;
}

function runtime(session = fakeSession()) {
	const settings = Settings.isolated();
	saveCustomPersonality(settings, "global", "Warm", "custom voice");
	const showHookConfirm = vi.fn(async () => true);
	const showPersonalityManager = vi.fn();
	const showError = vi.fn();
	const ctx = {
		settings,
		session,
		editor: { setText: vi.fn() },
		sessionManager: { getCwd: () => process.cwd() },
		showHookConfirm,
		showPersonalityManager,
		showError,
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		settings,
		showHookConfirm,
		showPersonalityManager,
		showError,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

describe("/personality", () => {
	it("opens the manager and completes available custom names", async () => {
		const h = runtime();
		await executeBuiltinSlashCommand("/personality", h.runtime);
		expect(h.showPersonalityManager).toHaveBeenCalled();
		const completions = await lookupBuiltinSlashCommand("personality")?.getTuiArgumentCompletions?.("w", h.runtime);
		expect(completions?.map(item => [item.value, item.submitsCommand])).toEqual([["Warm", true]]);
	});

	it("switches the session without a warning before any response", async () => {
		const h = runtime();
		await executeBuiltinSlashCommand("/personality warm", h.runtime);
		expect(cfgPersonality.get(h.settings)).toBe("Warm");
		expect(h.settings.readScopeValue(cfgPersonality, "session")).toBe("Warm");
		expect(h.showHookConfirm).not.toHaveBeenCalled();
	});

	it("leaves the active selection untouched if a cache warning is declined", async () => {
		const h = runtime(fakeSession({ cached: 100_000 }));
		h.showHookConfirm.mockResolvedValue(false);
		await executeBuiltinSlashCommand("/personality Warm", h.runtime);
		expect(h.showHookConfirm).toHaveBeenCalled();
		expect(cfgPersonality.get(h.settings)).toBe("default");
	});
});

describe("personality cache impact", () => {
	it("estimates a possible cache miss from observed usage and rates", async () => {
		const impact = await personalityCacheImpact(fakeSession({ cached: 100_000 }), "new voice");
		expect(impact?.tokens).toBe(100_000);
		expect(impact?.apiEquivalentUsd).toBeCloseTo(1.1);
		expect(describePersonalityCacheImpact(impact!)).toContain("100,000");
	});

	it("does not warn when the candidate does not change the prompt", async () => {
		expect(
			await personalityCacheImpact(fakeSession({ cached: 100_000, prompt: "old prompt" }), "same voice"),
		).toBeUndefined();
	});

	it("admits uncertainty when a caching provider reports no cached token count", async () => {
		const impact = await personalityCacheImpact(fakeSession({ cached: 0, cache: true }), "new voice");
		expect(impact).toEqual({});
		expect(describePersonalityCacheImpact(impact!)).toContain("unknown");
	});
});
