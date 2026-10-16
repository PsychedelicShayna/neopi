import { describe, expect, it } from "bun:test";
import { addAssistantUsage, emptyAgentUsage } from "@oh-my-pi/pi-tui/tools/agent-usage";

function usageAfter(duration: number) {
	const usage = emptyAgentUsage();
	addAssistantUsage(usage, {
		usage: {
			input: 10,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		ttft: 20,
		duration,
	});
	return usage;
}

describe("agent usage throughput", () => {
	it("reports no rate for a request too short to measure, keeping its timing", () => {
		expect(usageAfter(80).last).toEqual({ ttftMs: 20, durationMs: 80, outputTokensPerSecond: undefined });
		expect(usageAfter(100).last?.outputTokensPerSecond).toBeUndefined();
	});

	it("reports output tokens per second over the whole request once it is long enough", () => {
		expect(usageAfter(4000).last?.outputTokensPerSecond).toBe(50);
	});
});
