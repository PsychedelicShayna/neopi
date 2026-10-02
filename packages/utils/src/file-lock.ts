/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Linux uses abstract Unix sockets, Windows uses named
 * mutexes, and other Unix platforms use `flock(2)` on `${filePath}.lock`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";

/** Controls bounded waiting when an advisory file lock is contended. */
export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
	/** Cancel acquisition while waiting for another process to release the resource. */
	signal?: AbortSignal;
	/**
	 * Use a cooperative PID lease that can fence a dead or SIGSTOPped owner.
	 * Callers must check `isOwner()` before publishing protected work.
	 */
	takeoverStoppedOwner?: boolean;
}

/** An exclusive OS-backed lease. Releasing an already released handle is safe. */
export interface FileLockHandle {
	release(): void;
	/** False after a cooperative lease has been taken over by another process. */
	isOwner?(): boolean;
}

const DEFAULT_OPTIONS = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

function tryAcquireLock(lockPath: string): NativeFileLock | null {
	const lock = NativeFileLock.tryAcquire(lockPath);
	return lock.acquired ? lock : null;
}

interface CooperativeOwner {
	readonly pid: number;
	readonly startTime: string;
	readonly token: string;
	readonly released?: boolean;
}

function parseProcessStat(stat: string): { state: string; startTime: string } | undefined {
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 0) return undefined;
	const fields = stat
		.slice(commandEnd + 1)
		.trim()
		.split(/\s+/);
	const state = fields[0];
	const startTime = fields[19];
	return state && startTime ? { state, startTime } : undefined;
}

const cooperativeLockIO = {
	pid: () => process.pid,
	readProcessStat: async (pid: number) => Bun.file(`/proc/${pid}/stat`).text(),
};

async function readCooperativeOwner(lockPath: string): Promise<CooperativeOwner | undefined> {
	try {
		return JSON.parse(await Bun.file(lockPath).text()) as CooperativeOwner;
	} catch {
		return undefined;
	}
}

function readCooperativeOwnerSync(lockPath: string): CooperativeOwner | undefined {
	try {
		return JSON.parse(fs.readFileSync(lockPath, "utf8")) as CooperativeOwner;
	} catch {
		return undefined;
	}
}

async function ownerCanBeTakenOver(owner: CooperativeOwner): Promise<boolean> {
	if (owner.released) return true;
	try {
		const stat = parseProcessStat(await cooperativeLockIO.readProcessStat(owner.pid));
		if (!stat || stat.startTime !== owner.startTime) return true;
		return stat.state === "T" || stat.state === "t" || stat.state === "Z" || stat.state === "X";
	} catch {
		try {
			process.kill(owner.pid, 0);
			return false;
		} catch (error) {
			return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
		}
	}
}

async function writeCooperativeOwner(lockPath: string, owner: CooperativeOwner): Promise<void> {
	const temporary = `${lockPath}.${owner.token}.tmp`;
	await Bun.write(temporary, JSON.stringify(owner));
	await fs.promises.rename(temporary, lockPath);
}

async function tryAcquireCooperativeLock(filePath: string): Promise<FileLockHandle | null> {
	const lockPath = getLockPath(filePath);
	const claim = tryAcquireLock(`${lockPath}.claim`);
	if (!claim) return null;
	try {
		const current = await readCooperativeOwner(lockPath);
		if (current && !(await ownerCanBeTakenOver(current))) return null;

		const pid = cooperativeLockIO.pid();
		const stat = parseProcessStat(await cooperativeLockIO.readProcessStat(pid));
		if (!stat) throw new Error(`Unable to read process identity for PID ${pid}`);
		const owner: CooperativeOwner = { pid, startTime: stat.startTime, token: Bun.randomUUIDv7() };
		await writeCooperativeOwner(lockPath, owner);
		let released = false;
		return {
			isOwner: () => !released && readCooperativeOwnerSync(lockPath)?.token === owner.token,
			release: () => {
				if (released) return;
				released = true;
				const stored = readCooperativeOwnerSync(lockPath);
				if (stored?.token !== owner.token) return;
				fs.writeFileSync(lockPath, JSON.stringify({ ...owner, released: true }));
			},
		};
	} finally {
		claim.release();
	}
}

/** Acquire an exclusive lease; callers must release it when their operation ends. */
export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = opts.takeoverStoppedOwner ? await tryAcquireCooperativeLock(filePath) : tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): NativeFileLock {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding an OS-backed exclusive lock for `filePath`. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Run synchronous `fn` while holding an OS-backed exclusive lock for `filePath`. */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/**
 * Test-only acquisition handle for forcing ownership handoffs. This is not
 * part of the supported package API.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	getLockPath,
	parseProcessStat,
	cooperativeLockIO,
};
