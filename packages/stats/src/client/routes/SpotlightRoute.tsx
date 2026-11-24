import { LocalizedText, useTranslation } from "../i18n";
import { ScanSearch } from "lucide-react";
import { useState } from "react";
import { getSpotlightDashboardStats } from "../api";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import { Compounding } from "../spotlight/Compounding";
import { Coverage } from "../spotlight/Coverage";
import { Economics } from "../spotlight/Economics";
import { FetchBack, FetchBackGaps } from "../spotlight/FetchBack";
import { SpotlightHero } from "../spotlight/Hero";
import { Overhead } from "../spotlight/Overhead";
import { Ranking } from "../spotlight/Ranking";
import { ResultsFeed } from "../spotlight/ResultsFeed";
import { SavingsOverTime, WhereSavingsWent } from "../spotlight/Savings";
import { ShareTrend } from "../spotlight/ShareTrend";
import { Steps } from "../spotlight/Steps";
import { TimeCost } from "../spotlight/TimeCost";
import type { SpotlightAgentScope, TimeRange } from "../types";
import { Card, ChartSkeleton, PageHeader, QueryView, Segmented } from "../ui";
import "../spotlight/spotlight.css";

export interface SpotlightRouteProps {
	active: boolean;
	range: TimeRange;
}

const AGENT_OPTIONS = [
	{
		value: "all",
		label: <LocalizedText messageKey="pages.spotlight.all" english={"All"} />,
		title: "Every experiment session, subagents and advisors included",
		titleKey: "pages.spotlight.every_experiment_session_subagents_and_advisors_included",
	},
	{
		value: "main",
		label: <LocalizedText messageKey="pages.spotlight.main" english={"Main"} />,
		title: "Sessions you drove: the main agent only",
		titleKey: "pages.spotlight.sessions_you_drove_the_main_agent_only",
	},
	{
		value: "subagent",
		label: <LocalizedText messageKey="pages.spotlight.subagents" english={"Subagents"} />,
		title: "Sessions the task tool spawned",
		titleKey: "pages.spotlight.sessions_the_task_tool_spawned",
	},
] as const;

/** Prose for the scope in empty states ("main-agent "). */
const AGENT_SCOPE_PROSE: Record<SpotlightAgentScope, string> = { all: "", main: "main-agent ", subagent: "subagent " };

/** The page reads as four questions, in order; each heading opens the cards that answer one. */
function SectionHeading({ id, title, children }: { id: string; title: string; children: string }) {
	return (
		<header className="spot-section rise" id={id}>
			<h2 className="spot-section-title">{title}</h2>
			<p className="spot-section-copy">{children}</p>
		</header>
	);
}

