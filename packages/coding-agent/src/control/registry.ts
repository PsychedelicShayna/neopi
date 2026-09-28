/**
 * Discovery registry for live control endpoints (plan §5).
 *
 * Every published session writes `<entryId>.json` (0600, write-then-rename)
 * and listens on `<entryId>.sock` (0600) under `~/.omp/run/control-sessions`
 * (0700, owner-checked, symlink-refused; `PI_CONTROL_DIR` overrides). The
 * metadata carries static identity only; live state is served over the
 * socket. Directory, permission, `sun_path`, and atomic-write handling follow
 * the Collab host registry (`collab/registry.ts`), copied rather than imported
 * because its version gate and room semantics differ.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import type { ControlRole } from "./types";

export const CONTROL_REGISTRY_VERSION = 1;

/** Static identity recorded on disk for one session publication. */
export interface ControlMetadata {
	version: number;
	instanceId: string;
	/** Random per process image; distinguishes publications of an exec-restarted PID. */
	imageId: string;
	pid: number;
	/** Linux `/proc/<pid>/stat` start time (clock ticks); PID-reuse guard. */
	procStartTicks: number | null;
	endpoint: string;
	createdAt: number;
	startedAt: number;
	token: string;
	role: ControlRole;
	execPath: string;
	gitSha: string | null;
	profile: string | null;
	sessionId: string | null;
	sessionFile: string | null;
	title: string | null;
	cwd: string;
	tmuxPane: string | null;
	tmuxSession: string | null;
	tmuxWindow: string | null;
	tty: string | null;
}

/** Mutable identity fields rewritten on title/cwd/session changes. */
export type ControlMetadataUpdate = Partial<Pick<ControlMetadata, "sessionId" | "sessionFile" | "title" | "cwd">>;

export interface ControlRegistryOptions {
	/** Override the registry directory (tests). Defaults to `PI_CONTROL_DIR` or `~/.omp/run/control-sessions`. */
	dir?: string;
	/** Base for the short socket directory used when the canonical path overflows `sun_path`. */
	socketFallbackBase?: string;
}

/** Registry directory; profile-independent so any profile can drive any other. */
export function controlSessionsDir(): string {
	const override = process.env.PI_CONTROL_DIR;
	if (override && override.trim()) return path.resolve(override);
	return path.join(getBaseConfigRoot(), "run", "control-sessions");
}

const INSTANCE_ID_PATTERN = /^[a-z0-9]{8,64}$/;
const ENTRY_ID_PATTERN = /^[a-f0-9]{16}$/;

function isString(value: unknown): value is string {
	return typeof value === "string";
}
function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

/** Parse and validate metadata; `null` for anything malformed. */
export function parseControlMetadata(text: string): ControlMetadata | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const m = raw as Record<string, unknown>;
	if (typeof m.version !== "number") return null;
	if (!isString(m.instanceId) || !INSTANCE_ID_PATTERN.test(m.instanceId)) return null;
	if (!isString(m.imageId)) return null;
	if (typeof m.pid !== "number" || !Number.isInteger(m.pid) || m.pid <= 0) return null;
	if (m.procStartTicks !== null && typeof m.procStartTicks !== "number") return null;
	if (!isString(m.endpoint) || m.endpoint.length === 0) return null;
	if (typeof m.createdAt !== "number" || typeof m.startedAt !== "number") return null;
	if (!isString(m.token) || !/^[a-f0-9]{64}$/.test(m.token)) return null;
	if (m.role !== "tui" && m.role !== "rpc" && m.role !== "acp" && m.role !== "print") return null;
	if (!isString(m.execPath) || !isString(m.cwd)) return null;
	for (const key of [
		"gitSha",
		"profile",
		"sessionId",
		"sessionFile",
		"title",
		"tmuxPane",
		"tmuxSession",
		"tmuxWindow",
		"tty",
	] as const) {
		if (!isNullableString(m[key])) return null;
	}
	return m as unknown as ControlMetadata;
}

