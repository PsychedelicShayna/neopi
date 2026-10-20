import { completeSimple } from "@oh-my-pi/pi-ai";
import type { PersonaGenerationDeps, PersonaConfigDoc } from "@oh-my-pi/pi-tui/overlays/persona-config";
import type { ModelBrowserSource } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { compilePromptAsset, renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import { personaFeature, type PersonaFeature } from "../neopi/persona";
import generationSystem from "./prompts/generate-persona.md" with { type: "text" };
import generationUser from "./prompts/generate-persona-user.md" with { type: "text" };

interface Reference {
	id: string;
	label: string;
	instructions: () => Promise<string>;
}

/** Keep file-backed instructions lazy: only explicitly selected references are read. */
async function catalogue(
	doc: PersonaConfigDoc,
	personas: PersonaFeature,
	templates: readonly PromptTemplate[],
): Promise<Reference[]> {
	const ordinary = await personas.data("");
	return [
		...doc.entries.map((entry, index) => ({
			id: `live:${index}`,
			label: entry.builtin ? "Default live template" : `Live persona: ${entry.name}`,
			instructions: async () => entry.content,
		})),
		...ordinary.items.map(item => ({
			id: `persona:${item.name}`,
			label: `Persona: ${item.name}`,
			instructions: () => personas.instructions(item.name),
		})),
		...templates.map((template, index) => ({
			id: `prompt:${index}`,
			label: `Prompt: ${template.name} ${template.source}`,
			instructions: async () => template.content,
		})),
	];
}

/** Generation never mutates the active session or persists a persona before operator review. */
export function createLivePersonaGeneration(options: {
	registry: Pick<ModelRegistry, "getAvailable" | "resolver">;
	browserSource: ModelBrowserSource;
	templates: readonly PromptTemplate[];
	sessionId: string;
	personas?: PersonaFeature;
	cwd?: string;
}): PersonaGenerationDeps {
	const personas = options.personas ?? personaFeature();
	return {
		getAvailableModels: () => options.registry.getAvailable(),
		browserSource: options.browserSource,
		references: async doc =>
			(await catalogue(doc, personas, options.templates)).map(({ id, label }) => ({ id, label })),
		async generate({ model, references: selected, description, doc, signal }) {
			const available = await catalogue(doc, personas, options.templates);
			if (!selected.length) throw new Error("Select at least one reference prompt.");
			const references = await Promise.all(
				selected.map(async id => {
					const reference = available.find(item => item.id === id);
					if (!reference) throw new Error(`Reference no longer exists: ${id}`);
					return { label: reference.label, instructions: await reference.instructions() };
				}),
			);
			signal.throwIfAborted();
			const message = await completeSimple(
				model,
				{
					systemPrompt: [
						compilePromptAsset("live/generate-persona.md", generationSystem, { cwd: options.cwd })({}),
					],
					messages: [
						{
							role: "user",
							content: renderPromptAsset(
								"live/generate-persona-user.md",
								generationUser,
								{ description, references },
								{ cwd: options.cwd },
							),
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: options.registry.resolver(model),
					sessionId: options.sessionId,
					signal,
					maxTokens: 8192,
				},
			);
			if (message.stopReason === "error" || message.stopReason === "aborted")
				throw new Error(message.errorMessage ?? "Persona generation failed.");
			if (message.stopReason === "length")
				throw new Error("Persona generation exceeded the output limit. Try a shorter description.");
			const text = message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n")
				.trim();
			if (!text) throw new Error("Generator returned empty instructions.");
			return text;
		},
	};
}
