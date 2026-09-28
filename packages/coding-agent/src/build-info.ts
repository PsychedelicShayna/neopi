/**
 * Build identity for embedders. The package version stays fixed across many
 * commits, so the git commit is the only reliable way to tell trees apart.
 *
 * Compiled binaries carry the identity the build script baked in through
 * `--define`. Source trees resolve it from the NeoPi checkout that holds this
 * module. A package installed anywhere else (for example under an
 * application's `node_modules`) reports `gitSha: null`, never the enclosing
 * application's repository.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

export interface BuildInfo {
	/** Package version, e.g. "18.3.2". */
	readonly version: string;
	/** Full commit SHA the code was built or loaded from; null when unknown. */
	readonly gitSha: string | null;
	/** Whether the checkout had staged, unstaged, or untracked changes. */
	readonly dirty: boolean;
}

const UNKNOWN_BUILD: BuildInfo = { version: VERSION, gitSha: null, dirty: false };

async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Resolve the build identity of the git checkout rooted exactly at
 * `checkoutRoot`. An ancestor repository that merely contains the directory
 * does not count.
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
	return { version: VERSION, gitSha, dirty: gitSha !== null && (await repo.isDirty()) };
}

function bakedBuildInfo(): BuildInfo | undefined {
	const gitSha = process.env.PI_BUILD_GIT_SHA;
	if (gitSha === undefined) return undefined;
	return { version: VERSION, gitSha: gitSha || null, dirty: process.env.PI_BUILD_GIT_DIRTY === "true" };
}

/** Identity of this NeoPi build: baked in for compiled binaries, resolved from git for source trees. */
export const BUILD_INFO: BuildInfo = Object.freeze(
	// This module lives at <checkout>/packages/coding-agent/src/build-info.ts.
	bakedBuildInfo() ?? (await resolveGitBuildInfo(path.resolve(import.meta.dir, "..", "..", ".."))),
);
