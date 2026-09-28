/**
 * Lifetime ownership lease for session files (#106).
 *
 * The per-append publish lock in `session-storage.ts` is held for
 * microseconds, so two live processes could both append to one transcript
 * and silently fork it. A process that writes a session file holds this
 * lease from open to close; a second process that tries to open the file
 * fails closed with {@link SessionInUseError}.
 *
 * Ownership is a process-owned OS gate (`.{basename}.lease.os`, the same
 * `FileLock` primitive as the publish lock's `.lock.os`): the kernel reclaims
 * it when the holder exits, including SIGKILL, so no age heuristic decides
 * liveness. The holder records `{ pid, since }` in `.{basename}.lease` so a
 * rejected opener can name it. The record is advisory; the gate is
 * authoritative, and a record left behind by a killed holder is ignored and
 * overwritten by the next owner.
 *
 * Leases are process-scoped: managers in one process that open the same
 * file share one lease (reference counted), and only other processes are
 * excluded. Leases are local to one machine; network filesystems shared
 * between hosts are unsupported.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import { hasFsCode, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Another live process holds the lifetime lease on this session file. */
export class SessionInUseError extends Error {
	readonly sessionFile: string;
	/** Holder process id; 0 when the holder has not recorded itself (not yet, or could not). */
	readonly pid: number;
	/** Epoch milliseconds when the holder acquired the lease; 0 when unknown. */
	readonly since: number;

	constructor(sessionFile: string, pid: number, since: number) {
		const holder = pid > 0 ? `another NeoPi process (pid ${pid})` : "another NeoPi process";
		super(`Session ${sessionFile} is in use by ${holder}.`);
		this.name = "SessionInUseError";
		this.sessionFile = sessionFile;
		this.pid = pid;
		this.since = since;
	}
}

/** Lease holder as recorded beside the session file. */
export interface SessionLeaseHolder {
	pid: number;
	since: number;
}

/** A held lease. `release` (or leaving a `using` scope) is idempotent. */
export interface SessionLease extends Disposable {
	readonly sessionFile: string;
	/**
	 * Another reference to this same held lease. It never touches the OS and
	 * cannot fail, so a caller can keep a file owned across a transition that
	 * releases this reference.
	 */
	retain(): SessionLease;
	release(): void;
}

/**
 * How long an opener keeps retrying while the gate is held but no live
 * holder is recorded yet (a holder between claiming the gate and writing its
 * record, or a lister probing the gate for a few microseconds).
 */
const SESSION_LEASE_SETTLE_MS = 250;
const SESSION_LEASE_POLL_MS = 5;

interface HeldLease {
	/** Absent when the gate could not be created (unwritable directory); the lease then excludes nobody. */
	gate: NativeFileLock | undefined;
	recordPath: string;
	since: number;
	refs: number;
}

/**
 * Filesystem refusals that must not turn a lease into a startup failure: a
 * read-only or full session directory already surfaces through the session
 * store's own persistence-failure path, and read-only sessions must still load.
 */
function isUnwritableFsError(err: unknown): boolean {
	return ["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT"].some(code => hasFsCode(err, code));
}

/** Leases this process owns, keyed by {@link sessionLeaseKey}. */
const heldLeases = new Map<string, HeldLease>();

/** Whether `pid` names a live process. Unknown errors count as alive (fail closed). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH: no such process (dead). EPERM: alive without signal
		// permission. Anything else: assume alive (fail closed).
		return hasFsCode(err, "EPERM") || !hasFsCode(err, "ESRCH");
	}
}

/** Path of the holder record for `sessionFile`: `.{basename}.lease` beside it. */
export function sessionLeasePath(sessionFile: string): string {
	return path.join(path.dirname(sessionFile), `.${path.basename(sessionFile)}.lease`);
}

/**
 * Sidecar path carrying the OS gate. Like the publish lock's `.lock.os`, it
 * must stay in place on `flock(2)` platforms, so release never unlinks it.
 */
function leaseGatePath(recordPath: string): string {
	return `${recordPath}.os`;
}

function readLeaseRecord(recordPath: string): SessionLeaseHolder | undefined {
	let content: string;
	try {
		content = fs.readFileSync(recordPath, "utf8");
	} catch {
		return undefined;
	}
	try {
		const record: unknown = JSON.parse(content);
		if (typeof record !== "object" || record === null) return undefined;
		const { pid, since } = record as Record<string, unknown>;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
		return { pid, since: typeof since === "number" && Number.isFinite(since) ? since : 0 };
	} catch {
		return undefined;
	}
}

