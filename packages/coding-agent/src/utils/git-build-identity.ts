/**
 * Source identity of a NeoPi checkout, shared by the runtime `BUILD_INFO`
 * snapshot and the build scripts that bake it into compiled binaries.
 * Side-effect free: importing it does not load the native addon.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export interface GitBuildIdentity {
	/** Full 40-hex commit SHA; null when unknown. */
	readonly gitSha: string | null;
	/** Tracked files have staged or unstaged changes; null when unknown. */
	readonly dirty: boolean | null;
}

export const UNKNOWN_GIT_BUILD_IDENTITY: GitBuildIdentity = Object.freeze({ gitSha: null, dirty: null });

/** Realpath of `p`, or its resolved form when it does not exist. */
export async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Resolve the identity of the git checkout rooted exactly at `checkoutRoot`.
 * Linked worktrees (a `.git` file) resolve like any checkout; an ancestor
 * repository that merely contains the directory yields unknown. Dirtiness
 * counts tracked changes only and never enumerates untracked or ignored files.
 * Throws when the native vcs binding cannot load.
 */
export async function resolveGitBuildIdentity(checkoutRoot: string): Promise<GitBuildIdentity> {
	const repo = vcs.git(checkoutRoot);
	if (!repo) return UNKNOWN_GIT_BUILD_IDENTITY;
	const [root, expected] = await Promise.all([
		realpathOrResolved(repo.info().repoRoot),
		realpathOrResolved(checkoutRoot),
	]);
	if (root !== expected) return UNKNOWN_GIT_BUILD_IDENTITY;
	const gitSha = repo.headSync().commit ?? null;
	if (gitSha === null) return UNKNOWN_GIT_BUILD_IDENTITY;
	try {
		const trackedChanges = await repo.statusPorcelain({ untracked: "no" });
		return { gitSha, dirty: trackedChanges.trim().length > 0 };
	} catch {
		return { gitSha, dirty: null };
	}
}
