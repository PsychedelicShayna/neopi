import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Session entry id behind each in-memory message, keyed by object identity.
 *
 * Messages carry no id of their own, but hosts need to line a transcript
 * message up with the durable entry it was persisted as (RPC
 * `get_messages_page` `entryId`, rollback via `branch`). A WeakMap keeps the
 * association off the message object, so it never reaches provider payloads,
 * the session file, or structural equality checks, and it dies with the
 * message.
 *
 * Writers: `SessionManager.appendMessage` and every live custom-message append
 * record the entry they wrote; `buildSessionContext` records the entry each
 * rebuilt message came from; a prompt records the reserved id it will be
 * persisted under before the turn starts.
 */
const messageEntryIds = new WeakMap<AgentMessage, string>();

/** Record `entryId` as the session entry behind `message`. Returns `entryId`. */
export function setMessageEntryId(message: AgentMessage, entryId: string): string {
	messageEntryIds.set(message, entryId);
	return entryId;
}

/** The session entry id recorded for `message`, if any. */
export function getMessageEntryId(message: AgentMessage): string | undefined {
	return messageEntryIds.get(message);
}
