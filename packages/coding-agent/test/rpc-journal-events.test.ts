import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";
import { RpcSessionEventForwarder } from "../src/modes/rpc/rpc-session-events";
import type { RpcProjectedSessionEventFrame } from "../src/modes/rpc/rpc-types";
import type { SessionJournalEvent } from "../src/session/session-journal-events";
import { SessionManager } from "../src/session/session-manager";
import {
	linkMessageEntrySource,
	MESSAGE_ENTRY_IDENTITY_LIMIT,
	observeLiveMessageId,
	setMessageEntryId,
} from "../src/session/message-entry-ids";
import {
	MemorySessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
} from "../src/session/session-storage";
import { makeAssistantMessage } from "./session-manager/helpers";

class RefusingStorage extends MemorySessionStorage {
	refuse = false;
	override writeTextSync(file: string, text: string, options?: SessionStorageWriteOptions): void {
		if (this.refuse) throw new Error("journal write refused");
		super.writeTextSync(file, text, options);
	}
	override appendSync(file: string, text: string): void {
		if (this.refuse) throw new Error("journal append refused");
		super.appendSync(file, text);
	}
}

class GatedStorage extends MemorySessionStorage {
	readonly publish = Promise.withResolvers<void>();
	override openWriter(
		file: string,
		options?: { flags?: "a" | "w"; onError?: (error: Error) => void },
	): SessionStorageWriter {
		const inner = super.openWriter(file, options);
		let queued = Promise.resolve();
		return {
			append: line => {
				queued = queued.then(async () => {
					await this.publish.promise;
					await inner.append(line);
				});
				return queued;
			},
			flush: async () => {
				await queued;
				await inner.flush();
			},
			close: async () => {
				await queued;
				await inner.close();
			},
			isOpen: () => inner.isOpen(),
			getError: () => inner.getError(),
		};
	}
}

function transport(manager: SessionManager, streamMessage: AgentMessage | null = null) {
	const frames: RpcProjectedSessionEventFrame[] = [];
	const settled = new Set<(message: AgentMessage) => void>();
	const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
	const source = {
		sessionManager: manager,
		agent: { state: { streamMessage } },
		isSessionTransitioning: false,
		obfuscator: undefined,
		subscribeMessagePersistenceSettled(listener: (message: AgentMessage) => void) {
			settled.add(listener);
			return () => settled.delete(listener);
		},
	};
	forwarder.observeJournal(source);
	return {
		frames,
		forwarder,
		source,
		settle: (message: AgentMessage) => {
			for (const listener of settled) listener(message);
		},
	};
}

function committed(events: readonly SessionJournalEvent[]): string[] {
	return events.flatMap(event => (event.type === "journal_entry" ? [event.entry.id] : []));
}