export function SpotlightRoute({ active, range }: SpotlightRouteProps) {
	const tr = useTranslation();
	// Every experiment session shapes, subagents included; scoping keeps their very different workloads apart.
	const [agent, setAgent] = useState<SpotlightAgentScope>("all");
	const stats = useQuery(
		["spotlight", range, agent],
		({ signal }) => getSpotlightDashboardStats(range, agent, signal),
		{ enabled: active },
	);
	const meta = rangeMeta(range);
	const experimentStart = stats.data?.experimentStart ?? null;

	return (
		<div className="page spot-page">
			<PageHeader
				title="Spotlight"
				description={tr(
					"pages.spotlight.what_shaping_tool_output_saved_in_window",
					"What shaping tool output saved in {window} against what pi would have shown unshaped, after taking back what the agent fetched again because of a cut.",
					{ window: tr(`costs.window.${range}`, meta.windowLabel) },
				)}
				actions={
					<Segmented
						aria-label={tr("pages.spotlight.sessions", "Sessions")}
						options={AGENT_OPTIONS}
						value={agent}
						onChange={setAgent}
					/>
				}
			/>

			<QueryView
				query={stats}
				skeleton={<ChartSkeleton height={220} />}
				isEmpty={data => data.sessions === 0 && data.recent.length === 0}
				empty={
					<Card>
						<div className="spot-empty">
							<span className="spot-empty-icon" aria-hidden="true">
								<ScanSearch size={20} />
							</span>
							<h2 className="spot-empty-title">
								{experimentStart === null
									? tr(
											"pages.spotlight.the_spotlight_experiment_hasnt_run_yet",
											"The Spotlight experiment hasn't run yet",
										)
									: tr(
											`pages.spotlight.no_sessions.${agent}`,
											`No ${AGENT_SCOPE_PROSE[agent]}experiment sessions in {window}`,
											{ window: tr(`costs.window.${range}`, meta.windowLabel) },
										)}
							</h2>
							<p className="spot-empty-hint">
								{experimentStart === null ? (
									<>
										{tr("pages.spotlight.turn_it_on_with", "Turn it on with ")}
										<code>spotlight.experiment.enabled</code>
										{tr("pages.spotlight.in_your_settings_or", " in your settings or")}{" "}
										<code>PI_SPOTLIGHT_EXPERIMENT=1</code>. Every session then shapes tool output, a random
										share of results is held out unshaped as the counterfactual, and this page tracks what the
										cuts save as you work.
									</>
								) : agent === "all" ? (
									tr(
										"pages.spotlight.try_a_longer_range_or_start_a",
										"Try a longer range, or start a session with the experiment enabled.",
									)
								) : (
									tr(
										"pages.spotlight.try_a_longer_range_or_switch_to",
										"Try a longer range, or switch to All sessions.",
									)
								)}
							</p>
						</div>
					</Card>
				}
			>
				{data => (
					<>
						<SpotlightHero stats={data} windowLabel={meta.windowLabel} stale={stats.stale} />

						<SectionHeading id="spot-saved" title={tr("pages.spotlight.what_it_saved", "What it saved")}>
							{tr(
								"pages.spotlight.where_the_saving_came_from_what_fetch",
								"Where the saving came from, what fetch-backs took back, and what later requests no longer carry.",
							)}
						</SectionHeading>
						<div className="grid grid-main-side">
							<SavingsOverTime stats={data} range={range} stale={stats.stale} />
							<WhereSavingsWent stats={data} stale={stats.stale} />
						</div>
						<Compounding stats={data} active={active} stale={stats.stale} />
						<ShareTrend stats={data} range={range} stale={stats.stale} />

						<SectionHeading id="spot-cost" title={tr("pages.spotlight.what_it_cost", "What it cost")}>
							{tr(
								"pages.spotlight.agent_time_spotlights_latency_and_failures_and",
								"Agent time, Spotlight's latency and failures, and whether shaped sessions got worse.",
							)}
						</SectionHeading>
						<TimeCost stats={data} stale={stats.stale} />
						<Overhead stats={data} stale={stats.stale} />

						<SectionHeading
							id="spot-work"
							title={tr("pages.spotlight.is_spotlight_doing_the_work", "Is Spotlight doing the work?")}
						>
							{tr(
								"pages.spotlight.whether_its_heat_finds_the_lines_the",
								"Whether its heat finds the lines the agent needs, and whether its cuts come back less than cuts made without it.",
							)}
						</SectionHeading>
						<Ranking stats={data} stale={stats.stale} />
						<FetchBack stats={data} stale={stats.stale} />
						<FetchBackGaps stats={data} stale={stats.stale} />

						<SectionHeading id="spot-tune" title={tr("pages.spotlight.where_to_tune", "Where to tune")}>
							{tr(
								"pages.spotlight.which_steps_sizes_and_tools_pay_and",
								"Which steps, sizes and tools pay, and which tools Spotlight doesn't shape yet.",
							)}
						</SectionHeading>
						<Steps stats={data} stale={stats.stale} />
						<Economics stats={data} stale={stats.stale} />
						<Coverage stats={data} stale={stats.stale} />
						<ResultsFeed rows={data.recent} stale={stats.stale} />
					</>
				)}
			</QueryView>
		</div>
	);
}
