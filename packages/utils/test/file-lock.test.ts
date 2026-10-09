import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__internalsForTesting,
	acquireFileLock,
	FileLockContentionError,
	type FileLockHandle,
	withFileLock,
} from "../src/file-lock";
import { isEnoent } from "../src/fs-error";
import { removeWithRetries } from "../src/temp";

const { tryAcquireLock, getLockPath } = __internalsForTesting;

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

describe("native file-lock ownership", () => {
	test("a cancelled waiter never enters its critical section or releases the current owner", async () => {
		const root = await mkRoot();
		const target = path.join(root, "cancelled.json");
		const lockPath = getLockPath(target);
		const owner = tryAcquireLock(lockPath);
		if (!owner) throw new Error("owner failed to acquire");
		let entered = false;
		try {
			const controller = new AbortController();
			const waiting = withFileLock(
				target,
				async () => {
					entered = true;
				},
				{
					signal: controller.signal,
					retries: 100,
					retryDelayMs: 1000,
				},
			);
			controller.abort();
			await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
			expect(entered).toBe(false);
			expect(tryAcquireLock(lockPath)).toBeNull();
		} finally {
			owner.release();
		}
		await withFileLock(target, async () => {
			entered = true;
		});
		expect(entered).toBe(true);
	});

	test("a live process takes over from a SIGSTOPped owner and fences its stale lease", async () => {
		const root = await mkRoot();
		const target = path.join(root, "stopped-owner.json");
		const originalPid = __internalsForTesting.cooperativeLockIO.pid;
		const originalReadProcessStat = __internalsForTesting.cooperativeLockIO.readProcessStat;
		let currentPid = 101;
		const states = new Map<number, string>([
			[101, "S"],
			[202, "S"],
		]);
		const starts = new Map<number, string>([
			[101, "1001"],
			[202, "2002"],
		]);
		const stat = (pid: number) => {
			const fields = Array.from({ length: 20 }, () => "0");
			fields[0] = states.get(pid) ?? "X";
			fields[19] = starts.get(pid) ?? "0";
			return `${pid} (fake process) ${fields.join(" ")}`;
		};
		__internalsForTesting.cooperativeLockIO.pid = () => currentPid;
		__internalsForTesting.cooperativeLockIO.readProcessStat = async pid => stat(pid);

		let originalOwner: FileLockHandle | undefined;
		let successor: FileLockHandle | undefined;
		try {
			originalOwner = await acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true });
			currentPid = 202;
			await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toThrow(
				"Failed to acquire lock",
			);

			states.set(101, "T");
			successor = await acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true });
			expect(originalOwner.isOwner?.()).toBe(false);
			expect(successor.isOwner?.()).toBe(true);
		} finally {
			successor?.release();
			originalOwner?.release();
			__internalsForTesting.cooperativeLockIO.pid = originalPid;
			__internalsForTesting.cooperativeLockIO.readProcessStat = originalReadProcessStat;
		}
	});

	test("process death hands ownership to B while excluding C", async () => {
		const root = await mkRoot();
		const target = path.join(root, "abandoned.json");
		const readyPath = path.join(root, "holder-ready");
		const lockPath = getLockPath(target);
		const holder = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/file-lock-holder.ts"), target, readyPath],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			},
		);

		try {
			for (;;) {
				try {
					await fs.access(readyPath);
					break;
				} catch (error) {
					if (!isEnoent(error)) throw error;
					if (holder.exitCode !== null) {
						throw new Error(
							`lock holder exited before readiness (${holder.exitCode}): ${await new Response(holder.stderr).text()}`,
						);
					}
				}
			}

			holder.kill();
			expect(await holder.exited).not.toBe(0);

			const ownerB = tryAcquireLock(lockPath);
			if (!ownerB) throw new Error("B failed to acquire the abandoned lock");
			const ownerC = tryAcquireLock(lockPath);
			expect(ownerC).toBeNull();
			expect(ownerB.acquired).toBe(true);
			ownerB.release();
		} finally {
			if (holder.exitCode === null) {
				holder.kill();
				await holder.exited;
			}
		}
	}, 10_000);

	test("a former owner's late release cannot unlock its successor", async () => {
		const root = await mkRoot();
		const lockPath = getLockPath(path.join(root, "handoff.json"));
		const formerOwner = tryAcquireLock(lockPath);
		if (!formerOwner) throw new Error("former owner failed to acquire");
		formerOwner.release();

		const successor = tryAcquireLock(lockPath);
		if (!successor) throw new Error("successor failed to acquire");

		// Force the old release path after the successor owns the same name.
		formerOwner.release();
		expect(tryAcquireLock(lockPath)).toBeNull();
		expect(successor.acquired).toBe(true);

		successor.release();
		const finalOwner = tryAcquireLock(lockPath);
		if (!finalOwner) throw new Error("final owner failed to acquire");
		finalOwner.release();
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						await Promise.resolve();
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);

	test.skipIf(process.platform !== "linux")(
		"copies acquire independently without stealing an active same-process owner",
		async () => {
			const root = await mkRoot();
			const source = path.join(root, "source", "chronicler");
			const destination = path.join(root, "copy", "chronicler");
			const original = await acquireFileLock(source, { retries: 1, takeoverStoppedOwner: true });
			let copied: FileLockHandle | undefined;
			try {
				await expect(acquireFileLock(source, { retries: 1, takeoverStoppedOwner: true })).rejects.toBeInstanceOf(
					FileLockContentionError,
				);
				await fs.cp(path.dirname(source), path.dirname(destination), { recursive: true });
				copied = await acquireFileLock(destination, { retries: 1, takeoverStoppedOwner: true });
				expect(original.isOwner?.()).toBe(true);
				expect(copied.isOwner?.()).toBe(true);
				original.release();
				expect(copied.isOwner?.()).toBe(true);
			} finally {
				copied?.release();
				original.release();
			}
		},
	);

	test.skipIf(process.platform !== "linux")(
		"a moved active lease stays exclusive until its original handle releases",
		async () => {
			const root = await mkRoot();
			const source = path.join(root, "source", "chronicler");
			const destination = path.join(root, "moved", "chronicler");
			const original = await acquireFileLock(source, { retries: 1, takeoverStoppedOwner: true });
			try {
				await fs.rename(path.dirname(source), path.dirname(destination));
				expect(original.isOwner?.()).toBe(false);
				await expect(
					acquireFileLock(destination, { retries: 1, takeoverStoppedOwner: true }),
				).rejects.toBeInstanceOf(FileLockContentionError);
			} finally {
				original.release();
			}
			const recovered = await acquireFileLock(destination, { retries: 1, takeoverStoppedOwner: true });
			try {
				expect(recovered.isOwner?.()).toBe(true);
			} finally {
				recovered.release();
			}
		},
	);

	test.skipIf(process.platform !== "linux")(
		"legacy live ownership remains uncertain rather than being stolen by PID equality",
		async () => {
			const root = await mkRoot();
			const target = path.join(root, "legacy");
			const identity = __internalsForTesting.parseProcessStat(await Bun.file(`/proc/${process.pid}/stat`).text());
			if (!identity) throw new Error("missing process identity");
			await Bun.write(
				getLockPath(target),
				JSON.stringify({ pid: process.pid, startTime: identity.startTime, token: "legacy" }),
			);
			await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toThrow(
				"legacy live-owner metadata cannot be verified as orphaned",
			);
		},
	);

	test.skipIf(process.platform !== "linux")(
		"corrupt and inaccessible lease metadata surface operational errors, not contention",
		async () => {
			const root = await mkRoot();
			const target = path.join(root, "corrupt");
			await Bun.write(getLockPath(target), "{broken");
			await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toBeInstanceOf(
				SyntaxError,
			);
			expect(await Bun.file(getLockPath(target)).text()).toBe("{broken");
			await Bun.write(getLockPath(target), "{}");
			await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toThrow(
				"Invalid cooperative lease metadata",
			);
			expect(await Bun.file(getLockPath(target)).text()).toBe("{}");
			await fs.unlink(getLockPath(target));
			await fs.mkdir(getLockPath(target));
			try {
				await acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true });
				throw new Error("expected directory metadata to be rejected");
			} catch (error) {
				expect(error).not.toBeInstanceOf(FileLockContentionError);
				expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
			}
		},
	);

	test.skipIf(process.platform !== "linux")(
		"cross-process writers remain exclusive, copied metadata recovers, and process death frees the lease",
		async () => {
			const root = await mkRoot();
			const target = path.join(root, "original", "chronicler");
			const copiedTarget = path.join(root, "copy", "chronicler");
			const readyPath = path.join(root, "ready");
			const holder = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "fixtures/cooperative-file-lock-holder.ts"),
					target,
					readyPath,
				],
				{ cwd: path.resolve(import.meta.dir, "../../.."), stdin: "pipe", stdout: "ignore", stderr: "pipe" },
			);
			let copied: FileLockHandle | undefined;
			try {
				const deadline = Date.now() + 5_000;
				while (!(await Bun.file(readyPath).exists())) {
					if (holder.exitCode !== null || Date.now() >= deadline)
						throw new Error("cooperative holder failed to become ready");
					await Bun.sleep(10);
				}
				await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toBeInstanceOf(
					FileLockContentionError,
				);
				await fs.cp(path.dirname(target), path.dirname(copiedTarget), { recursive: true });
				copied = await acquireFileLock(copiedTarget, { retries: 1, takeoverStoppedOwner: true });
				expect(copied.isOwner?.()).toBe(true);
				// Acquiring the copy must not fence the original process's writer.
				await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toBeInstanceOf(
					FileLockContentionError,
				);
				holder.kill();
				await holder.exited;
				const recovered = await acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true });
				try {
					expect(recovered.isOwner?.()).toBe(true);
					await expect(acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true })).rejects.toBeInstanceOf(
						FileLockContentionError,
					);
				} finally {
					recovered.release();
				}
			} finally {
				copied?.release();
				if (holder.exitCode === null) {
					holder.kill();
					await holder.exited;
				}
			}
		},
		10_000,
	);

	test.skipIf(process.platform !== "linux")(
		"PID reuse invalidates a stale lease rather than blocking the new process identity",
		async () => {
			const root = await mkRoot();
			const target = path.join(root, "pid-reuse");
			await Bun.write(getLockPath(target), JSON.stringify({ pid: process.pid, startTime: "0", token: "reused" }));
			const recovered = await acquireFileLock(target, { retries: 1, takeoverStoppedOwner: true });
			try {
				expect(recovered.isOwner?.()).toBe(true);
			} finally {
				recovered.release();
			}
		},
	);
});
