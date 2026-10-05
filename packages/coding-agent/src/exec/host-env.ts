import * as fs from "node:fs";
import * as path from "node:path";
import { getHostEnvRuntimeRoot } from "@oh-my-pi/pi-utils/dirs";
import { getOriginalProcessEnv } from "@oh-my-pi/pi-utils/env";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

const hostEnv = getOriginalProcessEnv();
const HOST_KEYS = ["EDITOR", "VISUAL", "SSH_ASKPASS", "SUDO_ASKPASS", "TERM"] as const;
const SHELL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
let toolHostEnv: Promise<Record<string, string>> | undefined;

/** Lazily persist the launcher's env, never the sanitized tool env or project dotenv. */
export function getHostEnvForTools(): Promise<Record<string, string>> {
	return (toolHostEnv ??= createHostEnvForTools());
}

async function createHostEnvForTools(): Promise<Record<string, string>> {
	const root = getHostEnvRuntimeRoot();
	await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
	const dir = await fs.promises.mkdtemp(path.join(root, `${process.pid}-`));
	await fs.promises.chmod(dir, 0o700);
	const file = path.join(dir, "env.sh");
	try {
		// Sourcing restores absence too: inherited tool-only overrides must not survive.
		const unsetKeys = [...new Set([...Object.keys(NON_INTERACTIVE_ENV), ...HOST_KEYS])];
		const lines = [`unset ${unsetKeys.join(" ")}`];
		for (const [key, value] of Object.entries(hostEnv)) {
			if (!SHELL_ENV_NAME.test(key)) continue;
			// POSIX single quoting keeps shell metacharacters and multiline values inert.
			lines.push(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
		}
		await fs.promises.writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
	process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	const env: Record<string, string> = { OMP_HOST_ENV_FILE: file };
	for (const key of HOST_KEYS) {
		const value = hostEnv[key];
		if (value !== undefined) env[`OMP_HOST_${key}`] = value;
	}
	if (hostEnv.TERM !== undefined) env.TERM = hostEnv.TERM;
	return env;
}
