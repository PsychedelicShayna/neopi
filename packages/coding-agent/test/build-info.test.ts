/**
 * BUILD_INFO must describe NeoPi's own checkout. A NeoPi package installed
 * under another application's repository (node_modules) sits below that
 * repository's root, and must report `gitSha: null` instead of the
 * application's HEAD.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { resolveGitBuildInfo } from "@oh-my-pi/pi-coding-agent/build-info";

const checkoutRoot = path.resolve(import.meta.dir, "..", "..", "..");

describe("resolveGitBuildInfo", () => {
	test("a directory below an enclosing repository's root is not identified as that repository", async () => {
		const info = await resolveGitBuildInfo(path.join(checkoutRoot, "packages", "coding-agent"));
		expect(info.gitSha).toBeNull();
		expect(info.dirty).toBe(false);
	});

	test("the checkout root reports its HEAD commit", async () => {
		const info = await resolveGitBuildInfo(checkoutRoot);
		expect(info.gitSha).toMatch(/^[0-9a-f]{40}$/);
	});
});
