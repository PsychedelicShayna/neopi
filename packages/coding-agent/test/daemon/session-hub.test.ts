import { describe, expect, it } from "bun:test";
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
		const list = new SessionHubList(
			c => choices.push(c),
			() => {},
		);
		list.setSessions([row("a"), row("b"), row("c")]);
		list.handleInput("j");
		list.handleInput("\x1b[B");
		list.handleInput("k");
		list.handleInput("\r");
		list.handleInput("n");
		list.handleInput("q");
		list.handleInput("\x1b");
		expect(choices).toEqual([
			{ kind: "attach", sessionId: "b" },
			{ kind: "new" },
			{ kind: "quit" },
			{ kind: "quit" },
		]);
	});

	it("keeps the selected session selected when the list refreshes in a new order", () => {
		const list = new SessionHubList(
			() => {},
			() => {},
		);
		list.setSessions([row("a"), row("b")]);
		list.handleInput("j");
		list.setSessions([row("c"), row("a"), row("b")]);
		expect(list.sessions[list.selected]!.id).toBe("b");
	});

	it("does not attach to an exited session", () => {
		const choices: HubChoice[] = [];
		const list = new SessionHubList(
			c => choices.push(c),
			() => {},
		);
		list.setSessions([row("a", "exited")]);
		list.handleInput("\r");
		expect(choices).toEqual([]);
	});
});

