/**
 * BUILD_INFO identifies the NeoPi source tree it was loaded from: the full
 * commit, and whether tracked files differ from it. Unknown is never reported
 * as clean, an enclosing application's repository is never mistaken for
 * NeoPi's, and the snapshot ignores later cwd or HEAD changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGitBuildInfo } from "@oh-my-pi/pi-coding-agent/build-info";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { resolveBuildIdentity } from "../scripts/build-identity";

const checkoutRoot = path.resolve(import.meta.dir, "..", "..", "..");
const tempDirs: string[] = [];

async function tempDir(label: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `npi-build-info-${label}-`)));
	tempDirs.push(dir);
	return dir;
}

/** A git repo with one commit of `tracked.txt` and `.gitignore` ignoring `ignored/`. */
async function gitRepo(label: string, content: string): Promise<{ dir: string; sha: string }> {
	const dir = await tempDir(label);
	await $`git init --initial-branch=main`.cwd(dir).quiet();
	await $`git config user.name "Test User"`.cwd(dir).quiet();
	await $`git config user.email "test@example.com"`.cwd(dir).quiet();
	await Bun.write(path.join(dir, "tracked.txt"), content);
	await Bun.write(path.join(dir, ".gitignore"), "ignored/\n");
	await $`git add tracked.txt .gitignore`.cwd(dir).quiet();
	await $`git -c commit.gpgsign=false commit -m seed`.cwd(dir).quiet();
	const sha = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim();
	return { dir, sha };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("resolveGitBuildInfo", () => {
	test("two trees with the same package version report their own full commits", async () => {
		const [a, b] = await Promise.all([gitRepo("a", "one\n"), gitRepo("b", "two\n")]);
		const [infoA, infoB] = await Promise.all([resolveGitBuildInfo(a.dir), resolveGitBuildInfo(b.dir)]);
		expect(infoA.version).toBe(infoB.version);
		expect(infoA.gitSha).toBe(a.sha);
		expect(infoB.gitSha).toBe(b.sha);
		expect(infoA.gitSha).toMatch(/^[0-9a-f]{40}$/);
	});

	test("dirty counts tracked changes only, never untracked or ignored files", async () => {
		const { dir } = await gitRepo("dirty", "base\n");
		await Bun.write(path.join(dir, "untracked.txt"), "new\n");
		await Bun.write(path.join(dir, "ignored", "addon.node"), "binary\n");
		expect((await resolveGitBuildInfo(dir)).dirty).toBe(false);
		await Bun.write(path.join(dir, "tracked.txt"), "edited\n");
		expect((await resolveGitBuildInfo(dir)).dirty).toBe(true);
	});

	test("a detached linked worktree (.git file) reports its own commit", async () => {
		const { dir, sha: firstSha } = await gitRepo("main", "first\n");
		await Bun.write(path.join(dir, "tracked.txt"), "second\n");
		await $`git -c commit.gpgsign=false commit -am second`.cwd(dir).quiet();
		const worktree = path.join(await tempDir("wt"), "detached");
		await $`git worktree add --detach ${worktree} ${firstSha}`.cwd(dir).quiet();
		expect((await fs.stat(path.join(worktree, ".git"))).isFile()).toBe(true);
		const info = await resolveGitBuildInfo(worktree);
		expect(info.gitSha).toBe(firstSha);
		expect(info.dirty).toBe(false);
	});

	test("a non-git source reports unknown, not clean", async () => {
		const info = await resolveGitBuildInfo(await tempDir("plain"));
		expect(info).toMatchObject({ gitSha: null, dirty: null });
	});

	test("a directory below an enclosing repository's root is not identified as that repository", async () => {
		const { dir } = await gitRepo("app", "app\n");
		const nested = path.join(dir, "node_modules", "@oh-my-pi", "pi-coding-agent");
		await fs.mkdir(nested, { recursive: true });
		expect(await resolveGitBuildInfo(nested)).toMatchObject({ gitSha: null, dirty: null });
	});
});

describe("BUILD_INFO", () => {
	test("is snapshotted from the loaded tree, independent of cwd and later HEAD changes", async () => {
		const { dir: cwdRepo } = await gitRepo("cwd", "cwd\n");
		const expectedSha = (await $`git rev-parse HEAD`.cwd(checkoutRoot).quiet().text()).trim();
		const probe = path.join(await tempDir("probe"), "probe.ts");
		const module = path.join(checkoutRoot, "packages", "coding-agent", "src", "build-info.ts");
		await Bun.write(
			probe,
			[
				`import { $ } from "bun";`,
				`const { BUILD_INFO } = await import(${JSON.stringify(module)});`,
				`const before = JSON.stringify(BUILD_INFO);`,
				`await Bun.write("tracked.txt", "moved\\n");`,
				`await $\`git -c commit.gpgsign=false commit -qam moved\`.quiet();`,
				`process.chdir(${JSON.stringify(os.tmpdir())});`,
				`console.log(JSON.stringify({ before, after: JSON.stringify(BUILD_INFO) }));`,
			].join("\n"),
		);
		const result = await $`${process.execPath} ${probe}`.cwd(cwdRepo).quiet().nothrow();
		expect(result.exitCode).toBe(0);
		const { before, after } = JSON.parse(result.text().trim()) as { before: string; after: string };
		expect(after).toBe(before);
		expect((JSON.parse(before) as { gitSha: string | null }).gitSha).toBe(expectedSha);
	});
});

describe("BUILD_INFO in a source tree", () => {
	test("ignores compile-time provenance variables inherited from the environment", async () => {
		const expectedSha = (await $`git rev-parse HEAD`.cwd(checkoutRoot).quiet().text()).trim();
		const module = path.join(checkoutRoot, "packages", "coding-agent", "src", "build-info.ts");
		const probe = path.join(await tempDir("env"), "probe.ts");
		await Bun.write(
			probe,
			`import { BUILD_INFO } from ${JSON.stringify(module)};\nconsole.log(BUILD_INFO.gitSha);\n`,
		);
		const result = await $`${process.execPath} ${probe}`
			.env({ ...process.env, PI_BUILD_GIT_SHA: "0".repeat(40), PI_BUILD_GIT_DIRTY: "false" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(result.text().trim()).toBe(expectedSha);
	});
});

describe("resolveBuildIdentity (build scripts)", () => {
	test("bakes the checkout's commit with tracked-only dirtiness", async () => {
		const { dir, sha } = await gitRepo("build", "base\n");
		await Bun.write(path.join(dir, "untracked.txt"), "new\n");
		expect(await resolveBuildIdentity(dir)).toEqual({ gitSha: sha, dirty: false });
		await Bun.write(path.join(dir, "tracked.txt"), "edited\n");
		expect(await resolveBuildIdentity(dir)).toEqual({ gitSha: sha, dirty: true });
	});

	test("a source copy inside another repository bakes unknown, not the enclosing HEAD", async () => {
		const { dir } = await gitRepo("enclosing", "app\n");
		const copy = path.join(dir, "vendor", "neopi");
		await fs.mkdir(copy, { recursive: true });
		expect(await resolveBuildIdentity(copy)).toEqual({ gitSha: null, dirty: null });
	});
});
