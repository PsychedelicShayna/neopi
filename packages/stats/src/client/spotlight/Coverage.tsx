import { BarList, Legend, ShareBar } from "../charts";
import { formatCompact, formatInteger } from "../data/formatters";
import { useTranslation } from "../i18n";
import type { SpotlightDashboardStats } from "../types";
import { Badge, Card } from "../ui";
import { foldTools, formatShare } from "./meta";

const SHAPED_COLOR = "var(--spot-applied)";
const UNSHAPED_COLOR = "var(--spot-unshaped)";

/** Which tools' output the models of experiment sessions saw, shaped and not: where shaping could reach next. */
export function Coverage({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const tr = useTranslation();
	const rows = [...stats.coverage].sort((a, b) => b.tokens - a.tokens);
	const { listed, rest } = foldTools(rows);
	let shaped = 0;
	let unshaped = 0;
	for (const row of rows) {
		if (row.shaped) shaped += row.share;
		else unshaped += row.share;
	}
	const items = listed.map(row => ({
		key: row.tool,
		label: (
			<>
				<span className="spot-coverage-tool">{row.tool}</span>
				{row.shaped && <Badge>{tr("insights.coverage.shaped_badge", "shaped")}</Badge>}
				<span className="dim num">
					{tr("insights.calls_count", "{count} calls", { count: formatInteger(row.calls) })}
				</span>
			</>
		),
		value: row.share,
		display: `${formatShare(row.share)} · ${formatCompact(row.tokens)}`,
		color: row.shaped ? SHAPED_COLOR : UNSHAPED_COLOR,
	}));
	if (rest.length > 0) {
		let share = 0;
		let tokens = 0;
		let calls = 0;
		for (const row of rest) {
			share += row.share;
			tokens += row.tokens;
			calls += row.calls;
		}
		items.push({
			key: "\u0000rest",
			label: (
				<>
					<span className="spot-coverage-tool">
						{rest.length === 1
							? tr("insights.more_tool", "{count} more tool", { count: formatInteger(rest.length) })
							: tr("insights.more_tools", "{count} more tools", { count: formatInteger(rest.length) })}
					</span>
					<span className="dim num">
						{tr("insights.calls_count", "{count} calls", { count: formatInteger(calls) })}
					</span>
				</>
			),
			value: share,
			display: `${formatShare(share)} · ${formatCompact(tokens)}`,
			color: rest.some(row => row.shaped) ? SHAPED_COLOR : UNSHAPED_COLOR,
		});
	}

	return (
		<Card
			index={5}
			title={tr("insights.coverage.title", "Not shaped yet")}
			description={tr(
				"insights.coverage.description",
				"Share of the tool output experiment sessions' models saw, by tool: the unshaped ones are where shaping could reach next",
			)}
			actions={
				<Legend
					items={[
						{ key: "shaped", label: tr("insights.coverage.shaped", "Shaped"), color: SHAPED_COLOR },
						{ key: "unshaped", label: tr("insights.coverage.unshaped", "Not shaped"), color: UNSHAPED_COLOR },
					]}
				/>
			}
			stale={stale}
			footer={tr(
				"insights.coverage.footer",
				"Tokens are tool-result chars ÷ 4 over the experiment's sessions in the range; a tool counts as shaped when the experiment evaluated any of its results in the range.",
			)}
		>
			{rows.length === 0 ? (
				<div className="empty">{tr("insights.coverage.empty", "No tool output in this range.")}</div>
			) : (
				<div className="spot-coverage">
					<div className="spot-coverage-summary">
						<div className="spot-coverage-headline">
							<span className="num">{formatShare(unshaped)}</span>{" "}
							{tr(
								"insights.coverage.headline",
								"of tool output comes from tools the experiment did not shape in this range",
							)}
						</div>
						<ShareBar
							height={8}
							segments={[
								{
									key: "shaped",
									label: tr("insights.coverage.shaped", "Shaped"),
									value: shaped,
									color: SHAPED_COLOR,
								},
								{
									key: "unshaped",
									label: tr("insights.coverage.unshaped", "Not shaped"),
									value: unshaped,
									color: UNSHAPED_COLOR,
								},
							]}
						/>
					</div>
					<BarList items={items} />
				</div>
			)}
		</Card>
	);
}
