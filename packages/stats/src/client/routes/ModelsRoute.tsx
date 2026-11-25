import { LocalizedText, useTranslation, useLocale } from "../i18n";
import type { Translation } from "../types";
import "./models.css";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { getModelDashboardStats } from "../api";
import { type ChartSeries, Legend, Sparkline, TimeChart, useHiddenSeries } from "../charts";
import { buildModelColorLookup, modelKey, OTHER_COLOR } from "../data/colors";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
	formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, localizeGroupedSeries, pivotSeries } from "../data/series";
import {
	buildModelPerformanceLookup,
	type ModelPerformanceDataPoint,
	sumConversationTokens,
} from "../data/view-models";
import type { ModelDashboardStats, ModelStats, TimeRange } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	KeyValues,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Skeleton,
	Stat,
	StatGrid,
	Swatch,
	Table,
	TableSkeleton,
} from "../ui";

export interface ModelsRouteProps {
	active: boolean;
	range: TimeRange;
}

type ShareMode = "share" | "requests";

const SHARE_OPTIONS = [
	{ value: "share" as const, label: <LocalizedText messageKey="pages.models.share" english={"Share"} /> },
	{ value: "requests" as const, label: <LocalizedText messageKey="pages.models.requests" english={"Requests"} /> },
];

/** Models plotted individually in the share chart; the rest fold into "Other". */
const SHARE_LIMIT = 6;

