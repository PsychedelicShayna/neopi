import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isUserInvokedSkillPrompt } from "@oh-my-pi/pi-tui/chat/messages";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isRecord } from "@oh-my-pi/pi-utils";

import { ADVISOR_RENDER_OPTIONS } from "../advisor/delta-split";
import entryTemplate from "../prompts/chronicler/entry.md" with { type: "text" };
import type { CustomMessage } from "../session/messages";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../session/session-entries";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import type { CaptureSource } from "./store";

export interface ChronicleEntry extends CaptureSource {
	message: AgentMessage;
}

/** Shared by live capture and the headless backfill coverage scan. */
export function isChroniclerSourceEntry(entry: SessionEntry): entry is SessionMessageEntry | CustomMessageEntry {
	return (
		entry.type === "message" ||
		(entry.type === "custom_message" &&
			((entry.customType === "advisor" && entry.display) || isUserInvokedSkillPrompt(entry)))
	);
}

export function toChronicleEntry(entry: SessionMessageEntry | CustomMessageEntry): ChronicleEntry {
	const { id, parentId, timestamp } = entry;
	if (entry.type === "message") return { id, parentId, timestamp, message: entry.message };

	// The primary's persisted advice cards record interventions, not the advisor's
	// separate transcript (which includes private thinking and echoed primary input).
	if (entry.customType === "advisor") {
		return {
			id,
			parentId,
			timestamp,
			message: {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: Date.parse(timestamp),
			},
		};
	}

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

function renderAdvisorIntervention(message: CustomMessage): string {
	const { details } = message;
	const notes: unknown[] = isRecord(details) && Array.isArray(details.notes) ? details.notes : [];
	const rendered: string[] = [];
	for (const note of notes) {
		if (!isRecord(note) || typeof note.note !== "string" || !note.note.trim()) continue;
		const advisor = typeof note.advisor === "string" && note.advisor.trim() ? note.advisor : "default";
		const severity = typeof note.severity === "string" ? `; ${note.severity}` : "";
		rendered.push(`**Advisor (${advisor}${severity})**:\n${note.note.trim()}`);
	}
	// Older cards can lack structured notes; keep their full recorded body.
	return rendered.length ? rendered.join("\n\n") : `**Advisor**:\n${textContent(message.content, "\n")}`.trim();
}

function renderTranscript(message: AgentMessage, includeThinking: boolean): string {
	if (message.role === "custom" && message.customType === "advisor" && message.display) {
		return renderAdvisorIntervention(message);
	}
	// No cross-entry result index: a result retains its own source marker.
	return formatSessionHistoryMarkdown([message], {
		...ADVISOR_RENDER_OPTIONS,
		includeThinking,
		includeToolCallIds: true,
	}).trim();
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
				transcript: renderTranscript(entry.message, opts.includeThinking),
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