async function assertPrivateDir(dir: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`control registry directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`control registry path is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`control registry directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
const DEFAULT_SOCKET_FALLBACK_BASE = "/tmp";

function socketFallbackDir(dir: string, base: string): string {
	const key = new Bun.CryptoHasher("sha256")
		.update(String(process.getuid?.() ?? 0))
		.update("\0")
		.update(dir)
		.digest("hex")
		.slice(0, 20);
	return path.join(base, `omp-ctl-${key}`);
}

async function resolveSocketEndpoint(dir: string, entryId: string, fallbackBase: string): Promise<string> {
	const canonical = path.join(dir, `${entryId}.sock`);
	if (Buffer.byteLength(canonical) < SUN_PATH_LIMIT) return canonical;
	const shortDir = socketFallbackDir(dir, fallbackBase);
	await ensurePrivateDir(shortDir);
	return path.join(shortDir, `${entryId}.sock`);
}

/** `/proc/<pid>/stat` field 22 (start time in clock ticks); null off Linux or on error. */
export function procStartTicks(pid: number): number | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) is parenthesized and may contain spaces.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(rest[19]);
		return Number.isFinite(ticks) ? ticks : null;
	} catch {
		return null;
	}
}

function atomicWriteJson(filePath: string, value: unknown): void {
	const tmpPath = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	const fd = fs.openSync(tmpPath, "wx", 0o600);
	try {
		try {
			fs.writeFileSync(fd, JSON.stringify(value), "utf8");
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		fs.rmSync(tmpPath, { force: true });
		throw error;
	}
}

/** Handle for one live publication. */
export interface ControlPublication {
	readonly instanceId: string;
	readonly endpoint: string;
	readonly metadataPath: string;
	readonly token: string;
	metadata(): ControlMetadata;
	/** Rewrite mutable identity fields (atomic replace, same entry). */
	update(fields: ControlMetadataUpdate): void;
	/** Stop listening, sever clients, and remove artifacts. Idempotent. */
	close(): Promise<void>;
}

export interface PublishControlEndpointInput extends ControlRegistryOptions {
	role: ControlRole;
	instanceId: string;
	imageId: string;
	execPath: string;
	gitSha: string | null;
	profile: string | null;
	sessionId: string | null;
	sessionFile: string | null;
	title: string | null;
	cwd: string;
	tmuxPane: string | null;
	tmuxSession: string | null;
	tmuxWindow: string | null;
	tty: string | null;
	/** Connection handler; invoked for every accepted socket. */
	onConnection: (socket: net.Socket) => void;
}

/** Fresh random instance id (lowercase hex). */
export function newControlInstanceId(): string {
	return crypto.randomBytes(8).toString("hex");
}

/**
 * Bind the endpoint and write discovery metadata. Artifact names are unique
 * per publication, so pruning a dead entry can never remove a live successor.
 */
export async function publishControlEndpoint(input: PublishControlEndpointInput): Promise<ControlPublication> {
	const dir = input.dir ?? controlSessionsDir();
	await ensurePrivateDir(dir);
	if (!INSTANCE_ID_PATTERN.test(input.instanceId)) throw new Error("invalid control instance id");
	const entryId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	const endpoint = await resolveSocketEndpoint(dir, entryId, input.socketFallbackBase ?? DEFAULT_SOCKET_FALLBACK_BASE);
	const metaPath = path.join(dir, `${entryId}.json`);

	const liveSockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
		input.onConnection(socket);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", err => listening.reject(err));
	server.listen(endpoint, () => listening.resolve());
	const now = Date.now();
	let meta: ControlMetadata;
	try {
		await listening.promise;
		await fs.promises.chmod(endpoint, 0o600);
		meta = {
			version: CONTROL_REGISTRY_VERSION,
			instanceId: input.instanceId,
			imageId: input.imageId,
			pid: process.pid,
			procStartTicks: procStartTicks(process.pid),
			endpoint,
			createdAt: now,
			startedAt: now,
			token,
			role: input.role,
			execPath: input.execPath,
			gitSha: input.gitSha,
			profile: input.profile,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			title: input.title,
			cwd: input.cwd,
			tmuxPane: input.tmuxPane,
			tmuxSession: input.tmuxSession,
			tmuxWindow: input.tmuxWindow,
			tty: input.tty,
		};
		atomicWriteJson(metaPath, meta);
	} catch (error) {
		server.close();
		fs.rmSync(endpoint, { force: true });
		throw error;
	}

	const removeArtifactsSync = (): void => {
		try {
			fs.rmSync(metaPath, { force: true });
			fs.rmSync(endpoint, { force: true });
		} catch {
			// Best-effort; a survivor is pruned by the next list.
		}
	};
	process.once("exit", removeArtifactsSync);

	let closed = false;
	return {
		instanceId: input.instanceId,
		endpoint,
		metadataPath: metaPath,
		token,
		metadata: () => meta,
		update(fields) {
			if (closed) return;
			const next = { ...meta, ...fields };
			if (
				next.sessionId === meta.sessionId &&
				next.sessionFile === meta.sessionFile &&
				next.title === meta.title &&
				next.cwd === meta.cwd
			)
				return;
			meta = next;
			try {
				atomicWriteJson(metaPath, meta);
			} catch {
				// Listing still works from the stale identity; live state comes from the socket.
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			process.off("exit", removeArtifactsSync);
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			for (const socket of liveSockets) socket.destroy();
			removeArtifactsSync();
			await done.promise;
		},
	};
}

/** One registry entry as read from disk. */
export interface ControlRegistryEntry {
	name: string;
	dir: string;
	meta: ControlMetadata;
}

function pidState(pid: number): "alive" | "dead" | "unknown" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

/** Conclusive-death rule: the pid is gone, or it was reused by a different process. */
export function publicationProcessGone(meta: ControlMetadata): boolean {
	if (pidState(meta.pid) === "dead") return true;
	if (meta.procStartTicks !== null) {
		const current = procStartTicks(meta.pid);
		if (current !== null && current !== meta.procStartTicks) return true;
	}
	return false;
}

/** Remove one dead entry's artifacts (only sockets this registry could have created). */
export async function pruneControlEntry(dir: string, name: string, meta: ControlMetadata | null): Promise<void> {
	try {
		await fs.promises.rm(path.join(dir, name), { force: true });
		const ownsEndpoint =
			meta !== null &&
			(meta.endpoint.startsWith(dir + path.sep) ||
				meta.endpoint.startsWith(socketFallbackDir(dir, DEFAULT_SOCKET_FALLBACK_BASE) + path.sep));
		if (ownsEndpoint) await fs.promises.rm(meta.endpoint, { force: true });
	} catch {
		// Someone else pruned it already.
	}
}

/**
 * Read every metadata file. Malformed entries and entries whose process is
 * conclusively dead are pruned; everything else is returned for probing.
 */
export async function readControlEntries(options?: ControlRegistryOptions): Promise<ControlRegistryEntry[]> {
	const dir = options?.dir ?? controlSessionsDir();
	let names: string[];
	try {
		await assertPrivateDir(dir);
		names = await fs.promises.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const entries: ControlRegistryEntry[] = [];
	for (const name of names.filter(n => n.endsWith(".json") && ENTRY_ID_PATTERN.test(n.slice(0, -5))).sort()) {
		const filePath = path.join(dir, name);
		let text: string;
		try {
			const stat = await fs.promises.lstat(filePath);
			// Never trust metadata another user could have planted.
			if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) continue;
			text = await Bun.file(filePath).text();
		} catch {
			continue;
		}
		const meta = parseControlMetadata(text);
		if (!meta) {
			await pruneControlEntry(dir, name, null);
			continue;
		}
		if (meta.version !== CONTROL_REGISTRY_VERSION) {
			if (publicationProcessGone(meta)) await pruneControlEntry(dir, name, meta);
			continue;
		}
		if (pidState(meta.pid) === "dead") {
			await pruneControlEntry(dir, name, meta);
			continue;
		}
		entries.push({ name, dir, meta });
	}
	return entries;
}

/** Find the metadata of a publication by instance id (for caller identity checks). */
export async function findControlMetadata(
	instanceId: string,
	options?: ControlRegistryOptions,
): Promise<ControlMetadata | null> {
	const entries = await readControlEntries(options);
	return entries.find(entry => entry.meta.instanceId === instanceId)?.meta ?? null;
}

/**
 * HMAC proving a caller session publication holds its own registry token
 * (plan §6.5). The target recomputes it from the caller's metadata.
 */
export function callerConnectionToken(callerToken: string, targetInstanceId: string, callerInstanceId: string): string {
	return crypto.createHmac("sha256", callerToken).update(`${targetInstanceId}\0${callerInstanceId}`).digest("hex");
}

/** Constant-time string comparison. */
export function constantTimeEqual(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}
