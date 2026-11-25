/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 *
 * Every key here concerns the operator: what she sees and the id she takes part under.
 * Agent authorization (who may message or overhear whom) stays addressed-only and has
 * no settings.
 */
import { effect, register } from "../config/registry";
import type { AgentRef } from "../registry/agent-registry";
import { isLocalAgentSession } from "../session/agent-session-handle";
import { IRC_NOTIFICATION_LEVELS } from "./client-model";
import { DEFAULT_IRC_HISTORY_MAX_ENTRIES, setIrcHistoryMaxEntries, setIrcRelayToMainTranscript } from "./policy";

/** The operator's IRC id unless `irc.operator.handle` names another. */
export const DEFAULT_IRC_OPERATOR_HANDLE = "Operator";

export const cfgIrcOperatorHandle = register({
	id: "irc.operator.handle",
	type: "string",
	default: DEFAULT_IRC_OPERATOR_HANDLE,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "IRC Operator Handle",
		description:
			"Your IRC id: agents message you at it, and what you send from /irc or the IRC client comes from it. Takes effect the next time npi starts",
	},
});

export const cfgIrcViewerEnabled = register({
	id: "irc.operator.viewerEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "IRC Client",
		description: "Allow opening the IRC client for this session",
	},
});

export const cfgIrcOperatorDirectMessages = register({
	id: "irc.operator.directMessages",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "Receive IRC Direct Messages",
		description: "Allow agents to send you direct IRC messages, even if you share no room",
	},
});

export function ircOperatorDirectMessagesEnabled(root: AgentRef): boolean {
	const session = root.session;
	return session && isLocalAgentSession(session) && session.settings
		? cfgIrcOperatorDirectMessages.get(session.settings)
		: true;
}

export const cfgIrcOperatorNotifyDefault = register({
	id: "irc.operator.notifyDefault",
	type: "enum",
	values: IRC_NOTIFICATION_LEVELS,
	default: "mentions",
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "Default IRC Room Notifications",
		description: "Choose which room messages show a card and can become the next Alt+I destination unless overridden in the room",
		options: [
			{ value: "all", label: "Every message" },
			{ value: "mentions", label: "Mentions only" },
			{ value: "none", label: "Never" },
		],
	},
});

export const cfgIrcRelayToMainTranscript = register({
	id: "irc.operator.relayToMainTranscript",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "Announce Agent-to-Agent IRC",
		description:
			"Let live voice, event sounds and connected clients hear messages between other agents. Those messages never show in the main transcript and remain in IRC Traffic either way",
	},
});
effect(cfgIrcRelayToMainTranscript, setIrcRelayToMainTranscript);

export const cfgIrcHistoryMaxEntries = register({
	id: "irc.history.maxEntries",
	type: "number",
	default: DEFAULT_IRC_HISTORY_MAX_ENTRIES,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "IRC History Size",
		description: "Maximum number of recent IRC delivery attempts per root conversation; oldest drop first",
		options: [
			{ value: "200", label: "200" },
			{ value: "1000", label: "1000" },
			{ value: "5000", label: "5000" },
		],
	},
});
effect(cfgIrcHistoryMaxEntries, setIrcHistoryMaxEntries);
