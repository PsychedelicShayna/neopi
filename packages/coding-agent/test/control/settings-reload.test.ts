import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ControlClient } from "../../src/control/client";
import { publishControlEndpoint, readControlEntries, type ControlPublication } from "../../src/control/registry";
import { broadcastSettingsReload } from "../../src/control/settings-reload";

const children: Bun.Subprocess[] = [];
const clients: ControlClient[] = [];
let dir: string | undefined;
let stalled: ControlPublication | undefined;
let previousControlDir: string | undefined;
afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	await stalled?.close();
	stalled = undefined;
	vi.restoreAllMocks();
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	if (previousControlDir === undefined) delete process.env.PI_CONTROL_DIR;
	else process.env.PI_CONTROL_DIR = previousControlDir;
});

test("every Apply reaches all receivers repeatedly, project targets are isolated, and dead sockets time out", async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-reload-"));
	const registry = path.join(dir, "ctl");
	const profile = path.join(dir, "profile");
	const projects = [path.join(dir, "a"), path.join(dir, "a"), path.join(dir, "b")];
	await fs.mkdir(registry, { mode: 0o700 });
	await Bun.write(path.join(profile, "config.yml"), "theme:\n  dark: titanium\n");
	previousControlDir = process.env.PI_CONTROL_DIR;
	process.env.PI_CONTROL_DIR = registry;
	for (const cwd of projects) {
		await fs.mkdir(cwd, { recursive: true });
		children.push(
			Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixtures/settings-reload-host.ts")], {
				cwd,
				env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_CONTROL_DIR: registry },
				stdin: "pipe",
				stdout: "ignore",
				stderr: "pipe",
			}),
		);
	}
	const deadline = Date.now() + 15000;
	let entries = await readControlEntries();
	while (entries.length !== 3) {
		for (const child of children)
			if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
		if (Date.now() > deadline) throw new Error("Receivers did not publish");
		await Bun.sleep(20);
		entries = await readControlEntries();
	}
	for (const { meta } of entries) {
		const client = new ControlClient({ metadata: meta, label: "test", timeoutMs: 2000 });
		await client.connect();
		clients.push(client);
	}
	const values = () =>
		Promise.all(
			clients.map(async client => (await client.request({ type: "settings_get", path: "theme.dark" })).data),
		);
	for (const theme of ["anthracite", "dark", "titanium"]) {
		await Bun.write(path.join(profile, "config.yml.next"), `theme:\n  dark: ${theme}\n`);
		await fs.rename(path.join(profile, "config.yml.next"), path.join(profile, "config.yml"));
		expect(await broadcastSettingsReload("global")).toEqual({ notified: 3, failed: 0, unsupported: 0 });
		expect(await values()).toEqual(Array.from({ length: 3 }, () => ({ path: "theme.dark", value: theme })));
	}
	await Bun.write(path.join(projects[0], ".omp/config.yml"), "theme:\n  dark: anthracite\n");
	const alias = path.join(dir, "alias-a");
	await fs.symlink(projects[0], alias, "dir");
	expect(await broadcastSettingsReload("project", alias)).toEqual({ notified: 2, failed: 0, unsupported: 0 });
	for (const [i, value] of (await values()).entries())
		expect(value).toEqual({
			path: "theme.dark",
			value: entries[i].meta.cwd === projects[0] ? "anthracite" : "titanium",
		});
	expect(await broadcastSettingsReload("session")).toEqual({ notified: 0, failed: 0, unsupported: 0 });
	const mismatched = clients.find((_client, i) => entries[i].meta.cwd === projects[2])!;
	expect(
		(await mismatched.request({ type: "reload_settings", scope: "project", projectDir: projects[0] })).data,
	).toEqual({ applied: false });
	const unsupported = vi.spyOn(ControlClient.prototype, "request").mockResolvedValue({
		type: "response",
		command: "reload_settings",
		success: false,
		error: "Unknown command: reload_settings",
	});
	expect(await broadcastSettingsReload("global")).toEqual({ notified: 0, failed: 0, unsupported: 3 });
	unsupported.mockRestore();
	const sockets: net.Socket[] = [];
	stalled = await publishControlEndpoint({
		dir: registry,
		role: "rpc",
		instanceId: "settingsstalled123",
		imageId: "test",
		execPath: process.execPath,
		gitSha: null,
		profile: null,
		sessionId: null,
		sessionFile: null,
		title: null,
		cwd: projects[0],
		tmuxPane: null,
		tmuxSession: null,
		tmuxWindow: null,
		tty: null,
		onConnection: socket => sockets.push(socket),
	});
	// Preserve its live PID while avoiding the helper's sender exclusion for this synthetic unresponsive host.
	const metadata = stalled.metadata();
	await Bun.write(stalled.metadataPath, JSON.stringify({ ...metadata, pid: process.ppid, procStartTicks: null }));
	const started = Date.now();
	expect(await broadcastSettingsReload("global")).toEqual({ notified: 3, failed: 1, unsupported: 0 });
	expect(Date.now() - started).toBeLessThan(3000);
	for (const socket of sockets) socket.destroy();
}, 30000);
