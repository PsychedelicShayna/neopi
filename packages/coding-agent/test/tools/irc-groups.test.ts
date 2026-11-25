import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { IrcBus } from "../../src/irc/bus";
import { executeSend } from "../../src/irc/messaging";
import { registerIrcOperator } from "../../src/irc/operator";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import { getAgentTombstonePath } from "../../src/registry/agent-tombstone";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import type { CustomMessage } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
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

function peer(id: string, kind: AgentRef["kind"] = "sub", sessionManager?: SessionManager) {
	const messages: IrcMessage[] = [];
	const observations: CustomMessage[] = [];
	const session = {
		...(sessionManager && { sessionManager, activeToolExecutionUpdates: () => [] }),
		deliverIrcMessage: async (message: IrcMessage) => {
			messages.push(message);
			return "injected";
		},
		emitIrcRelayObservation: (message: CustomMessage) => observations.push(message),
	} as unknown as AgentSessionHandle;
	registry.register({ id, kind, displayName: id, session, parentId: kind === "sub" ? "Main" : undefined });
	const tool = new IrcTool({
		cwd: import.meta.dir,
		getSessionFile: () => sessionManager?.getSessionFile() ?? null,
		getAgentId: () => id,
		agentRegistry: registry,
	});
	return { messages, observations, call: tool.execute.bind(tool, "irc-test") };
}

function bodies(messages: IrcMessage[]): string[] {
	return messages.map(message => message.body);
}

async function reopen(manager: SessionManager): Promise<SessionManager> {
	const file = manager.getSessionFile()!;
	const rootRef = registry.get("Main");
	if (rootRef) IrcBus.closeGroupsForRoot(rootRef);
	await manager.close();
	IrcBus.resetGlobalForTests();
	registry = new AgentRegistry();
	IrcBus.installGlobal(new IrcBus(registry));
	return SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
}

