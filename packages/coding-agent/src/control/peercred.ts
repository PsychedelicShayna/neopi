/**
 * Peer credentials of a connected Unix-socket client (plan §6.1).
 *
 * Linux reads `SO_PEERCRED` with `getsockopt` through `bun:ffi` on the
 * socket's file descriptor. The check fails closed: any missing handle,
 * library, symbol, short read, or uid mismatch yields `undefined`, and the
 * server destroys the connection before parsing a byte.
 */
import type * as net from "node:net";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { logger } from "@oh-my-pi/pi-utils";

export interface PeerCredentials {
	pid: number;
	uid: number;
	gid: number;
}

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const UCRED_BYTES = 12;

type GetSockOpt = (fd: number, level: number, name: number, value: unknown, length: unknown) => number;
type GetPeerEid = (fd: number, uid: unknown, gid: unknown) => number;

interface PeerCredLibrary {
	getsockopt?: GetSockOpt;
	getpeereid?: GetPeerEid;
}

let library: PeerCredLibrary | null | undefined;

function loadLibrary(): PeerCredLibrary | null {
	if (library !== undefined) return library;
	try {
		if (process.platform === "linux") {
			const lib = dlopen("libc.so.6", {
				getsockopt: {
					args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
					returns: FFIType.i32,
				},
			});
			library = { getsockopt: lib.symbols.getsockopt as unknown as GetSockOpt };
		} else if (process.platform === "darwin") {
			const lib = dlopen("libc.dylib", {
				getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			});
			library = { getpeereid: lib.symbols.getpeereid as unknown as GetPeerEid };
		} else {
			library = null;
		}
	} catch (error) {
		logger.warn("control: peer credential library unavailable", { error: String(error) });
		library = null;
	}
	return library;
}

/** True when this platform can verify peers; the endpoint is disabled otherwise. */
export function peerCredentialsSupported(): boolean {
	return loadLibrary() !== null;
}

function socketFd(socket: net.Socket): number | undefined {
	const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
	const fd = handle?.fd;
	return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : undefined;
}

/** Read the connected peer's credentials, or `undefined` when they cannot be verified. */
export function peerCredentials(socket: net.Socket): PeerCredentials | undefined {
	const lib = loadLibrary();
	if (!lib) return undefined;
	const fd = socketFd(socket);
	if (fd === undefined) return undefined;
	try {
		if (lib.getsockopt) {
			const creds = new Int32Array(3);
			const len = new Uint32Array([UCRED_BYTES]);
			const rc = lib.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(creds), ptr(len));
			if (rc !== 0 || len[0] !== UCRED_BYTES) return undefined;
			return { pid: creds[0]!, uid: creds[1]!, gid: creds[2]! };
		}
		if (lib.getpeereid) {
			const uid = new Uint32Array(1);
			const gid = new Uint32Array(1);
			if (lib.getpeereid(fd, ptr(uid), ptr(gid)) !== 0) return undefined;
			return { pid: 0, uid: uid[0]!, gid: gid[0]! };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Same-user check: credentials must be readable and the uid must equal ours. Root is not exempt. */
export function isSameUserPeer(creds: PeerCredentials | undefined): creds is PeerCredentials {
	const uid = process.getuid?.();
	return creds !== undefined && uid !== undefined && creds.uid === uid;
}