describe("native journal notifications", () => {
	test("snapshot replays running tools and their latest partial output without an assistant in flight", async () => {
		const manager = SessionManager.inMemory();
		const live = transport(manager);
		const start = {
			type: "tool_execution_start" as const,
			toolCallId: "tool-1",
			toolName: "bash",
			args: { command: "work" },
		};
		live.forwarder.forward(start);
		live.forwarder.forward({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "bash",
			args: start.args,
			partialResult: { content: [{ type: "text", text: "old output" }], details: {} },
		});
		const update = {
			type: "tool_execution_update" as const,
			toolCallId: "tool-1",
			toolName: "bash",
			args: start.args,
			partialResult: { content: [{ type: "text" as const, text: "latest output" }], details: {} },
		};
		live.forwarder.forward(update);
		live.frames.length = 0;
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames).toMatchObject([
			{ type: "journal_state", reason: "snapshot" },
			{ ...start, snapshot: true },
			{ ...update, snapshot: true },
		]);

		live.forwarder.forward({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
		live.frames.length = 0;
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.map(frame => frame.type)).toEqual(["journal_state"]);

		live.forwarder.forward(start);
		await manager.newSession();
		live.frames.length = 0;
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.map(frame => frame.type)).toEqual(["journal_state"]);
		live.forwarder.dispose();
		await manager.close();
	});

	test("tool snapshot tracking survives an event filter without bypassing the filter", async () => {
		const manager = SessionManager.inMemory();
		const live = transport(manager);
		live.forwarder.setFilter(["journal_state"]);
		live.forwarder.forward({ type: "tool_execution_start", toolCallId: "filtered-tool", toolName: "read", args: {} });
		live.frames.length = 0;
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.map(frame => frame.type)).toEqual(["journal_state"]);
		live.forwarder.setFilter(null);
		live.frames.length = 0;
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.at(-1)).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "filtered-tool",
			snapshot: true,
		});
		live.forwarder.dispose();
		await manager.close();
	});

	test("append subscribers coexist, unsubscribe independently and cannot break other observers", async () => {
		const manager = SessionManager.inMemory();
		const first: string[] = [];
		const second: string[] = [];
		manager.subscribeEntries(() => {
			throw new Error("observer disconnected");
		});
		const stop = manager.subscribeEntries(entry => first.push(entry.id));
		manager.subscribeEntries(entry => second.push(entry.id));
		const a = manager.appendCustomEntry("first");
		stop();
		const b = manager.appendCustomEntry("second");
		expect(first).toEqual([a]);
		expect(second).toEqual([a, b]);
		await manager.close();
	});

	test("failed writes stay unsaved, then recovery announces each confirmed entry once", async () => {
		await using dir = await TempDir.create("@journal-events-failure-");
		const storage = new RefusingStorage();
		const manager = SessionManager.create(dir.path(), dir.path(), storage);
		const events: SessionJournalEvent[] = [];
		manager.subscribeJournal(event => events.push(event));
		await manager.ensureOnDisk();
		storage.refuse = true;
		const id = manager.appendMessage(makeAssistantMessage());
		expect(manager.isEntryDurable(id)).toBe(false);
		expect(committed(events)).toEqual([]);
		await expect(manager.flush()).rejects.toThrow("journal append refused");
		storage.refuse = false;
		await manager.recoverPersistenceFromCurrentState();
		expect(manager.isEntryDurable(id)).toBe(true);
		expect(committed(events)).toEqual([id]);
		await manager.rewriteEntries();
		expect(committed(events)).toEqual([id]);
		await manager.close();
	});

	test("subscribing before a snapshot catches an append during snapshot delivery without polling", async () => {
		await using dir = await TempDir.create("@journal-events-snapshot-");
		const manager = SessionManager.create(dir.path(), dir.path(), new MemorySessionStorage());
		await manager.ensureOnDisk();
		const frames: RpcProjectedSessionEventFrame[] = [];
		let id = "";
		const forwarder = new RpcSessionEventForwarder(frame => {
			frames.push(frame);
			if (frame.type === "journal_state" && frame.reason === "snapshot")
				id = manager.appendCustomEntry("during snapshot");
		});
		forwarder.observeJournal({
			sessionManager: manager,
			agent: { state: { streamMessage: null } },
			isSessionTransitioning: false,
			obfuscator: undefined,
			subscribeMessagePersistenceSettled: () => () => {},
		});
		expect(frames.filter(frame => frame.type === "journal_entry")).toMatchObject([{ entry: { id } }]);
		const original = manager.getJournalIdentity();
		manager.resetLeaf();
		expect(frames.at(-1)).toMatchObject({ type: "journal_state", reason: "leaf", ...original, leafId: null });
		manager.branch(id);
		expect(frames.at(-1)).toMatchObject({ type: "journal_state", reason: "leaf", leafId: id });
		await manager.newSession();
		expect(frames.at(-1)).toMatchObject({
			type: "journal_state",
			reason: "identity",
			...manager.getJournalIdentity(),
		});
		expect(manager.getSessionId()).not.toBe(original.sessionId);
		forwarder.dispose();
		await manager.close();
	});

	test("live IDs bind only after persistence and an owner session change invalidates old messages", async () => {
		await using dir = await TempDir.create("@journal-events-identities-");
		const storage = new RefusingStorage();
		const manager = SessionManager.create(dir.path(), dir.path(), storage);
		await manager.ensureOnDisk();
		const live = transport(manager);
		const message = makeAssistantMessage();
		const messageId = observeLiveMessageId(manager, message);
		live.forwarder.forward({ type: "message_start", message });
		live.forwarder.forward({ type: "message_end", message });
		storage.refuse = true;
		const entryId = manager.appendMessage(message);
		live.settle(message);
		expect(live.frames.some(frame => frame.type === "message_persisted")).toBe(false);
		storage.refuse = false;
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.at(-1)).toMatchObject({ type: "journal_state", reason: "snapshot", messageEntryIds: [] });
		await manager.recoverPersistenceFromCurrentState();
		expect(live.frames.filter(frame => frame.type === "message_persisted")).toEqual([
			{ type: "message_persisted", ...manager.getJournalIdentity(), messageId, entryId },
		]);
		const old = makeAssistantMessage();
		live.forwarder.forward({ type: "message_start", message: old });
		live.forwarder.forward({ type: "message_end", message: old });
		await manager.newSession();
		manager.appendMessage(old);
		live.settle(old);
		expect(live.frames.filter(frame => frame.type === "message_persisted")).toHaveLength(1);
		live.forwarder.dispose();
		await manager.close();
	});

	test("a disconnected observer recovers missed persistence from the native snapshot without an active stream", async () => {
		await using dir = await TempDir.create("@journal-events-reconnect-");
		const manager = SessionManager.create(dir.path(), dir.path(), new MemorySessionStorage());
		await manager.ensureOnDisk();
		const message = makeAssistantMessage();
		observeLiveMessageId(manager, message);
		const first = transport(manager, message);
		const start = first.frames.find(frame => frame.type === "message_start");
		if (!start || start.type !== "message_start") throw new Error("missing live assistant snapshot");
		first.forwarder.dispose();

		// The native owner continues while every transport is detached.
		const completed = { ...message, content: [{ type: "text" as const, text: "completed while disconnected" }] };
		observeLiveMessageId(manager, completed, true);
		const entryId = manager.appendMessage(completed);
		await manager.flush();
		expect(first.frames.some(frame => frame.type === "message_persisted")).toBe(false);
		expect(manager.getEntry(entryId)).toMatchObject({ id: entryId, message: completed });

		const reattached = transport(manager);
		const expected = {
			type: "journal_state",
			reason: "snapshot",
			...manager.getJournalIdentity(),
			messageEntryIds: [{ messageId: start.messageId, entryId }],
		} satisfies RpcProjectedSessionEventFrame;
		expect(reattached.frames).toEqual([expected]);
		reattached.forwarder.snapshotJournal(reattached.source);
		expect(reattached.frames).toEqual([expected, expected]);
		reattached.forwarder.dispose();
		await manager.close();
	});

	test("reopening the same journal in a new native owner cannot rebind a cached live message ID", async () => {
		await using dir = await TempDir.create("@journal-events-incarnation-");
		const storage = new MemorySessionStorage();
		const before = SessionManager.create(dir.path(), dir.path(), storage);
		await before.ensureOnDisk();
		const firstMessage = makeAssistantMessage();
		const beforeId = observeLiveMessageId(before, firstMessage);
		const firstObserver = transport(before, firstMessage);
		const peerObserver = transport(before, firstMessage);
		for (const observer of [firstObserver, peerObserver]) {
			expect(observer.frames.find(frame => frame.type === "message_start")).toMatchObject({ messageId: beforeId });
			observer.forwarder.dispose();
		}
		observeLiveMessageId(before, firstMessage, true);
		const beforeEntry = before.appendMessage(firstMessage);
		await before.flush();
		const identity = before.getJournalIdentity();
		if (!identity.sessionFile) throw new Error("missing durable session file");
		await before.close();

		const after = await SessionManager.open(identity.sessionFile, dir.path(), storage, { suppressBreadcrumb: true });
		expect(after.getJournalIdentity()).toEqual(identity);
		const secondMessage = makeAssistantMessage();
		secondMessage.content = [{ type: "text", text: "different output after restart" }];
		const afterId = observeLiveMessageId(after, secondMessage);
		expect(afterId).not.toBe(beforeId);
		const observer = transport(after, secondMessage);
		expect(observer.frames.find(frame => frame.type === "message_start")).toMatchObject({ messageId: afterId });
		observeLiveMessageId(after, secondMessage, true);
		observer.source.agent.state.streamMessage = null;
		observer.forwarder.forward({ type: "message_end", message: secondMessage });
		const afterEntry = after.appendMessage(secondMessage);
		observer.settle(secondMessage);
		await after.flush();
		expect(afterEntry).not.toBe(beforeEntry);
		observer.forwarder.snapshotJournal(observer.source);
		expect(observer.frames.at(-1)).toMatchObject({
			type: "journal_state",
			reason: "snapshot",
			messageEntryIds: [{ messageId: afterId, entryId: afterEntry }],
		});
		expect(firstObserver.frames.some(frame => frame.type === "message_persisted")).toBe(false);
		observer.forwarder.dispose();
		await after.close();
	});

	test("recovery waits for queued durability even when the observer that ended the message is gone", async () => {
		await using dir = await TempDir.create("@journal-events-reconnect-queued-");
		const storage = new GatedStorage();
		const manager = SessionManager.create(dir.path(), dir.path(), storage);
		await manager.ensureOnDisk();
		const message = makeAssistantMessage();
		const messageId = observeLiveMessageId(manager, message);
		const first = transport(manager);
		first.forwarder.forward({ type: "message_start", message });
		first.forwarder.forward({ type: "message_end", message });
		first.forwarder.dispose();
		const entryId = manager.appendMessage(message);
		const reattached = transport(manager);
		expect(reattached.frames.at(-1)).toMatchObject({ messageEntryIds: [] });
		storage.publish.resolve();
		await manager.flush();
		reattached.forwarder.snapshotJournal(reattached.source);
		expect(reattached.frames.at(-1)).toMatchObject({
			type: "journal_state",
			reason: "snapshot",
			messageEntryIds: [{ messageId, entryId }],
		});
		reattached.forwarder.dispose();
		await manager.close();
	});

	test("recovery bounds ID-only history and clears it on owner replacement but not branch navigation", async () => {
		await using dir = await TempDir.create("@journal-events-recovery-limit-");
		const manager = SessionManager.create(dir.path(), dir.path(), new MemorySessionStorage());
		await manager.ensureOnDisk();
		const pairs: Array<{ messageId: string; entryId: string }> = [];
		let oldest: AgentMessage | undefined;
		for (let index = 0; index < MESSAGE_ENTRY_IDENTITY_LIMIT + 2; index++) {
			const message = makeAssistantMessage();
			oldest ??= message;
			const messageId = observeLiveMessageId(manager, message, true);
			pairs.push({ messageId, entryId: manager.appendMessage(message) });
		}
		await manager.flush();
		const live = transport(manager);
		expect(live.frames.at(-1)).toMatchObject({ messageEntryIds: pairs.slice(2) });
		manager.branch(pairs[0].entryId);
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.at(-1)).toMatchObject({ messageEntryIds: pairs.slice(2) });
		await manager.newSession();
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.at(-1)).toMatchObject({ messageEntryIds: [] });
		// A late write belonging to the abandoned owner cannot repopulate its replacement.
		if (!oldest) throw new Error("missing old message");
		setMessageEntryId(oldest, pairs[0].entryId);
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.at(-1)).toMatchObject({ messageEntryIds: [] });
		live.forwarder.dispose();
		await manager.close();
	});

	test("an observer attached after message start binds a display clone only after its queued append confirms", async () => {
		await using dir = await TempDir.create("@journal-events-deferred-");
		const storage = new GatedStorage();
		const manager = SessionManager.create(dir.path(), dir.path(), storage);
		await manager.ensureOnDisk();
		const live = transport(manager);
		const message = makeAssistantMessage();
		const messageId = observeLiveMessageId(manager, message, true);
		const display = { ...message, content: [{ type: "text" as const, text: "display-only secret" }] };
		linkMessageEntrySource(display, message);
		live.forwarder.forward({ type: "message_end", message: display });
		const entryId = manager.appendMessage(message);
		live.settle(message);
		expect(manager.isEntryDurable(entryId)).toBe(false);
		expect(live.frames.some(frame => frame.type === "journal_entry" || frame.type === "message_persisted")).toBe(
			false,
		);
		storage.publish.resolve();
		await manager.flush();
		expect(live.frames.filter(frame => frame.type === "message_persisted")).toEqual([
			{ type: "message_persisted", ...manager.getJournalIdentity(), messageId, entryId },
		]);
		live.forwarder.dispose();
		await manager.close();
	});

	test("quiet live snapshots and repeat reads retain one native stream ID through updates and durability", async () => {
		await using dir = await TempDir.create("@journal-events-quiet-");
		const manager = SessionManager.create(dir.path(), dir.path(), new MemorySessionStorage());
		await manager.ensureOnDisk();
		const partial = makeAssistantMessage();
		partial.content = [{ type: "text", text: "quiet partial" }];
		const live = transport(manager, partial);
		const first = live.frames.find(frame => frame.type === "message_start");
		if (!first) throw new Error("missing live assistant snapshot");
		const messageId = first.messageId;
		expect(first).toMatchObject({
			type: "message_start",
			snapshot: true,
			messageId: expect.any(String),
			message: partial,
			...manager.getJournalIdentity(),
		});
		expect(first && "entryId" in first).toBe(false);
		live.forwarder.snapshotJournal(live.source);
		expect(live.frames.filter(frame => frame.type === "message_start")).toHaveLength(2);
		const updated = { ...partial, content: [{ type: "text" as const, text: "quiet partial, continued" }] };
		live.source.agent.state.streamMessage = updated;
		live.forwarder.forward({
			type: "message_update",
			message: updated,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ", continued", partial: updated },
		});
		const beforeDelayedStart = live.frames.length;
		live.forwarder.forward({ type: "message_start", message: partial });
		expect(live.frames).toHaveLength(beforeDelayedStart);
		live.source.agent.state.streamMessage = null;
		live.forwarder.forward({ type: "message_end", message: updated });
		const entryId = manager.appendMessage(updated);
		live.settle(updated);
		expect(
			live.frames
				.filter(
					frame =>
						frame.type === "message_start" ||
						frame.type === "message_update" ||
						frame.type === "message_end" ||
						frame.type === "message_persisted",
				)
				.map(frame => ("messageId" in frame ? frame.messageId : undefined)),
		).toEqual([messageId, messageId, messageId, messageId, messageId]);
		expect(live.frames.at(-1)).toMatchObject({ type: "message_persisted", entryId });
		live.forwarder.dispose();
		await manager.close();
	});

	test("a newer update or end during identity snapshot publication prevents an older assistant snapshot", async () => {
		for (const end of [false, true]) {
			const manager = SessionManager.inMemory();
			const partial = makeAssistantMessage();
			const newer = { ...partial, content: [{ type: "text" as const, text: "newer output" }] };
			const source = {
				sessionManager: manager,
				agent: { state: { streamMessage: partial as AgentMessage | null } },
				isSessionTransitioning: false,
				obfuscator: undefined,
				subscribeMessagePersistenceSettled: () => () => {},
			};
			const frames: RpcProjectedSessionEventFrame[] = [];
			let interleave = true;
			const forwarder = new RpcSessionEventForwarder(frame => {
				frames.push(frame);
				if (frame.type !== "journal_state" || frame.reason !== "snapshot" || !interleave) return;
				interleave = false;
				source.agent.state.streamMessage = end ? null : newer;
				forwarder.forward(
					end
						? { type: "message_end", message: newer }
						: {
								type: "message_update",
								message: newer,
								assistantMessageEvent: {
									type: "text_delta",
									contentIndex: 0,
									delta: "newer output",
									partial: newer,
								},
							},
				);
			});
			forwarder.observeJournal(source);
			expect(frames.some(frame => frame.type === "message_start")).toBe(false);
			expect(frames.at(-1)).toMatchObject({ type: end ? "message_end" : "message_update", message: newer });
			forwarder.dispose();
			await manager.close();
		}
	});

	test("a native owner replacement during snapshot publication never attaches the old assistant", async () => {
		await using dir = await TempDir.create("@journal-events-snapshot-owner-");
		const manager = SessionManager.create(dir.path(), dir.path(), new MemorySessionStorage());
		const root = manager.appendCustomEntry("root");
		await manager.ensureOnDisk();
		const before = manager.getSessionId();
		const oldAssistant = makeAssistantMessage();
		const source = {
			sessionManager: manager,
			agent: { state: { streamMessage: oldAssistant as AgentMessage | null } },
			isSessionTransitioning: false,
			obfuscator: undefined,
			subscribeMessagePersistenceSettled: () => () => {},
		};
		const frames: RpcProjectedSessionEventFrame[] = [];
		let replace = true;
		const forwarder = new RpcSessionEventForwarder(frame => {
			frames.push(frame);
			if (frame.type !== "journal_state" || frame.reason !== "snapshot" || !replace) return;
			replace = false;
			manager.createBranchedSession(root);
			source.agent.state.streamMessage = null;
		});
		forwarder.observeJournal(source);
		expect(manager.getSessionId()).not.toBe(before);
		expect(frames.some(frame => frame.type === "message_start")).toBe(false);
		expect(frames).toContainEqual({ type: "journal_state", reason: "identity", ...manager.getJournalIdentity() });
		forwarder.snapshotJournal(source);
		expect(frames.some(frame => frame.type === "message_start")).toBe(false);
		forwarder.dispose();
		await manager.close();
	});

	test("large canonical entries retain their full contents through existing v2 chunking", async () => {
		await using dir = await TempDir.create("@journal-events-large-");
		const manager = SessionManager.create(dir.path(), dir.path(), new MemorySessionStorage());
		await manager.ensureOnDisk();
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const decoder = new RpcFrameDecoder();
		const events: object[] = [];
		const unsubscribe = manager.subscribeJournal(event => {
			for (const line of encoder.encodeFrames(event)) {
				const decoded = decoder.push(JSON.parse(line));
				if (decoded) events.push(decoded);
			}
		});
		const text = "λ".repeat(800_000);
		const id = manager.appendCustomEntry("complete", { text });
		expect(events).toContainEqual({
			type: "journal_entry",
			...manager.getJournalIdentity(),
			entry: manager.getEntry(id),
		});
		unsubscribe();
		await manager.close();
	});
});
