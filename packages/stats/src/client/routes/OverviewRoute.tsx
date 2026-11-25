import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { getOverviewStats, getRecentRequests } from "../api";
import { Legend, ShareBar, TimeChart } from "../charts";
import { OTHER_COLOR } from "../data/colors";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatMessageCost,
	formatPercent,
	formatRelativeTime,
	formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import {
	buildDecisionModelShare,
	buildUsageTokenShare,
	sumConversationTokens,
	type TokenShareSegment,
	type TokenShareView,
} from "../data/view-models";
import { useTranslation, useLocale } from "../i18n";
import type { AgentType, Locale, MessageStats, TimeRange } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	Dot,
	LabelCell,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";

export interface OverviewRouteProps {
	active: boolean;
	range: TimeRange;
	onRequestClick: (id: number) => void;
}

type ActivityMetric = "requests" | "tokens" | "cost";

const ACTIVITY_OPTIONS = [
	{ value: "requests" as const, label: "Requests" },
	{ value: "tokens" as const, label: "Tokens" },
	{ value: "cost" as const, label: "Cost" },
];

const AGENT_LABEL: Record<AgentType, string> = { main: "Main agent", subagent: "Subagents", advisor: "Advisor" };
const AGENT_COLOR: Record<AgentType, string> = {
	main: "var(--chart-primary)",
	subagent: "var(--chart-secondary)",
	advisor: "#9d7bff",
};

const TOKEN_MIX = [
	{ key: "input", label: "Uncached input", color: "#5b8cff" },
	{ key: "cacheRead", label: "Cache read", color: "var(--chart-primary)" },
	{ key: "cacheWrite", label: "Cache write", color: "#f5b54a" },
	{ key: "output", label: "Output", color: "var(--chart-secondary)" },
] as const;

