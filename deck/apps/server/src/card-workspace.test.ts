import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readonlyCardCommand, snapshotCardAgentState } from "./card-workspace.ts";
import { spawnOwnedSync } from "./owned-process.ts";

const namespaces = ["mnt", "user", "pid", "ipc", "uts"];

for (const runtimeAlias of [false, true]) {
	for (const worktreeAlias of [false, true]) {
		test.skipIf(process.platform !== "linux")(`readonly sandbox starts with ${runtimeAlias ? "symlinked" : "canonical"} runtime and ${worktreeAlias ? "symlinked" : "canonical"} worktree paths`, () => {
			const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "deck-card-sandbox-")));
			try {
				const storage = path.join(root, "storage");
				const alias = path.join(root, "temp alias");
				mkdirSync(storage);
				symlinkSync(storage, alias, "dir");
				const runtimePath = path.join(storage, "runtime");
				const worktreePath = path.join(storage, "worktree");
				mkdirSync(runtimePath);
				mkdirSync(worktreePath);
				const source = path.join(worktreePath, "source.txt");
				const host = path.join(storage, "host.txt");
				writeFileSync(source, "original worktree");
				writeFileSync(host, "original host");
				const runtime = path.join(runtimeAlias ? alias : storage, "runtime");
				const cwd = path.join(worktreeAlias ? alias : storage, "worktree");
				// A fake worker exercises the OS sandbox without importing NeoPi or calling a provider.
				const worker = `
					const fs = require("node:fs");
					const denied = ${JSON.stringify([source, host, path.join(cwd, "source.txt")])}.map(file => {
						try { fs.writeFileSync(file, "forbidden"); return null; }
						catch (error) { return error.code; }
					});
					fs.writeFileSync(process.env.TMPDIR + "/started.txt", "fake worker started");
					console.log(JSON.stringify({
						cwd: process.cwd(), denied,
						devType: fs.statfsSync("/dev").type,
						namespaces: ${JSON.stringify(namespaces)}.map(name => fs.readlinkSync("/proc/self/ns/" + name)),
						mounts: fs.readFileSync("/proc/self/mountinfo", "utf8").split("\\n").filter(Boolean).map(line => {
							const [mount, filesystem] = line.split(" - ");
							const fields = mount.split(" ");
							return { path: fields[4], options: fields[5].split(","), type: filesystem.split(" ")[0] };
						}),
					}));
				`;
				const result = spawnOwnedSync(readonlyCardCommand([process.execPath, "-e", worker], cwd, runtime), {
					cwd, env: { TMPDIR: runtime }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
				});
				expect(result.stderr.toString()).toBe("");
				expect(result.exitCode).toBe(0);
				const observed = JSON.parse(result.stdout.toString()) as {
					cwd: string; denied: string[]; namespaces: string[]; devType: number;
					mounts: Array<{ path: string; options: string[]; type: string }>;
				};
				expect(observed.cwd).toBe(worktreePath);
				expect(readFileSync(path.join(runtimePath, "started.txt"), "utf8")).toBe("fake worker started");
				expect(observed.denied).toEqual(["EROFS", "EROFS", "EROFS"]);
				expect(readFileSync(source, "utf8")).toBe("original worktree");
				expect(readFileSync(host, "utf8")).toBe("original host");
				for (const [index, name] of namespaces.entries()) {
					expect(observed.namespaces[index]).not.toBe(readlinkSync(`/proc/self/ns/${name}`));
				}
				for (const directory of ["/run", "/tmp"]) {
					expect(observed.mounts.find(mount => mount.path === directory)?.type).toBe("tmpfs");
				}
				expect(observed.mounts.find(mount => mount.path === "/")?.options).toContain("ro");
				expect(observed.mounts.find(mount => mount.path === "/proc")?.type).toBe("proc");
				expect(observed.devType).toBe(0x01021994); // TMPFS_MAGIC, not an obscured host /dev mount.
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}

test("card snapshots copy canonical TOML and import legacy sources without copying YAML", () => {
	const root = mkdtempSync(path.join(tmpdir(), "deck-card-config-snapshot-"));
	try {
		const source = path.join(root, "source");
		const target = path.join(root, "runtime");
		mkdirSync(source);
		const legacy = "theme:\n  dark: titanium\n";
		writeFileSync(path.join(source, "config.yml"), legacy);
		chmodSync(path.join(source, "config.yml"), 0o640);
		writeFileSync(path.join(source, "models.toml"), '# custom models\n[providers]\n');
		writeFileSync(path.join(source, "models.yaml"), "providers: {}\n");
		writeFileSync(path.join(source, "unrelated.txt"), "not runtime state");
		snapshotCardAgentState(source, target);
		expect(Bun.TOML.parse(readFileSync(path.join(target, "config.toml"), "utf8"))).toEqual({ theme: { dark: "titanium" } });
		expect(statSync(path.join(source, "config.toml")).mode & 0o777).toBe(0o640);
		expect(readFileSync(path.join(source, "config.yml"), "utf8")).toBe(legacy);
		expect(readFileSync(path.join(target, "models.toml"), "utf8")).toBe('# custom models\n[providers]\n');
		for (const name of ["config.yml", "models.yaml", "unrelated.txt"]) expect(existsSync(path.join(target, name))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
