/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Linux uses abstract Unix sockets, Windows uses named
 * mutexes, and other Unix platforms use `flock(2)` on `${filePath}.lock`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import { isEnoent } from "./fs-error";

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

/** Acquisition exhausted its bounded attempts because an owner still holds the lease. */
export class FileLockContentionError extends Error {
	constructor(filePath: string, attempts: number, detail?: string) {
		super(`Failed to acquire lock for ${filePath} after ${attempts} attempts${detail ? `: ${detail}` : ""}`);
		this.name = "FileLockContentionError";
	}
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
	if (lock.acquired) return lock;
	lock.release();
	return null;
}

/** Acquire an exclusive lease without waiting; `null` while another holder owns it. */
export function tryAcquireFileLock(filePath: string): FileLockHandle | null {
	return tryAcquireLock(getLockPath(filePath));
}

interface CooperativeOwner {
	readonly pid: number;
	readonly startTime: string;
	readonly token: string;
	readonly released?: boolean;
	/** Native capability distinguishes an active handle from copied or orphaned metadata. */
	readonly capability?: string;
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

function parseCooperativeOwner(text: string, lockPath: string): CooperativeOwner {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null)
		throw new Error(`Invalid cooperative lease metadata at ${lockPath}`);
	const owner = value as Partial<CooperativeOwner>;
	if (
		typeof owner.pid !== "number" ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid < 1 ||
		typeof owner.startTime !== "string" ||
		!/^\d+$/.test(owner.startTime) ||
		typeof owner.token !== "string" ||
		!/^[a-zA-Z0-9-]+$/.test(owner.token) ||
		(owner.released !== undefined && typeof owner.released !== "boolean") ||
		(owner.capability !== undefined && (typeof owner.capability !== "string" || !path.isAbsolute(owner.capability)))
	) {
		throw new Error(`Invalid cooperative lease metadata at ${lockPath}`);
	}
	return owner as CooperativeOwner;
}

async function readCooperativeOwner(lockPath: string): Promise<CooperativeOwner | undefined> {
	try {
		return parseCooperativeOwner(await Bun.file(lockPath).text(), lockPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function readCooperativeOwnerSync(lockPath: string): CooperativeOwner | undefined {
	try {
		return parseCooperativeOwner(fs.readFileSync(lockPath, "utf8"), lockPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function cooperativeCapabilityPath(owner: CooperativeOwner, identity: fs.BigIntStats): string {
	// The inode follows a rename, but not a copy. The capability remains held
	// independently of the metadata path, including across workers in this PID.
	// Persist the locator: another process may use a different TMPDIR.
	return `${owner.capability}-${identity.dev}-${identity.ino}`;
}

async function ownerCanBeTakenOver(owner: CooperativeOwner, lockPath: string): Promise<boolean> {
	if (owner.released) return true;
	let processStat: string;
	try {
		processStat = await cooperativeLockIO.readProcessStat(owner.pid);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		try {
			process.kill(owner.pid, 0);
		} catch (killError) {
			if (typeof killError === "object" && killError !== null && "code" in killError && killError.code === "ESRCH") {
				return true;
			}
			throw killError;
		}
		throw error;
	}
	const stat = parseProcessStat(processStat);
	if (!stat) throw new Error(`Unable to read process identity for PID ${owner.pid}`);
	if (stat.startTime !== owner.startTime) return true;
	if (stat.state === "T" || stat.state === "t" || stat.state === "Z" || stat.state === "X") return true;
	if (!owner.capability) {
		// Legacy metadata alone cannot prove that a live owner is orphaned,
		// including one in another worker that shares this process's PID.
		return false;
	}
	const identity = await fs.promises.stat(lockPath, { bigint: true });
	const probe = tryAcquireLock(cooperativeCapabilityPath(owner, identity));
	if (!probe) return false;
	probe.release();
	return true;
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
		if (current && !(await ownerCanBeTakenOver(current, lockPath))) return null;

		const pid = cooperativeLockIO.pid();
		const stat = parseProcessStat(await cooperativeLockIO.readProcessStat(pid));
		if (!stat) throw new Error(`Unable to read process identity for PID ${pid}`);
		const token = Bun.randomUUIDv7();
		const owner: CooperativeOwner = {
			pid,
			startTime: stat.startTime,
			token,
			capability: path.join(os.tmpdir(), `npi-lease-${pid}-${stat.startTime}-${token}`),
		};
		await writeCooperativeOwner(lockPath, owner);
		const identity = await fs.promises.stat(lockPath, { bigint: true });
		const capability = tryAcquireLock(cooperativeCapabilityPath(owner, identity));
		if (!capability) throw new Error(`Unable to claim cooperative lease capability for ${filePath}`);
		let released = false;
		const ownsMetadata = (): boolean => {
			const stored = readCooperativeOwnerSync(lockPath);
			if (stored?.token !== owner.token || stored.released) return false;
			try {
				const currentIdentity = fs.statSync(lockPath, { bigint: true });
				return currentIdentity.dev === identity.dev && currentIdentity.ino === identity.ino;
			} catch (error) {
				if (isEnoent(error)) return false;
				throw error;
			}
		};
		return {
			isOwner: () => !released && ownsMetadata(),
			release: () => {
				if (released) return;
				released = true;
				try {
					if (!ownsMetadata()) return;
					// Serialize release with acquisition: a resumed stopped owner must
					// not overwrite a successor between its token check and write.
					const releaseClaim = tryAcquireLock(`${lockPath}.claim`);
					if (!releaseClaim) return;
					try {
						if (ownsMetadata()) fs.writeFileSync(lockPath, JSON.stringify({ ...owner, released: true }));
					} finally {
						releaseClaim.release();
					}
				} finally {
					capability.release();
				}
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
	if (!Number.isInteger(opts.retries) || opts.retries < 1)
		throw new RangeError("Lock retries must be a positive integer");

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = opts.takeoverStoppedOwner ? await tryAcquireCooperativeLock(filePath) : tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	const owner = opts.takeoverStoppedOwner ? await readCooperativeOwner(lockPath) : undefined;
	throw new FileLockContentionError(
		filePath,
		opts.retries,
		owner && !owner.capability && !owner.released
			? "legacy live-owner metadata cannot be verified as orphaned"
			: undefined,
	);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): NativeFileLock {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);
	if (!Number.isInteger(opts.retries) || opts.retries < 1)
		throw new RangeError("Lock retries must be a positive integer");

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new FileLockContentionError(filePath, opts.retries);
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