/** Publish the holder record by rename so a concurrent reader never sees a partial record. */
function writeLeaseRecord(recordPath: string, holder: SessionLeaseHolder): void {
	const tempPath = `${recordPath}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(holder), { mode: 0o600 });
	try {
		fs.renameSync(tempPath, recordPath);
	} catch (err) {
		fs.rmSync(tempPath, { force: true });
		throw err;
	}
}

/**
 * Identity of a session file for leasing: the file's own real path, so every
 * alias (a symlinked file or a symlinked directory) shares one lease. A file
 * that does not exist yet uses its directory's real path plus the basename,
 * which is the real path the file will have once it is created.
 */
function sessionLeaseKey(resolvedSessionFile: string): string {
	try {
		return fs.realpathSync(resolvedSessionFile);
	} catch {
		// Missing (or dangling) file: fall back to the directory.
	}
	try {
		return path.join(fs.realpathSync(path.dirname(resolvedSessionFile)), path.basename(resolvedSessionFile));
	} catch {
		return resolvedSessionFile;
	}
}

function claimLease(key: string, sessionFile: string): HeldLease {
	const recordPath = sessionLeasePath(key);
	const deadline = Date.now() + SESSION_LEASE_SETTLE_MS;
	for (;;) {
		let gate: NativeFileLock;
		try {
			gate = NativeFileLock.tryAcquire(leaseGatePath(recordPath));
		} catch (err) {
			if (!isUnwritableFsError(err)) throw err;
			logger.warn("Session lease gate unavailable; continuing without a lease", {
				sessionFile,
				error: String(err),
			});
			return { gate: undefined, recordPath, since: Date.now(), refs: 1 };
		}
		if (gate.acquired) {
			const since = Date.now();
			try {
				writeLeaseRecord(recordPath, { pid: process.pid, since });
			} catch (err) {
				if (!isUnwritableFsError(err)) {
					gate.release();
					throw err;
				}
				// The gate alone still excludes other processes; openers just cannot name this pid.
				logger.warn("Session lease record not written; holding the lease without a record", {
					sessionFile,
					error: String(err),
				});
			}
			return { gate, recordPath, since, refs: 1 };
		}
		gate.release();
		// A record naming a dead process (or this one) is stale: the gate is held
		// by a holder that has not recorded itself yet, or by a brief probe.
		const holder = readLeaseRecord(recordPath);
		const liveHolder = holder !== undefined && holder.pid !== process.pid && isPidAlive(holder.pid);
		if (liveHolder || Date.now() >= deadline) {
			throw new SessionInUseError(sessionFile, liveHolder ? holder.pid : 0, liveHolder ? holder.since : 0);
		}
		Bun.sleepSync(SESSION_LEASE_POLL_MS);
	}
}

class ProcessSessionLease implements SessionLease {
	readonly sessionFile: string;
	#key: string;
	#held: HeldLease;
	#released = false;

	constructor(key: string, sessionFile: string, held: HeldLease) {
		this.#key = key;
		this.sessionFile = sessionFile;
		this.#held = held;
	}

	retain(): SessionLease {
		if (this.#released) throw new Error(`Cannot retain a released session lease: ${this.sessionFile}`);
		this.#held.refs++;
		return new ProcessSessionLease(this.#key, this.sessionFile, this.#held);
	}

	[Symbol.dispose](): void {
		this.release();
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		const held = this.#held;
		held.refs--;
		if (held.refs > 0) return;
		heldLeases.delete(this.#key);
		try {
			const record = readLeaseRecord(held.recordPath);
			if (record?.pid === process.pid && record.since === held.since) fs.unlinkSync(held.recordPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session lease record", {
					sessionFile: this.sessionFile,
					error: String(err),
				});
			}
		} finally {
			held.gate?.release();
		}
	}
}

/**
 * Take the lifetime lease on `sessionFile` for this process.
 *
 * @throws SessionInUseError when another live process holds it.
 */
export function acquireSessionLease(sessionFile: string): SessionLease {
	const resolved = path.resolve(sessionFile);
	try {
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
	} catch (err) {
		if (!isUnwritableFsError(err)) throw err;
	}
	const key = sessionLeaseKey(resolved);
	let held = heldLeases.get(key);
	if (held) {
		held.refs++;
	} else {
		held = claimLease(key, resolved);
		heldLeases.set(key, held);
	}
	return new ProcessSessionLease(key, resolved, held);
}

/**
 * Linux abstract sockets and Windows named mutexes are not files, so probing
 * them creates nothing. `flock(2)` platforms lock a sidecar the probe would
 * create; there a missing sidecar already proves no holder ever gated the file.
 */
const GATE_IS_SIDECAR_FILE = process.platform !== "linux" && process.platform !== "win32";

/**
 * Holder of the lease on `sessionFile` when another live process owns it.
 * Returns `undefined` for a free file or one this process holds. Never takes
 * the lease; a free gate is released immediately and nothing is written.
 *
 * The gate, not the record, decides: a holder that could not write its
 * record (read-only or full directory) or has not written it yet still owns
 * the file, and is reported with `pid: 0` (unknown holder).
 */
export function inspectSessionLease(sessionFile: string): SessionLeaseHolder | undefined {
	const key = sessionLeaseKey(path.resolve(sessionFile));
	if (heldLeases.has(key)) return undefined;
	const recordPath = sessionLeasePath(key);
	const gatePath = leaseGatePath(recordPath);
	if (GATE_IS_SIDECAR_FILE && !fs.existsSync(gatePath)) return undefined;
	let gate: NativeFileLock;
	try {
		gate = NativeFileLock.tryAcquire(gatePath);
	} catch (err) {
		// A gate nobody can create is a gate nobody holds.
		if (isUnwritableFsError(err)) return undefined;
		throw err;
	}
	const held = !gate.acquired;
	gate.release();
	if (!held) return undefined;
	const record = readLeaseRecord(recordPath);
	// A missing record, or one left by a dead process, names nobody live.
	if (!record || record.pid === process.pid || !isPidAlive(record.pid)) return { pid: 0, since: 0 };
	return record;
}
