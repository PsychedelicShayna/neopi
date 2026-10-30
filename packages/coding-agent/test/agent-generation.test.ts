import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import { createAgentFieldGenerator, type AgentFieldGenerator } from "../src/task/agent-generation";
import { BUILTIN_TOOLS, type Tool, type ToolSession } from "../src/tools";
import { toolSummary } from "../src/tools/xdev";
import { agentDefinitionFieldSchema as fieldSchema } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";

const model = buildModel({
	id: "generator", name: "Generator", provider: "test", api: "ollama-chat", baseUrl: "https://example.test",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 8192,
});
function response(fields: Record<string, unknown>): ai.AssistantMessage {
	return {
		role: "assistant", content: [{ type: "toolCall", id: "submission", name: "submit_definition", arguments: fields }],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	};
}

describe("agent field generation harness context", () => {
	let dir: string;
	let settings: Settings;
	let registry: Map<string, Tool>;
	let generator: AgentFieldGenerator;
	beforeEach(async () => {
		const root = path.join(os.homedir(), ".cache/npi-canary");
		await fs.mkdir(root, { recursive: true });
		dir = await fs.mkdtemp(path.join(root, "agent-generation-"));
		resetSettingsForTest();
		settings = await Settings.init({ inMemory: true, cwd: dir, agentDir: dir });
		const session: ToolSession = {
			cwd: dir, hasUI: false, settings, getSessionFile: () => null, getSessionSpawns: () => "*",
		};
		registry = new Map();
		for (const name of ["read", "bash"] as const) {
			const tool = await BUILTIN_TOOLS[name](session);
			if (tool) registry.set(tool.name, tool);
		}
		generator = createAgentFieldGenerator({
			settings, cwd: dir, schema: () => fieldSchema,
			modelRegistry: { refresh: async () => {}, getAvailable: () => [model], resolver: () => async () => "test-key" },
			tools: () => [...registry.values()].map(tool => ({ name: tool.name, description: toolSummary(tool) })),
			advisors: async () => [{ name: "velvet", scope: "project-omp" }],
		});
	});
	afterEach(async () => {
		generator.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("supplies live schema descriptions, choices and the real registry's names and descriptions", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: "A careful reviewer" }));
		await generator.generateAgentFields({ definition: { systemPrompt: "Review the selected change" }, target: "description" });
		const system = completion.mock.calls[0][1].systemPrompt!.join("\n");
		for (const field of Object.keys(fieldSchema.properties)) expect(system).toContain(`"${field}"`);
		expect(system).toContain("When the delegating agent should choose this definition.");
		expect(system).toContain('"thinkingLevel"');
		expect(system).toContain('"xhigh"');
		expect(system).toContain('"autoloadSkills"');
		for (const name of ["read", "bash"]) {
			const tool = registry.get(name)!;
			expect(system).toContain(`- ${name}:`);
			expect(system).toContain(toolSummary(tool));
		}
		expect(system).toContain("velvet (project-omp)");
		expect(system).toContain("JSON Type Definition");
	});

	test("sends comments, current fields and only selected base definitions as authoring input", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ name: "mixed", description: "Mix", systemPrompt: "Mixed instructions" }));
		const bases = [
			{ name: "reviewer", description: "Review changes", systemPrompt: "Read the entire patch" },
			{ name: "tester", description: "Test changes", systemPrompt: "Exercise the changed behavior" },
		];
		await generator.generateAgentFields({ definition: { name: "chosen" }, target: "all", comment: "Make it more like the tester", baseDefinitions: bases });
		const input = completion.mock.calls[0][1].messages[0].content;
		expect(input).toContain("Make it more like the tester");
		expect(input).toContain("Read the entire patch");
		expect(input).toContain("Exercise the changed behavior");
		expect(input).toContain('"name": "chosen"');
	});

	test("limits generated tool choices to the host catalog and applies no invalid patch", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ tools: ["invented_tool"] }));
		await expect(generator.generateAgentFields({ definition: {}, target: "tools" })).rejects.toThrow("Invalid generated definition");
		completion.mockResolvedValue(response({ tools: ["read"] }));
		expect((await generator.generateAgentFields({ definition: {}, target: "tools" })).fields).toEqual({ tools: ["read"] });
	});

	test("generates named references and full private advisor policies through the canonical editor schema", async () => {
		const completion = vi.spyOn(ai, "completeSimple");
		for (const advisor of [
			{ ref: "velvet", scope: "project-omp" },
			{ inline: { name: "private", model: "@advisor", instructions: "Review every change", reviewMode: "agent-end", reviewInterval: 2, tools: ["read"], delivery: { concern: "on-yield", blocker: "next-tool-call" } } },
		]) {
			completion.mockResolvedValue(response({ advisor }));
			expect((await generator.generateAgentFields({ definition: {}, target: "advisor" })).fields.advisor).toEqual(advisor);
		}
		for (const advisor of [
			{ ref: "velvet", inline: { name: "conflicting" } },
			{ ref: "velvet", scope: "invalid-scope" },
			{ inline: { name: "private", delivery: { concern: "interrupt" } } },
		]) {
			completion.mockResolvedValue(response({ advisor }));
			await expect(generator.generateAgentFields({ definition: {}, target: "advisor" })).rejects.toThrow("Invalid generated definition");
		}
	});

	test("accepts nested JSON Schema and JTD output but rejects an unusable declaration", async () => {
		const completion = vi.spyOn(ai, "completeSimple");
		for (const output of [
			{ type: "object", properties: { reports: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } }, required: ["reports"] },
			{ properties: { text: { type: "string" } }, optionalProperties: { count: { type: "uint32" } } },
		]) {
			completion.mockResolvedValue(response({ output }));
			expect((await generator.generateAgentFields({ definition: {}, target: "output" })).fields.output).toEqual(output);
		}
		completion.mockResolvedValue(response({ output: false }));
		await expect(generator.generateAgentFields({ definition: {}, target: "output" })).rejects.toThrow("Invalid generated output schema");
	});
});
