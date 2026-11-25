import { LocalizedText, useTranslation, useLocale } from "../i18n";
import type { Locale, Translation } from "../types";
import { useDeferredValue, useMemo, useState } from "react";
import { getFolderStats } from "../api";
import { BarList } from "../charts";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatFolder,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { buildFolderRows, type FolderRowView } from "../data/view-models";
import type { TimeRange } from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	EmptyState,
	errorRateTone,
	MeterCell,
	PageHeader,
	QueryView,
	SearchInput,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import "./projects.css";

export interface ProjectsRouteProps {
	active: boolean;
	range: TimeRange;
}

/** Rows rendered before "Show all": keeps the first paint cheap with tens of thousands of folders. */
const TABLE_LIMIT = 100;
const TOP_LIMIT = 8;

export function ProjectsRoute({ active, range }: ProjectsRouteProps) {
	const locale = useLocale();
	const tr = useTranslation();
	const folders = useQuery(["projects", range], ({ signal }) => getFolderStats(range, signal), { enabled: active });
	const [search, setSearch] = useState("");
	// Benchmarks and scratch sessions can leave tens of thousands of one-off temp folders; hide them by default.
	const [hideTemporary, setHideTemporary] = useState(true);
	const query = useDeferredValue(search.trim().toLowerCase());
	const meta = rangeMeta(range);

	const view = useMemo(() => buildFolderRows(folders.data ?? []), [folders.data]);
	const scoped = useMemo(
		() => (hideTemporary ? view.rows.filter(row => !row.temporary) : view.rows),
		[view, hideTemporary],
	);
	const matching = useMemo(
		() => (query ? scoped.filter(row => row.folder.toLowerCase().includes(query)) : scoped),
		[scoped, query],
	);
	const top = useMemo(
		() => ({
			cost: [...scoped].sort((a, b) => b.totalCost - a.totalCost).slice(0, TOP_LIMIT),
			requests: [...scoped].sort((a, b) => b.totalRequests - a.totalRequests).slice(0, TOP_LIMIT),
		}),
		[scoped],
	);
	const topEmpty = (
		<EmptyState
			title={
				view.rows.length === 0
					? tr("pages.projects.no_project_folders_in_this_range", "No project folders in this range")
					: tr("pages.projects.only_temporary_folders_in_this_range", "Only temporary folders in this range")
			}
		/>
	);
	// Meter scales follow the whole range so a bar's length does not change while filtering.
	const columns = useMemo(() => folderColumns(view.maxRequests, view.maxCost, tr, locale), [view, tr, locale]);

	return (
		<div className="page">
			<PageHeader
				title={tr("pages.projects.projects", "Projects")}
				description={tr(
					"pages.projects.usage_by_session_folder_in_window",
					"Usage by session folder in {window}.",
					{ window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
			/>

			<QueryView query={folders} skeleton={<ChartSkeleton height={96} />}>
				{() => (
					<div data-stale={folders.stale}>
						<StatGrid min={180}>
							<Stat
								label={tr("pages.projects.folders", "Folders")}
								value={formatInteger(view.rows.length)}
								hint={
									view.temporaryCount > 0
										? tr("pages.projects.count_temporary", "{count} temporary", {
												count: formatInteger(view.temporaryCount),
											})
										: undefined
								}
							/>
							<Stat
								label={tr("pages.projects.requests", "Requests")}
								value={formatInteger(view.totalRequests)}
								hint={tr("pages.projects.count_failed", "{count} failed", {
									count: formatInteger(view.failedRequests),
								})}
							/>
							<Stat
								label={tr("pages.projects.api_equivalent_cost", "API-equivalent cost")}
								title={tr(
									"pages.projects.what_this_usage_would_cost_at_public",
									"What this usage would cost at public API rates",
								)}
								value={formatEstimatedCost(view.totalCost, view.unpricedRequests)}
								hint={
									view.unpricedRequests > 0
										? tr("pages.projects.count_unpriced", "{count} unpriced", {
												count: formatInteger(view.unpricedRequests),
											})
										: undefined
								}
							/>
							<Stat
								label={tr("pages.projects.conversation_tokens", "Conversation tokens")}
								title={tr(
									"pages.projects.uncached_input_cache_reads_cache_writes_output",
									"Uncached input + cache reads + cache writes + output",
								)}
								value={formatCompact(view.conversationTokens)}
							/>
							<Stat
								label={tr("pages.projects.cache_rate", "Cache rate")}
								title={tr(
									"pages.projects.cache_reads_uncached_input_cache_reads_across",
									"Cache reads ÷ (uncached input + cache reads), across every folder",
								)}
								value={formatPercent(view.cacheRate)}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-2">
				<Card
					index={1}
					title={tr("pages.projects.top_by_cost", "Top by cost")}
					description={tr("pages.projects.share_of_api_equivalent_cost", "Share of API-equivalent cost")}
					stale={folders.stale}
				>
					<QueryView
						query={folders}
						skeleton={<ChartSkeleton height={236} />}
						isEmpty={() => top.cost.length === 0}
						empty={topEmpty}
					>
						{() => (
							<BarList
								items={top.cost.map(row => ({
									key: row.folder,
									label: <span className="mono">{formatFolder(row.folder, tr)}</span>,
									value: row.totalCost,
									display: `${formatEstimatedCost(row.totalCost, row.unpricedRequests)} · ${formatPercent(row.costShare)}`,
									color: "var(--chart-secondary)",
								}))}
								onSelect={setSearch}
							/>
						)}
					</QueryView>
				</Card>
				<Card
					index={2}
					title={tr("pages.projects.top_by_requests", "Top by requests")}
					description={tr("pages.projects.share_of_all_requests", "Share of all requests")}
					stale={folders.stale}
				>
					<QueryView
						query={folders}
						skeleton={<ChartSkeleton height={236} />}
						isEmpty={() => top.requests.length === 0}
						empty={topEmpty}
					>
						{() => (
							<BarList
								items={top.requests.map(row => ({
									key: row.folder,
									label: <span className="mono">{formatFolder(row.folder, tr)}</span>,
									value: row.totalRequests,
									display: `${formatInteger(row.totalRequests)} · ${formatPercent(row.requestShare)}`,
								}))}
								onSelect={setSearch}
							/>
						)}
					</QueryView>
				</Card>
			</div>

			<Card
				index={3}
				title={tr("pages.projects.folders", "Folders")}
				description={
					folders.data
						? matching.length === view.rows.length
							? tr("pages.projects.count_folders", "{count} folders", { count: formatInteger(view.rows.length) })
							: tr("pages.projects.count_of_total_folders", "{count} of {total} folders", {
									count: formatInteger(matching.length),
									total: formatInteger(view.rows.length),
								})
						: undefined
				}
				actions={
					<>
						{view.temporaryCount > 0 && (
							<label
								className="check"
								title={tr(
									"pages.projects.session_folders_under_tmp_or_var_folders",
									"Session folders under /tmp or /var/folders",
								)}
							>
								<input
									type="checkbox"
									checked={hideTemporary}
									onChange={e => setHideTemporary(e.target.checked)}
								/>
								{tr("pages.projects.hide_temporary", "Hide temporary (")}
								{formatInteger(view.temporaryCount)})
							</label>
						)}
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder={tr("pages.projects.filter_folders", "Filter folders…")}
							width={240}
						/>
					</>
				}
				flush
				stale={folders.stale}
			>
				<QueryView query={folders} skeleton={<TableSkeleton rows={10} />}>
					{() => (
						<Table
							rows={matching}
							rowKey={row => row.folder}
							columns={columns}
							initialSort={{ key: "cost", dir: "desc" }}
							limit={TABLE_LIMIT}
							dense
							empty={
								<EmptyState
									title={
										view.rows.length === 0
											? tr(
													"pages.projects.no_project_folders_in_this_range",
													"No project folders in this range",
												)
											: tr("pages.projects.no_folders_match", "No folders match")
									}
									hint={
										view.rows.length === 0
											? tr("pages.projects.try_a_longer_range", "Try a longer range.")
											: hideTemporary && view.temporaryCount > 0
												? tr("pages.projects.temporary_folders_are_hidden", "Temporary folders are hidden.")
												: undefined
									}
								/>
							}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function folderColumns(maxRequests: number, maxCost: number, tr: Translation, locale: Locale): Column<FolderRowView>[] {
	return [
		{
			key: "folder",
			header: <LocalizedText messageKey="pages.projects.folder" english={"Folder"} />,
			sort: row => row.folder,
			render: row => (
				<span className="row projects-folder" title={row.folder || tr("pages.projects.root", "(root)")}>
					<span className="mono truncate">{formatFolder(row.folder, tr)}</span>
					{row.temporary && (
						<Badge>
							<LocalizedText messageKey="pages.projects.temp" english={"temp"} />
						</Badge>
					)}
				</span>
			),
		},
		{
			key: "requests",
			header: <LocalizedText messageKey="pages.projects.requests" english={"Requests"} />,
			align: "right",
			sort: row => row.totalRequests,
			render: row => (
				<span
					title={tr("pages.projects.percent_of_all_requests", "{percent} of all requests", {
						percent: formatPercent(row.requestShare),
					})}
				>
					<MeterCell value={row.totalRequests} max={maxRequests} display={formatInteger(row.totalRequests)} />
				</span>
			),
		},
		{
			key: "cost",
			header: <LocalizedText messageKey="pages.projects.cost" english={"Cost"} />,
			title: "API-equivalent cost at public API rates",
			titleKey: "pages.projects.api_equivalent_cost_at_public_api_rates",
			align: "right",
			sort: row => row.totalCost,
			render: row => (
				<span
					title={tr("pages.projects.percent_of_all_cost", "{percent} of all cost", {
						percent: formatPercent(row.costShare),
					})}
				>
					<MeterCell
						value={row.totalCost}
						max={maxCost}
						display={formatEstimatedCost(row.totalCost, row.unpricedRequests)}
						color="var(--chart-secondary)"
					/>
				</span>
			),
		},
		{
			key: "tokens",
			header: "Tokens",
			title: "Uncached input + cache reads + cache writes + output",
			titleKey: "pages.projects.uncached_input_cache_reads_cache_writes_output",
			align: "right",
			sort: row => row.conversationTokens,
			render: row => (
				<span className="num" title={formatInteger(row.conversationTokens)}>
					{formatCompact(row.conversationTokens)}
				</span>
			),
		},
		{
			key: "cacheRate",
			header: <LocalizedText messageKey="pages.projects.cache_rate" english={"Cache rate"} />,
			title: "Cache reads ÷ (uncached input + cache reads)",
			titleKey: "pages.projects.cache_reads_uncached_input_cache_reads",
			align: "right",
			sort: row => row.cacheRate,
			render: row => <span className="num">{formatPercent(row.cacheRate)}</span>,
		},
		{
			key: "cacheSavings",
			header: <LocalizedText messageKey="pages.projects.cache_savings" english={"Cache savings"} />,
			title: "Prompt-input cost saved versus billing the same tokens uncached",
			titleKey: "pages.projects.prompt_input_cost_saved_versus_billing_the",
			align: "right",
			sort: row => row.cacheSavings,
			render: row => (
				<span className={`num ${row.cacheSavings < 0 ? "tone-bad" : "muted"}`}>
					{formatPercent(row.cacheSavings)}
				</span>
			),
		},
		{
			key: "errorRate",
			header: <LocalizedText messageKey="pages.projects.errors" english={"Errors"} />,
			align: "right",
			sort: row => row.errorRate,
			render: row => (
				<span
					title={tr("pages.projects.count_failed", "{count} failed", { count: formatInteger(row.failedRequests) })}
				>
					<Badge tone={row.failedRequests > 0 ? errorRateTone(row.errorRate) : "neutral"} mono>
						{formatErrorRate(row.errorRate)}
					</Badge>
				</span>
			),
		},
		{
			key: "duration",
			header: <LocalizedText messageKey="pages.projects.avg_duration" english={"Avg duration"} />,
			align: "right",
			sort: row => row.avgDuration ?? -1,
			render: row => <span className="num">{formatDurationMs(row.avgDuration)}</span>,
		},
		{
			key: "last",
			header: <LocalizedText messageKey="pages.projects.last_active" english={"Last active"} />,
			align: "right",
			sort: row => row.lastTimestamp,
			render: row => <span className="dim">{formatRelativeTime(row.lastTimestamp, locale)}</span>,
		},
	];
}
