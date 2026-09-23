import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__setAfterRenameAsideForTests,
	formatNeopiExtensionsResult,
	installNeopiExtensions,
	listNeopiExtensionNames,
} from "./install-neopi-extensions";

const tempDirs: string[] = [];

afterEach(async () => {
	__setAfterRenameAsideForTests(undefined);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeExtension(
	root: string,
	name: string,
	body = `export default function ${name.replaceAll("-", "_")}() {}\n`,
): Promise<string> {
	const dir = path.join(root, name);
	await Bun.write(path.join(dir, "index.ts"), body);
	return dir;
}

describe("listNeopiExtensionNames", () => {
	test("lists every source directory and ignores files plus hidden names", async () => {
		const source = await tempDir("neopi-ext-src-");
		await writeExtension(source, "neopi-live-persona");
		await writeExtension(source, "neopi-loadout");
		await writeExtension(source, "neopi-persona");
		await Bun.write(path.join(source, "README.md"), "not an extension\n");
		await writeExtension(source, ".hidden");

		expect(await listNeopiExtensionNames(source)).toEqual(["neopi-live-persona", "neopi-loadout", "neopi-persona"]);
	});

	test("fails loudly when the source tree is missing", async () => {
		const missing = path.join(await tempDir("neopi-ext-missing-"), "extensions");
		await expect(listNeopiExtensionNames(missing)).rejects.toThrow(/NeoPi extensions source is missing/);
	});
});

describe("installNeopiExtensions", () => {
	test("symlinks the whole source set and leaves unrelated dest entries alone", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		await writeExtension(source, "neopi-live-persona");
		await writeExtension(source, "neopi-repl");
		await writeExtension(source, "third-party-looking-fork-ext");
		const userExt = path.join(dest, "copy-all");
		await Bun.write(path.join(userExt, "index.ts"), "export default function copy_all() {}\n");

		const first = await installNeopiExtensions({ sourceDir: source, destDir: dest });
		expect(first.installed).toEqual(["neopi-live-persona", "neopi-repl", "third-party-looking-fork-ext"]);
		expect(first.refreshed).toEqual([]);
		expect(first.unchanged).toEqual([]);
		expect(first.retired).toEqual([]);

		for (const name of first.installed) {
			expect((await fs.lstat(path.join(dest, name))).isSymbolicLink()).toBe(true);
			expect(await fs.realpath(path.join(dest, name))).toBe(await fs.realpath(path.join(source, name)));
		}
		expect((await fs.lstat(userExt)).isDirectory()).toBe(true);
		expect((await fs.lstat(userExt)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(userExt, "index.ts")).text()).toBe("export default function copy_all() {}\n");

		const second = await installNeopiExtensions({ sourceDir: source, destDir: dest });
		expect(second.installed).toEqual([]);
		expect(second.refreshed).toEqual([]);
		expect(second.unchanged).toEqual(["neopi-live-persona", "neopi-repl", "third-party-looking-fork-ext"]);
		expect(second.retired).toEqual([]);
		expect(await fs.readdir(dest)).toEqual(
			expect.arrayContaining(["copy-all", "neopi-live-persona", "neopi-repl", "third-party-looking-fork-ext"]),
		);
	});

	test("replaces a managed directory copy with a symlink so repo-relative imports keep working", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		await writeExtension(
			source,
			"neopi-live-persona",
			'export { x } from "../../packages/coding-agent/src/live/personas.ts";\n',
		);
		await Bun.write(path.join(dest, "neopi-live-persona", "index.ts"), "stale copy\n");

		const result = await installNeopiExtensions({ sourceDir: source, destDir: dest });
		expect(result.refreshed).toEqual(["neopi-live-persona"]);
		expect((await fs.lstat(path.join(dest, "neopi-live-persona"))).isSymbolicLink()).toBe(true);
		expect(await Bun.file(path.join(dest, "neopi-live-persona", "index.ts")).text()).toContain(
			"../../packages/coding-agent/src/live/personas.ts",
		);
	});

	test("retargets a managed symlink that points at the wrong directory", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		const other = await tempDir("neopi-ext-other-");
		await writeExtension(source, "neopi-persona");
		await writeExtension(other, "neopi-persona", "wrong\n");
		await fs.symlink(path.join(other, "neopi-persona"), path.join(dest, "neopi-persona"));

		const result = await installNeopiExtensions({ sourceDir: source, destDir: dest });
		expect(result.refreshed).toEqual(["neopi-persona"]);
		expect(await fs.realpath(path.join(dest, "neopi-persona"))).toBe(
			await fs.realpath(path.join(source, "neopi-persona")),
		);
	});

	test("renames a divergent dest directory aside instead of deleting it", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		await writeExtension(source, "neopi-live-persona");
		const destExt = path.join(dest, "neopi-live-persona");
		await Bun.write(path.join(destExt, "keep-me.ts"), "user edits\n");

		const result = await installNeopiExtensions({ sourceDir: source, destDir: dest });
		expect(result.refreshed).toEqual(["neopi-live-persona"]);
		expect(result.backups).toHaveLength(1);
		expect(result.backups[0]?.name).toBe("neopi-live-persona");
		const backup = result.backups[0]!.path;
		expect(path.basename(backup).startsWith(".")).toBe(true);
		expect(path.dirname(backup)).toBe(dest);
		expect((await fs.lstat(destExt)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(destExt)).toBe(await fs.realpath(path.join(source, "neopi-live-persona")));
		expect((await fs.lstat(backup)).isDirectory()).toBe(true);
		expect((await fs.lstat(backup)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(backup, "keep-me.ts")).text()).toBe("user edits\n");
		expect(formatNeopiExtensionsResult(result)).toContain(backup);
	});

	test("retires an owned legacy symlink after its NeoPi counterpart is active", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		const oldCheckout = await tempDir("omomp-old-checkout-");
		await writeExtension(source, "neopi-repl");
		const legacySource = await writeExtension(path.join(oldCheckout, "extensions"), "omomp-repl");
		const legacyDest = path.join(dest, "omomp-repl");
		await fs.symlink(legacySource, legacyDest);

		const result = await installNeopiExtensions({ sourceDir: source, destDir: dest });

		expect(result.retired).toEqual(["omomp-repl"]);
		expect(formatNeopiExtensionsResult(result)).toContain("retired 1: omomp-repl");
		await expect(fs.lstat(legacyDest)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.realpath(path.join(dest, "neopi-repl"))).toBe(await fs.realpath(path.join(source, "neopi-repl")));
	});

	test("retires a dangling relative legacy target without requiring the old checkout", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		await writeExtension(source, "neopi-repl");
		const missingTarget = path.join(dest, "old-checkout", "extensions", "omomp-repl");
		const legacyDest = path.join(dest, "omomp-repl");
		await fs.symlink(path.relative(dest, missingTarget), legacyDest);

		const result = await installNeopiExtensions({ sourceDir: source, destDir: dest });

		expect(result.retired).toEqual(["omomp-repl"]);
		await expect(fs.lstat(legacyDest)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.realpath(path.join(dest, "neopi-repl"))).toBe(await fs.realpath(path.join(source, "neopi-repl")));
	});

	test("preserves directories, hidden backups, unrelated links, and legacy links with foreign targets", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		const foreign = await tempDir("neopi-ext-foreign-");
		const oldCheckout = await tempDir("omomp-old-checkout-");
		await writeExtension(source, "neopi-persona");
		await writeExtension(source, "neopi-repl");

		const legacyDirectory = path.join(dest, "omomp-persona");
		await Bun.write(path.join(legacyDirectory, "keep-me.ts"), "user data\n");
		const foreignLegacyTarget = path.join(foreign, "plugins", "omomp-repl");
		await fs.symlink(foreignLegacyTarget, path.join(dest, "omomp-repl"));
		const unrelatedTarget = path.join(foreign, "extensions", "unrelated-dangling");
		await fs.symlink(unrelatedTarget, path.join(dest, "unrelated-dangling"));
		const liveForeignTarget = await writeExtension(foreign, "copy-all");
		await fs.symlink(liveForeignTarget, path.join(dest, "copy-all"));
		const legacyWithoutCounterpart = await writeExtension(path.join(oldCheckout, "extensions"), "omomp-loadout");
		await fs.symlink(legacyWithoutCounterpart, path.join(dest, "omomp-loadout"));
		const hiddenBackup = path.join(dest, ".omomp-repl.pre-symlink.123");
		await Bun.write(path.join(hiddenBackup, "keep-me.ts"), "backup\n");

		const result = await installNeopiExtensions({ sourceDir: source, destDir: dest });

		expect(result.retired).toEqual([]);
		expect(await Bun.file(path.join(legacyDirectory, "keep-me.ts")).text()).toBe("user data\n");
		expect(await fs.readlink(path.join(dest, "omomp-repl"))).toBe(foreignLegacyTarget);
		expect(await fs.readlink(path.join(dest, "unrelated-dangling"))).toBe(unrelatedTarget);
		expect(await fs.readlink(path.join(dest, "copy-all"))).toBe(liveForeignTarget);
		expect(await fs.readlink(path.join(dest, "omomp-loadout"))).toBe(legacyWithoutCounterpart);
		expect(await Bun.file(path.join(hiddenBackup, "keep-me.ts")).text()).toBe("backup\n");
	});

	test("restores the old dest and removes staging files if activation fails", async () => {
		const source = await tempDir("neopi-ext-src-");
		const dest = await tempDir("neopi-ext-dest-");
		await writeExtension(source, "neopi-live-persona");
		const destExt = path.join(dest, "neopi-live-persona");
		await Bun.write(path.join(destExt, "keep-me.ts"), "user edits\n");
		const legacyTarget = path.join(dest, "old-checkout", "extensions", "omomp-live-persona");
		const legacyDest = path.join(dest, "omomp-live-persona");
		await fs.symlink(legacyTarget, legacyDest);
		__setAfterRenameAsideForTests(async () => {
			throw new Error("activation failed");
		});

		await expect(installNeopiExtensions({ sourceDir: source, destDir: dest })).rejects.toThrow(/activation failed/);

		expect((await fs.lstat(destExt)).isDirectory()).toBe(true);
		expect((await fs.lstat(destExt)).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(destExt, "keep-me.ts")).text()).toBe("user edits\n");
		expect(await fs.readlink(legacyDest)).toBe(legacyTarget);
		const leftovers = (await fs.readdir(dest)).filter(name => name.includes(".tmp") || name.includes("pre-symlink"));
		expect(leftovers).toEqual([]);
	});
});

