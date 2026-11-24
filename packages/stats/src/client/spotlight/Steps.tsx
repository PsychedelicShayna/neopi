import { Fragment, type ReactNode, useState } from "react";
import { formatCompact, formatInteger } from "../data/formatters";
import { useTranslation } from "../i18n";
import type { SpotlightDashboardStats, SpotlightSizeBin, SpotlightStepCell, SpotlightTool } from "../types";
import { Card } from "../ui";
import { MoreTools } from "./chips";
import { foldTools, formatInterval, formatShare, SIZE_BINS, toolIcon, toolsBySaving } from "./meta";

/** Under this many cuts a cell's share swings on a handful of fetch-backs: it renders dimmed. */
const THIN_CUTS = 10;

/** Tint of a cell kept entirely (or lost entirely, or worse); the rest scale with the distance from half kept. */
const MAX_TINT = 30;
const MIN_TINT = 4;

/** Σ over a step's sizes, for its "all sizes" column. */
interface StepTotal {
	cuts: number;
	savedTokens: number;
	excessTokens: number;
}

interface StepRow {
	steps: string;
	bySize: Map<SpotlightSizeBin, SpotlightStepCell>;
	total: StepTotal;
}

/** Steps of one tool, the biggest saving first and `other` last. */
function stepRows(cells: readonly SpotlightStepCell[], tool: SpotlightTool): StepRow[] {
	const rows = new Map<string, StepRow>();
	for (const cell of cells) {
		if (cell.tool !== tool) continue;
		let row = rows.get(cell.steps);
		if (row === undefined) {
			row = { steps: cell.steps, bySize: new Map(), total: { cuts: 0, savedTokens: 0, excessTokens: 0 } };
			rows.set(cell.steps, row);
		}
		row.bySize.set(cell.size, cell);
		row.total.cuts += cell.cuts;
		row.total.savedTokens += cell.savedTokens;
		row.total.excessTokens += cell.excessTokens;
	}
	return [...rows.values()].sort(
		(a, b) => Number(a.steps === "other") - Number(b.steps === "other") || b.total.savedTokens - a.total.savedTokens,
	);
}

/** Green above half the saving kept, red below; strength grows toward all or nothing. */
function KeptCell({
	kept,
	cuts,
	title,
	children,
}: {
	kept: number | null;
	cuts: number;
	title: string;
	children: ReactNode;
}) {
	const tr = useTranslation();
	if (kept === null) {
		return (
			<div className="spot-econ-cell" data-empty="true" title={title}>
				<span className="dim">{tr("insights.steps.no_saving", "No saving")}</span>
			</div>
		);
	}
	// keptShare goes negative when the excess fetch-back outweighs the saving: as red as a total loss.
	const tint = MIN_TINT + Math.min(1, Math.abs(kept - 0.5) * 2) * (MAX_TINT - MIN_TINT);
	return (
		<div
			className="spot-econ-cell"
			data-tone={kept >= 0.5 ? "ok" : "bad"}
			data-thin={cuts < THIN_CUTS}
			style={{ "--tint": `${tint}%` }}
			title={title}
		>
			<span className="spot-econ-net num">
				{formatShare(kept)}
				<span className="spot-steps-unit">{tr("insights.steps.kept_suffix", " kept")}</span>
			</span>
			<dl className="spot-econ-facts">{children}</dl>
		</div>
	);
}

