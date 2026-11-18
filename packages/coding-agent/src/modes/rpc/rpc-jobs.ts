/**
 * Background jobs over RPC (`get_jobs`, `get_job_output`, `cancel_job`, `job_lifecycle`; capability
 * `background_jobs`). The data is the TUI `/jobs` sheet's: the session's async job tree, the job
 * inspector's output, and the owner-scoped cancel that `proc://<id>/kill` uses.
 */
import type { AsyncJobEvent } from "../../async";
import type { AgentSession, AsyncJobSnapshotItem } from "../../session/agent-session";

/** `recentLimit` default and ceiling for `get_jobs`. */
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;
/** One `get_job_output` reply carries at most this many bytes; the caller pages with `nextByte`. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 2000;
/** Progress frames of one job are at most this far apart. */
const PROGRESS_COALESCE_MS = 250;

export interface RpcJobInfo {
	/** Stable `bg_N` id. */
	id: string;
	type: "bash" | "task" | "eval" | "chronicle";
	label: string;
	/** Full command line of a job that runs a process; `label` is cut to 120 characters. */
	command?: string;
	status: "running" | "completed" | "failed" | "cancelled";
	/** Epoch milliseconds. */
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	/** Failure text of a failed job, cut to a bounded length. */
	error?: string;
	/** Registry id of the agent that registered the job. */
	ownerId?: string;
	/** Registry id of the subagent a task job runs. */
	agentId?: string;
	/** Size in bytes of the output snapshot `get_job_output` reads. */
	outputBytes: number;
}

export interface RpcJobsResult {
	/** The agent the tree is for; its own jobs are the top level. */
	rootId?: string;
	running: RpcJobInfo[];
	/** Settled jobs, newest first, at most `recentLimit`. */
	recent: RpcJobInfo[];
	/** Subagents owning listed jobs, with the ancestors linking them to the root. */
	agents: { id: string; parentId?: string }[];
	/** Running jobs by the TUI jobs-pill rule; equals `get_state.runningJobCount`. */
	runningCount: number;
}

export interface RpcJobOutputResult {
	jobId: string;
	status: RpcJobInfo["status"];
	fromByte: number;
	/** Pass as the next `fromByte` to read on. */
	nextByte: number;
	/** Size in bytes of the whole output snapshot. */
	totalBytes: number;
	/**
	 * `fromByte` exceeded the snapshot, or the snapshot no longer starts with what the caller holds
	 * (`revision` mismatch), so reading restarted at zero.
	 */
	reset: boolean;
	/** Identifies the snapshot bytes before `nextByte`; send it back with `fromByte: nextByte` to read on. */
	revision: string;
	output: string;
}

export type RpcJobLifecycleEvent = "registered" | "progress" | "completed" | "failed" | "cancelled";

export interface RpcJobLifecycleFrame {
	type: "job_lifecycle";
	event: RpcJobLifecycleEvent;
	job: RpcJobInfo;
	/** Running jobs by the TUI jobs-pill rule after this transition. */
	runningCount: number;
}

type RpcJobsSession = Pick<
	AgentSession,
	"getAsyncJobTree" | "inspectAsyncJob" | "cancelAsyncJob" | "getRunningBackgroundJobCount" | "subscribeAsyncJobs"
>;

function describeJob(session: RpcJobsSession, item: AsyncJobSnapshotItem): RpcJobInfo {
	const inspection = session.inspectAsyncJob(item.id);
	const output = inspection?.output;
	const finishedAt = item.endTime ?? (item.status === "running" ? undefined : Date.now());
	return {
		id: item.id,
		type: item.type,
		label: item.label,
		...(item.command !== undefined ? { command: item.command } : {}),
		status: item.status,
		startedAt: item.startTime,
		...(finishedAt !== undefined ? { finishedAt } : {}),
		...(inspection?.exitCode !== undefined ? { exitCode: inspection.exitCode } : {}),
		...(item.status === "failed" && output ? { error: output.slice(0, MAX_ERROR_CHARS) } : {}),
		...(item.ownerId !== undefined ? { ownerId: item.ownerId } : {}),
		...(item.agentId !== undefined ? { agentId: item.agentId } : {}),
		outputBytes: output ? Buffer.byteLength(output) : 0,
	};
}

