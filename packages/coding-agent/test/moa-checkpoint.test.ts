import { describe, expect, it } from "bun:test";
import { zeroUsage } from "@oh-my-pi/pi-coding-agent/moa/outer-stream";
import { completedMixtureRun, isMixtureRunComplete } from "@oh-my-pi/pi-coding-agent/moa/restore";
import { MIXTURE_RUN_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/moa/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const base = { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };

function checkpoint(runId: string, responseId: string): SessionEntry {
	return {
		...base,
		type: "custom",
		customType: MIXTURE_RUN_ENTRY_TYPE,
		data: { v: 1, reason: "done", run: { id: runId }, committedThrough: 0, outerResponseId: responseId },
	};
}

function assistant(responseId: string): SessionEntry {
	return {
		...base,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "finished" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
			responseId,
		},
	};
}

const reset: SessionEntry = { ...base, type: "reset_boundary" };

function lifecycle(runId: string): SessionEntry {
	return { ...base, type: "custom", customType: MIXTURE_RUN_ENTRY_TYPE, data: { kind: "run_end", runId } };
}

describe("mixture run completion on a persisted branch", () => {
	it("matches a done checkpoint only to a later assistant response with its own id", () => {
		const done = checkpoint("a", "r1");
		expect(completedMixtureRun([done, assistant("r1")], "a")?.outerResponseId).toBe("r1");
		expect(isMixtureRunComplete([done], "a")).toBe(false);
		expect(isMixtureRunComplete([assistant("r1"), done], "a")).toBe(false);
		expect(isMixtureRunComplete([done, assistant("r2")], "a")).toBe(false);
		expect(isMixtureRunComplete([done, assistant("r1")], "b")).toBe(false);
	});

	it("ignores lifecycle entries but refuses completion across a reset boundary", () => {
		const done = checkpoint("a", "r1");
		expect(isMixtureRunComplete([done, assistant("r1"), lifecycle("a")], "a")).toBe(true);
		expect(isMixtureRunComplete([lifecycle("a")], "a")).toBe(false);
		expect(isMixtureRunComplete([done, reset, assistant("r1")], "a")).toBe(false);
		expect(isMixtureRunComplete([done, assistant("r1"), reset], "a")).toBe(false);
	});

	it("returns the newest checkpoint when a done response was replayed", () => {
		const first = checkpoint("a", "r1");
		const second = checkpoint("a", "r2");
		expect(completedMixtureRun([first, assistant("r1"), second, assistant("r2")], "a")?.outerResponseId).toBe("r2");
	});
});
