/**
 * The operator — the human at this process's interactive UI — as an IRC
 * participant (issue #31). She has her own id, distinct from `Main` (the model
 * that owns the composer): agents address her directly, and what she sends is
 * `from` her, never forged as `Main`. Delivery to her needs no model turn; the
 * bus shows it on her UI and records it in the operator history.
 */
import type { IrcLogSource } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry, type AgentRegistryApi } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { IrcBus, ircHistorySessionId } from "./bus";

/** The operator's IRC id unless `irc.operator.handle` names another. */
export const DEFAULT_IRC_OPERATOR_HANDLE = "Operator";

/**
 * Register `handle` as the operator under `rootId`. Returns the unregister, or
 * undefined when another participant already holds that id or the id is the
 * broadcast address `all` (the operator then stays unaddressable rather than
 * shadowing anyone).
 */
export function registerIrcOperator(
	registry: AgentRegistryApi,
	handle: string,
	rootId: string,
): (() => void) | undefined {
	if (handle === "all" || registry.get(handle)) {
		logger.warn("IRC operator handle is taken; the operator is not addressable", { handle });
		return undefined;
	}
	const ref = registry.register({
		id: handle,
		displayName: handle,
		kind: "operator",
		parentId: rootId,
		session: null,
		status: "idle",
	});
	return () => {
		registry.unregister(handle, ref);
	};
}

/**
 * The operator IRC history of the UI bound to `session()`: its root's
 * conversation. The one read side shared by the IRC viewer and the side
 * panel's IRC view; agents gain nothing from it.
 */
export function operatorIrcLogSource(session: () => AgentSession): IrcLogSource {
	const bus = IrcBus.global();
	if (!(bus instanceof IrcBus)) throw new Error("Operator IRC history is only available on the main thread");
	const registry = AgentRegistry.global();
	return {
		entries: () => {
			const root = registry.rootForSession(session());
			// Unchanged from the viewer's own source: no resolvable root reads the whole log.
			return bus.history(root ? { rootId: root.id, sessionId: ircHistorySessionId(root) } : undefined);
		},
		subscribe: listener => bus.onHistory(listener),
	};
}
