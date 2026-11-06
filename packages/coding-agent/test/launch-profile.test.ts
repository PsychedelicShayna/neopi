import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { getSessionLaunchProfile, loadLaunchProfileMemory } from "@oh-my-pi/pi-coding-agent/neopi/launch-profile";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-lifecycle";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("launch profile memory", () => {
	let temp: TempDir;
	let state: SettingsTestState;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let settings: Settings;

	beforeEach(async () => {
		state = beginSettingsTest();
		temp = TempDir.createSync("@npi-launch-profile-");
		vi.spyOn(dirs, "getAgentDir").mockReturnValue(temp.path());
		vi.spyOn(dirs, "getActiveProfile").mockReturnValue(undefined);
		settings = await Settings.init({
			cwd: temp.path(),
			agentDir: temp.path(),
			overrides: { "memory.backend": "off" },
		});
		auth = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(auth, temp.join("models.toml"));
	});

	afterEach(async () => {
		auth?.close();
		AgentStorage.close();
		restoreSettingsTestState(state);
		await temp.remove();
	});

	async function startup(argv: string[] = []): Promise<CreateAgentSessionOptions> {
		return buildSessionOptions(parseArgs(["--cwd", temp.path(), ...argv]), [], undefined, registry, settings);
	}
	async function inspect(session: AgentSession): Promise<string[]> {
		const output: string[] = [];
		const handler = BUILTIN_LIFECYCLE_SLASH_COMMANDS.find(command => command.name === "launch-profile")?.handle;
		if (!handler) throw new Error("Missing launch profile inspection command");
		await handler(
			{ name: "launch-profile", args: "", text: "launch-profile" },
			{
				session,
				sessionManager: session.sessionManager,
				settings,
				cwd: temp.path(),
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);
		return output;
	}

	async function open(options: CreateAgentSessionOptions) {
		return createAgentSession({
			...options,
			cwd: temp.path(),
			agentDir: temp.path(),
			settings,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(temp.path()),
			workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			bindProcessState: false,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
		});
	}

	it("keeps real Settings.init and startup unchanged without a profile, even with a broken manifest", async () => {
		const baseline = await startup();
		const { session: first } = await open(baseline);
		const originalPrompt = [...first.systemPrompt];
		await first.dispose();

		await Bun.write(temp.join("launch-memory.json"), "invalid json");
		const options = await startup();
		expect(options).toEqual(baseline);
		expect(options).not.toHaveProperty("launchProfileMemory");
		const { session } = await open(options);
		try {
			expect(session.systemPrompt).toEqual(originalPrompt);
			expect(getSessionLaunchProfile(session)).toBeUndefined();
			expect(await inspect(session)).toEqual(["No launch profile memory was preloaded."]);
			expect(
				session.sessionManager
					.getEntries()
					.some(entry => entry.type === "custom" && entry.customType === "launch-profile"),
			).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("leaves existing named profiles unchanged until they save a memory manifest", async () => {
		vi.spyOn(dirs, "getActiveProfile").mockReturnValue("existing");
		expect(await startup()).not.toHaveProperty("launchProfileMemory");
	});

	it("preloads only the selected profile sources before the first turn and exposes the exact snapshot", async () => {
		for (const [name, memory] of [
			["work", "Client <ACME> prefers concise updates & explicit dates."],
			["personal", "My garden contains tulips."],
		]) {
			const agentDir = temp.join(name);
			await Bun.write(path.join(agentDir, "memory.md"), memory);
			await Bun.write(path.join(agentDir, "launch-memory.json"), JSON.stringify({ sources: ["memory.md"] }));
		}
		for (const name of ["work", "personal"]) {
			const bootstrap = extractProfileFlags(["--profile", name]);
			vi.spyOn(dirs, "getActiveProfile").mockReturnValue(bootstrap.profile);
			vi.spyOn(dirs, "getAgentDir").mockReturnValue(temp.join(name));
			const options = await startup(bootstrap.argv);
			expect(options.launchProfileMemory?.name).toBe(name);
			const { session } = await open(options);
			try {
				const wirePrompt = session.systemPrompt.join("\n\n");
				const chosen =
					name === "work"
						? "Client <ACME> prefers concise updates & explicit dates."
						: "My garden contains tulips.";
				const other = name === "work" ? "My garden contains tulips." : "Client <ACME>";
				expect(wirePrompt).toContain(chosen);
				expect(wirePrompt).not.toContain(other);
				expect(session.messages).toHaveLength(0);
				expect(getSessionLaunchProfile(session)).toContain(`Launch profile: ${name}`);
				expect(getSessionLaunchProfile(session)).toContain(chosen);
				const snapshot = session.sessionManager
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "launch-profile");
				expect(snapshot?.type === "custom" ? snapshot.data : undefined).toBe(getSessionLaunchProfile(session));
				// Inspection reads the launch snapshot, not a later edit to the source file.
				await Bun.write(temp.join(name, "memory.md"), "Changed after launch");
				expect(getSessionLaunchProfile(session)).toContain(chosen);
				expect(await inspect(session)).toEqual([getSessionLaunchProfile(session)!]);
			} finally {
				await session.dispose();
			}
		}
	});

	it("retains append prompts and explicitly selected memory in chat mode", async () => {
		vi.spyOn(dirs, "getActiveProfile").mockReturnValue("chat");
		await Bun.write(temp.join("launch-memory.json"), JSON.stringify({ sources: ["memory.md"] }));
		await Bun.write(temp.join("memory.md"), "Remember my chosen working context.");
		const { session } = await open(
			await startup(["--chat", "chat", "--append-system-prompt", "Keep this explicit append."]),
		);
		try {
			expect(session.systemPrompt.join("\n")).toContain("Remember my chosen working context.");
			expect(session.systemPrompt.join("\n")).toContain("Keep this explicit append.");
		} finally {
			await session.dispose();
		}
	});

	it("fails an explicitly selected invalid manifest or unreadable source instead of silently dropping memory", async () => {
		vi.spyOn(dirs, "getActiveProfile").mockReturnValue("work");
		await Bun.write(temp.join("launch-memory.json"), JSON.stringify({ sources: [42] }));
		await expect(startup()).rejects.toThrow("Invalid launch profile memory manifest");
		await Bun.write(temp.join("launch-memory.json"), JSON.stringify({ sources: ["missing.md"] }));
		await expect(startup()).rejects.toThrow('Cannot preload launch profile "work" memory source');
		await Bun.write(temp.join("launch-memory.json"), "broken json");
		await expect(startup()).rejects.toThrow("Cannot load launch profile memory manifest");
	});

	it("allows an empty selection and resolves external persistent files relative to the manifest", async () => {
		await Bun.write(temp.join("launch-memory.json"), JSON.stringify({ sources: [] }));
		expect(await loadLaunchProfileMemory("empty", temp.path())).toEqual({ name: "empty", sources: [] });
		await Bun.write(temp.join("shared.md"), "Shared memory");
		await Bun.write(temp.join("work", "launch-memory.json"), JSON.stringify({ sources: ["../shared.md"] }));
		expect((await loadLaunchProfileMemory("work", temp.join("work")))?.sources).toEqual([
			{ path: temp.join("shared.md"), content: "Shared memory" },
		]);
	});
});
