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
export async function retainMixtureCatalog(owner: string, ctx: MixtureRegistrationContext): Promise<MixtureScope> {
	const scope = MixtureCatalog.for(ctx.registry).scope(ctx.cwd, ctx.agentDir);
	scope.retain(owner);
	if (!scope.hasRoster) scope.setRoster(await discoverRegistrableMixtures(ctx));
	return scope;
}
