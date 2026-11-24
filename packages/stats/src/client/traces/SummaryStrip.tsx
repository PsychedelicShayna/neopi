/**
 * Headline tiles for one trace: wall time split into model/tool/idle, then
 * turns, requests, tool calls, agents, tokens, cost.
 */

import { useTranslation } from "../i18n";
import { formatCompact, formatElapsed, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import type { TraceSummary } from "../types";
import { Stat, StatGrid } from "../ui";

export interface SummaryStripProps {
	summary: TraceSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
	const tr = useTranslation();
	const share = (ms: number) => (summary.wallMs > 0 ? `${formatPercent(ms / summary.wallMs)} of wall` : undefined);
	return (
		<StatGrid min={112}>
			<Stat
				size="sm"
				label={tr("pages.summarystrip.wall_time", "Wall time")}
				value={formatElapsed(summary.wallMs)}
			/>
			<Stat
				size="sm"
				label={tr("pages.summarystrip.model_time", "Model time")}
				value={formatElapsed(summary.modelMs)}
				hint={share(summary.modelMs)}
			/>
			<Stat
				size="sm"
				label={tr("pages.summarystrip.tool_time", "Tool time")}
				value={formatElapsed(summary.toolMs)}
				hint={share(summary.toolMs)}
			/>
			<Stat
				size="sm"
				label={tr("pages.summarystrip.idle", "Idle")}
				value={formatElapsed(summary.idleMs)}
				hint={share(summary.idleMs)}
			/>
			<Stat size="sm" label={tr("pages.summarystrip.turns", "Turns")} value={formatInteger(summary.turns)} />
			<Stat
				size="sm"
				label={tr("pages.summarystrip.requests", "Requests")}
				value={formatInteger(summary.requests)}
				hint={tr("pages.summarystrip.count_tool_calls", "{count} tool calls", {
					count: formatInteger(summary.toolCalls),
				})}
			/>
			<Stat size="sm" label={tr("pages.summarystrip.agents", "Agents")} value={formatInteger(summary.subagents)} />
			<Stat size="sm" label="Tokens" value={formatCompact(summary.totalTokens)} />
			<Stat
				size="sm"
				label={tr("pages.summarystrip.cost", "Cost")}
				value={formatEstimatedCost(summary.costTotal, summary.unpricedRequests)}
			/>
		</StatGrid>
	);
}
