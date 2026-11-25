import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { IRC_TRAFFIC_ID, ircDmId, ircRoomId } from "../../src/irc/client-model";
import { OperatorIrcClient, registerIrcOperator } from "../../src/irc/operator";
import { ircOperatorStatePath } from "../../src/irc/operator-storage";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

it("sends operator DMs and restores a private client snapshot without copying it into a fork", async () => {
	using temp = TempDir.createSync("irc-operator-client-");
	const manager = SessionManager.create(temp.path(), temp.path());
	const agentDir = path.join(temp.path(), "profile");
	const registry = new AgentRegistry();
	const bus = new IrcBus(registry, undefined, agentDir);
	const registryGlobal = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const busGlobal = vi.spyOn(IrcBus, "global").mockReturnValue(bus);
	const delivered: IrcMessage[] = [];
	const options = { operatorId: "Human", operatorName: "Human", agentDir, requestRender() {}, reconcileOverlay() {} };
	const clients: OperatorIrcClient[] = [];
	try {
		await manager.ensureOnDisk();
		const session = { sessionManager: manager, activeToolExecutionUpdates: () => [] } as unknown as AgentSession;
		const root = registry.register({ id: "Root", displayName: "Root", kind: "main", session });
		registerIrcOperator(registry, "Human", root.id);
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: root.id,
			session: {
				deliverIrcMessage: async (message: IrcMessage) => {
					delivered.push(message);
					return "injected";
				},
			} as unknown as AgentSession,
		});
		const client = new OperatorIrcClient(root, session, options);
		clients.push(client);
		const conversationId = ircDmId("Human", "Peer");
		expect(client.resolveTarget({ dm: "Peer" })).toEqual({ conversationId });
		const leaf = manager.getLeafId();
		expect(await client.host.act({ kind: "send", conversationId, text: "Private from the operator" })).toBeUndefined();
		expect(delivered).toHaveLength(1);
		const [message] = delivered;
		expect(message).toMatchObject({ from: "Human", to: "Peer", body: "Private from the operator" });
		expect(client.resolveTarget({ messageId: message!.id })).toEqual({ conversationId, entryId: message!.id });
		client.model.open("resume", conversationId);
		client.model.setPinned(conversationId, true);
		expect(await client.host.act({ kind: "notifications", conversationId, level: "none" })).toBeUndefined();
		expect(manager.getLeafId()).toBe(leaf);
		const oldId = manager.getSessionId();
		const stateFile = ircOperatorStatePath(oldId, "client.json", agentDir);
		if (process.platform !== "win32") expect((await fs.stat(stateFile)).mode & 0o777).toBe(0o600);

		// Reconstruct without closing the first model: persistence is not deferred until the overlay closes.
		const restored = new OperatorIrcClient(root, session, options);
		clients.push(restored);
		expect(restored.model.open()).toBe(conversationId);
		expect(restored.model.conversations()[0]).toMatchObject({ id: conversationId, pinned: true });
		expect(restored.model.notificationLevel(conversationId)).toBe("none");
		expect(delivered).toHaveLength(1);
		await manager.fork({ copyArtifacts: true });
		expect(manager.getSessionId()).not.toBe(oldId);
		const forked = new OperatorIrcClient(root, session, options);
		clients.push(forked);
		expect(forked.model.open()).toBe(IRC_TRAFFIC_ID);
		expect(forked.model.notificationLevel(conversationId)).toBe("all");
		expect(forked.resolveTarget({ messageId: message!.id })).toBeUndefined();
		expect(forked.model.conversations()).toEqual([]);
		expect(await client.host.act({ kind: "send", conversationId, text: "Old client" })).toBeDefined();
		expect(delivered).toHaveLength(1);
	} finally {
		for (const client of clients) client.dispose();
		busGlobal.mockRestore();
		registryGlobal.mockRestore();
		await manager.close();
	}
});

