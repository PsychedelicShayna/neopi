import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";
import type { SessionEntry } from "./session-entries";

export interface SessionJournalIdentity {
	sessionId: string;
	sessionFile: string | null;
	leafId: string | null;
}
export type SessionJournalEvent =
	| ({ type: "journal_state"; reason: "snapshot" | "identity" | "leaf" } & SessionJournalIdentity)
	| ({ type: "journal_entry"; entry: SessionEntry } & SessionJournalIdentity);

/** Persistence acknowledgements and native pointer changes, independent of any transport. */
export class SessionJournalEvents {
	readonly #read: () => SessionJournalIdentity;
	readonly #listeners = new Set<(event: SessionJournalEvent) => void>();
	#durable = new WeakSet<SessionEntry>();
	#previous: SessionJournalIdentity | undefined;
	#rawFile: string | null | undefined;
	#canonicalFile: string | null = null;

	constructor(read: () => SessionJournalIdentity) {
		this.#read = read;
	}

	subscribe(listener: (event: SessionJournalEvent) => void): () => void {
		if (this.#listeners.size === 0) this.#previous = this.identity();
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	identity(): SessionJournalIdentity {
		const identity = this.#read();
		if (identity.sessionFile !== this.#rawFile) {
			this.#rawFile = identity.sessionFile;
			this.#canonicalFile = identity.sessionFile
				? resolveEquivalentPath(path.join(resolveEquivalentPath(path.dirname(identity.sessionFile)), path.basename(identity.sessionFile)))
				: null;
		}
		return { ...identity, sessionFile: this.#canonicalFile };
	}

	state(): void {
		if (this.#listeners.size === 0) return;
		const identity = this.identity();
		const previous = this.#previous;
		this.#previous = identity;
		if (!previous || previous.sessionId !== identity.sessionId || previous.sessionFile !== identity.sessionFile) {
			this.#emit({ type: "journal_state", reason: "identity", ...identity });
		} else if (previous.leafId !== identity.leafId) {
			this.#emit({ type: "journal_state", reason: "leaf", ...identity });
		}
	}

	isDurable(entry: SessionEntry): boolean {
		return this.#durable.has(entry);
	}

	/** Loaded records need no replay; a subscriber gets its initial history from native paging. */
	loaded(entries: readonly SessionEntry[]): void {
		this.#durable = new WeakSet(entries);
		this.state();
	}

	committed(entry: SessionEntry): void {
		if (this.#durable.has(entry)) return;
		this.#durable.add(entry);
		if (this.#listeners.size === 0) return;
		this.state();
		this.#emit({ type: "journal_entry", ...this.identity(), entry });
	}

	#emit(event: SessionJournalEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("Session journal observer failed", { error: String(error) });
			}
		}
	}
}
