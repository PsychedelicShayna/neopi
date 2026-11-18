/**
 * Accumulated active-processing time of one session: the sum of its completed
 * `agent_start`→`agent_end` windows plus the window that is open now. Idle time
 * between turns never counts. The `time_spent` status segment and the RPC
 * `get_state.activeTimeMs` read the same arithmetic.
 *
 * `sessionFile` snapshots the loaded session-file path. A session object can
 * switch conversations in place (`/resume`, `/move`, fork, RPC `switch_session`),
 * so {@link follows} tells a real-to-real file change from the undefined → real
 * first save, which keeps the same conversation.
 */
export class ActiveTimeMeter {
	#activeMs = 0;
	#startedAt: number | null = null;
	#sessionFile: string | undefined;

	constructor(sessionFile?: string) {
		this.#sessionFile = sessionFile;
	}

	/** An activity window is open. */
	get running(): boolean {
		return this.#startedAt !== null;
	}

	/** Open a window; a second start while one is open is a no-op, so reentrant `agent_start`s do not double-count. */
	start(now: number = Date.now()): boolean {
		if (this.#startedAt !== null) return false;
		this.#startedAt = now;
		return true;
	}

	/** Fold the open window into the total; idempotent while idle. */
	end(now: number = Date.now()): boolean {
		if (this.#startedAt === null) return false;
		this.#activeMs += Math.max(0, now - this.#startedAt);
		this.#startedAt = null;
		return true;
	}

	/** Discard the open window without crediting it (the agent finished at a moment nobody observed). */
	dropWindow(): void {
		this.#startedAt = null;
	}

	/** Zero the total and drop any open window. Returns whether anything was recorded. */
	reset(): boolean {
		if (this.#activeMs === 0 && this.#startedAt === null) return false;
		this.#activeMs = 0;
		this.#startedAt = null;
		return true;
	}

	/** Total active milliseconds, including the open window. */
	total(now: number = Date.now()): number {
		return this.#startedAt === null ? this.#activeMs : this.#activeMs + Math.max(0, now - this.#startedAt);
	}

	/** Milliseconds the open window has run, or null while idle. */
	windowElapsed(now: number = Date.now()): number | null {
		return this.#startedAt === null ? null : Math.max(0, now - this.#startedAt);
	}

	/**
	 * Note the session's current file. False when it is a different conversation from the one this meter
	 * counted (both files known and unequal), in which case the caller starts a fresh meter.
	 */
	follows(sessionFile: string | undefined): boolean {
		const switched =
			sessionFile !== undefined && this.#sessionFile !== undefined && this.#sessionFile !== sessionFile;
		if (!switched) this.#sessionFile = sessionFile;
		return !switched;
	}
}
