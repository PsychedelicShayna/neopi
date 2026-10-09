import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SUBAGENT_OUTCOME_EXCERPT_CHARS, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type AgentDefinition,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { activeSubagentRuns, EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	assertExternalHarnessCapabilities,
	ClaudeExternalHarnessAdapter,
	claudeExternalHarnessAdapter,
} from "../../src/task/external-harness";

const claudeAgent: AgentDefinition = {
	name: "claude-contract",
	description: "external harness contract fixture",
	systemPrompt: "Run the supplied fixture.",
	source: "project",
	harness: "claude",
	tools: ["read", "yield"],
};

function settledResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "external-contract",
		agent: claudeAgent.name,
		agentSource: claudeAgent.source,
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function lifecycleRunOptions(eventBus: EventBus) {
	return {
		cwd: "/tmp",
		agent: claudeAgent,
		task: "do work",
		index: 0,
		id: "external-contract",
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		eventBus,
	};
}

function collectLifecycle(eventBus: EventBus): SubagentLifecyclePayload[] {
	const events: SubagentLifecyclePayload[] = [];
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		events.push(data as SubagentLifecyclePayload);
	});
	return events;
}

describe("external harness contracts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts the host-owned yield capability while rejecting unsupported runtime tools", () => {
		expect(() => assertExternalHarnessCapabilities(claudeAgent)).not.toThrow();
		expect(() => assertExternalHarnessCapabilities({ ...claudeAgent, tools: ["read", "bash", "yield"] })).toThrow(
			"Claude external harness cannot represent requested tools: bash",
		);
	});

	it("observes cancellation that arrives during asynchronous isolation validation", async () => {
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("sidecar spawned after cancellation");
		});
		const controller = new AbortController();
		const run = new ClaudeExternalHarnessAdapter().execute({
			agent: claudeAgent,
			agentId: "claude-cancel",
			prompt: "do work",
			cwd: "/tmp",
			isolation: { isolated: true, worktree: "/tmp", repoRoot: "/tmp" },
			parent: { parentSessionId: "Main", inheritedExtensionState: {} },
			signal: controller.signal,
			maxRuntimeMs: 1_000,
			deadlineAt: Date.now() + 1_000,
			onProgress: () => {},
		});

		controller.abort("cancel during isolation");

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("brackets a successful external run with exactly one start and terminal event", async () => {
		const eventBus = new EventBus();
		const events = collectLifecycle(eventBus);
		vi.spyOn(claudeExternalHarnessAdapter, "execute").mockImplementation(async () => {
			expect(events.map(event => event.status)).toEqual(["started"]);
			return settledResult();
		});

		const result = await runSubprocess(lifecycleRunOptions(eventBus));

		expect(result.exitCode).toBe(0);
		expect(events.map(event => event.status)).toEqual(["started", "completed"]);
		expect(events[0]?.runToken).toMatch(/^[\da-f-]{36}$/);
		expect(events[1]?.runToken).toBe(events[0]?.runToken);
		expect(events[0]?.runKind).toBe("spawn");
		expect(events[0]?.depth).toBe(1);
		expect(events[1]?.outcomeExcerpt).toBe("done");
		expect(activeSubagentRuns(eventBus).size).toBe(0);
	});

	it("emits one failed settlement when an external adapter throws", async () => {
		const eventBus = new EventBus();
		const events = collectLifecycle(eventBus);
		vi.spyOn(claudeExternalHarnessAdapter, "execute").mockRejectedValue(new Error("adapter failed"));

		await expect(runSubprocess(lifecycleRunOptions(eventBus))).rejects.toThrow("adapter failed");
		expect(events.map(event => event.status)).toEqual(["started", "failed"]);
		expect(events[1]?.runToken).toBe(events[0]?.runToken);
		expect(events[1]?.outcomeExcerpt).toBe("");
		expect(activeSubagentRuns(eventBus).size).toBe(0);
	});

	it("publishes external runs to the root bus and excerpts accepted Unicode output", async () => {
		const sessionBus = new EventBus();
		const rootBus = new EventBus();
		const starts = collectLifecycle(sessionBus);
		const rootFrames = collectLifecycle(rootBus);
		const output = `  ${"🪐".repeat(SUBAGENT_OUTCOME_EXCERPT_CHARS + 2)}  `;
		vi.spyOn(claudeExternalHarnessAdapter, "execute").mockImplementation(async () => {
			expect(activeSubagentRuns(rootBus).size).toBe(1);
			return settledResult({ output });
		});

		const result = await runSubprocess({ ...lifecycleRunOptions(sessionBus), subagentEventBus: rootBus });
		expect(result.output).toBe(output);
		expect(rootFrames.map(frame => frame.status)).toEqual(["started", "completed"]);
		expect(starts.map(frame => frame.runToken)).toEqual(rootFrames.map(frame => frame.runToken));
		expect([...rootFrames[1]!.outcomeExcerpt!].length).toBe(SUBAGENT_OUTCOME_EXCERPT_CHARS - 2);
		expect(rootFrames[1]!.outcomeExcerpt).toBe("🪐".repeat(SUBAGENT_OUTCOME_EXCERPT_CHARS - 2));
		expect(activeSubagentRuns(rootBus).size).toBe(0);
	});
});
