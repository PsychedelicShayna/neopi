import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, realpathSync, copyFileSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import * as path from "node:path";
import { readTomlConfigSync } from "@oh-my-pi/pi-utils/settings-toml";
import { spawnOwned, spawnOwnedSync, terminateOwned } from "./owned-process.ts";
import type { CardRunOwnership } from "./db/card-runs.ts";

export async function cardGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("cancelled");
	const proc = spawnOwned(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } });
	const abort = () => { void terminateOwned(proc); };
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	try {
		const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (signal?.aborted) throw new Error("cancelled");
		if (exit !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
		return stdout.trim();
	} finally { signal?.removeEventListener("abort", abort); }
}

export async function validateLinkedWorktree(linked: string, signal?: AbortSignal): Promise<string> {
	if (!path.isAbsolute(linked)) throw new Error("linked worktree must be an absolute path");
	const cwd = realpathSync.native(linked);
	const root = realpathSync.native(await cardGit(cwd, ["rev-parse", "--show-toplevel"], signal));
	if (root !== cwd) throw new Error("linked worktree must name the git worktree root");
	const registered = await cardGit(cwd, ["worktree", "list", "--porcelain", "-z"], signal);
	for (const entry of registered.split("\0")) {
		if (!entry.startsWith("worktree ")) continue;
		const directory = entry.slice("worktree ".length);
		if (existsSync(directory) && realpathSync.native(directory) === cwd) return cwd;
	}
	throw new Error("linked worktree is not registered with git");
}

/** Ownership is server-written and never inferred from public run.cwd or YAML. */
export async function cleanupCardWorkspace(ownership: CardRunOwnership): Promise<void> {
	if (ownership.ownedWorktreePath && ownership.repository) {
		const result = spawnOwnedSync(["git", "worktree", "remove", "--force", ownership.ownedWorktreePath], {
			cwd: ownership.repository, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
		if (result.exitCode !== 0 && existsSync(ownership.ownedWorktreePath)) throw new Error(`Owned worktree cleanup failed: ${result.stderr.toString()}`);
		// The parent was also allocated by this run; remove it only when empty.
		try { rmdirSync(path.dirname(ownership.ownedWorktreePath)); } catch { /* nonempty is preserved */ }
	}
	if (ownership.runtimePath) rmSync(ownership.runtimePath, { recursive: true, force: true });
}

/** Snapshot only runtime settings/model/auth state, never sessions, extensions, or skills. */
export function snapshotCardAgentState(source: string, target: string): void {
	mkdirSync(target, { recursive: true, mode: 0o700 });
	if (!existsSync(source)) return;
	for (const name of ["config", "models"]) {
		readTomlConfigSync(path.join(source, `${name}.toml`), {
			legacyPaths: [path.join(source, `${name}.yml`), path.join(source, `${name}.yaml`)],
		});
	}
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (entry.name.endsWith(".db")) {
			const db = new Database(path.join(source, entry.name), { readonly: true });
			try { writeFileSync(path.join(target, entry.name), db.serialize(), { mode: 0o600 }); }
			finally { db.close(); }
		} else if (["config.toml", "models.toml"].includes(entry.name)) copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
	}
}

/** The portable capability clamp is primary. Linux additionally denies host-file writes. */
export function readonlyCardCommand(command: string[], cwd: string, runtime: string): string[] {
	if (process.platform !== "linux") return command;
	const bwrap = Bun.which("bwrap");
	if (!bwrap) throw new Error("Linux readonly defense requires bubblewrap; refusing to run without it");
	// Bubblewrap creates mount destinations without following symlinked parents.
	const runtimePath = realpathSync.native(runtime);
	const worktreePath = realpathSync.native(cwd);
	return [bwrap, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp", "--dir", runtimePath, "--bind", runtimePath, runtimePath, "--dir", worktreePath, "--ro-bind", worktreePath, worktreePath, "--chdir", worktreePath, "--", ...command];
}
