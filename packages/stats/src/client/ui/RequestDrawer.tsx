import { useTranslation, useLocale } from "../i18n";
import { GitBranch } from "lucide-react";
import { getRequestDetails } from "../api";
import {
	formatCost,
	formatDurationMs,
	formatFolder,
	formatInteger,
	formatMessageCost,
	formatRelativeTime,
	formatTimestamp,
	formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { buildHash, parseHash } from "../data/useHashRoute";
import { type RequestStatus, requestStatus } from "../data/view-models";
import { statsLocationHash } from "../host-transport";
import type { RequestDetails } from "../types";
import { Badge, type Tone } from "./Badge";
import { Drawer, KeyValues } from "./Drawer";
import { JsonBlock } from "./JsonBlock";
import { ErrorState, Skeleton } from "./States";
import "./request-drawer.css";

/** Label and tone for each request outcome; shared by the request tables. */
export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
	ok: { label: "OK", tone: "ok" },
	aborted: { label: "Aborted", tone: "warn" },
	failed: { label: "Failed", tone: "bad" },
};

export interface RequestDrawerProps {
	id: number | null;
	onClose: () => void;
}

/** Full detail sheet for one model request: timing, tokens, cost, ids, error, and the raw session entry. */
export function RequestDrawer({ id, onClose }: RequestDrawerProps) {
	const locale = useLocale();
	const tr = useTranslation();
	const query = useQuery(["request", id], ({ signal }) => getRequestDetails(id ?? 0, signal), {
		enabled: id !== null,
	});
	// Never show the previous request's payload under a new id.
	const details = query.stale ? null : query.data;
	const status = details ? REQUEST_STATUS[requestStatus(details)] : null;

	return (
		<Drawer
			open={id !== null}
			onClose={onClose}
			width={620}
			title={details ? <span className="mono">{details.model}</span> : tr("pages.requestdrawer.request", "Request")}
			subtitle={
				details ? (
					<>
						{details.provider} ·{" "}
						<span title={formatTimestamp(details.timestamp, locale)}>
							{formatRelativeTime(details.timestamp, locale)}
						</span>
					</>
				) : id !== null ? (
					<span className="mono">#{id}</span>
				) : undefined
			}
			actions={
				details && status ? (
					<div className="row" style={{ gap: 6 }}>
						<a
							className="btn"
							data-size="sm"
							data-variant="ghost"
							href={buildHash({
								...parseHash(statsLocationHash()),
								section: "traces",
								session: details.sessionFile,
							})}
							onClick={onClose}
							title={tr(
								"pages.requestdrawer.open_this_requests_session_in_the_trace",
								"Open this request's session in the trace view",
							)}
						>
							<GitBranch size={13} />
							{tr("pages.requestdrawer.trace", " Trace")}
						</a>
						<Badge tone={status.tone}>{tr(`pages.request_status.${requestStatus(details)}`, status.label)}</Badge>
					</div>
				) : undefined
			}
		>
			{details ? (
				<RequestDetailsBody details={details} aborted={requestStatus(details) === "aborted"} />
			) : query.error ? (
				<ErrorState error={query.error} onRetry={query.refetch} />
			) : (
				<div className="stack" style={{ gap: 12 }}>
					<Skeleton height={56} />
					<Skeleton height={120} />
					<Skeleton height={120} />
					<Skeleton height={220} />
				</div>
			)}
		</Drawer>
	);
}

