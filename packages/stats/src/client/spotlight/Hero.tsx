import { TriangleAlert } from "lucide-react";
import { formatCompact, formatInteger } from "../data/formatters";
import { useTranslation } from "../i18n";
import type { SpotlightDashboardStats } from "../types";
import { Stat } from "../ui";
import { foldTools, formatInterval, formatShare, formatSignedCompact, formatSignedCost, OTHER_TOOLS } from "./meta";

export interface SpotlightHeroProps {
	stats: SpotlightDashboardStats;
	/** Prose window ("the last 7 days"). */
	windowLabel: string;
	stale: boolean;
}

/**
 * Headline: the holdout-adjusted net (tokens and $, with intervals) against what `plain` would have shown, the old
 * full-output figure struck through as the baseline note, then gross, the excess fetch-back and the sample.
 */
export function SpotlightHero({ stats, windowLabel, stale }: SpotlightHeroProps) {
	const tr = useTranslation();
	const { gross, clawback, adjusted } = stats;
	const net = adjusted.netTokens;
	const netUsd = adjusted.netUsd;
	const tokenInterval = formatInterval(net, formatSignedCompact);
	const usdInterval = formatInterval(netUsd, formatSignedCost);
	// A tool's baseline only matters when it has cuts to adjust; `adjusted.byTool` runs the largest saving first.
	const thin = adjusted.byTool.filter(row => row.cuts > 0 && row.holdouts < adjusted.minHoldouts).map(row => row.tool);
	// Prose list: `read`, `read and bash`, `read, bash and eval`, `read, bash, … and 4 more tools`.
	const thinFold = foldTools(thin);
	const thinNames =
		thinFold.rest.length > 0
			? [...thinFold.listed, tr("insights.more_tools", "{count} more tools", { count: thinFold.rest.length })]
			: thin;
	const thinProse =
		thinNames.length < 2
			? (thinNames[0] ?? "")
			: tr("insights.hero.list", "{preceding} and {last}", {
					preceding: thinNames.slice(0, -1).join(", "),
					last: thinNames.at(-1) ?? "",
				});
	const heldFold = foldTools(adjusted.byTool);
	const heldRows = heldFold.listed.map(row => ({
		tool: row.tool,
		holdouts: row.holdouts,
		thin: thin.includes(row.tool),
	}));
	if (heldFold.rest.length > 0) {
		heldRows.push({
			tool: OTHER_TOOLS,
			holdouts: heldFold.rest.reduce((sum, row) => sum + row.holdouts, 0),
			thin: heldFold.rest.some(row => thin.includes(row.tool)),
		});
	}
	const overstated = gross.fullSavedTokens > 0 ? 1 - gross.savedTokens / gross.fullSavedTokens : null;

	return (
		<section
			className="card rise spot-hero"
			data-stale={stale}
			aria-label={tr("insights.hero.aria", "Spotlight savings summary")}
		>
			<div className="spot-hero-main">
				<div className="spot-hero-headline">
					<div className="spot-eyebrow">
						{tr("insights.hero.net_label", "Net saved in {window}, after fetch-backs a cut caused", {
							window: windowLabel,
						})}
					</div>
					<div className="spot-hero-figures">
						<span
							className="spot-hero-value gradient-text"
							title={
								net.value === null
									? undefined
									: tr("insights.tokens_count", "{count} tokens", { count: formatInteger(net.value) })
							}
						>
							{net.value === null ? "–" : formatSignedCompact(net.value)}
						</span>
						<span className="spot-hero-unit">tokens</span>
						{netUsd.value !== null && (
							<span
								className="spot-hero-usd"
								data-negative={netUsd.value < 0}
								title={tr(
									"insights.hero.net_usd_tip",
									"Avoided context priced at each later request's cache rates, minus the fetch-backs beyond the holdout baseline (priced the same way) and Spotlight's own bill",
								)}
							>
								{formatSignedCost(netUsd.value)}
							</span>
						)}
					</div>
					{(tokenInterval !== "" || usdInterval !== "") && (
						<div className="spot-hero-interval">
							{tr("insights.hero.interval", "90% interval")}{" "}
							<span className="num">{[tokenInterval, usdInterval].filter(Boolean).join(" · ")}</span>
						</div>
					)}
				</div>
				<div className="spot-hero-aside">
					<p className="spot-hero-note">
						{tr("insights.hero.plain_lead", "Counted against what pi would have shown unshaped (")}
						<code>plain</code>
						{tr(
							"insights.hero.plain_end",
							") for the same call (its inline cap and read page), with fetch-backs that held-out results show happen anyway added back.",
						)}{" "}
						{gross.fullSavedTokens > gross.savedTokens && (
							<>
								{tr(
									"insights.hero.full_lead",
									"Against the full output the shaping read, the cuts would claim",
								)}{" "}
								<s className="spot-struck num">{formatCompact(gross.fullSavedTokens)}</s>
								{tr("insights.hero.full_end", ", overstating the gross by {share}.", {
									share: formatShare(overstated),
								})}{" "}
							</>
						)}
						{gross.widerThanPlain > 0 &&
							(gross.widerThanPlain === 1
								? tr(
										"insights.hero.wider_one",
										"{count} result was wider than plain would have shown: cuts shown that way count as losses, results pi capped at plain's text save nothing. ",
										{ count: formatInteger(gross.widerThanPlain) },
									)
								: tr(
										"insights.hero.wider_many",
										"{count} results were wider than plain would have shown: cuts shown that way count as losses, results pi capped at plain's text save nothing. ",
										{ count: formatInteger(gross.widerThanPlain) },
									))}
						{gross.estimatedPlain > 0 &&
							(gross.estimatedPlain === 1
								? tr(
										"insights.hero.estimated_one",
										"{count} older result estimates plain from the inline cap.",
										{ count: formatInteger(gross.estimatedPlain) },
									)
								: tr(
										"insights.hero.estimated_many",
										"{count} older results estimate plain from the inline cap.",
										{ count: formatInteger(gross.estimatedPlain) },
									))}
					</p>
					{thin.length > 0 && (
						<p className="spot-hero-warn" role="note">
							<TriangleAlert size={14} aria-hidden="true" />
							<span>
								{thin.length === 1
									? tr(
											"insights.hero.thin_one",
											"{tools} has fewer than {count} held-out results: its part of the net rests on a thin baseline.",
											{ tools: thinProse, count: formatInteger(adjusted.minHoldouts) },
										)
									: tr(
											"insights.hero.thin_many",
											"{tools} have fewer than {count} held-out results: their part of the net rests on a thin baseline.",
											{ tools: thinProse, count: formatInteger(adjusted.minHoldouts) },
										)}
							</span>
						</p>
					)}
				</div>
			</div>

			<div className="spot-hero-stats">
				<Stat
					size="sm"
					label={tr("insights.gross_vs_plain", "Gross vs plain")}
					title={tr(
						"insights.gross_vs_plain_tip",
						"Σ (plain − shortened) tokens over shortened results; a cut that showed more than plain counts negative",
					)}
					value={formatSignedCompact(gross.savedTokens)}
					hint={tr("insights.hero.gross_hint", "{share} of tool output · {cut} of {total} results shortened", {
						share: formatShare(gross.ofToolOutput),
						cut: formatInteger(gross.shaped),
						total: formatInteger(gross.results),
					})}
				/>
				<Stat
					size="sm"
					label={tr("insights.hero.fetched", "Fetched back beyond baseline")}
					title={tr(
						"insights.hero.fetched_tip",
						"Fetch-back tokens beyond what held-out results (shown whole) fetch anyway, per tool (reads split by whether the agent was likely to edit them); 90% interval below",
					)}
					value={adjusted.excessTokens.value === null ? "–" : formatSignedCompact(-adjusted.excessTokens.value)}
					hint={
						<>
							{tr("insights.hero.fetched_hint", "of {count} fetched back", {
								count: formatCompact(clawback.tokens),
							})}
							{adjusted.excessTokens.lo !== null && adjusted.excessTokens.hi !== null && (
								<>
									{" "}
									<span className="dim">
										·{" "}
										<span className="spot-nowrap">
											90% {formatInterval(adjusted.excessTokens, formatCompact)}
										</span>
									</span>
								</>
							)}
						</>
					}
				/>
				<Stat
					size="sm"
					label={tr("insights.group.holdout.label", "Held out")}
					title={tr(
						"insights.hero.holdout_tip",
						"Would-be cuts shown whole at random: the baseline per tool (under {count} is thin)",
						{ count: adjusted.minHoldouts },
					)}
					value={formatInteger(stats.holdouts)}
					hint={
						<span className="spot-hero-tools">
							{heldRows.map(row => (
								<span
									key={row.tool}
									data-thin={row.thin}
									title={
										row.tool === OTHER_TOOLS
											? heldFold.rest.map(rest => `${rest.tool} ${formatInteger(rest.holdouts)}`).join(", ")
											: row.thin
												? tr("insights.hero.thin_tip", "{tool}: under {count} held out", {
														tool: row.tool,
														count: adjusted.minHoldouts,
													})
												: undefined
									}
								>
									{heldFold.rest.length > 0 && row === heldRows.at(-1)
										? tr("insights.other_tools", "other")
										: row.tool}{" "}
									<span className="num">{formatInteger(row.holdouts)}</span>
									{row.thin && (
										<TriangleAlert size={11} aria-label={tr("insights.hero.thin_aria", "thin baseline")} />
									)}
								</span>
							))}
						</span>
					}
				/>
				<Stat
					size="sm"
					label={tr("insights.hero.score_free", "Score-free cuts")}
					title={tr(
						"insights.hero.score_free_tip",
						"Cuts a random coin made without Spotlight (the no-score fallback rules): what Spotlight's scores add is the difference",
					)}
					value={formatInteger(stats.scoreFree)}
					hint={tr("insights.hero.score_free_hint", "cut without Spotlight, for comparison")}
				/>
				<Stat
					size="sm"
					label={tr("insights.hero.sessions", "Sessions")}
					value={formatInteger(stats.sessions)}
					hint={tr("insights.hero.sessions_hint", "experiment sessions, all shaped")}
				/>
			</div>
		</section>
	);
}
