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

/** Buffer fake events until the executor has started their owning run. */
export function ownFakeSessionEvents(session: AgentSession): void {
	const subscribe = session.subscribe.bind(session);
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let ownerStarted = false;
	const pending: AgentSessionEvent[] = [];
	session.subscribe = callback => {
		listener = callback;
		return subscribe(event => {
			if (!ownerStarted) pending.push(event);
			else callback(event);
		});
	};
	session.withRunOwner = <T>(owner: string | undefined, fn: () => T): T => {
		ownerStarted = true;
		listener?.({ type: "agent_start", runOwners: owner ? [owner] : [] });
		for (const event of pending.splice(0)) listener?.(event);
		return fn();
	};
}
