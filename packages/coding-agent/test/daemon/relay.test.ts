import { describe, expect, it } from "bun:test";
import { type RelayViewer, SessionRelay } from "../../src/daemon/relay";

type Frame = Record<string, unknown>;

/** A relay wired to a scripted child: `toChild` records what the relay wrote. */
function harness() {
	const toChild: Frame[] = [];
	const relay = new SessionRelay(frame => toChild.push(frame));
	const viewer = (id: string) => {
		const frames: Frame[] = [];
		const versions: number[] = [];
		const v: RelayViewer = { id, send: f => frames.push(f), setProtocolVersion: n => versions.push(n) };
		return { v, frames, versions };
	};
	/** Answer the head snapshot request the way rpc-ui does: marker frames in-stream, then the response. */
	const answerSnapshot = (inFlight?: Frame) => {
		const request = toChild.findLast(f => f.type === "snapshot_session_journal");
		if (!request) throw new Error("no snapshot requested");
		relay.fromChild({ type: "journal_state", reason: "snapshot", leafId: "L" });
		if (inFlight) relay.fromChild({ type: "message_start", snapshot: true, message: inFlight });
		relay.fromChild({ type: "response", id: request.id, command: "snapshot_session_journal", success: true, data: { leafId: "L" } });
	};
	const attach = (v: RelayViewer, inFlight?: Frame) => {
		relay.attach(v);
		answerSnapshot(inFlight);
	};
	return { relay, toChild, viewer, attach, answerSnapshot };
}

const ev = (n: number): Frame => ({ type: "message_update", n });

