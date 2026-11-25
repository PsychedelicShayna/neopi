import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { parseJsonlLenient, TempDir } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../../src/irc/bus";
import { IrcHistoryJournal } from "../../src/irc/history-journal";
import { ircOperatorStatePath } from "../../src/irc/operator-storage";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import type { CustomMessage } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";

function fixture(manager: SessionManager, agentDir: string, delivery?: Promise<"injected">) {
	const registry = new AgentRegistry();
	const delivered: IrcMessage[] = [];
	const relayed: CustomMessage[] = [];
	const root = registry.register({
		id: "Main",
		kind: "main",
		displayName: "Main",
		session: {
			sessionManager: manager,
			activeToolExecutionUpdates: () => [],
			emitIrcRelayObservation: (msg: CustomMessage) => relayed.push(msg),
		} as unknown as AgentSessionHandle,
	});
	registry.register({ id: "Human", kind: "operator", displayName: "Human", parentId: root.id, session: null });
	registry.register({
		id: "Peer",
		kind: "sub",
		displayName: "Peer",
		parentId: root.id,
		session: {
			deliverIrcMessage: async (msg: IrcMessage) => {
				delivered.push(msg);
				return delivery ?? "injected";
			},
		} as unknown as AgentSessionHandle,
	});
	const bus = new IrcBus(registry, undefined, agentDir);
	const history = () => bus.historyForRoot(root);
	return { bus, delivered, relayed, history, bodies: () => history().map(row => row.message.body) };
}

describe("operator IRC delivery journal", () => {
	it("restores full delivery attempts in send order without delivering, notifying, or moving the model leaf", async () => {
		using temp = TempDir.createSync("irc-history-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const agentDir = path.join(temp.path(), "operator-state");
		const delayed = Promise.withResolvers<"injected">();
		const first = fixture(manager, agentDir, delayed.promise);
		const file = manager.getSessionFile()!;
		const content = "First sent, last settled.\nKeep every line.";
		const leaf = manager.getLeafId();
		const pending = first.bus.send({ from: "Main", to: "Peer", body: content });
		try {
			const group = { from: "Peer", body: "room text", group: "council", groupText: "room text", fanoutId: "same" };
			await first.bus.send({ ...group, to: "Human" });
			const failed = await first.bus.send({ ...group, to: "Missing", localOnly: true });
			expect(failed.outcome).toBe("failed");
			delayed.resolve("injected");
			await pending;
			expect(first.bodies()).toEqual([content, "room text", "room text"]);
			expect(first.history().map(row => row.outcome)).toEqual(["injected", "injected", "failed"]);
			expect(first.history().at(-1)?.error).toBe(failed.error);
			expect(manager.getLeafId()).toBe(leaf);
			expect(first.delivered.map(message => message.body)).toEqual([content]);
		} finally {
			delayed.resolve("injected");
			await pending;
			await manager.close();
		}

		const resumed = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
		try {
			const next = fixture(resumed, agentDir);
			let notifications = 0;
			next.bus.onHistory(() => notifications++);
			const restored = next.history();
			expect(restored).toEqual(first.history());
			expect(restored.slice(1).map(row => row.message.fanoutId)).toEqual(["same", "same"]);
			expect(next.history()).toEqual(restored);
			expect(next.delivered).toEqual([]);
			expect(next.relayed).toEqual([]);
			expect(notifications).toBe(0);
			await next.bus.send({ from: "Human", to: "Peer", body: "after resume" });
			expect(notifications).toBe(1);
			expect(next.bodies()).toEqual([content, "room text", "room text", "after resume"]);
		} finally {
			await resumed.close();
		}
	});

	it("does not persist or display A's private history in a new or forked conversation", async () => {
		using temp = TempDir.createSync("irc-history-switch-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const agentDir = path.join(temp.path(), "operator-state");
		const delayed = Promise.withResolvers<"injected">();
		const ipc = fixture(manager, agentDir, delayed.promise);
		const fileA = manager.getSessionFile()!;
		await ipc.bus.send({ from: "Peer", to: "Human", body: "A private DM" });
		const inFlight = ipc.bus.send({ from: "Human", to: "Peer", body: "A late DM" });
		try {
			const fileB = (await manager.newSession())!;
			delayed.resolve("injected");
			await inFlight;
			expect(ipc.history()).toEqual([]);
			expect(ipc.relayed.some(row => typeof row.content === "string" && row.content.includes("A late DM"))).toBe(false);
			await ipc.bus.send({ from: "Peer", to: "Human", body: "B private DM" });
			expect(ipc.bodies()).toEqual(["B private DM"]);
			await manager.setSessionFile(fileA);
			expect(ipc.bodies()).toEqual(["A private DM"]);
			const fork = (await manager.fork({ copyArtifacts: true }))!;
			expect(ipc.history()).toEqual([]);
			expect(await Bun.file(fork.newSessionFile).text()).not.toContain("A private DM");
			await manager.setSessionFile(fileB);
			expect(fixture(manager, agentDir).bodies()).toEqual(["B private DM"]);
		} finally {
			delayed.resolve("injected");
			await inFlight;
			await manager.close();
		}
	});

	it("keeps explicitly scoped memory-only traffic without creating files or copying unowned traffic", async () => {
		using temp = TempDir.createSync("irc-history-memory-");
		const manager = SessionManager.inMemory(temp.path());
		const agentDir = path.join(temp.path(), "operator-state");
		try {
			const current = fixture(manager, agentDir);
			await current.bus.send({ from: "Detached", to: "Missing", body: "unowned", localOnly: true });
			await current.bus.send({ from: "Human", to: "Peer", body: "owned" });
			expect(current.bus.history().map(row => row.message.body)).toEqual(["unowned", "owned"]);
			expect(current.bodies()).toEqual(["owned"]);
			await manager.newSession();
			expect(current.history()).toEqual([]);
			expect(await fs.readdir(temp.path())).not.toContain("operator-state");
		} finally {
			await manager.close();
		}
	});

	it("bounds physical retention separately from the visible history cap", async () => {
		using temp = TempDir.createSync("irc-history-retention-");
		const sessionId = "session-with-capped-history";
		const file = ircOperatorStatePath(sessionId, "history.jsonl", temp.path());
		const cap = 2;
		const journal = new IrcHistoryJournal(sessionId, file, cap);
		for (let n = 0; n < 11; n++) {
			journal.record(
				journal.reserveOrder(),
				{
					message: { id: `id-${n}`, from: "Human", to: "Peer", body: `Sensitive row ${n}.`, ts: n },
					outcome: "injected",
					broadcast: false,
				},
				cap,
			);
			expect(parseJsonlLenient(await Bun.file(file).text()).length).toBeLessThanOrEqual(4);
		}
		if (process.platform !== "win32") {
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
		}
		const stored = await Bun.file(file).text();
		expect(stored).not.toContain("Sensitive row 0.");
		const resumed = new IrcHistoryJournal(sessionId, file, cap);
		expect(resumed.entries().map(row => row.message.id)).toEqual(["id-9", "id-10"]);
	});
});
