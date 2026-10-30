import { describe, expect, it } from "bun:test";
import { RemoteAgentSession, type RemoteTransport } from "../../src/daemon/remote-session";
import type { SessionEntry } from "../../src/session/session-entries";

type Frame = Record<string, unknown>;

/** A transport whose responses are released by the test, so frames can land on either side of them. */
function transport() {
	let listener: (frame: Frame) => void = () => {};
	const pending = new Map<string, (data: unknown) => void>();
	const t: RemoteTransport = {
		// Like SessionDaemonClient: onResponse runs synchronously at the response, the promise settles later.
		request: (frame, onResponse) => {
			const response = Promise.withResolvers<unknown>();
			pending.set(String(frame.type), data => {
				onResponse?.(data);
				response.resolve(data);
			});
			return response.promise;
		},
		send: () => {},
		onFrame: l => {
			listener = l;
			return () => {};
		},
		detach: async () => {},
	};
	const answer = async (type: string, data: unknown, afterResponse?: () => void) => {
		while (!pending.has(type)) await Bun.sleep(1);
		pending.get(type)!(data);
		pending.delete(type);
		afterResponse?.();
	};
	return { t, emit: (f: Frame) => listener(f), answer };
}

const user = { role: "user", content: "hi" };
const done = { role: "assistant", content: [{ type: "text", text: "done" }] };

describe("RemoteAgentSession attach cut", () => {
	it("each message and tool event lands once across the get_messages boundary", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		await answer("daemon.attach", {});
		// Before the cut: m1 completes (it is in history), tool t1 completes, t2 and m2 stay open, an approval is pending.
		emit({ type: "message_start", messageId: "m1", message: done });
		emit({ type: "message_end", messageId: "m1", message: done });
		emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {} });
		emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } });
		emit({ type: "tool_approval_request", id: "a1", toolName: "bash" });
		emit({ type: "message_start", messageId: "m2", message: { role: "assistant", content: [] } });
		emit({ type: "message_update", messageId: "m2", message: { role: "assistant", content: [{ type: "text", text: "pa" }] } });
		await answer("get_state", { sessionId: "s1", isStreaming: true });
		await answer("get_messages", { messages: [user, done] });
		await answer("get_entries", { entries: [], leafId: null });
		const session = await attaching;
		// After the cut: m2 finishes, t2 finishes.
		emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: {} });
		emit({ type: "message_end", messageId: "m2", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });

		expect(session.messages).toHaveLength(3);
		expect(session.runningTools).toEqual([]);
		const seen: string[] = [];
		session.subscribe(e => seen.push(`${e.type}:${String((e as Frame).messageId ?? (e as Frame).toolCallId ?? (e as Frame).id)}`));
		expect(seen).toEqual([
			"tool_execution_start:t2",
			"tool_approval_request:a1",
			"message_start:m2",
			"message_update:m2",
			"tool_execution_end:t2",
			"message_end:m2",
		]);
	});

	it("tracks a tool still running at the cut", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		await answer("daemon.attach", {});
		emit({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: {} });
		emit({ type: "tool_execution_update", toolCallId: "t9", toolName: "bash", args: {}, partialResult: "x" });
		await answer("get_state", { sessionId: "s1", isStreaming: true });
		await answer("get_messages", { messages: [] });
		await answer("get_entries", { entries: [], leafId: null });
		const session = await attaching;
		expect(session.runningTools).toEqual([{ toolCallId: "t9", toolName: "bash", args: {}, partialResult: "x" }]);
		expect(session.isStreaming).toBe(true);
	});

	it("an event decoded in the same batch right after the get_messages response is live, not dropped", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		await answer("daemon.attach", {});
		await answer("get_state", { sessionId: "s1", isStreaming: true });
		emit({ type: "message_start", messageId: "m3", message: { role: "assistant", content: [] } });
		// No microtask can run between the response callback and the following event.
		await answer("get_messages", { messages: [user] }, () => {
			emit({ type: "message_end", messageId: "m3", message: done });
		});
		await answer("get_entries", { entries: [], leafId: null });
		const session = await attaching;
		expect(session.messages).toEqual([user, done]);
		const seen: string[] = [];
		session.subscribe(e => seen.push(e.type));
		expect(seen).toEqual(["message_start", "message_end"]);
	});

	it("keeps a streaming event decoded immediately after a state response", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		await answer("daemon.attach", {});
		await answer("get_messages", { messages: [] });
		await answer("get_entries", { entries: [], leafId: null });
		await answer("get_state", { sessionId: "s1", isStreaming: false }, () => {
			emit({ type: "agent_start" });
		});
		const session = await attaching;
		expect(session.isStreaming).toBe(true);
		const refreshing = session.refreshState();
		await answer("get_state", { sessionId: "s1", isStreaming: true }, () => {
			emit({ type: "agent_end" });
		});
		await refreshing;
		expect(session.isStreaming).toBe(false);
	});
});

const timestamp = "2026-10-30T00:00:00.000Z";

function userEntry(id: string, parentId: string | null, content: string): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content, timestamp: 1 } };
}

