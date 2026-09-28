import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { computeNonMessageBreakdown, estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";
import { buildSystemPrompt } from "../../src/system-prompt";

const tokenizer = new Tokenizer();

/** External arktype copies expose bind on callable schemas, unlike omptype. */
function bindCapableSchema() {
	return Object.assign((value: unknown) => value, {
		toJsonSchema: () => ({ type: "object", properties: { a: { type: "string" } } }),
		assert: (value: unknown) => value,
	});
}

describe("extension tool context accounting", () => {
	it("counts a proxied bind-capable callable schema by its wire JSON Schema", () => {
		// Binding the schema loses its wire surface and once poisoned token accounting.
		const schema = bindCapableSchema();
		const unwrapped = { name: "ext", description: "ext tool", parameters: schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(unwrapped, wrapper);
		const proxied = wrapper as { name: string; description: string; parameters: unknown };
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBe(
			estimateToolSchemaTokens([unwrapped as never], tokenizer),
		);
		expect(estimateToolSchemaTokens([proxied as never], tokenizer)).toBeGreaterThan(0);
	});

	it("runs the full non-message breakdown on a proxied extension tool", () => {
		const schema = bindCapableSchema();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy({ name: "ext", description: "ext tool", parameters: schema }, wrapper);
		const session = { systemPrompt: ["base"], agent: { state: { tools: [wrapper] } } };
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		expect(breakdown.toolsTokens).toBeGreaterThan(0);
	});
});

describe("Skills context accounting", () => {
	it("uses the frozen provider prompt when the session skill inventory changes", async () => {
		const skill = {
			name: "agent-vfb",
			description: "Use the virtual framebuffer for interactive graphics",
			filePath: "/tmp/skills/agent-vfb/SKILL.md",
			baseDir: "/tmp/skills/agent-vfb",
			source: "test",
		};
		const promptOptions = {
			cwd: process.cwd(),
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
		const disabledPrompt = (await buildSystemPrompt({ ...promptOptions, skills: [] })).systemPrompt;
		const session = {
			systemPrompt: disabledPrompt,
			agent: { state: { tools: [{ name: "read", description: "read files", parameters: {} }] } },
			skills: [skill],
		};

		const afterEnable = computeNonMessageBreakdown(session as never, tokenizer);
		expect(afterEnable.skillsTokens).toBe(0);
		expect(afterEnable.systemPromptTokens).toBe(tokenizer.countTokens(disabledPrompt[0] ?? ""));

		const enabledPrompt = (await buildSystemPrompt({ ...promptOptions, skills: [skill] })).systemPrompt;
		session.systemPrompt = enabledPrompt;
		const withSkills = computeNonMessageBreakdown(session as never, tokenizer);
		expect(withSkills.skillsTokens).toBeGreaterThan(0);
		expect(withSkills.systemPromptTokens + withSkills.skillsTokens).toBe(
			tokenizer.countTokens(enabledPrompt[0] ?? ""),
		);

		session.skills = [];
		expect(computeNonMessageBreakdown(session as never, tokenizer).skillsTokens).toBe(withSkills.skillsTokens);
	});
	it("counts the generated inventory after a custom prompt's literal skills example", async () => {
		const options = {
			cwd: process.cwd(),
			contextFiles: [],
			rules: [],
			toolNames: ["read"],
			customPrompt: "Example markup:\n<skills>\n- sample: explanatory text\n</skills>",
			workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
		const skill = {
			name: "agent-vfb",
			description: "Use the virtual framebuffer for interactive graphics",
			filePath: "/tmp/skills/agent-vfb/SKILL.md",
			baseDir: "/tmp/skills/agent-vfb",
			source: "test",
		};
		const withoutInventory = (await buildSystemPrompt({ ...options, skills: [] })).systemPrompt;
		const withInventory = (await buildSystemPrompt({ ...options, skills: [skill] })).systemPrompt;
		const session = { systemPrompt: withoutInventory, agent: { state: { tools: [] } } };
		const exampleOnly = computeNonMessageBreakdown(session, tokenizer);
		session.systemPrompt = withInventory;
		const bothBlocks = computeNonMessageBreakdown(session, tokenizer);

		expect(bothBlocks.skillsTokens).toBeGreaterThan(exampleOnly.skillsTokens);
		expect(bothBlocks.systemPromptTokens + bothBlocks.skillsTokens).toBe(
			tokenizer.countTokens(withInventory[0] ?? ""),
		);
	});
});
