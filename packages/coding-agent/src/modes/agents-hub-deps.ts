import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model, ServiceTier } from "@oh-my-pi/pi-ai";
import type { AgentsHubDeps } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import type { AgentDefinitionDraft, NamedAgentAdvisor } from "@oh-my-pi/pi-tui/overlays/agent-definition-fields";
import { agentDefinitionFieldSchema } from "@oh-my-pi/pi-tui/overlays/agent-definition-fields";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { listNamedAdvisors } from "../advisor/config";
import type { EffectiveExtensionRoots } from "../capability/types";
import { getConfigDirs } from "../config";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import type { ModelRegistry } from "../config/model-registry";
import {
	resolveAgentAdvisorSelection,
	resolveAgentModelPatterns,
	resolveAgentPrewalkPattern,
	resolveModelOverride,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { refreshAgentDiscovery } from "../task";
import { createAgentFieldGenerator } from "../task/agent-generation";
import { listAgentGenerationSources } from "../task/agent-generation-sources";
import { parseAgentDefinitionDocument, serializeAgentDefinitionDocument } from "../task/agent-definition-document";
import { inspectAgentDefinition } from "../task/agent-definition-inspection";
import { discoverAgents } from "../task/discovery";
import { resolveAgentPrewalkDefault } from "../task/prewalk";
import { READ_ONLY_TOOL_NAMES } from "../task/read-only-policy";
import { listAgentDefinitionTools } from "../tools/tool-catalog";
import {
	cfgTaskAgentAdvisor,
	cfgTaskAgentModelOverrides,
	cfgTaskAgentPrewalk,
	cfgTaskDisabledAgents,
	cfgTaskMaxRecursionDepth,
	cfgTaskPrewalk,
} from "../task/settings";
import { createModelBrowserSource } from "./model-browser-source";
import { isJTDSchema } from "../tools/jtd-to-json-schema";

export function createAgentsHubDeps(
	cwd: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	extensionRoots: () => EffectiveExtensionRoots,
	activeModelPattern?: string,
	defaultModelPattern?: string,
	sessionServiceTier?: (model: Model) => ServiceTier | undefined,
	editorContext?: {
		tools: () => readonly { name: string; description: string }[];
		sessionDir: () => string | undefined;
		skills?: () => readonly { name: string; description?: string; filePath?: string; containRoot?: string }[];
		promptTemplates?: () => readonly PromptTemplate[];
		externalEditor?: (text: string) => Promise<string | null>;
	},
): AgentsHubDeps {
	const tools = () => listAgentDefinitionTools(editorContext?.tools() ?? []);
	const skills = () => editorContext?.skills?.() ?? [];
	const roles = () =>
		getKnownRoleIds(settings).flatMap(id => {
			const info = getRoleInfo(id, settings);
			return info.hidden ? [] : [{ id, label: info.name, description: info.description }];
		});
	// Inspection runs on every keystroke; it reads the last discovery and advisor catalog instead of rescanning.
	let knownAgents: readonly (AgentDefinitionDraft & { source: string })[] = [];
	let advisorCache: readonly NamedAgentAdvisor[] | undefined;
	const listAdvisors = async () => {
		const advisors = await listNamedAdvisors(cwd, getAgentDir(), editorContext?.sessionDir());
		advisorCache = advisors;
		return advisors;
	};
	void listAdvisors().catch(() => undefined);
	const modelPatterns = (name: string, model: string[] | undefined) => {
		const override = cfgTaskAgentModelOverrides.get(settings)[name];
		return resolveAgentModelPatterns({
			settingsOverride: (Array.isArray(override) ? override.join(",") : override)?.trim() || undefined,
			agentModel: model,
			settings,
			activeModelPattern,
			fallbackModelPattern: defaultModelPattern,
		});
	};
	const resolvePatterns = (patterns: string[]): string | undefined => {
		if (!patterns.length) return undefined;
		const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(patterns, modelRegistry, settings);
		return model
			? `${model.provider}/${model.id}${explicitThinkingLevel && thinkingLevel ? `:${thinkingLevel}` : ""}`
			: undefined;
	};
	const advisorLabel = (advisor: AgentDefinitionDraft["advisor"], override: string | undefined) => {
		const selection = resolveAgentAdvisorSelection({ settingsOverride: override, agentAdvisor: advisor });
		return selection?.definition
			? "ref" in selection.definition
				? selection.definition.ref
				: selection.definition.inline.name
			: selection
				? (selection.model ?? "@advisor")
				: undefined;
	};
	const generator = createAgentFieldGenerator({
		settings,
		modelRegistry,
		cwd,
		activeModelPattern,
		defaultModelPattern,
		schema: () => agentDefinitionFieldSchema,
		tools,
		advisors: listAdvisors,
		agents: () => knownAgents,
		skills,
		roles,
		readOnlyTools: READ_ONLY_TOOL_NAMES,
		maxRecursionDepth: () => cfgTaskMaxRecursionDepth.get(settings),
	});
	return {
		browserSource: createModelBrowserSource(settings, sessionServiceTier),
		loadAgents: async () => {
			const { agents } = await discoverAgents(cwd, undefined, extensionRoots());
			const disabled = new Set(cfgTaskDisabledAgents.get(settings));
			const overrides = cfgTaskAgentModelOverrides.get(settings);
			const prewalkOverrides = cfgTaskAgentPrewalk.get(settings);
			const advisorOverrides = cfgTaskAgentAdvisor.get(settings);
			const loaded = await Promise.all(
				agents.map(async agent => {
					const override = overrides[agent.name];
					const definition =
						agent.source !== "bundled" && agent.filePath
							? parseAgentDefinitionDocument(await Bun.file(agent.filePath).text())
							: agent;
					return {
						...agent,
						...definition,
						disabled: disabled.has(agent.name),
						overrideModel: (Array.isArray(override) ? override.join(",") : override)?.trim() || undefined,
						prewalkOverride: prewalkOverrides[agent.name]?.trim() || undefined,
						advisorOverride: advisorOverrides[agent.name]?.trim() || undefined,
					};
				}),
			);
			knownAgents = loaded;
			return loaded;
		},
		getAvailableModels: () => modelRegistry.getAvailable(),
		effectiveModelPatterns: agent => modelPatterns(agent.name, agent.model),
		resolvePatterns,
		effectivePrewalkPattern: agent =>
			resolveAgentPrewalkPattern({
				settingsOverride: agent.prewalkOverride,
				agentPrewalk: resolveAgentPrewalkDefault(agent, cfgTaskPrewalk.get(settings)),
			}),
		effectiveAdvisorPattern: agent => advisorLabel(agent.advisor, agent.advisorOverride),
		setAgentDisabled: (name, { disabled }) => cfgTaskDisabledAgents.setMember(settings, name, { member: disabled }),
		setAgentOverride: (property, name, value) => {
			const setting =
				property === "model"
					? cfgTaskAgentModelOverrides
					: property === "prewalk"
						? cfgTaskAgentPrewalk
						: cfgTaskAgentAdvisor;
			if (property !== "model") {
				setting.setEntry(settings, name, value);
				return;
			}
			const active = cfgTaskAgentModelOverrides.get(settings);
			cfgTaskAgentModelOverrides.setEntry(settings, name, value);
			cfgTaskAgentModelOverrides.clearOverride(settings);
			const persisted = cfgTaskAgentModelOverrides.get(settings);
			const picks = Object.entries(active).filter(
				([agent, pick]) => agent !== name && JSON.stringify(pick) !== JSON.stringify(persisted[agent]),
			);
			if (picks.length)
				cfgTaskAgentModelOverrides.override(settings, { ...persisted, ...Object.fromEntries(picks) });
		},
		editor: {
			get tools() {
				return tools();
			},
			readOnlyTools: [...READ_ONLY_TOOL_NAMES],
			get roles() {
				return roles();
			},
			get skills() {
				return skills();
			},
			listAdvisors,
			listGenerationSources: () =>
				listAgentGenerationSources({
					cwd,
					settings,
					extensionRoots: extensionRoots(),
					agents: async () => (await discoverAgents(cwd, undefined, extensionRoots())).agents,
					advisors: listAdvisors,
					promptTemplates: editorContext?.promptTemplates?.() ?? [],
					skills: skills(),
				}),
			parse: parseAgentDefinitionDocument,
			serialize: serializeAgentDefinitionDocument,
			generate: request => generator.generateAgentFields(request),
			externalEditor: editorContext?.externalEditor,
			outputSchemaDialect: schema => (isJTDSchema(schema) ? "jtd" : "json-schema"),
		},
		inspectDefinition: (definition, original) => {
			const prewalkOverrides = cfgTaskAgentPrewalk.get(settings);
			const advisorOverrides = cfgTaskAgentAdvisor.get(settings);
			const modelOverride = cfgTaskAgentModelOverrides.get(settings)[definition.name];
			const toolNames = new Set(tools().map(tool => tool.name));
			const skillNames = editorContext?.skills ? new Set(skills().map(skill => skill.name)) : undefined;
			return inspectAgentDefinition(definition, {
				known: knownAgents,
				originalName: original?.name,
				toolNames,
				skillNames,
				advisors: advisorCache,
				modelPatterns: draft => modelPatterns(draft.name, draft.model),
				resolveModel: resolvePatterns,
				prewalkTarget: draft =>
					resolveAgentPrewalkPattern({
						settingsOverride: prewalkOverrides[draft.name]?.trim() || undefined,
						agentPrewalk: resolveAgentPrewalkDefault(
							{ ...draft, source: original?.source ?? "project" },
							cfgTaskPrewalk.get(settings),
						),
					}),
				advisorSummary: draft => advisorLabel(draft.advisor, advisorOverrides[draft.name]?.trim() || undefined),
				overrides: name => ({
					model: (Array.isArray(modelOverride) ? modelOverride.join(",") : modelOverride)?.trim() || undefined,
					prewalk: prewalkOverrides[name]?.trim() || undefined,
					advisor: advisorOverrides[name]?.trim() || undefined,
				}),
				maxRecursionDepth: cfgTaskMaxRecursionDepth.get(settings),
			});
		},
		deleteDefinition: async agent => {
			if (agent.source === "bundled" || !agent.filePath) throw new Error("Bundled agents have no file to delete.");
			await fs.rm(agent.filePath);
			await refreshAgentDiscovery(cwd, extensionRoots());
		},
		dispose: () => generator.dispose(),
		saveDefinition: async (scope, definition, original) => {
			if (/[\\/\0]/.test(definition.name))
				throw new Error("Agent names cannot contain path separators or NUL characters.");
			const raw = serializeAgentDefinitionDocument(definition);
			parseAgentDefinitionDocument(raw);
			const existing = original?.source !== "bundled" ? original?.filePath : undefined;
			const targetDir = getConfigDirs("agents", { user: scope === "user", project: scope === "project", cwd }).find(
				dir => dir.source === ".omp",
			)?.path;
			if (!existing && !targetDir) throw new Error(`Cannot resolve ${scope} agents directory.`);
			const filePath = existing ?? path.join(targetDir!, `${definition.name}.md`);
			if (!existing) {
				try {
					await fs.stat(filePath);
					throw new Error(`Agent file already exists: ${shortenPath(filePath)}`);
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
			await Bun.write(filePath, raw);
			await refreshAgentDiscovery(cwd, extensionRoots());
			return filePath;
		},
	};
}
