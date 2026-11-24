import { CornerDownRight, Scissors } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
	formatCompact,
	formatCost,
	formatDurationMs,
	formatElapsed,
	formatInteger,
	formatRelativeTime,
	formatTimestamp,
} from "../data/formatters";
import { useLocale, useTranslation } from "../i18n";
import type { Locale, SpotlightRecoveryKind, SpotlightResultRow, Translation } from "../types";
import { Badge, Card, type Column, Drawer, KeyValues, Table } from "../ui";
import { KindBadge } from "./chips";
import { formatSignedCompact, RECOVERY_KIND, RECOVERY_KINDS, toolIcon } from "./meta";

function rowKey(row: SpotlightResultRow): string {
	return `${row.sessionFile}\u0000${row.toolCallId}`;
}

function NetCell({ value }: { value: number }) {
	return (
		<span className={value < 0 ? "num tone-bad" : value > 0 ? "num tone-ok" : "num"}>
			{formatSignedCompact(value)}
		</span>
	);
}

/** Plain → out with a bar of what survived the cut (would have, when held out). */
function ShrinkCell({ row }: { row: SpotlightResultRow }) {
	const tr = useTranslation();
	const { plainTokens, outTokens } = row;
	const kept = plainTokens > 0 ? Math.min(1, outTokens / plainTokens) : 1;
	return (
		<div
			className="spot-shrink"
			data-holdout={row.holdout}
			title={
				row.holdout
					? tr(
							"insights.results.shrink_holdout",
							"plain would show {plain} tokens, the cut would show {out} (shaping read {full})",
							{
								plain: formatInteger(plainTokens),
								out: formatInteger(outTokens),
								full: formatInteger(row.inTokens),
							},
						)
					: tr(
							"insights.results.shrink_cut",
							"plain would show {plain} tokens, the cut showed {out} (shaping read {full})",
							{
								plain: formatInteger(plainTokens),
								out: formatInteger(outTokens),
								full: formatInteger(row.inTokens),
							},
						)
			}
		>
			<span className="num">
				{formatCompact(plainTokens)}
				<span className="dim"> → </span>
				{formatCompact(outTokens)}
			</span>
			<span className="spot-shrink-bar" aria-hidden="true">
				<span className="spot-shrink-kept" style={{ width: `${kept * 100}%` }} />
			</span>
		</div>
	);
}

function kindCounts(row: SpotlightResultRow): [SpotlightRecoveryKind, number][] {
	const counts = new Map<SpotlightRecoveryKind, number>();
	for (const r of row.recoveries) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
	return RECOVERY_KINDS.flatMap(kind => {
		const count = counts.get(kind);
		return count ? [[kind, count]] : [];
	});
}

const resultColumns = (tr: Translation, locale: Locale): Column<SpotlightResultRow>[] => [
	{
		key: "target",
		header: tr("insights.results.result", "Result"),
		width: "40%",
		sort: row => row.timestamp,
		render: row => {
			const Icon = toolIcon(row.tool);
			return (
				<div className="spot-result">
					<span className="spot-tool" title={row.tool}>
						<Icon size={14} aria-hidden="true" />
						<span className="sr-only">{row.tool}</span>
					</span>
					<div className="stack spot-result-text">
						<span className="spot-target truncate" title={row.target}>
							{row.target}
						</span>
						<span className="row spot-result-meta">
							{row.holdout && <HoldoutBadge />}
							{row.scoreFree && <ScoreFreeBadge />}
							<span className="dim" title={formatTimestamp(row.timestamp, locale)}>
								{formatRelativeTime(row.timestamp, locale)}
							</span>
						</span>
					</div>
				</div>
			);
		},
	},
	{
		key: "shrink",
		header: tr("insights.results.plain_out", "Plain → out"),
		align: "right",
		sort: row => (row.plainTokens > 0 ? row.outTokens / row.plainTokens : 1),
		title: tr(
			"insights.results.plain_out_tip",
			"What pi would have shown unshaped (plain) for the call, and what the cut showed; the bar is the share that survived",
		),
		render: row => <ShrinkCell row={row} />,
	},
	{
		key: "saved",
		header: tr("insights.saved", "Saved"),
		align: "right",
		sort: row => row.savedTokens,
		render: row =>
			row.holdout ? (
				<span
					className="spot-would-save"
					title={tr("insights.results.would_save_tip", "Held out: what the cut would have saved")}
				>
					<span className="dim">{tr("insights.results.would_save_prefix", "would save ")}</span>
					<span className="num">{formatSignedCompact(row.savedTokens)}</span>
				</span>
			) : (
				<span className="num">{formatSignedCompact(row.savedTokens)}</span>
			),
	},
	{
		key: "hidden",
		header: tr("insights.results.hidden", "Hidden lines"),
		align: "right",
		sort: row => row.hiddenLines,
		render: row =>
			row.hiddenLines > 0 ? (
				<span className="num">{formatInteger(row.hiddenLines)}</span>
			) : (
				<span className="dim">–</span>
			),
	},
	{
		key: "recoveries",
		header: tr("insights.fetched_back", "Fetched back"),
		sort: row => row.recoveries.length,
		render: row => {
			const counts = kindCounts(row);
			return counts.length === 0 ? (
				<span className="dim" title={tr("insights.results.nothing_fetched", "Nothing fetched back")}>
					–
				</span>
			) : (
				<span className="row spot-kinds">
					{counts.map(([kind, count]) => (
						<KindBadge key={kind} kind={kind} count={count} />
					))}
				</span>
			);
		},
	},
	{
		key: "net",
		header: tr("insights.net", "Net"),
		align: "right",
		sort: row => row.netTokens,
		title: tr(
			"insights.results.net_tip",
			"Saved tokens minus the tokens of the calls that fetched hidden output back",
		),
		render: row =>
			row.holdout ? (
				<span
					className="dim"
					title={tr(
						"insights.results.net_holdout",
						"Held out: the model saw the whole result, so nothing was saved",
					)}
				>
					–
				</span>
			) : (
				<NetCell value={row.netTokens} />
			),
	},
];

