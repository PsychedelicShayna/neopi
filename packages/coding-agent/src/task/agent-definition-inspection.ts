import type {
	AgentDefinitionDraft,
	AgentDefinitionFinding,
	AgentDefinitionInspection,
} from "@oh-my-pi/pi-tui/overlays/agent-definition-fields";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import { isJTDSchema } from "../tools/jtd-to-json-schema";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { resolveSpawnPolicy } from "./spawn-policy";
import { READ_ONLY_TOOL_NAMES } from "./read-only-policy";

/** Everything the inspection needs from the running harness; the editor never reaches for it directly. */
export interface AgentInspectionContext {
	/** Every discovered definition, including the one being edited. */
	known: readonly { name: string; source: string }[];
	/** Name the definition had when the editor opened; renaming it is not a collision with itself. */
	originalName?: string;
	toolNames: ReadonlySet<string>;
	skillNames?: ReadonlySet<string>;
	advisors?: readonly { name: string; scope: string }[];
	modelPatterns: (draft: AgentDefinitionDraft) => string[];
	resolveModel: (patterns: string[]) => string | undefined;
	prewalkTarget: (draft: AgentDefinitionDraft) => string | undefined;
	advisorSummary: (draft: AgentDefinitionDraft) => string | undefined;
	/** `task.agentModelOverrides` / `agentPrewalk` / `agentAdvisor` entries keyed by this name. */
	overrides: (name: string) => { model?: string; prewalk?: string; advisor?: string };
	maxRecursionDepth: number;
}

/** The spawn policy the executor derives from `spawns`, including the `tools: task` compatibility rule. */
export function effectiveSpawns(draft: Pick<AgentDefinitionDraft, "spawns" | "tools">): string[] | "*" | undefined {
	if (draft.spawns === "*") return "*";
	if (Array.isArray(draft.spawns) && draft.spawns.length > 0) return draft.spawns;
	return draft.tools?.includes("task") ? "*" : undefined;
}

function outputSchemaOf(output: unknown): unknown {
	if (typeof output !== "string") return output;
	try {
		return JSON.parse(output);
	} catch {
		return output;
	}
}

function describeOutput(output: unknown): { fact: string; problem?: string } {
	const schema = outputSchemaOf(output);
	if (schema === undefined) return { fact: "none; results come back as the final message" };
	if (schema === null || schema === true || schema === false) {
		return {
			fact: "unusable",
			problem: "A boolean or null output is rejected before dispatch; omit output or use an object schema.",
		};
	}
	const built = buildOutputValidator(schema);
	if (built.error) return { fact: "invalid", problem: `Output schema is invalid: ${built.error}.` };
	const dialect = isJTDSchema(schema) ? "JTD" : "JSON Schema";
	const required = built.validator?.requiredFields ?? [];
	return {
		fact: `${dialect}; yield {data} validated${required.length ? `; required: ${required.join(", ")}` : ""}`,
	};
}

function formatOverride(setting: string, value: string | undefined): string | undefined {
	return value ? `Settings entry task.${setting} (${value}) wins over this field.` : undefined;
}

