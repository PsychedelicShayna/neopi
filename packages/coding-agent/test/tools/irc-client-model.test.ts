import { describe, expect, it } from "bun:test";
import { IrcBus } from "../../src/irc/bus";
import {
	IRC_TRAFFIC_ID,
	IrcClientModel,
	ircDmId,
	ircEntryConversationId,
	ircEntryId,
	ircRoomId,
	otherIrcDmPeer,
} from "../../src/irc/client-model";
import { AgentRegistry } from "../../src/registry/agent-registry";

function fixture() {
	const registry = new AgentRegistry();
	// Local participants with no model session avoid wake-turn side effects;
	// their messages and fan-outs still go through the real bus and its ledger.
	for (const id of ["Shayna", "A", "B"]) {
		registry.register({ id, displayName: id, kind: "operator", session: null, status: "idle" });
	}
	const bus = new IrcBus(registry);
	const source = { entries: () => bus.history(), subscribe: (listener: () => void) => bus.onHistory(listener) };
	return { bus, source };
}

async function send(bus: IrcBus, from: string, to: string, body: string): Promise<void> {
	await bus.send({ from, to, body, localOnly: true });
}

function bodies(client: IrcClientModel, id = client.selected): string[] {
	return client.entries(id).map(({ message }) => message.groupText ?? message.body);
}

describe("IRC conversation client model", () => {
	it("projects both directions of a DM in send order and previews without clearing unread", async () => {
		const { bus, source } = fixture();
		await send(bus, "A", "Shayna", "question");
		await send(bus, "Shayna", "A", "answer");
		await send(bus, "B", "A", "third-party");
		const client = new IrcClientModel(source, { operatorId: "Shayna" });
		try {
			const direct = ircDmId("Shayna", "A");
			const observed = ircDmId("A", "B");
			expect(otherIrcDmPeer(direct, "Shayna")).toBe("A");
			expect(otherIrcDmPeer(observed, "Shayna")).toBeUndefined();
			expect(bodies(client, direct)).toEqual(["question", "answer"]);
			expect(bodies(client, IRC_TRAFFIC_ID)).toEqual(["question", "answer", "third-party"]);
			expect(client.selected).toBe(IRC_TRAFFIC_ID);
			expect(client.unread(direct)).toBe(1);
			expect(client.unread()).toBe(2);
			client.open("resume", direct);
			expect(client.unread(direct)).toBe(0);
			expect(client.unread()).toBe(1);
			await send(bus, "A", "Shayna", "new while reading");
			expect(client.unread(direct)).toBe(1);
			client.markRead();
			expect(client.unread(direct)).toBe(0);
		} finally {
			client.dispose();
		}
	});

	it("keeps passive traffic from stealing the last position and jumps on a new addressed DM", async () => {
		const { bus, source } = fixture();
		const a = ircDmId("Shayna", "A");
		const b = ircDmId("Shayna", "B");
		await send(bus, "B", "Shayna", "hydrated backlog, not a new alert");
		const client = new IrcClientModel(source, {
			operatorId: "Shayna",
			snapshot: { lastConversation: a, pinned: [], read: [] },
		});
		try {
			expect(client.open()).toBe(a);
			client.close();
			await send(bus, "A", "B", "passive chatter");
			expect(client.open()).toBe(a);
			client.close();
			await send(bus, "B", "Shayna", "new alert");
			await send(bus, "A", "B", "newer, but passive");
			expect(client.open()).toBe(b);
			client.close();
			expect(client.open("traffic")).toBe(IRC_TRAFFIC_ID);
			expect(bodies(client).at(-1)).toBe("newer, but passive");
			expect(client.unread()).toBe(0);
		} finally {
			client.dispose();
		}
	});

	it("counts a room fan-out once and restores room selection, pins, and read state", async () => {
		const { bus, source } = fixture();
		const room = ircRoomId("council");
		const created = await bus.group("A", { op: "create", group: "council", members: ["A", "B", "Shayna"] });
		expect(created.isError).not.toBe(true);
		const client = new IrcClientModel(source, { operatorId: "Shayna" });
		try {
			client.open("traffic");
			client.close();
			const receipt = await bus.group("A", { op: "send", group: "council", message: "@Shayna-other passive" });
			expect(receipt.receipts).toHaveLength(3);
			expect(client.open()).toBe(IRC_TRAFFIC_ID);
			client.close();
			await bus.group("A", { op: "send", group: "council", message: "(@Shayna) hello\nsecond line" });
			expect(client.unread(room)).toBe(1);
			expect(client.unread()).toBe(1);
			const traffic = client.entries(IRC_TRAFFIC_ID).at(-1)!;
			expect(ircEntryConversationId(traffic)).toBe(room);
			expect(ircEntryId(traffic)).toBe(ircEntryId(client.entries(room).at(-1)!));
			expect(bodies(client, room).filter(body => body.endsWith("second line"))).toEqual(["(@Shayna) hello\nsecond line"]);
			expect(client.open()).toBe(room);
			client.close();
			client.setPinned(room, true);
			await send(bus, "B", "A", "new unpinned conversation");
			const restored = new IrcClientModel(source, { operatorId: "Shayna", snapshot: client.snapshot() });
			try {
				expect(restored.conversations(["everyone"]).map(item => item.id)).toEqual([
					room,
					ircDmId("B", "A"),
					ircRoomId("everyone"),
				]);
				expect(restored.unread(room)).toBe(0);
				expect(restored.unread()).toBe(1);
				expect(restored.open()).toBe(room);
			} finally {
				restored.dispose();
			}
		} finally {
			client.dispose();
		}
	});

	it("keeps a logical row at its original position when a later leg becomes its representative", async () => {
		const { bus, source } = fixture();
		const client = new IrcClientModel(source, { operatorId: "Shayna" });
		try {
			const groupSend = {
				from: "A",
				group: "council",
				groupText: "@Shayna room message",
				body: "@Shayna room message",
				broadcast: true,
				localOnly: true,
				fanoutId: "one-room-send",
			};
			await bus.send({ ...groupSend, to: "B" });
			await send(bus, "A", "B", "later logical message");
			const initial = client.entries(IRC_TRAFFIC_ID);
			expect(initial.map(entry => entry.message.to)).toEqual(["B", "B"]);
			await bus.send({ ...groupSend, to: "Shayna" });
			const delivered = client.entries(IRC_TRAFFIC_ID);
			expect(delivered.map(entry => entry.message.to)).toEqual(["Shayna", "B"]);
			expect(delivered.map(ircEntryId)).toEqual(initial.map(ircEntryId));
			expect(client.unread()).toBe(2);
			expect(client.open()).toBe(ircRoomId("council"));
		} finally {
			client.dispose();
		}
	});
});