it("binds operator room controls to the scoped roster and reports incomplete invites", async () => {
	using temp = TempDir.createSync("irc-room-controls-");
	const manager = SessionManager.create(temp.path(), temp.path());
	const registry = new AgentRegistry();
	const bus = new IrcBus(registry, undefined, temp.path());
	const registryGlobal = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const busGlobal = vi.spyOn(IrcBus, "global").mockReturnValue(bus);
	let client: OperatorIrcClient | undefined;
	try {
		await manager.ensureOnDisk();
		const relays: unknown[] = [];
		const session = {
			sessionManager: manager,
			settings: Settings.isolated({ "irc.operator.directMessages": false, "irc.operator.notifyDefault": "all" }),
			activeToolExecutionUpdates: () => [],
			emitIrcRelayObservation: (message: { display?: boolean }) => {
				if (message.display) relays.push(message);
			},
		} as unknown as AgentSession;
		const root = registry.register({ id: "Root", displayName: "Root", kind: "main", session });
		registerIrcOperator(registry, "Human", root.id);
		const delivered: IrcMessage[] = [];
		for (const id of ["Peer", "Quiet", "Later", "Wake", "Verbose", "Unavailable"]) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: root.id,
				status: "idle",
				session: {
					deliverIrcMessage: async (message: IrcMessage) => {
						if (id === "Unavailable") throw new Error("Could not accept the invite notice");
						delivered.push(message);
						return "injected";
					},
				} as unknown as AgentSession,
			});
		}
		registry.register({ id: "OtherRoot", kind: "main", displayName: "Other root", session: null });
		const room = "council";
		const conversationId = ircRoomId(room);
		const rendered = Promise.withResolvers<void>();
		client = new OperatorIrcClient(root, session, {
			operatorId: "Human",
			operatorName: "Human",
			agentDir: temp.path(),
			requestRender: rendered.resolve,
			reconcileOverlay() {},
		});
		const { host, model } = client;
		const act = host.act;
		const snapshot = async () => (await bus.roomsForRoot(root, "Human")).find(item => item.name === room);
		expect((await bus.send({ from: "Peer", to: "Human", body: "DMs disabled" })).outcome).toBe("failed");
		expect(await act({ kind: "send", conversationId: ircDmId("Human", "Peer"), text: "outbound DM still allowed" })).toBeUndefined();
		expect(relays).toHaveLength(0);
		expect((await bus.group("Peer", { op: "create", group: room, members: ["Peer"], notice: "silent" })).isError).not.toBe(true);
		expect(await act({ kind: "send", conversationId, text: "can't speak while spying" })).toBeDefined();
		expect(await act({ kind: "mute", room, memberId: "Peer", muted: true })).toBeDefined();
		expect(await act({ kind: "send", conversationId: ircDmId("Peer", "Quiet"), text: "can't reply" })).toBeDefined();
		expect(await act({ kind: "join", room, mode: "invisible" })).toBeUndefined();
		expect((await snapshot())?.joined).toBe(true);
		expect((await snapshot())?.members.map(member => member.id)).not.toContain("Human");
		expect(model.notificationLevel(conversationId)).toBe("all");
		expect(await act({ kind: "notifications", conversationId, level: "none" })).toBeUndefined();
		expect(await act({ kind: "invite", confirmation: { roomId: room, agentIds: ["OtherRoot"], noticeMode: "silent" } })).toBeDefined();
		await bus.group("Peer", { op: "send", group: room, message: "room delivery still works" });
		expect(model.entries(conversationId).at(-1)?.message.to).toBe("Human");
		expect(relays).toHaveLength(1);
		expect(client.relayNotifies({ from: "Peer", to: "Human", group: room, groupText: "@Human quiet" })).toBe(false);

		const beforeInvite = delivered.length;
		expect(await act({ kind: "invite", confirmation: { roomId: room, agentIds: ["Quiet"], noticeMode: "silent" } })).toBeUndefined();
		expect(delivered).toHaveLength(beforeInvite);
		expect(await act({ kind: "invite", confirmation: { roomId: room, agentIds: ["Quiet", "Unavailable"], noticeMode: "next-turn" } })).toContain("Unavailable");
		for (const [id, mode, noWake] of [
			["Later", "next-turn", true],
			["Wake", "wake-now", false],
			["Verbose", "verbose", true],
		] as const) {
			expect(await act({ kind: "invite", confirmation: { roomId: room, agentIds: [id], noticeMode: mode } })).toBeUndefined();
			const notice = delivered.at(-1);
			expect(notice).toMatchObject({ from: "Human", to: id, group: room });
			expect(notice?.noWake === true).toBe(noWake);
		}
		expect((await snapshot())?.members.map(member => member.id)).toContain("Unavailable");
		expect(await act({ kind: "permission", room, memberId: "Quiet", permission: "send", enabled: false })).toBeUndefined();
		expect(await act({ kind: "mute", room, memberId: "Quiet", muted: true })).toBeUndefined();
		client.setActive(true);
		await rendered.promise;
		expect(host.rooms().find(item => item.name === room)).toMatchObject({
			joined: true,
			canSend: true,
			notifications: "none",
			members: expect.arrayContaining([expect.objectContaining({
				id: "Quiet", muted: true, permissions: expect.objectContaining({ send: false }),
			})]),
		});
		expect(await act({ kind: "mute", room, memberId: "Quiet", muted: false })).toBeUndefined();
		expect(await act({ kind: "remove", room, memberId: "Unavailable" })).toBeUndefined();
		expect(await act({ kind: "leave", room })).toBeUndefined();
		expect((await snapshot())?.joined).toBe(false);
	} finally {
		client?.dispose();
		busGlobal.mockRestore();
		registryGlobal.mockRestore();
		await manager.close();
	}
});
