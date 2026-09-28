import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils/temp";

const inheritedProfileProbe = process.env.NPI_TEST_INHERITED_PROFILE_PROBE === "1";

if (inheritedProfileProbe) {
	test("clears inherited profiles before configuring temporary storage", () => {
		expect(process.env.OMP_PROFILE).toBeUndefined();
		expect(process.env.PI_PROFILE).toBeUndefined();
		const agentDir = getAgentDir();
		expect(agentDir.startsWith(`${os.tmpdir()}${path.sep}`)).toBe(true);
		expect(getSessionsDir()).toBe(path.join(agentDir, "sessions"));
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const) {
			const value = process.env[key];
			expect(value).toBeDefined();
			expect(value?.startsWith(`${os.tmpdir()}${path.sep}`)).toBe(true);
		}
		setAgentDir(path.join(os.homedir(), ".omp", "agent"));
		expect(() => getAgentDir()).toThrow("outside its isolated temporary storage");
	});
} else {
	test("rejects named profiles that escape temporary test storage", () => {
		delete process.env.PI_CONFIG_DIR;
		setProfile("work");

		expect(() => getAgentDir()).toThrow("outside its isolated temporary storage");
		expect(() => getSessionsDir()).toThrow("outside its isolated temporary storage");
	});

	test("rejects agent and session directories outside temporary test storage", () => {
		setAgentDir(path.join(os.homedir(), ".omp", "agent"));

		expect(() => getAgentDir()).toThrow("outside its isolated temporary storage");
		expect(() => getSessionsDir()).toThrow("outside its isolated temporary storage");
	});

	test("accepts a missing descendant beneath a symlinked temporary root", () => {
		const container = fs.mkdtempSync(path.join(os.tmpdir(), "npi-test-symlinked-storage-"));
		const actualRoot = path.join(container, "actual");
		const symlinkRoot = path.join(container, "link");
		fs.mkdirSync(actualRoot);
		fs.symlinkSync(actualRoot, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
		try {
			const agentDir = path.join(symlinkRoot, "missing", "agent");
			const result = Bun.spawnSync({
				cmd: [
					process.execPath,
					"-e",
					'import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs"; console.log(getAgentDir()); console.log(getSessionsDir());',
				],
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					NPI_TEST_ALLOWED_STORAGE_ROOT: symlinkRoot,
					PI_CODING_AGENT_DIR: agentDir,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
			expect(new TextDecoder().decode(result.stdout).trim().split("\n")).toEqual([
				agentDir,
				path.join(agentDir, "sessions"),
			]);
		} finally {
			removeSyncWithRetries(container);
		}
	});

	test("leaves root-invoked utility profile tests outside the coding-agent guard", () => {
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const result = Bun.spawnSync({
			cmd: [process.execPath, "test", "packages/utils/test/profiles.test.ts"],
			cwd: repoRoot,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
	});

	test("scopes the guard across utility and coding-agent files in one root runner", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, "test", "packages/utils/test/profiles.test.ts", import.meta.path],
			cwd: path.resolve(import.meta.dir, "..", "..", ".."),
			env: {
				...process.env,
				NPI_TEST_INHERITED_PROFILE_PROBE: "1",
				OMP_PROFILE: "inherited",
				PI_PROFILE: "inherited",
				XDG_DATA_HOME: path.join(os.homedir(), ".local", "share"),
				XDG_STATE_HOME: path.join(os.homedir(), ".local", "state"),
				XDG_CACHE_HOME: path.join(os.homedir(), ".cache"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`Inherited-profile probe failed:\n${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
			);
		}
	});
}
