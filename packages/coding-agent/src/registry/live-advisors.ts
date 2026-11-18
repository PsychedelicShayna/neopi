/**
 * Live advisor lifecycle in the agent registry (#345).
 *
 * Disk discovery (`persisted-agents.ts`) registers every advisor transcript it
 * finds as `parked`, live or not. This tracker mirrors one session's running
 * advisor runtimes instead: `running` while the advisor reviews, `idle` between
 * reviews, `parked` once its runtime stops (the transcript stays readable), and
 * unregistered when the owning agent itself leaves the registry. Advisor refs
 * stay session-less and read-only; the live agent is reachable only through
 * {@link liveAdvisorAgent}, for observers that render in-flight output.
 */
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import type { AgentRef, AgentRegistryApi } from "./agent-registry";

/** Registry id of an owner's advisor; matches the id disk discovery assigns. */
export function advisorAgentId(ownerId: string, slug: string): string {
	return slug ? `${ownerId}/advisor:${slug}` : `${ownerId}/advisor`;
}

const liveAgents = new WeakMap<AgentRegistryApi, Map<string, Agent>>();

/** The running agent behind an advisor ref, or undefined when its runtime is not live. */
export function liveAdvisorAgent(registry: AgentRegistryApi, id: string): Agent | undefined {
	return liveAgents.get(registry)?.get(id);
}

interface TrackedAdvisor {
	ref: AgentRef;
	agent: Agent;
	unsubscribe: () => void;
}

export interface LiveAdvisorTrackerOptions {
	registry: AgentRegistryApi;
	/** Registry id of the session that owns the advisors. */
	ownerId: string;
	session: Pick<AgentSession, "liveAdvisors" | "onLiveAdvisorsChange">;
}

function unregisterOwned(registry: AgentRegistryApi, owned: Map<string, AgentRef>): void {
	for (const [id, ref] of owned) registry.unregister(id, ref);
	owned.clear();
}

/**
 * Unregister `owned` once `owner` is no longer the ref under `ownerId`. This listener stays on
 * the registry while the owner is parked, after its session is disposed, so it lives outside
 * {@link trackLiveAdvisors}: a closure there would keep that scope, and with it the session,
 * reachable. `tracker.stop` is the only link back and is cleared when tracking stops.
 */
function unregisterOnOwnerExit(
	registry: AgentRegistryApi,
	ownerId: string,
	owner: AgentRef,
	owned: Map<string, AgentRef>,
	tracker: { stop?: () => void },
): () => void {
	const unsubscribe = registry.onChange(event => {
		if (event.ref.id !== ownerId || registry.get(ownerId) === owner) return;
		tracker.stop?.();
		unregisterOwned(registry, owned);
		unsubscribe();
	});
	return unsubscribe;
}

/** Mirror `session`'s advisor runtimes into `registry`; the returned stop runs at the owner's dispose. */
export function trackLiveAdvisors(options: LiveAdvisorTrackerOptions): () => void {
	const { registry, ownerId, session } = options;
	const owner = registry.get(ownerId);
	if (!owner) return () => {};
	let agents = liveAgents.get(registry);
	if (!agents) {
		agents = new Map();
		liveAgents.set(registry, agents);
	}
	const directory = agents;
	const tracked = new Map<string, TrackedAdvisor>();
	/** Exact generations this tracker owns; stale teardown must not remove their replacements. */
	const owned = new Map<string, AgentRef>();
	let stopped = false;
	let unsubscribeChanges = () => {};
	let unsubscribeOwner = () => {};
	const tracker: { stop?: () => void } = {};

	const forget = (id: string, entry: TrackedAdvisor): void => {
		entry.unsubscribe();
		tracked.delete(id);
		if (directory.get(id) === entry.agent) directory.delete(id);
	};

	const sync = (): void => {
		if (stopped) return;
		const live = new Set<string>();
		for (const advisor of session.liveAdvisors()) {
			const id = advisorAgentId(ownerId, advisor.slug);
			let ref = registry.get(id);
			// Never adopt a non-advisor ref that happens to use this id.
			if (ref && (ref.kind !== "advisor" || ref.parentId !== ownerId)) continue;
			live.add(id);
			const file = advisor.transcriptFile ?? null;
			if (ref && ref.sessionFile !== file) {
				// The owner switched transcripts (`/new`): the id now names a different file.
				const previous = tracked.get(id);
				if (previous) forget(id, previous);
				registry.unregister(id, ref);
				ref = undefined;
			}
			const status = advisor.agent.state.isStreaming ? "running" : "idle";
			if (!ref) {
				ref = registry.register({
					id,
					displayName: advisor.slug ? `advisor:${advisor.slug}` : "advisor",
					kind: "advisor",
					parentId: ownerId,
					session: null,
					sessionFile: file,
					status,
					history: { readOnly: true },
				});
			}
			owned.set(id, ref);
			const current = tracked.get(id);
			if (current?.agent === advisor.agent && current.ref === ref) {
				registry.setStatus(id, status, ref);
				continue;
			}
			if (current) forget(id, current);
			const unsubscribe = advisor.agent.subscribe(event => {
				if (tracked.get(id)?.agent !== advisor.agent) return;
				if (event.type === "agent_start") {
					// A review run may begin after `/new` retargeted the transcript file.
					sync();
					const entry = tracked.get(id);
					if (entry?.agent === advisor.agent) registry.setStatus(id, "running", entry.ref);
				} else if (event.type === "agent_end") {
					const entry = tracked.get(id);
					if (entry?.agent === advisor.agent) registry.setStatus(id, "idle", entry.ref);
				}
			});
			tracked.set(id, { ref, agent: advisor.agent, unsubscribe });
			directory.set(id, advisor.agent);
			registry.setStatus(id, status, ref);
			// Rebuilt runtimes can retain both id and status: observers still need the new live source.
			registry.setHistory(id, { readOnly: true }, file ?? undefined);
		}
		for (const [id, entry] of tracked) {
			if (live.has(id)) continue;
			forget(id, entry);
			registry.setStatus(id, "parked", entry.ref);
		}
	};

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		tracker.stop = undefined;
		unsubscribeChanges();
		for (const [id, entry] of [...tracked]) {
			forget(id, entry);
			registry.setStatus(id, "parked", entry.ref);
		}
		if (registry.get(ownerId) !== owner) {
			unregisterOwned(registry, owned);
			unsubscribeOwner();
		}
	};
	unsubscribeOwner = unregisterOnOwnerExit(registry, ownerId, owner, owned, tracker);
	tracker.stop = stop;
	sync();
	unsubscribeChanges = session.onLiveAdvisorsChange(sync);
	return stop;
}