describe("SessionRelay", () => {
	it("late attach mid multi-message turn: exact cut, no gap, no duplicate, existing viewer untouched", () => {
		const h = harness();
		const a = h.viewer("A");
		h.attach(a.v);
		h.relay.fromChild({ type: "agent_start" });
		h.relay.fromChild({ type: "message_start", id: "m1" });
		h.relay.fromChild({ type: "message_end", id: "m1" });
		h.relay.fromChild({ type: "message_start", id: "m2" });
		h.relay.fromChild(ev(1));

		const b = h.viewer("B");
		h.relay.attach(b.v);
		// Frames emitted while the snapshot request is in flight but before the child handled it.
		h.relay.fromChild(ev(2));
		h.answerSnapshot({ id: "m2", partial: true });
		h.relay.fromChild(ev(3));
		h.relay.fromChild({ type: "agent_end" });

		const types = (fs: Frame[]) => fs.map(f => (f.type === "message_update" ? `u${f.n}` : String(f.type)));
		// B: history comes from the snapshot (m1 is in the journal; m2 resumes from the snapshot message_start).
		expect(types(b.frames)).toEqual(["journal_state", "message_start", "response", "u3", "agent_end"]);
		expect(b.frames[1]).toMatchObject({ snapshot: true });
		// A: the live stream only; no snapshot frames from B's attach.
		expect(types(a.frames).slice(2)).toEqual(["agent_start", "message_start", "message_end", "message_start", "u1", "u2", "u3", "agent_end"]);
	});

	it("routes concurrent requests with colliding client ids to their askers only", () => {
		const h = harness();
		const a = h.viewer("A");
		const b = h.viewer("B");
		h.attach(a.v);
		h.attach(b.v);
		h.relay.fromViewer("A", { type: "get_state", id: "1" });
		h.relay.fromViewer("B", { type: "get_state", id: "1" });
		const [toA, toB] = h.toChild.filter(f => f.type === "get_state");
		expect(toA!.id).not.toBe(toB!.id);
		// Answer out of order.
		h.relay.fromChild({ type: "response", id: toB!.id, command: "get_state", success: true, data: "for-B" });
		h.relay.fromChild({ type: "response", id: toA!.id, command: "get_state", success: true, data: "for-A" });
		const responses = (fs: Frame[]) => fs.filter(f => f.type === "response" && f.command === "get_state");
		expect(responses(a.frames)).toEqual([{ type: "response", id: "1", command: "get_state", success: true, data: "for-A" }]);
		expect(responses(b.frames)).toEqual([{ type: "response", id: "1", command: "get_state", success: true, data: "for-B" }]);
	});

	it("drops a response whose asker detached instead of broadcasting it", () => {
		const h = harness();
		const a = h.viewer("A");
		const b = h.viewer("B");
		h.attach(a.v);
		h.attach(b.v);
		h.relay.fromViewer("A", { type: "get_state", id: "x" });
		const routed = h.toChild.findLast(f => f.type === "get_state")!;
		h.relay.detach("A");
		h.relay.fromChild({ type: "response", id: routed.id, command: "get_state", success: true });
		expect(b.frames.some(f => f.command === "get_state")).toBe(false);
	});

	it("first answer settles a dialog once; the second gets already_answered; others see the protocol cancel", () => {
		const h = harness();
		const a = h.viewer("A");
		const b = h.viewer("B");
		h.attach(a.v);
		h.attach(b.v);
		h.relay.fromChild({ type: "extension_ui_request", id: "d1", method: "confirm", title: "ok?" });
		expect(h.relay.pendingInteractions).toBe(1);
		h.relay.fromViewer("B", { type: "extension_ui_response", id: "d1", confirmed: true });
		h.relay.fromViewer("A", { type: "extension_ui_response", id: "d1", confirmed: false });
		expect(h.toChild.filter(f => f.type === "extension_ui_response")).toEqual([
			{ type: "extension_ui_response", id: "d1", confirmed: true },
		]);
		expect(a.frames).toContainEqual(expect.objectContaining({ type: "extension_ui_request", method: "cancel", targetId: "d1" }));
		expect(a.frames).toContainEqual(expect.objectContaining({ type: "response", code: "already_answered", id: "d1" }));
		expect(b.frames.some(f => f.method === "cancel")).toBe(false);
		expect(h.relay.pendingInteractions).toBe(0);
	});

	it("tool approvals and plan proposals close for the other viewers with their own cancel frames", () => {
		const h = harness();
		const a = h.viewer("A");
		const b = h.viewer("B");
		h.attach(a.v);
		h.attach(b.v);
		h.relay.fromChild({ type: "tool_approval_request", id: "t1", toolName: "bash" });
		h.relay.fromChild({ type: "plan_proposal_request", id: "p1" });
		h.relay.fromViewer("A", { type: "tool_approval_response", id: "t1", decision: "approve" });
		h.relay.fromViewer("B", { type: "plan_proposal_response", id: "p1", decision: "approve" });
		expect(b.frames).toContainEqual(expect.objectContaining({ type: "tool_approval_cancel", targetId: "t1" }));
		expect(a.frames).toContainEqual(expect.objectContaining({ type: "plan_proposal_cancel", id: "p1" }));
		// A child-side cancel clears the pending interaction too.
		h.relay.fromChild({ type: "tool_approval_request", id: "t2" });
		h.relay.fromChild({ type: "tool_approval_cancel", id: "c", targetId: "t2" });
		expect(h.relay.pendingInteractions).toBe(0);
	});

	it("a late attacher sees interactions still open and can answer them", () => {
		const h = harness();
		const a = h.viewer("A");
		h.attach(a.v);
		h.relay.fromChild({ type: "extension_ui_request", id: "d1", method: "select", options: ["x"] });
		const b = h.viewer("B");
		h.attach(b.v);
		expect(b.frames).toContainEqual(expect.objectContaining({ id: "d1", method: "select" }));
		h.relay.fromViewer("B", { type: "extension_ui_response", id: "d1", value: "x" });
		expect(h.toChild).toContainEqual({ type: "extension_ui_response", id: "d1", value: "x" });
	});

	it("detach and reattach during a stream loses nothing between the cut and the live tail", () => {
		const h = harness();
		const a = h.viewer("A");
		h.attach(a.v);
		h.relay.fromChild({ type: "agent_start" });
		h.relay.fromChild(ev(1));
		h.relay.detach("A");
		h.relay.fromChild(ev(2)); // nobody attached: lands in the journal/in-flight message only
		const a2 = h.viewer("A2");
		h.relay.attach(a2.v);
		h.answerSnapshot({ id: "m", text: "u1u2" });
		h.relay.fromChild(ev(3));
		h.relay.fromChild({ type: "agent_end" });
		expect(a2.frames.map(f => f.type)).toEqual(["journal_state", "message_start", "response", "message_update", "agent_end"]);
		expect(a2.frames[1]).toMatchObject({ message: { text: "u1u2" } });
		expect(h.relay.streaming).toBe(false);
	});

	it("a viewer that disconnects before its snapshot completes never joins the broadcast set", () => {
		const h = harness();
		const a = h.viewer("A");
		h.relay.attach(a.v);
		h.relay.detach("A");
		const b = h.viewer("B");
		h.relay.attach(b.v);
		h.answerSnapshot(); // A's snapshot (head) completes and is discarded
		h.answerSnapshot(); // B's
		h.relay.fromChild(ev(1));
		expect(a.frames).toEqual([]);
		expect(h.relay.viewerCount).toBe(1);
		expect(b.frames.at(-1)).toMatchObject({ type: "message_update", n: 1 });
	});

	it("answers protocol negotiation per viewer before the attach completes and delivers ready to attachers", () => {
		const h = harness();
		const a = h.viewer("A");
		h.relay.attach(a.v); // attached before the child is ready
		h.relay.fromChild({ type: "ready", supportedProtocolVersions: [1, 2] });
		h.relay.fromViewer("A", { type: "negotiate_protocol", protocolVersion: 2, id: "n" });
		expect(a.frames[0]).toMatchObject({ type: "ready" });
		expect(a.frames).toContainEqual({ type: "response", command: "negotiate_protocol", id: "n", success: true, data: { protocolVersion: 2 } });
		expect(a.versions).toEqual([2]);
		expect(h.toChild.some(f => f.type === "negotiate_protocol")).toBe(false);
	});

	it("routes host tool calls to the registering viewer and withdraws its tools on detach", () => {
		const h = harness();
		const a = h.viewer("A");
		const b = h.viewer("B");
		h.attach(a.v);
		h.attach(b.v);
		h.relay.fromViewer("A", { type: "set_host_tools", id: "1", tools: [{ name: "t" }] });
		h.relay.fromChild({ type: "host_tool_call", id: "h1", toolName: "t" });
		expect(a.frames.some(f => f.type === "host_tool_call")).toBe(true);
		expect(b.frames.some(f => f.type === "host_tool_call")).toBe(false);
		h.relay.fromViewer("A", { type: "host_tool_result", id: "h1", result: {} });
		expect(h.toChild.at(-1)).toEqual({ type: "host_tool_result", id: "h1", result: {} });
		h.relay.detach("A");
		expect(h.toChild.at(-1)).toMatchObject({ type: "set_host_tools", tools: [] });
	});
});
