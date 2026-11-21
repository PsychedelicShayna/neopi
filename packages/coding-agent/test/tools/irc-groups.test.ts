import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { IrcBus } from "../../src/irc/bus";
import { executeSend } from "../../src/irc/messaging";
import { registerIrcOperator } from "../../src/irc/operator";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import type { CustomMessage } from "../../src/session/messages";
import { IrcTool } from "../../src/tools/irc";

let registry: AgentRegistry;

beforeEach(() => {
	registry = new AgentRegistry();
	IrcBus.installGlobal(new IrcBus(registry));
});

afterEach(() => {
	IrcBus.resetGlobalForTests();
	vi.useRealTimers();
});

function peer(id: string, kind: AgentRef["kind"] = "sub") {
	const messages: IrcMessage[] = [];
	const observations: CustomMessage[] = [];
	const session = {
		deliverIrcMessage: async (message: IrcMessage) => {
			messages.push(message);
			return "injected";
		},
		emitIrcRelayObservation: (message: CustomMessage) => observations.push(message),
	} as unknown as AgentSessionHandle;
	registry.register({ id, kind, displayName: id, session, parentId: kind === "sub" ? "Main" : undefined });
	const tool = new IrcTool({
		cwd: import.meta.dir,
		getSessionFile: () => null,
		getAgentId: () => id,
		agentRegistry: registry,
	});
	return { messages, observations, call: tool.execute.bind(tool, "irc-test") };
}

function bodies(messages: IrcMessage[]): string[] {
	return messages.map(message => message.body);
}

describe("IRC namespaces", () => {
	it("delivers a council message to exactly its three members, including the creator", async () => {
		const main = peer("Main", "main");
		const a = peer("A");
		const b = peer("B");
		const c = peer("C");
		expect((await a.call({ op: "create", group: "council", members: ["A", "B", "C"] })).isError).not.toBe(true);
		for (const member of [a, b, c]) {
			expect(bodies(member.messages)).toEqual([expect.stringContaining("added to IRC group council")]);
			member.messages.length = 0;
		}
		const result = await a.call({ op: "send", group: "council", message: "Compare findings." });
		expect(result.details?.receipts?.map(receipt => receipt.to)).toEqual(["A", "B", "C"]);
		for (const member of [a, b, c]) {
			expect(bodies(member.messages)).toEqual([
				"A sent this to group council, which you are part of.\n\nCompare findings.",
			]);
		}
		expect(main.messages).toEqual([]);
		expect(main.observations).toEqual([]);
	});

	it("broadcasts to everyone, takes new participants, and keeps removed peers directly reachable", async () => {
		const main = peer("Main", "main");
		const a = peer("A");
		const b = peer("B");
		registerIrcOperator(registry, "Operator", "Main");
		expect((await main.call({ op: "groups" })).content).toEqual([{ type: "text", text: "everyone (4)" }]);
		const c = peer("C");
		const broadcast = await main.call({ op: "broadcast", message: "First" });
		expect(broadcast.details?.receipts?.map(receipt => receipt.to)).toEqual(["Main", "A", "B", "Operator", "C"]);
		expect(main.observations.map(message => message.content)).toEqual([
			expect.stringContaining("Main sent this to group everyone"),
		]);
		await main.call({ op: "remove", group: "everyone", members: ["B", "C"] });
		expect((await b.call({ op: "my_groups" })).content).toEqual([{ type: "text", text: "No IRC groups." }]);
		await main.call({ op: "broadcast", message: "Second" });
		await executeSend({ registry, senderId: "Main" }, { to: "all", message: "Legacy broadcast" });
		await main.call({ op: "send", to: "B", message: "Private" });
		expect(bodies(a.messages)).toEqual([
			expect.stringContaining("First"),
			expect.stringContaining("Second"),
			"Legacy broadcast",
		]);
		expect(bodies(b.messages)).toEqual([expect.stringContaining("First"), "Private"]);
		expect(bodies(c.messages)).toEqual([expect.stringContaining("First")]);
		await main.call({ op: "remove", group: "everyone", members: ["Main", "A", "Operator"] });
		expect((await main.call({ op: "groups" })).content).toEqual([{ type: "text", text: "everyone (0)" }]);
	});

	it("rejects empty creation and removes a non-fixed group when the last member leaves", async () => {
		const a = peer("A");
		expect((await a.call({ op: "create", group: "empty", members: [] })).isError).toBe(true);
		await a.call({ op: "create", group: "draft", members: ["A"] });
		await a.call({ op: "leave", group: "draft" });
		expect((await a.call({ op: "members", group: "draft" })).isError).toBe(true);
		expect((await a.call({ op: "groups" })).content).toEqual([{ type: "text", text: "everyone (1)" }]);
	});

	it("retains idle/parked members, reminds the sole member on departure, and extends by five minutes", async () => {
		vi.useFakeTimers();
		const a = peer("A");
		const b = peer("B");
		peer("C");
		await a.call({ op: "create", group: "draft", members: ["A"] });
		expect(bodies(a.messages)).toContainEqual(expect.stringContaining("deleted in 10 minutes"));
		await a.call({ op: "add", group: "draft", members: ["B", "C"] });
		for (const status of ["idle", "parked"] as const) registry.setStatus("B", status);
		vi.advanceTimersByTime(11 * 60_000);
		expect((await a.call({ op: "members", group: "draft" })).content).toEqual([
			{ type: "text", text: "Members of IRC group draft: A, B, C." },
		]);
		a.messages.length = 0;
		registry.setStatus("B", "aborted");
		registry.unregister("C");
		expect(bodies(a.messages)).toEqual([expect.stringContaining("deleted in 10 minutes")]);
		expect(bodies(b.messages)).toEqual([expect.stringContaining("added to IRC group draft")]);
		expect((await a.call({ op: "keep", group: "draft", reason: " " })).isError).toBe(true);
		vi.advanceTimersByTime(9 * 60_000);
		expect((await a.call({ op: "keep", group: "draft", reason: "Awaiting counsel" })).content).toEqual([
			{ type: "text", text: "Kept IRC group draft for 5 more minutes: Awaiting counsel" },
		]);
		vi.advanceTimersByTime(5 * 60_000);
		expect((await a.call({ op: "my_groups" })).content).toEqual([{ type: "text", text: "everyone (1)\ndraft (1)" }]);
		vi.advanceTimersByTime(60_000);
		expect((await a.call({ op: "my_groups" })).content).toEqual([{ type: "text", text: "everyone (1)" }]);
	});
});
