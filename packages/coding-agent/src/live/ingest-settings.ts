import { logger } from "@oh-my-pi/pi-utils";
import type { PersonaSourceField } from "@oh-my-pi/pi-tui/overlays/persona-config";
import { LivePersonaStore, onLivePersonaStateChanged } from "./personas";

export interface LiveIngestPersonaSettings {
	ircPrimary: boolean;
	ircPeers: boolean;
	subagents: boolean;
	subagentMaxDepth: number;
	voicedSlotsByDepth: number[];
	subagentClassifier: boolean;
	classifierQuietMs: number;
	rescoreIntervalMs: number;
	startAnnounceQuietMs: number;
	voicedChangeCue: boolean;
	effortAlerts: boolean;
	advisorNotes: { nit: boolean; concern: boolean; blocker: boolean };
	advisorThinking: boolean;
	relayReasoning: boolean;
	relayProgress: boolean;
	relayFinalAnswers: boolean;
	includeVoiceNote: boolean;
}

export const LIVE_INGEST_DEFAULTS: Readonly<LiveIngestPersonaSettings> = Object.freeze({
	ircPrimary: true,
	ircPeers: true,
	subagents: true,
	subagentMaxDepth: 1,
	voicedSlotsByDepth: Object.freeze([8, 4, 2]) as unknown as number[],
	subagentClassifier: true,
	classifierQuietMs: 10_000,
	rescoreIntervalMs: 600_000,
	startAnnounceQuietMs: 5_000,
	voicedChangeCue: true,
	effortAlerts: true,
	advisorNotes: Object.freeze({ nit: true, concern: true, blocker: true }),
	advisorThinking: false,
	relayReasoning: true,
	relayProgress: true,
	relayFinalAnswers: true,
	includeVoiceNote: true,
});

function record(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("ingest: must be an object");
	return value as Record<string, unknown>;
}

export function normalizeLiveIngestSettings(partial: unknown): LiveIngestPersonaSettings {
	const source = record(partial);
	const defaults = LIVE_INGEST_DEFAULTS;
	const boolean = (name: keyof LiveIngestPersonaSettings): boolean => {
		const value = source[name];
		if (value === undefined) return defaults[name] as boolean;
		if (typeof value !== "boolean") throw new Error(`${name}: must be a boolean`);
		return value;
	};
	const time = (name: "classifierQuietMs" | "startAnnounceQuietMs" | "rescoreIntervalMs", low: number): number => {
		const value = source[name] ?? defaults[name];
		if (
			!Number.isInteger(value) ||
			((value as number) < low && (value !== 0 || low !== 60_000)) ||
			(value as number) > (low === 60_000 ? 3_600_000 : 600_000)
		) {
			throw new Error(
				`${name}: ${low === 60_000 ? "must be 0 or an integer between 60000 and 3600000" : "must be an integer between 0 and 600000"}`,
			);
		}
		return value as number;
	};
	const depth = source.subagentMaxDepth ?? defaults.subagentMaxDepth;
	if (!Number.isInteger(depth) || ((depth as number) < 1 && depth !== -1))
		throw new Error("subagentMaxDepth: must be a positive integer or -1 (unlimited)");
	const slots = source.voicedSlotsByDepth ?? defaults.voicedSlotsByDepth;
	if (
		!Array.isArray(slots) ||
		!slots.length ||
		!slots.every(value => Number.isInteger(value) && (value >= 1 || value === -1))
	)
		throw new Error("voicedSlotsByDepth: must be a non-empty array of positive integers or -1");
	const advisor = source.advisorNotes === undefined ? {} : record(source.advisorNotes);
	const advisorBoolean = (severity: "nit" | "concern" | "blocker") => {
		const value = advisor[severity];
		if (value === undefined) return defaults.advisorNotes[severity];
		if (typeof value !== "boolean") throw new Error(`advisorNotes.${severity}: must be a boolean`);
		return value;
	};
	return {
		ircPrimary: boolean("ircPrimary"),
		ircPeers: boolean("ircPeers"),
		subagents: boolean("subagents"),
		subagentMaxDepth: depth as number,
		voicedSlotsByDepth: [...slots],
		subagentClassifier: boolean("subagentClassifier"),
		classifierQuietMs: time("classifierQuietMs", 0),
		rescoreIntervalMs: time("rescoreIntervalMs", 60_000),
		startAnnounceQuietMs: time("startAnnounceQuietMs", 0),
		voicedChangeCue: boolean("voicedChangeCue"),
		effortAlerts: boolean("effortAlerts"),
		advisorNotes: {
			nit: advisorBoolean("nit"),
			concern: advisorBoolean("concern"),
			blocker: advisorBoolean("blocker"),
		},
		advisorThinking: boolean("advisorThinking"),
		relayReasoning: boolean("relayReasoning"),
		relayProgress: boolean("relayProgress"),
		relayFinalAnswers: boolean("relayFinalAnswers"),
		includeVoiceNote: boolean("includeVoiceNote"),
	};
}

