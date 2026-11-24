import { formatCompact, formatCost, formatInteger } from "../data/formatters";
import { useTranslation } from "../i18n";
import type { SpotlightCutEconomics, SpotlightDashboardStats, Translation } from "../types";
import { Card } from "../ui";
import { foldTools, formatSignedCost, OTHER_TOOLS, toolIcon, toolsBySaving } from "./meta";

export interface EconomicsProps {
	stats: SpotlightDashboardStats;
	stale: boolean;
}

/**
 * Tint strength of the strongest cell; the rest scale with √|net| so the sign reads first, size second, and one
 * outlier does not wash out every other cell.
 */
const MAX_TINT = 30;
const MIN_TINT = 5;

/** Narrowest tool column before the table scrolls sideways instead of squeezing its cells. */
const TOOL_COLUMN_PX = 120;

function cellTitle(tr: Translation, cell: SpotlightCutEconomics, tool: string): string {
	return [
		tr("insights.economics.tooltip.cuts", "{tool}: {count} cuts", { tool, count: formatInteger(cell.cuts) }),
		tr("insights.economics.tooltip.saved", "Saved {tokens} tokens ({cost})", {
			tokens: formatCompact(cell.savedTokens),
			cost: formatCost(cell.savedUsd),
		}),
		tr("insights.economics.tooltip.recovered", "Fetched back {tokens} tokens ({cost})", {
			tokens: formatCompact(cell.recoveredTokens),
			cost: formatCost(cell.recoveryUsd),
		}),
		tr("insights.economics.tooltip.turns", "{count} extra turns ({cost})", {
			count: formatInteger(cell.extraTurns),
			cost: formatCost(cell.turnUsd),
		}),
		tr("insights.economics.tooltip.net", "Net {net}", { net: formatSignedCost(cell.netUsd) }),
	].join("\n");
}

/** The folded tools' cells summed into an `other` cell. */
function otherCell(cells: readonly SpotlightCutEconomics[]): SpotlightCutEconomics | undefined {
	if (cells.length === 0) return undefined;
	const sum: SpotlightCutEconomics = {
		tool: OTHER_TOOLS,
		cuts: 0,
		savedTokens: 0,
		recoveredTokens: 0,
		extraTurns: 0,
		savedUsd: 0,
		recoveryUsd: 0,
		turnUsd: 0,
		netUsd: 0,
		extraTurnsPer100Cuts: 0,
		netUsdPer100Cuts: 0,
	};
	for (const cell of cells) {
		sum.cuts += cell.cuts;
		sum.savedTokens += cell.savedTokens;
		sum.recoveredTokens += cell.recoveredTokens;
		sum.extraTurns += cell.extraTurns;
		sum.savedUsd += cell.savedUsd;
		sum.recoveryUsd += cell.recoveryUsd;
		sum.turnUsd += cell.turnUsd;
		sum.netUsd += cell.netUsd;
	}
	if (sum.cuts > 0) {
		sum.extraTurnsPer100Cuts = (sum.extraTurns * 100) / sum.cuts;
		sum.netUsdPer100Cuts = (sum.netUsd * 100) / sum.cuts;
	}
	return sum;
}

/**
 * Per tool: what a hundred cuts earn after fetch-backs, extra turns and Spotlight's bill. Tools with cuts, the
 * largest saving first; past the top ones the rest sum into one `other` column.
 */
