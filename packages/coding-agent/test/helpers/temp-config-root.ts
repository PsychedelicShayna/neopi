import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils/temp";

export interface TempConfigRoot {
	readonly configDir: string;
	readonly path: string;
	remove(): void;
}

/**
 * Create a home-relative config name whose storage resolves beneath the OS temp
 * directory. The home entry stays on HOME's drive while a junction/symlink
 * keeps the guarded agent and session data out of the real config tree.
 */
export function createTempConfigRoot(prefix: string): TempConfigRoot {
	const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const home = os.homedir();
	const configRoot = fs.mkdtempSync(path.join(home, `.${prefix}`));
	fs.rmdirSync(configRoot);
	try {
		fs.symlinkSync(storageRoot, configRoot, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		removeSyncWithRetries(storageRoot);
		throw error;
	}
	let removed = false;
	return {
		configDir: path.relative(home, configRoot),
		path: configRoot,
		remove(): void {
			if (removed) return;
			removed = true;
			try {
				fs.unlinkSync(configRoot);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			} finally {
				removeSyncWithRetries(storageRoot);
			}
		},
	};
}