export function OverviewRoute({ active, range, onRequestClick }: OverviewRouteProps) {
	const locale = useLocale();
	const tr = useTranslation();
	const overview = useQuery(["overview", range], ({ signal }) => getOverviewStats(range, signal), { enabled: active });
	const recent = useQuery(["recent-requests"], ({ signal }) => getRecentRequests(12, signal), { enabled: active });
	const [metric, setMetric] = useState<ActivityMetric>("requests");
	const columns = useMemo(() => requestColumns(tr, locale), [tr, locale]);
	const meta = rangeMeta(range);

	const series = useMemo(() => {
		const points = overview.data?.timeSeries ?? [];
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
		);
		return {
			buckets,
			requests: densify(points, buckets, p => p.requests - p.errors),
			errors: densify(points, buckets, p => p.errors),
			tokens: densify(points, buckets, p => p.tokens),
			cost: densify(points, buckets, p => p.cost),
			all: densify(points, buckets, p => p.requests),
		};
	}, [overview.data, range]);

	const attribution = useMemo(() => {
		const data = overview.data;
		if (!data) return null;
		return {
			usage: buildUsageTokenShare(data.byAgentType, data.bySideChannel),
			decisions: buildDecisionModelShare(data.bySideChannel),
		};
	}, [overview.data]);

	const chartSeries =
		metric === "requests"
			? [
					{
						key: "ok",
						label: tr("overview.succeeded", "Succeeded"),
						color: "var(--chart-primary)",
						values: series.requests,
					},
					{ key: "err", label: tr("common.failed", "Failed"), color: "var(--bad)", values: series.errors },
				]
			: metric === "tokens"
				? [
						{
							key: "tokens",
							label: tr("common.tokens", "Tokens"),
							color: "var(--chart-primary)",
							values: series.tokens,
						},
					]
				: [
						{
							key: "cost",
							label: tr("overview.api_equivalent", "API-equivalent"),
							color: "var(--chart-secondary)",
							values: series.cost,
						},
					];

	return (
		<div className="page">
			<PageHeader
				title={tr("nav.overview", "Overview")}
				description={tr("overview.description", "Everything omp did across your sessions in {window}.").replace(
					"{window}",
					tr(`costs.window.${range}`, meta.windowLabel),
				)}
			/>

			<QueryView query={overview} skeleton={<ChartSkeleton height={112} />}>
				{({ overall }) => (
					<div data-stale={overview.stale} className="stack" style={{ gap: 16 }}>
						<StatGrid min={190}>
							<Stat
								label={tr("overview.api_cost", "API-equivalent cost")}
								title={tr("costs.estimate_title", "What this usage would cost at public API rates")}
								value={formatEstimatedCost(overall.totalCost, overall.unpricedRequests)}
								hint={
									overall.unpricedRequests > 0
										? tr("overview.unpriced", "{count} unpriced").replace(
												"{count}",
												formatInteger(overall.unpricedRequests),
											)
										: undefined
								}
								spark={series.cost}
								sparkColor="var(--chart-secondary)"
							/>
							<Stat
								label={tr("nav.requests", "Requests")}
								value={formatInteger(overall.totalRequests)}
								hint={tr("overview.failed_count", "{count} failed").replace(
									"{count}",
									formatInteger(overall.failedRequests),
								)}
								spark={series.all}
							/>
							<Stat
								label={tr("overview.conversation_tokens", "Conversation tokens")}
								title={tr(
									"overview.conversation_tokens_hint",
									"Uncached input + cache reads + cache writes + output",
								)}
								value={formatCompact(sumConversationTokens(overall))}
								hint={tr("overview.output_count", "{count} output").replace(
									"{count}",
									formatCompact(overall.totalOutputTokens),
								)}
								spark={series.tokens}
							/>
							<Stat
								label={tr("overview.cache_rate", "Cache rate")}
								title={tr("overview.cache_rate_hint", "Cache reads ÷ (uncached input + cache reads)")}
								value={formatPercent(overall.cacheRate)}
								hint={tr("overview.saved", "{percent} saved").replace(
									"{percent}",
									formatPercent(overall.cacheSavings),
								)}
							/>
							<Stat
								label={tr("overview.error_rate", "Error rate")}
								value={formatErrorRate(overall.errorRate)}
								hint={tr("overview.succeeded_count", "{count} succeeded").replace(
									"{count}",
									formatInteger(overall.successfulRequests),
								)}
								spark={series.errors}
								sparkColor="var(--bad)"
							/>
						</StatGrid>
						<StatGrid min={140}>
							<Stat
								size="sm"
								label={tr("overview.token_input", "Uncached input")}
								value={formatCompact(overall.totalInputTokens)}
							/>
							<Stat
								size="sm"
								label={tr("components.costCacheRead", "Cache read")}
								value={formatCompact(overall.totalCacheReadTokens)}
							/>
							<Stat
								size="sm"
								label={tr("components.costCacheWrite", "Cache write")}
								value={formatCompact(overall.totalCacheWriteTokens)}
							/>
							<Stat
								size="sm"
								label={tr("components.costOutput", "Output")}
								value={formatCompact(overall.totalOutputTokens)}
							/>
							<Stat
								size="sm"
								label={tr("overview.premium", "Premium requests")}
								value={formatInteger(Math.round(overall.totalPremiumRequests * 100) / 100)}
							/>
							<Stat
								size="sm"
								label={tr("overview.tokens_per_second", "Tokens/s")}
								value={formatTokensPerSecond(overall.avgTokensPerSecond)}
							/>
							<Stat
								size="sm"
								label={tr("overview.average_latency", "Avg latency")}
								value={formatDurationMs(overall.avgDuration)}
							/>
							<Stat
								size="sm"
								label={tr("overview.average_ttft", "Avg TTFT")}
								value={formatDurationMs(overall.avgTtft)}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-main-side">
				<Card
					index={1}
					title={tr("nav.activity", "Activity")}
					description={
						meta.bucketMs < 3_600_000
							? tr("overview.per_5m", "Per 5 minutes")
							: meta.bucketMs < 86_400_000
								? tr("overview.per_hour", "Per hour")
								: tr("overview.per_day", "Per day")
					}
					actions={
						<Segmented
							size="sm"
							options={ACTIVITY_OPTIONS.map(option => ({
								...option,
								label: tr(`overview.activity_${option.value}`, option.label),
							}))}
							value={metric}
							onChange={setMetric}
						/>
					}
					stale={overview.stale}
				>
					<QueryView query={overview} skeleton={<ChartSkeleton height={260} />}>
						{() => (
							<TimeChart
								buckets={series.buckets}
								bucketMs={meta.bucketMs}
								series={chartSeries}
								height={260}
								format={metric === "cost" ? v => formatEstimatedCost(v, 0) : formatCompact}
							/>
						)}
					</QueryView>
				</Card>

				<Card
					index={2}
					title={tr("overview.token_mix", "Token mix")}
					description={tr("overview.token_mix_hint", "Where conversation tokens went")}
					stale={overview.stale}
				>
					<QueryView query={overview} skeleton={<ChartSkeleton height={260} />}>
						{({ overall }) => {
							const mix = {
								input: overall.totalInputTokens,
								cacheRead: overall.totalCacheReadTokens,
								cacheWrite: overall.totalCacheWriteTokens,
								output: overall.totalOutputTokens,
							};
							const total = sumConversationTokens(overall);
							return (
								<div className="stack" style={{ gap: 18 }}>
									<div className="stack" style={{ gap: 10 }}>
										<ShareBar
											segments={TOKEN_MIX.map(t => ({
												key: t.key,
												label: tr(`overview.token_${t.key}`, t.label),
												value: mix[t.key],
												color: t.color,
											}))}
										/>
										<Legend
											items={TOKEN_MIX.map(t => ({
												key: t.key,
												label: tr(`overview.token_${t.key}`, t.label),
												color: t.color,
												value: total > 0 ? formatPercent(mix[t.key] / total, 0) : "–",
											}))}
										/>
									</div>
									{attribution && (
										<div className="stack" style={{ gap: 10 }}>
											<div className="section-label" style={{ marginBottom: 0 }}>
												By source
											</div>
											<ShareBreakdown view={attribution.usage} />
										</div>
									)}
								</div>
							);
						}}
					</QueryView>
				</Card>
			</div>

			{attribution && attribution.decisions.segments.length > 0 && (
				<Card
					index={3}
					title={tr("overview.decision_models", "Decision models")}
					description={tr("overview.decision_models_hint", "Where decision-model tokens went, by use case")}
					stale={overview.stale}
				>
					<ShareBreakdown view={attribution.decisions} wide />
				</Card>
			)}

			<Card
				index={4}
				title={
					<>
						<Dot tone="live" pulse /> {tr("overview.recent", "Latest requests")}
					</>
				}
				description={tr("overview.recent_hint", "Most recent model calls across every session")}
				actions={
					<a className="btn" data-size="sm" data-variant="ghost" href={`#/requests?range=${range}`}>
						All requests <ArrowRight size={13} />
					</a>
				}
				flush
			>
				<QueryView query={recent} skeleton={<TableSkeleton rows={8} />}>
					{rows => (
						<Table
							rows={rows}
							rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
							onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
							columns={columns}
							dense
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function segmentLabel(segment: TokenShareSegment): string {
	if (segment.kind === "agent") return AGENT_LABEL[segment.agentType];
	return segment.category.charAt(0).toUpperCase() + segment.category.slice(1);
}

function segmentColor(segment: TokenShareSegment, colors: ReadonlyMap<string, string>): string {
	if (segment.kind === "agent") return AGENT_COLOR[segment.agentType];
	return colors.get(segment.category) ?? OTHER_COLOR;
}

/**
 * A share bar over one row per segment: swatch, label, requests, tokens, percent of the bar.
 * `wide` lays the rows out in columns, for a card that spans the page.
 */
function ShareBreakdown({ view, wide = false }: { view: TokenShareView; wide?: boolean }) {
	const { segments, categoryColors } = view;
	return (
		<div className="stack" style={{ gap: 10 }}>
			<ShareBar
				segments={segments.map(s => ({
					key: s.key,
					label: segmentLabel(s),
					value: s.tokens,
					color: segmentColor(s, categoryColors),
				}))}
			/>
			<div className={wide ? "grid grid-3" : "stack"} style={{ gap: wide ? "10px 28px" : 10 }}>
				{segments.map(s => (
					<div key={s.key} className="row" style={{ justifyContent: "space-between" }}>
						<span className="row" style={{ minWidth: 0 }}>
							<span className="swatch" style={{ background: segmentColor(s, categoryColors) }} />
							<span className="truncate">{segmentLabel(s)}</span>
							<span className="dim num" style={{ flexShrink: 0 }}>
								{formatInteger(s.requests)} req
							</span>
						</span>
						<span className="row" style={{ flexShrink: 0 }}>
							<span className="dim num">{formatCompact(s.tokens)}</span>
							<span className="num" style={{ minWidth: 48, textAlign: "right" }}>
								{formatPercent(s.share)}
							</span>
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function requestColumns(tr: (key: string, english: string) => string, locale: Locale) {
	return [
		{
			key: "model",
			header: tr("common.model", "Model"),
			render: (row: MessageStats) => <LabelCell primary={row.model} secondary={row.provider} />,
		},
		{
			key: "time",
			header: tr("overview.when", "When"),
			render: (row: MessageStats) => <span className="muted">{formatRelativeTime(row.timestamp, locale)}</span>,
		},
		{
			key: "tokens",
			header: tr("common.tokens", "Tokens"),
			align: "right" as const,
			render: (row: MessageStats) => <span className="num">{formatInteger(row.usage.totalTokens)}</span>,
		},
		{
			key: "cost",
			header: tr("common.cost", "Cost"),
			align: "right" as const,
			render: (row: MessageStats) => <span className="num">{formatMessageCost(row, 4)}</span>,
		},
		{
			key: "duration",
			header: tr("common.duration", "Duration"),
			align: "right" as const,
			render: (row: MessageStats) => <span className="num">{formatDurationMs(row.duration)}</span>,
		},
		{
			key: "status",
			header: tr("common.status", "Status"),
			align: "right" as const,
			render: (row: MessageStats) =>
				row.errorMessage ? <Badge tone="bad">{tr("common.failed", "Failed")}</Badge> : <Badge tone="ok">OK</Badge>,
		},
	];
}
