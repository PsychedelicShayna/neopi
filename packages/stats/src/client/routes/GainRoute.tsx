import { LocalizedText, useTranslation } from "../i18n";
import { useMemo, useState } from "react";
import { getGainDashboardStats } from "../api";
import { Chart, type ChartSeries, Legend } from "../charts";
import { formatBytes, formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import type { GainSource, GainSourceTotals, TimeRange } from "../types";
import {
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	MeterCell,
	PageHeader,
	QueryView,
	Stat,
	StatGrid,
	Table,
} from "../ui";

export interface GainRouteProps {
	active: boolean;
	range: TimeRange;
}

const DAY_MS = 86_400_000;

const SOURCE_LABEL: Record<GainSource, string> = {
	snapcompact: "Snapcompact imaged tool results",
	compaction: "Snapcompact compaction (context freed)",
};

/** The server buckets gain by local calendar day (`YYYY-MM-DD`). */
const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

interface SourceRow extends GainSourceTotals {
	source: GainSource;
	/** Share of all saved tokens (0-1). */
	share: number;
}

export function GainRoute({ active, range }: GainRouteProps) {
	const tr = useTranslation();
	const [project, setProject] = useState<string | null>(null);
	const gain = useQuery(["gain", range, project], ({ signal }) => getGainDashboardStats(range, project, signal), {
		enabled: active,
	});
	const meta = rangeMeta(range);
	const data = gain.data;

	const series = useMemo(() => {
		// A date-time string without an offset parses as local midnight.
		const points = (data?.timeSeries ?? []).map(p => ({ ...p, timestamp: Date.parse(`${p.date}T00:00:00`) }));
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
			DAY_MS,
		);
		const daily = densify(points, buckets, p => p.total);
		let running = 0;
		const cumulative = daily.map(v => (running += v));
		return { buckets, daily, cumulative };
	}, [data, range]);

	const sourceRows = useMemo((): SourceRow[] => {
		if (!data) return [];
		const total = data.overall.savedTokens;
		return (Object.keys(data.bySource) as GainSource[]).map(source => ({
			...data.bySource[source],
			source,
			share: total > 0 ? data.bySource[source].savedTokens / total : 0,
		}));
	}, [data]);

	const projects = data?.projects ?? [];
	// Keep the chosen project selectable even when the current range never saw it.
	const projectOptions = project !== null && !projects.includes(project) ? [project, ...projects] : projects;
	const scope = project ? ` for ${project}` : "";

	const chartSeries: ChartSeries[] = [
		{
			key: "daily",
			label: tr("pages.gain.saved_per_day", "Saved per day"),
			color: "var(--chart-primary)",
			values: series.daily,
		},
		{
			key: "cumulative",
			label: tr("pages.gain.cumulative", "Cumulative"),
			color: "var(--chart-secondary)",
			values: series.cumulative,
			kind: "line",
			axis: "right",
		},
	];

	return (
		<div className="page">
			<PageHeader
				title={tr("pages.gain.gain", "Gain")}
				description={tr(
					"pages.gain.context_snapcompact_freed_by_compacting_and_tokens",
					"Context snapcompact freed by compacting, and tokens it saved by imaging tool results{scope}, in {window}.",
					{ scope: scope, window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
				actions={
					projectOptions.length > 0 && (
						<select
							className="input"
							aria-label={tr("pages.gain.project", "Project")}
							value={project ?? ""}
							onChange={e => setProject(e.target.value || null)}
							style={{ maxWidth: 320 }}
						>
							<option value="">{tr("pages.gain.all_projects", "All projects")}</option>
							{projectOptions.map(p => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					)
				}
			/>

			<QueryView
				query={gain}
				skeleton={<ChartSkeleton height={96} />}
				isEmpty={stats => stats.overall.hits === 0 && stats.timeSeries.length === 0}
				empty={
					<Card>
						<EmptyState
							title={tr(
								"pages.gain.no_savings_recorded_scope_in_window",
								"No savings recorded{scope} in {window}",
								{ scope: scope, window: tr(`costs.window.${range}`, meta.windowLabel) },
							)}
							hint={
								range === "all"
									? tr(
											"pages.gain.savings_appear_here_once_snapcompact_compacts_the",
											"Savings appear here once snapcompact compacts the context or images tool output.",
										)
									: tr("pages.gain.try_a_longer_range", "Try a longer range.")
							}
						/>
					</Card>
				}
			>
				{({ overall }) => (
					<>
						<div data-stale={gain.stale}>
							<StatGrid min={180}>
								<Stat
									label={tr("pages.gain.saved_tokens", "Saved tokens")}
									value={formatCompact(overall.savedTokens)}
									hint={formatInteger(overall.savedTokens)}
									spark={series.daily}
								/>
								<Stat
									label={tr("pages.gain.saved_bytes", "Saved bytes")}
									value={formatBytes(overall.savedBytes)}
								/>
								<Stat
									label={tr("pages.gain.reduction", "Reduction")}
									title={tr(
										"pages.gain.saved_bytes_original_bytes_when_the_original",
										"Saved bytes ÷ original bytes, when the original size is known",
									)}
									value={overall.reductionPercent !== null ? formatPercent(overall.reductionPercent) : "–"}
									hint={
										overall.reductionPercent === null
											? tr("pages.gain.original_size_not_recorded", "original size not recorded")
											: undefined
									}
								/>
								<Stat label={tr("pages.gain.hits", "Hits")} value={formatInteger(overall.hits)} />
								<Stat
									label={tr("pages.gain.saved_per_hit", "Saved per hit")}
									value={overall.hits > 0 ? formatCompact(overall.savedTokens / overall.hits) : "–"}
									hint="tokens"
								/>
							</StatGrid>
						</div>

						<Card
							index={1}
							title={tr("pages.gain.savings_over_time", "Savings over time")}
							description={tr(
								"pages.gain.tokens_saved_per_day_with_the_running",
								"Tokens saved per day, with the running total",
							)}
							actions={<Legend items={chartSeries.map(s => ({ key: s.key, label: s.label, color: s.color }))} />}
							stale={gain.stale}
						>
							<Chart
								slots={series.buckets.length}
								tickLabel={i => DAY_LABEL.format(series.buckets[i])}
								series={chartSeries}
								height={260}
								formatTooltip={formatInteger}
								formatRight={formatCompact}
							/>
						</Card>

						<Card
							index={2}
							title={tr("pages.gain.by_source", "By source")}
							description={tr("pages.gain.savings_per_subsystem", "Savings per subsystem")}
							flush
							stale={gain.stale}
						>
							<Table rows={sourceRows} rowKey={row => row.source} columns={SOURCE_COLUMNS} />
						</Card>
					</>
				)}
			</QueryView>
		</div>
	);
}

const SOURCE_COLUMNS: Column<SourceRow>[] = [
	{
		key: "source",
		header: <LocalizedText messageKey="pages.gain.source" english={"Source"} />,
		sort: row => row.source,
		render: row => (
			<span className="cell-primary">
				{<LocalizedText messageKey={`pages.gain.source.${row.source}`} english={SOURCE_LABEL[row.source]} />}
			</span>
		),
	},
	{
		key: "tokens",
		header: <LocalizedText messageKey="pages.gain.saved_tokens" english={"Saved tokens"} />,
		align: "right",
		sort: row => row.savedTokens,
		render: row => (
			<span title={formatInteger(row.savedTokens)}>
				<MeterCell value={row.share} max={1} display={formatCompact(row.savedTokens)} />
			</span>
		),
	},
	{
		key: "share",
		header: <LocalizedText messageKey="pages.gain.share" english={"Share"} />,
		align: "right",
		sort: row => row.share,
		render: row => <span className="num muted">{formatPercent(row.share)}</span>,
	},
	{
		key: "bytes",
		header: <LocalizedText messageKey="pages.gain.saved_bytes" english={"Saved bytes"} />,
		align: "right",
		sort: row => row.savedBytes,
		render: row => <span className="num">{formatBytes(row.savedBytes)}</span>,
	},
	{
		key: "hits",
		header: <LocalizedText messageKey="pages.gain.hits" english={"Hits"} />,
		align: "right",
		sort: row => row.hits,
		render: row => <span className="num">{formatInteger(row.hits)}</span>,
	},
	{
		key: "reduction",
		header: <LocalizedText messageKey="pages.gain.reduction" english={"Reduction"} />,
		align: "right",
		sort: row => row.reductionPercent ?? -1,
		render: row => (
			<span className="num">{row.reductionPercent !== null ? formatPercent(row.reductionPercent) : "–"}</span>
		),
	},
];