describe("RemoteAgentSession native transcript", () => {
	it("follows the selected journal branch and compaction rather than flattened get_messages", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		const root = userEntry("root", null, "before compaction");
		const discarded = userEntry("discarded", "root", "other branch");
		const compaction: SessionEntry = {
			type: "compaction",
			id: "compact",
			parentId: "root",
			timestamp,
			summary: "Earlier work summarized",
			firstKeptEntryId: "",
			tokensBefore: 100,
		};
		const branchSummary: SessionEntry = {
			type: "branch_summary", id: "branch", parentId: "compact", timestamp,
			fromId: "discarded", summary: "Other branch findings",
		};
		const tail = userEntry("tail", "branch", "after compaction");
		emit({ type: "journal_state", reason: "snapshot", sessionId: "s1", sessionFile: "/remote/s1.jsonl", leafId: "tail" });
		await answer("daemon.attach", {});
		await answer("get_state", { sessionId: "s1", isStreaming: false });
		await answer("get_messages", { messages: [user] });
		await answer("get_entries", { entries: [root, discarded, compaction, branchSummary, tail], leafId: "tail" });
		const session = await attaching;

		expect(session.sessionManager.getCwd()).toBe("/remote/project");
		expect(session.sessionManager.getSessionId()).toBe("s1");
		expect(session.sessionManager.getSessionFile()).toBe("/remote/s1.jsonl");
		const full = session.buildTranscriptSessionContext();
		expect(full.messages.some(message => message.role === "user" && message.content === "before compaction")).toBe(true);
		expect(full.messages.some(message => message.role === "user" && message.content === "other branch")).toBe(false);
		expect(full.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(full.messages.some(message => message.role === "branchSummary" && message.summary === "Other branch findings")).toBe(true);
		const collapsed = session.buildTranscriptSessionContext({ collapseCompactedHistory: true });
		expect(collapsed.messages.some(message => message.role === "user" && message.content === "before compaction")).toBe(false);
		expect(collapsed.messages.some(message => message.role === "user" && message.content === "after compaction")).toBe(true);

		emit({ type: "journal_state", reason: "leaf", sessionId: "s1", sessionFile: "/remote/s1.jsonl", leafId: "discarded" });
		expect(session.buildTranscriptSessionContext().messages.map(message => message.content)).toEqual([
			"before compaction",
			"other branch",
		]);
		emit({ type: "journal_state", reason: "leaf", sessionId: "s1", sessionFile: "/remote/s1.jsonl", leafId: null });
		expect(session.buildTranscriptSessionContext().messages).toEqual([]);
	});

	it("cuts journal entries synchronously and follows live append without replaying old leaf state", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		const root = userEntry("root", null, "first");
		const next = userEntry("next", "root", "second");
		emit({ type: "journal_state", reason: "snapshot", sessionId: "s1", sessionFile: null, leafId: null });
		await answer("daemon.attach", {});
		await answer("get_state", { sessionId: "s1", isStreaming: false });
		emit({ type: "journal_entry", sessionId: "s1", sessionFile: null, leafId: "root", entry: root });
		await answer("get_entries", { entries: [root], leafId: "root" }, () => {
			emit({ type: "journal_entry", sessionId: "s1", sessionFile: null, leafId: "next", entry: next });
		});
		// Making the message cut later must not reapply the old journal snapshot/entry.
		await answer("get_messages", { messages: [] });
		const session = await attaching;
		expect(session.sessionManager.getEntries()).toEqual([root, next]);
		expect(session.buildTranscriptSessionContext().messages.map(message => message.content)).toEqual(["first", "second"]);
		// Repeated persistence notifications do not duplicate the native journal.
		emit({ type: "journal_entry", sessionId: "s1", sessionFile: null, leafId: "next", entry: next });
		expect(session.sessionManager.getEntries()).toHaveLength(2);
	});

	it("retains native snapshot tools, partial updates and live stream state across attach", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1", "/remote/project");
		const root = userEntry("root", null, "run it");
		const toolMessage: SessionEntry = {
			type: "message",
			id: "assistant",
			parentId: "root",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		};
		emit({ type: "journal_state", reason: "snapshot", sessionId: "s1", sessionFile: null, leafId: "assistant" });
		emit({ type: "tool_execution_start", snapshot: true, toolCallId: "call-1", toolName: "bash", args: { command: "sleep 60" } });
		const update = {
			type: "tool_execution_update", snapshot: true, toolCallId: "call-1",
			toolName: "bash", args: { command: "sleep 60" }, partialResult: { content: [{ type: "text", text: "waiting" }] },
		};
		emit(update);
		emit({ type: "message_start", snapshot: true, messageId: "live", message: done });
		await answer("daemon.attach", {});
		await answer("get_state", { sessionId: "s1", isStreaming: true });
		await answer("get_entries", { entries: [root, toolMessage], leafId: "assistant" });
		await answer("get_messages", { messages: [toolMessage.message] });
		const session = await attaching;
		expect(session.streamMessage).toEqual(done);
		expect(session.runningTools).toEqual([{
			toolCallId: "call-1", toolName: "bash", args: { command: "sleep 60" }, partialResult: update.partialResult,
		}]);
		expect(session.activeToolExecutionUpdates()).toEqual([update]);
		const live = session.buildTranscriptSessionContext({ keepInFlightToolCalls: true });
		expect(live.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === "call-1"))).toBe(true);
		const seen: string[] = [];
		session.subscribe(event => seen.push(event.type));
		expect(seen).toEqual(["journal_state", "tool_execution_start", "tool_execution_update", "message_start"]);
		emit({ type: "message_update", messageId: "live", message: { ...done, content: [{ type: "text", text: "new content" }] } });
		expect(session.streamMessage?.content).toEqual([{ type: "text", text: "new content" }]);
		emit({ type: "message_end", messageId: "steered-user", message: user });
		expect(session.streamMessage?.content).toEqual([{ type: "text", text: "new content" }]);
		emit({ type: "message_end", messageId: "live", message: done });
		expect(session.streamMessage).toBeUndefined();
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {} });
		expect(session.runningTools).toEqual([]);
		expect(session.activeToolExecutionUpdates()).toEqual([]);
		expect(session).not.toHaveProperty("hasBuiltInTool");
		expect(session).not.toHaveProperty("getToolByName");
		expect(session.sessionManager).not.toHaveProperty("putBlobSync");
	});
});
