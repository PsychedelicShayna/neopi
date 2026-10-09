import { prompt } from "@oh-my-pi/pi-utils";
import voiceAgentNoteTemplate from "./prompts/voice-agent-note.md" with { type: "text" };

export const LIVE_VOICE_NOTE_ENTRY_TYPE = "live-voice-note";

export interface LiveVoiceNoteEntry {
	voice: string;
	operator: string;
	delivered: boolean;
	timestamp: number;
}

export interface LiveDelegationDetails {
	operator: string;
	voice?: string;
	noteId?: string;
}

export function buildLiveDelegationMessage(
	operator: string,
	voiceText: string,
	includeVoiceNote: boolean,
): { content: string; details: LiveDelegationDetails } {
	const details: LiveDelegationDetails = { operator };
	if (!voiceText) return { content: operator, details };
	details.voice = voiceText;
	const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
	if (!includeVoiceNote || normalize(voiceText) === normalize(operator)) return { content: operator, details };
	const note = prompt.compile(voiceAgentNoteTemplate)({ voice: voiceText });
	return { content: operator ? `${operator}\n\n${note}` : note, details };
}