/** The `/jobs` sheet's tree: this agent's jobs and those of the subagents below it. */
export function listRpcJobs(session: RpcJobsSession, recentLimit?: number): RpcJobsResult {
	const limit =
		recentLimit === undefined
			? DEFAULT_RECENT_LIMIT
			: Math.min(MAX_RECENT_LIMIT, Math.max(0, Math.trunc(recentLimit)));
	const tree = session.getAsyncJobTree({ recentLimit: limit });
	return {
		...(tree?.rootId !== undefined ? { rootId: tree.rootId } : {}),
		running: (tree?.running ?? []).map(item => describeJob(session, item)),
		recent: (tree?.recent ?? []).map(item => describeJob(session, item)),
		agents: tree?.agents ?? [],
		runningCount: session.getRunningBackgroundJobCount(),
	};
}

function revisionOf(bytes: Uint8Array): string {
	return `${bytes.length}:${Bun.hash(bytes).toString(16)}`;
}

/** A byte slice of the job's output snapshot, or undefined when the job is not in this session's tree. */
export function readRpcJobOutput(
	session: RpcJobsSession,
	jobId: string,
	fromByte: number | undefined,
	revision?: string,
): RpcJobOutputResult | undefined {
	const inspection = session.inspectAsyncJob(jobId);
	if (!inspection) return undefined;
	const tree = session.getAsyncJobTree({ recentLimit: Number.POSITIVE_INFINITY });
	const item = [...(tree?.running ?? []), ...(tree?.recent ?? [])].find(candidate => candidate.id === jobId);
	if (!item) return undefined;
	const bytes = Buffer.from(inspection.output ?? "", "utf8");
	let start = fromByte === undefined ? 0 : Math.max(0, Math.trunc(fromByte));
	let reset = false;
	if (start > bytes.length) {
		start = 0;
		reset = true;
	}
	// A running job's output is a rolling tail the producer replaces, so an offset alone cannot tell
	// "more text after what I hold" from "different text of the same length": the caller proves what it
	// holds with the revision of the bytes before `fromByte`.
	if (revision !== undefined && start > 0 && revisionOf(bytes.subarray(0, start)) !== revision) {
		start = 0;
		reset = true;
	}
	// Never split a multi-byte character: start on and end before a character boundary.
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	let end = Math.min(bytes.length, start + MAX_OUTPUT_BYTES);
	while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return {
		jobId,
		status: item.status,
		fromByte: start,
		nextByte: end,
		totalBytes: bytes.length,
		reset,
		revision: revisionOf(bytes.subarray(0, end)),
		output: bytes.subarray(start, end).toString("utf8"),
	};
}

/** Cancel a running job the session's own agent owns; false for unknown, foreign or settled jobs. */
export function cancelRpcJob(session: RpcJobsSession, jobId: string): boolean {
	return session.cancelAsyncJob(jobId);
}

const LIFECYCLE_EVENTS: Record<AsyncJobEvent["type"], RpcJobLifecycleEvent> = {
	register: "registered",
	background: "registered",
	progress: "progress",
	complete: "completed",
	failed: "failed",
	cancelled: "cancelled",
};

/**
 * Forwards the session's job transitions as `job_lifecycle` frames so a host keeps a live list and count.
 * Progress frames are coalesced per job; every other transition is sent at once and supersedes a pending
 * progress frame.
 */
export class RpcJobEvents {
	readonly #session: RpcJobsSession;
	readonly #output: (frame: RpcJobLifecycleFrame) => void;
	readonly #pending = new Map<string, NodeJS.Timeout>();
	readonly #unsubscribe: () => void;
	#disposed = false;

	constructor(session: RpcJobsSession, output: (frame: RpcJobLifecycleFrame) => void) {
		this.#session = session;
		this.#output = output;
		this.#unsubscribe = session.subscribeAsyncJobs(event => this.#onEvent(event.type, event.job));
	}

	#send(event: RpcJobLifecycleEvent, job: AsyncJobSnapshotItem): void {
		this.#output({
			type: "job_lifecycle",
			event,
			job: describeJob(this.#session, job),
			runningCount: this.#session.getRunningBackgroundJobCount(),
		});
	}

	#onEvent(type: AsyncJobEvent["type"], job: AsyncJobSnapshotItem): void {
		const event = LIFECYCLE_EVENTS[type];
		if (event === "progress") {
			if (this.#pending.has(job.id)) return;
			this.#pending.set(
				job.id,
				setTimeout(() => {
					this.#pending.delete(job.id);
					this.#send("progress", job);
				}, PROGRESS_COALESCE_MS),
			);
			return;
		}
		const timer = this.#pending.get(job.id);
		if (timer) {
			clearTimeout(timer);
			this.#pending.delete(job.id);
		}
		// The manager announces a transition before its own tables reflect it (a registering job is not listed
		// yet), so describe the job and count running ones one microtask later, in event order.
		queueMicrotask(() => {
			if (!this.#disposed) this.#send(event, job);
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
	}
}
