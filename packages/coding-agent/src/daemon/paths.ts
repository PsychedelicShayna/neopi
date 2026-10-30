import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/** Runtime directory of the session daemon for the active profile (one daemon per user and profile). */
export function sessionDaemonDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "run", "session-daemon");
}

/** Socket the session daemon listens on. */
export function sessionDaemonEndpoint(dir: string = sessionDaemonDir()): string {
	return ipcEndpoint(dir, "sessions");
}

/** Overrides the runtime directory (tests); inherited by the daemon worker. */
export const SESSION_DAEMON_DIR_ENV = "PI_SESSION_DAEMON_DIR";
