import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionManager } from "./session-manager";
import type { SessionEntry } from "./session-entries";

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

export interface MessageEntryIdentity {
	messageId: string;
	entryId: string;
}

/** Bounded, content-free recovery history for one native session owner. */
export const MESSAGE_ENTRY_IDENTITY_LIMIT = 256;
interface OwnerLiveMessageIds {
	incarnation: string;
	next: number;
	sessionId: string;
	sessionFile: string | undefined;
	ids: WeakMap<AgentMessage, string>;
	assistantId: string | undefined;
	entryIds: Map<string, string>;
}
const liveMessageIds = new WeakMap<LiveMessageOwner, OwnerLiveMessageIds>();
const messageLiveIdentities = new WeakMap<AgentMessage, { ownerIds: OwnerLiveMessageIds; messageId: string }>();

function ownerLiveMessageIds(owner: LiveMessageOwner): OwnerLiveMessageIds {
	const sessionId = owner.getSessionId();
	const sessionFile = owner.getSessionFile();
	let ownerIds = liveMessageIds.get(owner);
	if (!ownerIds || ownerIds.sessionId !== sessionId || ownerIds.sessionFile !== sessionFile) {
		ownerIds = {
			incarnation: ownerIds?.incarnation ?? Bun.randomUUIDv7(),
			next: ownerIds?.next ?? 0,
			sessionId,
			sessionFile,
			ids: new WeakMap(),
			assistantId: undefined,
			entryIds: new Map(),
		};
		liveMessageIds.set(owner, ownerIds);
	}
	return ownerIds;
}

function retainEntryIdentity(ownerIds: OwnerLiveMessageIds, messageId: string, entryId: string): void {
	ownerIds.entryIds.set(messageId, entryId);
	if (ownerIds.entryIds.size > MESSAGE_ENTRY_IDENTITY_LIMIT) {
		const oldest = ownerIds.entryIds.keys().next().value;
		if (oldest !== undefined) ownerIds.entryIds.delete(oldest);
	}
}

/** Most recent durable associations, oldest first, independent of transport subscriptions. */
export function getDurableMessageEntryIdentities(
	owner: LiveMessageOwner & Pick<SessionManager, "isEntryDurable">,
): MessageEntryIdentity[] {
	const identities: MessageEntryIdentity[] = [];
	for (const [messageId, entryId] of ownerLiveMessageIds(owner).entryIds) {
		if (owner.isEntryDurable(entryId)) identities.push({ messageId, entryId });
	}
	return identities;
}

/**
 * Live identities for entries in a journal read, whether or not they are durable.
 * Read native message objects as well as the bounded recovery window so an older
 * live message included in this response is not lost to snapshot-window eviction.
 * These pairs identify the rendering cut; they are not persistence acknowledgements.
 */
export function getMessageEntryIdentities(
	owner: LiveMessageOwner,
	entries: readonly SessionEntry[],
): MessageEntryIdentity[] {
	const ownerIds = ownerLiveMessageIds(owner);
	const recentIds = new Map<string, string>();
	for (const [messageId, entryId] of ownerIds.entryIds) recentIds.set(entryId, messageId);
	const identities: MessageEntryIdentity[] = [];
	for (const entry of entries) {
		const messageId = (entry.type === "message"
			? ownerIds.ids.get(getMessageEntrySource(entry.message))
			: undefined) ?? recentIds.get(entry.id);
		if (messageId !== undefined) identities.push({ messageId, entryId: entry.id });
	}
	return identities;
}

/** Opaque, incarnation-unique unsaved identity shared across an owner's transports. */
export function liveMessageId(owner: LiveMessageOwner, message: AgentMessage, existingId?: string): string {
	const ownerIds = ownerLiveMessageIds(owner);
	const native = getMessageEntrySource(message);
	const id = existingId ?? ownerIds.ids.get(native) ?? `msg-${ownerIds.incarnation}-${++ownerIds.next}`;
	ownerIds.ids.set(native, id);
	const previous = messageLiveIdentities.get(native);
	if (previous?.ownerIds !== ownerIds || previous.messageId !== id) {
		messageLiveIdentities.set(native, { ownerIds, messageId: id });
		const entryId = getMessageEntryId(native);
		if (entryId !== undefined) retainEntryIdentity(ownerIds, id, entryId);
	}
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
	const live = messageLiveIdentities.get(getMessageEntrySource(message));
	if (live) retainEntryIdentity(live.ownerIds, live.messageId, entryId);
	return entryId;
}

/** The session entry id recorded for `message`, if any. */
export function getMessageEntryId(message: AgentMessage): string | undefined {
	return messageEntryIds.get(message);
}
