/**
 * `mcp.includeServers` (set per run by `--mcp`) admits only servers whose names
 * match one of its globs. The user `disabledServers` denylist and per-server
 * `enabled: false` still exclude a server the allowlist would admit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, reset as resetDiscoveryCache } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("mcp.includeServers allowlist", () => {
	let projectDir = "";
	let userAgentDir = "";

	beforeEach(async () => {
		resetSettingsForTest();
		resetDiscoveryCache();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-mcp-include-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-mcp-include-user-"));
		setAgentDir(userAgentDir);

		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					github: { command: "echo", args: ["github"] },
					"linear-work": { command: "echo", args: ["linear"] },
					"denylisted-server": { command: "echo", args: ["denylisted"] },
					"linear-off": { command: "echo", args: ["off"], enabled: false },
					unrelated: { command: "echo", args: ["unrelated"] },
				},
			}),
		);
		await fs.writeFile(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({ mcpServers: {}, disabledServers: ["denylisted-server"] }),
		);

		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("admits only glob matches, and the denylist and enabled:false still win", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, {
			includeServers: ["github", "linear-*", "denylisted-server"],
		});
		expect(Object.keys(configs).sort()).toEqual(["github", "linear-work"]);
	});

	test("an empty allowlist admits every enabled server", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, { includeServers: [] });
		expect(Object.keys(configs).sort()).toEqual(["github", "linear-work", "unrelated"]);
	});

	test("a direct connect (/mcp enable, /mcp add) of an excluded server never spawns it", async () => {
		const marker = path.join(projectDir, "spawned");
		const manager = new MCPManager(projectDir, null, async () => ({ configs: {}, sources: {}, exaApiKeys: [] }));
		await manager.discoverAndConnect({ includeServers: ["github"] });
		const result = await manager.connectServers(
			{ unrelated: { command: "/bin/sh", args: ["-c", `touch '${marker}'`] } },
			{},
		);
		await manager.disconnectAll();
		expect(result.errors.get("unrelated")).toContain("allowlist");
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});
