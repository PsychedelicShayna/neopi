import {
	type GitBuildIdentity,
	resolveGitBuildIdentity,
	UNKNOWN_GIT_BUILD_IDENTITY,
} from "../src/utils/git-build-identity";

/** Source identity a build bakes into `BUILD_INFO` (see src/build-info.ts). */
export type BuildIdentity = GitBuildIdentity;

/**
 * Resolve the checkout's identity through the native vcs binding, with the
 * same rules as the runtime `BUILD_INFO`. Call this before any generator
 * rewrites tracked placeholders. Cross-compiling release runners lack the
 * host addon; there a CI checkout's `GITHUB_SHA` (clean by construction) is
 * used, and anywhere else the identity is baked as unknown.
 */
export async function resolveBuildIdentity(repoRoot: string): Promise<BuildIdentity> {
	try {
		return await resolveGitBuildIdentity(repoRoot);
	} catch {
		const ciSha = Bun.env.GITHUB_SHA;
		return ciSha ? { gitSha: ciSha, dirty: false } : UNKNOWN_GIT_BUILD_IDENTITY;
	}
}
