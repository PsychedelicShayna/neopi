import { describe, expect, it } from "bun:test";
import { RemoteAgentSession, type RemoteTransport } from "../../src/daemon/remote-session";

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
		const attaching = RemoteAgentSession.attach(t, "s1");
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
		const attaching = RemoteAgentSession.attach(t, "s1");
		await answer("daemon.attach", {});
		emit({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: {} });
		emit({ type: "tool_execution_update", toolCallId: "t9", toolName: "bash", args: {}, partialResult: "x" });
		await answer("get_state", { sessionId: "s1", isStreaming: true });
		await answer("get_messages", { messages: [] });
		const session = await attaching;
		expect(session.runningTools).toEqual([{ toolCallId: "t9", toolName: "bash", args: {}, partialResult: "x" }]);
		expect(session.isStreaming).toBe(true);
	});

	it("an event decoded in the same batch right after the get_messages response is live, not dropped", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1");
		await answer("daemon.attach", {});
		await answer("get_state", { sessionId: "s1", isStreaming: true });
		emit({ type: "message_start", messageId: "m3", message: { role: "assistant", content: [] } });
		// No microtask can run between the response callback and the following event.
		await answer("get_messages", { messages: [user] }, () => {
			emit({ type: "message_end", messageId: "m3", message: done });
		});
		const session = await attaching;
		expect(session.messages).toEqual([user, done]);
		const seen: string[] = [];
		session.subscribe(e => seen.push(e.type));
		expect(seen).toEqual(["message_start", "message_end"]);
	});

	it("keeps a streaming event decoded immediately after a state response", async () => {
		const { t, emit, answer } = transport();
		const attaching = RemoteAgentSession.attach(t, "s1");
		await answer("daemon.attach", {});
		await answer("get_messages", { messages: [] });
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