describe("default NeoPi extension paths", () => {
	test("default dest follows profiles and PI_CODING_AGENT_DIR", async () => {
		const installer = path.join(import.meta.dir, "install-neopi-extensions.ts");
		const script = `import { defaultNeopiExtensionsDestDir } from ${JSON.stringify(installer)}; process.stdout.write(defaultNeopiExtensionsDestDir());`;
		const destFor = async (env: Record<string, string>): Promise<string> => {
			const proc = Bun.spawn(["bun", "-e", script], {
				cwd: path.join(import.meta.dir, ".."),
				env: {
					...process.env,
					OMP_PROFILE: "",
					PI_PROFILE: "",
					PI_CODING_AGENT_DIR: "",
					...env,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				throw new Error(stderr || `default dest helper exited ${exitCode}`);
			}
			return stdout;
		};

		const configDir = process.env.PI_CONFIG_DIR || ".omp";
		expect(await destFor({ OMP_PROFILE: "neopi-ext-review" })).toBe(
			path.join(os.homedir(), configDir, "profiles", "neopi-ext-review", "agent", "extensions"),
		);
		expect(await destFor({ PI_CODING_AGENT_DIR: "/tmp/pi-coding-agent-dir" })).toBe(
			path.join("/tmp/pi-coding-agent-dir", "extensions"),
		);
	});
});
