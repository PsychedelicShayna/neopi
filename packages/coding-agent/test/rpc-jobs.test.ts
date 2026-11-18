/**
 * Issue #665: `get_jobs`, `get_job_output`, `cancel_job` and `job_lifecycle` expose the `/jobs` sheet's data to RPC hosts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	cancelRpcJob,
	listRpcJobs,
	readRpcJobOutput,
	RpcJobEvents,
	type RpcJobLifecycleFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-jobs";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const OWNER = "Main";

describe("RPC background jobs", () => {
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let gates: PromiseWithResolvers<void>[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				getApiKey: () => "test-key",
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: OWNER,
			asyncJobManager: manager,
		});
		gates = [];
	});

	afterEach(async () => {
		for (const gate of gates) gate.resolve();
		await session.dispose();
		authStorage.close();
		AgentRegistry.resetGlobalForTests();
	});

	/** A job that reports `text`, then waits for the test to let it finish. */
	function gated(
		label: string,
		options: { type?: "bash" | "eval"; ownerId?: string; text?: string; fail?: string; foreground?: boolean } = {},
	): { id: string; gate: PromiseWithResolvers<void>; progress: (text: string) => Promise<void> } {
		const gate = Promise.withResolvers<void>();
		gates.push(gate);
		let report: ((text: string, details?: Record<string, unknown>) => Promise<void>) | undefined;
		const ready = Promise.withResolvers<void>();
		const id = manager.register(
			options.type ?? "bash",
			label,
			async ({ reportProgress }) => {
				report = reportProgress;
				if (options.text !== undefined) await reportProgress(options.text);
				ready.resolve();
				await gate.promise;
				if (options.fail) throw new Error(options.fail);
				return options.text ?? "done";
			},
			{ ownerId: options.ownerId ?? OWNER, foreground: options.foreground },
		);
		return {
			id,
			gate,
			progress: async text => {
				await ready.promise;
				await report?.(text);
			},
		};
	}

	test("lists running and settled jobs with the TUI sheet's facts, bounded by recentLimit", async () => {
		const running = gated("tail -f log", { text: "line 1\n" });
		const failing = gated("make", { fail: "exit 2" });
		const done = gated("echo hi", { text: "hi" });
		await running.progress("line 1\n");
		failing.gate.resolve();
		done.gate.resolve();
		await manager.getJob(failing.id)?.promise.catch(() => {});
		await manager.getJob(done.id)?.promise;

		const jobs = listRpcJobs(session);
		expect(jobs.rootId).toBe(OWNER);
		expect(jobs.running.map(job => job.id)).toEqual([running.id]);
		expect(jobs.running[0]).toMatchObject({
			type: "bash",
			label: "tail -f log",
			status: "running",
			ownerId: OWNER,
			outputBytes: 7,
		});
		expect(jobs.running[0].finishedAt).toBeUndefined();
		expect(jobs.runningCount).toBe(1);
		const byId = new Map(jobs.recent.map(job => [job.id, job]));
		expect(byId.get(failing.id)).toMatchObject({ status: "failed", error: expect.stringContaining("exit 2") });
		expect(byId.get(done.id)).toMatchObject({ status: "completed" });
		expect(byId.get(done.id)?.finishedAt).toBeGreaterThanOrEqual(byId.get(done.id)!.startedAt);
		expect(listRpcJobs(session, 1).recent).toHaveLength(1);
		expect(listRpcJobs(session, 0).recent).toHaveLength(0);
	});

	test("jobs owned outside the session's tree and foreground-backed jobs are not listed", () => {
		gated("other agent", { ownerId: "Stranger" });
		gated("pending foreground", { foreground: true });
		expect(listRpcJobs(session).running).toEqual([]);
		expect(readRpcJobOutput(session, "bg_1", 0)).toBeUndefined();
	});

	test("reads output incrementally by byte offset without splitting characters, and restarts when the offset overshoots", async () => {
		const job = gated("printer", { text: "héllo " });
		await job.progress("héllo ");
		const first = readRpcJobOutput(session, job.id, undefined);
		expect(first).toMatchObject({
			output: "héllo ",
			fromByte: 0,
			nextByte: 7,
			totalBytes: 7,
			reset: false,
			status: "running",
		});
		await job.progress("héllo wörld");
		const next = readRpcJobOutput(session, job.id, first!.nextByte);
		expect(next).toMatchObject({ output: "wörld", fromByte: 7, nextByte: 13, totalBytes: 13, reset: false });
		// An offset inside "ö" resumes on the next character boundary.
		expect(readRpcJobOutput(session, job.id, 9)?.output).toBe("rld");
		const overshoot = readRpcJobOutput(session, job.id, 999);
		expect(overshoot).toMatchObject({ reset: true, fromByte: 0, output: "héllo wörld" });
	});

	test("a revision tells appended output from a rolling tail that was replaced", async () => {
		const job = gated("rolling", { text: "AAAA" });
		await job.progress("AAAA");
		const first = readRpcJobOutput(session, job.id, undefined);
		expect(first).toMatchObject({ output: "AAAA", nextByte: 4, reset: false });
		expect(first?.revision).toBeString();
		// Same length, different bytes: an offset alone would answer empty and leave the client on "AAAA".
		await job.progress("BBBB");
		const replaced = readRpcJobOutput(session, job.id, first!.nextByte, first!.revision);
		expect(replaced).toMatchObject({ output: "BBBB", fromByte: 0, nextByte: 4, reset: true });
		// Longer replacement that merely shares a length prefix with the old text is not spliced either.
		await job.progress("CCCCDDDD");
		const longer = readRpcJobOutput(session, job.id, replaced!.nextByte, replaced!.revision);
		expect(longer).toMatchObject({ output: "CCCCDDDD", fromByte: 0, reset: true });
		// Genuinely appended text still reads incrementally with a matching revision.
		await job.progress("CCCCDDDDEEEE");
		const appended = readRpcJobOutput(session, job.id, longer!.nextByte, longer!.revision);
		expect(appended).toMatchObject({ output: "EEEE", fromByte: 8, nextByte: 12, reset: false });
		// Without a revision the offset alone is trusted, as for older clients.
		expect(readRpcJobOutput(session, job.id, 8)?.output).toBe("EEEE");
	});

	test("cancels only running jobs the session's agent owns", async () => {
		const running = gated("sleep 100");
		const foreign = gated("other", { ownerId: "Stranger" });
		expect(cancelRpcJob(session, "bg_nope")).toBe(false);
		expect(cancelRpcJob(session, foreign.id)).toBe(false);
		expect(cancelRpcJob(session, running.id)).toBe(true);
		expect(manager.getJob(running.id)?.status).toBe("cancelled");
		expect(cancelRpcJob(session, running.id)).toBe(false);
		expect(manager.getJob(foreign.id)?.status).toBe("running");
	});

	describe("job_lifecycle frames", () => {
		let frames: RpcJobLifecycleFrame[];
		let events: RpcJobEvents;

		beforeEach(() => {
			frames = [];
			events = new RpcJobEvents(session, frame => void frames.push(frame));
		});

		afterEach(() => events.dispose());

		test("announces registration, completion, failure and cancellation with the live running count", async () => {
			const ok = gated("ok");
			const bad = gated("bad", { fail: "boom" });
			const cancelled = gated("cancelled");
			await Bun.sleep(0);
			expect(frames.map(frame => [frame.event, frame.job.id])).toEqual([
				["registered", ok.id],
				["registered", bad.id],
				["registered", cancelled.id],
			]);
			expect(frames[2].runningCount).toBe(3);
			manager.cancel(cancelled.id);
			ok.gate.resolve();
			bad.gate.resolve();
			await manager.getJob(ok.id)?.promise;
			await manager.getJob(bad.id)?.promise.catch(() => {});
			const settled = frames.slice(3);
			expect(settled.map(frame => [frame.event, frame.job.status])).toEqual([
				["cancelled", "cancelled"],
				["completed", "completed"],
				["failed", "failed"],
			]);
			expect(settled.at(-1)?.runningCount).toBe(0);
			expect(settled.at(-1)?.job.error).toContain("boom");
		});

		test("coalesces a burst of progress into one frame and drops it when the job settles first", async () => {
			const chatty = gated("chatty", { text: "0" });
			await chatty.progress("0");
			for (const text of ["1", "12", "123"]) await chatty.progress(text);
			expect(frames.filter(frame => frame.event === "progress")).toHaveLength(0);
			await Bun.sleep(350);
			const progress = frames.filter(frame => frame.event === "progress");
			expect(progress).toHaveLength(1);
			expect(progress[0].job.outputBytes).toBe(3);
			const quick = gated("quick", { text: "x" });
			quick.gate.resolve();
			await manager.getJob(quick.id)?.promise;
			await Bun.sleep(350);
			expect(frames.filter(frame => frame.job.id === quick.id && frame.event === "progress")).toHaveLength(0);
		});

		test("a foreground-backed job is silent until promoted", async () => {
			const job = gated("foreground", { foreground: true });
			await Bun.sleep(0);
			expect(frames).toEqual([]);
			manager.backgroundJob(job.id);
			await Bun.sleep(0);
			expect(frames.map(frame => [frame.event, frame.job.id])).toEqual([["registered", job.id]]);
		});

		test("stops after dispose", async () => {
			events.dispose();
			gated("late");
			await Bun.sleep(0);
			expect(frames).toEqual([]);
		});
	});

	describe("commands", () => {
		let handle: (command: RpcCommand) => Promise<RpcResponse>;

		beforeEach(() => {
			const context: Pick<RpcCommandHandlerContext, "session" | "success" | "error"> = {
				session,
				success: (id, command, data) =>
					({
						id,
						type: "response",
						command,
						success: true,
						...(data !== undefined ? { data } : {}),
					}) as RpcResponse,
				error: (id, command, error) => ({ id, type: "response", command, success: false, error }),
			};
			handle = createRpcCommandHandler(context as RpcCommandHandlerContext);
		});

		test("serve the job helpers and validate their arguments", async () => {
			const job = gated("cmd", { text: "out" });
			await job.progress("out");
			const list = await handle({ id: "1", type: "get_jobs" });
			expect(list).toMatchObject({ success: true, command: "get_jobs", data: { running: [{ id: job.id }] } });
			const output = await handle({ id: "2", type: "get_job_output", jobId: job.id });
			expect(output).toMatchObject({ success: true, data: { output: "out", nextByte: 3 } });
			expect(await handle({ id: "3", type: "get_job_output", jobId: "bg_999" })).toMatchObject({
				success: false,
				error: "Job not found: bg_999",
			});
			expect(await handle({ id: "4", type: "get_job_output", jobId: "" })).toMatchObject({ success: false });
			expect(await handle({ id: "5", type: "get_job_output", jobId: job.id, fromByte: Number.NaN })).toMatchObject({
				success: false,
			});
			expect(await handle({ id: "6", type: "get_jobs", recentLimit: Number.NaN })).toMatchObject({ success: false });
			expect(
				await handle({ id: "6b", type: "get_job_output", jobId: job.id, revision: 7 } as unknown as RpcCommand),
			).toMatchObject({ success: false });
			expect(await handle({ id: "7", type: "cancel_job", jobId: job.id })).toMatchObject({
				success: true,
				data: { cancelled: true },
			});
			expect(await handle({ id: "8", type: "cancel_job", jobId: job.id })).toMatchObject({
				data: { cancelled: false },
			});
			expect(await handle({ id: "9", type: "cancel_job", jobId: 5 as unknown as string })).toMatchObject({
				success: false,
			});
		});
	});
});
