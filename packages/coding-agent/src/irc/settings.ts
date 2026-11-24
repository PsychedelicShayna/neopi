/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 *
 * Every key here concerns the operator: what she sees and the id she takes part under.
 * Agent authorization (who may message or overhear whom) stays addressed-only and has
 * no settings.
 */
import { effect, register } from "../config/registry";
import { DEFAULT_IRC_OPERATOR_HANDLE } from "./operator";
import { DEFAULT_IRC_HISTORY_MAX_ENTRIES, setIrcHistoryMaxEntries, setIrcRelayToMainTranscript } from "./policy";

export const cfgIrcOperatorHandle = register({
	id: "irc.operator.handle",
	type: "string",
	default: DEFAULT_IRC_OPERATOR_HANDLE,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "IRC Operator Handle",
		description:
			"Your IRC id: agents message you at it, and what you send from /irc or the IRC viewer comes from it. Takes effect the next time npi starts",
	},
});

export const cfgIrcViewerEnabled = register({
	id: "irc.operator.viewerEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "IRC Viewer",
		description: "Let the IRC viewer key open the history of agent-to-agent messages in this session",
	},
});

export const cfgIrcRelayToMainTranscript = register({
	id: "irc.operator.relayToMainTranscript",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Messaging",
		label: "IRC Messages in Transcript",
		description:
			"Show messages between other agents in the main transcript, in full. Messages to the main agent and to you always show; the IRC viewer keeps every message either way",
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
		description: "Most messages the IRC viewer keeps per process; the oldest drop first",
		options: [
			{ value: "200", label: "200" },
			{ value: "1000", label: "1000" },
			{ value: "5000", label: "5000" },
		],
	},
});
effect(cfgIrcHistoryMaxEntries, setIrcHistoryMaxEntries);
