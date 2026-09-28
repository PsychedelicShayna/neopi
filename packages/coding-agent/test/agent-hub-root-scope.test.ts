import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

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
