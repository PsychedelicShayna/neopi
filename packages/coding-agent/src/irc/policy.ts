/**
 * Process-wide operator policy for IRC observability, driven by the `irc.*`
 * settings (see `./settings`). It changes only what the human sees, never what
 * agents may send, receive, or read.
 */

export const DEFAULT_IRC_HISTORY_MAX_ENTRIES = 1000;

let historyMaxEntries = DEFAULT_IRC_HISTORY_MAX_ENTRIES;
let relayToMainTranscript = true;

/** Most entries the operator's IRC history keeps; the oldest drop first. */
export function ircHistoryMaxEntries(): number {
	return historyMaxEntries;
}

export function setIrcHistoryMaxEntries(value: number): void {
	historyMaxEntries = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_IRC_HISTORY_MAX_ENTRIES;
}

/** Whether the root session is told about traffic between other agents (voice, sounds, clients); it never shows it. */
export function ircRelayToMainTranscript(): boolean {
	return relayToMainTranscript;
}

export function setIrcRelayToMainTranscript(value: boolean): void {
	relayToMainTranscript = value;
}
