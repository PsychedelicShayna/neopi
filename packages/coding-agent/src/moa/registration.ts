/**
 * Discovery to registration: every discovered mixture is resolved and
 * validated; one with errors (or refused by the capability gate) is logged
 * and never becomes a selectable model.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { discoverMixtures } from "./config";
import { MixtureCatalog, type MixtureScope } from "./provider";
import { resolveMixture } from "./resolve";
import type { ResolvedMixture } from "./types";
import { validateMixture } from "./validate";

export interface MixtureRegistrationContext {
	cwd: string;
	agentDir?: string;
	registry: ModelRegistry;
	settings: Settings;
}

/** Discover, resolve, and validate; returns the mixtures that may be registered. */
export async function discoverRegistrableMixtures(ctx: MixtureRegistrationContext): Promise<ResolvedMixture[]> {
	const discovered = await discoverMixtures(ctx.cwd, ctx.agentDir);
	const names = discovered.mixtures.map(entry => entry.definition.name);
	const registrable: ResolvedMixture[] = [];
	for (const entry of discovered.mixtures) {
		const resolved = resolveMixture(entry.definition, {
			registry: ctx.registry,
			settings: ctx.settings,
			preparedPresets: entry.preparedPresets,
		});
		const { errors, warnings } = validateMixture(resolved, { settings: ctx.settings, names });
		const mixture = entry.definition.name;
		for (const issue of warnings) {
			logger.warn("Mixture definition warning", { mixture, file: entry.path, ...issue });
		}
		if (errors.length > 0) {
			for (const issue of errors) {
				logger.warn("Mixture refused at registration", { mixture, file: entry.path, ...issue });
			}
			continue;
		}
		registrable.push(resolved);
	}
	return registrable;
}

/**
 * Hold the workspace's scope of the registry's catalog for `owner`; the scope's first
 * holder discovers and registers that workspace's roster. If discovery, resolution,
 * validation, or registration throws, the hold is dropped before the error propagates,
 * so a failed retain leaves no owner behind.
 */
async function retainScope(
	owner: string,
	ctx: MixtureRegistrationContext,
	restoredRoster?: readonly ResolvedMixture[],
): Promise<MixtureScope> {
	const scope = MixtureCatalog.for(ctx.registry).scope(ctx.cwd, ctx.agentDir);
	scope.retain(owner);
	try {
		await scope.initializeRoster(owner, () =>
			restoredRoster !== undefined ? Promise.resolve(restoredRoster) : discoverRegistrableMixtures(ctx),
		);
	} catch (error) {
		try {
			scope.release(owner);
		} catch (cleanupError) {
			logger.warn("Mixture scope cleanup failed after retain error", {
				scope: scope.key,
				cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
	return scope;
}

/**
 * A session's hold on the catalog scope of the workspace it runs in. The scope follows
 * the session's cwd: a relocation ({@link rebind}) retains the destination's scope and
 * releases the source's, so the session only ever runs its current workspace's mixtures.
 */
export class MixtureWorkspace {
	readonly #owner: string;
	/** `cwd` is the workspace currently held. */
	#ctx: MixtureRegistrationContext;
	#scope: MixtureScope;
	/** A failed rollback can leave this workspace without its source owner. */
	#held = true;
	#released = false;
	#sourceRoster: readonly ResolvedMixture[] | undefined;

	private constructor(owner: string, ctx: MixtureRegistrationContext, scope: MixtureScope) {
		this.#owner = owner;
		this.#ctx = ctx;
		this.#scope = scope;
	}

	static async retain(owner: string, ctx: MixtureRegistrationContext): Promise<MixtureWorkspace> {
		return new MixtureWorkspace(owner, ctx, await retainScope(owner, ctx));
	}

	/** The scope of the workspace the session is in now. */
	get scope(): MixtureScope {
		return this.#scope;
	}
	/**
	 * Move the hold to `cwd`'s scope, discovering it under the current settings if no one
	 * holds it yet. Release the source first to avoid a false name.scope_conflict.
	 * On failure restore the source's resolved roster without rediscovery under
	 * destination settings. Returns whether the scope changed.
	 */
	async rebind(cwd: string): Promise<boolean> {
		if (this.#released) throw new Error("Cannot rebind a released mixture workspace");
		const source = this.#ctx;
		const next = MixtureCatalog.for(source.registry).scope(cwd, source.agentDir);
		if (next.key === this.#scope.key) {
			if (!this.#held) {
				this.#scope = await retainScope(this.#owner, source, this.#sourceRoster);
				this.#held = true;
				this.#sourceRoster = undefined;
			}
			return false;
		}
		// Keep the resolved roster even if both the move and immediate restoration fail:
		// the caller retries the source after restoring its settings.
		this.#sourceRoster ??= this.#scope.roster();
		try {
			// release may remove the owner and then throw while registering the remaining scopes.
			this.#held = false;
			this.#scope.release(this.#owner);
			const destination = await retainScope(this.#owner, { ...source, cwd });
			this.#scope = destination;
			this.#ctx = { ...source, cwd };
			this.#held = true;
			this.#sourceRoster = undefined;
		} catch (error) {
			try {
				this.#scope = await retainScope(this.#owner, source, this.#sourceRoster);
				this.#held = true;
				this.#sourceRoster = undefined;
			} catch (restoreError) {
				logger.warn("Mixture source scope restoration failed after rebind error", {
					from: source.cwd,
					to: cwd,
					restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
				});
			}
			logger.warn("Mixture workspace rebind failed; attempted to keep the previous workspace", {
				from: source.cwd,
				to: cwd,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		return true;
	}

	/** Drop the hold; releasing twice is harmless and never restores a failed move. */
	release(): void {
		if (this.#released) return;
		this.#released = true;
		this.#sourceRoster = undefined;
		if (!this.#held) return;
		this.#held = false;
		this.#scope.release(this.#owner);
	}
}
