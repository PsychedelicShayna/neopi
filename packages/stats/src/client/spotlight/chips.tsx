import type { SpotlightCutGroup, SpotlightRecoveryKind } from "../types";
import { useTranslation } from "../i18n";
import { CUT_GROUP, cutGroupLabel, cutGroupRule, RECOVERY_KIND, recoveryLabel, recoveryRule } from "./meta";

/** Key to the fetch-back groups: each group's mark shape and color, its rule on hover. */
export function GroupLegend({ groups }: { groups: readonly SpotlightCutGroup[] }) {
	const tr = useTranslation();
	return (
		<div className="legend spot-group-legend">
			{groups.map(group => (
				<span
					key={group}
					className="legend-item"
					title={cutGroupRule(tr, group)}
					style={{ "--dot": CUT_GROUP[group].color }}
				>
					<span className="spot-group-mark" data-shape={CUT_GROUP[group].shape} aria-hidden="true" />
					{cutGroupLabel(tr, group)}
				</span>
			))}
		</div>
	);
}

/** Shows or hides the tools a card folded away (see `foldTools`). */
export function MoreTools({
	hidden,
	expanded,
	onToggle,
}: {
	hidden: readonly string[];
	expanded: boolean;
	onToggle: () => void;
}) {
	const tr = useTranslation();
	return (
		<button
			type="button"
			className="btn spot-more-tools"
			data-variant="ghost"
			data-size="sm"
			aria-expanded={expanded}
			title={expanded ? undefined : hidden.join(", ")}
			onClick={onToggle}
		>
			{expanded
				? tr("insights.show_fewer", "Show fewer tools")
				: tr("insights.show_more", "Show {count} more tools", { count: hidden.length })}
		</button>
	);
}

/** Recovery kind pill: icon, label (or a count) in the kind's color. */
export function KindBadge({ kind, count }: { kind: SpotlightRecoveryKind; count?: number }) {
	const tr = useTranslation();
	const meta = RECOVERY_KIND[kind];
	const Icon = meta.icon;
	const label = recoveryLabel(tr, kind);
	const rule = recoveryRule(tr, kind);
	return (
		<span
			className="spot-kind"
			style={{ "--kind": meta.color }}
			title={
				count === undefined
					? rule
					: tr("insights.recovery.count_title", "{count} × {label}: {rule}", {
							count,
							label: label.toLowerCase(),
							rule,
						})
			}
		>
			<Icon size={12} aria-hidden="true" />
			{count === undefined ? label : <span className="num">{count}</span>}
			{count !== undefined && <span className="sr-only">{recoveryLabel(tr, kind, true)}</span>}
		</span>
	);
}
