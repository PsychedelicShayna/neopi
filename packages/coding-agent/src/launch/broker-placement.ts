import * as net from "node:net";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import { findScopedSettings, Settings } from "../config/settings";
import { cfgLaunchBrokerScope, cfgLaunchBrokerSlice } from "./settings";
import type { DaemonSpawnOptions } from "./spawn-options";

/** Connect budget for the user-manager probe; a live manager answers a local socket connect immediately. */
const USER_MANAGER_PROBE_TIMEOUT_MS = 250;
/**
 * How long a scoped launch may take to produce a reachable broker before the launcher is killed
 * and the broker is started directly; well under the client's 10 s connect budget, so the direct
 * broker still has time to come up when systemd hangs.
 */
export const SCOPE_STARTUP_TIMEOUT_MS = 4_000;

/** Where a freshly spawned daemon broker runs. */
export type BrokerPlacement =
	| {
			/** Own transient systemd user scope, outside the spawning client's cgroup. */
			kind: "scope";
			unit: string;
			slice: string;
			/** `systemd-run` argv prefix; the broker command follows it. */
			launcher: string[];
	  }
	| {
			/** The spawning client's cgroup, in a new session (`setsid`). */
			kind: "inherit";
			reason: string;
	  };

export interface BrokerPlacementInput {
	platform: NodeJS.Platform;
	/** `launch.brokerScope`. */
	enabled: boolean;
	/** `launch.brokerSlice`; blank selects the default slice. */
	slice: string;
	/** Scope unit name, including the `.scope` suffix. */
	unit: string;
	description: string;
	/** Environment the broker is spawned with; supplies `PATH` and `XDG_RUNTIME_DIR`. */
	env: Record<string, string | undefined>;
}

/**
 * Effective `launch.brokerScope` / `launch.brokerSlice` for a broker spawn: the active session's or
 * the process's settings when one is loaded, otherwise the persisted global and project config for
 * `cwd` (`npi ps` and SDK embedders spawn brokers without initializing the settings singleton).
 */
export async function brokerScopeSettings(cwd: string): Promise<{ enabled: boolean; slice: string }> {
	let effective = findScopedSettings();
	if (!effective) {
		try {
			effective = await Settings.loadReadOnly({ cwd });
		} catch (error) {
			logger.warn("Failed to read broker placement settings; using defaults", {
				cwd,
				error: error instanceof Error ? error.message : String(error),
			});
			return { enabled: cfgLaunchBrokerScope.default, slice: cfgLaunchBrokerSlice.default };
		}
	}
	return { enabled: cfgLaunchBrokerScope.get(effective), slice: cfgLaunchBrokerSlice.get(effective) };
}

/** Unique transient scope name for one broker spawn; the hash ties it to its project in `systemctl --user`. */
export function brokerScopeUnit(projectDir: string): string {
	const project = Bun.hash.wyhash(projectDir).toString(16).padStart(16, "0").slice(0, 12);
	return `neopi-broker-${project}-${crypto.randomUUID().slice(0, 8)}.scope`;
}

/**
 * Whether the systemd user manager answers on its private socket, the local transport
 * `systemd-run --user` uses. A connect costs no process spawn and rejects stale socket files.
 */
export function userManagerReachable(runtimeDir: string | undefined): Promise<boolean> {
	if (!runtimeDir) return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect(path.join(runtimeDir, "systemd", "private"));
	const settle = (reachable: boolean): void => {
		clearTimeout(timer);
		socket.destroy();
		resolve(reachable);
	};
	const timer = setTimeout(() => settle(false), USER_MANAGER_PROBE_TIMEOUT_MS);
	socket.once("connect", () => settle(true));
	socket.once("error", () => settle(false));
	return promise;
}