describe("IRC group session persistence", () => {
	it("delivers a restored council message to exactly its three members", async () => {
		using temp = TempDir.createSync("irc-council-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const root = peer("Main", "main", manager);
		for (const id of ["A", "B", "C"]) peer(id);
		await root.call({ op: "create", group: "council", members: ["A", "B", "C"] });

		const resumed = await reopen(manager);
		try {
			const main = peer("Main", "main", resumed);
			const a = peer("A");
			const b = peer("B");
			const c = peer("C");
			const outsider = peer("D");
			expect((await main.call({ op: "members", group: "council" })).content).toEqual([
				{ type: "text", text: "Members of IRC group council: A, B, C." },
			]);
			const journalLeaf = resumed.getLeafId();
			const sent = await main.call({ op: "send", group: "council", message: "After restart." });
			expect(sent.details?.receipts?.map(receipt => receipt.to)).toEqual(["A", "B", "C"]);
			expect(resumed.getLeafId()).toBe(journalLeaf);
			for (const member of [a, b, c]) {
				expect(bodies(member.messages)).toEqual([
					"Main sent this to group council, which you are part of.\n\nAfter restart.",
				]);
			}
			expect(outsider.messages).toEqual([]);
		} finally {
			await resumed.close();
		}
	});

	it("keeps everyone opt-outs for both the legacy broadcast and the IRC group", async () => {
		using temp = TempDir.createSync("irc-everyone-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const root = peer("Main", "main", manager);
		peer("Excluded");
		await root.call({ op: "remove", group: "everyone", members: ["Excluded"] });

		const resumed = await reopen(manager);
		try {
			const main = peer("Main", "main", resumed);
			const excluded = peer("Excluded");
			const included = peer("Included");
			const legacy = await executeSend({ registry, senderId: "Main" }, { to: "all", message: "Legacy" });
			expect(legacy.details?.receipts?.map(receipt => receipt.to)).toEqual(["Included"]);
			expect((await excluded.call({ op: "my_groups" })).content).toEqual([{ type: "text", text: "No IRC groups." }]);
			const broadcast = await main.call({ op: "broadcast", message: "IRC" });
			expect(broadcast.details?.receipts?.map(receipt => receipt.to)).toEqual(["Main", "Included"]);
			expect(bodies(included.messages)).toEqual(["Legacy", expect.stringContaining("\n\nIRC")]);
			expect(excluded.messages).toEqual([]);
		} finally {
			await resumed.close();
		}
	});

	it("drops gone and killed agents, deletes empty groups, and retains agents restored as parked", async () => {
		using temp = TempDir.createSync("irc-roster-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const root = peer("Main", "main", manager);
		peer("Gone");
		for (const id of ["Parked", "Killed"]) {
			peer(id);
			const file = path.join(manager.getArtifactsDir()!, `${id}.jsonl`);
			const child = await SessionManager.open(file, temp.path());
			child.appendSessionInit({ systemPrompt: ["persisted"], task: "persisted task", tools: ["yield"] });
			await child.ensureOnDisk();
			await child.close();
			if (id === "Killed") await Bun.write(getAgentTombstonePath(file), "");
		}
		await root.call({ op: "create", group: "empty-after-restore", members: ["Gone"] });
		await root.call({ op: "create", group: "sole-after-restore", members: ["Main", "Gone"] });
		await root.call({ op: "create", group: "parked-member", members: ["Main", "Parked", "Gone", "Killed"] });

		const resumed = await reopen(manager);
		try {
			const main = peer("Main", "main", resumed);
			expect((await main.call({ op: "members", group: "empty-after-restore" })).isError).toBe(true);
			expect((await main.call({ op: "members", group: "sole-after-restore" })).content).toEqual([
				{ type: "text", text: "Members of IRC group sole-after-restore: Main." },
			]);
			expect(bodies(main.messages)).toEqual([expect.stringContaining("deleted in 10 minutes")]);
			expect((await main.call({ op: "members", group: "parked-member" })).content).toEqual([
				{ type: "text", text: "Members of IRC group parked-member: Main, Parked." },
			]);
			expect(registry.get("Parked")?.status).toBe("parked");
			expect(registry.get("Killed")?.status).toBe("aborted");
		} finally {
			await resumed.close();
		}
	});

	it("expires past deadlines offline and lets a sole member keep a pending group after resume", async () => {
		vi.useFakeTimers();
		using temp = TempDir.createSync("irc-deadline-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const root = peer("Main", "main", manager);
		await root.call({ op: "create", group: "expired", members: ["Main"] });
		await root.call({ op: "create", group: "pending", members: ["Main"] });
		await root.call({ op: "keep", group: "pending", reason: "First extension" });
		IrcBus.resetGlobalForTests();
		vi.advanceTimersByTime(11 * 60_000);

		const resumed = await reopen(manager);
		try {
			const main = peer("Main", "main", resumed);
			expect((await main.call({ op: "my_groups" })).content).toEqual([
				{ type: "text", text: "everyone (1)\npending (1)" },
			]);
			expect(main.messages).toEqual([]);
			expect((await main.call({ op: "keep", group: "pending", reason: "Second extension" })).content).toEqual([
				{ type: "text", text: "Kept IRC group pending for 5 more minutes: Second extension" },
			]);
			vi.advanceTimersByTime(8 * 60_000);
			expect((await main.call({ op: "members", group: "pending" })).isError).not.toBe(true);
			vi.advanceTimersByTime(60_000);
			expect((await main.call({ op: "members", group: "pending" })).isError).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("copies the historical group's state into a fork without sharing later membership edits", async () => {
		using temp = TempDir.createSync("irc-fork-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const originalFile = manager.getSessionFile()!;
		const main = peer("Main", "main", manager);
		peer("A");
		peer("B");
		await main.call({ op: "create", group: "council", members: ["Main", "A", "B"] });
		const forkPoint = manager.getLeafId()!;
		await main.call({ op: "remove", group: "council", members: ["B"] });
		await manager.flush();
		manager.createBranchedSession(forkPoint);
		await manager.flush();

		expect((await main.call({ op: "members", group: "council" })).content).toEqual([
			{ type: "text", text: "Members of IRC group council: Main, A, B." },
		]);
		await main.call({ op: "remove", group: "council", members: ["A"] });
		expect((await main.call({ op: "members", group: "council" })).content).toEqual([
			{ type: "text", text: "Members of IRC group council: Main, B." },
		]);
		await manager.close();

		const original = await SessionManager.open(originalFile);
		try {
			const root = peer("Main", "main", original);
			expect((await root.call({ op: "members", group: "council" })).content).toEqual([
				{ type: "text", text: "Members of IRC group council: Main, A." },
			]);
		} finally {
			await original.close();
		}
	});
});

describe("IRC send options", () => {
	it("delivers a direct message with empty optional fields", async () => {
		const main = peer("Main", "main");
		const shayna = peer("shayna");
		const outsider = peer("Outsider");
		const sent = await main.call({
			op: "send",
			to: "shayna",
			group: "",
			message: "Hi",
			members: [],
			reason: "",
			replyTo: "",
			progress: false,
		});
		expect(sent.details?.receipts?.map(receipt => receipt.to)).toEqual(["shayna"]);
		expect(bodies(shayna.messages)).toEqual(["Hi"]);
		expect(shayna.messages[0]?.replyTo).toBeUndefined();
		expect(shayna.messages[0]?.progress).toBeUndefined();
		expect(outsider.messages).toEqual([]);
	});

	const noRecipients: string[] = [];

	it.each([{ to: "" }, { to: " \t" }, { to: noRecipients }])(
		"sends to a group with no direct recipients: %j",
		async ({ to }) => {
			const main = peer("Main", "main");
			const a = peer("A");
			const b = peer("B");
			const outsider = peer("Outsider");
			await main.call({ op: "create", group: "council", members: ["A", "B"] });
			const sent = await main.call({
				op: "send",
				to,
				group: "council",
				message: "Hi",
				members: [],
				reason: "",
				replyTo: "",
				progress: false,
			});
			expect(sent.details?.receipts?.map(receipt => receipt.to)).toEqual(["A", "B"]);
			for (const member of [a, b]) {
				expect(member.messages.at(-1)?.body).toBe("Main sent this to group council, which you are part of.\n\nHi");
			}
			expect(outsider.messages).toEqual([]);
		},
	);

	it.each([
		{ to: "A", group: "council" },
		{ to: "", group: "" },
		{ to: noRecipients, group: " \t" },
	])("rejects ambiguous or missing destinations without delivery: %j", async destinations => {
		const main = peer("Main", "main");
		const a = peer("A");
		const b = peer("B");
		await main.call({ op: "create", group: "council", members: ["A", "B"] });
		const sent = await main.call({ op: "send", ...destinations, message: "Hi" });
		expect(sent.isError).toBe(true);
		expect(sent.content).toEqual([{ type: "text", text: "Specify either to or group, not both." }]);
		for (const member of [a, b]) {
			expect(bodies(member.messages)).toEqual([expect.stringContaining("added to IRC group council")]);
		}
	});

	it.each([{ progress: true }, { replyTo: "message-id" }])(
		"rejects direct-message options on group sends: %j",
		async options => {
			const main = peer("Main", "main");
			const a = peer("A");
			const b = peer("B");
			await main.call({ op: "create", group: "council", members: ["A", "B"] });
			const sent = await main.call({ op: "send", group: "council", message: "Hi", ...options });
			expect(sent.isError).toBe(true);
			expect(sent.content).toEqual([{ type: "text", text: "replyTo and progress apply only to direct messages." }]);
			for (const member of [a, b]) {
				expect(bodies(member.messages)).toEqual([expect.stringContaining("added to IRC group council")]);
			}
		},
	);

	it("ignores a blank reply ID from direct-send callers outside the tool", async () => {
		peer("Main", "main");
		const a = peer("A");
		await executeSend({ registry, senderId: "Main" }, { to: "A", message: "Hi", replyTo: " \t" });
		expect(bodies(a.messages)).toEqual(["Hi"]);
		expect(a.messages[0]?.replyTo).toBeUndefined();
	});
});

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
		expect(broadcast.details?.outgoing).toEqual({
			from: "Main",
			to: ["Main", "A", "B", "Operator", "C"],
			group: "everyone",
			timestamp: expect.any(Number),
		});
		expect(main.observations.map(message => message.content)).toEqual([
			expect.stringContaining("Main sent this to group everyone"),
		]);
		expect(main.observations.map(message => message.display)).toEqual([false]);
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

	it("stamps each group leg with the group as it is when sent, and one id for the whole send", async () => {
		peer("Main", "main");
		const a = peer("A");
		const b = peer("B");
		const c = peer("C");
		await a.call({ op: "create", group: "council", members: ["A", "B", "C"] });
		await a.call({ op: "create", group: "review", members: ["A", "B"] });
		// The notice of being added names its group, without being a message sent to it.
		expect(b.messages.map(message => [message.group, message.groupText])).toEqual([
			["council", undefined],
			["review", undefined],
		]);
		for (const member of [a, b, c]) member.messages.length = 0;

		await a.call({ op: "send", group: "council", message: "Compare findings." });
		const toB = b.messages[0]!;
		const toC = c.messages[0]!;
		// The model-facing body keeps its heading; the sender's own text travels beside it.
		expect(toB.body).toBe("A sent this to group council, which you are part of.\n\nCompare findings.");
		expect(toB).toMatchObject({ group: "council", groupText: "Compare findings.", sharedGroups: ["review"] });
		expect(toC).toMatchObject({ group: "council", groupText: "Compare findings." });
		expect(toC.sharedGroups).toBeUndefined();
		expect(toB.fanoutId).toBeTruthy();
		expect(toC.fanoutId).toBe(toB.fanoutId);

		// A later send is its own fan-out, and membership changes show only from then on.
		await b.call({ op: "leave", group: "review" });
		await a.call({ op: "send", group: "council", message: "Second round." });
		expect(b.messages[1]!.sharedGroups).toBeUndefined();
		expect(b.messages[1]!.fanoutId).not.toBe(toB.fanoutId);
		expect(toB.sharedGroups).toEqual(["review"]);

		// A direct message names no group, only the ones both ends share.
		await a.call({ op: "send", to: "C", message: "Just you." });
		expect(c.messages[2]).toMatchObject({ body: "Just you.", sharedGroups: ["council"] });
		expect(c.messages[2]!.group).toBeUndefined();
		expect(c.messages[2]!.fanoutId).toBeUndefined();
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
