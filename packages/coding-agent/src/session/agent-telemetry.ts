import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	addAssistantUsage,
	agentUsageFromMessages,
	emptyAgentUsage,
	type AgentUsage,
} from "@oh-my-pi/pi-tui/tools/agent-usage";

import type { Settings } from "../config/settings";
import type { ContextUsage } from "../extensibility/extensions/types";
import template from "../prompts/system/agent-telemetry.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import { cfgTelemetryAgentContext, cfgTelemetryThresholdEvents, cfgTelemetryToolResults } from "../telemetry-settings";
import type { AgentSession } from "./agent-session";
import { readToolExecutionStart } from "./exit-diagnostics";
import { getSessionCompactionBoundaries } from "./context-usage-runtime";
import type { SessionEntry } from "./session-entries";

export interface AgentContextTelemetry {
	type: "agent_context";
	model: { provider: string; id: string; effort: string | null };
	context: { usedTokens: number; limitTokens: number; percent: number; estimated: true } | null;
	compaction: {
		enabled: boolean;
		thresholdTokens: number | null;
		speculationStartsAtTokens: number | null;
		state: "idle" | "running" | "armed" | "compacting";
	};
	checkpoint: { active: boolean; available: boolean };
	/** Local token estimate for retained messages from the latest user message onward. */
	recentTurnFootprint: {
		tokens: number;
		messages: number;
		scope: "latest_user_turn";
		estimated: true;
	} | null;
	/** One completed model request, not the cumulative session ledger. */
	previousTurn: AgentUsage | null;
	fleet: { running: number; idle: number; parked: number; aborted: number };
	events?: {
		type: "approaching_compaction";
		headroomTokens: number;
		estimated: true;
		checkpointAvailable: boolean;
	}[];
	full?: {
		usage: AgentUsage;
		cacheReadPercent: number | null;
		cost: { main: number; advisors: number };
		agents: { id: string; status: string; context: ContextUsage | null; usage: AgentUsage | null }[];
	};
}

export interface AgentTelemetryHost {
	session: Pick<
		AgentSession,
		| "messages"
		| "agent"
		| "model"
		| "thinkingLevel"
		| "getContextUsage"
		| "isCompacting"
		| "compactionSpeculation"
		| "autoCompactionEnabled"
		| "getCheckpointState"
		| "getEnabledToolNames"
		| "getAdvisorCost"
	>;
	settings: Settings;
	registry?: AgentRegistry;
	agentId?: string;
	entries(): readonly SessionEntry[];
}