function RequestDetailsBody({ details, aborted }: { details: RequestDetails; aborted: boolean }) {
	const locale = useLocale();
	const tr = useTranslation();
	const { usage } = details;
	const throughput =
		details.duration !== null && details.duration > 0 && usage.output > 0
			? (usage.output * 1000) / details.duration
			: null;
	// The stats row as ingested, without the session payload shown separately below.
	const { messages, output, ...row } = details;

	return (
		<>
			{details.errorMessage && (
				<section className="request-drawer-error" data-tone={aborted ? "warn" : "bad"} role="note">
					<div className="request-drawer-error-label">
						{aborted ? tr("pages.requestdrawer.aborted", "Aborted") : "Error"}
					</div>
					<pre className="request-drawer-error-text">{details.errorMessage}</pre>
				</section>
			)}

			<section>
				<div className="section-label">{tr("pages.requestdrawer.timing", "Timing")}</div>
				<KeyValues
					items={[
						{
							key: "at",
							label: tr("pages.requestdrawer.started", "Started"),
							value: formatTimestamp(details.timestamp, locale),
						},
						{
							key: "duration",
							label: tr("pages.requestdrawer.duration", "Duration"),
							value: formatDurationMs(details.duration),
						},
						{
							key: "ttft",
							label: tr("pages.requestdrawer.time_to_first_token", "Time to first token"),
							value: formatDurationMs(details.ttft),
						},
						{
							key: "tps",
							label: tr("pages.requestdrawer.output_tokens_s", "Output tokens/s"),
							value: formatTokensPerSecond(throughput),
						},
					]}
				/>
			</section>

			<section>
				<div className="section-label">Tokens</div>
				<KeyValues
					items={[
						{
							key: "input",
							label: tr("pages.requestdrawer.uncached_input", "Uncached input"),
							value: formatInteger(usage.input),
						},
						{
							key: "cacheRead",
							label: tr("pages.requestdrawer.cache_read", "Cache read"),
							value: formatInteger(usage.cacheRead),
						},
						{
							key: "cacheWrite",
							label: tr("pages.requestdrawer.cache_write", "Cache write"),
							value: formatInteger(usage.cacheWrite),
						},
						{
							key: "output",
							label: tr("pages.requestdrawer.output", "Output"),
							value: formatInteger(usage.output),
						},
						{ key: "total", label: "Total", value: formatInteger(usage.totalTokens) },
						{
							key: "premium",
							label: tr("pages.requestdrawer.premium_requests", "Premium requests"),
							value: formatInteger(Math.round((usage.premiumRequests ?? 0) * 100) / 100),
						},
					]}
				/>
			</section>

			<section>
				<div className="section-label">{tr("pages.requestdrawer.api_equivalent_cost", "API-equivalent cost")}</div>
				<KeyValues
					items={[
						{ key: "total", label: "Total", value: formatMessageCost(details, 4) },
						{
							key: "input",
							label: tr("pages.requestdrawer.input", "Input"),
							value: formatCost(usage.cost.input, 4),
						},
						{
							key: "cacheRead",
							label: tr("pages.requestdrawer.cache_read", "Cache read"),
							value: formatCost(usage.cost.cacheRead, 4),
						},
						{
							key: "cacheWrite",
							label: tr("pages.requestdrawer.cache_write", "Cache write"),
							value: formatCost(usage.cost.cacheWrite, 4),
						},
						{
							key: "output",
							label: tr("pages.requestdrawer.output", "Output"),
							value: formatCost(usage.cost.output, 4),
						},
					]}
				/>
			</section>

			<section>
				<div className="section-label">{tr("pages.requestdrawer.identity", "Identity")}</div>
				<KeyValues
					items={[
						{ key: "id", label: tr("pages.requestdrawer.request_id", "Request id"), value: details.id ?? "–" },
						{ key: "entry", label: tr("pages.requestdrawer.entry_id", "Entry id"), value: details.entryId },
						{
							key: "stop",
							label: tr("pages.requestdrawer.stop_reason", "Stop reason"),
							value: details.stopReason,
						},
						{ key: "api", label: "API", value: details.api },
						{
							key: "project",
							label: tr("pages.requestdrawer.project", "Project"),
							value: <span title={details.folder}>{formatFolder(details.folder, tr)}</span>,
						},
					]}
				/>
				<div className="request-drawer-file">
					<span className="kv-key">{tr("pages.requestdrawer.session_file", "Session file")}</span>
					<span className="kv-value">{details.sessionFile}</span>
				</div>
			</section>

			{output != null && (
				<JsonBlock data={output} title={tr("pages.requestdrawer.output_message", "Output message")} />
			)}
			<JsonBlock data={messages} title={tr("pages.requestdrawer.session_entry", "Session entry")} initialCollapsed />
			<JsonBlock data={row} title={tr("pages.requestdrawer.stats_row", "Stats row")} initialCollapsed />
		</>
	);
}
