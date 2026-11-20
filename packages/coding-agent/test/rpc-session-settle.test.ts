import { describe, expect, test } from "bun:test";
import { RpcSessionSettleWatcher } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const agentStart: AgentSessionEvent = { type: "agent_start" };
const yieldedPause: AgentSessionEvent = { type: "agent_pause", messages: [], yielded: true, awaiting: true };
const agentEnd: AgentSessionEvent = { type: "agent_end", messages: [] };

/** Session whose run, live-loop and background-work state the test drives. */
function createSession() {
	const backgroundDone = Promise.withResolvers<void>();
	const session = {
		isRunActive: false,
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		pendingAsyncWork: false,
		settleCalls: 0,
		hasPendingAsyncWork() {
			return this.pendingAsyncWork;
		},
		async settleAsyncWork() {
			this.settleCalls++;
			await backgroundDone.promise;
		},
	};
	return { session, finishBackgroundWork: backgroundDone.resolve };
}

async function settleLoop(): Promise<void> {
	for (let hop = 0; hop < 4; hop++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("RpcSessionSettleWatcher", () => {
	test("a paused run settles only at its agent_end", async () => {
		const { session } = createSession();
		const frames: object[] = [];
		const watcher = new RpcSessionSettleWatcher(session, frame => frames.push(frame));

		// A transition check without agent activity owes no frame.
		await watcher.check();
		expect(frames).toEqual([]);

		// The model yields while a background job can still resume the run.
		session.isRunActive = true;
		watcher.observe(agentStart);
		watcher.observe(yieldedPause);
		await watcher.check();
		await settleLoop();
		expect(frames).toEqual([]);

		// The job result resumes the run; the follow-up loop ends it.
		watcher.observe(agentStart);
		session.isRunActive = false;
		watcher.observe(agentEnd);
		await settleLoop();

		expect(frames).toEqual([{ type: "session_settled" }]);
	});

	test("does not settle while another run is live, then settles on that run's end once", async () => {
		const { session } = createSession();
		const frames: object[] = [];
		const watcher = new RpcSessionSettleWatcher(session, frame => frames.push(frame));

		watcher.observe(agentStart);
		session.isRunActive = true;
		session.isStreaming = true;
		watcher.observe(agentEnd);
		await settleLoop();
		expect(frames).toEqual([]);

		session.isRunActive = false;
		session.isStreaming = false;
		watcher.observe(agentEnd);
		await settleLoop();
		watcher.observe(agentEnd);
		await settleLoop();

		// One stretch of activity settles once, even with a repeated end.
		expect(frames).toEqual([{ type: "session_settled" }]);
	});

	test("a run that ends with background work pending settles only after that work drains", async () => {
		const { session, finishBackgroundWork } = createSession();
		const frames: object[] = [];
		const watcher = new RpcSessionSettleWatcher(session, frame => frames.push(frame));

		// The run ends, but a job (started even while idle) can still wake the session.
		session.pendingAsyncWork = true;
		watcher.observe(agentStart);
		watcher.observe(agentEnd);
		await settleLoop();
		expect(frames).toEqual([]);
		expect(session.settleCalls).toBe(1);

		// The job delivers and nothing remains.
		session.pendingAsyncWork = false;
		finishBackgroundWork();
		await settleLoop();

		expect(frames).toEqual([{ type: "session_settled" }]);
	});
});
