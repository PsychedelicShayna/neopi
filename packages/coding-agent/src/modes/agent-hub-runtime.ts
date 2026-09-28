import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentHubRegistry, AgentLifecycleLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { parseSessionEntries } from "../session/session-loader";

/** Filesystem and parser used by local and host-backed transcript viewers. */
export const agentTranscriptSource: AgentTranscriptSource = {
	fs,
	parseEntries: text =>
		parseSessionEntries(text).filter(entry => entry.type === "message" || entry.type === "model_change"),
};

/** Host services used by the roster, without exposing runtime implementation to tui. */
export function createAgentHubRuntime(
	options: {
		registry?: AgentRegistry;
		lifecycle?: AgentLifecycleManager;
		irc?: IrcBus;
		activity?: AgentActivityIndex;
		remote?: AgentHubRemote;
		settings?: Settings;
		sessionFile?: string | null;
		/**
		 * Top-level root that owns this hub's UI. When several roots share the
		 * registry, the hub lists, resolves, and acts only on that root's agents
		 * (plus refs whose parent chain cannot be resolved). Omitted: full roster.
		 */
		root?: () => AgentRef | undefined;
	} = {},
): Pick<
	AgentHubDeps<AgentRef>,
	"registry" | "lifecycle" | "irc" | "activity" | "manageActivityLive" | "transcript" | "loadPersisted" | "getRoleInfo"
> {
	const registry = options.registry ?? AgentRegistry.global();
	const owns = (id: string): boolean => registry.isInRootTree(id, options.root?.());
	const lifecycle = (): AgentLifecycleManager => options.lifecycle ?? AgentLifecycleManager.global();
	const scopedRegistry: AgentHubRegistry<AgentRef> = {
		list: () => registry.list().filter(ref => owns(ref.id)),
		get: id => (owns(id) ? registry.get(id) : undefined),
		onChange: listener => registry.onChange(listener),
	};
	const scopedLifecycle: AgentLifecycleLike<AgentRef> = {
		ensureLive: async id => {
			if (!owns(id)) throw new Error(`Agent ${id} belongs to another session.`);
			return lifecycle().ensureLive(id);
		},
		release: async (id, expected, releaseOptions) =>
			owns(id) ? lifecycle().release(id, expected, releaseOptions) : false,
	};
	return {
		registry: scopedRegistry,
		lifecycle: () => scopedLifecycle,
		irc: options.irc ?? IrcBus.global(),
		activity: options.activity ?? new AgentActivityIndex({ remote: options.remote }),
		manageActivityLive: !options.activity,
		transcript: agentTranscriptSource,
		loadPersisted: shouldContinue =>
			registerPersistedSubagents(registry, options.sessionFile, {
				shouldContinue,
				rootAgentId: options.root?.()?.id,
			}),
		getRoleInfo: options.settings ? role => getRoleInfo(role, options.settings!) : undefined,
	};
}
