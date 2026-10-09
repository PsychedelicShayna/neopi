/**
 * Parent-liveness watchdog shared by the hidden worker subprocesses, headless
 * print/json runs, and SDK embedders that spawn their own workers.
 *
 * A process started by a host must not outlive that host, even when the host
 * is SIGKILLed and never gets to signal its children. The watchdog records the
 * parent pid, then detects its death two ways:
 *
 * - a native process handle (`pidfd` on Linux) whose `waitForExit()` settles
 *   the moment the parent exits, when the caller supplies the native API;
 * - a poll that notices reparenting (`process.ppid` changing) or a parent pid
 *   that no longer answers signal 0.
 *
 * The native API is injected rather than imported so this module stays out of
 * the native addon's load cost: the CLI entry imports it statically, before
 * its speculative first frame.
 */
import type * as Natives from "@oh-my-pi/pi-natives";

/** Default interval for the parent-liveness poll. */
export const PARENT_WATCHDOG_POLL_MS = 1_000;

/** The part of `@oh-my-pi/pi-natives` the watchdog uses for its native parent handle. */
export type ParentWatchdogNatives = Pick<typeof Natives, "Process" | "ProcessStatus">;

/** Options for {@link watchParentProcess}. */
export interface ParentWatchdogOptions {
	/**
	 * Parent pid to watch. Defaults to `process.ppid` at call time. Record it as
	 * early as possible: once the parent is gone the kernel reparents this
	 * process and `process.ppid` no longer names the original host.
	 */
	parentPid?: number;
	/** Poll interval in milliseconds. Defaults to {@link PARENT_WATCHDOG_POLL_MS}. */
	pollIntervalMs?: number;
	/**
	 * Native process API (`{ Process, ProcessStatus }` from `@oh-my-pi/pi-natives`).
	 * With it, parent death is noticed immediately; without it, by the poll.
	 */
	natives?: ParentWatchdogNatives;
	/**
	 * Invoked at most once, asynchronously, when the parent is gone — including
	 * when it was already gone at install time. Never invoked after `stop()`.
	 */
	onParentExit: () => void;
}

/** Handle returned by {@link watchParentProcess}. */
export interface ParentWatchdog {
	/** Parent pid being watched (`0` when there is no parent to watch). */
	readonly parentPid: number;
	/** Stop watching and release the native wait and poll timer. Idempotent. */
	stop(): void;
}

/**
 * Watch the parent process and invoke `onParentExit` once it dies.
 *
 * On POSIX a parent pid `<= 0` means there is nothing to watch (NeoPi running as
 * PID 1 in a container). Windows reports a missing parent as `<= 0`, which is
 * treated as already dead. The poll timer is unref'd; the native wait is
 * cancelled by `stop()`, so a stopped watchdog never holds the event loop open.
 */
export function watchParentProcess(options: ParentWatchdogOptions): ParentWatchdog {
	const parentPid = options.parentPid ?? process.ppid;
	const waitAbort = new AbortController();
	let pollTimer: NodeJS.Timeout | undefined;
	let done = false;

	const stop = (): void => {
		if (done) return;
		done = true;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		waitAbort.abort();
	};
	const fire = (): void => {
		if (done) return;
		stop();
		options.onParentExit();
	};
	const handle: ParentWatchdog = { parentPid, stop };

	if (parentPid <= 0) {
		if (process.platform === "win32") queueMicrotask(fire);
		return handle;
	}

	// On hosts where pidfd_open is blocked or unavailable (pre-5.3 kernels,
	// restrictive seccomp), Process.fromPid returns null even when the parent
	// is alive. Null means "no native handle", never "dead": the poll below
	// still decides liveness. PI_TEST_NO_NATIVES forces that fallback in tests.
	const natives = process.env.PI_TEST_NO_NATIVES ? undefined : options.natives;
	let parentProcess: Natives.Process | null = null;
	if (natives) {
		try {
			parentProcess = natives.Process.fromPid(parentPid);
		} catch {}
	}

	// Containers often run NeoPi as PID 1, so a child legitimately starts with
	// ppid 1. Treating ppid <= 1 as orphaned at boot would kill containerized
	// runs; reparenting is detected instead by `process.ppid` changing.
	const isParentAlive = (): boolean => {
		if (process.ppid !== parentPid) return false;
		if (parentProcess && natives) {
			try {
				return parentProcess.status() === natives.ProcessStatus.Running;
			} catch {}
		}
		try {
			process.kill(parentPid, 0);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException)?.code === "EPERM";
		}
	};

	if (!isParentAlive()) {
		queueMicrotask(fire);
		return handle;
	}

	// A native wait can fail or resolve false without the parent exiting.
	// Confirm liveness before firing; the poll keeps watching if the handle
	// becomes unusable while the parent remains alive.
	parentProcess?.waitForExit({ signal: waitAbort.signal }).then(
		exited => {
			if (exited || !isParentAlive()) fire();
		},
		() => {
			if (!isParentAlive()) fire();
		},
	);
	pollTimer = setInterval(() => {
		if (!isParentAlive()) fire();
	}, options.pollIntervalMs ?? PARENT_WATCHDOG_POLL_MS);
	pollTimer.unref();
	return handle;
}
