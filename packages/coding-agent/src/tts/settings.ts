/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import type { Settings } from "../config/settings";
import { type SpeechSegmentOptions } from "./segmenter";
import {
	DEFAULT_TTS_SPEED,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_LOCAL_VOICE_VALUES,
	TTS_SPEED_OPTIONS,
} from "./models";

/** Session voice controller owns an isolated runtime override; never persist the toggle. */
export const cfgVoiceEnabled = register({
	id: "voice.enabled",
	type: "boolean",
	default: false,
});

export const cfgVoicePostprocess = register({
	id: "voice.postprocess",
	type: "string",
	default: "",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Local voice reply instruction",
		description:
			"Optional tiny/smol prompt for the complete spoken reply. Empty speaks verbatim. Use /voice to enable this session.",
	},
});

export const cfgTtsLocalVoice = register({
	id: "tts.localVoice",
	type: "enum",
	values: TTS_LOCAL_VOICE_VALUES,
	default: DEFAULT_TTS_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Local TTS Voice",
		description: "Phonon voice used by the local TTS backend (American/British, female/male)",
		options: TTS_LOCAL_VOICE_OPTIONS,
	},
});

export const cfgTtsLocalSpeed = register({
	id: "tts.localSpeed",
	type: "number",
	default: DEFAULT_TTS_SPEED,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Local TTS Speed",
		description: "Speaking rate of the local TTS backend (tts tool, omp say). 1 = normal; clamped to 0.8–1.3",
		options: TTS_SPEED_OPTIONS,
	},
});

export const cfgSpeechEnabled = register({
	id: "speech.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization",
		description: "Speak the assistant's output aloud through the speakers as it streams",
	},
});

export const cfgSpeechMode = register({
	id: "speech.mode",
	type: "enum",
	values: ["all", "assistant", "yield"] as const,
	default: "assistant",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization Mode",
		description:
			"What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end",
		options: [
			{ value: "all", label: "All (messages + thinking)" },
			{ value: "assistant", label: "Assistant messages" },
			{ value: "yield", label: "Final message only" },
		],
	},
});

export const cfgSpeechEnhanced = register({
	id: "speech.enhanced",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Enhanced Speech Rewriting",
		description:
			"Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure",
	},
});

export const cfgSpeechVoice = register({
	id: "speech.voice",
	type: "enum",
	values: TTS_LOCAL_VOICE_VALUES,
	default: DEFAULT_TTS_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization Voice",
		description: "Phonon voice used when speaking the assistant's output aloud",
		options: TTS_LOCAL_VOICE_OPTIONS,
	},
});

export const cfgSpeechSpeed = register({
	id: "speech.speed",
	type: "number",
	default: DEFAULT_TTS_SPEED,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization Speed",
		description: "Speaking rate when reading the assistant's output aloud. 1 = normal; clamped to 0.8–1.3",
		options: TTS_SPEED_OPTIONS,
	},
});

export const cfgTtsPacingThreads = register({
	id: "tts.pacingThreads",
	type: "number",
	default: 0,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: CPU threads",
		description:
			"ONNX intra-op threads for the paced engine. 0 keeps the runtime default; try 2 to reduce contention. Changes reload its model",
	},
});

export const cfgTtsPacing = register({
	id: "tts.pacing",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: pacing",
		description: "Idle between synthesis segments while buffered speech plays. Only affects the Kokoro, paced engine",
	},
});
export const cfgTtsPacingMargin = register({
	id: "tts.pacingMarginMs",
	type: "number",
	default: 350,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: safety margin",
		description:
			"Start synthesis this many milliseconds before its predicted deadline. Increase if playback has gaps",
	},
});
export const cfgTtsSegmentMin = register({
	id: "tts.segmentMinChars",
	type: "number",
	default: 80,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: minimum segment",
		description: "Minimum characters before a preferred boundary, except the first segment or the final remainder",
	},
});
export const cfgTtsSegmentMax = register({
	id: "tts.segmentMaxChars",
	type: "number",
	default: 240,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: maximum segment",
		description: "Character target, clamped to 40–280. Quotes, parentheses and indivisible words can extend past it",
	},
});
export const cfgTtsSegmentFirst = register({
	id: "tts.segmentFirstChars",
	type: "number",
	default: 80,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: first segment",
		description: "Short first-segment character target for fast initial speech, capped at the maximum segment length",
	},
});
export const cfgTtsSegmentWords = register({
	id: "tts.segmentMaxWords",
	type: "number",
	default: 40,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: hard word target",
		description: "Fallback word-count target when no preferred anchor fits. Enclosed clauses stay together",
	},
});
export const cfgTtsSegmentSentences = register({
	id: "tts.segmentSentences",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: sentence boundaries",
		description: "Prefer full-stop sentence endings before all other boundary rules",
	},
});
export const cfgTtsSegmentCommas = register({
	id: "tts.segmentCommas",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: comma boundaries",
		description: "Prefer commas after sentence endings in the boundary ladder",
	},
});
export const cfgTtsSegmentConjunctions = register({
	id: "tts.segmentConjunctions",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: conjunction boundaries",
		description: "Cut before and, or, or because when no sentence or comma boundary fits",
	},
});
export const cfgTtsSegmentPunctuation = register({
	id: "tts.segmentPunctuation",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: other punctuation",
		description:
			"Use colon, semicolon, exclamation, question and closing quote/parenthesis boundaries before word cuts",
	},
});
export const cfgTtsSegmentEllipsis = register({
	id: "tts.segmentEllipsis",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Paced Kokoro: ellipsis boundaries",
		description: "Treat a run of dots as one sentence ending. When disabled, only a single dot ends a sentence",
	},
});

function bounded(value: number, fallback: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

export function speechSegmentOptions(settings: Settings): SpeechSegmentOptions {
	const maxChars = bounded(cfgTtsSegmentMax.get(settings), 240, 40, 280);
	return {
		minChars: bounded(cfgTtsSegmentMin.get(settings), 80, 1, maxChars),
		maxChars,
		firstChars: bounded(cfgTtsSegmentFirst.get(settings), 80, 12, maxChars),
		maxWords: bounded(cfgTtsSegmentWords.get(settings), 40, 1, 100),
		sentences: cfgTtsSegmentSentences.get(settings),
		commas: cfgTtsSegmentCommas.get(settings),
		conjunctions: cfgTtsSegmentConjunctions.get(settings),
		punctuation: cfgTtsSegmentPunctuation.get(settings),
		ellipsis: cfgTtsSegmentEllipsis.get(settings),
	};
}

export function speechPacingMargin(settings: Settings): number {
	return bounded(cfgTtsPacingMargin.get(settings), 350, 0, 10000);
}

export function speechPacingThreads(settings: Settings): number {
	return bounded(cfgTtsPacingThreads.get(settings), 0, 0, 64);
}
