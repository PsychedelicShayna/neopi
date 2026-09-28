// Real processes and sockets: placement probes a unix socket standing in for the systemd user
// manager's private endpoint and resolves a stand-in `systemd-run` on PATH, so the decision and the
// fallback run exactly as they do against a live manager, without creating real systemd units.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest } from "../../src/config/settings";
import { type BrokerPlacement, launchBroker, resolveBrokerPlacement } from "../../src/launch/broker-placement";
import { createDaemonBrokerClient } from "../../src/launch/client";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface FakeSystemd {
	root: string;
	env: Record<string, string>;
}

/** A PATH holding a stand-in `systemd-run` and a runtime dir whose manager socket answers when `listening`. */
async function fakeSystemd(systemdRunScript: string | undefined, listening: boolean): Promise<FakeSystemd> {
	const tempDir = TempDir.createSync("@omp-broker-placement-");
	cleanups.push(() => tempDir.removeSync());
	const root = tempDir.path();
	const binDir = path.join(root, "bin");
	const runtimeDir = path.join(root, "run");
	await fs.mkdir(binDir);
	await fs.mkdir(path.join(runtimeDir, "systemd"), { recursive: true });
	if (systemdRunScript !== undefined) {
		const launcher = path.join(binDir, "systemd-run");
		await Bun.write(launcher, `#!/bin/sh\n${systemdRunScript}\n`);
		await fs.chmod(launcher, 0o755);
	}
	const managerSocket = path.join(runtimeDir, "systemd", "private");
	if (listening) {
		const listener = Bun.listen({ unix: managerSocket, socket: { data() {} } });
		cleanups.push(() => listener.stop(true));
	} else {
		// A socket file left by a dead manager: present on disk, refuses connections.
		await Bun.write(managerSocket, "");
	}
	return { root, env: { PATH: binDir, XDG_RUNTIME_DIR: runtimeDir } };
}

function placementFor(fake: FakeSystemd, overrides: { platform?: NodeJS.Platform; enabled?: boolean; slice?: string }) {
	return resolveBrokerPlacement({
		platform: overrides.platform ?? "linux",
		enabled: overrides.enabled ?? true,
		slice: overrides.slice ?? "neopi-broker.slice",
		unit: "neopi-broker-test.scope",
		description: "test broker",
		env: fake.env,
	});
}

/** Run the broker command through `launchBroker` and resolve with how it reports being launched. */
async function launchedVia(fake: FakeSystemd, placement: BrokerPlacement, startupTimeoutMs?: number): Promise<string> {
	const reportSocket = path.join(fake.root, "report.sock");
	const { promise, resolve } = Promise.withResolvers<string>();
	const listener = Bun.listen({
		unix: reportSocket,
		socket: { data: (_socket, data) => resolve(data.toString("utf8")) },
	});
	cleanups.push(() => listener.stop(true));
	const report =
		'const s = await Bun.connect({ unix: process.env.REPORT_SOCKET, socket: { data() {} } }); s.end(process.env.LAUNCHED_VIA ?? "direct");';
	launchBroker(
		{
			cmd: [process.execPath, "-e", report],
			cwd: fake.root,
			env: { ...fake.env, REPORT_SOCKET: reportSocket },
			spawnOptions: { detached: true },
		},
		placement,
		fake.root,
		startupTimeoutMs,
	);
	return promise;
}

describe("resolveBrokerPlacement", () => {
	it("scopes the broker under the configured slice when systemd-run and the user manager are available", async () => {
		const fake = await fakeSystemd("exit 0", true);
		const placement = await placementFor(fake, { slice: "custom-broker.slice" });
		expect(placement.kind).toBe("scope");
		if (placement.kind !== "scope") return;
		expect(placement.launcher[0]).toBe(path.join(fake.env.PATH, "systemd-run"));
		expect(placement.launcher).toEqual(
			expect.arrayContaining([
				"--user",
				"--scope",
				"--collect",
				"--slice=custom-broker.slice",
				"--unit=neopi-broker-test.scope",
			]),
		);
	});

	it("falls back to the default slice when the configured slice is blank", async () => {
		const fake = await fakeSystemd("exit 0", true);
		const placement = await placementFor(fake, { slice: "  " });
		expect(placement.kind === "scope" && placement.slice).toBe("neopi-broker.slice");
	});

	it("keeps the broker inherited when launch.brokerScope is false even though systemd is available", async () => {
		const fake = await fakeSystemd("exit 0", true);
		expect(await placementFor(fake, { enabled: false })).toEqual({
			kind: "inherit",
			reason: "launch.brokerScope is false",
		});
	});

	it("keeps the broker inherited when systemd-run is not on PATH", async () => {
		const fake = await fakeSystemd(undefined, true);
		expect((await placementFor(fake, {})).kind).toBe("inherit");
	});

	it("keeps the broker inherited when the user manager socket refuses connections", async () => {
		const fake = await fakeSystemd("exit 0", false);
		expect(await placementFor(fake, {})).toEqual({ kind: "inherit", reason: "systemd user manager unreachable" });
	});

	it("keeps the broker inherited off Linux", async () => {
		const fake = await fakeSystemd("exit 0", true);
		expect((await placementFor(fake, { platform: "darwin" })).kind).toBe("inherit");
	});
});

