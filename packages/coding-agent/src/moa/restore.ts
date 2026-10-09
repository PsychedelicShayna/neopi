import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import { MIXTURE_RUN_ENTRY_TYPE, type MixtureCheckpoint } from "./types";

/** Match the newest durable done checkpoint to the assistant response it named, within one reset boundary. */
export function completedMixtureRun(branch: readonly SessionEntry[], runId: string): MixtureCheckpoint | undefined {
	const responses = new Set<string>();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "reset_boundary") break;
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.responseId) {
			responses.add(entry.message.responseId);
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== MIXTURE_RUN_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { reason, run, outerResponseId } = entry.data;
		if (
			reason === "done" &&
			isRecord(run) &&
			run.id === runId &&
			typeof outerResponseId === "string" &&
			responses.has(outerResponseId)
		) {
			return entry.data as unknown as MixtureCheckpoint;
		}
	}
	return undefined;
}

export function isMixtureRunComplete(branch: readonly SessionEntry[], runId: string): boolean {
	return completedMixtureRun(branch, runId) !== undefined;
}

/**
 * Select the latest resumable run on the active branch. An assistant response
 * commits only checkpoints preceding it, within this branch's reset boundary.
 * A newer uncommitted checkpoint is skipped in favor of the last durable one.
 */
export function restoreMixtureRun(
	branch: readonly SessionEntry[],
): { checkpoint: MixtureCheckpoint; committed: boolean } | undefined {
	const responses = new Set<string>();
	let runId: string | undefined;
	let reset = false;
	let candidate: MixtureCheckpoint | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "reset_boundary") break;
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.responseId) {
			responses.add(entry.message.responseId);
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== MIXTURE_RUN_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { kind, run, outerResponseId } = entry.data;
		const entryRunId = isRecord(run) && typeof run.id === "string" ? run.id : entry.data.runId;
		if (typeof entryRunId !== "string") continue;
		runId ??= entryRunId;
		if (entryRunId !== runId) continue;
		if (kind === "run_reset") reset = true;
		if (reset || candidate || !isRecord(run) || typeof entry.data.reason !== "string") continue;
		if (outerResponseId !== undefined && (typeof outerResponseId !== "string" || !responses.has(outerResponseId)))
			continue;
		candidate = entry.data as unknown as MixtureCheckpoint;
	}
	if (!runId || reset || isMixtureRunComplete(branch, runId) || !candidate) return undefined;
	return { checkpoint: candidate, committed: candidate.outerResponseId !== undefined };
}
