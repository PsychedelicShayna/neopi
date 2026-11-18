import { getModelMatchPreferences, resolveCliModel, type ResolveCliModelResult } from "./model-resolver";
import type { Settings } from "./settings";
import type { AgentSession } from "../session/agent-session";

/**
 * Resolve a `/model` / `/switch` selector the way `npi bench` and `--model`
 * do: exact `provider/id`, fuzzy ids (`opus`), role aliases (`@smol`, `smol`),
 * and `:level` thinking suffixes. Unqualified selectors prefer the session's
 * `--models` scope, else the authenticated set, before the full catalog.
 */
export function resolveSessionModelSelector(
	selector: string,
	session: Pick<AgentSession, "scopedModels" | "modelRegistry">,
	settings: Settings,
): ResolveCliModelResult {
	const scoped = session.scopedModels.map(entry => entry.model);
	return resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
}
