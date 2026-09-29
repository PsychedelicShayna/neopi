/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "./voices";

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "enum",
	values: LIVE_VOICE_VALUES,
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice",
		description: "Voice used by Codex-backed realtime voice sessions",
		options: LIVE_VOICE_OPTIONS,
	},
});

export const cfgLiveForceDelegateKeyword = register({
	id: "live.forceDelegateKeyword",
	type: "string",
	default: "",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Force-Delegate Keyword",
		description:
			"Finalized speech containing this phrase sends accumulated speech to the main agent (empty disables)",
	},
});

export const cfgLiveBlockDelegateKeyword = register({
	id: "live.blockDelegateKeyword",
	type: "string",
	default: "",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Block-Delegate Keyword",
		description: "Finalized speech containing this phrase stays with the voice agent (empty disables)",
	},
});

export const cfgLiveSubmitKeyword = register({
	id: "live.submitKeyword",
	type: "string",
	default: "",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Submit Keyword",
		description: "Phrase at the end of finalized speech that submits the composer to its selected destination",
	},
});
