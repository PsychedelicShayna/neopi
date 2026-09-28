/**
 * Exit-with-parent: a process started by a host dies when the host dies, even
 * when the host is SIGKILLed and never signals its children.
 *
 * Headless print/json runs install this at startup (opt out with
 * `--no-exit-with-parent`). SDK embedders that spawn their own worker
 * processes can install the same behaviour with {@link exitWithParent}.
 *
 * When the watched parent dies, the run aborts every attached session, tears
 * down the child processes it owns (MCP servers including their `setsid`
 * process groups, async jobs, LSP servers, eval kernels, and everything else
 * registered with postmortem cleanup) within a fixed budget, then hard-exits
 * with {@link EXIT_WITH_PARENT_EXIT_CODE}.
 */
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { disposeAllVmContexts } from "./eval/js/context-manager";
import { disposeAllKernelSessions } from "./eval/py/executor";
import { shutdownAll as shutdownAllLspClients } from "./lsp/client";
import type { MCPManager } from "./mcp/manager";
import { killDetachedStdioProcessGroups } from "./mcp/transports/stdio";
import type { AgentSession } from "./session/agent-session";
import { SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "./session/agent-session-types";
import { watchParentProcess } from "./utils/parent-watchdog";

/** Exit status after the parent died: 128 + SIGHUP, the status a hung-up session reports. */
export const EXIT_WITH_PARENT_EXIT_CODE = 129;
/**
 * Default teardown budget after parent death. Covers an MCP server's SIGTERM
 * grace (1 s) before its group is SIGKILLed; anything still running when the
 * budget ends is SIGKILLed or abandoned by the hard exit.
 */
export const EXIT_WITH_PARENT_TEARDOWN_MS = 2_000;

/** Abort reason recorded on the aborted turn. */
const PARENT_EXIT_ABORT_REASON = "Parent process exited";

/** Options for {@link exitWithParent}. */
export interface ExitWithParentOptions {
	/**
	 * Parent pid recorded at startup. Defaults to `process.ppid` at call time;
	 * pass a value captured earlier when startup work precedes installation.
	 */
	parentPid?: number;
	/** Exit status after teardown. Defaults to {@link EXIT_WITH_PARENT_EXIT_CODE}. */
	exitCode?: number;
	/** Teardown budget in milliseconds. Defaults to {@link EXIT_WITH_PARENT_TEARDOWN_MS}. */
	teardownMs?: number;
}

/** Resources torn down with the process when the parent dies. */
export interface ExitWithParentTarget {
	session: AgentSession;
	/**
	 * MCP manager serving the session. Disconnected immediately (killing stdio
	 * servers' process groups) rather than after the session's dispose drain.
	 */
	mcpManager?: MCPManager;
}

/** Handle returned by {@link exitWithParent}. */
export interface ExitWithParent {
	/** Parent pid being watched (`0` when there is no parent to watch). */
	readonly parentPid: number;
	/** Register a session (and optional MCP manager) to abort and tear down on parent death. Returns a detach function. */
	attach(target: ExitWithParentTarget): () => void;
	/** Stop watching. Teardown already in progress is not cancelled. Idempotent. */
	stop(): void;
}

/**
 * Watch the parent process; when it dies, abort attached sessions, tear down
 * owned child processes within the budget, and hard-exit this process.
 *
 * Global process owners (LSP clients, eval kernels, detached MCP process
 * groups, postmortem registrations) are torn down even when no session is
 * attached yet, so a host dying during startup still leaves nothing behind.
 */
export function exitWithParent(options: ExitWithParentOptions = {}): ExitWithParent {
	const targets = new Set<ExitWithParentTarget>();
	const exitCode = options.exitCode ?? EXIT_WITH_PARENT_EXIT_CODE;
	const teardownMs = options.teardownMs ?? EXIT_WITH_PARENT_TEARDOWN_MS;
	const watchdog = watchParentProcess({
		parentPid: options.parentPid,
		onParentExit: () => void tearDownAfterParentExit([...targets], watchdog.parentPid, exitCode, teardownMs),
	});
	return {
		parentPid: watchdog.parentPid,
		attach(target) {
			targets.add(target);
			return () => {
				targets.delete(target);
			};
		},
		stop: () => watchdog.stop(),
	};
}

async function tearDownAfterParentExit(
	targets: ExitWithParentTarget[],
	parentPid: number,
	exitCode: number,
	teardownMs: number,
): Promise<never> {
	logger.warn("Parent process exited; tearing down and exiting", { parentPid, exitCode, teardownMs });
	const hardExit = (): never => {
		// Groups whose cooperative SIGTERM grace outlived the budget, and servers
		// still mid-connect, would survive the exit as orphans otherwise.
		killDetachedStdioProcessGroups();
		return postmortem.exitProcess(exitCode);
	};
	const deadline = setTimeout(hardExit, teardownMs);
	// The host held our stdio pipes: writes to them now fail with EPIPE. That is
	// the expected state of a run whose host is gone, not a fatal error that
	// should race this teardown with its own exit.
	postmortem.interceptUnhandledRejections(
		reason => reason instanceof Error && postmortem.classifyBrokenPipe(reason) === "stdio-write",
	);
	process.stdout.on("error", ignoreStreamError);
	process.stderr.on("error", ignoreStreamError);
	// Run inside the postmortem pass rather than beside it, so a competing
	// fatal or signal exit awaits these child-process kills instead of
	// skipping them.
	postmortem.register("exit-with-parent", () => tearDownOwnedProcesses(targets, teardownMs));
	// The pass also runs every other cleanup registration: session dispose,
	// LSP clients, Python kernels, browser tabs, SSH, daemon clients.
	await postmortem.cleanup();
	clearTimeout(deadline);
	return hardExit();
}

async function tearDownOwnedProcesses(targets: ExitWithParentTarget[], teardownMs: number): Promise<void> {
	const work: Promise<unknown>[] = [shutdownAllLspClients(), disposeAllKernelSessions(), disposeAllVmContexts()];
	for (const { session, mcpManager } of targets) {
		// abort() kills the running tool (a foreground bash command) right away;
		// dispose() reaches MCP and async jobs only after its drain windows, so
		// those are torn down directly as well. dispose() still has to run: it
		// alone releases browser tabs, computer sessions, provider state, session
		// disposers and the persistence flush. The overall deadline bounds it.
		work.push(session.abort({ reason: PARENT_EXIT_ABORT_REASON }));
		work.push(
			session.dispose({
				drainTimeoutMs: teardownMs,
				mnemopiConsolidateTimeoutMs: Math.min(teardownMs, SHUTDOWN_CONSOLIDATE_BUDGET_MS),
			}),
		);
		if (session.asyncJobManager) work.push(session.asyncJobManager.dispose({ timeoutMs: teardownMs }));
		if (mcpManager) work.push(mcpManager.disconnectAll());
	}
	await Promise.allSettled(work);
}

function ignoreStreamError(): void {}
