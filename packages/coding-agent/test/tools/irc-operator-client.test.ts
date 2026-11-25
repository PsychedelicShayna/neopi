import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../../src/irc/bus";
import { IRC_TRAFFIC_ID, ircDmId } from "../../src/irc/client-model";
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
		expect(manager.getLeafId()).toBe(leaf);
		const oldId = manager.getSessionId();
		const stateFile = ircOperatorStatePath(oldId, "client.json", agentDir);
		if (process.platform !== "win32") expect((await fs.stat(stateFile)).mode & 0o777).toBe(0o600);

		// Reconstruct without closing the first model: persistence is not deferred until the overlay closes.
		const restored = new OperatorIrcClient(root, session, options);
		clients.push(restored);
		expect(restored.model.open()).toBe(conversationId);
		expect(restored.model.conversations()[0]).toMatchObject({ id: conversationId, pinned: true });
		expect(delivered).toHaveLength(1);
		await manager.fork({ copyArtifacts: true });
		expect(manager.getSessionId()).not.toBe(oldId);
		const forked = new OperatorIrcClient(root, session, options);
		clients.push(forked);
		expect(forked.model.open()).toBe(IRC_TRAFFIC_ID);
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
