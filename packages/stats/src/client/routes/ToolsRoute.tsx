import { LocalizedText, useTranslation, useLocale } from "../i18n";
import type { Locale, Translation } from "../types";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { getToolDashboardStats } from "../api";
import { Legend, Sparkline, TimeChart, useHiddenSeries } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import {
	formatCompact,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify, localizeGroupedSeries, pivotSeries } from "../data/series";
import { buildToolRows, type ToolRowView } from "../data/view-models";
import type { TimeRange, ToolDashboardStats, ToolModelStats, ToolTimeSeriesPoint } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Swatch,
	Table,
	TableSkeleton,
} from "../ui";
import "./tools.css";

export interface ToolsRouteProps {
	active: boolean;
	range: TimeRange;
}

type CallMetric = "calls" | "errors";

const METRIC_OPTIONS = [
	{ value: "calls" as const, label: <LocalizedText messageKey="pages.tools.calls" english={"Calls"} /> },
	{ value: "errors" as const, label: <LocalizedText messageKey="pages.tools.errors" english={"Errors"} /> },
];

/** Tools stacked individually in the calls chart; the rest fold into "Other". */
const TOP_TOOLS = 6;

const ATTRIBUTION_NOTE =
	"Tokens and API-equivalent cost of each invoking turn, split evenly across that turn's tool calls";

const NO_CALLS = (
	<EmptyState
		title={
			<LocalizedText messageKey="pages.tools.no_tool_calls_in_this_range" english={"No tool calls in this range"} />
		}
	/>
);

