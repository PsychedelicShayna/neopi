import * as fs from "node:fs";
import * as path from "node:path";
import { getHostEnvRuntimeRoot } from "@oh-my-pi/pi-utils/dirs";
import { getOriginalProcessEnv } from "@oh-my-pi/pi-utils/env";
import { tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { getShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

const hostEnv = getOriginalProcessEnv();
const HOST_KEYS = ["EDITOR", "VISUAL", "SSH_ASKPASS", "SUDO_ASKPASS", "TERM"] as const;
const SHELL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
let toolHostEnv: Promise<Record<string, string>> | undefined;

/** Lazily persist the launcher's env, never the sanitized tool env or project dotenv. */
export function getHostEnvForTools(): Promise<Record<string, string>> {
	return (toolHostEnv ??= createHostEnvForTools());
}

async function pruneAbandonedSnapshots(root: string): Promise<void> {
	for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+-[A-Za-z0-9]+$/.test(entry.name)) continue;
		const dir = path.join(root, entry.name);
		// OS-backed leases survive PID reuse and are released even after SIGKILL.
		const lease = tryAcquireFileLock(path.join(dir, "owner"));
		if (!lease) continue;
		try {
			await fs.promises.rm(dir, { recursive: true, force: true });
		} finally {
			lease.release();
		}
	}
}

async function createHostEnvForTools(): Promise<Record<string, string>> {
	const root = getHostEnvRuntimeRoot();
	await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
	// Serialize pruning and creation so another launcher cannot collect a
	// newly created directory before its owner lease has been acquired.
	return withFileLock(path.join(root, "gc"), async () => {
		await pruneAbandonedSnapshots(root);
		const dir = await fs.promises.mkdtemp(path.join(root, `${process.pid}-`));
		const lease = tryAcquireFileLock(path.join(dir, "owner"));
		if (!lease) {
			await fs.promises.rm(dir, { recursive: true, force: true });
			throw new Error("Unable to acquire host-environment snapshot lease");
		}
		const file = path.join(dir, "env.sh");
		try {
			await fs.promises.chmod(dir, 0o700);
			// Sourcing restores absence too: inherited tool-only overrides must not survive.
			const shellOnlyKeys = Object.keys(getShellConfig().env).filter(key => !(key in hostEnv));
			const metadataKeys = ["OMP_HOST_ENV_FILE", ...HOST_KEYS.map(key => `OMP_HOST_${key}`)];
			const unsetKeys = [
				...new Set([...Object.keys(NON_INTERACTIVE_ENV), ...shellOnlyKeys, ...HOST_KEYS, ...metadataKeys]),
			].filter(key => SHELL_ENV_NAME.test(key));
			const lines = [`unset ${unsetKeys.join(" ")}`];
			for (const [key, value] of Object.entries(hostEnv)) {
				if (!SHELL_ENV_NAME.test(key)) continue;
				// POSIX single quoting keeps shell metacharacters and multiline values inert.
				lines.push(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
			}
			await fs.promises.writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
		} catch (error) {
			lease.release();
			await fs.promises.rm(dir, { recursive: true, force: true });
			throw error;
		}
		process.once("exit", () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} finally {
				lease.release();
			}
		});
		const env: Record<string, string> = { OMP_HOST_ENV_FILE: file };
		for (const key of HOST_KEYS) {
			const value = hostEnv[key];
			if (value !== undefined) env[`OMP_HOST_${key}`] = value;
		}
		if (hostEnv.TERM !== undefined) env.TERM = hostEnv.TERM;
		return env;
	});
}