describe("launchBroker", () => {
	it("runs the broker through the scope launcher", async () => {
		// Stand-in systemd-run: skip its options, then exec the broker command like `--scope` does.
		const fake = await fakeSystemd('while [ "${1#--}" != "$1" ]; do shift; done\nLAUNCHED_VIA=scope exec "$@"', true);
		expect(await launchedVia(fake, await placementFor(fake, {}))).toBe("scope");
	});

	it("starts the broker directly when the scope launcher fails", async () => {
		const fake = await fakeSystemd("exit 1", true);
		expect(await launchedVia(fake, await placementFor(fake, {}))).toBe("direct");
	});

	it("kills a hanging scope launcher and starts the broker directly once the startup deadline passes", async () => {
		const fake = await fakeSystemd("", true);
		const pidFile = path.join(fake.root, "launcher.pid");
		// Stand-in systemd-run that never starts the broker, like a manager that accepts the socket but
		// stalls. The broker env's PATH holds only the stand-in, so the hang uses an absolute binary.
		await Bun.write(
			path.join(fake.env.PATH, "systemd-run"),
			`#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" -e "setTimeout(() => {}, 30_000)"\n`,
		);
		// Runs before the temp dir removal registered by fakeSystemd, while the pid file still exists.
		cleanups.unshift(() => {
			try {
				process.kill(Number.parseInt(readFileSync(pidFile, "utf8"), 10), "SIGKILL");
			} catch {
				// Already gone: the expected outcome.
			}
		});
		const launched = await launchedVia(fake, await placementFor(fake, {}), 300);
		const launcherPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
		let launcherAlive = true;
		try {
			process.kill(launcherPid, 0);
		} catch {
			launcherAlive = false;
		}
		expect(launched).toBe("direct");
		expect(launcherAlive).toBe(false);
	});
});

describe("daemon broker client placement", () => {
	const savedEnv = { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetSettingsForTest();
	});

	/**
	 * Start a broker through a real client with no settings loaded in this process, and report whether
	 * the spawn went through the (recording, then exec'ing) stand-in `systemd-run`.
	 */
	async function spawnedThroughScope(brokerScope: boolean): Promise<boolean> {
		resetSettingsForTest();
		const fake = await fakeSystemd("", true);
		const marker = path.join(fake.root, "systemd-run-invoked");
		// Stand-in systemd-run: record the call, skip its options, then exec the broker like `--scope` does.
		await Bun.write(
			path.join(fake.env.PATH, "systemd-run"),
			`#!/bin/sh\necho "$@" > "${marker}"\nwhile [ "\${1#--}" != "$1" ]; do shift; done\nexec "$@"\n`,
		);
		const projectDir = path.join(fake.root, "project");
		await fs.mkdir(getProjectAgentDir(projectDir), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			`launch:\n  brokerScope: ${brokerScope}\n`,
		);
		process.env.PATH = `${fake.env.PATH}${path.delimiter}${savedEnv.PATH ?? ""}`;
		process.env.XDG_RUNTIME_DIR = fake.env.XDG_RUNTIME_DIR;
		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir: path.join(fake.root, "broker-run"),
			idleGraceMs: 100,
		});
		try {
			const ping = await client.request({ op: "ping" });
			expect(ping.op).toBe("ping");
			await client.request({ op: "shutdown" });
		} finally {
			client.close();
		}
		return Bun.file(marker).exists();
	}

	it("keeps the broker out of a scope when the persisted project config sets launch.brokerScope: false", async () => {
		expect(await spawnedThroughScope(false)).toBe(false);
	});

	it("launches the broker through systemd-run when the persisted config enables the scope", async () => {
		expect(await spawnedThroughScope(true)).toBe(true);
	});
});
