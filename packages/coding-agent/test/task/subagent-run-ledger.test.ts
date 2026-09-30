import { describe, expect, it } from "bun:test";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { ACTIVE_RUN_LEDGER_MAX, activeSubagentRuns, emitSubagentFrame, EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function start(runToken: string, id = "reused-id"): SubagentLifecyclePayload {
	return { id, runToken, status: "started", agent: "worker", agentSource: "user", index: 0, runKind: "spawn", depth: 1 };
}

describe("subagent active-run ledger", () => {
	it("records before listeners, separates same-id runs, and never borrows unowned historical attribution", () => {
		const bus = new EventBus();
		const first = start("T1");
		let observedBeforeListener = false;
		const unsubscribe = bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, () => {
			observedBeforeListener = activeSubagentRuns(bus).has("T1");
			unsubscribe();
		});
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, first);
		expect(observedBeforeListener).toBe(true);
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_PROGRESS_CHANNEL, {
			runToken: "T1", owned: false, runEffectiveModelIdentity: "old/model", runEffectiveThinkingLevel: "max",
			progress: { resolvedModel: "old/model", resolvedThinkingLevel: "max" },
		});
		expect(activeSubagentRuns(bus).get("T1")?.runEffectiveModelIdentity).toBeUndefined();
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_PROGRESS_CHANNEL, {
			runToken: "T1", owned: true, runEffectiveModelIdentity: "new/model", runEffectiveThinkingLevel: "high",
		});
		expect(first.runEffectiveModelIdentity).toBeUndefined();
		const snapshot = activeSubagentRuns(bus);
		expect(snapshot.get("T1")?.runEffectiveModelIdentity).toBe("new/model");
		expect(snapshot.get("T1")?.runEffectiveThinkingLevel).toBe("high");
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, start("T2"));
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...first, status: "completed", outcomeExcerpt: "accepted" });
		expect([...activeSubagentRuns(bus).keys()]).toEqual(["T2"]);
		expect(snapshot.has("T1")).toBe(true);
	});

	it("evicts only the oldest active token and removes a settled token", () => {
		const bus = new EventBus();
		for (let n = 0; n <= ACTIVE_RUN_LEDGER_MAX; n++) {
			emitSubagentFrame(bus, undefined, TASK_SUBAGENT_LIFECYCLE_CHANNEL, start(`T${n}`));
		}
		expect(activeSubagentRuns(bus).size).toBe(ACTIVE_RUN_LEDGER_MAX);
		expect(activeSubagentRuns(bus).has("T0")).toBe(false);
		expect(activeSubagentRuns(bus).has("T1")).toBe(true);
		emitSubagentFrame(bus, undefined, TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...start("T1"), status: "failed", outcomeExcerpt: "" });
		expect(activeSubagentRuns(bus).has("T1")).toBe(false);
	});
});