function HoldoutBadge() {
	const tr = useTranslation();
	return (
		<span
			title={tr(
				"insights.results.holdout_tip",
				"Held out at random: the model saw the original, unshortened result",
			)}
		>
			<Badge>{tr("insights.results.holdout_badge", "held out")}</Badge>
		</span>
	);
}

function ScoreFreeBadge() {
	const tr = useTranslation();
	return (
		<span
			title={tr(
				"insights.results.score_free_tip",
				"A random coin skipped Spotlight: the no-score fallback rules made this cut",
			)}
		>
			<Badge>{tr("insights.results.score_free_badge", "score-free")}</Badge>
		</span>
	);
}

/** The 60 newest shortened results; a row opens its recovery timeline. */
export function ResultsFeed({ rows, stale }: { rows: readonly SpotlightResultRow[]; stale: boolean }) {
	const tr = useTranslation();
	const locale = useLocale();
	const columns = useMemo(() => resultColumns(tr, locale), [tr, locale]);
	const [selected, setSelected] = useState<string | null>(null);
	const close = useCallback(() => setSelected(null), []);
	const current = useMemo(() => rows.find(row => rowKey(row) === selected) ?? null, [rows, selected]);

	return (
		<>
			<Card
				index={6}
				title={tr("insights.results.title", "Recent results")}
				description={tr(
					"insights.results.description",
					"The newest shortened and held-out tool results and what the agent fetched back",
				)}
				flush
				stale={stale}
				footer={tr(
					"insights.results.footer",
					"Saved is what plain would have shown minus what the cut showed (the would-be cut for held-out ones, which save nothing); recovery tokens are the recovery calls' results (chars ÷ 4 when no exact count exists).",
				)}
			>
				<Table
					rows={rows}
					rowKey={rowKey}
					columns={columns}
					onRowClick={row => setSelected(rowKey(row))}
					selectedKey={selected}
					limit={15}
					empty={
						<div className="empty">
							{tr("insights.results.empty", "No shortened or held-out results in this range.")}
						</div>
					}
				/>
			</Card>
			<RecoveryDrawer row={current} onClose={close} />
		</>
	);
}

