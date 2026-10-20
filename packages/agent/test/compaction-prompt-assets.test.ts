import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildAnthropicCompactionInstructions,
	generateBranchSummary,
	generateSummary,
	getAutoHandoffThresholdFocus,
	renderHandoffPrompt,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	renderBranchSummaryContext,
	renderCompactionSummaryContext,
	renderHandoffSummaryContext,
} from "@oh-my-pi/pi-agent-core/compaction/messages";
import { getContextWindowTruncatedOutputMessage } from "@oh-my-pi/pi-agent-core/compaction/openai";
import { formatFileOperations, getSummarizationSystemPrompt } from "@oh-my-pi/pi-agent-core/compaction/utils";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import * as snapcompact from "@oh-my-pi/snapcompact";
import branchSummaryContext from "../src/compaction/prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContext from "../src/compaction/prompts/compaction-summary-context.md" with { type: "text" };
import handoffDocument from "../src/compaction/prompts/handoff-document.md" with { type: "text" };
import handoffSummaryContext from "../src/compaction/prompts/handoff-summary-context.md" with { type: "text" };
import summarizationSystem from "../src/compaction/prompts/summarization-system.md" with { type: "text" };

let root: string;

beforeEach(async () => {
	root = path.join(os.homedir(), ".cache/npi-canary/compaction-prompt-assets", Snowflake.next());
	await fs.mkdir(root, { recursive: true });
	vi.spyOn(dirs, "getProjectDir").mockReturnValue(root);
	vi.spyOn(dirs, "getAgentDir").mockReturnValue(path.join(root, "user-agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

async function override(id: string, text: string, cwd = root): Promise<void> {
	await Bun.write(path.join(cwd, ".omp/builtin-prompts", id), text);
}

function response(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "retained summary" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const conversation: AgentMessage[] = [{ role: "user", content: "Keep the parser fix.", timestamp: 1 }];

function summarizerModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
	return model;
}

describe("compaction prompt asset reload boundaries", () => {
	test("leaves bundled handoff, system and summary wrappers byte-identical without overrides", () => {
		expect(renderHandoffPrompt()).toBe(prompt.render(handoffDocument));
		expect(renderHandoffPrompt("Keep the parser")).toBe(
			prompt.render(handoffDocument, { additionalFocus: "Keep the parser" }),
		);
		expect(getSummarizationSystemPrompt()).toBe(prompt.render(summarizationSystem));
		for (const [render, bundled] of [
			[renderBranchSummaryContext, branchSummaryContext],
			[renderCompactionSummaryContext, compactionSummaryContext],
			[renderHandoffSummaryContext, handoffSummaryContext],
		] as const) {
			expect(render("<summary>kept</summary>")).toBe(prompt.render(bundled, { summary: "<summary>kept</summary>" }));
		}
	});

	test("renders current handoff focus from an override and reloads the next call", async () => {
		await override("compaction/handoff-document.md", "Focus: {{additionalFocus}}");
		expect(renderHandoffPrompt("parser")).toBe("Focus: parser");
		await override("compaction/handoff-document.md", "New focus: {{additionalFocus}}");
		expect(renderHandoffPrompt("tokens")).toBe("New focus: tokens");
		expect(renderHandoffPrompt()).toBe("New focus:");
	});

	test("reads automatic handoff focus from the explicit session cwd", async () => {
		const sessionCwd = path.join(root, "moved-session");
		await override("compaction/auto-handoff-threshold-focus.md", "default project");
		await override("compaction/auto-handoff-threshold-focus.md", "moved project", sessionCwd);
		expect(getAutoHandoffThresholdFocus(sessionCwd)).toBe("moved project");
		await override("compaction/auto-handoff-threshold-focus.md", "new moved project focus", sessionCwd);
		expect(getAutoHandoffThresholdFocus(sessionCwd)).toBe("new moved project focus");
	});

	test("fails closed when the handoff template is broken", async () => {
		await override("compaction/handoff-document.md", "{{#if additionalFocus}}unclosed");
		expect(() => renderHandoffPrompt("parser")).toThrow();
	});

	test("renders all summary notices with current summary data and falls back for a broken notice", async () => {
		for (const [id, render] of [
			["branch-summary-context.md", renderBranchSummaryContext],
			["compaction-summary-context.md", renderCompactionSummaryContext],
			["handoff-summary-context.md", renderHandoffSummaryContext],
		] as const) {
			await override(`compaction/${id}`, "Stored {{summary}}");
			expect(render("first")).toBe("Stored first");
			await override(`compaction/${id}`, "Reloaded {{summary}}");
			expect(render("second")).toBe("Reloaded second");
		}
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await override("compaction/compaction-summary-context.md", "{{#if summary}}broken");
		expect(renderCompactionSummaryContext("safe")).toBe(prompt.render(compactionSummaryContext, { summary: "safe" }));
		expect(warning).toHaveBeenCalled();
	});

	test("keeps all Anthropic instruction fields available in overrides", async () => {
		await override(
			"compaction/anthropic-compaction-instructions.md",
			"{{basePrompt}} | {{customInstructions}} | {{extraContext}}",
		);
		expect(buildAnthropicCompactionInstructions("base", "focus", "memory")).toBe("base | focus | memory");
	});

	test("reads file-operation templates in agent and snapcompact packages at each use", async () => {
		await override("compaction/file-operations.md", "Agent files: {{files}}");
		await override("compaction/snapcompact/file-operations.md", "Image files: {{files}}");
		expect(formatFileOperations(["src/a.ts"], [])).toContain("Agent files:");
		expect(formatFileOperations(["src/a.ts"], [])).toContain("a.ts (Read)");
		expect(snapcompact.upsertFileOperations("Summary", ["src/a.ts"], [])).toContain("Image files:");
		await override("compaction/snapcompact/file-operations.md", "Reloaded image files: {{files}}");
		expect(snapcompact.upsertFileOperations("Summary", ["src/a.ts"], [])).toContain("Reloaded image files:");
	});

	test("reloads the output-truncation notice instead of freezing it at import time", async () => {
		await override("compaction/context-window-truncated-output.md", "Old output omitted.");
		expect(getContextWindowTruncatedOutputMessage()).toBe("Old output omitted.");
		await override("compaction/context-window-truncated-output.md", "Earlier output is now omitted.");
		expect(getContextWindowTruncatedOutputMessage()).toBe("Earlier output is now omitted.");
	});

	test("sends fresh initial, update and system templates on successive summary requests", async () => {
		const cwd = path.join(root, "summary-session");
		const requests: Context[] = [];
		const completeImpl = async (_model: unknown, context: Context) => {
			requests.push(context);
			return response();
		};
		await override("compaction/summarization-system.md", "Summary system one", cwd);
		await override("compaction/compaction-summary.md", "Initial summary instruction", cwd);
		await generateSummary(conversation, summarizerModel(), 2048, "key", undefined, undefined, undefined, {
			cwd,
			completeImpl,
		});
		await override("compaction/summarization-system.md", "Summary system two, updated", cwd);
		await override("compaction/compaction-update-summary.md", "Updated summary instruction", cwd);
		await generateSummary(conversation, summarizerModel(), 2048, "key", undefined, undefined, "prior", {
			cwd,
			completeImpl,
		});
		expect(requests[0].systemPrompt).toEqual(["Summary system one"]);
		expect(requests[1].systemPrompt).toEqual(["Summary system two, updated"]);
		expect(JSON.stringify(requests[0].messages)).toContain("Initial summary instruction");
		expect(JSON.stringify(requests[1].messages)).toContain("Updated summary instruction");
		expect(JSON.stringify(requests[1].messages)).toContain("prior");
	});

	test("resolves branch instructions and preamble for each branch generation", async () => {
		const cwd = path.join(root, "branch-session");
		const entries: SessionEntry[] = [
			{ type: "message", id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: conversation[0] },
		];
		const requests: Context[] = [];
		const options = {
			cwd,
			model: summarizerModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			completeImpl: async (_model: unknown, context: Context) => {
				requests.push(context);
				return response();
			},
		};
		await override("compaction/branch-summary.md", "Branch instruction one", cwd);
		await override("compaction/branch-summary-preamble.md", "Branch prefix: ", cwd);
		expect((await generateBranchSummary(entries, options)).summary).toBe("Branch prefix:retained summary");
		await override("compaction/branch-summary.md", "Branch instruction two, updated", cwd);
		await override("compaction/branch-summary-preamble.md", "Updated branch prefix: ", cwd);
		expect((await generateBranchSummary(entries, options)).summary).toBe("Updated branch prefix:retained summary");
		expect(JSON.stringify(requests[0].messages)).toContain("Branch instruction one");
		expect(JSON.stringify(requests[1].messages)).toContain("Branch instruction two, updated");
	});
});
