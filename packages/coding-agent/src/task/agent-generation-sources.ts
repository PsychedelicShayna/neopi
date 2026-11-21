import * as path from "node:path";
import type { AgentGenerationSource } from "@oh-my-pi/pi-tui/overlays/agent-definition-fields";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { NamedAdvisor } from "../advisor/config";
import { loadCapability } from "../capability";
import { contextFileCapability } from "../capability/context-file";
import { instructionCapability } from "../capability/instruction";
import { ruleCapability } from "../capability/rule";
import { slashCommandCapability } from "../capability/slash-command";
import { systemPromptCapability } from "../capability/system-prompt";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { resolveContainedPath } from "../discovery/contained-path";
import type { Skill } from "../extensibility/skills";
import { createLivePersonaFeature } from "../live/personas";
import { BUILTIN_PERSONALITIES } from "../neopi/personalities";
import { listCustomPersonalities } from "../neopi/personality-settings";
import { personaFeature } from "../neopi/persona";
import { previewBuiltinPersonality } from "../system-prompt";
import { serializeAgentDefinitionDocument } from "./agent-definition-document";
import type { AgentDefinition } from "./types";

type SkillReference = Pick<Skill, "name"> & Partial<Pick<Skill, "description" | "filePath" | "containRoot">>;

interface AuthoringDocument {
	_source: SourceMeta;
	path: string;
	content: string;
	name?: string;
	description?: string;
}

// Prose authored for the harness. Operational configuration capabilities
// (settings, MCP, SSH, executable extensions) aren't authoring documents.
const DOCUMENT_CAPABILITIES = [
	[contextFileCapability.id, "context-file"],
	[instructionCapability.id, "instruction"],
	[ruleCapability.id, "rule"],
	[slashCommandCapability.id, "slash-command"],
	[systemPromptCapability.id, "system-prompt"],
] as const;

async function readSource(
	metadata: Omit<AgentGenerationSource, "content">,
	read: () => Promise<string>,
): Promise<AgentGenerationSource | undefined> {
	try {
		const content = await read();
		if (content.trim()) return { ...metadata, content };
	} catch (error) {
		logger.warn("Cannot read agent generation reference", {
			kind: metadata.kind,
			name: metadata.name,
			error: String(error),
		});
	}
	return undefined;
}

/** Discover local reference material; only selections are forwarded to the author model. */
export async function listAgentGenerationSources(options: {
	cwd: string;
	settings: Settings;
	extensionRoots: EffectiveExtensionRoots;
	agents: () => Promise<readonly AgentDefinition[]>;
	advisors: () => Promise<readonly NamedAdvisor[]>;
	promptTemplates: readonly PromptTemplate[];
	skills: readonly SkillReference[];
}): Promise<AgentGenerationSource[]> {
	const personas = personaFeature();
	const [agents, advisors, sessionPersonas, livePersonas, documents] = await Promise.all([
		options.agents(),
		options.advisors(),
		personas.data(""),
		createLivePersonaFeature().data(),
		Promise.all(
			DOCUMENT_CAPABILITIES.map(async ([id, kind]) => {
				const { items } = await loadCapability<AuthoringDocument>(id, {
					cwd: options.cwd,
					agentDir: getAgentDir(),
					extensionRoots: options.extensionRoots,
				});
				return items
					.filter(item => item.content.trim())
					.map(item => ({
						kind,
						name: item.name ?? path.basename(item.path),
						description: `${item._source.level} · ${item.description || item.path}`,
						content: item.content,
					}));
			}),
		),
	]);
	const fileBacked = await Promise.all([
		...BUILTIN_PERSONALITIES.filter(name => name !== "none").map(name =>
			readSource({ kind: "personality", name, description: "Built-in" }, () =>
				previewBuiltinPersonality(name, options.cwd),
			),
		),
		...sessionPersonas.items.map(({ name, definition }) =>
			readSource({ kind: "persona", name, description: `Session persona · ${definition.mode}` }, () =>
				personas.instructions(name),
			),
		),
		...options.skills.flatMap(({ name, description, filePath, containRoot }) =>
			filePath
				? [
						readSource({ kind: "skill", name, description }, async () => {
							if (!containRoot) return Bun.file(filePath).text();
							const resolved = await resolveContainedPath(containRoot, filePath);
							if (resolved.status !== "ok")
								throw new Error(`Cannot resolve contained skill file (${resolved.status})`);
							return Bun.file(resolved.realPath).text();
						}),
					]
				: [],
		),
	]);
	return [
		...agents.map(agent => ({
			kind: "agent",
			name: agent.name,
			description: `${agent.source} · ${agent.description}`,
			content: serializeAgentDefinitionDocument(agent),
		})),
		...advisors.map(({ name, scope, config }) => ({
			kind: "advisor",
			name,
			description: scope,
			content: JSON.stringify(config, null, 2),
		})),
		...listCustomPersonalities(options.settings).map(({ name, scope, prompt }) => ({
			kind: "personality",
			name,
			description: scope,
			content: prompt,
		})),
		...livePersonas.items
			.filter(item => item.instructions.trim())
			.map(({ name, instructions }) => ({
				kind: "persona",
				name,
				description: "Live voice persona",
				content: instructions,
			})),
		...options.promptTemplates.map(({ name, description, content, source }) => ({
			kind: "prompt",
			name,
			description: `${source} ${description}`,
			content,
		})),
		...documents.flat(),
		...fileBacked.filter(source => source !== undefined),
	];
}
