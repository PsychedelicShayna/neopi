import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { isRecord } from "@oh-my-pi/pi-utils";
import generationSystem from "../prompts/system/agent-fields-system.md" with { type: "text" };
import generationUser from "../prompts/system/agent-fields-user.md" with { type: "text" };
import { buildOutputValidator } from "../tools/output-schema-validator";
import {
	createDefinitionGenerator,
	type DefinitionGenerationRequest,
	type DefinitionGenerationResult,
	type DefinitionGeneratorOptions,
} from "./definition-generation";
import type { AgentDefinition } from "./types";

export type AgentGenerationDefinition = Omit<AgentDefinition, "source" | "filePath">;
export type AgentFieldGenerationRequest = DefinitionGenerationRequest<AgentGenerationDefinition>;
export type AgentFieldGenerationResult = DefinitionGenerationResult<AgentGenerationDefinition>;

export interface AgentFieldGenerator {
	generateAgentFields(request: AgentFieldGenerationRequest): Promise<AgentFieldGenerationResult>;
	dispose(): void;
}

export interface AgentGenerationTool {
	name: string;
	description: string;
}

export interface AgentGenerationAdvisor {
	name: string;
	scope: string;
}

export interface AgentFieldGeneratorOptions extends Omit<DefinitionGeneratorOptions<AgentGenerationDefinition>, "systemPrompt" | "requestPrompt" | "validateFields"> {
	/** The editor's canonical schema, including field descriptions and allowed values. */
	schema: () => Record<string, unknown>;
	/** Read all host registry tools, using the central toolSummary helper for descriptions. */
	tools: () => readonly AgentGenerationTool[];
	advisors?: () => Promise<readonly AgentGenerationAdvisor[]>;
}

/** One authoring API for field regeneration, whole definitions, and selected-reference mixes. */
export function createAgentFieldGenerator(options: AgentFieldGeneratorOptions): AgentFieldGenerator {
	const schema = (): Record<string, unknown> => {
		const declared = options.schema();
		const properties = isRecord(declared.properties) ? declared.properties : {};
		const tools = options.tools();
		return {
			...declared,
			properties: {
				...properties,
				...(isRecord(properties.tools) && tools.length ? {
					tools: { ...properties.tools, type: "array", items: { type: "string", enum: tools.map(tool => tool.name) } },
				} : {}),
			},
		};
	};
	const generator = createDefinitionGenerator<AgentGenerationDefinition>({
		...options,
		schema,
		validateFields: fields => {
			if (fields.output !== undefined) {
				const validation = buildOutputValidator(fields.output);
				if (validation.error) throw new Error(`Invalid generated output schema: ${validation.error}`);
			}
		},
		systemPrompt: async () => renderPromptAsset("system/agent-fields-system.md", generationSystem, {
			fieldSchema: JSON.stringify(schema(), null, 2),
			tools: options.tools(),
			advisors: await options.advisors?.() ?? [],
		}, { cwd: options.cwd }),
		requestPrompt: request => renderPromptAsset("system/agent-fields-user.md", generationUser, {
			target: request.target,
			definition: JSON.stringify(request.definition, null, 2),
			comment: request.comment,
			baseDefinitions: request.baseDefinitions?.map(definition => ({
				name: definition.name,
				definition: JSON.stringify(definition, null, 2),
			})),
		}, { cwd: options.cwd }),
	});
	return {
		generateAgentFields: (request: AgentFieldGenerationRequest): Promise<AgentFieldGenerationResult> => generator.generate(request),
		dispose: () => generator.dispose(),
	};
}
