import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model, ServiceTier } from "@oh-my-pi/pi-ai";
import type { AgentsHubDeps } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { agentDefinitionFieldSchema } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { listNamedAdvisors } from "../advisor/config";
import type { EffectiveExtensionRoots } from "../capability/types";
import { getConfigDirs } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import { resolveAgentAdvisorSelection, resolveAgentModelPatterns, resolveAgentPrewalkPattern, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { refreshAgentDiscovery } from "../task";
import { createAgentFieldGenerator } from "../task/agent-generation";
import { parseAgentDefinitionDocument, serializeAgentDefinitionDocument } from "../task/agent-definition-document";
import { discoverAgents } from "../task/discovery";
import { resolveAgentPrewalkDefault } from "../task/prewalk";
import { listAgentDefinitionTools } from "../tools/tool-catalog";
import { cfgTaskAgentAdvisor, cfgTaskAgentModelOverrides, cfgTaskAgentPrewalk, cfgTaskDisabledAgents, cfgTaskPrewalk } from "../task/settings";
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
	editorContext?: { tools: () => readonly { name: string; description: string }[]; sessionDir: () => string | undefined; externalEditor?: (text: string) => Promise<string | null> },
): AgentsHubDeps {
	const tools = () => listAgentDefinitionTools(editorContext?.tools() ?? []);
	const listAdvisors = () => listNamedAdvisors(cwd, getAgentDir(), editorContext?.sessionDir());
	const generator = createAgentFieldGenerator({ settings, modelRegistry, cwd, activeModelPattern, defaultModelPattern, schema: () => agentDefinitionFieldSchema, tools, advisors: listAdvisors });
	return {
		browserSource: createModelBrowserSource(settings, sessionServiceTier),
		loadAgents: async () => {
			const { agents } = await discoverAgents(cwd, undefined, extensionRoots());
			const disabled = new Set(cfgTaskDisabledAgents.get(settings));
			const overrides = cfgTaskAgentModelOverrides.get(settings);
			const prewalkOverrides = cfgTaskAgentPrewalk.get(settings);
			const advisorOverrides = cfgTaskAgentAdvisor.get(settings);
			return Promise.all(agents.map(async agent => {
				const override = overrides[agent.name];
				const definition = agent.source !== "bundled" && agent.filePath ? parseAgentDefinitionDocument(await Bun.file(agent.filePath).text()) : agent;
				return { ...agent, ...definition, disabled: disabled.has(agent.name), overrideModel: (Array.isArray(override) ? override.join(",") : override)?.trim() || undefined, prewalkOverride: prewalkOverrides[agent.name]?.trim() || undefined, advisorOverride: advisorOverrides[agent.name]?.trim() || undefined };
			}));
		},
		getAvailableModels: () => modelRegistry.getAvailable(),
		effectiveModelPatterns: agent => resolveAgentModelPatterns({ settingsOverride: agent.overrideModel, agentModel: agent.model, settings, activeModelPattern, fallbackModelPattern: defaultModelPattern }),
		resolvePatterns: patterns => {
			if (!patterns.length) return undefined;
			const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(patterns, modelRegistry, settings);
			return model ? `${model.provider}/${model.id}${explicitThinkingLevel && thinkingLevel ? `:${thinkingLevel}` : ""}` : undefined;
		},
		effectivePrewalkPattern: agent => resolveAgentPrewalkPattern({ settingsOverride: agent.prewalkOverride, agentPrewalk: resolveAgentPrewalkDefault(agent, cfgTaskPrewalk.get(settings)) }),
		effectiveAdvisorPattern: agent => {
			const selection = resolveAgentAdvisorSelection({ settingsOverride: agent.advisorOverride, agentAdvisor: agent.advisor });
			return selection?.definition ? "ref" in selection.definition ? selection.definition.ref : selection.definition.inline.name : selection ? selection.model ?? "@advisor" : undefined;
		},
		setAgentDisabled: (name, { disabled }) => cfgTaskDisabledAgents.setMember(settings, name, { member: disabled }),
		setAgentOverride: (property, name, value) => {
			const setting = property === "model" ? cfgTaskAgentModelOverrides : property === "prewalk" ? cfgTaskAgentPrewalk : cfgTaskAgentAdvisor;
			if (property !== "model") { setting.setEntry(settings, name, value); return; }
			const active = cfgTaskAgentModelOverrides.get(settings);
			cfgTaskAgentModelOverrides.setEntry(settings, name, value);
			cfgTaskAgentModelOverrides.clearOverride(settings);
			const persisted = cfgTaskAgentModelOverrides.get(settings);
			const picks = Object.entries(active).filter(([agent, pick]) => agent !== name && JSON.stringify(pick) !== JSON.stringify(persisted[agent]));
			if (picks.length) cfgTaskAgentModelOverrides.override(settings, { ...persisted, ...Object.fromEntries(picks) });
		},
		editor: {
			get tools() { return tools(); },
			listAdvisors,
			parse: parseAgentDefinitionDocument,
			serialize: serializeAgentDefinitionDocument,
			generate: request => generator.generateAgentFields(request),
			externalEditor: editorContext?.externalEditor,
			outputSchemaDialect: schema => isJTDSchema(schema) ? "jtd" : "json-schema",
		},
		dispose: () => generator.dispose(),
		saveDefinition: async (scope, definition, original) => {
			if (/[\\/\0]/.test(definition.name)) throw new Error("Agent names cannot contain path separators or NUL characters.");
			const raw = serializeAgentDefinitionDocument(definition);
			parseAgentDefinitionDocument(raw);
			const existing = original?.source !== "bundled" ? original?.filePath : undefined;
			const targetDir = getConfigDirs("agents", { user: scope === "user", project: scope === "project", cwd }).find(dir => dir.source === ".omp")?.path;
			if (!existing && !targetDir) throw new Error(`Cannot resolve ${scope} agents directory.`);
			const filePath = existing ?? path.join(targetDir!, `${definition.name}.md`);
			if (!existing) {
				try { await fs.stat(filePath); throw new Error(`Agent file already exists: ${shortenPath(filePath)}`); }
				catch (error) { if (!isEnoent(error)) throw error; }
			}
			await Bun.write(filePath, raw);
			await refreshAgentDiscovery(cwd, extensionRoots());
			return filePath;
		},
	};
}