const depthOptions = [
	{ value: "1", label: "Direct children only" },
	{ value: "2", label: "2" },
	{ value: "3", label: "3" },
	{ value: "-1", label: "Unlimited" },
] as const;
const slotOptions = [
	{ value: "1", label: "1" },
	{ value: "2", label: "2" },
	{ value: "4", label: "4" },
	{ value: "8", label: "8" },
	{ value: "16", label: "16" },
	{ value: "32", label: "32" },
	{ value: "-1", label: "All (watch everything)" },
] as const;
const classifierQuietOptions = [
	{ value: "3000", label: "3000" },
	{ value: "5000", label: "5000" },
	{ value: "10000", label: "Default" },
	{ value: "20000", label: "20000" },
	{ value: "30000", label: "30000" },
] as const;
const rescoreOptions = [
	{ value: "0", label: "Off" },
	{ value: "300000", label: "5 min" },
	{ value: "600000", label: "10 min (default)" },
	{ value: "1800000", label: "30 min" },
] as const;
const startQuietOptions = [
	{ value: "0", label: "Immediately" },
	{ value: "2000", label: "2000" },
	{ value: "5000", label: "Default" },
	{ value: "10000", label: "10000" },
] as const;

function sourceBoolean(
	key: string,
	label: string,
	value: boolean,
	description: string,
	enabledBy?: string,
): PersonaSourceField {
	return { key, label, kind: "boolean", value, description, enabledBy };
}

function sourceChoice(
	key: string,
	label: string,
	value: number,
	options: ReadonlyArray<{ value: string; label: string; description?: string }>,
	description: string,
	enabledBy?: string,
): PersonaSourceField {
	const stringValue = String(value);
	return {
		key,
		label,
		kind: "choice",
		value: stringValue,
		options: options.some(option => option.value === stringValue)
			? options
			: [{ value: stringValue, label: `Custom (${stringValue})` }, ...options],
		description,
		enabledBy,
	};
}

