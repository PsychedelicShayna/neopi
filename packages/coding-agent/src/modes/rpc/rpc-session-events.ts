/**
 * Session-event forwarding for RPC mode: stamps message lifecycle frames with a
 * `messageId` and applies the host's `set_event_filter` selection.
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { deobfuscateAssistantContent } from "../../secrets/message-transform";
import {
	getMessageEntryId,
	getDurableMessageEntryIdentities,
	getMessageEntrySource,
	liveMessageId,
	observeLiveMessageId,
} from "../../session/message-entry-ids";
import type { SessionManager } from "../../session/session-manager";
import type { SessionJournalEvent, SessionJournalIdentity } from "../../session/session-journal-events";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	RpcAgentSessionEventFrame,
	RpcDeltaAssistantMessageEvent,
	RpcMessageUpdates,
	RpcProjectedSessionEventFrame,
} from "./rpc-types";

type JournalSnapshotSource = Pick<
	AgentSession,
	"sessionManager" | "subscribeMessagePersistenceSettled" | "isSessionTransitioning" | "obfuscator"
> & {
	readonly agent: { readonly state: { readonly streamMessage: AgentMessage | null } };
};

/**
 * The shell of a block a `*_start` opens. The snapshot behind a start event is cloned when the agent loop consumes the
 * event, after the provider may have streamed more into the same partial, so its streamed content is not trustworthy:
 * empty it, and every following delta applies cleanly. The matching `*_end` carries the final content.
 */
function openedBlock(block: AssistantMessage["content"][number] | undefined) {
	switch (block?.type) {
		case "text":
			return { ...block, text: "" };
		case "thinking":
			return { ...block, thinking: "" };
		case "toolCall":
			return { ...block, arguments: {} };
		default:
			return block;
	}
}

