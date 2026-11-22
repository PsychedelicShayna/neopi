import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import {
	advisorAgentId,
	liveAdvisorAgent,
	liveAdvisorRestart,
	trackLiveAdvisors,
} from "../../src/registry/live-advisors";
import type { AgentSession } from "../../src/session/agent-session";
import type { LiveAdvisor } from "../../src/session/session-advisors";

class AdvisorFeed implements Pick<AgentSession, "liveAdvisors" | "onLiveAdvisorsChange" | "restartAdvisor"> {
	#advisors: LiveAdvisor[] = [];
	readonly #listeners = new Set<() => void>();
	readonly restarts: string[] = [];
	restartAdvisor(slug: string): boolean {
		this.restarts.push(slug);
		return true;
	}
	liveAdvisors(): LiveAdvisor[] {
		return this.#advisors;
	}
	onLiveAdvisorsChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	set(advisors: LiveAdvisor[]): void {
		this.#advisors = advisors;
		for (const listener of this.#listeners) listener();
	}
	get listenerCount(): number {
		return this.#listeners.size;
	}
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function advisor(slug = "", transcriptFile: string | undefined = "/tmp/owner/__advisor.jsonl"): LiveAdvisor {
	return { slug, name: slug || "default", transcriptFile, agent: new Agent() };
}

interface TrackerFixture {
	registry: AgentRegistry;
	owner: AgentRef;
	feed: AdvisorFeed;
	stop(): void;
}

function fixture(advisors: LiveAdvisor[] = []): TrackerFixture {
	const registry = new AgentRegistry();
	const owner = registry.register({ id: "owner", displayName: "owner", kind: "main", session: null });
	const feed = new AdvisorFeed();
	feed.set(advisors);
	const stop = trackLiveAdvisors({ registry, ownerId: owner.id, session: feed });
	cleanups.push(() => {
		stop();
		registry.unregister(owner.id);
	});
	return { registry, owner, feed, stop };
}

function start(advisor: LiveAdvisor): void {
	advisor.agent.state.isStreaming = true;
	advisor.agent.emitExternalEvent({ type: "agent_start" });
}

function finish(advisor: LiveAdvisor): void {
	advisor.agent.state.isStreaming = false;
	advisor.agent.emitExternalEvent({ type: "agent_end", messages: [] });
}

describe("live advisor registry tracking", () => {
	test("runtime discovery registers default and named read-only refs without live sessions", () => {
		const first = advisor();
		const second = advisor("critic", "/tmp/owner/__advisor.critic.jsonl");
		const { registry, owner } = fixture([first, second]);
		expect(advisorAgentId(owner.id, "")).toBe("owner/advisor");
		expect(advisorAgentId(owner.id, "critic")).toBe("owner/advisor:critic");
		for (const runtime of [first, second]) {
			const id = advisorAgentId(owner.id, runtime.slug);
			const ref = registry.get(id);
			expect(ref?.kind).toBe("advisor");
			expect(ref?.parentId).toBe(owner.id);
			expect(ref?.status).toBe("idle");
			expect(ref?.session).toBeNull();
			expect(ref?.sessionFile).toBe(runtime.transcriptFile);
			expect(ref?.history?.readOnly).toBe(true);
			expect(liveAdvisorAgent(registry, id)).toBe(runtime.agent);
		}
	});

	test("restart routes the exact slug to the selected advisor's owner, including nested owners", () => {
		const { registry, owner, feed } = fixture([advisor(), advisor("critic")]);
		const worker = registry.register({
			id: "owner.worker",
			displayName: "worker",
			kind: "sub",
			parentId: owner.id,
			session: null,
		});
		const workerFeed = new AdvisorFeed();
		workerFeed.set([advisor("critic", "/tmp/worker/__advisor.critic.jsonl")]);
		const stop = trackLiveAdvisors({ registry, ownerId: worker.id, session: workerFeed });
		cleanups.push(() => {
			stop();
			registry.unregister(worker.id, worker);
		});
		const nested = registry.get(advisorAgentId(worker.id, "critic"))!;
		const implicit = registry.get(advisorAgentId(owner.id, ""))!;

		expect(liveAdvisorRestart(registry, nested)?.()).toBe(true);
		expect(workerFeed.restarts).toEqual(["critic"]);
		expect(feed.restarts).toEqual([]);
		expect(liveAdvisorRestart(registry, implicit)?.()).toBe(true);
		expect(feed.restarts).toEqual([""]);
	});

	test("restart refuses parked advisors and stale refs after the same id is retargeted", () => {
		const original = advisor();
		const { registry, feed } = fixture([original]);
		const old = registry.get("owner/advisor")!;
		const staleRestart = liveAdvisorRestart(registry, old);
		expect(staleRestart).toBeDefined();
		feed.set([]);
		expect(liveAdvisorRestart(registry, old)).toBeUndefined();
		expect(staleRestart?.()).toBe(false);

		feed.set([advisor("", "/tmp/next/__advisor.jsonl")]);
		const next = registry.get(old.id)!;
		expect(next).not.toBe(old);
		expect(liveAdvisorRestart(registry, old)).toBeUndefined();
		expect(staleRestart?.()).toBe(false);
		expect(feed.restarts).toEqual([]);
		expect(liveAdvisorRestart(registry, next)?.()).toBe(true);
		expect(feed.restarts).toEqual([""]);
	});

	test("runtime start/end events update running/idle without focus or session attachment", () => {
		const runtime = advisor();
		const { registry } = fixture([runtime]);
		const ref = registry.get("owner/advisor");
		start(runtime);
		expect(ref?.status).toBe("running");
		finish(runtime);
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBeNull();
	});

	test("stopped runtime parks its transcript and a later runtime can adopt that exact ref", () => {
		const runtime = advisor("critic");
		const { registry, feed } = fixture([runtime]);
		const ref = registry.get("owner/advisor:critic");
		feed.set([]);
		expect(registry.get("owner/advisor:critic")).toBe(ref);
		expect(ref?.status).toBe("parked");
		expect(liveAdvisorAgent(registry, "owner/advisor:critic")).toBeUndefined();
		const rebuilt = advisor("critic");
		feed.set([rebuilt]);
		expect(registry.get("owner/advisor:critic")).toBe(ref);
		expect(ref?.status).toBe("idle");
		expect(liveAdvisorAgent(registry, "owner/advisor:critic")).toBe(rebuilt.agent);
	});

	test("a same-status rebuild publishes its replacement live source and ignores the old agent", () => {
		const original = advisor();
		const { registry, feed } = fixture([original]);
		const ref = registry.get("owner/advisor");
		const events: string[] = [];
		const unsubscribe = registry.onChange(event => {
			if (event.ref === ref) events.push(event.type);
		});
		const rebuilt = advisor();
		feed.set([rebuilt]);
		expect(registry.get("owner/advisor")).toBe(ref);
		expect(liveAdvisorAgent(registry, "owner/advisor")).toBe(rebuilt.agent);
		expect(events).toContain("metadata_changed");
		start(rebuilt);
		finish(original);
		expect(ref?.status).toBe("running");
		finish(rebuilt);
		expect(ref?.status).toBe("idle");
		unsubscribe();
	});

	test("retargeted transcript files replace the generation, including becoming unpersisted", () => {
		const original = advisor();
		const { registry, feed } = fixture([original]);
		const old = registry.get("owner/advisor");
		const moved = { ...original, transcriptFile: "/tmp/next/__advisor.jsonl" };
		feed.set([moved]);
		const next = registry.get("owner/advisor");
		expect(next).not.toBe(old);
		expect(next?.sessionFile).toBe(moved.transcriptFile);
		feed.set([{ ...moved, transcriptFile: undefined }]);
		expect(registry.get("owner/advisor")).not.toBe(next);
		expect(registry.get("owner/advisor")?.sessionFile).toBeNull();
		expect(liveAdvisorAgent(registry, "owner/advisor")).toBe(original.agent);
	});

	test("owner removal while still live unregisters refs and detaches runtime/feed observers", () => {
		const runtime = advisor();
		const { registry, owner, feed } = fixture([runtime]);
		registry.unregister(owner.id, owner);
		expect(registry.get("owner/advisor")).toBeUndefined();
		expect(liveAdvisorAgent(registry, "owner/advisor")).toBeUndefined();
		expect(feed.listenerCount).toBe(0);
		feed.set([runtime]);
		start(runtime);
		expect(registry.get("owner/advisor")).toBeUndefined();
	});

	test("stopping the tracker keeps parked refs only while that exact owner stays registered", () => {
		const runtime = advisor();
		const { registry, owner, feed, stop } = fixture([runtime]);
		stop();
		stop();
		expect(registry.get("owner/advisor")?.status).toBe("parked");
		expect(liveAdvisorAgent(registry, "owner/advisor")).toBeUndefined();
		expect(feed.listenerCount).toBe(0);
		registry.unregister(owner.id, owner);
		expect(registry.get("owner/advisor")).toBeUndefined();
	});

	test("stale owner teardown cannot remove a newer same-id advisor ref", () => {
		const { registry, owner, stop } = fixture([advisor()]);
		stop();
		const replacement = registry.register({
			id: "owner/advisor",
			displayName: "replacement",
			kind: "advisor",
			parentId: owner.id,
			session: null,
			sessionFile: "/tmp/replacement.jsonl",
			status: "idle",
		});
		registry.register({ ...owner });
		stop();
		expect(registry.get(replacement.id)).toBe(replacement);
		expect(replacement.status).toBe("idle");
	});

	test("owner replacement stops the old live tracker instead of adopting the new tree", () => {
		const runtime = advisor();
		const { registry, owner, feed } = fixture([runtime]);
		registry.register({ ...owner });
		expect(registry.get("owner/advisor")).toBeUndefined();
		expect(feed.listenerCount).toBe(0);
		feed.set([advisor("new")]);
		expect(registry.get("owner/advisor:new")).toBeUndefined();
	});

	test("colliding non-advisors or advisors parented to another owner are never adopted", () => {
		const { registry, feed } = fixture();
		const collision = registry.register({
			id: "owner/advisor",
			displayName: "ordinary sub",
			kind: "sub",
			parentId: "owner",
			session: null,
		});
		const foreign = registry.register({
			id: "owner/advisor:foreign",
			displayName: "foreign advisor",
			kind: "advisor",
			parentId: "other",
			session: null,
		});
		feed.set([advisor(), advisor("foreign")]);
		expect(registry.get(collision.id)).toBe(collision);
		expect(registry.get(foreign.id)).toBe(foreign);
		expect(liveAdvisorAgent(registry, collision.id)).toBeUndefined();
		expect(liveAdvisorAgent(registry, foreign.id)).toBeUndefined();
	});
});
