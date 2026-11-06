import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapterConfigs } from "@oh-my-pi/pi-coding-agent/dap/config";
import { stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";

const ADAPTER = "omp-precedence-probe";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("DAP config layering", () => {
	test("a cwd file overrides the project config dir field by field", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-precedence-"));
		await Bun.write(
			path.join(tempDir, ".omp", "dap.toml"),
			stringifySettingsToml({ [ADAPTER]: { command: "project-cmd", args: ["from-project"] } }),
		);
		await Bun.write(path.join(tempDir, "dap.toml"), stringifySettingsToml({ [ADAPTER]: { command: "cwd-cmd" } }));

		const adapter = getAdapterConfigs(tempDir)[ADAPTER];

		expect(adapter?.command).toBe("cwd-cmd");
		expect(adapter?.args).toEqual(["from-project"]);
	});

	test("native TOML wholly wins over legacy siblings without importing stale fields", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-native-precedence-"));
		const legacyPath = path.join(tempDir, "dap.json");
		const legacySource = JSON.stringify({ [ADAPTER]: { command: "legacy-cmd", args: ["stale"] } });
		await Bun.write(legacyPath, legacySource);
		await Bun.write(path.join(tempDir, "dap.toml"), stringifySettingsToml({ [ADAPTER]: { command: "native-cmd" } }));

		const adapter = getAdapterConfigs(tempDir)[ADAPTER];
		expect(adapter?.command).toBe("native-cmd");
		expect(adapter?.args).toEqual([]);
		expect(await Bun.file(legacyPath).text()).toBe(legacySource);
	});
});