/** Drops the accumulated snapshot a streaming event carries, keeping what a client needs to rebuild it; `done` and `error` have none. */
function toDelta(event: AssistantMessageEvent): RpcDeltaAssistantMessageEvent {
	switch (event.type) {
		case "done":
		case "error":
			return event;
		case "start": {
			const { partial, ...rest } = event;
			return { ...rest, message: partial };
		}
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta": {
			const { partial: _partial, ...increment } = event;
			return increment;
		}
		case "text_end": {
			// `content` already carries the text; the block adds only what it cannot (the signature).
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "text") return rest;
			const { text: _text, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "thinking_end": {
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "thinking") return rest;
			const { thinking: _thinking, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "image_end":
		case "toolcall_end": {
			// `content` / `toolCall` is the whole block.
			const { partial: _partial, ...rest } = event;
			return rest;
		}
		default: {
			const { partial, ...rest } = event;
			const block = openedBlock(partial.content[event.contentIndex]);
			return block === undefined ? rest : { ...rest, block };
		}
	}
}

/**
 * Writes session events to the RPC output. Message ids are assigned whether or
 * not the frame passes the filter, so changing the filter mid-message never
 * splits one message across two ids.
 */
export class RpcSessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageUpdates: RpcMessageUpdates = "full";
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];
	#assistantMessageId: string | undefined;
	#messageRevision = 0;
	#manager: SessionManager | undefined;
	#unsubscribeJournal: (() => void) | undefined;
	#unsubscribePersistence: (() => void) | undefined;
	#endedMessages = new WeakMap<AgentMessage, { messageId: string; generation: number }>();
	#bindingGeneration = 0;
	readonly #pendingEntryMessages = new Map<string, string>();
	readonly #output: (frame: RpcProjectedSessionEventFrame) => void;

	constructor(output: (frame: RpcProjectedSessionEventFrame) => void) {
		this.#output = output;
	}

	/** Subscribe first, then publish identity before the host requests its history snapshot. */
	observeJournal(session: JournalSnapshotSource): void {
		this.dispose();
		const manager = session.sessionManager;
		this.#manager = manager;
		this.#unsubscribeJournal = manager.subscribeJournal(event => this.#journalEvent(event));
		this.#unsubscribePersistence = session.subscribeMessagePersistenceSettled(message => {
			const ended = this.#endedMessages.get(message);
			this.#endedMessages.delete(message);
			if (!ended || ended.generation !== this.#bindingGeneration) return;
			const entryId = getMessageEntryId(message);
			if (!entryId) return;
			this.#pendingEntryMessages.set(entryId, ended.messageId);
			this.#associateEntry(entryId);
		});
		this.snapshotJournal(session);
	}

	/** An ordered, repeatable native snapshot, without replacing the live subscription. */
	snapshotJournal(session: JournalSnapshotSource): SessionJournalIdentity {
		const manager = session.sessionManager;
		const identity = manager.getJournalIdentity();
		const generation = this.#bindingGeneration;
		const revision = this.#messageRevision;
		const streamMessage = session.isSessionTransitioning ? null : session.agent.state.streamMessage;
		const messageEntryIds = getDurableMessageEntryIdentities(manager);
		this.#emit({ type: "journal_state", reason: "snapshot", ...identity, messageEntryIds });
		const current = manager.getJournalIdentity();
		if (streamMessage?.role !== "assistant" || session.isSessionTransitioning ||
			generation !== this.#bindingGeneration || revision !== this.#messageRevision ||
			current.sessionId !== identity.sessionId || current.sessionFile !== identity.sessionFile ||
			current.leafId !== identity.leafId) return current;
		let messageId = this.#assistantMessageId;
		if (messageId === undefined) {
			messageId = observeLiveMessageId(manager, streamMessage);
			this.#assistantMessageId = messageId;
			this.#openMessageIds.push(messageId);
		}
		const obfuscator = session.obfuscator;
		const content = obfuscator
			? deobfuscateAssistantContent(obfuscator, streamMessage.content)
			: streamMessage.content;
		const message = content === streamMessage.content ? streamMessage : { ...streamMessage, content };
		this.#emit({ type: "message_start", snapshot: true, ...identity, messageId, message });
		return manager.getJournalIdentity();
	}

	dispose(): void {
		this.#unsubscribeJournal?.();
		this.#unsubscribeJournal = undefined;
		this.#unsubscribePersistence?.();
		this.#unsubscribePersistence = undefined;
		this.#manager = undefined;
		this.#invalidateBinding();
	}

	#invalidateBinding(): void {
		this.#bindingGeneration++;
		this.#openMessageIds.length = 0;
		this.#assistantMessageId = undefined;
		this.#pendingEntryMessages.clear();
		this.#endedMessages = new WeakMap();
	}

	#journalEvent(event: SessionJournalEvent): void {
		if (event.type === "journal_state" && event.reason === "identity") this.#invalidateBinding();
		this.#emit(event);
		if (event.type === "journal_entry") this.#associateEntry(event.entry.id);
	}

	#associateEntry(entryId: string): void {
		const messageId = this.#pendingEntryMessages.get(entryId);
		if (!messageId || !this.#manager?.isEntryDurable(entryId)) return;
		this.#pendingEntryMessages.delete(entryId);
		this.#emit({ type: "message_persisted", ...this.#manager.getJournalIdentity(), messageId, entryId });
	}

	#emit(frame: RpcProjectedSessionEventFrame): void {
		if (!this.#filter || this.#filter.has(frame.type)) this.#output(frame);
	}

	/** Forward only the listed event types; `null` forwards everything. Returns the active selection. */
	setFilter(events: readonly string[] | null, messageUpdates: RpcMessageUpdates = "full"): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		this.#messageUpdates = messageUpdates;
		return this.#filter ? Array.from(this.#filter) : null;
	}

	forward(event: AgentSessionEvent): void {
		if (event.type === "message_start" || event.type === "message_update" ||
			event.type === "message_end" || event.type === "agent_end") this.#messageRevision++;
		// A subscription snapshot or update may beat the session's delayed start notification.
		if (event.type === "message_start" && event.message.role === "assistant" &&
			this.#assistantMessageId !== undefined) return;
		const generation = this.#bindingGeneration;
		const frame = this.#stamp(event);
		if (event.type === "message_end" && frame.type === "message_end" && this.#manager) {
			this.#endedMessages.set(getMessageEntrySource(event.message), { messageId: frame.messageId, generation });
		}
		if (this.#filter && !this.#filter.has(frame.type)) return;
		if (frame.type === "message_update" && this.#messageUpdates === "delta") {
			this.#output({
				...frame,
				message: { role: frame.message.role },
				assistantMessageEvent: toDelta(frame.assistantMessageEvent),
			});
			return;
		}
		this.#output(frame);
	}

	#stamp(event: AgentSessionEvent): RpcAgentSessionEventFrame {
		switch (event.type) {
			case "message_start": {
				const messageId = this.#mintMessageId(event.message);
				this.#openMessageIds.push(messageId);
				if (event.message.role === "assistant") this.#assistantMessageId = messageId;
				return { ...event, messageId };
			}
			case "message_update": {
				let messageId = this.#assistantMessageId ?? this.#openMessageIds.at(-1);
				if (messageId === undefined) {
					messageId = this.#mintMessageId(event.message);
					this.#openMessageIds.push(messageId);
				}
				this.#assistantMessageId = messageId;
				if (this.#manager) liveMessageId(this.#manager, event.message, messageId);
				return { ...event, messageId };
			}
			case "message_end": {
				const messageId = this.#openMessageIds.pop() ?? this.#assistantMessageId ?? this.#mintMessageId(event.message);
				if (event.message.role === "assistant") this.#assistantMessageId = undefined;
				if (this.#manager) liveMessageId(this.#manager, event.message, messageId);
				return { ...event, messageId };
			}
			case "agent_end":
				// A run never leaves a message open; drop anything a dropped frame stranded.
				this.#openMessageIds.length = 0;
				this.#assistantMessageId = undefined;
				return event;
			default:
				return event;
		}
	}

	#mintMessageId(message: AgentMessage): string {
		return this.#manager ? liveMessageId(this.#manager, message) : `msg-${++this.#messageCount}`;
	}
}
