/**
 * Plain-text rendering of index reports and recall results for session jobs and the CLI.
 */
import type { IndexReport } from "./indexer";
import type { RecallResult, TraceStep } from "./recall";

export function formatIndexReport(report: IndexReport, limit = 50): string {
	const n = report.nodes;
	const lines = [
		`Chronicle view ${report.dryRun ? "(dry run) " : ""}at ${report.root}`,
		`${report.atoms} atoms from ${report.sessions} sessions in ${report.projects} projects (${report.stores} stores)`,
		`summary model: ${report.summaryModel ?? "unresolved"}`,
		`nodes: ${n.total} total, ${n.fresh} fresh, ${n.generated} regenerated (${n.enumerated} enumerations, ${n.singleChild} single-child), ${n.stale} stale, ${n.blocked} blocked, ${n.outsideWindow} outside window, ${n.failed} failed, ${n.pruned} pruned`,
		`complete: ${report.complete ? "yes" : "no"}`,
	];
	const pending = report.changes.filter(change => change.outcome !== "generated");
	if (pending.length > 0) {
		lines.push("", "Not regenerated:");
		for (const change of pending.slice(0, limit)) {
			lines.push(
				`- ${change.key || "root"} (${change.level}): ${change.outcome}${change.reason ? ` [${change.reason}]` : ""}${change.detail ? ` — ${change.detail}` : ""}`,
			);
		}
		if (pending.length > limit) lines.push(`  … ${pending.length - limit} more (use --json)`);
	}
	if (report.canonical.length > 0) {
		lines.push("", `Canonical diagnostics (${report.canonical.length}; atoms untouched):`);
		for (const diagnostic of report.canonical.slice(0, limit)) {
			lines.push(
				`- ${diagnostic.kind}: ${diagnostic.atomId ? `${diagnostic.atomId} ` : ""}${diagnostic.path} — ${diagnostic.detail}`,
			);
		}
		if (report.canonical.length > limit) lines.push(`  … ${report.canonical.length - limit} more (use --json)`);
	}
	if (report.derived.length > 0) {
		lines.push("", `Derived view problems (${report.derived.length}):`);
		for (const problem of report.derived) lines.push(`- ${problem.key || "root"}: ${problem.detail}`);
	}
	return lines.join("\n");
}

function score(value: number): string {
	return value.toFixed(2);
}

export function formatTraceStep(step: TraceStep, candidateLimit = 8): string {
	const where = step.node || "root";
	const candidates = step.candidates
		?.slice(0, candidateLimit)
		.map(candidate => `${candidate.label} ${score(candidate.score)}`)
		.join("; ");
	return `[${step.search}#${step.hop}] ${step.action} ${where}${candidates ? ` — ${candidates}` : ""}${
		step.note ? ` (${step.note})` : ""
	}`;
}

export function formatRecallResult(
	result: RecallResult,
	options: { traceLimit?: number; traceCandidates?: number } = {},
): string {
	const lines: string[] = [];
	const view = result.view;
	const flags = [
		!view.complete ? "index incomplete or partial" : undefined,
		view.viewStale ? "view stale for some results (re-run `npi chronicle index`)" : undefined,
		result.rankerFallback ? "ranking fell back to lexical on some hops" : undefined,
	].filter(Boolean);
	lines.push(
		`Chronicle recall (${result.ranker} ranker; view indexed ${view.indexedAt ?? "unknown"})${flags.length ? ` — ${flags.join("; ")}` : ""}`,
	);
	if (result.prefilter) {
		lines.push(`Transcript prefilter: ${result.prefilter.matchingSessions.length} candidate sessions (${result.prefilter.matchingTranscripts} matching transcripts); keywords: ${result.prefilter.keywords}`);
	}

	if (result.results.length === 0) lines.push("", "No atoms selected.");
	for (const [index, atom] of result.results.entries()) {
		lines.push(
			"",
			`## ${index + 1}. ${atom.title}`,
			`id: ${atom.id} · ${atom.kind} · ${atom.eventTime} · score ${score(atom.score)}${atom.confident ? " (confident)" : ""} · via ${atom.via}${atom.anchor ? ` (anchor ${atom.anchor})` : ""}${atom.stale ? " · CHANGED since indexing" : ""}`,
			`project: ${atom.project} · session: ${atom.sessionId}`,
			`beat: ${atom.beat}`,
			`transcript: ${atom.transcript.path} entries ${atom.transcript.entryIds.join(", ")}`,
			"",
			atom.body + (atom.bodyTruncated ? "\n… [truncated; read the beat file for the rest]" : ""),
		);
		if (atom.neighbors.length > 0) {
			lines.push("", "Neighbors:");
			for (const neighbor of atom.neighbors) {
				lines.push(`- ${neighbor.eventTime} ${neighbor.title} (${neighbor.id}, session ${neighbor.sessionId})`);
			}
		}
	}

	if (result.candidates.length > 0) {
		lines.push(
			"",
			result.ambiguous
				? `Ambiguous: no confident atom. Narrow with ${result.ask === "time-range" ? "a rough time range (from/to)" : "an adjacent event (hint)"}, or descend a candidate with node=<key>.`
				: "Candidate periods (descend with node=<key> and a finer resolution):",
		);
		for (const period of result.candidates) {
			lines.push(
				`- ${period.key} — ${period.label} (${period.localStart} – ${period.localEnd}, ${period.atomCount} atoms) score ${score(period.score)}: ${period.description}`,
			);
		}
	}

	for (const error of result.evidenceErrors) lines.push(`! ${error.id}: ${error.reason}`);

	const limit = options.traceLimit ?? 24;
	if (result.trace.length > 0) {
		lines.push("", `Trace (${result.trace.length} steps${result.trace.length > limit ? `, first ${limit}` : ""}):`);
		for (const step of result.trace.slice(0, limit)) lines.push(formatTraceStep(step, options.traceCandidates));
	}
	return lines.join("\n");
}