export function Economics({ stats, stale }: EconomicsProps) {
	const tr = useTranslation();
	const cut = new Set(stats.economics.filter(cell => cell.cuts > 0).map(cell => cell.tool));
	const { listed, rest } = foldTools(toolsBySaving(stats).filter(tool => cut.has(tool)));
	const folded = new Set(rest);
	const cells = new Map(stats.economics.filter(cell => !folded.has(cell.tool)).map(cell => [cell.tool, cell]));
	const other = otherCell(stats.economics.filter(cell => folded.has(cell.tool)));
	if (other) cells.set(OTHER_TOOLS, other);
	const tools = rest.length > 0 ? [...listed, OTHER_TOOLS] : listed;
	let maxAbs = 0;
	for (const cell of cells.values()) if (cell.cuts > 0) maxAbs = Math.max(maxAbs, Math.abs(cell.netUsdPer100Cuts));

	return (
		<Card
			index={3}
			title={tr("insights.economics.title", "What cuts earn, by tool")}
			description={tr(
				"insights.economics.description",
				"Net dollars per 100 cuts after fetch-backs, extra turns and Spotlight's own bill",
			)}
			actions={
				maxAbs > 0 && (
					<span className="spot-econ-scale" aria-hidden="true">
						<span className="num">{formatSignedCost(-maxAbs)}</span>
						<span className="spot-econ-ramp" />
						<span className="num">{formatSignedCost(maxAbs)}</span>
					</span>
				)
			}
			stale={stale}
			footer={tr(
				"insights.economics.footer",
				"Shortened results only; held-out ones save nothing. Every fetch-back counts against the cut here, the share held-out results show comes back anyway included, so this is the cautious view. An extra turn is a request whose every tool call fetched back output these cuts hid. Dollars price saved and fetched-back tokens as carried context, like Compounding.",
			)}
		>
			{tools.length === 0 ? (
				<div className="empty">{tr("insights.no_shortened", "No shortened results in this range.")}</div>
			) : (
				<div className="spot-econ-scroll">
					<table className="spot-econ" style={{ minWidth: `${tools.length * TOOL_COLUMN_PX}px` }}>
						<thead>
							<tr>
								{tools.map(tool => {
									const Icon = toolIcon(tool);
									return (
										<th key={tool} scope="col" title={tool === OTHER_TOOLS ? rest.join(", ") : tool}>
											<span className="row spot-econ-tool">
												<Icon size={13} aria-hidden="true" />
												<span className="spot-econ-tool-name">
													{rest.length > 0 && tool === OTHER_TOOLS
														? tr("insights.other_tools", "other")
														: tool}
												</span>
											</span>
										</th>
									);
								})}
							</tr>
						</thead>
						<tbody>
							<tr>
								{tools.map(tool => {
									const cell = cells.get(tool);
									const label =
										rest.length > 0 && tool === OTHER_TOOLS ? tr("insights.other_tools", "other") : tool;
									if (cell === undefined || cell.cuts === 0) {
										return (
											<td key={tool}>
												<div className="spot-econ-cell" data-empty="true">
													<span className="dim">{tr("insights.economics.no_cuts", "No cuts")}</span>
												</div>
											</td>
										);
									}
									const net = cell.netUsdPer100Cuts;
									const tint =
										maxAbs > 0 ? MIN_TINT + Math.sqrt(Math.abs(net) / maxAbs) * (MAX_TINT - MIN_TINT) : 0;
									const tone = net < 0 ? "bad" : net > 0 ? "ok" : "neutral";
									return (
										<td key={tool}>
											<div
												className="spot-econ-cell"
												data-tone={tone}
												style={{ "--tint": `${tint}%` }}
												title={cellTitle(tr, cell, label)}
											>
												<span className="spot-econ-net num">{formatSignedCost(net)}</span>
												<dl className="spot-econ-facts">
													<div>
														<dt>{tr("insights.cuts_lower", "cuts")}</dt>
														<dd className="num">{formatInteger(cell.cuts)}</dd>
													</div>
													<div>
														<dt>{tr("insights.saved_lower", "saved")}</dt>
														<dd className="num">{formatCompact(cell.savedTokens)}</dd>
													</div>
													<div>
														<dt>{tr("insights.economics.turns_per_100", "extra turns /100")}</dt>
														<dd className="num">{cell.extraTurnsPer100Cuts.toFixed(1)}</dd>
													</div>
												</dl>
											</div>
										</td>
									);
								})}
							</tr>
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}
