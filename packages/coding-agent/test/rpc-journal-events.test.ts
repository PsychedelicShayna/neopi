import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";
import { RpcSessionEventForwarder } from "../src/modes/rpc/rpc-session-events";
import type { RpcProjectedSessionEventFrame } from "../src/modes/rpc/rpc-types";
import type { SessionJournalEvent } from "../src/session/session-journal-events";
import { SessionManager } from "../src/session/session-manager";
import { linkMessageEntrySource } from "../src/session/message-entry-ids";
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
		live.forwarder.forward({ type: "message_start", message });
		live.forwarder.forward({ type: "message_end", message });
		storage.refuse = true;
		const entryId = manager.appendMessage(message);
		live.settle(message);
		expect(live.frames.some(frame => frame.type === "message_persisted")).toBe(false);
		storage.refuse = false;
		await manager.recoverPersistenceFromCurrentState();
		expect(live.frames.filter(frame => frame.type === "message_persisted")).toEqual([
			{ type: "message_persisted", ...manager.getJournalIdentity(), messageId: "msg-1", entryId },
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

	test("an observer attached after message start binds a display clone only after its queued append confirms", async () => {
		await using dir = await TempDir.create("@journal-events-deferred-");
		const storage = new GatedStorage();
		const manager = SessionManager.create(dir.path(), dir.path(), storage);
		await manager.ensureOnDisk();
		const live = transport(manager);
		const message = makeAssistantMessage();
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
			{ type: "message_persisted", ...manager.getJournalIdentity(), messageId: "msg-1", entryId },
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
		expect(first).toMatchObject({
			type: "message_start",
			snapshot: true,
			messageId: "msg-1",
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
		).toEqual(["msg-1", "msg-1", "msg-1", "msg-1", "msg-1"]);
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
