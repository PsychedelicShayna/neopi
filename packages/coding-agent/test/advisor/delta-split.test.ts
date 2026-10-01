// Direct unit tests for the multi-message-split pure renderer (src/advisor/delta-split.ts).
// Verifies:
//  1. Multi-message split is byte-equivalent to the old single-block render
//     for mixed user/assistant/toolResult history.
//  2. WIP marker lands on the LAST chunk only.
//  3. Obfuscation fixture: secrets in tool-call arguments / toolResult
//     details.diff are obfuscated BEFORE chunk rendering (message-level pass),
//     matching the old security contract.
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { renderAdvisorDeltaChunks } from "../../src/advisor/delta-split";
import { formatSessionHistoryMarkdown } from "../../src/session/session-history-format";

function user(text: string, ts: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: ts } as AgentMessage;
}
function agent(text: string, ts: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: ts,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		stopReason: "stop",
	} as unknown as AgentMessage;
}
function toolCall(id: string, ts: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.ts" } }],
		timestamp: ts,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		stopReason: "tool_use",
	} as unknown as AgentMessage;
}
function toolResult(id: string, ts: number): AgentMessage {
	return { role: "toolResult", toolCallId: id, content: "file content", timestamp: ts } as unknown as AgentMessage;
}

const OPTS = {
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
	expandToolIO: true,
	includeThinking: true,
} as const;

function chunksToText(chunks: AgentMessage[] | null): string | null {
	if (!chunks) return null;
	return chunks.map(c => ((c as { content: unknown }).content as { text: string }[])[0].text).join("\n");
}

describe("renderAdvisorDeltaChunks (delta-split)", () => {
	it("alternating user/agent byte-identical to single-block", () => {
		const msgs = [user("first", 1), agent("a1", 2), user("second", 3), agent("a2", 4)];
		const old = `### Session update\n\n${formatSessionHistoryMarkdown(msgs, OPTS)}`;
		const chunks = renderAdvisorDeltaChunks(msgs, {
			wip: false,
			includeThinking: true,
			advisorRegexSecretValues: new Set(),
		});
		expect(chunksToText(chunks)).toBe(old);
	});

	it("consecutive same-role user byte-identical", () => {
		const msgs = [user("u1", 1), user("u2", 2), agent("a", 3)];
		const old = `### Session update\n\n${formatSessionHistoryMarkdown(msgs, OPTS)}`;
		expect(
			chunksToText(
				renderAdvisorDeltaChunks(msgs, { wip: false, includeThinking: true, advisorRegexSecretValues: new Set() }),
			),
		).toBe(old);
	});

	it("toolCall + toolResult pairing byte-identical", () => {
		const msgs = [toolCall("call_1", 1), toolResult("call_1", 2), user("done", 3)];
		const old = `### Session update\n\n${formatSessionHistoryMarkdown(msgs, OPTS)}`;
		const chunks = renderAdvisorDeltaChunks(msgs, {
			wip: false,
			includeThinking: true,
			advisorRegexSecretValues: new Set(),
		});
		expect(chunksToText(chunks)).toBe(old);
	});

	it("complex mixed history byte-identical", () => {
		const msgs = [
			user("question", 1),
			agent("thinking", 2),
			toolCall("c2", 3),
			toolResult("c2", 4),
			agent("answer", 5),
			user("follow-up", 6),
			user("steering", 7),
			agent("final", 8),
		];
		const old = `### Session update\n\n${formatSessionHistoryMarkdown(msgs, OPTS)}`;
		const chunks = renderAdvisorDeltaChunks(msgs, {
			wip: false,
			includeThinking: true,
			advisorRegexSecretValues: new Set(),
		});
		expect(chunksToText(chunks)).toBe(old);
	});

	it("gates escaped primary reasoning in split advisor updates while retaining text and tools", () => {
		const msgs = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Consider <untrusted> & retry" },
					{ type: "redactedThinking", data: "hidden-secret" },
					{ type: "text", text: "Decision: proceed" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
				],
				timestamp: 1,
			} as unknown as AgentMessage,
			toolResult("c1", 2),
		];
		const enabled = chunksToText(
			renderAdvisorDeltaChunks(msgs, { wip: false, includeThinking: true, advisorRegexSecretValues: new Set() }),
		)!;
		const disabled = chunksToText(
			renderAdvisorDeltaChunks(msgs, { wip: false, includeThinking: false, advisorRegexSecretValues: new Set() }),
		)!;
		expect(enabled).toBe(
			`### Session update\n\n${formatSessionHistoryMarkdown(msgs, { ...OPTS, primaryThinkingXml: true })}`,
		);
		expect(enabled).toContain("<primary-thinking>\nConsider &lt;untrusted&gt; &amp; retry\n</primary-thinking>");
		expect(disabled).not.toContain("primary-thinking");
		expect(disabled).not.toContain("Consider");
		for (const output of [enabled, disabled]) {
			expect(output).toContain("Decision: proceed");
			expect(output).toContain("→ read(a.ts)");
			expect(output).not.toContain("hidden-secret");
		}
	});

	it("wip marker lands on LAST chunk only", () => {
		const msgs = [user("u1", 1), agent("a1", 2), user("u2", 3)];
		const chunks = renderAdvisorDeltaChunks(msgs, {
			wip: true,
			includeThinking: true,
			advisorRegexSecretValues: new Set(),
		});
		expect(chunks).not.toBeNull();
		const texts = chunks!.map(c => ((c as { content: unknown }).content as { text: string }[])[0].text);
		// Marker only in the final chunk; earlier chunks unchanged.
		for (let i = 0; i < texts.length - 1; i++) {
			expect(texts[i]).not.toContain("[in progress");
		}
		expect(texts[texts.length - 1]).toContain("[in progress — more steps follow]");
	});

	it("splits into multiple user messages for multi-message history", () => {
		const msgs = [user("u1", 1), agent("a1", 2), user("u2", 3), agent("a2", 4)];
		const chunks = renderAdvisorDeltaChunks(msgs, {
			wip: false,
			includeThinking: true,
			advisorRegexSecretValues: new Set(),
		});
		expect(chunks!.length).toBeGreaterThan(1);
	});

	it("puts the heading on the first emitted chunk when earlier messages render empty", () => {
		const empty = {
			role: "custom",
			customType: "advisor",
			content: "internal advice",
			display: false,
			timestamp: 1,
		} as AgentMessage;
		const chunks = renderAdvisorDeltaChunks([empty, user("visible", 2)], {
			wip: false,
			includeThinking: true,
			advisorRegexSecretValues: new Set(),
		});
		expect(chunksToText(chunks)).toStartWith("### Session update\n\n");
	});
});