export function ToolsRoute({ active, range }: ToolsRouteProps) {
	const locale = useLocale();
	const tr = useTranslation();
	const tools = useQuery(["tools", range], ({ signal }) => getToolDashboardStats(range, signal), { enabled: active });
	const [metric, setMetric] = useState<CallMetric>("calls");
	const [hidden, toggleHidden] = useHiddenSeries();
	const [pickedTool, setToolFilter] = useState<string | null>(null);
	const meta = rangeMeta(range);

	const view = useMemo(() => buildToolsView(tools.data, range, tr, locale), [tools.data, range, tr, locale]);
	// A pick from another range only applies while that tool still has calls.
	const toolFilter = pickedTool !== null && view.toolNames.includes(pickedTool) ? pickedTool : null;

	const chartSeries = localizeGroupedSeries(metric === "calls" ? view.callSeries : view.errorSeries, tr);
	const isEmpty = (data: ToolDashboardStats) => data.byTool.length === 0;

	return (
		<div className="page">
			<PageHeader
				title={tr("pages.tools.tools", "Tools")}
				description={tr(
					"pages.tools.which_tools_omp_called_in_window_how",
					"Which tools omp called in {window}, how often they failed, and what they cost.",
					{ window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
			/>

			<QueryView query={tools} skeleton={<ChartSkeleton height={112} />}>
				{() => {
					const t = view.totals;
					return (
						<div data-stale={tools.stale} className="stack" style={{ gap: 16 }}>
							<StatGrid min={190}>
								<Stat
									label={tr("pages.tools.tool_calls", "Tool calls")}
									value={formatInteger(t.calls)}
									hint={tr("pages.tools.count_failed", "{count} failed", { count: formatInteger(t.errors) })}
									spark={view.totalCalls}
								/>
								<Stat
									label={tr("pages.tools.distinct_tools", "Distinct tools")}
									value={formatInteger(t.tools)}
									hint={
										view.rows[0]
											? tr("pages.tools.most_used_tool", "Most used: {tool}", { tool: view.rows[0].tool })
											: undefined
									}
								/>
								<Stat
									label={tr("pages.tools.error_rate", "Error rate")}
									title={tr(
										"pages.tools.tool_results_that_came_back_flagged_as",
										"Tool results that came back flagged as errors",
									)}
									value={formatErrorRate(t.calls > 0 ? t.errors / t.calls : 0)}
									hint={tr("pages.tools.count_succeeded", "{count} succeeded", {
										count: formatInteger(t.calls - t.errors),
									})}
									spark={view.totalErrors}
									sparkColor="var(--bad)"
								/>
								<Stat
									label={tr("pages.tools.attributed_tokens", "Attributed tokens")}
									title={ATTRIBUTION_NOTE}
									value={formatCompact(Math.round(t.tokens))}
									hint={tr("pages.tools.count_output", "{count} output", {
										count: formatCompact(Math.round(t.output)),
									})}
								/>
								<Stat
									label={tr("pages.tools.attributed_cost", "Attributed cost")}
									title={tr("pages.tools.note_api_equivalent_estimate", "{note}; API-equivalent estimate", {
										note: tr("pages.tools.attribution_note", ATTRIBUTION_NOTE),
									})}
									value={formatEstimatedCost(t.cost, t.unpriced)}
									hint={
										t.unpriced > 0
											? tr("pages.tools.count_unpriced_requests", "{count} unpriced requests", {
													count: formatInteger(Math.round(t.unpriced)),
												})
											: tr("pages.tools.api_equivalent", "API-equivalent")
									}
								/>
							</StatGrid>
							<StatGrid min={150}>
								<Stat
									size="sm"
									label={tr("pages.tools.result_text", "Result text")}
									title={tr(
										"pages.tools.characters_of_tool_result_text_fed_back",
										"Characters of tool-result text fed back into context",
									)}
									value={`${formatCompact(t.resultChars)} chars`}
								/>
								<Stat
									size="sm"
									label={tr("pages.tools.call_arguments", "Call arguments")}
									title={tr(
										"pages.tools.characters_of_serialized_tool_call_arguments",
										"Characters of serialized tool-call arguments",
									)}
									value={`${formatCompact(t.argsChars)} chars`}
								/>
								<Stat
									size="sm"
									label={tr("pages.tools.avg_result_per_call", "Avg result per call")}
									value={`${formatCompact(t.calls > 0 ? Math.round(t.resultChars / t.calls) : 0)} chars`}
								/>
								<Stat
									size="sm"
									label={tr("pages.tools.avg_arguments_per_call", "Avg arguments per call")}
									value={`${formatCompact(t.calls > 0 ? Math.round(t.argsChars / t.calls) : 0)} chars`}
								/>
							</StatGrid>
						</div>
					);
				}}
			</QueryView>

			<Card
				index={1}
				title={
					metric === "calls"
						? tr("pages.tools.calls_over_time", "Calls over time")
						: tr("pages.tools.errors_over_time", "Errors over time")
				}
				description={tr(
					"pages.tools.per_bucket_top_count_tools_stacked",
					"Per {bucket}, top {count} tools stacked",
					{
						bucket:
							meta.bucketMs < 3_600_000
								? tr("pages.period.five_minutes", "5 minutes")
								: meta.bucketMs < 86_400_000
									? tr("pages.period.hour", "hour")
									: tr("pages.period.day", "day"),
						count: TOP_TOOLS,
					},
				)}
				actions={<Segmented size="sm" options={METRIC_OPTIONS} value={metric} onChange={setMetric} />}
				stale={tools.stale}
			>
				<QueryView query={tools} skeleton={<ChartSkeleton height={260} />} isEmpty={isEmpty} empty={NO_CALLS}>
					{() => (
						<div className="stack" style={{ gap: 12 }}>
							<TimeChart
								buckets={view.buckets}
								bucketMs={meta.bucketMs}
								series={chartSeries}
								hidden={hidden}
								height={260}
								formatTooltip={formatInteger}
								emptyLabel={
									metric === "errors"
										? tr("pages.tools.no_tool_errors_in_this_range", "No tool errors in this range")
										: undefined
								}
							/>
							<Legend
								items={chartSeries.map(s => ({
									key: s.key,
									label: s.label,
									color: s.color,
									value: formatCompact(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
								}))}
								hidden={hidden}
								onToggle={toggleHidden}
							/>
						</div>
					)}
				</QueryView>
			</Card>

			<Card
				index={2}
				title={tr("pages.tools.by_tool", "By tool")}
				description={tr(
					"pages.tools.note_select_a_tool_to_break_it",
					"{note}. Select a tool to break it down by model.",
					{ note: tr("pages.tools.attribution_note", ATTRIBUTION_NOTE) },
				)}
				flush
				stale={tools.stale}
			>
				<QueryView query={tools} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={NO_CALLS}>
					{() => (
						<Table
							rows={view.rows}
							rowKey={row => row.tool}
							columns={view.toolColumns}
							initialSort={{ key: "calls", dir: "desc" }}
							limit={20}
							selectedKey={toolFilter}
							onRowClick={row => setToolFilter(prev => (prev === row.tool ? null : row.tool))}
							dense
						/>
					)}
				</QueryView>
			</Card>

			<Card
				index={3}
				title={tr("pages.tools.by_tool_and_model", "By tool and model")}
				description={tr(
					"pages.tools.which_models_call_which_tools_and_how",
					"Which models call which tools, and how often those calls fail",
				)}
				flush
				stale={tools.stale}
				actions={
					<div className="row" style={{ gap: 6 }}>
						<select
							className="input tools-filter"
							value={toolFilter ?? ""}
							onChange={e => setToolFilter(e.target.value || null)}
							aria-label={tr("pages.tools.filter_by_tool", "Filter by tool")}
						>
							<option value="">{tr("pages.tools.all_tools", "All tools")}</option>
							{view.toolNames.map(name => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
						{toolFilter !== null && (
							<button
								type="button"
								className="btn"
								data-size="sm"
								data-variant="ghost"
								data-icon="true"
								title={tr("pages.tools.clear_tool_filter", "Clear tool filter")}
								aria-label={tr("pages.tools.clear_tool_filter", "Clear tool filter")}
								onClick={() => setToolFilter(null)}
							>
								<X size={13} />
							</button>
						)}
					</div>
				}
			>
				<QueryView query={tools} skeleton={<TableSkeleton rows={8} />} isEmpty={isEmpty} empty={NO_CALLS}>
					{data => <ToolModelTable rows={data.byToolModel} tool={toolFilter} colors={view.colors} />}
				</QueryView>
			</Card>
		</div>
	);
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

interface ToolTotals {
	calls: number;
	errors: number;
	tools: number;
	tokens: number;
	output: number;
	cost: number;
	unpriced: number;
	resultChars: number;
	argsChars: number;
}

function buildToolsView(data: ToolDashboardStats | null, range: TimeRange, tr: Translation, locale: Locale) {
	const byTool = data?.byTool ?? [];
	const points = data?.series ?? [];
	const rows = buildToolRows(byTool).sort((a, b) => b.calls - a.calls);
	const colors = buildColorLookup(byTool.map(t => ({ key: t.tool, weight: t.calls })));
	const buckets = bucketAxis(
		range,
		points.map(p => p.timestamp),
	);

	const totals: ToolTotals = {
		calls: 0,
		errors: 0,
		tools: byTool.length,
		tokens: 0,
		output: 0,
		cost: 0,
		unpriced: 0,
		resultChars: 0,
		argsChars: 0,
	};
	for (const t of byTool) {
		totals.calls += t.calls;
		totals.errors += t.errors;
		totals.tokens += t.totalTokensShare;
		totals.output += t.outputTokensShare;
		totals.cost += t.costShare;
		totals.unpriced += t.unpricedRequestsShare;
		totals.resultChars += t.resultChars;
		totals.argsChars += t.argsChars;
	}

	// Every tool keeps its table swatch color in both metrics; zero slots become
	// gaps so the tooltip lists only tools active in that bucket.
	const [callSeries, errorSeries] = [(p: ToolTimeSeriesPoint) => p.calls, (p: ToolTimeSeriesPoint) => p.errors].map(
		value =>
			pivotSeries(points, { buckets, key: p => p.tool, value, limit: TOP_TOOLS, colors }).map(s => ({
				...s,
				values: s.values.map(v => v || null),
			})),
	);
	// Unlimited pivot for the per-row sparklines.
	const trends = new Map(
		pivotSeries(points, { buckets, key: p => p.tool, value: p => p.calls }).map(s => [s.key, s.values as number[]]),
	);

	const maxCalls = rows[0]?.calls ?? 0;
	const toolColumns = buildToolColumns(maxCalls, colors, trends, tr, locale);

	return {
		rows,
		colors,
		buckets,
		totals,
		callSeries,
		errorSeries,
		totalCalls: densify(points, buckets, p => p.calls),
		totalErrors: densify(points, buckets, p => p.errors),
		toolNames: rows.map(r => r.tool).sort((a, b) => a.localeCompare(b)),
		toolColumns,
	};
}

function buildToolColumns(
	maxCalls: number,
	colors: ReadonlyMap<string, string>,
	trends: ReadonlyMap<string, number[]>,
	tr: Translation,
	locale: Locale,
): Column<ToolRowView>[] {
	return [
		{
			key: "tool",
			header: <LocalizedText messageKey="pages.tools.tool" english={"Tool"} />,
			sort: row => row.tool,
			render: row => (
				<span className="row" style={{ gap: 8 }}>
					<Swatch color={colors.get(row.tool) ?? OTHER_COLOR} />
					<span className="mono truncate tools-name" title={row.tool}>
						{row.tool}
					</span>
				</span>
			),
		},
		{
			key: "trend",
			header: <LocalizedText messageKey="pages.tools.trend" english={"Trend"} />,
			title: "Calls per bucket over the range",
			titleKey: "pages.tools.calls_per_bucket_over_the_range",
			render: row => {
				const values = trends.get(row.tool);
				return values && values.length > 1 ? (
					<Sparkline values={values} width={80} height={20} color={colors.get(row.tool) ?? OTHER_COLOR} />
				) : (
					<span className="dim">–</span>
				);
			},
		},
		{
			key: "calls",
			header: <LocalizedText messageKey="pages.tools.calls" english={"Calls"} />,
			align: "right",
			sort: row => row.calls,
			render: row => (
				<MeterCell
					value={row.calls}
					max={maxCalls}
					display={
						<span
							title={tr("pages.tools.percent_of_all_tool_calls", "{percent} of all tool calls", {
								percent: formatPercent(row.callFraction),
							})}
						>
							{formatInteger(row.calls)}
							<span className="dim tools-share">{formatPercent(row.callFraction, 0)}</span>
						</span>
					}
				/>
			),
		},
		{
			key: "errorRate",
			header: <LocalizedText messageKey="pages.tools.errors" english={"Errors"} />,
			title: "Calls whose result came back flagged as an error",
			titleKey: "pages.tools.calls_whose_result_came_back_flagged_as",
			align: "right",
			sort: row => row.errorRate,
			render: row => (
				<span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
					<span className="num dim">{formatInteger(row.errors)}</span>
					<Badge tone={row.errors > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
						{formatErrorRate(row.errorRate)}
					</Badge>
				</span>
			),
		},
		{
			key: "args",
			header: <LocalizedText messageKey="pages.tools.args" english={"Args"} />,
			title: "Characters of serialized tool-call arguments",
			titleKey: "pages.tools.characters_of_serialized_tool_call_arguments",
			align: "right",
			sort: row => row.argsChars,
			render: row => <span className="num">{formatCompact(row.argsChars)}</span>,
		},
		{
			key: "result",
			header: <LocalizedText messageKey="pages.tools.result" english={"Result"} />,
			title: "Characters of tool-result text fed back into context",
			titleKey: "pages.tools.characters_of_tool_result_text_fed_back",
			align: "right",
			sort: row => row.resultChars,
			render: row => <span className="num">{formatCompact(row.resultChars)}</span>,
		},
		{
			key: "avgResult",
			header: <LocalizedText messageKey="pages.tools.result_call" english={"Result / call"} />,
			title: "Mean tool-result characters per call",
			titleKey: "pages.tools.mean_tool_result_characters_per_call",
			align: "right",
			sort: row => row.avgResultChars,
			render: row => <span className="num muted">{formatCompact(Math.round(row.avgResultChars))}</span>,
		},
		{
			key: "tokens",
			header: <LocalizedText messageKey="pages.tools.attr_tokens" english={"Attr. tokens"} />,
			title: ATTRIBUTION_NOTE,
			align: "right",
			sort: row => row.totalTokensShare,
			render: row => (
				<span
					className="num"
					title={tr("pages.tools.percent_of_attributed_tokens", "{percent} of attributed tokens", {
						percent: formatPercent(row.tokenFraction),
					})}
				>
					{formatCompact(Math.round(row.totalTokensShare))}
					<span className="dim tools-share">{formatPercent(row.tokenFraction, 0)}</span>
				</span>
			),
		},
		{
			key: "cost",
			header: <LocalizedText messageKey="pages.tools.attr_cost" english={"Attr. cost"} />,
			title: tr("pages.tools.note_api_equivalent_estimate", "{note}; API-equivalent estimate", {
				note: tr("pages.tools.attribution_note", ATTRIBUTION_NOTE),
			}),
			align: "right",
			sort: row => row.costShare,
			render: row => (
				<span
					className="num"
					title={tr("pages.tools.percent_of_attributed_cost", "{percent} of attributed cost", {
						percent: formatPercent(row.costFraction),
					})}
				>
					{formatEstimatedCost(row.costShare, row.unpricedRequestsShare)}
					<span className="dim tools-share">{formatPercent(row.costFraction, 0)}</span>
				</span>
			),
		},
		{
			key: "lastUsed",
			header: <LocalizedText messageKey="pages.tools.last_used" english={"Last used"} />,
			align: "right",
			sort: row => row.lastUsed,
			render: row => <span className="muted">{formatRelativeTime(row.lastUsed, locale)}</span>,
		},
	];
}

// ---------------------------------------------------------------------------
// Tool × model breakdown
// ---------------------------------------------------------------------------

interface ToolModelRow extends ToolModelStats {
	errorRate: number;
}

function ToolModelTable({
	rows,
	tool,
	colors,
}: {
	rows: ToolModelStats[];
	tool: string | null;
	colors: ReadonlyMap<string, string>;
}) {
	const locale = useLocale();
	const tr = useTranslation();
	const filtered = useMemo<ToolModelRow[]>(
		() =>
			(tool === null ? rows : rows.filter(r => r.tool === tool)).map(r => ({
				...r,
				errorRate: r.calls > 0 ? r.errors / r.calls : 0,
			})),
		[rows, tool],
	);
	const columns = useMemo<Column<ToolModelRow>[]>(() => {
		const maxCalls = filtered.reduce((max, r) => Math.max(max, r.calls), 0);
		return [
			{
				key: "tool",
				header: tr("pages.tools.tool", "Tool"),
				sort: row => row.tool,
				render: row => (
					<span className="row" style={{ gap: 8 }}>
						<Swatch color={colors.get(row.tool) ?? OTHER_COLOR} />
						<span className="mono truncate tools-name" title={row.tool}>
							{row.tool}
						</span>
					</span>
				),
			},
			{
				key: "model",
				header: tr("pages.tools.model", "Model"),
				sort: row => row.model,
				render: row => (
					<LabelCell
						primary={<span className="mono">{row.model || tr("pages.tools.unknown", "(unknown)")}</span>}
						secondary={row.provider}
					/>
				),
			},
			{
				key: "calls",
				header: tr("pages.tools.calls", "Calls"),
				align: "right",
				sort: row => row.calls,
				render: row => <MeterCell value={row.calls} max={maxCalls} display={formatInteger(row.calls)} />,
			},
			{
				key: "errorRate",
				header: tr("pages.tools.errors", "Errors"),
				align: "right",
				sort: row => row.errorRate,
				render: row => (
					<span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
						<span className="num dim">{formatInteger(row.errors)}</span>
						<Badge tone={row.errors > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
							{formatErrorRate(row.errorRate)}
						</Badge>
					</span>
				),
			},
			{
				key: "result",
				header: tr("pages.tools.result", "Result"),
				title: tr(
					"pages.tools.characters_of_tool_result_text_fed_back",
					"Characters of tool-result text fed back into context",
				),
				align: "right",
				sort: row => row.resultChars,
				render: row => <span className="num">{formatCompact(row.resultChars)}</span>,
			},
			{
				key: "tokens",
				header: tr("pages.tools.attr_tokens", "Attr. tokens"),
				title: ATTRIBUTION_NOTE,
				align: "right",
				sort: row => row.totalTokensShare,
				render: row => <span className="num">{formatCompact(Math.round(row.totalTokensShare))}</span>,
			},
			{
				key: "cost",
				header: tr("pages.tools.attr_cost", "Attr. cost"),
				title: tr("pages.tools.note_api_equivalent_estimate", "{note}; API-equivalent estimate", {
					note: tr("pages.tools.attribution_note", ATTRIBUTION_NOTE),
				}),
				align: "right",
				sort: row => row.costShare,
				render: row => <span className="num">{formatEstimatedCost(row.costShare, row.unpricedRequestsShare)}</span>,
			},
			{
				key: "lastUsed",
				header: tr("pages.tools.last_used", "Last used"),
				align: "right",
				sort: row => row.lastUsed,
				render: row => <span className="muted">{formatRelativeTime(row.lastUsed, locale)}</span>,
			},
		];
	}, [filtered, colors, tr, locale]);

	return (
		<Table
			rows={filtered}
			rowKey={row => `${row.tool}::${row.model}::${row.provider}`}
			columns={columns}
			initialSort={{ key: "calls", dir: "desc" }}
			limit={25}
			dense
			empty={
				<EmptyState
					title={
						tool
							? tr("pages.tools.no_calls_to_tool_in_this_range", "No calls to {tool} in this range", {
									tool: tool,
								})
							: tr("pages.tools.no_tool_calls_in_this_range", "No tool calls in this range")
					}
				/>
			}
		/>
	);
}
