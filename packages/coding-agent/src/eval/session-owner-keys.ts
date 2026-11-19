import type { SessionOwners } from "./executor-base";

/**
 * Shared sessions stay shared until an owner resets a kernel it does not own
 * exclusively. Remember that fork until owner disposal, including while its
 * kernel is resetting, starting, or dead, so later calls cannot rejoin the parent.
 */
export class OwnerScopedSessionKeys {
	readonly #forksByOwner = new Map<string, Set<string>>();

	resolve(
		baseKey: string,
		ownerId: string | undefined,
		reset: boolean,
		getOwners: (key: string) => SessionOwners | undefined,
	): string {
		if (ownerId === undefined) return baseKey;
		const forks = this.#forksByOwner.get(ownerId);
		if (forks?.has(baseKey)) return OwnerScopedSessionKeys.forkKey(baseKey, ownerId);
		if (!reset) return baseKey;
		const base = getOwners(baseKey);
		if (!base || (!base.hasFallbackOwner && base.ownerIds.size === 1 && base.ownerIds.has(ownerId))) {
			return baseKey;
		}
		if (forks) forks.add(baseKey);
		else this.#forksByOwner.set(ownerId, new Set([baseKey]));
		return OwnerScopedSessionKeys.forkKey(baseKey, ownerId);
	}

	/** The key a forked owner's session lives under. */
	static forkKey(baseKey: string, ownerId: string): string {
		return `${baseKey}\0fork\0${ownerId}`;
	}

	/** Forget `ownerId`'s forks, except those whose base key `keep` accepts (sessions disposal is leaving alive). */
	disposeByOwner(ownerId: string, keep?: (baseKey: string) => boolean): void {
		const forks = this.#forksByOwner.get(ownerId);
		if (!forks) return;
		if (keep) {
			for (const baseKey of Array.from(forks)) if (!keep(baseKey)) forks.delete(baseKey);
			if (forks.size > 0) return;
		}
		this.#forksByOwner.delete(ownerId);
	}

	clear(): void {
		this.#forksByOwner.clear();
	}
}
