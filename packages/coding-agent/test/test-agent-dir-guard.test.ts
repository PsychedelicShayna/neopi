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
		expect(() => getAgentDir()).not.toThrow();
		expect(getAgentDir()).not.toContain(`${path.sep}profiles${path.sep}inherited${path.sep}`);
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
			process.env.NPI_TEST_ALLOWED_STORAGE_ROOT = symlinkRoot;
			const agentDir = path.join(symlinkRoot, "missing", "agent");
			setAgentDir(agentDir);

			expect(getAgentDir()).toBe(agentDir);
			expect(getSessionsDir()).toBe(path.join(agentDir, "sessions"));
		} finally {
			removeSyncWithRetries(container);
		}
	});

	test("clears profiles inherited by the test process", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, "test", import.meta.path],
			cwd: path.resolve(import.meta.dir, ".."),
			env: {
				...process.env,
				NPI_TEST_INHERITED_PROFILE_PROBE: "1",
				OMP_PROFILE: "inherited",
				PI_PROFILE: "inherited",
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
