// Real processes and sockets: placement probes a unix socket standing in for the systemd user
// manager's private endpoint and resolves a stand-in `systemd-run` on PATH, so the decision and the
// fallback run exactly as they do against a live manager, without creating real systemd units.
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type BrokerPlacement, launchBroker, resolveBrokerPlacement } from "../../src/launch/broker-placement";

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
async function launchedVia(fake: FakeSystemd, placement: BrokerPlacement): Promise<string> {
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
});
