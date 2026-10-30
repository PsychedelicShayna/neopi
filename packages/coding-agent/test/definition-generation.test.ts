import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import {
	createDefinitionGenerator,
	type DefinitionGenerator,
} from "../src/task/definition-generation";
import { cfgDefinitionGenerationConversationTtlMs } from "../src/task/settings";

const model = buildModel({
	id: "generator", name: "Generator", provider: "test", api: "ollama-chat", baseUrl: "https://example.test",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000, maxTokens: 8192,
});
const authorModel = buildModel({ ...model, id: "author", name: "Author" });
interface Definition { name: string; description: string; tools?: string[] }
const schema = {
	type: "object", properties: {
		name: { type: "string" }, description: { type: "string" }, tools: { type: "array", items: { type: "string" } },
	}, required: ["name", "description"],
};
function response(fields: Record<string, unknown>): ai.AssistantMessage {
	return {
		role: "assistant", content: [{ type: "toolCall", id: "submission", name: "submit_definition", arguments: fields }],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: Date.now(),
	};
}

describe("structured definition generation", () => {
	let dir: string;
	let settings: Settings;
	let generator: DefinitionGenerator<Definition>;
	beforeEach(async () => {
		const root = path.join(os.homedir(), ".cache/npi-canary");
		await fs.mkdir(root, { recursive: true });
		dir = await fs.mkdtemp(path.join(root, "definition-generation-"));
		resetSettingsForTest();
		settings = await Settings.init({ inMemory: true, cwd: dir, agentDir: dir });
		generator = createDefinitionGenerator<Definition>({
			settings, cwd: dir,
			modelRegistry: { refresh: async () => {}, getAvailable: () => [model, authorModel], resolver: () => async () => "test-key" },
			schema: () => schema,
			// These stand in for the caller's prompt templates; no provider receives them in tests.
			systemPrompt: () => "Fixture definition schema",
			requestPrompt: request => JSON.stringify(request),
		});
	});
	afterEach(async () => {
		generator.dispose();
		vi.restoreAllMocks();
		resetSettingsForTest();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("loads clean Settings with the default generation retention", () => {
		expect(cfgDefinitionGenerationConversationTtlMs.get(settings)).toBe(3_600_000);
	});

	test.each([0, 2_147_483_647])("accepts generation retention boundary %s", value => {
		cfgDefinitionGenerationConversationTtlMs.override(settings, value);
		expect(cfgDefinitionGenerationConversationTtlMs.get(settings)).toBe(value);
	});

	test.each([-1, 0.5, 2_147_483_648, NaN, Infinity])(
		"rejects invalid generation retention %s without changing the prior value",
		value => {
			cfgDefinitionGenerationConversationTtlMs.override(settings, 60_000);
			expect(() => cfgDefinitionGenerationConversationTtlMs.override(settings, value)).toThrow(
				"Definition generation retention must be a non-negative duration in milliseconds (at most 2147483647).",
			);
			expect(cfgDefinitionGenerationConversationTtlMs.get(settings)).toBe(60_000);
		},
	);

	test("single-field requests discard incidental fields and never mutate the draft", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: "New description", name: "wrong", tools: ["write"] }));
		const definition = { name: "review", description: "Old description", tools: ["read"] };
		const result = await generator.generate({ definition, target: "description" });
		expect(result.fields).toEqual({ description: "New description" });
		expect(definition).toEqual({ name: "review", description: "Old description", tools: ["read"] });
		expect(completion.mock.calls[0][1].tools?.[0].parameters).toMatchObject({
			properties: { description: { type: "string" } }, required: ["description"], additionalProperties: false,
		});
		expect(completion.mock.calls[0][2]?.toolChoice).toEqual({ type: "tool", name: "submit_definition" });
	});

	test("retains comments and complete prior turns only within the inactivity TTL", async () => {
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: "Original result" }));
		const first = await generator.generate({ definition: { name: "review" }, target: "description", comment: "Tools have been updated" });
		expect(completion.mock.calls[0][1].messages[0].content).toContain("Tools have been updated");
		expect(first.conversationId).toBeString();
		now += 3_599_999;
		completion.mockResolvedValue(response({ description: "Less formal result" }));
		const second = await generator.generate({ definition: { name: "review" }, target: "description", comment: "Less formal", conversationId: first.conversationId });
		const retained = completion.mock.calls[1][1].messages;
		expect(retained.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(JSON.stringify(retained)).toContain("Original result");
		expect(retained[3].content).toContain("Less formal");
		expect(second.conversationId).toBe(first.conversationId);
		now += 3_600_000;
		const third = await generator.generate({ definition: { name: "review" }, target: "description", comment: "Start again", conversationId: first.conversationId });
		expect(completion.mock.calls[2][1].messages).toHaveLength(1);
		expect(JSON.stringify(completion.mock.calls[2][1].messages)).not.toContain("Original result");
		expect(third.conversationId).not.toBe(first.conversationId);
	});

	test("zero retention discards an existing conversation and returns no reusable id", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: "Generated" }));
		const first = await generator.generate({ definition: {}, target: "description" });
		cfgDefinitionGenerationConversationTtlMs.override(settings, 0);
		const second = await generator.generate({ definition: {}, target: "description", conversationId: first.conversationId });
		expect(second.conversationId).toBeUndefined();
		expect(completion.mock.calls[1][1].messages).toHaveLength(1);
		cfgDefinitionGenerationConversationTtlMs.override(settings, 3_600_000);
		await generator.generate({ definition: {}, target: "description", conversationId: first.conversationId });
		expect(completion.mock.calls[2][1].messages).toHaveLength(1);
	});

	test("a shorter retention setting expires idle history without another generation", async () => {
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: "Private draft" }));
		const first = await generator.generate({ definition: {}, target: "description" });
		now += 5_000;
		cfgDefinitionGenerationConversationTtlMs.override(settings, 1_000);
		await Bun.sleep(0);
		cfgDefinitionGenerationConversationTtlMs.override(settings, 3_600_000);
		await generator.generate({ definition: {}, target: "description", conversationId: first.conversationId });
		expect(completion.mock.calls[1][1].messages).toHaveLength(1);
	});

	test("mixes only selected bases while preserving preset fields, including empty lists", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ name: "do-not-overwrite", description: "Mixed description", tools: ["write"] }));
		const bases = [{ name: "reader", description: "Read carefully", tools: ["read"] }, { name: "writer", description: "Write clearly", tools: ["write"] }];
		const result = await generator.generate({ definition: { name: "chosen", tools: [] }, target: "all", baseDefinitions: bases, comment: "Combine their strengths" });
		expect(result.fields).toEqual({ name: "chosen", description: "Mixed description", tools: [] });
		const input = completion.mock.calls[0][1].messages[0].content;
		expect(input).toContain("Read carefully");
		expect(input).toContain("Write clearly");
		expect(input).toContain("Combine their strengths");
	});

	test("uses the configured agent-author role rather than a hard-coded model", async () => {
		vi.spyOn(settings, "getModelRole").mockImplementation(role => role === "agent-author" ? "test/author" : undefined);
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: "Generated" }));
		await generator.generate({ definition: {}, target: "description" });
		expect(completion.mock.calls[0][0]).toBe(authorModel);
	});

	test("rejects invalid, truncated, failed and unstructured output without retaining it", async () => {
		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(response({ description: 17 }));
		await expect(generator.generate({ definition: {}, target: "description" })).rejects.toThrow("Invalid generated definition");
		completion.mockResolvedValue({ ...response({}), stopReason: "length" });
		await expect(generator.generate({ definition: {}, target: "description" })).rejects.toThrow("output limit");
		completion.mockResolvedValue({ ...response({}), stopReason: "error", errorMessage: "Provider denied" });
		await expect(generator.generate({ definition: {}, target: "description" })).rejects.toThrow("Provider denied");
		completion.mockResolvedValue({ ...response({}), content: [{ type: "text", text: "{\"description\":\"raw JSON\"}" }] });
		await expect(generator.generate({ definition: {}, target: "description" })).rejects.toThrow("structured definition");
		completion.mockResolvedValue(response({}));
		await expect(generator.generate({ definition: {}, target: "description" })).rejects.toThrow("Invalid generated definition");
	});

	test("cancellation and disposal never deliver or retain a late response", async () => {
		const pending = Promise.withResolvers<ai.AssistantMessage>();
		vi.spyOn(ai, "completeSimple").mockReturnValue(pending.promise);
		const controller = new AbortController();
		const generating = generator.generate({ definition: {}, target: "description", signal: controller.signal });
		await Bun.sleep(0);
		controller.abort();
		pending.resolve(response({ description: "Late result" }));
		await expect(generating).rejects.toThrow();
		generator.dispose();
		await expect(generator.generate({ definition: {}, target: "description" })).rejects.toThrow("disposed");
	});
});
