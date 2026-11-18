import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { createDefinitionGenerator } from "../task/definition-generation";
import systemTemplate from "../prompts/advisor/generate-system.md" with { type: "text" };
import requestTemplate from "../prompts/advisor/generate-request.md" with { type: "text" };
import { advisorDefinitionJsonSchema, parseInlineAdvisorConfig } from "./config";

export function createAdvisorGenerator(options: {
	settings: Settings;
	modelRegistry: ModelRegistry;
	cwd: string;
	availableToolNames: readonly string[];
}) {
	const generator = createDefinitionGenerator<AdvisorConfig>({
		settings: options.settings,
		modelRegistry: options.modelRegistry,
		cwd: options.cwd,
		schema: advisorDefinitionJsonSchema,
		validateFields: fields => { parseInlineAdvisorConfig(fields); },
		systemPrompt: () => renderPromptAsset("advisor/generate-system.md", systemTemplate, {
			schema: JSON.stringify(advisorDefinitionJsonSchema(), null, 2),
			tools: options.availableToolNames,
		}),
		requestPrompt: request => renderPromptAsset("advisor/generate-request.md", requestTemplate, {
			bases: JSON.stringify(request.baseDefinitions ?? [], null, 2),
			comment: request.comment ?? "",
			definition: JSON.stringify(request.definition, null, 2),
		}),
	});
	return {
		async generate(bases: readonly AdvisorConfig[], comment: string, signal: AbortSignal): Promise<AdvisorConfig> {
			const result = await generator.generate({ definition: {}, target: "all", baseDefinitions: bases, comment, signal });
			return parseInlineAdvisorConfig(result.fields);
		},
		dispose: () => generator.dispose(),
	};
}
