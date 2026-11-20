import { describe, expect, test } from "bun:test";
import type { AgentDefinitionDraft } from "@oh-my-pi/pi-tui/overlays/agent-definition-fields";
import {
	type AgentInspectionContext,
	inspectAgentDefinition,
} from "@oh-my-pi/pi-coding-agent/task/agent-definition-inspection";

const context: AgentInspectionContext = {
	known: [
		{ name: "scout", source: "bundled" },
		{ name: "editor", source: "project" },
	],
	originalName: "editor",
	toolNames: new Set(["read", "grep", "edit", "write", "task", "bash"]),
	skillNames: new Set(["tdd"]),
	advisors: [{ name: "velvet", scope: "user" }],
	modelPatterns: draft => draft.model ?? [],
	resolveModel: patterns => (patterns.includes("@smol") ? "anthropic/claude-haiku" : undefined),
	prewalkTarget: draft =>
		draft.prewalk === true ? "@smol" : typeof draft.prewalk === "string" ? draft.prewalk : undefined,
	advisorSummary: draft => (draft.advisor ? "@advisor" : undefined),
	overrides: () => ({}),
	maxRecursionDepth: 2,
};
const base: AgentDefinitionDraft = { name: "editor", description: "Edits", systemPrompt: "Edit." };
const warnings = (draft: AgentDefinitionDraft) =>
	inspectAgentDefinition(draft, context)
		.findings.filter(finding => finding.level === "warn")
		.map(finding => [finding.field, finding.text]);
const fact = (draft: AgentDefinitionDraft, key: string) =>
	inspectAgentDefinition(draft, context).facts.find(entry => entry.k === key)?.v;

describe("inspectAgentDefinition", () => {
	test("a plain definition has no warnings and inherits the parent's model", () => {
		expect(warnings(base)).toEqual([]);
		expect(fact(base, "Model")).toBe("inherits the parent's model");
		expect(fact(base, "Spawns")).toBe("none");
	});

	test("the task tool without spawns is reported as the wildcard grant it becomes", () => {
		const draft = { ...base, tools: ["read", "task"] };
		expect(warnings(draft)).toContainEqual(["spawns", 'The task tool without spawns silently grants spawns: "*".']);
		expect(fact(draft, "Spawns")).toStartWith("any type");
	});

	test("spawn lists name their default and flag targets that do not exist", () => {
		const draft: AgentDefinitionDraft = { ...base, spawns: ["scout", "planner"] };
		expect(fact(draft, "Spawns")).toBe("scout, planner (default: scout) · depth cap 2");
		expect(warnings(draft).map(([field]) => field)).toEqual(["spawns"]);
	});

	test("read-only classification follows the declared tool list", () => {
		expect(fact({ ...base, tools: ["read", "grep"] }, "Tools")).toContain("classified read-only");
		expect(fact({ ...base, tools: ["read", "bash"] }, "Tools")).not.toContain("read-only");
	});

	test("an empty tools list is not a sandbox and only gains task when spawns are declared", () => {
		const draft = { ...base, tools: [] };
		expect(inspectAgentDefinition(draft, context).findings).toContainEqual({
			level: "info",
			field: "tools",
			text: "A tools list is not a sandbox: MCP and custom tools stay available unless the caller restricts them.",
		});
		expect(fact(draft, "Tools")).toContain("yield");
		expect(fact(draft, "Tools")).not.toContain("task");
		expect(fact({ ...draft, spawns: ["scout"] }, "Tools")).toContain("task");
	});

	test("boolean or null output and invalid schemas are rejected before dispatch would reject them", () => {
		expect(warnings({ ...base, output: true }).map(([field]) => field)).toEqual(["output"]);
		expect(warnings({ ...base, output: null }).map(([field]) => field)).toEqual(["output"]);
		const valid = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
		expect(warnings({ ...base, output: valid })).toEqual([]);
		expect(fact({ ...base, output: valid }, "Output")).toContain("required: ok");
	});

	test("prewalk with a tool list lacking edit and write can never fire", () => {
		expect(warnings({ ...base, prewalk: true, tools: ["read"] }).map(([field]) => field)).toEqual(["prewalk"]);
		expect(warnings({ ...base, prewalk: true, tools: ["read", "edit"] })).toEqual([]);
	});

	test("names: reserved, colliding and shadowing", () => {
		expect(warnings({ ...base, name: "Main" }).map(([field]) => field)).toEqual(["name"]);
		expect(warnings({ ...base, name: "scout" })[0]?.[1]).toContain("Shadows the bundled");
		expect(warnings(base)).toEqual([]); // keeping its own name is not a collision
	});

	test("catalog references: unknown tools, skills, named advisors and unresolvable models", () => {
		const draft: AgentDefinitionDraft = {
			...base,
			tools: ["read", "nonesuch", "mcp__github_search"],
			autoloadSkills: ["tdd", "missing"],
			advisor: { ref: "ghost" },
			model: ["vendor/unknown"],
		};
		expect(warnings(draft).map(([field]) => field)).toEqual(["model", "tools", "advisor", "autoloadSkills"]);
		expect(fact({ ...base, model: ["vendor/unknown", "@smol"] }, "Model")).toBe("anthropic/claude-haiku");
	});
});
