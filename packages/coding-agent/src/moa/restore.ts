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
