/**
 * Per-host mixture run state, keyed by the serialized run key. `acquire` is an
 * execution lock: a second call for a key whose run is executing does not wait,
 * it is told the run is busy. Non-serializable per-run state (provider session
 * maps per member, the operator's images for the entry hop) lives on the entry,
 * never in a checkpoint.
 */
import type { ImageContent, ProviderSessionState } from "@oh-my-pi/pi-ai";
import type { MixtureRun, MixtureRunKey } from "./types";

export interface MixtureRunEntry {
	/** Written only by {@link MixtureRunStore.install}. */
	run: MixtureRun | undefined;
	/** Provider session state per member id, scoped to this run. */
	providerState: Map<string, Map<string, ProviderSessionState>>;
	/** Images attached to the operator prompt that started the run; forwarded to the entry hop. */
	topicImages: ImageContent[];
	/** `{{conversation}}` of the prompt that started the run: the operator-facing history before it. */
	conversation: string;
}

export interface MixtureRunLease {
	entry: MixtureRunEntry;
	release(): void;
}

function serializeKey(key: MixtureRunKey): string {
	return JSON.stringify([key.host, key.mixture, key.lineage, key.conversation]);
}

export class MixtureRunStore {
	#entries = new Map<string, MixtureRunEntry>();
	#executing = new Set<string>();
	/** The entry each installed run executed in; ownership outlives replacement, not {@link clear}. */
	#owners = new WeakMap<MixtureRun, MixtureRunEntry>();

	/** Lock the key for one engine call; undefined when another call holds it. */
	acquire(key: MixtureRunKey): MixtureRunLease | undefined {
		const id = serializeKey(key);
		if (this.#executing.has(id)) return undefined;
		this.#executing.add(id);
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = { run: undefined, providerState: new Map(), topicImages: [], conversation: "" };
			this.#entries.set(id, entry);
		}
		let released = false;
		return {
			entry,
			release: () => {
				if (released) return;
				released = true;
				this.#executing.delete(id);
			},
		};
	}

	/** Make `run` the leased entry's run; the only writer of `entry.run`. */
	install(entry: MixtureRunEntry, run: MixtureRun): void {
		entry.run = run;
		this.#owners.set(run, entry);
	}

	/** The run that produced an outer response, if this store still holds it. */
	findByResponseId(responseId: string): MixtureRun | undefined {
		for (const entry of this.#entries.values()) {
			if (entry.run?.outerResponses.some(response => response.responseId === responseId)) return entry.run;
		}
		return undefined;
	}

	/** Whether `run` is still one of this store's runs (not dropped by {@link clear}). */
	holds(run: MixtureRun): boolean {
		for (const entry of this.#entries.values()) if (entry.run === run) return true;
		return false;
	}

	/**
	 * Whether the entry that executed `run` is still this store's entry for its
	 * key: true after a later run replaced it there, false once {@link clear}
	 * dropped that entry, even if the key has a fresh entry since.
	 */
	owns(run: MixtureRun): boolean {
		const owner = this.#owners.get(run);
		return owner !== undefined && this.#entries.get(serializeKey(run.key)) === owner;
	}

	/** Every run this store holds. */
	runs(): MixtureRun[] {
		const runs: MixtureRun[] = [];
		for (const entry of this.#entries.values()) if (entry.run) runs.push(entry.run);
		return runs;
	}

	/** Drop every run; a call still executing keeps its entry but is no longer held. */
	clear(): void {
		this.#entries.clear();
	}
}