function RecoveryDrawer({ row, onClose }: { row: SpotlightResultRow | null; onClose: () => void }) {
	const tr = useTranslation();
	const locale = useLocale();
	if (row === null) return null;
	const Icon = toolIcon(row.tool);
	const recovered = row.savedTokens - row.netTokens;
	return (
		<Drawer
			open
			onClose={onClose}
			width={600}
			title={
				<span className="spot-drawer-title" title={row.target}>
					{row.target}
				</span>
			}
			subtitle={
				<span className="row spot-drawer-subtitle">
					<Icon size={13} aria-hidden="true" />
					{row.tool}
					{row.holdout && <HoldoutBadge />}
					{row.scoreFree && <ScoreFreeBadge />}
					<span>{formatTimestamp(row.timestamp, locale)}</span>
				</span>
			}
		>
			<div className="spot-drawer-summary">
				<div>
					<div className="spot-eyebrow">
						{row.holdout ? tr("insights.results.would_save", "Would save") : tr("insights.saved", "Saved")}
					</div>
					<div className="spot-drawer-figure num">{formatSignedCompact(row.savedTokens)}</div>
				</div>
				<div>
					<div className="spot-eyebrow">{tr("insights.fetched_back", "Fetched back")}</div>
					<div className={recovered > 0 ? "spot-drawer-figure num tone-warn" : "spot-drawer-figure num"}>
						{formatCompact(recovered)}
					</div>
				</div>
				<div>
					<div className="spot-eyebrow">{tr("insights.net", "Net")}</div>
					{row.holdout ? (
						<div
							className="spot-drawer-figure dim"
							title={tr("insights.results.drawer_net_holdout", "Held out: the model saw the whole result")}
						>
							–
						</div>
					) : (
						<div
							className={
								row.netTokens < 0 ? "spot-drawer-figure num tone-bad" : "spot-drawer-figure num tone-ok"
							}
						>
							{formatSignedCompact(row.netTokens)}
						</div>
					)}
				</div>
			</div>

			<KeyValues
				items={[
					{
						key: "plain",
						label: tr("insights.results.drawer_plain", "Plain would show"),
						value: formatInteger(row.plainTokens),
					},
					{
						key: "out",
						label: tr("insights.results.drawer_out", "Tokens out"),
						value: formatInteger(row.outTokens),
					},
					{
						key: "in",
						label: tr("insights.results.drawer_full", "Full output read"),
						value: formatInteger(row.inTokens),
					},
					{
						key: "hidden",
						label: row.holdout
							? tr("insights.results.drawer_would_hide", "Lines it would hide")
							: tr("insights.results.hidden", "Hidden lines"),
						value: formatInteger(row.hiddenLines),
					},
					{
						key: "steps",
						label: tr("insights.steps.steps", "Steps"),
						value: row.steps.length > 0 ? row.steps.join(" → ") : "–",
					},
					{
						key: "cost",
						label: tr("insights.spotlight_cost", "Spotlight cost"),
						value: formatCost(row.spotlightUsd),
					},
					{
						key: "ms",
						label: tr("insights.results.drawer_shaping_time", "Shaping time"),
						value: formatDurationMs(row.shapeMs),
					},
				]}
			/>

			<div>
				<div className="section-label">{tr("insights.results.call", "Call")}</div>
				<pre className="code-block spot-drawer-call">{row.target}</pre>
			</div>

			<div>
				<div className="section-label">{tr("insights.results.timeline", "Recovery timeline")}</div>
				<ol className="spot-timeline">
					<li className="spot-timeline-item" data-kind={row.holdout ? "holdout" : "cut"}>
						<span className="spot-timeline-node" aria-hidden="true">
							<Scissors size={12} />
						</span>
						<div className="spot-timeline-body">
							<div className="row spot-timeline-head">
								<span className="cell-primary">
									{row.holdout
										? tr("insights.results.timeline_holdout", "Held out: the model saw the original")
										: tr("insights.results.shortened", "Shortened")}
								</span>
								<span className="dim num">
									{row.holdout
										? tr("insights.results.would_change", "would be {plain} → {out} tokens", {
												plain: formatCompact(row.plainTokens),
												out: formatCompact(row.outTokens),
											})
										: tr("insights.results.cut_change", "{plain} → {out} tokens", {
												plain: formatCompact(row.plainTokens),
												out: formatCompact(row.outTokens),
											})}
									{row.hiddenLines > 0 &&
										tr("insights.results.hidden_count", ", {count} lines hidden", {
											count: formatInteger(row.hiddenLines),
										})}
								</span>
							</div>
						</div>
					</li>
					{row.recoveries.map(r => (
						<li
							key={r.toolCallId}
							className="spot-timeline-item"
							data-kind={r.kind}
							style={{ "--kind": RECOVERY_KIND[r.kind].color }}
						>
							<span className="spot-timeline-node" aria-hidden="true">
								<CornerDownRight size={12} />
							</span>
							<div className="spot-timeline-body">
								<div className="row spot-timeline-head">
									<KindBadge kind={r.kind} />
									{r.turn && <Badge tone="warn">{tr("insights.results.extra_turn", "extra turn")}</Badge>}
									<span className="spot-timeline-spacer" />
									<span className="num tone-warn">+{formatCompact(r.tokens)}</span>
								</div>
								<code className="spot-timeline-target" title={r.target}>
									<span className="dim">{r.tool} </span>
									{r.target}
								</code>
								<div className="micro">
									{r.after === 0
										? tr("insights.results.next_call", "The next call")
										: r.after === 1
											? tr("insights.results.call_later_one", "{count} call later", {
													count: formatInteger(r.after),
												})
											: tr("insights.results.call_later_many", "{count} calls later", {
													count: formatInteger(r.after),
												})}
									{tr("insights.results.after_cut", " · {elapsed} after the cut", {
										elapsed: formatElapsed(Math.max(0, r.timestamp - row.timestamp)),
									})}
								</div>
							</div>
						</li>
					))}
					<li className="spot-timeline-item" data-kind="net">
						<span className="spot-timeline-node" aria-hidden="true" />
						<div className="spot-timeline-body">
							<div className="row spot-timeline-head">
								<span className="cell-primary">
									{row.holdout
										? row.recoveries.length === 0
											? tr("insights.results.nothing_fetched", "Nothing fetched back")
											: tr("insights.results.fetched_full", "Fetched more although it saw everything")
										: row.recoveries.length === 0
											? tr("insights.results.full_saving", "Nothing fetched back: the full saving stands")
											: tr("insights.net", "Net")}
								</span>
								<span className="spot-timeline-spacer" />
								{row.holdout ? (
									<span className="dim">{tr("insights.results.no_saving", "saves nothing")}</span>
								) : (
									<NetCell value={row.netTokens} />
								)}
							</div>
						</div>
					</li>
				</ol>
			</div>
		</Drawer>
	);
}
