import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Private operator state follows a session ID within this profile, not its transcript path.
 * This directory is outside session artifacts: fork, export and transfer do not copy it.
 * Deleting the transcript does not remove this state; if the sidecar is absent, start empty.
 */
export function ircOperatorStatePath(
	sessionId: string,
	file: "history.jsonl" | "client.json",
	agentDir = getAgentDir(),
): string {
	const key = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
	return path.join(agentDir, "irc-client", key, file);
}

/** Synchronous because the owner reads/writes sidecars at synchronous UI and bus boundaries. */
export function ensureIrcOperatorStateDirectory(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}
