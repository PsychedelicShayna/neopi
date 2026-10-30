import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { PersonaConfigDoc } from "@oh-my-pi/pi-tui/overlays/persona-config";
import { createLivePersonaGeneration } from "../src/live/persona-generation";
import { defaultLiveInstructions } from "../src/live/personas";
import { createPersonaFeature, PersonaStore, type PersonaFeature } from "../src/neopi/persona";
import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { Settings, resetSettingsForTest } from "../src/config/settings";

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
function response(text: string, stopReason: ai.StopReason = "stop"): ai.AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason,
		timestamp: Date.now(),
	};
}
const doc: PersonaConfigDoc = {
	entries: [
		{
			name: "default",
			builtin: true,
			content: defaultLiveInstructions,
			mode: "replace",
			sourceKind: "inline",
			path: "",
			literal: "",
			inheritToTasks: false,
		},
		{
			name: "creative",
			content: "Speak in nautical riddles, {{firstName}}.",
			mode: "replace",
			sourceKind: "inline",
			path: "",
			literal: "",
			inheritToTasks: false,
		},
	],
};

describe("live persona generation catalogue and completion", () => {
	let dir: string;
	let personas: PersonaFeature;
	beforeEach(async () => {
		const root = path.join(os.homedir(), ".cache/npi-canary");
		await fs.mkdir(root, { recursive: true });
		dir = await fs.mkdtemp(path.join(root, "persona-generation-"));
		personas = createPersonaFeature(new PersonaStore(path.join(dir, "personas.json")), () => dir);
		await personas.create("inline", {
			mode: "replace",
			source: { kind: "inline", content: "Unselected secret example." },
		});
		await Bun.write(path.join(dir, "file.md"), "File-backed creative example.");
		await personas.create("file", { mode: "replace", source: { kind: "file", path: "file.md" } });
		resetSettingsForTest();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await fs.rm(dir, { recursive: true, force: true });
	});
	async function generation(personality = false) {
		// Real initialization with no generation configuration must remain safe.
		const settings = await Settings.init({ inMemory: true, cwd: dir, agentDir: dir });
		return createLivePersonaGeneration({
			personality,
			registry: { getAvailable: () => [model], resolver: () => async () => "test-key" },
			browserSource: createModelBrowserSource(settings),
			personas,
			sessionId: "generation-test",
			cwd: dir,
			templates: [
				{
					name: "storyteller",
					description: "Creative voice",
					source: "(user)",
					content: "Tell stories in short beats.",
				},
			],
		});
	}

	test("generates personality injections from selected references", async () => {
		const deps = await generation(true);
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response("Warm and direct."));
		expect((await deps.references(doc))[0]?.label).toBe("Personality: default");
		const result = await deps.generate({
			model,
			references: ["live:1"],
			description: "Warm and direct",
			doc,
			signal: new AbortController().signal,
		});
		expect(result).toBe("Warm and direct.");
		expect(completion.mock.calls[0]?.[1].systemPrompt?.join("\n")).toContain("personality injection");
	});

	test("resolves generator templates from the session project without freezing reference values", async () => {
		await Bun.write(
			path.join(dir, ".omp/builtin-prompts/live/generate-persona.md"),
			"Custom generator instructions.\n",
		);
		await Bun.write(
			path.join(dir, ".omp/builtin-prompts/live/generate-persona-user.md"),
			"Description: {{description}}\n{{#each references}}{{label}}: {{instructions}}{{/each}}",
		);
		const deps = await generation();
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response("Generated instructions."));
		await deps.generate({
			model,
			references: ["live:1"],
			description: "A cartographer",
			doc,
			signal: new AbortController().signal,
		});
		const context = completion.mock.calls[0][1];
		expect(context.systemPrompt).toEqual(["Custom generator instructions.\n"]);
		expect(context.messages[0].content).toContain("Description: A cartographer");
		expect(context.messages[0].content).toContain("Speak in nautical riddles, {{firstName}}.");
		await Bun.write(
			path.join(dir, ".omp/builtin-prompts/live/generate-persona.md"),
			"Updated generator instructions.",
		);
		await deps.generate({
			model,
			references: ["live:1"],
			description: "A navigator",
			doc,
			signal: new AbortController().signal,
		});
		expect(completion.mock.calls[1][1].systemPrompt).toEqual(["Updated generator instructions."]);
	});

	test("lists all references without reading unselected file-backed prompts", async () => {
		await fs.rm(path.join(dir, "file.md"));
		const deps = await generation();
		expect(await deps.references(doc)).toEqual([
			{ id: "live:0", label: "Default live template" },
			{ id: "live:1", label: "Live persona: creative" },
			{ id: "persona:file", label: "Persona: file" },
			{ id: "persona:inline", label: "Persona: inline" },
			{ id: "prompt:0", label: "Prompt: storyteller (user)" },
		]);
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response("Generated instructions."));
		expect(
			await deps.generate({
				model,
				references: ["live:1"],
				description: "Use that voice",
				doc,
				signal: new AbortController().signal,
			}),
		).toBe("Generated instructions.");
		expect(completion).toHaveBeenCalledTimes(1);
	});

	test.each([
		[["live:0"], [defaultLiveInstructions]],
		[
			["persona:file", "prompt:0"],
			["File-backed creative example.", "Tell stories in short beats."],
		],
		[
			["live:0", "live:1"],
			[defaultLiveInstructions, "Speak in nautical riddles, {{firstName}}."],
		],
	])("sends only selected reference bodies %j through the chosen model", async (selected, included) => {
		const deps = await generation();
		const completion = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(response("Final instructions with {{firstName}}."));
		const signal = new AbortController().signal;
		const result = await deps.generate({
			model,
			references: selected,
			description: "A patient cartographer",
			doc,
			signal,
		});
		expect(result).toBe("Final instructions with {{firstName}}.");
		const args = completion.mock.calls[0];
		expect(args?.[0]).toBe(model);
		expect(args?.[2]?.signal).toBe(signal);
		expect(args?.[2]?.sessionId).toBe("generation-test");
		const input = args?.[1].messages[0]?.content;
		expect(typeof input).toBe("string");
		for (const text of included) expect(input).toContain(text);
		expect(input).toContain("A patient cartographer");
		expect(input).not.toContain("Unselected secret example.");
		if (!selected.includes("live:0")) expect(input).not.toContain(defaultLiveInstructions);
	});

	test("surfaces selected-file errors and rejects empty, truncated and failed completions", async () => {
		const deps = await generation();
		const completion = vi.spyOn(ai, "completeSimple");
		await fs.rm(path.join(dir, "file.md"));
		const request = {
			model,
			references: ["persona:file"],
			description: "new",
			doc,
			signal: new AbortController().signal,
		};
		await expect(deps.generate(request)).rejects.toThrow();
		expect(completion).not.toHaveBeenCalled();
		request.references = ["live:0"];
		completion.mockResolvedValue(response(""));
		await expect(deps.generate(request)).rejects.toThrow("empty instructions");
		completion.mockResolvedValue(response("partial", "length"));
		await expect(deps.generate(request)).rejects.toThrow("output limit");
		completion.mockResolvedValue({ ...response("", "error"), errorMessage: "Provider denied" });
		await expect(deps.generate(request)).rejects.toThrow("Provider denied");
	});
});
