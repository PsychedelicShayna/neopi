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
			documentEnvelopes: entry.envelopes,
			documentRoles: entry.roles,
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
 * holder discovers and registers that workspace's roster.
 */
async function retainScope(owner: string, ctx: MixtureRegistrationContext): Promise<MixtureScope> {
	const scope = MixtureCatalog.for(ctx.registry).scope(ctx.cwd, ctx.agentDir);
	scope.retain(owner);
	if (!scope.hasRoster) scope.setRoster(await discoverRegistrableMixtures(ctx));
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
	 * holds it yet. The source is released first: while this session still held it, a
	 * destination defining the same name differently would be refused as a scope conflict.
	 * If the destination cannot be retained, the source is retained again before the error
	 * propagates. Returns whether the scope changed.
	 */
	async rebind(cwd: string): Promise<boolean> {
		const next = MixtureCatalog.for(this.#ctx.registry).scope(cwd, this.#ctx.agentDir);
		if (next.key === this.#scope.key) return false;
		const source = this.#ctx;
		this.#scope.release(this.#owner);
		try {
			this.#scope = await retainScope(this.#owner, { ...source, cwd });
			this.#ctx = { ...source, cwd };
		} catch (error) {
			this.#scope = await retainScope(this.#owner, source);
			logger.warn("Mixture workspace rebind failed; kept the previous workspace", {
				from: source.cwd,
				to: cwd,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		return true;
	}

	/** Drop the hold; releasing twice is harmless. */
	release(): void {
		this.#scope.release(this.#owner);
	}
}
