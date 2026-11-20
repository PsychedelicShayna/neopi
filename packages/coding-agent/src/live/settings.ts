/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { DEFAULT_LIVE_MODEL, LIVE_MODEL_OPTIONS } from "./protocol";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS } from "./voices";

export const cfgLiveModel = register({
	id: "live.model",
	type: "string",
	default: DEFAULT_LIVE_MODEL,
	validate: value => {
		if (value === undefined) return;
		if (typeof value !== "string" || !value || /\s/.test(value)) {
			throw new Error("Live model must be a nonempty model slug without whitespace");
		}
	},
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Model",
		description: "Model requested for the next live call; the service does not report which model answers",
		options: LIVE_MODEL_OPTIONS,
	},
});

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "string",
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice",
		description: "Voice of realtime voice sessions; a custom live endpoint may take other names (set in config)",
		options: LIVE_VOICE_OPTIONS,
	},
});

export const cfgLiveModelCatalogPath = register({
	id: "live.modelCatalogPath",
	type: "string",
	default: "~/.bnuuy-agents/skills/model-catalog/catalog.json",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Model Catalog",
		description: "Path to the operator-editable model catalog JSON used for effort alerts.",
	},
});

export const cfgLiveDelegationDelivery = register({
	id: "live.delegationDelivery",
	type: "enum",
	values: ["steer", "followUp", "interrupt"],
	default: "steer",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Handoff Delivery",
		description: "How vocal handoffs reach the main agent; applies to the next handoff without restarting live mode",
		options: [
			{ value: "steer", label: "Steer without cancelling (default)" },
			{ value: "followUp", label: "Queue for next yield" },
			{ value: "interrupt", label: "Interrupt and restart" },
		],
	},
});

export const cfgLiveSuppressDelegateKeyword = register({
	id: "live.suppressDelegateKeyword",
	type: "string",
	default: "Iris",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Direct-Address Keyword",
		description:
			"Leading address that rejects handoffs to the main agent; case/punctuation insensitive (empty disables)",
	},
});

export const cfgLiveForceUtteranceKeyword = register({
	id: "live.forceUtteranceKeyword",
	type: "string",
	default: "relay",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Force-Utterance Keyword",
		description:
			"Phrase anywhere in finalized speech that requires a canonical main-agent handoff; direct address wins (empty disables)",
	},
});

export const cfgLiveHoldMode = register({
	id: "live.holdMode",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Hold Mode",
		description: "Hold unsent speech until submit or force-delegate; an admitted voice reply keeps playing",
	},
});

export const cfgLiveQuietFloorMs = register({
	id: "live.quietFloorMs",
	type: "number",
	default: 0,
	validate: value => {
		if (typeof value === "number" && value < 0) throw new Error("Live quiet floor must not be negative");
	},
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Quiet Floor (ms)",
		description: "Minimum quiet after microphone speech or composer writes before a new reply or handoff; 0 disables",
		options: [
			{ value: "0", label: "Disabled (default)" },
			{ value: "2000", label: "2000 ms" },
			{ value: "5000", label: "5000 ms" },
			{ value: "10000", label: "10000 ms" },
		],
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
			"Phrase at the end of composer text that force-delegates after the configured silence (empty disables)",
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
		description:
			"Trailing phrase releases a complete request for the voice agent to answer or delegate after silence (empty disables)",
	},
});

export const cfgLiveSubmitSilenceMs = register({
	id: "live.submitSilenceMs",
	type: "number",
	default: 2000,
	validate: value => {
		if (typeof value === "number" && value < 0) throw new Error("Live submit silence must not be negative");
	},
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Submit Silence (ms)",
		description:
			"Quiet after microphone speech and composer writes before a trailing keyword runs; speech must be finalized",
		options: [
			{ value: "0", label: "Immediately" },
			{ value: "500", label: "500 ms" },
			{ value: "1000", label: "1000 ms" },
			{ value: "2000", label: "2000 ms (default)" },
			{ value: "3000", label: "3000 ms" },
			{ value: "5000", label: "5000 ms" },
			{ value: "10000", label: "10000 ms" },
		],
	},
});

function validateLiveEndpoint(raw: unknown): void {
	if (typeof raw !== "string" || !raw.trim()) return;
	let protocol: string;
	try {
		protocol = new URL(raw.trim()).protocol;
	} catch {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
}

export const cfgLiveEndpoint = register({
	id: "live.endpoint",
	type: "string",
	default: undefined,
	validate: validateLiveEndpoint,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Endpoint",
		description:
			"Base URL of an OpenAI Realtime WebRTC-compatible server (e.g. http://127.0.0.1:8080/v1) used for live voice instead of Codex; empty uses Codex",
	},
});

export const cfgLiveApiKey = register({
	id: "live.apiKey",
	type: "string",
	default: undefined,
	credential: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Endpoint API Key",
		description: "Bearer key sent only to the live endpoint: a literal, an environment variable name, or !command",
	},
});

/** The voice a live session uses: an explicit choice, else the `live.voice` setting, else the default. */
export function resolveLiveVoice(scope: ScopeLike, voice?: string): string {
	return voice?.trim() || cfgLiveVoice.get(scope).trim() || DEFAULT_LIVE_VOICE;
}
