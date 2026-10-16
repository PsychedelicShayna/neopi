/**
 * Per-agent usage record (#19): one shape for subagent progress, advisor stats,
 * and Agent Hub rows, accumulated from assistant-message usage by
 * {@link addAssistantUsage}, so every surface counts the same way.
 */
import type { Usage } from "@oh-my-pi/pi-ai";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { outputTokensPerSecond } from "../overlays/usage-row";

/** Timing of an agent's most recent completed request. */
export interface AgentRequestTiming {
	/** Time to first token, ms. */
	ttftMs?: number;
	/** Request wall duration, ms. */
	durationMs?: number;
	/** Output tokens per second over {@link durationMs}. */
	outputTokensPerSecond?: number;
}

export interface AgentUsage {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	/** Sum of provider-reported `totalTokens`. */
	total: number;
	/** Sum of provider-reported cost, USD. */
	cost: number;
	/** Assistant requests counted. */
	requests: number;
	/** Most recent request with timing data; absent until a provider reports any. */
	last?: AgentRequestTiming;
}

/** The usage-bearing part of an assistant message. */
export interface AssistantUsageSource {
	usage?: Partial<Usage> & { cost?: Partial<Usage["cost"]> };
	ttft?: number;
	duration?: number;
}

export function emptyAgentUsage(): AgentUsage {
	return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 };
}

function count(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function positive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Add one completed assistant request to `into`. */
export function addAssistantUsage(into: AgentUsage, message: AssistantUsageSource): void {
	const usage = message.usage;
	if (!usage) return;
	const output = count(usage.output);
	into.input += count(usage.input);
	into.output += output;
	into.reasoning += count(usage.reasoningTokens);
	into.cacheRead += count(usage.cacheRead);
	into.cacheWrite += count(usage.cacheWrite);
	into.total += count(usage.totalTokens);
	into.cost += count(usage.cost?.total);
	into.requests++;
	const ttftMs = positive(message.ttft);
	const durationMs = positive(message.duration);
	if (ttftMs === undefined && durationMs === undefined) return;
	into.last = {
		ttftMs,
		durationMs,
		outputTokensPerSecond: outputTokensPerSecond(output, durationMs),
	};
}

/** Usage of every assistant message in a transcript. */
export function agentUsageFromMessages(messages: ReadonlyArray<{ role: string } & AssistantUsageSource>): AgentUsage {
	const usage = emptyAgentUsage();
	for (const message of messages) {
		if (message.role === "assistant") addAssistantUsage(usage, message);
	}
	return usage;
}

/** One-line token split and last-request timing, e.g. `in 12K · out 4.5K · reasoning 2K · ttft 820ms · 45 tok/s`. */
export function formatAgentUsageBreakdown(usage: AgentUsage): string {
	const parts = [`in ${formatNumber(usage.input)}`, `out ${formatNumber(usage.output)}`];
	if (usage.reasoning > 0) parts.push(`reasoning ${formatNumber(usage.reasoning)}`);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		parts.push(`cache ${formatNumber(usage.cacheRead)} read / ${formatNumber(usage.cacheWrite)} write`);
	}
	const last = usage.last;
	if (last?.ttftMs !== undefined) parts.push(`ttft ${formatDuration(last.ttftMs)}`);
	if (last?.outputTokensPerSecond !== undefined) parts.push(`${Math.round(last.outputTokensPerSecond)} tok/s`);
	return parts.join(" · ");
}
