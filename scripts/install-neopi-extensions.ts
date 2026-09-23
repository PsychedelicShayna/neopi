#!/usr/bin/env bun
/**
 * Deploy every NeoPi-owned extension from the repo `extensions/` tree into an
 * agent extensions directory.
 *
 * Each source directory becomes a symlink at `<dest>/<name>`. That keeps
 * in-repo relative imports resolvable and picks up new fork extensions without
 * a hard-coded source list. Unrelated entries in dest are left untouched;
 * known legacy extension symlinks are retired after their replacements activate.
 * A same-named dest directory is renamed aside, never deleted.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";

export interface InstallNeopiExtensionsOptions {
	sourceDir: string;
	destDir: string;
}

export interface NeopiExtensionBackup {
	name: string;
	path: string;
}

export interface InstallNeopiExtensionsResult {
	installed: string[];
	refreshed: string[];
	unchanged: string[];
	retired: string[];
	backups: NeopiExtensionBackup[];
}

type ManagedSymlinkOutcome = {
	status: "installed" | "refreshed" | "unchanged";
	backup?: string;
};

let afterRenameAsideForTests: ((dest: string, backup: string) => Promise<void>) | undefined;

/** Test-only hook invoked after dest is renamed aside and before activation. */
export function __setAfterRenameAsideForTests(
	hook: ((dest: string, backup: string) => Promise<void>) | undefined,
): void {
	afterRenameAsideForTests = hook;
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isDirBusy(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "EISDIR" || error.code === "ENOTEMPTY" || error.code === "EPERM")
	);
}

export function defaultNeopiExtensionsSourceDir(repoRoot: string): string {
	return path.join(repoRoot, "extensions");
}

export function defaultNeopiExtensionsDestDir(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "extensions");
}

/** Directory names under `sourceDir` that should be deployed. Hidden names and files are ignored. */
export async function listNeopiExtensionNames(sourceDir: string): Promise<string[]> {
	let entries: Dirent<string>[];
	try {
		entries = await fs.readdir(sourceDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`NeoPi extensions source is missing: ${sourceDir}`);
		}
		throw error;
	}
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory()) continue;
		names.push(entry.name);
	}
	names.sort();
	return names;
}

async function sameRealpath(left: string, right: string): Promise<boolean> {
	try {
		return (await fs.realpath(left)) === (await fs.realpath(right));
	} catch {
		return false;
	}
}

const LEGACY_EXTENSION_NAMES = [
	["omomp-persona", "neopi-persona"],
	["omomp-loadout", "neopi-loadout"],
	["omomp-repl", "neopi-repl"],
	["omomp-live-persona", "neopi-live-persona"],
] as const;

function isKnownLegacyExtensionTarget(target: string, legacyName: string, legacyDest: string): boolean {
	const resolvedTarget = path.resolve(path.dirname(legacyDest), target);
	return path.basename(resolvedTarget) === legacyName && path.basename(path.dirname(resolvedTarget)) === "extensions";
}

async function retireLegacyExtensions(destDir: string, installedNames: ReadonlySet<string>): Promise<string[]> {
	const retired: string[] = [];
	for (const [legacyName, neopiName] of LEGACY_EXTENSION_NAMES) {
		if (!installedNames.has(neopiName)) continue;

		const legacyDest = path.join(destDir, legacyName);
		let stat;
		try {
			stat = await fs.lstat(legacyDest);
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!stat.isSymbolicLink()) continue;

		const target = await fs.readlink(legacyDest);
		if (!isKnownLegacyExtensionTarget(target, legacyName, legacyDest)) continue;
		await fs.unlink(legacyDest);
		retired.push(legacyName);
	}
	return retired;
}

function hiddenSibling(dest: string, label: string): string {
	return path.join(path.dirname(dest), `.${path.basename(dest)}.${label}`);
}

