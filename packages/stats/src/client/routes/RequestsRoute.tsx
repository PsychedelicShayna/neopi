import { LocalizedText, useTranslation, useLocale } from "../i18n";
import type { Locale, Translation } from "../types";
import { useMemo, useState } from "react";
import { getRecentRequests } from "../api";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatFolder,
	formatInteger,
	formatMessageCost,
	formatRelativeTime,
	formatTimestamp,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { type RequestStatus, requestStatus, summarizeRequests } from "../data/view-models";
import { REQUEST_STATUS } from "../ui/RequestDrawer";
import type { MessageStats, TimeRange } from "../types";
import {
	Card,
	type Column,
	Dot,
	EmptyState,
	LabelCell,
	PageHeader,
	QueryView,
	SearchInput,
	Segmented,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";

export interface RequestsRouteProps {
	active: boolean;
	range: TimeRange;
	onRequestClick: (id: number) => void;
}

/** How many of the newest requests to load; "Load more" steps through these. */
const LOAD_STEPS = [500, 2_000, 10_000] as const;

type StatusFilter = "all" | RequestStatus;

export function RequestsRoute({ active, range, onRequestClick }: RequestsRouteProps) {
	const locale = useLocale();
	const tr = useTranslation();
	const localizedRequestColumns = useMemo(() => requestColumns(locale, tr), [locale, tr]);
	const [step, setStep] = useState(0);
	const limit = LOAD_STEPS[step];
	const log = useQuery(["requests-log", limit], ({ signal }) => getRecentRequests(limit, signal), { enabled: active });
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<StatusFilter>("all");
	const meta = rangeMeta(range);

	const view = useMemo(() => {
		const rows = log.data ?? [];
		const cutoff = meta.spanMs === null ? null : Date.now() - meta.spanMs;
		const inRange = cutoff === null ? rows : rows.filter(row => row.timestamp >= cutoff);
		// The loaded window covers the whole range when the server ran out of rows
		// or the oldest loaded row is already older than the range start. Stale
		// rows belong to a smaller limit that is being replaced.
		const complete = !log.stale && (rows.length < limit || (cutoff !== null && inRange.length < rows.length));
		const counts: Record<StatusFilter, number> = { all: inRange.length, ok: 0, aborted: 0, failed: 0 };
		for (const row of inRange) counts[requestStatus(row)]++;
		return { loaded: rows.length, inRange, complete, counts, summary: summarizeRequests(inRange) };
	}, [log.data, log.stale, limit, meta.spanMs]);

	const filtered = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return view.inRange.filter(
			row =>
				(status === "all" || requestStatus(row) === status) &&
				(needle === "" ||
					row.model.toLowerCase().includes(needle) ||
					row.provider.toLowerCase().includes(needle) ||
					row.folder.toLowerCase().includes(needle)),
		);
	}, [view.inRange, search, status]);

	const { summary, counts, complete } = view;
	const nextStep = step + 1 < LOAD_STEPS.length ? LOAD_STEPS[step + 1] : null;
	const loadMore =
		nextStep !== null ? (
			<button
				type="button"
				className="btn"
				data-size="sm"
				disabled={log.refreshing}
				onClick={() => setStep(step + 1)}
			>
				{log.refreshing && log.stale
					? tr("pages.requests.loading", "Loading…")
					: tr("pages.requests.load_latest_count", "Load latest {count}", { count: formatInteger(nextStep) })}
			</button>
		) : undefined;

	const statusOptions = (["all", "ok", "aborted", "failed"] as const).map(value => ({
		value,
		label: (
			<>
				{value === "all"
					? tr("pages.requests.all", "All")
					: tr(`pages.request_status.${value}`, REQUEST_STATUS[value].label)}{" "}
				<span className="dim num">{formatCompact(counts[value])}</span>
			</>
		),
	}));

	return (
		<div className="page">
			<PageHeader
				title={tr("pages.requests.requests", "Requests")}
				description={tr(
					"pages.requests.every_model_call_neopi_made_in_window",
					"Every model call NeoPi made in {window}, newest first. Open a row for its full payload.",
					{ window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
			/>

			<QueryView query={log} skeleton={<Skeleton height={96} style={{ borderRadius: 12 }} />}>
				{() => (
					<div data-stale={log.stale}>
						<StatGrid min={160}>
							<Stat
								label={tr("pages.requests.requests", "Requests")}
								value={formatInteger(summary.requests)}
								hint={
									summary.oldest === null
										? tr("pages.requests.none_in_window", "none in {window}", {
												window: tr(`costs.window.${range}`, meta.windowLabel),
											})
										: tr("pages.requests.since_time", "since {time}", {
												time: formatRelativeTime(summary.oldest, locale),
											})
								}
							/>
							<Stat
								label={tr("pages.requests.failed", "Failed")}
								value={formatInteger(summary.failed)}
								hint={tr("pages.requests.rate_aborted_aborted", "{rate} · {aborted} aborted", {
									rate: summary.requests > 0 ? formatErrorRate(summary.failed / summary.requests) : "–",
									aborted: formatInteger(summary.aborted),
								})}
							/>
							<Stat
								label="Tokens"
								title={tr(
									"pages.requests.total_tokens_across_these_requests",
									"Total tokens across these requests",
								)}
								value={formatCompact(summary.tokens)}
							/>
							<Stat
								label={tr("pages.requests.api_equivalent_cost", "API-equivalent cost")}
								title={tr(
									"pages.requests.what_these_requests_would_cost_at_public",
									"What these requests would cost at public API rates",
								)}
								value={formatEstimatedCost(summary.cost, summary.unpriced)}
								hint={
									summary.unpriced > 0
										? tr("pages.requests.count_unpriced", "{count} unpriced", {
												count: formatInteger(summary.unpriced),
											})
										: undefined
								}
							/>
							<Stat
								label={tr("pages.requests.median_duration", "Median duration")}
								value={formatDurationMs(summary.medianDuration)}
								hint={`p95 ${formatDurationMs(summary.p95Duration)}`}
							/>
							<Stat
								label={tr("pages.requests.median_ttft", "Median TTFT")}
								title={tr("pages.requests.time_to_first_token", "Time to first token")}
								value={formatDurationMs(summary.medianTtft)}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<Card
				index={1}
				title={tr("pages.requests.request_log", "Request log")}
				description={
					log.data === null
						? tr("pages.requests.loading_the_latest_requests", "Loading the latest requests…")
						: complete
							? tr(
									"pages.requests.count_of_total_requests_in_window",
									"{count} of {total} requests in {window}",
									{
										count: formatInteger(filtered.length),
										total: formatInteger(summary.requests),
										window: tr(`costs.window.${range}`, meta.windowLabel),
									},
								)
							: tr(
									"pages.requests.count_of_the_latest_total_requests",
									"{count} of the latest {total} requests",
									{ count: formatInteger(filtered.length), total: formatInteger(summary.requests) },
								)
				}
				actions={
					<>
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder={tr("pages.requests.model_provider_or_project", "Model, provider or project")}
						/>
						<Segmented
							size="sm"
							aria-label={tr("pages.requests.status", "Status")}
							options={statusOptions}
							value={status}
							onChange={setStatus}
						/>
					</>
				}
				flush
				stale={log.stale}
				footer={
					log.data !== null && !complete ? (
						<>
							<span>
								{tr(
									"pages.requests.latest_requests_loaded",
									"Showing the latest {count} requests, back to {date}. Older requests in {window} are not loaded.",
									{
										count: formatInteger(view.loaded),
										date: summary.oldest === null ? "–" : formatTimestamp(summary.oldest, locale),
										window: tr(`costs.window.${range}`, meta.windowLabel),
									},
								)}
							</span>
							{loadMore}
						</>
					) : undefined
				}
			>
				<QueryView query={log} skeleton={<TableSkeleton rows={12} />}>
					{() => (
						<Table
							rows={filtered}
							rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
							onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
							columns={localizedRequestColumns}
							initialSort={{ key: "time", dir: "desc" }}
							limit={100}
							dense
							empty={
								<EmptyState
									title={
										summary.requests === 0
											? tr("pages.requests.no_requests_in_window", "No requests in {window}", {
													window: tr(`costs.window.${range}`, meta.windowLabel),
												})
											: tr("pages.requests.no_requests_match", "No requests match")
									}
									hint={
										summary.requests === 0
											? undefined
											: tr(
													"pages.requests.clear_the_search_or_status_filter",
													"Clear the search or status filter.",
												)
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

function requestColumns(locale: Locale, tr: Translation): readonly Column<MessageStats>[] {
	return [
		{
			key: "model",
			header: <LocalizedText messageKey="pages.requests.model" english={"Model"} />,
			sort: row => row.model,
			render: row => <LabelCell primary={<span className="mono">{row.model}</span>} secondary={row.provider} />,
		},
		{
			key: "time",
			header: <LocalizedText messageKey="pages.requests.when" english={"When"} />,
			sort: row => row.timestamp,
			render: row => (
				<span className="muted" title={formatTimestamp(row.timestamp, locale)}>
					{formatRelativeTime(row.timestamp, locale)}
				</span>
			),
		},
		{
			key: "project",
			header: <LocalizedText messageKey="pages.requests.project" english={"Project"} />,
			sort: row => row.folder,
			render: row => (
				<span className="mono muted truncate" title={row.folder} style={{ display: "block", maxWidth: 180 }}>
					{formatFolder(row.folder, tr)}
				</span>
			),
		},
		{
			key: "input",
			header: <LocalizedText messageKey="pages.requests.input" english={"Input"} />,
			title: "Uncached input tokens",
			titleKey: "pages.requests.uncached_input_tokens",
			align: "right",
			sort: row => row.usage.input,
			render: row => <span className="num">{formatCompact(row.usage.input)}</span>,
		},
		{
			key: "cache",
			header: <LocalizedText messageKey="pages.requests.cache_read" english={"Cache read"} />,
			title: "Cache read tokens (hover a cell for cache writes)",
			titleKey: "pages.requests.cache_read_tokens_hover_a_cell_for",
			align: "right",
			sort: row => row.usage.cacheRead,
			render: row => (
				<span
					className="num"
					title={tr("pages.requests.cache_write_count", "Cache write: {count}", {
						count: formatInteger(row.usage.cacheWrite),
					})}
				>
					{formatCompact(row.usage.cacheRead)}
				</span>
			),
		},
		{
			key: "output",
			header: <LocalizedText messageKey="pages.requests.output" english={"Output"} />,
			align: "right",
			sort: row => row.usage.output,
			render: row => <span className="num">{formatCompact(row.usage.output)}</span>,
		},
		{
			key: "cost",
			header: <LocalizedText messageKey="pages.requests.cost" english={"Cost"} />,
			title: "API-equivalent estimate",
			titleKey: "pages.requests.api_equivalent_estimate",
			align: "right",
			sort: row => row.usage.cost.total,
			render: row => <span className="num">{formatMessageCost(row, 4)}</span>,
		},
		{
			key: "duration",
			header: <LocalizedText messageKey="pages.requests.duration" english={"Duration"} />,
			align: "right",
			sort: row => row.duration ?? -1,
			render: row => <span className="num">{formatDurationMs(row.duration)}</span>,
		},
		{
			key: "ttft",
			header: "TTFT",
			title: "Time to first token",
			titleKey: "pages.requests.time_to_first_token",
			align: "right",
			sort: row => row.ttft ?? -1,
			render: row => <span className="num muted">{formatDurationMs(row.ttft)}</span>,
		},
		{
			key: "status",
			header: <LocalizedText messageKey="pages.requests.status" english={"Status"} />,
			sort: row => requestStatus(row),
			render: row => {
				const status = REQUEST_STATUS[requestStatus(row)];
				return (
					<span title={row.errorMessage ?? undefined}>
						<LabelCell
							lead={<Dot tone={status.tone} />}
							primary={tr(`pages.request_status.${requestStatus(row)}`, status.label)}
							secondary={<span className="mono">{row.stopReason}</span>}
						/>
					</span>
				);
			},
		},
	];
}
