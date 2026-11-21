import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import { createLivePersonaFeature } from "../src/live/personas";
import { createAgentsHubDeps } from "../src/modes/agents-hub-deps";
import { personaFeature } from "../src/neopi/persona";
import { saveCustomPersonality } from "../src/neopi/personality-settings";
import { createAgentFieldGenerator, type AgentFieldGenerator } from "../src/task/agent-generation";
import { BUILTIN_TOOLS, type Tool, type ToolSession } from "../src/tools";
import { toolSummary } from "../src/tools/xdev";
import { READ_ONLY_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/task/read-only-policy";
import {
	agentDefinitionFieldSchema as fieldSchema,
	type AgentAdvisor,
} from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const model = buildModel({
	id: "generator",
	name: "Generator",
	provider: "test",
	api: "ollama-chat",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});
function response(fields: Record<string, unknown>): ai.AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "submission", name: "submit_definition", arguments: fields }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
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
			cwd: dir,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		registry = new Map();
		for (const name of ["read", "bash"] as const) {
			const tool = await BUILTIN_TOOLS[name](session);
			if (tool) registry.set(tool.name, tool);
		}
		generator = createAgentFieldGenerator({
			settings,
			cwd: dir,
			schema: () => fieldSchema,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [model],
				resolver: () => async () => "test-key",
			},
			tools: () => [...registry.values()].map(tool => ({ name: tool.name, description: toolSummary(tool) })),
			advisors: async () => [{ name: "velvet", scope: "project-omp" }],
			readOnlyTools: READ_ONLY_TOOL_NAMES,
		});
	});
	afterEach(async () => {
		generator.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("supplies live schema descriptions, choices and the real registry's names and descriptions", async () => {
		const completion = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(response({ description: "A careful reviewer" }));
		await generator.generateAgentFields({
			definition: { systemPrompt: "Review the selected change" },
			target: "description",
		});
		const system = completion.mock.calls[0][1].systemPrompt!.join("\n");
		for (const field of Object.keys(fieldSchema.properties)) expect(system).toContain(`"${field}"`);
		expect(system).toContain("When the delegating agent should choose this definition.");
		expect(system).toContain('"thinkingLevel"');
		expect(system).toContain('"xhigh"');
		expect(system).toContain('"autoloadSkills"');
		for (const name of ["read", "bash"]) {
			const tool = registry.get(name)!;
			expect(system).toMatch(/- read\b.*readOnly=true/);
			expect(system).toMatch(/- bash\b.*readOnly=false/);
			expect(system).toContain(toolSummary(tool));
		}
		expect(system).toContain("velvet (project-omp)");
		expect(system).toContain("JSON Type Definition");
	});

	test("sends comments, current fields and only selected base definitions as authoring input", async () => {
		const completion = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(response({ name: "mixed", description: "Mix", systemPrompt: "Mixed instructions" }));
		const bases = [
			{ name: "reviewer", description: "Review changes", systemPrompt: "Read the entire patch" },
			{ name: "tester", description: "Test changes", systemPrompt: "Exercise the changed behavior" },
		];
		await generator.generateAgentFields({
			definition: { name: "chosen" },
			target: "all",
			comment: "Make it more like the tester",
			baseDefinitions: bases,
		});
		const input = completion.mock.calls[0][1].messages[0].content;
		expect(input).toContain("Make it more like the tester");
		expect(input).toContain("Read the entire patch");
		expect(input).toContain("Exercise the changed behavior");
		expect(input).toContain('"name": "chosen"');
	});

	test("discovers all reference kinds and forwards only selected content through the hub to the author role", async () => {
		const previousAgentDir = getAgentDir();
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-generation-profile-"));
		const profile = path.join(root, "profile");
		const project = path.join(root, "project");
		const auth = createInMemoryAuthStorage();
		let dispose: (() => void) | undefined;
		await fs.mkdir(profile);
		setAgentDir(profile);
		try {
			await Bun.write(
				path.join(project, ".omp", "agents", "base.md"),
				"---\nname: base\ndescription: Project reference\nprewalk: true\n---\nAgent reference body",
			);
			await Bun.write(
				path.join(project, "WATCHDOG.yml"),
				"advisors:\n  - name: velvet\n    instructions: Advisor reference body\n",
			);
			await Bun.write(path.join(project, ".omp", "AGENTS.md"), "Project context reference body");
			saveCustomPersonality(settings, "project", "warm", "Personality reference body");
			await Bun.write(path.join(profile, "persona.md"), "Persona reference body");
			await personaFeature().create("focused", {
				mode: "append",
				source: { kind: "file", path: "persona.md" },
			});
			await createLivePersonaFeature().saveAll({ voice: { instructions: "Voice reference body" } }, undefined);
			const skillPath = path.join(project, ".omp", "skills", "workflow", "SKILL.md");
			await Bun.write(skillPath, "---\nname: workflow\ndescription: A workflow\n---\nSkill reference body");
			const fallback = { ...model, id: "fallback" };
			settings.setModelRole("agent-author", `${model.provider}/${model.id}`);
			const models = new ModelRegistry(auth);
			vi.spyOn(models, "refresh").mockResolvedValue(undefined);
			vi.spyOn(models, "getAvailable").mockReturnValue([fallback, model]);
			const deps = createAgentsHubDeps(
				project,
				settings,
				models,
				() => ({ explicit: [], configured: [], configuredLevel: "user", mode: "explicit-only" }),
				`${fallback.provider}/${fallback.id}`,
				undefined,
				undefined,
				{
					tools: () => [],
					sessionDir: () => undefined,
					promptTemplates: () => [
						{ name: "example", description: "A prompt", content: "Prompt reference body", source: "(project)" },
						{
							name: "other",
							description: "Not selected",
							content: "Unselected reference body",
							source: "(user)",
						},
					],
					skills: () => [{ name: "workflow", description: "A workflow", filePath: skillPath }],
				},
			);
			dispose = deps.dispose;
			const sources = await deps.editor.listGenerationSources!();
			const examples = [
				["agent", "base", "Agent reference body"],
				["advisor", "velvet", "Advisor reference body"],
				["personality", "warm", "Personality reference body"],
				["persona", "focused", "Persona reference body"],
				["persona", "voice", "Voice reference body"],
				["prompt", "example", "Prompt reference body"],
				["skill", "workflow", "Skill reference body"],
				["context-file", "AGENTS.md", "Project context reference body"],
			] as const;
			const selected = examples.map(([kind, name, content]) => {
				const source = sources.find(item => item.kind === kind && item.name === name);
				if (!source) throw new Error(`Missing ${kind} reference ${name}`);
				expect(source.content).toContain(content);
				return source;
			});
			expect(selected[0].content).toContain("prewalk: true");
			expect(sources.some(source => source.kind === "agent" && source.name === "task")).toBe(true);
			expect(sources.some(source => source.kind === "personality" && source.name === "default")).toBe(true);
			expect(sources.some(source => source.kind === "prompt" && source.name === "other")).toBe(true);
			const completion = vi
				.spyOn(ai, "completeSimple")
				.mockResolvedValue(
					response({ name: "not-chosen", description: "Mix", systemPrompt: "Mixed instructions" }),
				);
			const result = await deps.editor.generate({
				definition: { name: "chosen", description: "", systemPrompt: "", prewalk: false, tools: [] },
				target: "all",
				comment: "Use the workflow and the voice",
				sources: selected,
				signal: new AbortController().signal,
			});
			const [usedModel, context] = completion.mock.calls[0];
			expect(usedModel.id).toBe(model.id);
			const input = context.messages[0].content;
			expect(input).toContain("Use the workflow and the voice");
			expect(input).toContain(JSON.stringify(selected, null, 2));
			expect(input).not.toContain("Unselected reference body");
			const parameters = context.tools?.[0].parameters as { properties: Record<string, unknown> };
			for (const field of ["name", "prewalk", "tools"]) expect(parameters.properties).not.toHaveProperty(field);
			expect(result.fields).toEqual({
				name: "chosen",
				prewalk: false,
				tools: [],
				description: "Mix",
				systemPrompt: "Mixed instructions",
			});
		} finally {
			dispose?.();
			setAgentDir(previousAgentDir);
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("limits generated tool choices to the host catalog and applies no invalid patch", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ tools: ["invented_tool"] }));
		await expect(generator.generateAgentFields({ definition: {}, target: "tools" })).rejects.toThrow(
			"Invalid generated definition",
		);
		completion.mockResolvedValue(response({ tools: ["read"] }));
		expect((await generator.generateAgentFields({ definition: {}, target: "tools" })).fields).toEqual({
			tools: ["read"],
		});
	});

	test("generates named references and full private advisor policies through the canonical editor schema", async () => {
		const completion = vi.spyOn(ai, "completeSimple");
		for (const advisor of [
			{ ref: "velvet", scope: "project-omp" },
			{
				inline: {
					name: "private",
					model: "@advisor",
					instructions: "Review every change",
					reviewMode: "agent-end",
					reviewInterval: 2,
					tools: ["read"],
					delivery: { concern: "on-yield", blocker: "next-tool-call" },
				},
			},
		] satisfies AgentAdvisor[]) {
			completion.mockResolvedValue(response({ advisor }));
			expect((await generator.generateAgentFields({ definition: {}, target: "advisor" })).fields.advisor).toEqual(
				advisor,
			);
		}
		for (const advisor of [
			{ ref: "velvet", inline: { name: "conflicting" } },
			{ ref: "velvet", scope: "invalid-scope" },
			{ inline: { name: "private", delivery: { concern: "interrupt" } } },
		]) {
			completion.mockResolvedValue(response({ advisor }));
			await expect(generator.generateAgentFields({ definition: {}, target: "advisor" })).rejects.toThrow(
				"Invalid generated definition",
			);
		}
	});

	test("accepts nested JSON Schema and JTD output but rejects an unusable declaration", async () => {
		const completion = vi.spyOn(ai, "completeSimple");
		for (const output of [
			{
				type: "object",
				properties: {
					reports: {
						type: "array",
						items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					},
				},
				required: ["reports"],
			},
			{ properties: { text: { type: "string" } }, optionalProperties: { count: { type: "uint32" } } },
		]) {
			completion.mockResolvedValue(response({ output }));
			expect((await generator.generateAgentFields({ definition: {}, target: "output" })).fields.output).toEqual(
				output,
			);
		}
		completion.mockResolvedValue(response({ output: false }));
		await expect(generator.generateAgentFields({ definition: {}, target: "output" })).rejects.toThrow(
			"Invalid generated output schema",
		);
	});
});
