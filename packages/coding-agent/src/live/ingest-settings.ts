import { logger } from "@oh-my-pi/pi-utils";
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
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("ingest: must be an object");
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
		if (!Number.isInteger(value) || (value as number) < low && (value !== 0 || low !== 60_000) || (value as number) > (low === 60_000 ? 3_600_000 : 600_000)) {
			throw new Error(`${name}: ${low === 60_000 ? "must be 0 or an integer between 60000 and 3600000" : "must be an integer between 0 and 600000"}`);
		}
		return value as number;
	};
	const depth = source.subagentMaxDepth ?? defaults.subagentMaxDepth;
	if (!Number.isInteger(depth) || (depth as number) < 1 && depth !== -1)
		throw new Error("subagentMaxDepth: must be a positive integer or -1 (unlimited)");
	const slots = source.voicedSlotsByDepth ?? defaults.voicedSlotsByDepth;
	if (!Array.isArray(slots) || !slots.length || !slots.every(value => Number.isInteger(value) && (value >= 1 || value === -1)))
		throw new Error("voicedSlotsByDepth: must be a non-empty array of positive integers or -1");
	const advisor = source.advisorNotes === undefined ? {} : record(source.advisorNotes);
	const advisorBoolean = (severity: "nit" | "concern" | "blocker") => {
		const value = advisor[severity];
		if (value === undefined) return defaults.advisorNotes[severity];
		if (typeof value !== "boolean") throw new Error(`advisorNotes.${severity}: must be a boolean`);
		return value;
	};
	return {
		ircPrimary: boolean("ircPrimary"), ircPeers: boolean("ircPeers"), subagents: boolean("subagents"),
		subagentMaxDepth: depth as number, voicedSlotsByDepth: [...slots],
		subagentClassifier: boolean("subagentClassifier"),
		classifierQuietMs: time("classifierQuietMs", 0), rescoreIntervalMs: time("rescoreIntervalMs", 60_000),
		startAnnounceQuietMs: time("startAnnounceQuietMs", 0),
		voicedChangeCue: boolean("voicedChangeCue"), effortAlerts: boolean("effortAlerts"),
		advisorNotes: { nit: advisorBoolean("nit"), concern: advisorBoolean("concern"), blocker: advisorBoolean("blocker") },
		advisorThinking: boolean("advisorThinking"),
		relayReasoning: boolean("relayReasoning"), relayProgress: boolean("relayProgress"),
		relayFinalAnswers: boolean("relayFinalAnswers"), includeVoiceNote: boolean("includeVoiceNote"),
	};
}

export async function resolveLiveIngestSettings(statePath?: string): Promise<LiveIngestPersonaSettings> {
	const store = new LivePersonaStore(statePath);
	try {
		const state = await store.read();
		const active = state.active;
		if (!active || active === "default") return normalizeLiveIngestSettings(state.defaultIngest);
		const definition = state.personas[active];
		if (definition?.instructions.trim()) return normalizeLiveIngestSettings(definition.ingest);
		logger.warn("Active live persona missing or empty; using default live ingest settings", { path: store.path, active });
	} catch (error) {
		logger.warn("Live persona state unreadable; using default live ingest settings", {
			path: store.path, error: error instanceof Error ? error.message : String(error),
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
	get(): LiveIngestPersonaSettings { return this.#current; }
	refresh(): Promise<void> {
		const seq = ++this.#seq;
		const wave = this.#wave ??= Promise.withResolvers<void>();
		void resolveLiveIngestSettings(this.#statePath).then(next => {
			if (seq !== this.#seq) return;
			const previous = this.#current;
			this.#current = next;
			if (JSON.stringify(next) !== JSON.stringify(previous)) {
				for (const listener of this.#listeners) {
					try { listener(next, previous); }
					catch (error) { logger.debug("live ingest settings listener failed", { error: String(error) }); }
				}
			}
			if (seq === this.#seq && this.#wave === wave) { this.#wave = undefined; wave.resolve(); }
		});
		return wave.promise;
	}
	listen(listener: (next: LiveIngestPersonaSettings, previous: LiveIngestPersonaSettings) => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}
	attach(): () => void {
		if (!this.#unsubscribe) {
			this.#unsubscribe = onLivePersonaStateChanged(() => { void this.refresh(); });
			void this.refresh();
		}
		return () => {
			this.#unsubscribe?.(); this.#unsubscribe = undefined;
			this.#seq++;
			this.#wave?.resolve(); this.#wave = undefined;
		};
	}
}