export function liveIngestSourceFields(settings: LiveIngestPersonaSettings): PersonaSourceField[] {
	const fields: PersonaSourceField[] = [
		sourceBoolean(
			"ircPrimary",
			"IRC to primary",
			settings.ircPrimary,
			"Relays subagent IRC addressed to the primary; default is on.",
		),
		sourceBoolean(
			"ircPeers",
			"IRC between subagents",
			settings.ircPeers,
			"Relays IRC between subagents; default is on.",
		),
		sourceBoolean(
			"subagents",
			"Subagents",
			settings.subagents,
			"Tracks and narrates subagent activity; default is on.",
		),
		sourceChoice(
			"subagentMaxDepth",
			"Subagent max depth",
			settings.subagentMaxDepth,
			depthOptions,
			"Limits tracked subagent nesting; default is direct children only.",
			"subagents",
		),
	];
	settings.voicedSlotsByDepth.forEach((value, index, values) => {
		const depth = index + 1;
		fields.push(
			sourceChoice(
				`voicedSlotsByDepth.${index}`,
				`Voiced slots: depth ${depth}${index === values.length - 1 ? "+" : ""}`,
				value,
				slotOptions,
				"Limits concurrently narrated subagents at this depth; defaults are 8, 4, and 2.",
				"subagents",
			),
		);
	});
	fields.push(
		sourceBoolean(
			"subagentClassifier",
			"Importance classifier",
			settings.subagentClassifier,
			"Ranks tracked subagents for voiced slots; default is on.",
			"subagents",
		),
		sourceChoice(
			"classifierQuietMs",
			"Classifier quiet time",
			settings.classifierQuietMs,
			classifierQuietOptions,
			"Waits for roster quiet before classification; default is 10000 ms.",
			"subagentClassifier",
		),
		sourceChoice(
			"rescoreIntervalMs",
			"Periodic rescore",
			settings.rescoreIntervalMs,
			rescoreOptions,
			"Periodically refreshes importance scores; default is 10 minutes.",
			"subagentClassifier",
		),
		sourceChoice(
			"startAnnounceQuietMs",
			"Start announcement quiet time",
			settings.startAnnounceQuietMs,
			startQuietOptions,
			"Batches start announcements after quiet; default is 5000 ms.",
			"subagents",
		),
		sourceBoolean(
			"voicedChangeCue",
			"Voiced-set change cue",
			settings.voicedChangeCue,
			"Announces changes to the narrated subagent set; default is on.",
			"subagents",
		),
		sourceBoolean(
			"effortAlerts",
			"Effort red alerts (catalog)",
			settings.effortAlerts,
			"Checks catalog-marked effort selections independently; default is on.",
			"subagents",
		),
		sourceBoolean(
			"advisorNotes.nit",
			"Advisor notes: nit",
			settings.advisorNotes.nit,
			"Relays advisor nit notes; default is on.",
		),
		sourceBoolean(
			"advisorNotes.concern",
			"Advisor notes: concern",
			settings.advisorNotes.concern,
			"Relays advisor concern notes; default is on.",
		),
		sourceBoolean(
			"advisorNotes.blocker",
			"Advisor notes: blocker",
			settings.advisorNotes.blocker,
			"Relays advisor blocker notes; default is on.",
		),
		sourceBoolean(
			"advisorThinking",
			"Advisor thinking",
			settings.advisorThinking,
			"Relays finalized advisor reasoning; default is off.",
		),
		sourceBoolean(
			"relayReasoning",
			"Primary reasoning narration",
			settings.relayReasoning,
			"Relays the primary agent's reasoning narration; default is on.",
		),
		sourceBoolean(
			"relayProgress",
			"Primary tool progress",
			settings.relayProgress,
			"Relays the primary agent's tool progress; default is on.",
		),
		sourceBoolean(
			"relayFinalAnswers",
			"Primary final answers",
			settings.relayFinalAnswers,
			"Relays the primary agent's final answers; default is on.",
		),
		sourceBoolean(
			"includeVoiceNote",
			"Include voice agent's note in delegations",
			settings.includeVoiceNote,
			"Includes voice-agent provenance in delegations; default is on.",
		),
	);
	return fields;
}