async function restoreBackup(backup: string, dest: string, cause: unknown): Promise<never> {
	try {
		await fs.rename(backup, dest);
	} catch (restoreError) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Failed to activate symlink at ${dest}; original left at ${backup}: ${reason}`, {
			cause: restoreError,
		});
	}
	throw cause;
}

async function ensureManagedSymlink(source: string, dest: string): Promise<ManagedSymlinkOutcome> {
	const absSource = await fs.realpath(source);
	if (await sameRealpath(dest, absSource)) return { status: "unchanged" };

	let existed = false;
	try {
		await fs.lstat(dest);
		existed = true;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	await fs.mkdir(path.dirname(dest), { recursive: true });
	const tmp = hiddenSibling(dest, `${process.pid}.${Date.now()}.tmp`);
	let backup: string | undefined;
	let tmpMoved = false;

	try {
		await fs.symlink(absSource, tmp);
		try {
			await fs.rename(tmp, dest);
			tmpMoved = true;
		} catch (error) {
			if (!isDirBusy(error)) throw error;
			backup = hiddenSibling(dest, `pre-symlink.${Date.now()}`);
			await fs.rename(dest, backup);
			try {
				if (afterRenameAsideForTests) await afterRenameAsideForTests(dest, backup);
				await fs.rename(tmp, dest);
				tmpMoved = true;
			} catch (activateError) {
				await restoreBackup(backup, dest, activateError);
			}
		}
	} finally {
		if (!tmpMoved) {
			await fs.rm(tmp, { force: true });
		}
	}

	return {
		status: existed ? "refreshed" : "installed",
		backup,
	};
}

/**
 * Symlink every source extension directory into `destDir`. Same-named dest
 * directories are renamed aside and reported, not removed. Once a NeoPi
 * counterpart is active, retire its known legacy symlink only when the target
 * has the expected extensions/<legacy-name> shape. Leave other entries alone.
 */
export async function installNeopiExtensions(
	options: InstallNeopiExtensionsOptions,
): Promise<InstallNeopiExtensionsResult> {
	const sourceDir = path.resolve(options.sourceDir);
	const destDir = path.resolve(options.destDir);
	const names = await listNeopiExtensionNames(sourceDir);
	await fs.mkdir(destDir, { recursive: true });

	const result: InstallNeopiExtensionsResult = {
		installed: [],
		refreshed: [],
		unchanged: [],
		backups: [],
		retired: [],
	};
	for (const name of names) {
		const outcome = await ensureManagedSymlink(path.join(sourceDir, name), path.join(destDir, name));
		result[outcome.status].push(name);
		if (outcome.backup) result.backups.push({ name, path: outcome.backup });
	}
	result.retired = await retireLegacyExtensions(destDir, new Set(names));
	return result;
}

export function formatNeopiExtensionsResult(result: InstallNeopiExtensionsResult): string {
	const parts = [
		result.installed.length ? `linked ${result.installed.join(", ")}` : undefined,
		result.refreshed.length ? `refreshed ${result.refreshed.join(", ")}` : undefined,
		result.unchanged.length ? `already current ${result.unchanged.join(", ")}` : undefined,
		result.retired.length ? `retired ${result.retired.length}: ${result.retired.join(", ")}` : undefined,
		result.backups.length
			? `kept ${result.backups.map(backup => `${backup.name} at ${backup.path}`).join(", ")}`
			: undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join("; ") : "no NeoPi extensions to deploy";
}

function parseArgs(argv: string[]): { sourceDir?: string; destDir?: string } {
	const parsed: { sourceDir?: string; destDir?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--source" && next) {
			parsed.sourceDir = next;
			i++;
			continue;
		}
		if (arg === "--dest" && next) {
			parsed.destDir = next;
			i++;
			continue;
		}
		throw new Error(`usage: install-neopi-extensions.ts [--source <dir>] [--dest <dir>]`);
	}
	return parsed;
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	const repoRoot = path.join(import.meta.dir, "..");
	const result = await installNeopiExtensions({
		sourceDir: args.sourceDir ?? defaultNeopiExtensionsSourceDir(repoRoot),
		destDir: args.destDir ?? defaultNeopiExtensionsDestDir(),
	});
	console.log(`neopi extensions: ${formatNeopiExtensionsResult(result)}`);
}
