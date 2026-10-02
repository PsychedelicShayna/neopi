import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults(emit?: (event: AgentSessionEvent) => void) {
	return {
		withRunOwner: <T>(owner: string | undefined, fn: () => T): T => {
			if (owner) emit?.({ type: "agent_start", runOwners: [owner] });
			return fn();
		},
		setActiveToolsByName: async (_toolNames: string[]) => {},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
		addDisposer: () => {},
	} satisfies Partial<AgentSession>;
}