export function liveIngestSettingsFromFields(
	fields: PersonaSourceField[] | undefined,
	raw: unknown,
): LiveIngestPersonaSettings {
	const next = normalizeLiveIngestSettings(raw);
	for (const field of fields ?? []) {
		if (field.kind === "boolean") {
			switch (field.key) {
				case "ircPrimary":
					next.ircPrimary = field.value;
					break;
				case "ircPeers":
					next.ircPeers = field.value;
					break;
				case "subagents":
					next.subagents = field.value;
					break;
				case "subagentClassifier":
					next.subagentClassifier = field.value;
					break;
				case "voicedChangeCue":
					next.voicedChangeCue = field.value;
					break;
				case "effortAlerts":
					next.effortAlerts = field.value;
					break;
				case "advisorNotes.nit":
					next.advisorNotes.nit = field.value;
					break;
				case "advisorNotes.concern":
					next.advisorNotes.concern = field.value;
					break;
				case "advisorNotes.blocker":
					next.advisorNotes.blocker = field.value;
					break;
				case "advisorThinking":
					next.advisorThinking = field.value;
					break;
				case "relayReasoning":
					next.relayReasoning = field.value;
					break;
				case "relayProgress":
					next.relayProgress = field.value;
					break;
				case "relayFinalAnswers":
					next.relayFinalAnswers = field.value;
					break;
				case "includeVoiceNote":
					next.includeVoiceNote = field.value;
					break;
			}
			continue;
		}
		const value = Number(field.value);
		if (!Number.isFinite(value)) continue;
		if (field.key === "subagentMaxDepth") next.subagentMaxDepth = value;
		else if (field.key === "classifierQuietMs") next.classifierQuietMs = value;
		else if (field.key === "rescoreIntervalMs") next.rescoreIntervalMs = value;
		else if (field.key === "startAnnounceQuietMs") next.startAnnounceQuietMs = value;
		else if (field.key.startsWith("voicedSlotsByDepth.")) {
			const index = Number(field.key.slice("voicedSlotsByDepth.".length));
			if (Number.isInteger(index) && index >= 0 && index < next.voicedSlotsByDepth.length) {
				next.voicedSlotsByDepth[index] = value;
			}
		}
	}
	return normalizeLiveIngestSettings(next);
}

export async function resolveLiveIngestSettings(statePath?: string): Promise<LiveIngestPersonaSettings> {
	const store = new LivePersonaStore(statePath);
	try {
		const state = await store.read();
		const active = state.active;
		if (!active || active === "default") return normalizeLiveIngestSettings(state.defaultIngest);
		const definition = state.personas[active];
		if (definition?.instructions.trim()) return normalizeLiveIngestSettings(definition.ingest);
		logger.warn("Active live persona missing or empty; using default live ingest settings", {
			path: store.path,
			active,
		});
	} catch (error) {
		logger.warn("Live persona state unreadable; using default live ingest settings", {
			path: store.path,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return normalizeLiveIngestSettings(undefined);
}

export class LiveIngestSettingsSource {
	#current: LiveIngestPersonaSettings;
	#statePath: string | undefined;
	#listeners = new Set<(next: LiveIngestPersonaSettings, previous: LiveIngestPersonaSettings) => void>();
	#seq = 0;
	#wave: PromiseWithResolvers<void> | undefined;
	#unsubscribe: (() => void) | undefined;
	constructor(initial: LiveIngestPersonaSettings, statePath?: string) {
		this.#current = initial;
		this.#statePath = statePath;
	}
	get(): LiveIngestPersonaSettings {
		return this.#current;
	}
	refresh(): Promise<void> {
		const seq = ++this.#seq;
		const wave = (this.#wave ??= Promise.withResolvers<void>());
		void resolveLiveIngestSettings(this.#statePath).then(next => {
			if (seq !== this.#seq) return;
			const previous = this.#current;
			this.#current = next;
			if (JSON.stringify(next) !== JSON.stringify(previous)) {
				for (const listener of this.#listeners) {
					try {
						listener(next, previous);
					} catch (error) {
						logger.debug("live ingest settings listener failed", { error: String(error) });
					}
				}
			}
			if (seq === this.#seq && this.#wave === wave) {
				this.#wave = undefined;
				wave.resolve();
			}
		});
		return wave.promise;
	}
	listen(listener: (next: LiveIngestPersonaSettings, previous: LiveIngestPersonaSettings) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	attach(): () => void {
		if (!this.#unsubscribe) {
			this.#unsubscribe = onLivePersonaStateChanged(() => {
				void this.refresh();
			});
			void this.refresh();
		}
		return () => {
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
			this.#seq++;
			this.#wave?.resolve();
			this.#wave = undefined;
		};
	}
}
