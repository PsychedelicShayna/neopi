/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type ContextBreakdown,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
	getToolSchemaMetadataRevision,
	invalidateToolSchemaMetadata,
	renderContextUsage,
} from "../src/status-line/context-usage";

const tokenizer = new Tokenizer();

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters } as never],
			tokenizer,
		);
		const wireEstimate = estimateToolSchemaTokens(
			[{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never],
			tokenizer,
		);
		expect(arktypeEstimate).toBe(wireEstimate);
	});

	it("skips a parameters value that stringifies to undefined, counting exactly name + description", () => {
		// A plain function is neither an arktype schema nor JSON-serializable:
		// the independent unserializable-schema fallback must skip it while the
		// tool's own strings still contribute their exact token share.
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: "odd tool", parameters: function bareSchema() {} } as never],
			tokenizer,
		);
		expect(estimate).toBe(estimateToolSchemaTokens([{ name: "odd", description: "odd tool" } as never], tokenizer));
	});

	it("counts rendered examples, which the agent loop appends to the wire description", () => {
		const tool = { name: "grep", description: "Search files.", parameters: { type: "object" } };
		const examples = [{ caption: "Find TODOs", call: { pattern: "TODO", path: "src" } }];
		const without = estimateToolSchemaTokens([tool as never], tokenizer);
		const withExamples = estimateToolSchemaTokens([{ ...tool, examples } as never], tokenizer);
		expect(withExamples).toBeGreaterThan(without);
	});

	it("skips non-string name/description fragments", () => {
		const estimate = estimateToolSchemaTokens(
			[{ name: "odd", description: undefined, parameters: { type: "object" } } as never],
			tokenizer,
		);
		expect(estimate).toBeGreaterThan(0);
	});

	it("does not reread dynamic metadata until its explicit revision changes", () => {
		let description = "short";
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return description;
			},
			parameters: {},
		};
		const tools = [tool];
		const first = estimateToolSchemaTokens(tools, tokenizer);
		expect(reads).toBe(1);
		expect(estimateToolSchemaTokens(tools, tokenizer)).toBe(first);
		expect(reads).toBe(1);

		description = "a substantially longer dynamic description after a live policy update";
		invalidateToolSchemaMetadata(tools);
		expect(getToolSchemaMetadataRevision(tools)).toBe(1);
		expect(estimateToolSchemaTokens(tools, tokenizer)).toBeGreaterThan(first);
		expect(reads).toBe(2);
	});

	it("separates array, tokenizer, and source-revision cache keys", () => {
		let reads = 0;
		const tool = {
			name: "dynamic",
			get description() {
				reads++;
				return "metadata";
			},
			parameters: {},
		};
		const tools = [tool];
		estimateToolSchemaTokens(tools, tokenizer, 1);
		estimateToolSchemaTokens(tools, tokenizer, 1);
		expect(reads).toBe(1);

		estimateToolSchemaTokens(tools, tokenizer, 2);
		expect(reads).toBe(2);
		estimateToolSchemaTokens([...tools], tokenizer, 2);
		expect(reads).toBe(3);
		estimateToolSchemaTokens(tools, new Tokenizer(), 2);
		expect(reads).toBe(4);
	});
});

/**
 * Contract: the /context panel surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("renderContextUsage snapcompact section", () => {
	const themeStub = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = renderContextUsage(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
			themeStub,
		);
		expect(output).toContain("Snapcompact (estimated wire savings)");
		expect(output).toContain("System prompt (all): saves ~3.2K (9.8K text → 2 frames ≈ 6.6K)");
		expect(output).toContain("Tool results: none imaged (3 in history)");
		// 27929 logical − 3168 saved ≈ 25K on the wire.
		expect(output).toContain("Next request: ~25K tokens on the wire");
	});

	it("reports text-only models as inactive", () => {
		const output = renderContextUsage(breakdownWith({ visionCapable: false, savedTokens: 0 }), themeStub);
		expect(output).toContain("Snapcompact: inactive (model has no image input)");
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		const output = renderContextUsage(breakdownWith(undefined), themeStub);
		expect(output).not.toContain("Snapcompact");
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } } };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never, tokenizer);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never, tokenizer);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never, tokenizer)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never, tokenizer);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never, tokenizer);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never, tokenizer).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never, tokenizer);
		const breakdown = computeNonMessageBreakdown(session as never, tokenizer);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never, tokenizer)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never, tokenizer).systemPromptTokens).not.toBe(
			breakdown.systemPromptTokens,
		);
	});

	it("invalidates settings-backed dynamic descriptions on the settings revision", () => {
		let description = "short";
		const tool = {
			name: "dynamic",
			get description() {
				return description;
			},
			parameters: {},
		};
		const session = {
			...makeSession(["base"], [tool]),
			settings: { revision: 1, get: () => true },
		};
		const first = computeNonMessageBreakdown(session as never, tokenizer, session.settings.revision).toolsTokens;
		description = "a longer settings-backed description after a live update";
		session.settings.revision++;
		expect(
			computeNonMessageBreakdown(session as never, tokenizer, session.settings.revision).toolsTokens,
		).toBeGreaterThan(first);
	});
});

/**
 * Contract: missing tool descriptions or system-prompt sections still produce
 * finite token estimates. Extensions can contribute tools whose descriptions
 * are absent at runtime (issue #9331).
 */
describe("non-message estimates tolerate a missing description", () => {
	it("estimateToolSchemaTokens does not throw on an undefined tool description", () => {
		const tokens = estimateToolSchemaTokens(
			[{ name: "lens_tool", description: undefined, parameters: {} } as never],
			tokenizer,
		);
		expect(Number.isFinite(tokens)).toBe(true);
		expect(tokens).toBeGreaterThanOrEqual(0);
	});

	it("computeNonMessageBreakdown does not throw on an undefined system-context section", () => {
		const session = {
			systemPrompt: ["primary prompt", undefined, "trailing context"],
			agent: { state: { tools: [] } },
		} as never;
		const b = computeNonMessageBreakdown(session, tokenizer);
		expect(Number.isFinite(b.systemContextTokens)).toBe(true);
		expect(b.systemContextTokens).toBeGreaterThanOrEqual(0);
	});
});
