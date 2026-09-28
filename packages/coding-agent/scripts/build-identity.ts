import { $ } from "bun";

/** Source identity a build bakes into `BUILD_INFO` (see src/build-info.ts). */
export interface BuildIdentity {
	readonly gitSha: string | null;
	readonly dirty: boolean | null;
}

/**
 * Resolve the checkout's identity with the git CLI. Build scripts cannot use
 * the native vcs binding: cross-compiling release runners lack the host addon,
 * and the portable build moves it aside. `dirty` matches BUILD_INFO: tracked
 * changes only. Call this before any generator rewrites tracked placeholders.
 */
export async function resolveBuildIdentity(repoRoot: string): Promise<BuildIdentity> {
	const head = await $`git rev-parse --verify HEAD`.cwd(repoRoot).quiet().nothrow();
	if (head.exitCode !== 0) return { gitSha: null, dirty: null };
	const gitSha = head.text().trim();
	const status = await $`git status --porcelain --untracked-files=no`.cwd(repoRoot).quiet().nothrow();
	return { gitSha, dirty: status.exitCode === 0 ? status.text().trim().length > 0 : null };
}
