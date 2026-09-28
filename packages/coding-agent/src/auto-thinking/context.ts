import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import { readCommittedChroniclerBatches, type CommittedChroniclerBatch } from "../chronicler/store";
import contextTemplate from "../prompts/system/auto-thinking-effort-context.md" with { type: "text" };
import { formatSessionDumpText } from "../session/session-dump-format";
import type { SessionMessageEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

/** No live Chronicler access: only the session's branch and artifact location. */
export type EffortContextSession = Pick<SessionManager, "getBranch"> &
	Partial<Pick<SessionManager, "getArtifactsDir">>;

type TranscriptEntry = Pick<SessionMessageEntry, "id" | "message">;

const renderContext = prompt.compile(contextTemplate);

function messageText(message: TranscriptEntry["message"]): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

/** Build context from one frozen active-branch transcript and one immutable commit snapshot. */
export function renderEffortContext(
	promptText: string,
	transcript: readonly TranscriptEntry[],
	batches: readonly CommittedChroniclerBatch[],
): string {
	const active = new Set(transcript.map(entry => entry.id));
	const last = transcript[transcript.length - 1];
	const pendingId = last && messageText(last.message) === promptText ? last.id : undefined;
	const included = new Set<string>();
	const diary: ({ title: string; body: string } | { carry: true; body: string })[] = [];
	for (const batch of batches) {
		// The commit manifest may include another branch. A beat is safe only when
		// every one of its sources belongs to the selected active branch.
		for (const beat of batch.beats) {
			if (!beat.sources.every(id => active.has(id) && id !== pendingId)) continue;
			diary.push({ title: beat.title, body: beat.body });
			for (const id of beat.sources) included.add(id);
		}
		const carry = batch.checkpoint.carry;
		if (carry && carry.sources.length && carry.sources.every(id => active.has(id) && id !== pendingId)) {
			diary.push({ body: carry.text, carry: true });
			for (const id of carry.sources) included.add(id);
		}
	}
	const uncovered = transcript.filter(entry => entry.id !== pendingId && !included.has(entry.id));
	const history = uncovered.length
		? formatSessionDumpText({ messages: uncovered.map(entry => entry.message) })
		: "";
	// Rendering without post-formatting preserves verbatim request and transcript whitespace.
	return renderContext({ diary, history: history.trim(), request: promptText });
}

/** Missing or unusable diary is a read-only transcript fallback, never a cache repair. */
export async function readEffortContext(
	promptText: string,
	manager?: EffortContextSession,
	onFallback?: (reason: string) => void,
): Promise<string> {
	if (!manager) return renderContext({ diary: [], history: "", request: promptText });
	const transcript = manager.getBranch().filter(entry => entry.type === "message");
	const artifacts = manager.getArtifactsDir?.();
	if (!artifacts) {
		onFallback?.("No committed Chronicler diary; classifying from the active-branch transcript.");
		return renderEffortContext(promptText, transcript, []);
	}
	try {
		const batches = await readCommittedChroniclerBatches(path.join(artifacts, "chronicler"));
		if (batches.length === 0) onFallback?.("No committed Chronicler diary; classifying from the active-branch transcript.");
		return renderEffortContext(promptText, transcript, batches);
	} catch {
		onFallback?.("Chronicler diary is unreadable; classifying from the active-branch transcript.");
		return renderEffortContext(promptText, transcript, []);
	}
}
