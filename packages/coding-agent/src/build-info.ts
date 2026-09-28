/**
 * Build identity for embedders. The package version stays fixed across many
 * commits, so the git commit is the only reliable way to tell trees apart.
 *
 * Compiled binaries carry the identity the build script baked in through
 * `--define`. Source trees resolve it from the git checkout that holds this
 * module; a tree outside any checkout reports `gitSha: null`.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

export interface BuildInfo {
	/** Package version, e.g. "18.3.2". */
	readonly version: string;
	/** Full commit SHA the code was built or loaded from; null outside a git checkout. */
	readonly gitSha: string | null;
	/** Whether the checkout had staged, unstaged, or untracked changes. */
	readonly dirty: boolean;
}

/** Resolve the build identity of the git checkout containing `dir`. */
export async function resolveGitBuildInfo(dir: string): Promise<BuildInfo> {
	const repo = vcs.git(dir);
	if (!repo) return { version: VERSION, gitSha: null, dirty: false };
	const gitSha = repo.headSync().commit ?? null;
	return { version: VERSION, gitSha, dirty: gitSha !== null && (await repo.isDirty()) };
}

function bakedBuildInfo(): BuildInfo | undefined {
	const gitSha = process.env.PI_BUILD_GIT_SHA;
	if (gitSha === undefined) return undefined;
	return { version: VERSION, gitSha: gitSha || null, dirty: process.env.PI_BUILD_GIT_DIRTY === "true" };
}

/** Identity of this NeoPi build: baked in for compiled binaries, resolved from git for source trees. */
export const BUILD_INFO: BuildInfo = Object.freeze(bakedBuildInfo() ?? (await resolveGitBuildInfo(import.meta.dir)));
