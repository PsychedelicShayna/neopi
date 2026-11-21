import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import {
	createModelMentionSource,
	type ModelMentionCandidateSource,
} from "@oh-my-pi/pi-tui/prompt/model-mention-autocomplete";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { formatModelRoleAlias, getKnownRoleIds } from "../config/model-roles";
import { cfgCycleOrder } from "../config/model-settings";
import { resolveSessionModelSelector } from "../config/session-model-selector";
import { createModelBrowserSource } from "../modes/model-browser-source";
import type { InteractiveModeContext } from "../modes/types";
import type { TuiSlashCommandRuntime } from "./types";

const modelSources = new WeakMap<InteractiveModeContext["session"], ModelMentionCandidateSource>();

function modelSource(ctx: InteractiveModeContext) {
	const { session } = ctx;
	let source = modelSources.get(session);
	if (!source) {
		source = createModelMentionSource({
			source: createModelBrowserSource(ctx.settings, model => session.effectiveServiceTier(model)),
			registry: session.modelRegistry,
			scopedModels: () => session.scopedModels.map(entry => entry.model),
		});
		modelSources.set(session, source);
	}
	return source;
}

/** Complete a model, role, or supported effort suffix. Shared with commands that embed a selector. */
export function buildModelSelectorCompletions(
	runtime: TuiSlashCommandRuntime,
): (prefix: string) => AutocompleteItem[] | null {
	return prefix => {
		if (/\s/.test(prefix)) return null;
		const { ctx } = runtime;
		const { session, settings } = ctx;
		const lower = prefix.toLowerCase();
		const items: AutocompleteItem[] = [];
		const add = (selector: string, description?: string, label = selector) => {
			items.push({ value: `${selector} `, label, description, submitsCommand: true });
		};
		const colon = prefix.lastIndexOf(":");
		if (prefix.startsWith("@")) {
			if (colon === -1) {
				for (const role of new Set([...cfgCycleOrder.get(settings), ...getKnownRoleIds(settings)])) {
					const configured = settings.getModelRole(role);
					if (!configured) continue;
					const alias = formatModelRoleAlias(role);
					if (alias.toLowerCase().includes(lower)) add(alias, configured);
				}
			}
		} else {
			const rankModels = modelSource(ctx);
			void rankModels.retryDiscovery?.();
			for (const { selector, model } of rankModels(prefix)) {
				// A colon can belong to a literal model ID. Keep those matches before suffixes.
				if (colon === -1 || selector.toLowerCase().startsWith(lower) || model.id.toLowerCase().startsWith(lower)) {
					add(selector, model.name);
				}
			}
		}
		if (colon > 0) {
			const base = prefix.slice(0, colon);
			const query = lower.slice(colon + 1);
			const { model } = resolveSessionModelSelector(base, session, settings);
			if (model?.reasoning) {
				for (const level of ["off", AUTO_THINKING, ...getSupportedEfforts(model)] as const) {
					if (!level.startsWith(query)) continue;
					const selector = `${base}:${level}`;
					// The resolver gives an exact literal ID priority over an effort suffix.
					if (resolveSessionModelSelector(selector, session, settings).thinkingLevel !== level) continue;
					add(selector, getConfiguredThinkingLevelMetadata(level).description, `:${level}`);
				}
			}
		}
		return items.length > 0 ? items : null;
	};
}