/** Decide where the broker runs: its own systemd user scope when available and enabled, else inherited. */
export async function resolveBrokerPlacement(input: BrokerPlacementInput): Promise<BrokerPlacement> {
	if (input.platform !== "linux") return { kind: "inherit", reason: `unsupported platform ${input.platform}` };
	if (!input.enabled) return { kind: "inherit", reason: "launch.brokerScope is false" };
	const systemdRun = $which("systemd-run", { PATH: input.env.PATH });
	if (!systemdRun) return { kind: "inherit", reason: "systemd-run not found on PATH" };
	if (!(await userManagerReachable(input.env.XDG_RUNTIME_DIR))) {
		return { kind: "inherit", reason: "systemd user manager unreachable" };
	}
	const slice = input.slice.trim() || cfgLaunchBrokerSlice.default;
	return {
		kind: "scope",
		unit: input.unit,
		slice,
		launcher: [
			systemdRun,
			"--user",
			"--scope",
			"--collect",
			"--quiet",
			`--slice=${slice}`,
			`--unit=${input.unit}`,
			`--description=${input.description}`,
		],
	};
}

export interface BrokerLaunch {
	cmd: string[];
	cwd: string | undefined;
	env: Record<string, string>;
	spawnOptions: DaemonSpawnOptions;
}

/** Handle for a broker spawn whose scope launcher is still watched for failure. */
export interface LaunchedBroker {
	/** Stop watching the scope launcher; call once the endpoint answers or startup gives up. */
	settle(): void;
}

interface SpawnedBroker {
	exited: Promise<number>;
	kill(signal?: NodeJS.Signals | number): void;
}

function spawnDetachedBroker(launch: BrokerLaunch, cmd: string[]): SpawnedBroker {
	const child = Bun.spawn(cmd, {
		cwd: launch.cwd,
		env: launch.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		...launch.spawnOptions,
	});
	child.unref();
	return child;
}

/**
 * Spawn the broker where `placement` says and log the placement. A scoped launch that exits
 * non-zero (the scope could not be created, e.g. a rejected slice name) or has not produced a
 * reachable broker within `startupTimeoutMs` (systemd hanging) before {@link LaunchedBroker.settle}
 * is replaced once by a broker in the client's cgroup — the launcher is killed first — so a broken
 * scope setup never strands clients.
 */
export function launchBroker(
	launch: BrokerLaunch,
	placement: BrokerPlacement,
	runtimeDir: string,
	startupTimeoutMs = SCOPE_STARTUP_TIMEOUT_MS,
): LaunchedBroker {
	if (placement.kind === "inherit") {
		spawnDetachedBroker(launch, launch.cmd);
		logger.info("Daemon broker placed in the spawning client's cgroup", { runtimeDir, reason: placement.reason });
		return { settle() {} };
	}
	// A shared scope outlives the worker that first opened it. The deck's
	// generation sweep must not claim its broker or daemon children; retain
	// the marker in the original launch for direct and failed-scope fallback.
	let scopedLaunch = launch;
	if ("NPI_DECK_GEN" in launch.env) {
		const env = { ...launch.env };
		delete env.NPI_DECK_GEN;
		scopedLaunch = { ...launch, env };
	}
	let settled = false;
	const child = spawnDetachedBroker(scopedLaunch, [...placement.launcher, ...launch.cmd]);
	logger.info("Daemon broker placed in its own systemd user scope", {
		runtimeDir,
		unit: placement.unit,
		slice: placement.slice,
	});
	const deadline = setTimeout(() => {
		if (settled) return;
		child.kill("SIGKILL");
		fallBack({ timeoutMs: startupTimeoutMs });
	}, startupTimeoutMs);
	deadline.unref();
	const settle = (): void => {
		settled = true;
		clearTimeout(deadline);
	};
	const fallBack = (failure: Record<string, unknown>): void => {
		if (settled) return;
		settle();
		spawnDetachedBroker(launch, launch.cmd);
		logger.warn("Daemon broker scope launch failed; placed in the spawning client's cgroup", {
			runtimeDir,
			unit: placement.unit,
			slice: placement.slice,
			...failure,
		});
	};
	void child.exited.then(exitCode => {
		// Exit 0 is a scoped broker that already ran and left (e.g. it lost the lease race to a live
		// broker); the client connects to whichever broker holds the endpoint.
		if (exitCode === 0) settle();
		else fallBack({ exitCode });
	});
	return { settle };
}
