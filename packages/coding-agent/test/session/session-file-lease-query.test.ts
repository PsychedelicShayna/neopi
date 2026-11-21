import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ControlClient } from "@oh-my-pi/pi-coding-agent/control/client";
import { readControlEntries } from "@oh-my-pi/pi-coding-agent/control/registry";
import { sessionLeasePath } from "@oh-my-pi/pi-coding-agent/session/session-lease";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcChild } from "../helpers/rpc-child";

const CLI = path.join(import.meta.dir, "../../src/cli.ts");
const SESSION_MANAGER = path.join(import.meta.dir, "../../src/session/session-manager.ts");

async function runCli(root: TempDir, ...args: string[]) {
	const child = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: root.path(),
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root.join("agent"),
			PI_CONTROL_DIR: root.join("control"),
			XDG_CONFIG_HOME: root.path(),
			XDG_STATE_HOME: root.path(),
			XDG_DATA_HOME: root.path(),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function query(root: TempDir, file: string): Promise<unknown> {
	const result = await runCli(root, "session", "lease", "--file", file);
	expect(result.exitCode, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

async function publication(root: TempDir, child: RpcChild) {
	await child.waitFor(frame => frame.type === "ready", 30_000);
	const entries = await readControlEntries({ dir: root.join("control"), prune: false });
	const entry = entries.find(({ meta }) => meta.pid === child.process.pid);
	if (!entry?.meta.sessionFile) throw new Error(`RPC process ${child.process.pid} published no session file`);
	return entry;
}

async function directorySnapshot(dir: string) {
	return Promise.all(
		(await fs.readdir(dir)).sort().map(async name => {
			const file = path.join(dir, name);
			const stat = await fs.lstat(file);
			return { name, mtimeMs: stat.mtimeMs, bytes: stat.isFile() ? await fs.readFile(file) : null };
		}),
	);
}

describe("exact session file lease query", () => {
	it("attests a fresh untitled process without creating its transcript or changing its directory", async () => {
		await using root = await TempDir.create("@omp-file-lease-");
		const dir = root.join("sessions");
		const child = await RpcChild.spawn({
			root: root.path(),
			mode: "rpc-ui",
			args: ["--cwd", root.path(), "--session-dir", dir, "--new-session"],
			env: { PI_CONTROL_DIR: root.join("control") },
		});
		try {
			const { meta } = await publication(root, child);
			const file = meta.sessionFile!;
			const { pid, instanceId, imageId } = meta;
			const key = path.join(await fs.realpath(dir), path.basename(file));
			const before = await directorySnapshot(dir);
			expect(meta.title).toBeNull();
			expect(before.map(entry => entry.name)).not.toContain(path.basename(file));
			expect(await query(root, path.relative(root.path(), file))).toEqual({
				status: "held",
				sessionFile: key,
				holder: { pid, instanceId, imageId },
			});
			expect(await directorySnapshot(dir)).toEqual(before);
		} finally {
			await child.dispose();
		}
	}, 60_000);

	it("rejects false attribution and a second writer on a persisted zero-turn transcript", async () => {
		await using root = await TempDir.create("@omp-file-lease-");
		const dir = root.join("sessions");
		const seed = SessionManager.create(root.path(), dir);
		await seed.ensureOnDisk();
		await seed.close();
		const file = await fs.realpath(seed.getSessionFile()!);
		const alias = root.join("alias.jsonl");
		await fs.symlink(file, alias);
		const env = { PI_CONTROL_DIR: root.join("control") };
		const owner = await RpcChild.spawn({ root: root.path(), mode: "rpc-ui", args: ["--session", file], env });
		try {
			const ownerEntry = await publication(root, owner);
			const { pid, instanceId, imageId, title } = ownerEntry.meta;
			const held = { status: "held", sessionFile: file, holder: { pid, instanceId, imageId } };
			const before = await directorySnapshot(dir);
			expect(title).toBeNull();
			expect(await query(root, alias)).toEqual(held);
			expect(await directorySnapshot(dir)).toEqual(before);

			const contender = await RpcChild.spawn({ root: root.path(), mode: "rpc-ui", args: ["--session", file], env });
			try {
				expect(await contender.process.exited).toBe(1);
				await contender.closed;
				expect(contender.frames.some(frame => frame.type === "ready")).toBe(false);
				expect(contender.stderr).toContain(
					JSON.stringify({ type: "startup_error", code: "session_in_use", pid, sessionFile: file }),
				);
			} finally {
				await contender.dispose();
			}
			const reader = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
				import { SessionManager } from ${JSON.stringify(SESSION_MANAGER)};
				const reader = await SessionManager.openReadOnly(process.argv[1]);
				process.stdout.write(JSON.stringify({ id: reader.getSessionId(), file: reader.getSessionFile() ?? null,
					messages: reader.getEntries().filter(entry => entry.type === "message").length }));
				await reader.close();`,
					file,
				],
				{ env: process.env, stdout: "pipe", stderr: "pipe" },
			);
			const [readerExit, stdout, stderr] = await Promise.all([
				reader.exited,
				new Response(reader.stdout).text(),
				new Response(reader.stderr).text(),
			]);
			expect(readerExit, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual({ id: seed.getSessionId(), file: null, messages: 0 });
			expect(await directorySnapshot(dir)).toEqual(before);

			const unrelated = await RpcChild.spawn({
				root: root.path(),
				args: ["--cwd", root.path(), "--new-session"],
				env,
			});
			try {
				const other = await publication(root, unrelated);
				await Bun.write(sessionLeasePath(file), JSON.stringify({ pid: other.meta.pid, since: Date.now() }));
				// Even a live endpoint with discovery metadata pointing at the file is not proof.
				await Bun.write(path.join(other.dir, other.name), JSON.stringify({ ...other.meta, sessionFile: file }));
				const spoofed = await directorySnapshot(dir);
				expect(await query(root, file)).toEqual(held);

				const metadataPath = path.join(ownerEntry.dir, ownerEntry.name);
				await fs.rename(metadataPath, `${metadataPath}.hidden`);
				const client = new ControlClient({ metadata: other.meta, label: "lease test", probe: true });
				try {
					await client.connect();
					const unknown = { status: "held_unknown", sessionFile: file };
					expect(await client.request({ type: "get_session_file_lease", sessionFile: file })).toMatchObject({
						success: true,
						data: unknown,
					});
					expect(await query(root, file)).toEqual(unknown);
					expect(await directorySnapshot(dir)).toEqual(spoofed);
				} finally {
					client.close();
					await fs.rename(`${metadataPath}.hidden`, metadataPath);
				}
			} finally {
				await unrelated.dispose();
			}
		} finally {
			await owner.dispose();
		}
	}, 60_000);

	it("reports a free path without leaving any sidecar or history", async () => {
		await using root = await TempDir.create("@omp-file-lease-");
		const file = path.join(await fs.realpath(root.path()), "free.jsonl");
		const before = await fs.readdir(root.path());
		expect(await query(root, file)).toEqual({ status: "not_held", sessionFile: file });
		expect(await fs.readdir(root.path())).toEqual(before);
	}, 30_000);

	it("reports a failed path inspection separately from a free gate", async () => {
		await using root = await TempDir.create("@omp-file-lease-");
		const notADirectory = root.join("regular-file");
		await Bun.write(notADirectory, "not a directory");
		const file = path.join(notADirectory, "session.jsonl");
		expect(await query(root, file)).toEqual({
			status: "inspection_failed",
			sessionFile: file,
			reason: expect.stringContaining("ENOTDIR"),
		});
	}, 30_000);
});
