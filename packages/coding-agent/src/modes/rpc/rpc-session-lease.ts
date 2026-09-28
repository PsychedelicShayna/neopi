/**
 * RPC surface of the session lifetime lease (#106, capability `session_lease`).
 */
import { SessionInUseError } from "../../session/session-lease";
import type { RpcStartupError } from "./rpc-types";

/** Error `code` on a command response that targeted a session another process holds. */
export const SESSION_IN_USE_CODE = "session_in_use";

/** The stderr `startup_error` line for a `--session` launch onto a leased file. */
export function sessionInUseStartupError(error: SessionInUseError): RpcStartupError {
	return { type: "startup_error", code: "session_in_use", pid: error.pid, sessionFile: error.sessionFile };
}

/** `SESSION_IN_USE_CODE` when `error` is a lease rejection, else `undefined`. */
export function sessionLeaseErrorCode(error: unknown): string | undefined {
	return error instanceof SessionInUseError ? SESSION_IN_USE_CODE : undefined;
}
