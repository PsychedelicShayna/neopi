import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

const stubSession = () => ({ dispose: async () => {} }) as unknown as AgentSession;

describe("agent hub runtime with several top-level roots", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;

	beforeEach(() => {
		registry = new AgentRegistry();
		lifecycle = new AgentLifecycleManager(registry);
	});
	afterEach(async () => {
		await lifecycle.dispose(Date.now());
	});

	function seed() {
		const rootA = registry.register({ id: "DeckA", displayName: "main", kind: "main", session: stubSession() });
		registry.register({ id: "DeckB", displayName: "main", kind: "main", session: stubSession() });
		registry.register({
			id: "DeckA.Research",
			displayName: "task",
			kind: "sub",
			parentId: "DeckA",
			session: stubSession(),
		});
		registry.register({
			id: "DeckB.Research",
			displayName: "task",
			kind: "sub",
			parentId: "DeckB",
			session: stubSession(),
		});
		// A restored ref whose parent chain cannot be resolved stays visible, as with one root.
		registry.register({
			id: "Orphan",
			displayName: "task",
			kind: "sub",
			parentId: "Gone",
			session: null,
			status: "parked",
		});
		return rootA;
	}

	it("lists and resolves only the owning root's agents, and refuses lifecycle actions on another root's", async () => {
		const rootA = seed();
		const hub = createAgentHubRuntime({ registry, lifecycle, root: () => rootA });

		expect(
			hub.registry
				.list()
				.map(ref => ref.id)
				.sort(),
		).toEqual(["DeckA", "DeckA.Research", "Orphan"]);
		expect(hub.registry.get("DeckB.Research")).toBeUndefined();
		expect(hub.registry.get("DeckA.Research")?.parentId).toBe("DeckA");

		const foreign = registry.get("DeckB.Research")!;
		await expect(hub.lifecycle().ensureLive("DeckB.Research")).rejects.toThrow(/another session/);
		await expect(hub.lifecycle().release("DeckB.Research", foreign, { tombstone: true })).resolves.toBe(false);
		expect(registry.get("DeckB.Research")?.status).toBe("running");
		await expect(hub.lifecycle().ensureLive("DeckA.Research")).resolves.toBe(
			registry.get("DeckA.Research")!.session!,
		);
	});

	it("keeps the full roster when no owning root is known", () => {
		seed();
		const hub = createAgentHubRuntime({ registry, lifecycle });
		expect(hub.registry.list()).toHaveLength(registry.list().length);
	});
});

describe("restoring a resumed non-Main root's persisted children", () => {
	function transcript(): string {
		return [
			JSON.stringify({ type: "session", id: "s0", parentId: null, timestamp: "2026-09-28T10:00:00.000Z" }),
			JSON.stringify({
				type: "session_init",
				id: "si",
				parentId: "s0",
				timestamp: "2026-09-28T10:00:01.000Z",
				agent: "task",
				task: "research",
			}),
		].join("\n");
	}

	for (const mainLive of [true, false]) {
		it(`parents restored top-level children to the owning root (${mainLive ? "Main live" : "no Main"})`, async () => {
			using tempDir = TempDir.createSync("@omp-root-restore-");
			const rootFile = path.join(tempDir.path(), "deck-a.jsonl");
			await Bun.write(rootFile, "");
			await Bun.write(path.join(tempDir.path(), "deck-a", "DeckA.Research.jsonl"), `${transcript()}\n`);
			await Bun.write(
				path.join(tempDir.path(), "deck-a", "DeckA.Research", "DeckA.Research.Research.jsonl"),
				`${transcript()}\n`,
			);
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycleManager(registry);
			try {
				if (mainLive)
					registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: stubSession() });
				const rootA = registry.register({
					id: "DeckA",
					displayName: "main",
					kind: "main",
					session: stubSession(),
					sessionFile: rootFile,
				});
				const hub = createAgentHubRuntime({ registry, lifecycle, root: () => rootA, sessionFile: rootFile });
				await hub.loadPersisted(() => true);

				expect(registry.get("DeckA.Research")?.parentId).toBe("DeckA");
				expect(registry.get("DeckA.Research.Research")?.parentId).toBe("DeckA.Research");
				expect(registry.rootOf("DeckA.Research")).toBe(rootA);
				expect(hub.registry.get("DeckA.Research")).toBeDefined();
				if (mainLive) {
					const mainHub = createAgentHubRuntime({ registry, lifecycle, root: () => registry.get(MAIN_AGENT_ID) });
					expect(mainHub.registry.get("DeckA.Research")).toBeUndefined();
				}
			} finally {
				await lifecycle.dispose(Date.now());
			}
		});
	}
});
