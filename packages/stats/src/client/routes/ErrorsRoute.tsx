import { LocalizedText, useTranslation, useLocale } from "../i18n";
import type { Locale, Translation } from "../types";
import { ArrowUpRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { getRecentErrors } from "../api";
import { BarList } from "../charts";
import { modelKey } from "../data/colors";
import {
	formatCompact,
	formatFolder,
	formatInteger,
	formatMessageCost,
	formatRelativeTime,
	formatTimestamp,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { type ErrorGroupView, errorSignature, groupErrorsBySignature } from "../data/view-models";
import type { MessageStats, TimeRange } from "../types";
import {
	Card,
	type Column,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	SearchInput,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
} from "../ui";
import "./errors.css";

export interface ErrorsRouteProps {
	active: boolean;
	range: TimeRange;
	onRequestClick: (id: number) => void;
}

/** How many of the newest failures to load; "Load more" steps through these. */
const LOAD_STEPS = [50, 200, 1_000] as const;

export function ErrorsRoute({ active, range, onRequestClick }: ErrorsRouteProps) {
	const locale = useLocale();
	const tr = useTranslation();
	const localizedFailureColumns = useMemo(() => failureColumns(locale, tr), [locale, tr]);
	const [step, setStep] = useState(0);
	const limit = LOAD_STEPS[step];
	const errors = useQuery(["errors", range, limit], ({ signal }) => getRecentErrors(range, limit, signal), {
		enabled: active,
	});
	const [selectedSignature, setSelectedSignature] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const meta = rangeMeta(range);

	const view = useMemo(() => {
		const rows = (errors.data ?? []).map(row => ({ row, signature: errorSignature(row.errorMessage) }));
		const groups = groupErrorsBySignature(errors.data ?? []);
		const byModel = new Map<string, { model: string; provider: string; count: number }>();
		for (const { row } of rows) {
			const key = modelKey(row.model, row.provider);
			const entry = byModel.get(key);
			if (entry) entry.count++;
			else byModel.set(key, { model: row.model, provider: row.provider, count: 1 });
		}
		const models = [...byModel.entries()]
			.map(([key, entry]) => ({ key, ...entry }))
			.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
		const newest = rows.reduce<MessageStats | null>(
			(best, { row }) => (!best || row.timestamp > best.timestamp ? row : best),
			null,
		);
		return { rows, groups, models, newest };
	}, [errors.data]);

	// Selections that no longer exist in this range's data are ignored.
	const signature = view.groups.some(g => g.signature === selectedSignature) ? selectedSignature : null;
	const model = view.models.some(m => m.key === selectedModel) ? selectedModel : null;

	const filtered = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return view.rows
			.filter(
				entry =>
					(signature === null || entry.signature === signature) &&
					(model === null || modelKey(entry.row.model, entry.row.provider) === model) &&
					(needle === "" ||
						entry.row.model.toLowerCase().includes(needle) ||
						entry.row.provider.toLowerCase().includes(needle) ||
						entry.row.folder.toLowerCase().includes(needle) ||
						(entry.row.errorMessage ?? "").toLowerCase().includes(needle)),
			)
			.map(entry => entry.row);
	}, [view.rows, signature, model, search]);

	const loaded = errors.data?.length ?? 0;
	// The server applies the range; fewer rows than the limit means we have them all.
	const complete = !errors.stale && loaded < limit;
	const nextStep = step + 1 < LOAD_STEPS.length ? LOAD_STEPS[step + 1] : null;
	const footer =
		errors.data !== null && !complete ? (
			<>
				<span>
					{tr(
						"pages.errors.latest_failures_loaded",
						"Showing the latest {count} failures in {window}; older ones are not loaded.",
						{ count: formatInteger(loaded), window: tr(`costs.window.${range}`, meta.windowLabel) },
					)}
				</span>
				{nextStep !== null && (
					<button
						type="button"
						className="btn"
						data-size="sm"
						disabled={errors.refreshing}
						onClick={() => setStep(step + 1)}
					>
						{errors.refreshing && errors.stale
							? tr("pages.errors.loading", "Loading…")
							: tr("pages.errors.load_latest_count", "Load latest {count}", { count: formatInteger(nextStep) })}
					</button>
				)}
			</>
		) : undefined;

	const maxGroup = view.groups[0]?.count ?? 0;
	const groupColumns = useMemo(() => buildGroupColumns(maxGroup, locale), [maxGroup, locale]);
	const selectedModelInfo = view.models.find(m => m.key === model);

	return (
		<div className="page">
			<PageHeader
				title={tr("pages.errors.errors", "Errors")}
				description={tr(
					"pages.errors.failed_model_requests_in_window_grouped_by",
					"Failed model requests in {window}, grouped by error signature. Open a failure for its full payload.",
					{ window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
			/>

			<QueryView query={errors} skeleton={<Skeleton height={96} style={{ borderRadius: 12 }} />}>
				{() => (
					<div data-stale={errors.stale}>
						<StatGrid min={170}>
							<Stat
								label={tr("pages.errors.failures", "Failures")}
								value={formatInteger(loaded)}
								hint={
									complete
										? tr("pages.errors.in_window", "in {window}", {
												window: tr(`costs.window.${range}`, meta.windowLabel),
											})
										: tr("pages.errors.latest_count_loaded", "latest {count} loaded", {
												count: formatInteger(loaded),
											})
								}
							/>
							<Stat
								label={tr("pages.errors.signatures", "Signatures")}
								title={tr(
									"pages.errors.distinct_error_messages_after_normalizing_ids_and",
									"Distinct error messages after normalizing ids and numbers",
								)}
								value={formatInteger(view.groups.length)}
								hint={
									view.groups[0]
										? tr("pages.errors.top_count_failures", "top: {count} failures", {
												count: formatInteger(view.groups[0].count),
											})
										: undefined
								}
							/>
							<Stat
								label={tr("pages.errors.affected_models", "Affected models")}
								value={formatInteger(view.models.length)}
								hint={view.models[0]?.model}
							/>
							<Stat
								label={tr("pages.errors.last_failure", "Last failure")}
								value={view.newest ? formatRelativeTime(view.newest.timestamp, locale) : "–"}
								hint={
									view.newest
										? formatTimestamp(view.newest.timestamp, locale)
										: tr("pages.errors.none_in_window", "none in {window}", {
												window: tr(`costs.window.${range}`, meta.windowLabel),
											})
								}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-main-side">
				<Card
					index={1}
					title={tr("pages.errors.error_signatures", "Error signatures")}
					description={tr(
						"pages.errors.same_message_with_ids_and_counters_normalized",
						"Same message with ids and counters normalized. Select one to filter the failures below.",
					)}
					flush
					stale={errors.stale}
				>
					<QueryView
						query={errors}
						skeleton={<TableSkeleton rows={8} />}
						isEmpty={rows => rows.length === 0}
						empty={
							<EmptyState
								title={tr("pages.errors.no_failures_in_window", "No failures in {window}", {
									window: tr(`costs.window.${range}`, meta.windowLabel),
								})}
								hint={tr(
									"pages.errors.every_request_succeeded_or_was_aborted",
									"Every request succeeded or was aborted.",
								)}
							/>
						}
					>
						{() => (
							<Table
								rows={view.groups}
								rowKey={group => group.signature}
								columns={groupColumns}
								onRowClick={group =>
									setSelectedSignature(signature === group.signature ? null : group.signature)
								}
								selectedKey={signature}
								expanded={group =>
									group.signature === signature ? (
										<SignatureDetail group={group} onRequestClick={onRequestClick} />
									) : null
								}
								limit={12}
							/>
						)}
					</QueryView>
				</Card>

				<Card
					index={2}
					title={tr("pages.errors.by_model", "By model")}
					description={tr(
						"pages.errors.failures_per_model_select_one_to_filter",
						"Failures per model. Select one to filter.",
					)}
					stale={errors.stale}
				>
					<QueryView
						query={errors}
						skeleton={<Skeleton height={180} />}
						isEmpty={rows => rows.length === 0}
						empty={<EmptyState title={tr("pages.errors.no_affected_models", "No affected models")} />}
					>
						{() => (
							<BarList
								items={view.models.slice(0, 12).map(m => ({
									key: m.key,
									label: (
										<span className="row" style={{ gap: 6, minWidth: 0 }}>
											<span className="mono truncate">{m.model}</span>
											<span className="dim truncate">{m.provider}</span>
										</span>
									),
									value: m.count,
									color: m.key === model ? "var(--bad)" : "color-mix(in srgb, var(--bad) 45%, transparent)",
								}))}
								onSelect={key => setSelectedModel(model === key ? null : key)}
							/>
						)}
					</QueryView>
				</Card>
			</div>

			<Card
				index={3}
				title={tr("pages.errors.failures", "Failures")}
				description={
					errors.data === null
						? tr("pages.errors.loading_failures", "Loading failures…")
						: tr(
								"pages.errors.count_of_total_failures_newest_first",
								"{count} of {total} failures, newest first",
								{ count: formatInteger(filtered.length), total: formatInteger(loaded) },
							)
				}
				actions={
					<>
						{signature !== null && (
							<button
								type="button"
								className="btn errors-filter"
								data-size="sm"
								onClick={() => setSelectedSignature(null)}
								title={signature}
							>
								<span className="mono truncate">{signature}</span>
								<X size={12} />
							</button>
						)}
						{selectedModelInfo && (
							<button
								type="button"
								className="btn errors-filter"
								data-size="sm"
								onClick={() => setSelectedModel(null)}
							>
								<span className="mono truncate">{selectedModelInfo.model}</span>
								<X size={12} />
							</button>
						)}
						<SearchInput
							value={search}
							onChange={setSearch}
							placeholder={tr("pages.errors.message_model_or_project", "Message, model or project")}
						/>
					</>
				}
				flush
				stale={errors.stale}
				footer={footer}
			>
				<QueryView
					query={errors}
					skeleton={<TableSkeleton rows={10} />}
					isEmpty={rows => rows.length === 0}
					empty={
						<EmptyState
							title={tr("pages.errors.no_failures_in_window", "No failures in {window}", {
								window: tr(`costs.window.${range}`, meta.windowLabel),
							})}
						/>
					}
				>
					{() => (
						<Table
							rows={filtered}
							rowKey={row => row.id ?? `${row.sessionFile}:${row.entryId}`}
							onRowClick={row => row.id !== undefined && onRequestClick(row.id)}
							columns={localizedFailureColumns}
							initialSort={{ key: "time", dir: "desc" }}
							limit={50}
							dense
							empty={
								<EmptyState
									title={tr("pages.errors.no_failures_match", "No failures match")}
									hint={tr(
										"pages.errors.clear_the_search_or_the_selected_filters",
										"Clear the search or the selected filters.",
									)}
								/>
							}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}

function buildGroupColumns(maxCount: number, locale: Locale): Column<ErrorGroupView>[] {
	return [
		{
			key: "signature",
			header: <LocalizedText messageKey="pages.errors.signature" english={"Signature"} />,
			wrap: true,
			sort: group => group.signature,
			render: group => (
				<span className="errors-signature" title={group.latest.errorMessage ?? undefined}>
					{group.signature}
				</span>
			),
		},
		{
			key: "models",
			header: <LocalizedText messageKey="pages.errors.models" english={"Models"} />,
			sort: group => group.models.length,
			render: group => (
				<LabelCell
					primary={<span className="mono">{group.models[0]?.model}</span>}
					secondary={group.models.length > 1 ? `+${group.models.length - 1} more` : group.models[0]?.provider}
				/>
			),
		},
		{
			key: "last",
			header: <LocalizedText messageKey="pages.errors.last_seen" english={"Last seen"} />,
			sort: group => group.lastSeen,
			render: group => (
				<span className="muted" title={formatTimestamp(group.lastSeen, locale)}>
					{formatRelativeTime(group.lastSeen, locale)}
				</span>
			),
		},
		{
			key: "count",
			header: <LocalizedText messageKey="pages.errors.failures" english={"Failures"} />,
			align: "right",
			width: 120,
			sort: group => group.count,
			render: group => (
				<MeterCell value={group.count} max={maxCount} display={formatInteger(group.count)} color="var(--bad)" />
			),
		},
	];
}

function SignatureDetail({ group, onRequestClick }: { group: ErrorGroupView; onRequestClick: (id: number) => void }) {
	const locale = useLocale();
	const tr = useTranslation();
	const latestId = group.latest.id;
	return (
		<div className="errors-detail">
			<pre className="code-block errors-detail-message">
				{group.latest.errorMessage ?? tr("pages.errors.unknown_error", "Unknown error")}
			</pre>
			<div className="errors-detail-meta">
				<span className="muted">
					{formatInteger(group.count)}
					{tr("pages.errors.failures_first", " failures · first ")}
					{formatTimestamp(group.firstSeen, locale)}
					{tr("pages.errors.last", " · last")} {formatTimestamp(group.lastSeen, locale)}
				</span>
				{latestId !== undefined && (
					<button type="button" className="btn" data-size="sm" onClick={() => onRequestClick(latestId)}>
						{tr("pages.errors.open_latest", "Open latest ")}
						<ArrowUpRight size={13} />
					</button>
				)}
			</div>
			<div className="errors-detail-models">
				{group.models.map(m => (
					<span key={modelKey(m.model, m.provider)} className="badge" data-mono="true">
						{m.model} <span className="dim">{m.provider}</span>{" "}
						<span className="num">{formatCompact(m.count)}</span>
					</span>
				))}
			</div>
		</div>
	);
}

function failureColumns(locale: Locale, tr: Translation): readonly Column<MessageStats>[] {
	return [
		{
			key: "time",
			header: <LocalizedText messageKey="pages.errors.when" english={"When"} />,
			width: 120,
			sort: row => row.timestamp,
			render: row => (
				<span className="muted" title={formatTimestamp(row.timestamp, locale)}>
					{formatRelativeTime(row.timestamp, locale)}
				</span>
			),
		},
		{
			key: "model",
			header: <LocalizedText messageKey="pages.errors.model" english={"Model"} />,
			sort: row => row.model,
			render: row => <LabelCell primary={<span className="mono">{row.model}</span>} secondary={row.provider} />,
		},
		{
			key: "error",
			header: "Error",
			sort: row => row.errorMessage ?? "",
			render: row => (
				<span className="errors-message" title={row.errorMessage ?? undefined}>
					{row.errorMessage ?? <LocalizedText messageKey="pages.errors.unknown_error" english={"Unknown error"} />}
				</span>
			),
		},
		{
			key: "project",
			header: <LocalizedText messageKey="pages.errors.project" english={"Project"} />,
			sort: row => row.folder,
			render: row => (
				<span className="mono muted" title={row.folder}>
					{formatFolder(row.folder, tr)}
				</span>
			),
		},
		{
			key: "tokens",
			header: "Tokens",
			align: "right",
			sort: row => row.usage.totalTokens,
			render: row => <span className="num">{formatInteger(row.usage.totalTokens)}</span>,
		},
		{
			key: "cost",
			header: <LocalizedText messageKey="pages.errors.cost" english={"Cost"} />,
			title: "API-equivalent estimate",
			titleKey: "pages.errors.api_equivalent_estimate",
			align: "right",
			sort: row => row.usage.cost.total,
			render: row => <span className="num">{formatMessageCost(row, 4)}</span>,
		},
	];
}