export function ModelsRoute({ active, range }: ModelsRouteProps) {
	const tr = useTranslation();
	const query = useQuery(["models", range], ({ signal }) => getModelDashboardStats(range, signal), {
		enabled: active,
	});
	const meta = rangeMeta(range);
	const [mode, setMode] = useState<ShareMode>("share");
	const [hidden, toggleSeries] = useHiddenSeries();
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const view = useMemo(() => (query.data ? buildModelsView(query.data, range) : null), [query.data, range]);
	const bucket = bucketName(meta.bucketMs);
	const bucketWord = tr(`pages.period.${bucket.replace(" ", "_")}`, bucket);
	// Stable columns: a fresh array would make Table re-sort on every render.
	const columns = useMemo(
		() => (view ? buildModelColumns(view, expandedKey, bucketWord, tr) : []),
		[view, expandedKey, bucketWord, tr],
	);
	const isEmpty = (data: ModelDashboardStats) => data.byModel.length === 0;
	const empty = (
		<EmptyState
			title={tr("pages.models.no_model_usage_in_this_range", "No model usage in this range")}
			hint={tr("pages.models.pick_a_wider_range_in_the_top", "Pick a wider range in the top bar.")}
		/>
	);

	return (
		<div className="page">
			<PageHeader
				title={tr("pages.models.models", "Models")}
				description={tr(
					"pages.models.which_models_did_the_work_in_window",
					"Which models did the work in {window}, and how fast they answered.",
					{ window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
			/>

			<QueryView
				query={query}
				skeleton={<Skeleton height={112} style={{ borderRadius: 12 }} />}
				isEmpty={isEmpty}
				empty={empty}
			>
				{() =>
					view && (
						<div data-stale={query.stale}>
							<StatGrid min={200}>
								<Stat
									label={tr("pages.models.models_used", "Models used")}
									value={formatInteger(view.models.length)}
									hint={tr("pages.models.across_count_provider_plural", "across {count} provider{plural}", {
										count: formatInteger(view.providerCount),
										plural: view.providerCount === 1 ? "" : "s",
									})}
								/>
								<Stat
									label={tr("pages.models.most_used", "Most used")}
									title={view.top ? `${view.top.model} (${view.top.provider})` : undefined}
									value={view.top ? view.top.model : "–"}
									hint={
										view.top
											? tr("pages.models.share_of_requests_provider", "{share} of requests · {provider}", {
													share: formatPercent(view.top.totalRequests / Math.max(1, view.totalRequests)),
													provider: view.top.provider,
												})
											: undefined
									}
								/>
								<Stat
									label={tr("pages.models.requests", "Requests")}
									value={formatInteger(view.totalRequests)}
									hint={tr("pages.models.count_failed", "{count} failed", {
										count: formatInteger(view.failedRequests),
									})}
									spark={view.requestTotals}
								/>
								<Stat
									label={tr("pages.models.api_equivalent_cost", "API-equivalent cost")}
									title={tr(
										"pages.models.what_this_usage_would_cost_at_public",
										"What this usage would cost at public API rates",
									)}
									value={formatEstimatedCost(view.totalCost, view.unpricedRequests)}
									hint={
										view.unpricedRequests > 0
											? tr("pages.models.count_unpriced", "{count} unpriced", {
													count: formatInteger(view.unpricedRequests),
												})
											: undefined
									}
								/>
							</StatGrid>
						</div>
					)
				}
			</QueryView>

			<Card
				index={1}
				title={tr("pages.models.request_share", "Request share")}
				description={
					mode === "share"
						? tr(
								"pages.models.each_models_share_of_requests_per_bucket",
								"Each model's share of requests per {bucket}",
								{ bucket: bucketWord },
							)
						: tr("pages.models.requests_per_bucket_stacked_by_model", "Requests per {bucket}, stacked by model", {
								bucket: bucketWord,
							})
				}
				actions={
					<Segmented
						size="sm"
						options={SHARE_OPTIONS}
						value={mode}
						onChange={setMode}
						aria-label={tr("pages.models.share_chart_mode", "Share chart mode")}
					/>
				}
				stale={query.stale}
			>
				<QueryView query={query} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={empty}>
					{() =>
						view && (
							<div className="stack" style={{ gap: 12 }}>
								<TimeChart
									buckets={view.buckets}
									bucketMs={meta.bucketMs}
									series={localizeGroupedSeries(mode === "share" ? view.shareSeries : view.countSeries, tr)}
									hidden={hidden}
									height={260}
									yMax={mode === "share" ? 1 : undefined}
									format={mode === "share" ? v => formatPercent(v, 0) : formatCompact}
									formatTooltip={mode === "share" ? v => formatPercent(v) : formatInteger}
									showTotal={mode === "requests"}
								/>
								<Legend
									items={localizeGroupedSeries(view.countSeries, tr).map(s => ({
										key: s.key,
										label: s.label,
										color: s.color,
										value: formatPercent(sumValues(s.values) / Math.max(1, sumValues(view.requestTotals))),
									}))}
									hidden={hidden}
									onToggle={toggleSeries}
								/>
							</div>
						)
					}
				</QueryView>
			</Card>

			<Card
				index={2}
				title={tr("pages.models.all_models", "All models")}
				description={tr(
					"pages.models.click_a_row_for_latency_and_throughput",
					"Click a row for latency and throughput over time",
				)}
				stale={query.stale}
				flush
			>
				<QueryView query={query} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={empty}>
					{() =>
						view && (
							<Table
								rows={view.models}
								rowKey={row => modelKey(row.model, row.provider)}
								columns={columns}
								initialSort={{ key: "requests", dir: "desc" }}
								limit={25}
								onRowClick={row => {
									const key = modelKey(row.model, row.provider);
									setExpandedKey(prev => (prev === key ? null : key));
								}}
								selectedKey={expandedKey}
								expanded={row => {
									const key = modelKey(row.model, row.provider);
									return key === expandedKey ? (
										<ModelDetail
											model={row}
											color={view.swatches.get(key) ?? "var(--chart-primary)"}
											points={view.performance.get(key) ?? []}
											bucketMs={meta.bucketMs}
											bucketWord={bucketWord}
										/>
									) : null;
								}}
							/>
						)
					}
				</QueryView>
			</Card>
		</div>
	);
}

interface ModelsView {
	models: ModelStats[];
	top: ModelStats | undefined;
	/** Chart color of each individually plotted model; the rest share "Other" gray. */
	swatches: Map<string, string>;
	labels: Map<string, string>;
	providerCount: number;
	totalRequests: number;
	failedRequests: number;
	totalCost: number;
	unpricedRequests: number;
	maxRequests: number;
	buckets: number[];
	requestTotals: number[];
	/** Top-N + Other requests per bucket (stacked counts). */
	countSeries: ChartSeries[];
	/** `countSeries` as a fraction of each bucket's total. */
	shareSeries: ChartSeries[];
	/** Dense requests per bucket for every model, for the table sparkline. */
	trends: Map<string, readonly (number | null)[]>;
	performance: Map<string, ModelPerformanceDataPoint[]>;
}

function buildModelsView(data: ModelDashboardStats, range: TimeRange): ModelsView {
	const models = data.byModel;
	const colors = buildModelColorLookup(models);
	const labels = modelLabels(models);
	const buckets = bucketAxis(
		range,
		data.modelSeries.map(p => p.timestamp),
	);
	const requestTotals = densify(data.modelSeries, buckets, p => p.requests);
	const pivot = {
		buckets,
		key: (p: { model: string; provider: string }) => modelKey(p.model, p.provider),
		label: (key: string) => labels.get(key) ?? key,
		value: (p: { requests: number }) => p.requests,
		colors,
	};
	// Zero slots become gaps so tooltips list only the models active in that bucket.
	const countSeries = pivotSeries(data.modelSeries, { ...pivot, limit: SHARE_LIMIT }).map(s => ({
		...s,
		values: s.values.map(v => v || null),
	}));
	const shareSeries = countSeries.map(s => ({
		...s,
		values: s.values.map((v, i) => (v === null ? null : v / requestTotals[i])),
	}));
	const trends = new Map(pivotSeries(data.modelSeries, pivot).map(s => [s.key, s.values]));

	let top: ModelStats | undefined;
	let totalRequests = 0;
	let failedRequests = 0;
	let totalCost = 0;
	let unpricedRequests = 0;
	for (const m of models) {
		if (!top || m.totalRequests > top.totalRequests) top = m;
		totalRequests += m.totalRequests;
		failedRequests += m.failedRequests;
		totalCost += m.totalCost;
		unpricedRequests += m.unpricedRequests;
	}

	return {
		models,
		top,
		swatches: new Map(countSeries.filter(s => s.key !== "__other__").map(s => [s.key, s.color])),
		labels,
		providerCount: new Set(models.map(m => m.provider)).size,
		totalRequests,
		failedRequests,
		totalCost,
		unpricedRequests,
		maxRequests: top?.totalRequests ?? 0,
		buckets,
		requestTotals,
		countSeries,
		shareSeries,
		trends,
		performance: buildModelPerformanceLookup(data.modelPerformanceSeries),
	};
}

/** Model name, qualified by provider only when the same model id is served by several. */
function modelLabels(models: readonly ModelStats[]): Map<string, string> {
	const providersPerModel = new Map<string, number>();
	for (const m of models) providersPerModel.set(m.model, (providersPerModel.get(m.model) ?? 0) + 1);
	return new Map(
		models.map(m => [
			modelKey(m.model, m.provider),
			(providersPerModel.get(m.model) ?? 0) > 1 ? `${m.model} · ${m.provider}` : m.model,
		]),
	);
}

function buildModelColumns(
	view: ModelsView,
	expandedKey: string | null,
	bucketWord: string,
	tr: Translation,
): Column<ModelStats>[] {
	return [
		{
			key: "expand",
			header: "",
			width: 28,
			render: row => (
				<span className="models-chevron" data-open={modelKey(row.model, row.provider) === expandedKey}>
					<ChevronRight size={14} />
				</span>
			),
		},
		{
			key: "model",
			header: <LocalizedText messageKey="pages.models.model" english={"Model"} />,
			sort: row => row.model,
			render: row => (
				<LabelCell
					lead={<Swatch color={view.swatches.get(modelKey(row.model, row.provider)) ?? OTHER_COLOR} />}
					primary={<span className="mono">{row.model}</span>}
					secondary={row.provider}
				/>
			),
		},
		{
			key: "requests",
			header: <LocalizedText messageKey="pages.models.requests" english={"Requests"} />,
			align: "right",
			sort: row => row.totalRequests,
			render: row => (
				<MeterCell
					value={row.totalRequests}
					max={view.maxRequests}
					display={formatInteger(row.totalRequests)}
					color={view.swatches.get(modelKey(row.model, row.provider)) ?? OTHER_COLOR}
				/>
			),
		},
		{
			key: "cost",
			header: <LocalizedText messageKey="pages.models.cost" english={"Cost"} />,
			title: "API-equivalent estimate at public rates",
			titleKey: "pages.models.api_equivalent_estimate_at_public_rates",
			align: "right",
			sort: row => row.totalCost,
			render: row => <span className="num">{formatEstimatedCost(row.totalCost, row.unpricedRequests)}</span>,
		},
		{
			key: "tokens",
			header: "Tokens",
			title: "Uncached input + cache reads + cache writes + output",
			titleKey: "pages.models.uncached_input_cache_reads_cache_writes_output",
			align: "right",
			sort: row => sumConversationTokens(row),
			render: row => {
				const tokens = sumConversationTokens(row);
				return (
					<span className="num" title={formatInteger(tokens)}>
						{formatCompact(tokens)}
					</span>
				);
			},
		},
		{
			key: "cache",
			header: <LocalizedText messageKey="pages.models.cache_rate" english={"Cache rate"} />,
			title: "Cache reads ÷ (uncached input + cache reads)",
			titleKey: "pages.models.cache_reads_uncached_input_cache_reads",
			align: "right",
			sort: row => row.cacheRate,
			render: row => <span className="num">{formatPercent(row.cacheRate)}</span>,
		},
		{
			key: "errors",
			header: <LocalizedText messageKey="pages.models.errors" english={"Errors"} />,
			align: "right",
			sort: row => row.errorRate,
			render: row =>
				row.failedRequests === 0 ? (
					<span className="num dim">0%</span>
				) : (
					<span
						title={tr("pages.models.count_failed", "{count} failed", {
							count: formatInteger(row.failedRequests),
						})}
					>
						<Badge tone={errorRateTone(row.errorRate)} mono>
							{formatErrorRate(row.errorRate)}
						</Badge>
					</span>
				),
		},
		{
			key: "tps",
			header: "Tokens/s",
			title: "Average output tokens per second",
			titleKey: "pages.models.average_output_tokens_per_second",
			align: "right",
			sort: row => row.avgTokensPerSecond ?? -1,
			render: row => <span className="num">{formatTokensPerSecond(row.avgTokensPerSecond)}</span>,
		},
		{
			key: "ttft",
			header: "TTFT",
			title: "Average time to first token",
			titleKey: "pages.models.average_time_to_first_token",
			align: "right",
			sort: row => row.avgTtft ?? -1,
			render: row => <span className="num">{formatDurationMs(row.avgTtft)}</span>,
		},
		{
			key: "trend",
			header: <LocalizedText messageKey="pages.models.trend" english={"Trend"} />,
			title: tr("pages.models.requests_per_bucket", "Requests per {bucket}", { bucket: bucketWord }),
			width: 112,
			render: row => {
				const key = modelKey(row.model, row.provider);
				const values = view.trends.get(key);
				return values ? (
					<Sparkline
						values={values.map(v => v ?? 0)}
						color={view.swatches.get(key) ?? OTHER_COLOR}
						width={96}
						height={22}
					/>
				) : (
					<span className="dim">–</span>
				);
			},
		},
	];
}

function ModelDetail({
	model,
	color,
	points,
	bucketMs,
	bucketWord,
}: {
	model: ModelStats;
	color: string;
	points: readonly ModelPerformanceDataPoint[];
	bucketMs: number;
	bucketWord: string;
}) {
	const locale = useLocale();
	const tr = useTranslation();
	const [hidden, toggle] = useHiddenSeries();
	const series: ChartSeries[] = [
		{
			key: "tps",
			label: "Tokens/s",
			color,
			kind: points.length > 1 ? "line" : "bars",
			values: points.map(p => p.avgTokensPerSecond),
		},
		{
			key: "ttft",
			label: "TTFT",
			color: OTHER_COLOR,
			kind: points.length > 1 ? "line" : "bars",
			axis: "right",
			dashed: true,
			values: points.map(p => p.avgTtftSeconds),
		},
	];

	return (
		<div className="models-detail">
			<div className="models-detail-facts">
				<div>
					<div className="section-label">{tr("pages.models.efficiency", "Efficiency")}</div>
					<KeyValues
						items={[
							{
								key: "err",
								label: tr("pages.models.error_rate", "Error rate"),
								value: (
									<span className={`tone-${errorRateTone(model.errorRate)}`}>
										{formatErrorRate(model.errorRate)}{" "}
										<span className="dim">
											({formatInteger(model.failedRequests)}
											{tr("pages.models.failed", " failed)")}
										</span>
									</span>
								),
							},
							{
								key: "cache",
								label: tr("pages.models.cache_rate", "Cache rate"),
								value: formatPercent(model.cacheRate),
							},
							{
								key: "savings",
								label: tr("pages.models.cache_savings", "Cache savings"),
								value: (
									<span className={model.cacheSavings < 0 ? "tone-bad" : undefined}>
										{formatPercent(model.cacheSavings)}
									</span>
								),
							},
							{
								key: "premium",
								label: tr("pages.models.premium_requests", "Premium requests"),
								value: formatInteger(Math.round(model.totalPremiumRequests * 100) / 100),
							},
						]}
					/>
				</div>
				<div>
					<div className="section-label">{tr("pages.models.latency", "Latency")}</div>
					<KeyValues
						items={[
							{
								key: "dur",
								label: tr("pages.models.avg_duration", "Avg duration"),
								value: formatDurationMs(model.avgDuration),
							},
							{
								key: "ttft",
								label: tr("pages.models.avg_ttft", "Avg TTFT"),
								value: formatDurationMs(model.avgTtft),
							},
							{ key: "tps", label: "Tokens/s", value: formatTokensPerSecond(model.avgTokensPerSecond) },
						]}
					/>
				</div>
				<div>
					<div className="section-label">Tokens</div>
					<KeyValues
						items={[
							{
								key: "in",
								label: tr("pages.models.uncached_input", "Uncached input"),
								value: formatCompact(model.totalInputTokens),
							},
							{
								key: "cr",
								label: tr("pages.models.cache_read", "Cache read"),
								value: formatCompact(model.totalCacheReadTokens),
							},
							{
								key: "cw",
								label: tr("pages.models.cache_write", "Cache write"),
								value: formatCompact(model.totalCacheWriteTokens),
							},
							{
								key: "out",
								label: tr("pages.models.output", "Output"),
								value: formatCompact(model.totalOutputTokens),
							},
						]}
					/>
				</div>
				<div className="micro dim">
					{tr("pages.models.first_seen", "First seen ")}
					{formatRelativeTime(model.firstTimestamp, locale)}
					{tr("pages.models.last_seen", " · last seen")} {formatRelativeTime(model.lastTimestamp, locale)}
				</div>
			</div>
			<div className="models-detail-chart">
				<div className="row" style={{ justifyContent: "space-between" }}>
					<div className="section-label" style={{ marginBottom: 0 }}>
						{tr("pages.models.performance_per_active", "Performance per active ")}
						{bucketWord}
					</div>
					<Legend
						items={series.map(s => ({ key: s.key, label: s.label, color: s.color }))}
						hidden={hidden}
						onToggle={toggle}
					/>
				</div>
				{points.length === 0 ? (
					<EmptyState
						title={tr("pages.models.no_performance_samples", "No performance samples")}
						hint={tr(
							"pages.models.timing_is_recorded_for_streamed_responses",
							"Timing is recorded for streamed responses.",
						)}
					/>
				) : (
					<TimeChart
						buckets={points.map(p => p.timestamp)}
						bucketMs={bucketMs}
						series={series}
						hidden={hidden}
						stacked={false}
						height={240}
						format={formatCompact}
						formatTooltip={v => `${formatTokensPerSecond(v)} tok/s`}
						formatRight={v => `${Number(v.toFixed(2))}s`}
						tooltipExtra={i => (
							<div className="chart-tooltip-row chart-tooltip-total">
								<span className="chart-tooltip-label">{tr("pages.models.requests", "Requests")}</span>
								<span className="chart-tooltip-value">{formatInteger(points[i].requests)}</span>
							</div>
						)}
					/>
				)}
			</div>
		</div>
	);
}

function bucketName(bucketMs: number): string {
	if (bucketMs < 3_600_000) return "5 minutes";
	if (bucketMs < 86_400_000) return "hour";
	return "day";
}

function sumValues(values: readonly (number | null)[]): number {
	let total = 0;
	for (const v of values) total += v ?? 0;
	return total;
}
