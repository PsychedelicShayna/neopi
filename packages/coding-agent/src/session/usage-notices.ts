import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { USAGE_REPORT_TTL_MS } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai/usage";

import type { Settings } from "../config/settings";
import template from "../prompts/system/agent-telemetry.md" with { type: "text" };
import {
	cfgTelemetryThresholdEvents,
	cfgUsageNoticesContextPercent,
	cfgUsageNoticesEnabled,
	cfgUsageNoticesQuotaPercent,
	cfgUsageNoticesRemainingPercent,
} from "../telemetry-settings";
import type { AgentContextTelemetry } from "./agent-telemetry";

export interface UsageNotice {
	type: "provider_quota" | "context_pressure" | "usage_unavailable";
	provider: string;
	window?: string;
	account?: string;
	usedPercent?: number;
	remainingPercent?: number;
	used?: number;
	remaining?: number;
	unit?: string;
	resetsAt?: number | null;
	cacheAgeMs: number | null;
	stale?: boolean;
	usedTokens?: number;
	compactionThresholdTokens?: number | null;
	headroomTokens?: number | null;
	deltaTokens?: number | null;
	estimated?: true;
	action: string;
}

/** Per-session crossings. No timers, invalidation, or force-refresh path. */
export class UsageNotices {
	#active = new Set<string>();
	#reports: UsageReport[] | null = null;
	#readAt = -Infinity;
	#previousContext: { key: string; tokens: number } | undefined;

	observe(reports: UsageReport[] | null, now = Date.now()): void {
		this.#reports = reports;
		this.#readAt = now;
	}

	async prepare(
		messages: AgentMessage[],
		settings: Settings,
		inspect: () => AgentContextTelemetry | undefined,
		read: () => Promise<UsageReport[] | null>,
		emit: (notice: UsageNotice) => void,
		now = Date.now(),
	): Promise<AgentMessage[]> {
		if (!cfgUsageNoticesEnabled.get(settings)) {
			this.#active.clear();
			this.#previousContext = undefined;
			return messages;
		}
		const context = inspect();
		if (!context) return messages;
		if (now - this.#readAt >= USAGE_REPORT_TTL_MS) {
			try {
				this.observe(await read(), now);
			} catch {
				this.observe(null, now);
			}
		}
		// Settings can be switched off while the broker read is in flight.
		if (!cfgUsageNoticesEnabled.get(settings)) return messages;
		const events: UsageNotice[] = [];
		const active = new Set<string>();
		const crossing = (key: string, notice: UsageNotice) => {
			active.add(key);
			if (!this.#active.has(key)) events.push(notice);
		};
		const provider = context.model.provider;
		const reports = this.#reports?.filter(report => report.provider === provider);
		if (!reports?.length) {
			crossing(`${provider}:unavailable`, {
				type: "usage_unavailable",
				provider,
				cacheAgeMs: null,
				action: "Usage could not be read or is unsupported. Open /usage to inspect or request a refresh.",
			});
		}
		for (const report of reports ?? []) {
			const cacheAgeMs = Number.isFinite(report.fetchedAt) ? Math.max(0, now - report.fetchedAt) : null;
			const stale = cacheAgeMs === null || cacheAgeMs >= USAGE_REPORT_TTL_MS;
			const account = String(report.metadata?.credentialId ?? report.metadata?.accountId ?? "");
			if (stale)
				crossing(`${provider}:${account}:stale`, {
					type: "usage_unavailable",
					provider,
					cacheAgeMs,
					stale,
					action: "Cached usage is stale. Open /usage to inspect provider availability or request a refresh.",
				});
			for (const limit of report.limits) {
				if (limit.scope.modelId && limit.scope.modelId !== context.model.id) continue;
				const fraction = resolveUsedFraction(limit);
				if (fraction === undefined || !Number.isFinite(fraction)) continue;
				const usedPercent = fraction * 100;
				const remainingPercent = Math.max(0, (1 - fraction) * 100);
				const base = `${provider}:${limit.scope.accountId ?? account}:${limit.id}:${limit.window?.resetsAt ?? ""}`;
				const notice: UsageNotice = {
					type: "provider_quota",
					provider,
					account: limit.scope.accountId || account || undefined,
					window: limit.window?.label ?? limit.label,
					usedPercent,
					remainingPercent,
					used: limit.amount.used,
					remaining: limit.amount.remaining,
					unit: limit.amount.unit,
					resetsAt: limit.window?.resetsAt ?? null,
					cacheAgeMs,
					stale,
					action: "Open /usage to inspect accounts and reset times; switch model or account if needed.",
				};
				if (usedPercent >= cfgUsageNoticesQuotaPercent.get(settings)) crossing(`${base}:used`, notice);
				if (remainingPercent <= cfgUsageNoticesRemainingPercent.get(settings) + 1e-9) {
					const key = `${base}:remaining`;
					active.add(key);
					if (!this.#active.has(key) && !events.includes(notice)) events.push(notice);
				}
			}
		}
		const occupancy = context.context;
		if (occupancy) {
			const key = `${provider}/${context.model.id}`;
			const previous = this.#previousContext;
			if (occupancy.percent >= cfgUsageNoticesContextPercent.get(settings)) {
				const threshold = context.compaction.thresholdTokens;
				crossing(`${key}:context`, {
					type: "context_pressure",
					provider,
					usedPercent: occupancy.percent,
					remainingPercent: Math.max(0, 100 - occupancy.percent),
					cacheAgeMs: 0,
					usedTokens: occupancy.usedTokens,
					compactionThresholdTokens: threshold,
					headroomTokens: threshold === null ? null : Math.max(0, threshold - occupancy.usedTokens),
					deltaTokens: previous?.key === key ? occupancy.usedTokens - previous.tokens : null,
					estimated: true,
					action: "Finish the current step or use /compact before adding large tool results.",
				});
			}
			this.#previousContext = { key, tokens: occupancy.usedTokens };
		}
		this.#active = active;
		for (const event of events) emit(event);
		if (!events.length || !cfgTelemetryThresholdEvents.get(settings)) return messages;
		return [
			...messages,
			{
				role: "custom",
				customType: "agent-usage-notices",
				content: renderPromptAsset("system/agent-telemetry.md", template, {
					json: JSON.stringify({ type: "usage_threshold_events", events }),
				}),
				display: false,
				attribution: "agent",
				timestamp: now,
			},
		];
	}
}
