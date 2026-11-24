import { TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import { formatCost, formatDurationMs, formatInteger } from "../data/formatters";
import { LocalizedText, useTranslation } from "../i18n";
import type { SpotlightDashboardStats, SpotlightFailureCause, SpotlightOverhead, Translation } from "../types";
import { Badge, Card, type Column, errorRateTone, Table } from "../ui";
import { formatShare } from "./meta";

/** p50 with p90 beside it, dim. */
function Percentiles({ p50, p90 }: { p50: number | null; p90: number | null }) {
	if (p50 === null) return <span className="dim">–</span>;
	return (
		<span className="num">
			{formatDurationMs(p50)}
			<span className="dim"> / {formatDurationMs(p90)}</span>
		</span>
	);
}

/** Causes whose code words don't read well; the rest show their code with spaces. */
const CAUSE_LABELS: Readonly<Record<string, string>> = {
	no_credential: "not signed in",
	transport: "network",
	timeout: "timeout",
	rate_limited: "rate limited",
	bad_reply: "bad reply",
	unrecorded: "unrecorded",
};

/** A failure cause as the card names it: `http_502` reads "HTTP 502", any other code its words. */
function causeLabel(tr: Translation, cause: string): string {
	const http = /^http_(\d+)$/.exec(cause);
	if (http) return `HTTP ${http[1]}`;
	return Object.hasOwn(CAUSE_LABELS, cause)
		? tr(`insights.overhead.cause.${cause}`, CAUSE_LABELS[cause])
		: cause.replaceAll("_", " ");
}

/** Each cause with its share of the results that called Spotlight; its result count on hover. */
function FailureCauses({ causes }: { causes: readonly SpotlightFailureCause[] }) {
	const tr = useTranslation();
	if (causes.length === 0) return <span className="dim">–</span>;
	return (
		<span>
			{causes.map(({ cause, results, share }, i) => (
				<Fragment key={cause}>
					{i > 0 && <span className="dim"> · </span>}
					<span
						className="spot-nowrap"
						title={tr("insights.results_count", "{count} results", { count: formatInteger(results) })}
					>
						{causeLabel(tr, cause)} <span className="num">{formatShare(share)}</span>
					</span>
				</Fragment>
			))}
		</span>
	);
}

const COLUMNS: Column<SpotlightOverhead>[] = [
	{
		key: "failures",
		header: <LocalizedText messageKey="insights.overhead.header.failures" english="Spotlight failures" />,
		align: "right",
		sort: row => row.failureRate ?? -1,
		title: "Results whose Spotlight calls failed or timed out, of those that called it: they were cut by the no-score fallback",
		titleKey: "insights.overhead.tip.failures",
		render: row =>
			row.failureRate === null ? (
				<span className="dim">–</span>
			) : (
				<Badge tone={errorRateTone(row.failureRate)} mono>
					{formatShare(row.failureRate)}
				</Badge>
			),
	},
	{
		key: "causes",
		header: <LocalizedText messageKey="insights.overhead.header.causes" english="Failure causes" />,
		align: "right",
		sort: row => row.failureCauses[0]?.share ?? -1,
		wrap: true,
		title: "Why the calls failed, as shares of the results that called Spotlight. A result whose calls failed two ways counts under both; unrecorded results were journaled before pi recorded causes",
		titleKey: "insights.overhead.tip.causes",
		render: row => <FailureCauses causes={row.failureCauses} />,
	},
	{
		key: "failedWait",
		header: <LocalizedText messageKey="insights.overhead.header.failed_wait" english="Waited on failures" />,
		align: "right",
		sort: row => row.failedWaitMs,
		title: "Wall time tool calls spent on Spotlight calls that failed or timed out",
		titleKey: "insights.overhead.tip.failed_wait",
		render: row =>
			row.failedWaitMs > 0 ? (
				<span className="num">{formatDurationMs(row.failedWaitMs)}</span>
			) : (
				<span className="dim">–</span>
			),
	},
	{
		key: "results",
		header: <LocalizedText messageKey="insights.overhead.header.results" english="Results" />,
		align: "right",
		sort: row => row.results,
		title: "Results Spotlight evaluated, held-out ones included",
		titleKey: "insights.overhead.tip.results",
		render: row => <span className="num">{formatInteger(row.results)}</span>,
	},
	{
		key: "shape",
		header: <LocalizedText messageKey="insights.overhead.header.shaping" english="Shaping p50 / p90" />,
		align: "right",
		sort: row => row.shapeMsP50 ?? -1,
		title: "Wall time shaping added to a tool call",
		titleKey: "insights.overhead.tip.shaping",
		render: row => <Percentiles p50={row.shapeMsP50} p90={row.shapeMsP90} />,
	},
	{
		key: "spotlight",
		header: <LocalizedText messageKey="insights.overhead.header.spotlight" english="Spotlight p50 / p90" />,
		align: "right",
		sort: row => row.spotlightMsP50 ?? -1,
		title: "Spotlight's own request time, over results whose calls all answered",
		titleKey: "insights.overhead.tip.spotlight",
		render: row => <Percentiles p50={row.spotlightMsP50} p90={row.spotlightMsP90} />,
	},
	{
		key: "usd",
		header: <LocalizedText messageKey="insights.overhead.header.usd" english="Spotlight $" />,
		align: "right",
		sort: row => row.spotlightUsd,
		render: row => <span className="num">{formatCost(row.spotlightUsd)}</span>,
	},
];

/**
 * Failed Spotlight calls mean the cut came from the no-score fallback, not Spotlight's scorer: every comparison then
 * partly measures the fallback. Called out above the table once the failure rate reaches the warning rate.
 */
function FailureCallout({ overhead }: { overhead: SpotlightOverhead }) {
	const tr = useTranslation();
	const rate = overhead.failureRate;
	if (rate === null) return null;
	const tone = errorRateTone(rate);
	if (tone === "ok") return null;
	const waitedMs = overhead.failedWaitMs;
	const unsigned = overhead.failureCauses.find(c => c.cause === "no_credential");
	return (
		<div className="spot-callout" data-tone={tone} role="note">
			<TriangleAlert size={16} aria-hidden="true" />
			<div>
				<div className="spot-callout-head">
					<span className="num">{formatShare(rate)}</span>
					{tr("insights.overhead.warning_head", " of results that called Spotlight failed")}
				</div>
				<p className="spot-callout-copy">
					{tr(
						"insights.overhead.warning_body",
						"A failed or timed-out call leaves the cut to the no-score fallback, so those results measure the fallback rather than Spotlight's scorer. Read every comparison on this page with that share in mind.",
					)}
					{waitedMs > 0 && (
						<>
							{" "}
							{tr("insights.overhead.warning_wait_lead", "Tool calls waited ")}
							<span className="num">{formatDurationMs(waitedMs)}</span>
							{tr("insights.overhead.warning_wait_end", " on those failures.")}
						</>
					)}
					{unsigned && (
						<>
							{" "}
							<span className="num">{formatShare(unsigned.share)}</span>
							{tr("insights.overhead.warning_login_lead", " had no Stencil sign-in: run")} <code>/login</code>
							{tr("insights.overhead.warning_login_middle", " and choose Stencil, or set ")}
							<code>STENCIL_API_KEY</code>
							{tr("insights.overhead.warning_login_end", ", to restore ranking.")}
						</>
					)}
				</p>
			</div>
		</div>
	);
}

/** What shaping costs in latency, reliability and Spotlight's bill. */
export function Overhead({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const tr = useTranslation();
	const { overhead } = stats;
	const rows = overhead.results > 0 ? [overhead] : [];
	return (
		<Card
			index={3}
			title={tr("insights.overhead.title", "Overhead")}
			description={tr(
				"insights.overhead.description",
				"What shaping costs: Spotlight failures, added latency and its bill",
			)}
			flush
			stale={stale}
			footer={tr(
				"insights.overhead.footer",
				"Every evaluated result counts, held-out ones included: they were shaped too, just not shown.",
			)}
		>
			{overhead.results > 0 && <FailureCallout overhead={overhead} />}
			<Table
				rows={rows}
				rowKey={() => "overhead"}
				columns={COLUMNS}
				dense
				empty={<div className="empty">{tr("insights.no_evaluated", "No evaluated results in this range.")}</div>}
			/>
		</Card>
	);
}
