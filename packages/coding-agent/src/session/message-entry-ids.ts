import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionManager } from "./session-manager";

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
const messageEntrySources = new WeakMap<AgentMessage, AgentMessage>();
type LiveMessageOwner = Pick<SessionManager, "getSessionId" | "getSessionFile">;
interface OwnerLiveMessageIds {
	next: number;
	sessionId: string;
	sessionFile: string | undefined;
	ids: WeakMap<AgentMessage, string>;
	assistantId: string | undefined;
}
const liveMessageIds = new WeakMap<LiveMessageOwner, OwnerLiveMessageIds>();

function ownerLiveMessageIds(owner: LiveMessageOwner): OwnerLiveMessageIds {
	const sessionId = owner.getSessionId();
	const sessionFile = owner.getSessionFile();
	let ownerIds = liveMessageIds.get(owner);
	if (!ownerIds) {
		ownerIds = { next: 0, sessionId, sessionFile, ids: new WeakMap(), assistantId: undefined };
		liveMessageIds.set(owner, ownerIds);
	} else if (ownerIds.sessionId !== sessionId || ownerIds.sessionFile !== sessionFile) {
		ownerIds.sessionId = sessionId;
		ownerIds.sessionFile = sessionFile;
		ownerIds.ids = new WeakMap();
		ownerIds.assistantId = undefined;
	}
	return ownerIds;
}

/** Share unsaved identity across transports, without retaining content or inventing journal IDs. */
export function liveMessageId(owner: LiveMessageOwner, message: AgentMessage, existingId?: string): string {
	const ownerIds = ownerLiveMessageIds(owner);
	const native = getMessageEntrySource(message);
	const id = existingId ?? ownerIds.ids.get(native) ?? `msg-${++ownerIds.next}`;
	ownerIds.ids.set(native, id);
	return id;
}

/** Stamp the native emission before any observer can see its frame. Snapshots use the same active identity. */
export function observeLiveMessageId(owner: LiveMessageOwner, message: AgentMessage, ended = false): string {
	const ownerIds = ownerLiveMessageIds(owner);
	const id = liveMessageId(owner, message, message.role === "assistant" ? ownerIds.assistantId : undefined);
	if (message.role === "assistant") ownerIds.assistantId = ended ? undefined : id;
	return id;
}

export function clearLiveMessageId(owner: LiveMessageOwner): void {
	ownerLiveMessageIds(owner).assistantId = undefined;
}

/** Keep a display-only clone tied to its native message before an entry ID exists. */
export function linkMessageEntrySource(display: AgentMessage, native: AgentMessage): void {
	messageEntrySources.set(display, getMessageEntrySource(native));
}

export function getMessageEntrySource(message: AgentMessage): AgentMessage {
	return messageEntrySources.get(message) ?? message;
}

/** Record `entryId` as the session entry behind `message`. Returns `entryId`. */
export function setMessageEntryId(message: AgentMessage, entryId: string): string {
	messageEntryIds.set(message, entryId);
	return entryId;
}

/** The session entry id recorded for `message`, if any. */
export function getMessageEntryId(message: AgentMessage): string | undefined {
	return messageEntryIds.get(message);
}
