import type { Settings } from "../config/settings";
import { cfgMoaMaxHops } from "./settings";
import type { MixtureRun } from "./types";

/** Operator-facing progress of the runs currently held by a session. */
export function formatMixtureStatus(runs: readonly MixtureRun[], settings: Settings): string {
	if (runs.length === 0) return "no active mixture run";
	return runs
		.map(run => {
			const maxHops = run.resolved.definition.limits?.maxHops ?? cfgMoaMaxHops.get(settings);
			return `mixture/${run.key.mixture}: ${run.status} · phase ${run.phase.kind} · member ${run.activeMemberId ?? "-"} · hops ${run.lifetime.hops} (window ${run.window.hops}/${maxHops}) · spent $${run.lifetime.usd.toFixed(2)} (window $${run.window.usd.toFixed(2)})`;
		})
		.join("\n");
}

export function formatMixtureReset(reset: readonly { mixture: string; runId: string }[]): string {
	if (reset.length === 0) return "no active mixture run";
	return `reset ${reset.length} mixture run(s): ${reset.map(run => `mixture/${run.mixture}`).join(", ")}`;
}
