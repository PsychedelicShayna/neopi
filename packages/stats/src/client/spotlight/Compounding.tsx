import { format } from "@oh-my-pi/pi-utils/dates";
import { useMemo, useState } from "react";
import { getSpotlightSessionContext } from "../api";
import { Chart, type ChartSeries, Legend, type SlotMarker } from "../charts";
import { formatCompact, formatFolder, formatInteger, formatTimestamp } from "../data/formatters";
import { useQuery } from "../data/query";
import { useLocale, useTranslation } from "../i18n";
import type { SpotlightDashboardStats, SpotlightSessionContext, SpotlightSessionSummary, Translation } from "../types";
import { Badge, Card, ChartSkeleton, EmptyState, ErrorState } from "../ui";
import { formatShare, formatSignedCompact, formatSignedCost } from "./meta";

export interface CompoundingProps {
	stats: SpotlightDashboardStats;
	active: boolean;
	stale: boolean;
}

/**
 * Title, else a subagent's file name (`Consumers.jsonl`), else the project
 * folder. Subagent and advisor sessions are indented under an arrow and tagged,
 * since they sit in the newest-first list beside the session that spawned them.
 */
function sessionLabel(tr: Translation, session: SpotlightSessionSummary): string {
	const main = session.agentType === "main";
	const base = (session.sessionFile.split("/").pop() ?? "").replace(/\.jsonl$/, "");
	const name = session.title?.trim() || (main ? formatFolder(session.folder, tr) : base);
	const head = main ? name : `↳ ${name} (${session.agentType})`;
	return tr("insights.compounding.session_option", "{head} · {count} saved", {
		head,
		count: formatCompact(session.savedTokens),
	});
}

/** A cut keeps paying: every later request would have re-read it. One session's context with and without shaping. */
export function Compounding({ stats, active, stale }: CompoundingProps) {
	const tr = useTranslation();
	const { compounding } = stats;
	const [picked, setPicked] = useState<string | null>(null);
	const sessions = stats.sessionList;
	// Default: the newest session that saved anything (the list is newest first).
	const fallback = sessions.find(s => s.savedTokens > 0) ?? sessions[0];
	const file = picked !== null && sessions.some(s => s.sessionFile === picked) ? picked : fallback?.sessionFile;

	const context = useQuery(
		["spotlight-session", file ?? null],
		({ signal }) => getSpotlightSessionContext(file ?? "", signal),
		{ enabled: active && file !== undefined },
	);
	const avoided = compounding.avoidedTokens - compounding.recoveredCarriedTokens;
	// Saving-weighted mean of the requests each cut stayed out of.
	const carry = stats.gross.savedTokens > 0 ? compounding.avoidedTokens / stats.gross.savedTokens : null;
	const points = context.data?.points;
	// The selected session's own share: what its requests would have carried without shaping, and didn't.
	const sessionShare = useMemo(() => {
		if (!points) return null;
		let gap = 0;
		let without = 0;
		for (const p of points) {
			gap += p.withoutTokens - p.contextTokens;
			without += p.withoutTokens;
		}
		return without > 0 ? { share: gap / without, tokens: gap } : null;
	}, [points]);

	return (
		<Card
			index={3}
			title={tr("insights.compounding.title", "Compounding")}
			description={tr(
				"insights.compounding.description",
				"A cut is never re-read: each later request of the session carries a smaller context",
			)}
			actions={
				sessions.length > 0 && (
					<select
						className="input spot-session-select"
						aria-label={tr("insights.compounding.select_session", "Session")}
						value={file ?? ""}
						onChange={e => setPicked(e.target.value)}
					>
						{sessions.map(s => (
							<option key={s.sessionFile} value={s.sessionFile}>
								{sessionLabel(tr, s)}
							</option>
						))}
					</select>
				)
			}
			stale={stale}
			footer={tr(
				"insights.compounding.footer",
				"Context = input + cache read + cache write of each request. A compaction is a request whose context is under 60% of the previous one's; it ends the carry.",
			)}
		>
			<div className="spot-compounding">
				<div className="spot-compounding-chart">
					{file === undefined ? (
						<EmptyState title={tr("insights.compounding.empty", "No experiment sessions in this range")} />
					) : context.data === null ? (
						context.error ? (
							<ErrorState error={context.error} onRetry={context.refetch} />
						) : (
							<ChartSkeleton height={280} />
						)
					) : (
						<ContextChart context={context.data} stale={context.stale} />
					)}
				</div>
				<aside className="spot-compounding-side">
					<div className="spot-eyebrow">
						{tr("insights.compounding.avoided_title", "Context avoided in this session")}
					</div>
					<div className="spot-side-value">{formatShare(sessionShare?.share ?? null)}</div>
					{points !== undefined && (
						<p className="spot-side-copy">
							{sessionShare === null
								? tr("insights.compounding.no_recorded", "This session has no recorded requests.")
								: tr(
										"insights.compounding.session_savings",
										"of what its requests would have carried without Spotlight: {tokens} prompt tokens, net of recoveries.",
										{ tokens: formatSignedCompact(sessionShare.tokens) },
									)}
						</p>
					)}
					{context.data && <SessionFacts session={context.data.session} />}
					<p className="spot-side-range">
						<span className="spot-side-range-value">{formatShare(compounding.avoidedShare)}</span>{" "}
						{tr(
							"insights.compounding.range",
							"across all the sessions shown: cuts kept {tokens} tokens out of later requests",
							{ tokens: formatCompact(Math.max(0, avoided)) },
						)}
						{carry !== null &&
							tr("insights.compounding.carry", ", each saved token re-sent {count} times on average", {
								count: carry.toFixed(1),
							})}
						.
					</p>
				</aside>
			</div>
		</Card>
	);
}

