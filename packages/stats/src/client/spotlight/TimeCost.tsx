import { Legend } from "../charts";
import { formatElapsed, formatInteger } from "../data/formatters";
import { useTranslation } from "../i18n";
import type { SpotlightDashboardStats } from "../types";
import { Card } from "../ui";
import { formatShare } from "./meta";

/** Share of the experiment's agent time spent on requests that only fetched cut output back, and on shaping. */
export function TimeCost({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const tr = useTranslation();
	const legend = [
		{ key: "fetch", label: tr("insights.time.fetch_turns", "Fetch-back turns"), color: "var(--spot-turns)" },
		{ key: "shape", label: tr("insights.time.shaping", "Shaping"), color: "var(--spot-cost)" },
	];
	const row = stats.timeCost;
	const fetchShare = row.agentMs > 0 ? row.fetchBackMs / row.agentMs : 0;
	const shapeShare = row.agentMs > 0 ? row.shapeMs / row.agentMs : 0;
	// Shares are a few percent: scale the bars to the total (with headroom) so they stay readable.
	const top = fetchShare + shapeShare;
	const scale = top > 0 ? top * 1.15 : 1;
	const fetchWidth = (fetchShare / scale) * 100;
	const shapeWidth = (shapeShare / scale) * 100;

	return (
		<Card
			index={3}
			title={tr("insights.time.title", "Time cost")}
			description={tr(
				"insights.time.description",
				"Share of the experiment sessions' model time spent on requests that only fetched cut output back, plus the time tool calls spent shaping",
			)}
			actions={<Legend items={legend} />}
			stale={stale}
			footer={tr(
				"insights.time.footer",
				"Model time is the summed duration of the experiment sessions' requests. A fetch-back turn is a request whose every tool call fetched back output a cut hid; shaping is the wall time tool calls spent shaping (Spotlight's requests included, held-out results too). Bars run to {share} of model time.",
				{ share: formatShare(scale) },
			)}
		>
			{row.agentMs === 0 ? (
				<div className="empty">{tr("insights.time.empty", "No experiment requests in this range.")}</div>
			) : (
				<ul className="spot-time">
					<li className="spot-time-row">
						<span className="spot-time-label">{tr("insights.share.group.shaped", "Shaped sessions")}</span>
						<span className="spot-time-track" aria-hidden="true">
							<span
								className="spot-time-fill"
								style={{ width: `${fetchWidth}%`, background: "var(--spot-turns)" }}
							/>
							<span
								className="spot-time-fill"
								style={{ width: `${shapeWidth}%`, background: "var(--spot-cost)" }}
							/>
						</span>
						<span className="spot-time-share num">{formatShare(top)}</span>
						<span className="spot-time-detail">
							<span className="num">{formatElapsed(row.fetchBackMs)}</span>
							{tr("insights.time.in", " in")} <span className="num">{formatInteger(row.fetchBackTurns)}</span>{" "}
							{row.fetchBackTurns === 1 ? tr("insights.time.turn", "turn") : tr("insights.time.turns", "turns")}{" "}
							· <span className="num">{formatElapsed(row.shapeMs)}</span>
							{tr("insights.time.shaping_suffix", " shaping")}
							<span className="dim">
								{" "}
								{tr("insights.time.of", "of ")}
								<span className="num">{formatElapsed(row.agentMs)}</span>
							</span>
						</span>
					</li>
				</ul>
			)}
		</Card>
	);
}
