import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBundledChangelogPath } from "../../src/utils/changelog";

interface HeapProbeResult {
	retainedChangelogStrings: number;
}

interface BundleProbeResult {
	version: string;
	entries: number;
}

const heapProbePath = path.resolve(import.meta.dir, "..", "fixtures", "changelog-static-import-heap-probe.ts");
const bundleProbePath = path.resolve(import.meta.dir, "..", "fixtures", "changelog-bundle-fallback-probe.ts");
const buildProbePath = path.resolve(import.meta.dir, "..", "fixtures", "changelog-build-probe.ts");

async function runProbe<T = BundleProbeResult>(command: string[], cwd?: string): Promise<T> {
	const proc = Bun.spawn(command, {
		cwd,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as T;
}

describe("bundled changelog asset path resolution", () => {
	const moduleUrl = new URL("file:///opt/omp/dist/cli.js");

	test.each([
		["Windows drive-letter", String.raw`C:\omp\dist\CHANGELOG.md`],
		["Windows UNC", String.raw`\\server\share\omp\CHANGELOG.md`],
		["POSIX", "/opt/omp/dist/CHANGELOG.md"],
	])("preserves an absolute %s path", (_kind, nativePath) => {
		expect(resolveBundledChangelogPath(nativePath, moduleUrl)).toBe(nativePath);
	});

	test("resolves a relative emitted asset against the module", () => {
		expect(resolveBundledChangelogPath("./CHANGELOG-hash.md", moduleUrl)).toEqual(
			new URL("./CHANGELOG-hash.md", moduleUrl),
		);
	});
});

describe("changelog static import resources", () => {
	test("does not retain the multi-megabyte changelog text before parsing", async () => {
		const proc = Bun.spawn([process.execPath, heapProbePath], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout) as HeapProbeResult).toEqual({ retainedChangelogStrings: 0 });
	}, 30_000);

	test("reads the emitted changelog asset when run outside the bundle directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-changelog-bundle-"));
		try {
			const bundleDir = path.join(tempDir, "bundle");
			const unrelatedCwd = path.join(tempDir, "cwd");
			const missingPackageChangelogPath = path.join(tempDir, "missing-package", "CHANGELOG.md");
			await fs.mkdir(unrelatedCwd);
			const sourceResult = await runProbe([process.execPath, bundleProbePath, missingPackageChangelogPath]);

			// A fresh compiler process avoids Bun's shared in-process build path cache.
			const bundlePath = await runProbe<string>([process.execPath, buildProbePath, "bundle", bundleDir]);
			const result = await runProbe([process.execPath, bundlePath, missingPackageChangelogPath], unrelatedCwd);

			expect(result.entries).toBe(sourceResult.entries);
			expect(result.version).toBe(sourceResult.version);
		} finally {
			await fs.rm(tempDir, { force: true, recursive: true });
		}
	}, 30_000);

	test("reads the emitted changelog asset from a compiled binary", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-changelog-compiled-"));
		try {
			const binaryPath = path.join(tempDir, "changelog-probe");
			const unrelatedCwd = path.join(tempDir, "cwd");
			const missingPackageChangelogPath = path.join(tempDir, "missing-package", "CHANGELOG.md");
			await fs.mkdir(unrelatedCwd);
			const sourceResult = await runProbe([process.execPath, bundleProbePath, missingPackageChangelogPath]);

			await runProbe<string>([process.execPath, buildProbePath, "compile", binaryPath]);

			const result = await runProbe([binaryPath, missingPackageChangelogPath], unrelatedCwd);
			expect(result.entries).toBe(sourceResult.entries);
			expect(result.version).toBe(sourceResult.version);
		} finally {
			await fs.rm(tempDir, { force: true, recursive: true });
		}
	}, 30_000);
});