/** Tool × shaping steps × cut size: how much of each kind of cut's saving stays saved after fetch-backs. */
export function Steps({ stats, stale }: { stats: SpotlightDashboardStats; stale: boolean }) {
	const tr = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const all = toolsBySaving(stats).flatMap(tool => {
		const rows = stepRows(stats.steps, tool);
		return rows.length === 0 ? [] : [{ tool, rows }];
	});
	const { listed, rest } = foldTools(all);
	const tools = expanded ? all : listed;

	return (
		<Card
			index={5}
			title={tr("insights.steps.title", "Which cuts pay")}
			description={tr(
				"insights.steps.description",
				"Share of each kind of cut's saving that stays saved after fetch-backs beyond the holdout baseline, by size",
			)}
			actions={
				<span className="spot-econ-scale" aria-hidden="true">
					<span className="num">0%</span>
					<span className="spot-econ-ramp" />
					<span className="num">{tr("insights.steps.full_kept", "100% kept")}</span>
				</span>
			}
			stale={stale}
			footer={tr(
				"insights.steps.footer",
				'Scored and score-free cuts. Kept = (saved − fetch-back beyond the tool\'s holdout baseline) ÷ saved; fetched back is the share of cuts the agent came back for within 12 calls. Sizes are the tokens a cut saved against plain; step combinations under 10 cuts fold into "other". Cells under {thin} cuts are dimmed.',
				{ thin: THIN_CUTS },
			)}
		>
			{tools.length === 0 ? (
				<div className="empty">{tr("insights.no_shortened", "No shortened results in this range.")}</div>
			) : (
				<>
					<div className="spot-steps-scroll">
						<table className="spot-econ spot-steps">
							<thead>
								<tr>
									<th scope="col">{tr("insights.steps.steps", "Steps")}</th>
									{SIZE_BINS.map(size => (
										<th key={size} scope="col" className="num">
											{size} <span className="dim">{tr("insights.saved_lower", "saved")}</span>
										</th>
									))}
									<th scope="col">{tr("insights.steps.all_sizes", "All sizes")}</th>
								</tr>
							</thead>
							<tbody>
								{tools.map(({ tool, rows }) => {
									const Icon = toolIcon(tool);
									return (
										<Fragment key={tool}>
											<tr className="spot-steps-tool">
												<th scope="rowgroup" colSpan={SIZE_BINS.length + 2}>
													<span className="row spot-econ-tool">
														<Icon size={13} aria-hidden="true" />
														{tool}
													</span>
												</th>
											</tr>
											{rows.map(row => {
												const { total } = row;
												const totalKept =
													total.savedTokens > 0
														? (total.savedTokens - total.excessTokens) / total.savedTokens
														: null;
												return (
													<tr key={row.steps}>
														<th scope="row" className="spot-steps-name" title={row.steps}>
															{row.steps}
														</th>
														{SIZE_BINS.map(size => {
															const cell = row.bySize.get(size);
															if (cell === undefined || cell.cuts === 0) {
																return (
																	<td key={size}>
																		<div className="spot-econ-cell" data-empty="true">
																			<span className="dim">–</span>
																		</div>
																	</td>
																);
															}
															const interval = formatInterval(cell.fetchBackRate, formatShare);
															return (
																<td key={size}>
																	<KeptCell
																		kept={cell.keptShare}
																		cuts={cell.cuts}
																		title={[
																			tr(
																				"insights.steps.size_tip",
																				"{tool} · {steps} · {size} saved: {cuts} cuts",
																				{
																					tool,
																					steps: row.steps,
																					size,
																					cuts: formatInteger(cell.cuts),
																				},
																			),
																			tr(
																				"insights.steps.saved_tip",
																				"Saved {saved}, fetched back {recovered}, {excess} beyond the baseline",
																				{
																					saved: formatCompact(cell.savedTokens),
																					recovered: formatCompact(cell.recoveredTokens),
																					excess: formatCompact(cell.excessTokens),
																				},
																			),
																			tr(
																				"insights.steps.fetch_tip",
																				"Fetched back after {share} of cuts{interval}",
																				{
																					share: formatShare(cell.fetchBackRate.value),
																					interval: interval === "" ? "" : ` (${interval})`,
																				},
																			),
																		].join("\n")}
																	>
																		<div>
																			<dt>{tr("insights.cuts_lower", "cuts")}</dt>
																			<dd className="num">{formatInteger(cell.cuts)}</dd>
																		</div>
																		<div>
																			<dt>{tr("insights.fetched_back_lower", "fetched back")}</dt>
																			<dd className="num">
																				{formatShare(cell.fetchBackRate.value)}
																			</dd>
																		</div>
																	</KeptCell>
																</td>
															);
														})}
														<td>
															<KeptCell
																kept={totalKept}
																cuts={total.cuts}
																title={tr(
																	"insights.steps.total_tip",
																	"{tool} · {steps}: {cuts} cuts saved {saved}, {excess} fetched back beyond the baseline",
																	{
																		tool,
																		steps: row.steps,
																		cuts: formatInteger(total.cuts),
																		saved: formatCompact(total.savedTokens),
																		excess: formatCompact(total.excessTokens),
																	},
																)}
															>
																<div>
																	<dt>{tr("insights.cuts_lower", "cuts")}</dt>
																	<dd className="num">{formatInteger(total.cuts)}</dd>
																</div>
																<div>
																	<dt>{tr("insights.saved_lower", "saved")}</dt>
																	<dd className="num">{formatCompact(total.savedTokens)}</dd>
																</div>
															</KeptCell>
														</td>
													</tr>
												);
											})}
										</Fragment>
									);
								})}
							</tbody>
						</table>
					</div>
					{rest.length > 0 && (
						<MoreTools
							hidden={rest.map(item => item.tool)}
							expanded={expanded}
							onToggle={() => setExpanded(value => !value)}
						/>
					)}
				</>
			)}
		</Card>
	);
}
