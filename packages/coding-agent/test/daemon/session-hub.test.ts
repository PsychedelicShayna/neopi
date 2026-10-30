import { describe, expect, it } from "bun:test";
import { FrameSessionModel } from "../../src/daemon/attach-view";
import type { HostedSessionInfo } from "../../src/daemon/server";
import { type HubChoice, SessionHubList } from "../../src/daemon/session-hub";

const row = (id: string, status: HostedSessionInfo["status"] = "idle"): HostedSessionInfo => ({
	id,
	pid: 1,
	cwd: "/w",
	title: `t-${id}`,
	model: "mock/m1",
	status,
	viewers: 0,
	createdAt: 0,
	lastActivity: Date.now(),
	sessionFile: null,
});

describe("SessionHubList", () => {
	it("moves with arrows and vim keys, attaches with enter, creates with n, quits with q and esc", () => {
		const choices: HubChoice[] = [];
		const list = new SessionHubList(c => choices.push(c), () => {});
		list.setSessions([row("a"), row("b"), row("c")]);
		list.handleInput("j");
		list.handleInput("\x1b[B");
		list.handleInput("k");
		list.handleInput("\r");
		list.handleInput("n");
		list.handleInput("q");
		list.handleInput("\x1b");
		expect(choices).toEqual([{ kind: "attach", sessionId: "b" }, { kind: "new" }, { kind: "quit" }, { kind: "quit" }]);
	});

	it("keeps the selected session selected when the list refreshes in a new order", () => {
		const list = new SessionHubList(() => {}, () => {});
		list.setSessions([row("a"), row("b")]);
		list.handleInput("j");
		list.setSessions([row("c"), row("a"), row("b")]);
		expect(list.sessions[list.selected]!.id).toBe("b");
	});

	it("does not attach to an exited session", () => {
		const choices: HubChoice[] = [];
		const list = new SessionHubList(c => choices.push(c), () => {});
		list.setSessions([row("a", "exited")]);
		list.handleInput("\r");
		expect(choices).toEqual([]);
	});
});

describe("FrameSessionModel", () => {
	const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

	it("rebuilds the transcript from history, then a snapshot message, then live deltas", () => {
		const model = new FrameSessionModel();
		model.loadHistory([{ role: "user", content: "hi" }, assistant("hello")]);
		model.apply({ type: "agent_start" });
		model.apply({ type: "message_start", snapshot: true, message: assistant("al") });
		model.apply({ type: "message_update", message: assistant("alpha be") });
		expect(model.live?.text).toBe("alpha be");
		model.apply({ type: "message_end", message: assistant("alpha beta") });
		model.apply({ type: "agent_end" });
		expect(model.entries.map(e => `${e.role}:${e.text}`)).toEqual(["user:hi", "assistant:hello", "assistant:alpha beta"]);
		expect(model.streaming).toBe(false);
	});

	it("answers a confirm and drops an interaction another viewer settled", () => {
		const model = new FrameSessionModel();
		model.apply({ type: "extension_ui_request", id: "d1", method: "confirm", title: "ok?" });
		model.apply({ type: "tool_approval_request", id: "t1", toolName: "bash" });
		expect(model.answer(model.interactions[0]!, 0)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: true });
		model.apply({ type: "tool_approval_cancel", id: "x", targetId: "t1" });
		expect(model.interactions).toEqual([]);
	});
});
