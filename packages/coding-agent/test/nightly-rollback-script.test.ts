import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../../scripts/npi-nightly-rollback.sh");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "nightly-rollback-test-"));
	roots.push(home);
	const dir = join(home, ".local/lib/npi-nightly");
	await mkdir(dir, { recursive: true });
	const current = "#!/bin/sh\necho npi/current\n";
	const previous = "#!/bin/sh\necho npi/previous\n";
	await writeFile(join(dir, "npi"), current);
	await writeFile(join(dir, "npi.previous"), previous);
	await writeFile(join(dir, "npi.rolled-back"), "older backup");
	await chmod(join(dir, "npi"), 0o755);
	await chmod(join(dir, "npi.previous"), 0o755);
	return { home, dir, current, previous };
}

async function run(home: string, args: string[]) {
	const child = Bun.spawn(["bash", script, ...args], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test.each(["--version", "--help", "-h", "--unknown"])("%s never rolls back nightly", async argument => {
	const f = await fixture();
	const before = await stat(join(f.dir, "npi"));
	const result = await run(f.home, [argument]);
	expect(result.code).toBe(argument === "--unknown" ? 2 : 0);
	expect(await readFile(join(f.dir, "npi"), "utf8")).toBe(f.current);
	expect((await stat(join(f.dir, "npi"))).ino).toBe(before.ino);
	expect(await readFile(join(f.dir, "npi.previous"), "utf8")).toBe(f.previous);
	expect(await readFile(join(f.dir, "npi.rolled-back"), "utf8")).toBe("older backup");
});

test("an explicit no-argument rollback restores the previous image and preserves the current image", async () => {
	const f = await fixture();
	expect((await run(f.home, [])).code).toBe(0);
	expect(await readFile(join(f.dir, "npi"), "utf8")).toBe(f.previous);
	expect(await readFile(join(f.dir, "npi.rolled-back"), "utf8")).toBe(f.current);
	expect((await stat(join(f.dir, "npi"))).ino).toBe((await stat(join(f.dir, "npi.previous"))).ino);
	// A second invocation must not overwrite the saved current image with itself.
	expect((await run(f.home, [])).code).toBe(1);
	expect(await readFile(join(f.dir, "npi.rolled-back"), "utf8")).toBe(f.current);
});
