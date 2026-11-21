import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isUserInvokedSkillPrompt } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord } from "@oh-my-pi/pi-utils";

import { ADVISOR_RENDER_OPTIONS } from "../advisor/delta-split";
import entryTemplate from "../prompts/chronicler/entry.md" with { type: "text" };
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../session/session-entries";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import type { CaptureSource } from "./store";

export interface ChronicleEntry extends CaptureSource {
	message: AgentMessage;
}

/** Shared by live capture and the headless backfill coverage scan. */
export function isChroniclerSourceEntry(entry: SessionEntry): entry is SessionMessageEntry | CustomMessageEntry {
	return entry.type === "message" || (entry.type === "custom_message" && isUserInvokedSkillPrompt(entry));
}

export function toChronicleEntry(entry: SessionMessageEntry | CustomMessageEntry): ChronicleEntry {
	const { id, parentId, timestamp } = entry;
	if (entry.type === "message") return { id, parentId, timestamp, message: entry.message };

	// The history formatter reads the structured args and labels them `User:`.
	// Never give it the expanded body, even as a fallback for a bare invocation.
	const details = isRecord(entry.details) ? entry.details : undefined;
	return {
		id,
		parentId,
		timestamp,
		message: {
			role: "custom",
			customType: entry.customType,
			attribution: entry.attribution,
			content: "",
			display: true,
			details: { name: details?.name, args: details?.args },
			timestamp: Date.parse(timestamp),
		},
	};
}

export interface RenderChronicleDeltaOptions {
	includeThinking: boolean;
	obfuscator?: { obfuscate(text: string, shared?: ReadonlySet<string>): string };
}

export function renderChronicleDelta(
	entries: readonly ChronicleEntry[],
	opts: RenderChronicleDeltaOptions,
): AgentMessage[] {
	if (!entries.length) return [];
	const text = entries
		.map(entry =>
			renderPromptAsset("chronicler/entry.md", entryTemplate, {
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				// Deliberately no cross-entry result index: a result retains its own source marker.
				transcript: formatSessionHistoryMarkdown([entry.message], {
					...ADVISOR_RENDER_OPTIONS,
					includeThinking: opts.includeThinking,
					includeToolCallIds: true,
				}).trim(),
			}),
		)
		.join("\n\n");
	return [
		{
			role: "user",
			content: [{ type: "text", text: opts.obfuscator?.obfuscate(text) ?? text }],
			timestamp: Date.now(),
		},
	];
}
