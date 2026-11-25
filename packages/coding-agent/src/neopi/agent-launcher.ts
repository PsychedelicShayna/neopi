import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import type { SelectItem } from "@oh-my-pi/pi-tui";
import { slugifyAdvisorName } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	newSessionThinkingLevel,
	resolveThinkingLevelForModel,
	type ConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ADVISOR_DEFAULT_TOOL_NAMES } from "../advisor/advise-tool";
import {
	extractExplicitThinkingSelector,
	formatModelStringWithRouting,
	resolveAgentAdvisorSelection,
	resolveAgentModelSelection,
	resolveAgentPrewalkPattern,
	resolveExplicitModelRole,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { advisorAgentId } from "../registry/live-advisors";
import type { AgentSession } from "../session/agent-session";
import { ASYNC_PREVIEW_MAX_CHARS } from "../session/async-job-delivery";
import { cfgDefaultThinkingLevel } from "../session/settings";
import { discoverAgents } from "../task/discovery";
import { generateTaskName } from "../task/name-generator";
import { resolveAgentPrewalkDefault } from "../task/prewalk";
import {
	cfgTaskAgentAdvisor,
	cfgTaskAgentModelOverrides,
	cfgTaskAgentPrewalk,
	cfgTaskDisabledAgents,
	cfgTaskMaxRecursionDepth,
	cfgTaskPrewalk,
	cfgTaskStructured,
} from "../task/settings";
import {
	PLAN_MODE_TOOLS,
	resolveEffectiveSubagentPolicy,
	reserveStructuredSubagentId,
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "../task/structured-subagent";
import { canSpawnAtDepth, type AgentDefinition } from "../task/types";
import { resolveBuiltinToolPlan } from "../tools";
import { normalizeToolNames } from "../tools/builtin-names";
import { parseCappedSpawnSelector, parseSpawnSpec, type SpawnSpec } from "./spawn-spec";

export { parseSpawnArguments, parseSpawnContextCap } from "./spawn-spec";

export interface SpawnPreset {
	type: string;
	description: string;
	tools: SelectItem[];
	advisorSeat?: true;
}

export interface SpawnDraft {
	type: string;
	name: string;
	assignment: string;
	model?: string;
	context?: number;
	prewalk?: string;
	advisor?: string;
	tools?: string[];
	delegation?: string[] | "*";
}

export interface AgentLauncher {
	presets: SpawnPreset[];
	resolveSpec(spec: string): SpawnDraft;
	launch(draft: SpawnDraft, signal?: AbortSignal): Promise<string>;
}

export function isSpawnName(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value);
}

/** Real native types only; a model selector cannot crew an external harness. */
async function discoverSpawnTypes(session: AgentSession): Promise<Map<string, AgentDefinition>> {
	const spawnSession = session.getAgentLauncherSession();
	const discovery = await discoverAgents(spawnSession.cwd, undefined, spawnSession.effectiveExtensionRoots?.());
	const disabled = new Set(cfgTaskDisabledAgents.get(session.settings));
	const agents = new Map<string, AgentDefinition>();
	for (const agent of [...discovery.agents, ...(spawnSession.getSessionAgents?.() ?? [])]) {
		if (!disabled.has(agent.name) && !agents.has(agent.name) && (!agent.harness || agent.harness === "omp")) {
			agents.set(agent.name, agent);
		}
	}
	return agents;
}

export async function completeSpawnTypes(session: AgentSession, prefix: string) {
	const match = /^(@?)([\w.-]*)$/.exec(prefix);
	if (!match) return null;
	const agents = await discoverSpawnTypes(session);
	const rows = [...agents.values()].map(agent => ({ name: agent.name, description: agent.description }));
	if (!agents.has("advisor")) rows.push({ name: "advisor", description: "Session-local advisor" });
	const matches = rows
		.filter(agent => agent.name.toLowerCase().startsWith(match[2].toLowerCase()))
		.map(agent => ({
			value: match[1] + agent.name,
			label: agent.name,
			description: sanitizeDisplayLine(agent.description),
			// Enter after `/spawn ` must still open the bare launcher; Tab completes a type.
			preserveInputOnSubmit: prefix.length === 0,
		}));
	return matches.length ? matches : null;
}

function validateEffort(model: Model, effort?: ConfiguredThinkingLevel): void {
	if (!effort || effort === ThinkingLevel.Inherit) return;
	const supported = model.reasoning ? getSupportedThinkingLevels(model) : [ThinkingLevel.Off];
	if (effort === "auto" ? supported.some(level => level !== ThinkingLevel.Off) : supported.includes(effort)) return;
	throw new Error(
		`Unsupported effort :${effort} for ${formatModelStringWithRouting(model)}; supported efforts: ${supported.join(", ") || "off"}.`,
	);
}

function renderModel(model: Model, effort: ConfiguredThinkingLevel | undefined, settings: Settings): string {
	const level = newSessionThinkingLevel(
		model,
		effort === ThinkingLevel.Inherit ? undefined : effort,
		cfgDefaultThinkingLevel.get(settings),
	);
	const effective = !model.reasoning
		? ThinkingLevel.Off
		: level === "auto"
			? level
			: resolveThinkingLevelForModel(model, level);
	return formatModelSelectorValue(formatModelStringWithRouting(model), effective);
}

function resolvedRoleEffort(settings: Settings, role: string | undefined): ConfiguredThinkingLevel | undefined {
	const saved = role ? settings.getRoleEffortSelection(role) : undefined;
	return saved?.mode === "fixed" ? saved.level : saved?.mode === "auto" ? "auto" : undefined;
}

function resolveExactModel(selector: string, models: Model[], settings: Settings): string {
	const role = selector.startsWith("@");
	const roleId = role ? resolveExplicitModelRole(selector, settings) : undefined;
	const resolved = role
		? resolveModelRoleValue(selector, models, { settings })
		: resolveModelOverride([selector], { getAvailable: () => models }, settings, { exactOnly: true });
	if (!resolved.model || resolved.warning || (role && !roleId)) {
		throw new Error(
			resolved.warning ??
				`No available model matches "${selector}". Use an exact provider/model or @role, optionally followed by :effort.`,
		);
	}
	const explicit = role || resolved.explicitThinkingLevel ? extractExplicitThinkingSelector(selector) : undefined;
	validateEffort(resolved.model, explicit);
	return renderModel(
		resolved.model,
		explicit ?? resolvedRoleEffort(settings, roleId) ?? resolved.thinkingLevel,
		settings,
	);
}

function resolveAuxModel(value: string, field: "prewalk" | "advisor", models: Model[], settings: Settings) {
	if (value === "on" || value === "off") return { selector: value };
	const { selector, context } = field === "prewalk" ? parseCappedSpawnSelector(value) : { selector: value };
	try {
		return { selector: resolveExactModel(selector, models, settings), context };
	} catch (error) {
		throw new Error(`Invalid ${field}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Capture the owner and defaults once, before any editor suspends the command. */
export async function createAgentLauncher(session: AgentSession): Promise<AgentLauncher> {
	const spawnSession = session.getAgentLauncherSession();
	const ownerSessionFile = spawnSession.getSessionFile();
	const { settings } = session;
	const agents = await discoverSpawnTypes(session);
	const models = session.modelRegistry.getAvailable();
	const modelRegistry = { getAvailable: () => models };
	const modelOverrides = cfgTaskAgentModelOverrides.get(settings);
	const prewalkOverrides = cfgTaskAgentPrewalk.get(settings);
	const advisorOverrides = cfgTaskAgentAdvisor.get(settings);
	const isPlan = spawnSession.getPlanModeState?.()?.enabled === true;
	const structured = cfgTaskStructured.get(settings);
	const childDepth = (spawnSession.taskDepth ?? 0) + 1;
	const canDelegate = canSpawnAtDepth(cfgTaskMaxRecursionDepth.get(settings), childDepth);
	const inheritedTools = session.getEnabledToolNames().filter(tool => session.hasBuiltInTool(tool));
	// The hidden goal tool is a mode grant, not an active tool. An unedited
	// inherited roster keeps it; an explicit agent tool list or checkbox can omit it.
	const canGrantGoal = !isPlan && session.hasBuiltInTool("goal");
	if (canGrantGoal && !inheritedTools.includes("goal")) inheritedTools.push("goal");
	const candidates = normalizeToolNames([
		...inheritedTools,
		...Array.from(agents.values()).flatMap(agent => agent.tools ?? []),
		...(isPlan ? PLAN_MODE_TOOLS : []),
	]);
	const eligible = (
		await resolveBuiltinToolPlan(
			{
				...spawnSession,
				restrictToolNames: true,
				taskDepth: childDepth,
				skipPythonPreflight: true,
				getGoalModeState: undefined,
			},
			candidates,
		)
	).names;
	const defaults = new Map<string, Omit<SpawnDraft, "name" | "assignment">>();
	const presets: SpawnPreset[] = [];
	const toolRows = (names: string[]): SelectItem[] => names.toSorted().map(value => ({ value, label: value }));
	const isAdvisor = (type: string) => type === "advisor" && !agents.has(type);
	const name = generateTaskName();
	for (const agent of agents.values()) {
		const { name: type } = agent;
		const prewalkDefault = resolveAgentPrewalkDefault(agent, cfgTaskPrewalk.get(settings));
		const prewalkPattern = resolveAgentPrewalkPattern({
			settingsOverride: prewalkOverrides[type],
			agentPrewalk: prewalkDefault,
		});
		const advisor = resolveAgentAdvisorSelection({
			settingsOverride: advisorOverrides[type],
			agentAdvisor: agent.advisor,
		});
		const spawnTools = isPlan
			? [...PLAN_MODE_TOOLS, ...(agent.tools ?? []).filter(tool => tool === "ast_grep")]
			: agent.tools;
		const usesYield =
			(structured || agent.structured === true) &&
			(agent.output !== undefined || spawnSession.outputSchema !== undefined);
		const allowed = eligible.filter(
			tool =>
				tool !== "yield" &&
				(tool !== "goal" || (canGrantGoal && (agent.harness === undefined || agent.harness === "omp"))) &&
				(tool !== "task" || canDelegate) &&
				(!isPlan || spawnTools?.includes(tool)) &&
				(tool !== "todo" || !usesYield || Boolean(prewalkPattern)),
		);
		const tools = normalizeToolNames([
			...(spawnTools ?? inheritedTools),
			...(!isPlan && agent.spawns !== undefined ? ["task"] : []),
		]).filter(tool => allowed.includes(tool));
		const rows = toolRows(allowed);
		if (usesYield)
			rows.push({
				value: "yield",
				label: "yield",
				disabled: true,
				description: "Included: submit the structured result",
			});
		const selection = resolveAgentModelSelection({
			settingsOverride: modelOverrides[type],
			agentModel: agent.model,
			settings,
			activeModelPattern: spawnSession.getActiveModelString?.(),
			fallbackModelPattern: spawnSession.getModelString?.(),
		});
		const resolved = resolveModelOverride(selection.patterns, modelRegistry, settings);
		const effort =
			resolvedRoleEffort(settings, selection.role) ??
			(resolved.explicitThinkingLevel ? resolved.thinkingLevel : (agent.thinkingLevel ?? resolved.thinkingLevel));
		defaults.set(type, {
			type,
			model: resolved.model ? renderModel(resolved.model, effort, settings) : undefined,
			prewalk: prewalkPattern,
			advisor:
				advisor?.model ??
				(advisor?.definition && "ref" in advisor.definition ? advisor.definition.ref : advisor ? "on" : undefined),
			tools,
			delegation: tools.includes("task") ? (agent.spawns ?? "*") : [],
		});
		presets.push({ type, description: agent.description, tools: rows });
	}
	if (isAdvisor("advisor")) {
		const tools = session.getAdvisorAvailableToolNames();
		const editableTools = tools.filter(tool => tool !== "advise");
		const resolved = resolveModelRoleValue("@advisor", models, { settings });
		defaults.set("advisor", {
			type: "advisor",
			model: resolved.model
				? renderModel(resolved.model, resolvedRoleEffort(settings, "advisor") ?? resolved.thinkingLevel, settings)
				: undefined,
			tools: editableTools.filter(tool => ADVISOR_DEFAULT_TOOL_NAMES.has(tool) || tool === "recall"),
		});
		presets.push({
			type: "advisor",
			advisorSeat: true,
			description: "Session-local advisor",
			tools: [
				...toolRows(editableTools),
				{ value: "advise", label: "advise", disabled: true, description: "Included: send advice to the session" },
			],
		});
	}
	// Remember explicit overrides separately from display values, so an unedited
	// default keeps the definition's retries, routing and role policy intact.
	const explicit = new WeakMap<SpawnDraft, SpawnSpec>();
	return {
		presets,
		resolveSpec(spec) {
			const parsed = parseSpawnSpec(spec);
			const base = defaults.get(parsed.type);
			if (!base)
				throw new Error(
					`Unknown or unavailable agent type "${parsed.type}". Available: ${[...defaults.keys()].join(", ") || "none"}.`,
				);
			const draft: SpawnDraft = {
				...base,
				name,
				assignment: "",
				context: parsed.context,
				tools: [...(base.tools ?? [])],
				delegation: Array.isArray(base.delegation) ? [...base.delegation] : base.delegation,
			};
			if (parsed.model) draft.model = resolveExactModel(parsed.model, models, settings);
			if (parsed.effort !== undefined) {
				const resolved =
					draft.model && resolveModelOverride([draft.model], modelRegistry, settings, { exactOnly: true }).model;
				if (!resolved)
					throw new Error(
						`No available model for ${parsed.type}. Choose one in /spawn or add @model to the spec.`,
					);
				validateEffort(resolved, parsed.effort);
				draft.model = renderModel(resolved, parsed.effort, settings);
			}
			if (isAdvisor(draft.type) && (parsed.prewalk || parsed.advisor))
				throw new Error("An advisor seat does not support prewalk or its own advisor.");
			if (parsed.prewalk) {
				resolveAuxModel(parsed.prewalk, "prewalk", models, settings);
				draft.prewalk = parsed.prewalk;
			}
			if (parsed.advisor) {
				resolveAuxModel(parsed.advisor, "advisor", models, settings);
				draft.advisor = parsed.advisor;
			}
			explicit.set(draft, parsed);
			return draft;
		},
		async launch(draft, signal) {
			const base = defaults.get(draft.type);
			if (!base) throw new Error("Choose an available agent type.");
			const name = draft.name.trim();
			if (!isSpawnName(name))
				throw new Error(
					"Name must start with a letter and contain at most 32 letters, digits, underscores or hyphens.",
				);
			const assignment = draft.assignment.trim();
			if (!assignment) throw new Error("An assignment is required.");
			if (!draft.model) throw new Error(`No available model for ${draft.type}. Choose a model in /spawn.`);
			const modelChanged =
				draft.model !== base.model ||
				explicit.get(draft)?.model !== undefined ||
				explicit.get(draft)?.effort !== undefined;
			const availableModels = session.modelRegistry.getAvailable();
			const model = modelChanged ? resolveExactModel(draft.model, availableModels, settings) : draft.model;
			if (draft.context !== undefined && (!Number.isSafeInteger(draft.context) || draft.context <= 0)) {
				throw new Error("Context cap must be a positive integer token count.");
			}
			const tools = draft.tools ?? base.tools ?? [];
			const preset = presets.find(preset => preset.type === draft.type)!;
			const unknown = tools.filter(tool => !preset.tools.some(row => row.value === tool && !row.disabled));
			if (unknown.length) throw new Error(`Unavailable tools for ${draft.type}: ${unknown.join(", ")}.`);
			const checkOwner = () => {
				signal?.throwIfAborted();
				if (spawnSession.isDisposed?.()) throw new Error("The owning session has closed.");
				if (spawnSession.getSessionFile() !== ownerSessionFile)
					throw new Error("The owning session changed. Run /spawn again in the current session.");
			};
			checkOwner();
			if (isAdvisor(draft.type)) {
				const config = { name, model, tools, instructions: assignment, reviewMode: "turn" as const };
				if (draft.context === undefined) session.launchAdvisor(config);
				else session.launchAdvisor(config, draft.context);
				const owner =
					AgentRegistry.global().rootForSession(session)?.id ?? spawnSession.getAgentId?.() ?? MAIN_AGENT_ID;
				return `Launched advisor ${name}. Open its transcript with /hub ${advisorAgentId(owner, slugifyAdvisorName(name))}.`;
			}
			const parsed = explicit.get(draft);
			const prewalk =
				draft.prewalk !== base.prewalk || parsed?.prewalk !== undefined
					? resolveAuxModel(draft.prewalk || "off", "prewalk", availableModels, settings)
					: undefined;
			const advisor =
				draft.advisor !== base.advisor || parsed?.advisor !== undefined
					? resolveAuxModel(draft.advisor || "off", "advisor", availableModels, settings)
					: undefined;
			const manager = spawnSession.asyncJobManager;
			if (!manager) throw new Error("This session does not support managed background agents.");
			const request: StructuredSubagentRequest = {
				session: spawnSession,
				invocationKind: "task",
				agent: draft.type,
				...(modelChanged ? { model, confirmedModel: model } : {}),
				assignment,
				tools,
				spawns: tools.includes("task") ? (draft.delegation ?? base.delegation ?? "*") : [],
				contextCap: draft.context,
				prewalkOverride: prewalk?.selector,
				prewalkContextCap: prewalk?.context,
				advisorOverride: advisor?.selector,
				keepAlive: true,
				detached: true,
				structured,
			};
			await resolveEffectiveSubagentPolicy(request);
			checkOwner();
			const id = await reserveStructuredSubagentId(spawnSession, { label: name });
			checkOwner();
			manager.register(
				"task",
				id,
				async ({ signal, reportProgress }) => {
					const execution = await runStructuredSubagent({
						...request,
						identity: { id },
						signal,
						onProgress: progress => {
							void reportProgress(`Running ${id}`, { progress: [progress] });
						},
					});
					if (execution.result.exitCode !== 0)
						throw new Error(execution.result.error ?? execution.result.stderr ?? `Agent ${id} failed.`);
					return {
						text: `Agent ${id} completed.\n${execution.result.output}${execution.mergeSummary}`,
						transcriptPreview: truncateMiddle(execution.result.output.trim(), {
							maxBytes: ASYNC_PREVIEW_MAX_CHARS,
						}).content,
					};
				},
				{ id, agentId: id, ownerId: spawnSession.getAgentId?.() ?? undefined },
			);
			return `Launched ${id} as ${model}. Open its transcript with /hub ${id}.`;
		},
	};
}