/** Reads the same local counters as the rail and shared per-agent usage surfaces. */
export function inspectAgentTelemetry(
	host: AgentTelemetryHost,
	includeFull = cfgTelemetryAgentContext.get(host.settings) === "full",
): AgentContextTelemetry | undefined {
	const { session, settings, registry, agentId } = host;
	const model: Model | undefined = session.model;
	if (!model) return undefined;
	const context = session.getContextUsage();
	const boundaries = context ? getSessionCompactionBoundaries(settings, context.contextWindow, model) : null;
	const threshold =
		boundaries && context ? Math.round((boundaries.thresholdPercent / 100) * context.contextWindow) : null;
	const speculationStartsAt =
		boundaries?.speculationPercent != null && context
			? Math.round((boundaries.speculationPercent / 100) * context.contextWindow)
			: null;
	const previous = session.messages.findLast(message => message.role === "assistant");
	const checkpointActive = session.getCheckpointState() !== undefined;
	const enabledTools = session.getEnabledToolNames();
	const checkpointAvailable =
		!checkpointActive && enabledTools.includes("checkpoint") && enabledTools.includes("rewind");
	const turnStart = session.messages.findLastIndex(message => message.role === "user");
	let turnTokens = 0;
	if (turnStart !== -1) {
		for (let index = turnStart; index < session.messages.length; index++) {
			turnTokens += session.agent.tokenizer.countMessage(session.messages[index]!);
		}
	}
	const refs =
		registry?.list().filter(ref => {
			if (ref.kind !== "main" && ref.kind !== "sub" && ref.kind !== "advisor") return false;
			return registry.isInRootTree(ref.id, agentId ? registry.rootOf(agentId) : undefined);
		}) ?? [];
	const fleet = { running: 0, idle: 0, parked: 0, aborted: 0 };
	for (const ref of refs) fleet[ref.status]++;
	const record: AgentContextTelemetry = {
		type: "agent_context",
		model: { provider: model.provider, id: model.id, effort: session.thinkingLevel ?? null },
		context: context
			? {
					usedTokens: context.tokens,
					limitTokens: context.contextWindow,
					percent: Math.round(context.percent * 10) / 10,
					estimated: true,
				}
			: null,
		compaction: {
			enabled: session.autoCompactionEnabled && boundaries !== null,
			thresholdTokens: threshold,
			speculationStartsAtTokens: speculationStartsAt,
			state: session.isCompacting ? "compacting" : session.compactionSpeculation,
		},
		checkpoint: { active: checkpointActive, available: checkpointAvailable },
		recentTurnFootprint:
			turnStart === -1
				? null
				: {
						tokens: turnTokens,
						messages: session.messages.length - turnStart,
						scope: "latest_user_turn",
						estimated: true,
					},
		previousTurn: previous ? agentUsageFromMessages([previous]) : null,
		fleet,
	};
	if (
		cfgTelemetryThresholdEvents.get(settings) &&
		session.autoCompactionEnabled &&
		context &&
		threshold !== null &&
		context.tokens >= (speculationStartsAt ?? threshold)
	) {
		record.events = [
			{
				type: "approaching_compaction",
				headroomTokens: Math.max(0, threshold - context.tokens),
				estimated: true,
				checkpointAvailable,
			},
		];
	}
	if (includeFull) {
		const usage = emptyAgentUsage();
		for (const entry of host.entries()) {
			if (entry.type === "message" && entry.message.role === "assistant") addAssistantUsage(usage, entry.message);
		}
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		record.full = {
			usage,
			cacheReadPercent: promptTokens > 0 ? Math.round((usage.cacheRead / promptTokens) * 1_000) / 10 : null,
			cost: { main: usage.cost, advisors: session.getAdvisorCost() },
			agents: refs.map(ref => ({
				id: ref.id,
				status: ref.status,
				context: ref.session?.getContextUsage() ?? null,
				usage: ref.session
					? agentUsageFromMessages(ref.session.messages)
					: (ref.history?.metrics?.agentUsage ?? null),
			})),
		};
	}
	return record;
}

/** Transient provider projection: never persists telemetry or rewrites tool payloads in storage. */
export function injectAgentTelemetry(messages: AgentMessage[], host: AgentTelemetryHost): AgentMessage[] {
	const contextMode = cfgTelemetryAgentContext.get(host.settings);
	const toolMode = cfgTelemetryToolResults.get(host.settings);
	const thresholdEvents = cfgTelemetryThresholdEvents.get(host.settings);
	// This exact identity fast path also avoids traversing transcripts, fleet, or counters.
	if (contextMode === "off" && toolMode === "off" && !thresholdEvents) return messages;
	const record = inspectAgentTelemetry(host, contextMode === "full" || toolMode === "full");
	if (!record) return messages;
	let projected = messages;
	if (toolMode !== "off") {
		const lastAssistant = messages.findLastIndex(message => message.role === "assistant");
		const starts = new Map<string, number>();
		for (const entry of host.entries()) {
			const start = readToolExecutionStart(entry);
			if (start) starts.set(start.toolCallId, Date.parse(start.startedAt));
		}
		projected = messages.map((message, index) => {
			if (index <= lastAssistant || message.role !== "toolResult") return message;
			const startedAt = starts.get(message.toolCallId);
			const durationMs =
				startedAt !== undefined && Number.isFinite(startedAt) ? Math.max(0, message.timestamp - startedAt) : null;
			const value = {
				type: "tool_telemetry",
				tool: message.toolName,
				isError: message.isError,
				durationMs,
				...(toolMode === "full" ? { runtime: record } : {}),
			};
			return { ...message, content: [...message.content, { type: "text", text: renderTelemetry(value) }] };
		});
	}
	if (contextMode !== "off" || (thresholdEvents && record.events)) {
		const value =
			contextMode === "off"
				? { type: "agent_threshold_events", events: record.events }
				: contextMode === "minimal" && record.full
					? { ...record, full: undefined }
					: record;
		projected = [
			...projected,
			{
				role: "custom",
				customType: "agent-runtime-telemetry",
				content: renderTelemetry(value),
				display: false,
				attribution: "agent",
				timestamp: messages.at(-1)?.timestamp ?? 0,
			},
		];
	}
	return projected;
}

function renderTelemetry(value: object): string {
	return renderPromptAsset("system/agent-telemetry.md", template, { json: JSON.stringify(value) });
}
