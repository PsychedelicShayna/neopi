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
	/** Holder process id; 0 when the holder had not yet recorded itself. */
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

/** A held lease. `release` is idempotent. */
export interface SessionLease {
	readonly sessionFile: string;
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
	gate: NativeFileLock;
	recordPath: string;
	since: number;
	refs: number;
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
 * Identity of a session file for leasing: its directory's real path plus the
 * basename, so symlinked aliases of one directory share a single lease.
 */
function sessionLeaseKey(resolvedSessionFile: string): string {
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
		const gate = NativeFileLock.tryAcquire(leaseGatePath(recordPath));
		if (gate.acquired) {
			const since = Date.now();
			try {
				writeLeaseRecord(recordPath, { pid: process.pid, since });
			} catch (err) {
				gate.release();
				throw err;
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
			held.gate.release();
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
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
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
 * Holder of the lease on `sessionFile` when another live process owns it.
 * Returns `undefined` for a free file or one this process holds. Never takes
 * the lease; a free gate is released immediately and nothing is written.
 */
export function inspectSessionLease(sessionFile: string): SessionLeaseHolder | undefined {
	const key = sessionLeaseKey(path.resolve(sessionFile));
	if (heldLeases.has(key)) return undefined;
	const recordPath = sessionLeasePath(key);
	// Every owner records itself, so a missing record means a free file; this
	// also keeps listing from creating gate sidecars on `flock(2)` platforms.
	if (!fs.existsSync(recordPath)) return undefined;
	const gate = NativeFileLock.tryAcquire(leaseGatePath(recordPath));
	const held = !gate.acquired;
	gate.release();
	if (!held) return undefined;
	return readLeaseRecord(recordPath);
}