function SessionFacts({ session }: { session: SpotlightSessionSummary }) {
	const tr = useTranslation();
	return (
		<dl className="spot-facts">
			<div>
				<dt>{tr("insights.compounding.agent", "Agent")}</dt>
				<dd className="row">
					<Badge>{session.agentType}</Badge>
				</dd>
			</div>
			<div>
				<dt>{tr("insights.compounding.requests", "Requests")}</dt>
				<dd className="num">{formatInteger(session.requests)}</dd>
			</div>
			<div>
				<dt>{tr("insights.saved", "Saved")}</dt>
				<dd className="num">{formatSignedCompact(session.savedTokens)}</dd>
			</div>
			<div>
				<dt>{tr("insights.compounding.net_usd", "Net $")}</dt>
				<dd className="num">{formatSignedCost(session.netUsd)}</dd>
			</div>
		</dl>
	);
}

/** One session's context per request. The x axis is the request number (several can share a minute); the tooltip carries the time. */
function ContextChart({ context, stale }: { context: SpotlightSessionContext; stale: boolean }) {
	const tr = useTranslation();
	const locale = useLocale();
	const { points } = context;
	const legend = [
		{ key: "actual", label: tr("insights.compounding.context", "Context"), color: "var(--spot-gross)" },
		{ key: "ghost", label: tr("insights.compounding.without", "Without Spotlight"), color: "var(--spot-ghost)" },
		{ key: "compaction", label: tr("insights.compounding.compaction", "Compaction"), color: "var(--line-4)" },
	];
	const chart = useMemo(() => {
		const series: ChartSeries[] = [
			{
				key: "actual",
				label: tr("insights.compounding.context", "Context"),
				color: "var(--spot-gross)",
				kind: "area",
				values: points.map(p => p.contextTokens),
			},
			{
				key: "ghost",
				label: tr("insights.compounding.avoided", "Avoided"),
				color: "var(--spot-ghost)",
				kind: "area",
				pattern: "hatch",
				dashed: true,
				values: points.map(p => Math.max(0, p.withoutTokens - p.contextTokens)),
			},
		];
		const markers: SlotMarker[] = [];
		points.forEach((p, i) => {
			if (p.compacted) markers.push({ index: i });
		});
		return { series, markers };
	}, [points, tr]);

	if (points.length === 0) {
		return <EmptyState title={tr("insights.compounding.no_requests", "No requests recorded for this session")} />;
	}
	return (
		<div className="spot-context" data-stale={stale}>
			<Legend items={legend} />
			<Chart
				slots={points.length}
				series={chart.series}
				markers={chart.markers}
				height={280}
				tickLabel={i => `#${i + 1}`}
				tooltipTitle={i =>
					tr("insights.compounding.tooltip_title", "Request {index} · {time}", {
						index: i + 1,
						time:
							locale === "es"
								? formatTimestamp(points[i].timestamp, locale)
								: format(new Date(points[i].timestamp), "MMM d HH:mm:ss"),
					})
				}
				formatTooltip={formatInteger}
				showTotal={false}
				tooltipExtra={i => {
					const p = points[i];
					return (
						<div className="spot-tooltip-extra">
							<div className="chart-tooltip-row chart-tooltip-total">
								<span className="chart-tooltip-label">
									{tr("insights.compounding.without", "Without Spotlight")}
								</span>
								<span className="chart-tooltip-value">{formatInteger(p.withoutTokens)}</span>
							</div>
							{p.saved > 0 && (
								<div className="chart-tooltip-row">
									<span className="chart-tooltip-label">
										{tr("insights.compounding.cut_since", "Cut since last request")}
									</span>
									<span className="chart-tooltip-value">{formatInteger(p.saved)}</span>
								</div>
							)}
							{p.recovered > 0 && (
								<div className="chart-tooltip-row">
									<span className="chart-tooltip-label">{tr("insights.fetched_back", "Fetched back")}</span>
									<span className="chart-tooltip-value">{formatInteger(p.recovered)}</span>
								</div>
							)}
							{p.compacted && (
								<div className="chart-tooltip-row dim">
									{tr("insights.compounding.compacted", "Compaction before this request")}
								</div>
							)}
						</div>
					);
				}}
			/>
		</div>
	);
}
