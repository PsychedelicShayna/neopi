/**
 * Opens a session file through `SessionManager.open` (taking its lifetime
 * lease), reports "held" on stdout, and then idles until killed.
 */
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const sessionPath = process.argv[2];
if (!sessionPath) throw new Error("Expected a session path");

const manager = await SessionManager.open(sessionPath);
process.stdout.write("held\n");
// Keep the manager (and its lease) alive until the parent kills this process.
setInterval(() => manager.getSessionId(), 60_000);