/** Effective facts and problems for a definition draft, in the harness's own terms. */
export function inspectAgentDefinition(
	draft: AgentDefinitionDraft,
	context: AgentInspectionContext,
): AgentDefinitionInspection {
	const facts: { k: string; v: string }[] = [];
	const findings: AgentDefinitionFinding[] = [];
	const warn = (text: string, field?: AgentDefinitionFinding["field"]): void => {
		findings.push({ level: "warn", text, field });
	};
	const info = (text: string, field?: AgentDefinitionFinding["field"]): void => {
		findings.push({ level: "info", text, field });
	};

	const name = draft.name.trim();
	if (!name) warn("A name is required.", "name");
	else if (/[\\/\0]/.test(name)) warn("Names cannot contain path separators or NUL characters.", "name");
	else if (name.toLowerCase() === MAIN_AGENT_RULE_NAME || name.toLowerCase() === SUB_AGENT_RULE_NAME)
		warn(`"${name}" is reserved for the session itself; the definition would be ignored.`, "name");
	else if (name !== context.originalName) {
		const clash = context.known.find(agent => agent.name === name);
		if (clash)
			warn(
				clash.source === "bundled"
					? `Shadows the bundled "${name}" agent; removing this file reveals it again.`
					: `A ${clash.source} definition named "${name}" already exists.`,
				"name",
			);
	}
	if (!draft.description.trim())
		warn("A description is required; the delegating agent picks types by it.", "description");
	if (!draft.systemPrompt.trim())
		info("The body is empty; the agent gets only the harness's subagent prompt.", "systemPrompt");

	const overrides = context.overrides(name);
	const patterns = context.modelPatterns(draft);
	const resolved = patterns.length > 0 ? context.resolveModel(patterns) : undefined;
	facts.push({
		k: "Model",
		v: resolved ?? (patterns.length > 0 ? `unresolved: ${patterns.join(", ")}` : "inherits the parent's model"),
	});
	if (patterns.length > 0 && !resolved)
		warn("None of the model selectors resolves to an available model right now.", "model");
	const overrideNote = formatOverride("agentModelOverrides", overrides.model);
	if (overrideNote) info(overrideNote, "model");
	if (draft.thinkingLevel && patterns.some(pattern => /:(minimal|low|medium|high|xhigh|max)$/.test(pattern)))
		info("A selector's :effort suffix wins over the thinking level.", "thinkingLevel");
	if (draft.harness === "codex") warn("The codex harness parses but cannot be spawned.", "harness");

	if (draft.tools === undefined) facts.push({ k: "Tools", v: "default selection" });
	else {
		if (draft.tools.length === 0) {
			const task = draft.spawns === undefined ? "" : "; task is added below the spawn depth cap";
			facts.push({
				k: "Tools",
				v: `No built-ins explicitly selected (yield is added for structured agents${task})`,
			});
		} else {
			const readOnly = draft.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
			facts.push({ k: "Tools", v: `${draft.tools.join(", ")}${readOnly ? " · classified read-only" : ""}` });
		}
		info(
			"A tools list is not a sandbox: MCP and custom tools stay available unless the caller restricts them.",
			"tools",
		);
		for (const tool of draft.tools)
			if (!context.toolNames.has(tool) && !tool.startsWith("mcp__"))
				warn(`Unknown tool "${tool}"; it will not be constructed.`, "tools");
	}

	const spawns = effectiveSpawns(draft);
	const policy = resolveSpawnPolicy(spawns === undefined ? "" : Array.isArray(spawns) ? spawns.join(",") : spawns);
	facts.push({
		k: "Spawns",
		v: !policy.enabled
			? "none"
			: policy.allowedAgents === null
				? `any type (default task) · depth cap ${context.maxRecursionDepth}`
				: `${policy.allowedAgents.join(", ")} (default: ${policy.defaultAgent}) · depth cap ${context.maxRecursionDepth}`,
	});
	if (draft.spawns === undefined && draft.tools?.includes("task"))
		warn('The task tool without spawns silently grants spawns: "*".', "spawns");
	if (Array.isArray(draft.spawns)) {
		for (const target of draft.spawns) {
			if (target === name) warn("Lists itself in spawns; the depth cap bounds the recursion.", "spawns");
			else if (!context.known.some(agent => agent.name === target))
				warn(`Spawn target "${target}" does not exist yet; spawning it fails until it is created.`, "spawns");
		}
	}

	const output = describeOutput(draft.output);
	facts.push({ k: "Output", v: output.fact });
	if (output.problem) warn(output.problem, "output");
	if (draft.structured === false && draft.output !== undefined)
		info("structured: false cannot veto a caller that keeps structured mode on.", "structured");

	const prewalkTarget = context.prewalkTarget(draft);
	facts.push({ k: "Prewalk", v: prewalkTarget ? `after the first edit/write → ${prewalkTarget}` : "off" });
	if (prewalkTarget && draft.tools && !draft.tools.some(tool => tool === "edit" || tool === "write"))
		warn("Prewalk fires after the first edit or write, and this tool list has neither.", "prewalk");
	const prewalkNote = formatOverride("agentPrewalk", overrides.prewalk);
	if (prewalkNote) info(prewalkNote, "prewalk");
	const advisor = context.advisorSummary(draft);
	facts.push({ k: "Advisor", v: advisor ?? "none (subagents run unadvised by default)" });
	const advisorNote = formatOverride("agentAdvisor", overrides.advisor);
	if (advisorNote) info(advisorNote, "advisor");
	if (draft.advisor && typeof draft.advisor === "object" && "ref" in draft.advisor && context.advisors) {
		const ref = draft.advisor.ref;
		const scope = draft.advisor.scope;
		if (!context.advisors.some(entry => entry.name === ref && (!scope || entry.scope === scope)))
			warn(`Named advisor "${ref}" was not found; spawning fails with an unknown-advisor error.`, "advisor");
	}
	if (draft.blocking) facts.push({ k: "Blocking", v: "the parent waits inline" });
	if (context.skillNames && draft.autoloadSkills)
		for (const skill of draft.autoloadSkills)
			if (!context.skillNames.has(skill))
				warn(`Skill "${skill}" is not installed; it is silently dropped.`, "autoloadSkills");

	return { facts, findings };
}
