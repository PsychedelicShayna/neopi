/**
 * Plain-text rendering of recall results for the tool and the CLI.
 */
import type { RecallResult, TraceStep } from "./recall";

function score(value: number): string {
	return value.toFixed(2);
}

export function formatTraceStep(step: TraceStep): string {
	const where = step.node || "root";
	const candidates = step.candidates
		?.slice(0, 8)
		.map(candidate => `${candidate.label} ${score(candidate.score)}`)
		.join("; ");
	return `[${step.search}#${step.hop}] ${step.action} ${where}${candidates ? ` — ${candidates}` : ""}${
		step.note ? ` (${step.note})` : ""
	}`;
}

export function formatRecallResult(result: RecallResult, options: { traceLimit?: number } = {}): string {
	const lines: string[] = [];
	const view = result.view;
	const flags = [
		!view.complete ? "index incomplete or partial" : undefined,
		view.viewStale ? "view stale for some results (re-run `npi chronicle index`)" : undefined,
		result.rankerFallback ? "model ranking fell back to lexical on some hops" : undefined,
	].filter(Boolean);
	lines.push(
		`Chronicle recall (${result.ranker} ranker; view indexed ${view.indexedAt ?? "unknown"})${flags.length ? ` — ${flags.join("; ")}` : ""}`,
	);

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
		for (const step of result.trace.slice(0, limit)) lines.push(formatTraceStep(step));
	}
	return lines.join("\n");
}
