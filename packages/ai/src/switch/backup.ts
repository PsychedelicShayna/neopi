import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SwitchDatabase } from "./database";
import { SwitchError } from "./error";

function invalidPath(): never {
	throw new SwitchError(
		422,
		"backup_path",
		"Backup must be a new regular file beneath the service-owned backup directory, without symlinks or traversal",
	);
}

/** The operator chooses a service-side name, never an arbitrary output location. */
export async function createBackup(
	database: SwitchDatabase,
	root: string,
	requested: string,
	beforeSnapshot: () => void,
): Promise<{ path: string; bytes: number }> {
	if (!requested || requested.includes("\0") || requested.split(/[\\/]/).includes("..")) invalidPath();
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const rootStat = await fs.lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.geteuid && rootStat.uid !== process.geteuid()))
		invalidPath();
	await fs.chmod(root, 0o700);
	const canonicalRoot = await fs.realpath(root);
	const destination = path.resolve(canonicalRoot, requested);
	const relative = path.relative(canonicalRoot, destination);
	if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
		invalidPath();
	let parent = canonicalRoot;
	for (const component of relative.split(path.sep).slice(0, -1)) {
		parent = path.join(parent, component);
		let info: fsTypes.Stats;
		try {
			info = await fs.lstat(parent);
		} catch {
			invalidPath();
		}
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			(process.geteuid && info.uid !== process.geteuid()) ||
			(info.mode & 0o022) !== 0
		)
			invalidPath();
	}
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(destination, "wx", 0o600);
	} catch {
		invalidPath();
	}
	let opened: fsTypes.Stats | undefined;
	let success = false;
	try {
		opened = await handle.stat();
		if (!opened.isFile()) invalidPath();
		beforeSnapshot();
		// VACUUM INTO accepts an existing empty file; exclusive creation fixed its permissions.
		database.backup(destination);
		await handle.sync();
		const current = await fs.lstat(destination);
		if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino)
			invalidPath();
		const result = { path: destination, bytes: current.size };
		success = true;
		return result;
	} finally {
		let closed = false;
		try {
			await handle.close();
			closed = true;
		} finally {
			if (!success || !closed) {
				try {
					const current = await fs.lstat(destination);
					if (opened && current.isFile() && current.dev === opened.dev && current.ino === opened.ino)
						await fs.unlink(destination);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		}
	}
}
