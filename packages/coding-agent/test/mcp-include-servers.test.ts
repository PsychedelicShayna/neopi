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
import { loadAllMCPConfigs, MCPUnknownServerError } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgMcpIncludeServers } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const MARKER_SERVER = path.join(import.meta.dir, "fixtures", "mcp-marker-server.ts");
const MARKER_SERVER_NAMES = ["github", "linear-work", "other"] as const;

/** A project whose three stdio servers each touch `<dir>/ran-<name>` when spawned. */
async function writeMarkerProject(dir: string): Promise<void> {
	const mcpServers = Object.fromEntries(
		MARKER_SERVER_NAMES.map(name => [
			name,
			{ command: process.execPath, args: [MARKER_SERVER, name, path.join(dir, `ran-${name}`)] },
		]),
	);
	await fs.mkdir(path.join(dir, ".omp"), { recursive: true });
	await fs.writeFile(path.join(dir, ".omp", "mcp.json"), JSON.stringify({ mcpServers }));
}

async function spawnedServers(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir);
	return entries
		.filter(entry => entry.startsWith("ran-"))
		.map(entry => entry.slice(4))
		.sort();
}

async function startSession(cwd: string, includeServers: readonly unknown[]): Promise<AgentSession> {
	// Wait for every connection instead of the default 250 ms startup window, so
	// slow CI spawns cannot race the tool assertions.
	const settings = Settings.isolated({ "mcp.startupTimeoutMs": 0 });
	if (includeServers.length > 0) cfgMcpIncludeServers.override(settings, includeServers as string[]);
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(cwd, "agent"),
		settings,
		agentRegistry: new AgentRegistry(),
		agentId: `mcp-allowlist-${path.basename(cwd)}`,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		hasUI: false,
	});
	return session;
}

async function mcpToolNamesWhenSettled(session: AgentSession, expectedCount: number): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const names = session
			.getAllToolNames()
			.filter(name => name.startsWith("mcp__"))
			.sort();
		if (names.length >= expectedCount || Date.now() > deadline) return names;
		await Bun.sleep(50);
	}
}

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

	test("a literal entry naming no available server is reported; a glob matching nothing is not", async () => {
		const { unmatchedIncludes } = await loadAllMCPConfigs(projectDir, {
			includeServers: ["github", "gihtub", "denylisted-server", "nothing-*"],
		});
		expect(unmatchedIncludes).toEqual(["gihtub", "denylisted-server"]);
	});

	test("createAgentSession rejects an unknown literal name before spawning any server", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "npi-mcp-unknown-"));
		try {
			await writeMarkerProject(cwd);
			const failure = await startSession(cwd, ["github", "gihtub"]).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(MCPUnknownServerError);
			expect((failure as MCPUnknownServerError).serverNames).toEqual(["gihtub"]);
			expect(await spawnedServers(cwd)).toEqual([]);
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("a malformed non-string allowlist entry fails closed instead of admitting everything", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "npi-mcp-malformed-"));
		try {
			await writeMarkerProject(cwd);
			const failure = await startSession(cwd, [1]).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(MCPUnknownServerError);
			expect((failure as MCPUnknownServerError).serverNames).toEqual(["1"]);
			expect(await spawnedServers(cwd)).toEqual([]);
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("concurrent SDK sessions keep independent allowlists and never spawn excluded servers", async () => {
		const [cwdA, cwdB, cwdC] = await Promise.all(
			["a", "b", "c"].map(label => fs.mkdtemp(path.join(os.tmpdir(), `npi-mcp-session-${label}-`))),
		);
		const sessions: AgentSession[] = [];
		try {
			await Promise.all([writeMarkerProject(cwdA), writeMarkerProject(cwdB), writeMarkerProject(cwdC)]);
			// allSettled: a rejected start must not orphan the sessions that did start.
			const started = await Promise.allSettled([
				startSession(cwdA, ["github", "linear-*"]),
				startSession(cwdB, ["oth*"]),
				startSession(cwdC, []),
			]);
			for (const outcome of started) if (outcome.status === "fulfilled") sessions.push(outcome.value);
			for (const outcome of started) if (outcome.status === "rejected") throw outcome.reason;
			const [toolsA, toolsB, toolsC] = await Promise.all([
				mcpToolNamesWhenSettled(sessions[0]!, 2),
				mcpToolNamesWhenSettled(sessions[1]!, 1),
				mcpToolNamesWhenSettled(sessions[2]!, 3),
			]);
			expect(toolsA).toEqual(["mcp__github_ping", "mcp__linear_work_ping"]);
			expect(toolsB).toEqual(["mcp__other_ping"]);
			expect(toolsC).toEqual(["mcp__github_ping", "mcp__linear_work_ping", "mcp__other_ping"]);
			expect(await spawnedServers(cwdA)).toEqual(["github", "linear-work"]);
			expect(await spawnedServers(cwdB)).toEqual(["other"]);
			expect(await spawnedServers(cwdC)).toEqual(["github", "linear-work", "other"]);
		} finally {
			await Promise.all(sessions.map(session => session.dispose()));
			await Promise.all([cwdA, cwdB, cwdC].map(dir => removeWithRetries(dir)));
		}
	});
});
