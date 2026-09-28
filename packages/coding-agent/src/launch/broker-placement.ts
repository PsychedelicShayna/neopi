import * as net from "node:net";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { cfgLaunchBrokerScope, cfgLaunchBrokerSlice } from "./settings";
import type { DaemonSpawnOptions } from "./spawn-options";

/** Connect budget for the user-manager probe; a live manager answers a local socket connect immediately. */
const USER_MANAGER_PROBE_TIMEOUT_MS = 250;

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

/** The broker settings, or their defaults for processes that never initialized settings. */
export function brokerScopeSettings(): { enabled: boolean; slice: string } {
	if (!isSettingsInitialized()) {
		return { enabled: cfgLaunchBrokerScope.default, slice: cfgLaunchBrokerSlice.default };
	}
	return { enabled: cfgLaunchBrokerScope.get(settings), slice: cfgLaunchBrokerSlice.get(settings) };
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

function spawnDetachedBroker(launch: BrokerLaunch, cmd: string[]): { exited: Promise<number> } {
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
 * non-zero before {@link LaunchedBroker.settle} (the scope could not be created, e.g. a rejected
 * slice name) is retried once in the client's cgroup, so a broken scope setup never strands clients.
 */
export function launchBroker(launch: BrokerLaunch, placement: BrokerPlacement, runtimeDir: string): LaunchedBroker {
	if (placement.kind === "inherit") {
		spawnDetachedBroker(launch, launch.cmd);
		logger.info("Daemon broker placed in the spawning client's cgroup", { runtimeDir, reason: placement.reason });
		return { settle() {} };
	}
	let settled = false;
	const child = spawnDetachedBroker(launch, [...placement.launcher, ...launch.cmd]);
	logger.info("Daemon broker placed in its own systemd user scope", {
		runtimeDir,
		unit: placement.unit,
		slice: placement.slice,
	});
	void child.exited.then(exitCode => {
		if (settled || exitCode === 0) return;
		settled = true;
		spawnDetachedBroker(launch, launch.cmd);
		logger.warn("Daemon broker scope launch failed; placed in the spawning client's cgroup", {
			runtimeDir,
			unit: placement.unit,
			slice: placement.slice,
			exitCode,
		});
	});
	return {
		settle() {
			settled = true;
		},
	};
}
