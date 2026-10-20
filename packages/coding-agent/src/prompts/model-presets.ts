import { resolveCascade } from "@oh-my-pi/pi-catalog/compat/cascade";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import opus5 from "./model-families/opus-5.md" with { type: "text" };

const presets = new Map([["opus-5", { id: "model-families/opus-5.md", bundled: opus5 }]]);

/** KDL owns selection; the registry maps preset names to inspectable prompt assets. */
export function resolveModelPreset(model: Model | undefined) {
	if (!model) return undefined;
	const identity = classifyModel(model.provider, model.id);
	const selected = resolveCascade({
		provider: model.provider,
		api: model.api,
		model: model.id,
		reasoning: Boolean(model.reasoning),
		class: identity.class,
		family: identity.family,
		revision: identity.revision,
	}).catalog.behavioralPreset;
	if (typeof selected !== "string" || selected === "none") return undefined;
	const preset = presets.get(selected);
	if (!preset) throw new Error(`Unknown model behavioral preset: ${selected}`);
	return {
		...preset,
		context: {
			modelClass: identity.class,
			modelFamily: identity.family ?? "",
			modelRevision: identity.revision ?? "",
		},
	};
}

export function renderModelPreset(model: Model | undefined, cwd: string): string {
	const preset = resolveModelPreset(model);
	return preset ? renderPromptAsset(preset.id, preset.bundled, preset.context, { cwd }).trim() : "";
}
