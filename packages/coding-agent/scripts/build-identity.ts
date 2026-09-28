import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

/** Source identity a build bakes into `BUILD_INFO` (see src/build-info.ts). */
export interface BuildIdentity {
	readonly gitSha: string | null;
	readonly dirty: boolean | null;
}

const UNKNOWN_IDENTITY: BuildIdentity = { gitSha: null, dirty: null };

async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Resolve the identity of the git checkout rooted exactly at `repoRoot`, with
 * the git CLI. Build scripts cannot use the native vcs binding: cross-compiling
 * release runners lack the host addon, and the portable build moves it aside.
 * A source copy without its own `.git` inside another repository reports
 * unknown rather than the enclosing repository. `dirty` matches BUILD_INFO:
 * tracked changes only. Call this before any generator rewrites tracked
 * placeholders.
 */
export async function resolveBuildIdentity(repoRoot: string): Promise<BuildIdentity> {
	const top = await $`git rev-parse --show-toplevel`.cwd(repoRoot).quiet().nothrow();
	if (top.exitCode !== 0) return UNKNOWN_IDENTITY;
	const [root, expected] = await Promise.all([realpathOrResolved(top.text().trim()), realpathOrResolved(repoRoot)]);
	if (root !== expected) return UNKNOWN_IDENTITY;
	const head = await $`git rev-parse --verify HEAD`.cwd(repoRoot).quiet().nothrow();
	if (head.exitCode !== 0) return UNKNOWN_IDENTITY;
	const gitSha = head.text().trim();
	const status = await $`git status --porcelain --untracked-files=no`.cwd(repoRoot).quiet().nothrow();
	return { gitSha, dirty: status.exitCode === 0 ? status.text().trim().length > 0 : null };
}
