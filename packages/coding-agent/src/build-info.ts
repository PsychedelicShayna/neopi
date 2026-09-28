/**
 * Build identity for embedders. The package version stays fixed across many
 * commits, so the git commit is the only reliable way to tell trees apart.
 *
 * Compiled binaries carry the identity the build script baked in through
 * `--define`. Source trees resolve it once, when this module loads, from the
 * NeoPi checkout that holds this module (never `process.cwd()`). A package
 * installed anywhere else, for example under an application's `node_modules`,
 * reports unknown identity instead of the enclosing application's repository.
 *
 * `BUILD_INFO` identifies source only. It does not certify API compatibility
 * or which native addon is loaded.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

export interface BuildInfo {
	/** Package version, e.g. "18.3.2". */
	readonly version: string;
	/** Full 40-hex commit SHA the code was built or loaded from; null when unknown. */
	readonly gitSha: string | null;
	/**
	 * Whether tracked files had staged or unstaged changes. Untracked and
	 * ignored files (generated bundles, native addons, dependencies) never
	 * count. Null when unknown; unknown is never reported as clean.
	 */
	readonly dirty: boolean | null;
}

const UNKNOWN_BUILD: BuildInfo = Object.freeze({ version: VERSION, gitSha: null, dirty: null });

async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Resolve the build identity of the git checkout rooted exactly at
 * `checkoutRoot`. Linked worktrees (a `.git` file) resolve like any checkout;
 * an ancestor repository that merely contains the directory does not count.
 */
export async function resolveGitBuildInfo(checkoutRoot: string): Promise<BuildInfo> {
	const repo = vcs.git(checkoutRoot);
	if (!repo) return UNKNOWN_BUILD;
	const [root, expected] = await Promise.all([
		realpathOrResolved(repo.info().repoRoot),
		realpathOrResolved(checkoutRoot),
	]);
	if (root !== expected) return UNKNOWN_BUILD;
	const gitSha = repo.headSync().commit ?? null;
	if (gitSha === null) return UNKNOWN_BUILD;
	try {
		const { staged, unstaged } = await repo.statusSummary();
		return Object.freeze({ version: VERSION, gitSha, dirty: staged + unstaged > 0 });
	} catch {
		return Object.freeze({ version: VERSION, gitSha, dirty: null });
	}
}

/** Build identity baked into compiled binaries (`PI_BUILD_GIT_*` defines). */
function bakedBuildInfo(): BuildInfo | undefined {
	const gitSha = process.env.PI_BUILD_GIT_SHA;
	if (gitSha === undefined) return undefined;
	const dirty = process.env.PI_BUILD_GIT_DIRTY;
	return Object.freeze({
		version: VERSION,
		gitSha: gitSha || null,
		dirty: dirty === "true" ? true : dirty === "false" ? false : null,
	});
}

/**
 * Identity of this NeoPi build, snapshotted when the module loads: baked in
 * for compiled binaries, resolved from git for source trees.
 */
export const BUILD_INFO: BuildInfo =
	bakedBuildInfo() ??
	// This module lives at <checkout>/packages/coding-agent/src/build-info.ts.
	(await resolveGitBuildInfo(path.resolve(import.meta.dir, "..", "..", "..")));
