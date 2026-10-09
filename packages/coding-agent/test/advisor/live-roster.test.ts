import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Live advisor roster did not update");
		await Bun.sleep(20);
	}
}

describe("live WATCHDOG.yml roster", () => {
	let temp: TempDir;
	let session: AgentSession;
	let auth: AuthStorage;
	let cwd: string;

	async function start(enabled: boolean): Promise<void> {
		temp = TempDir.createSync("@watchdog-live-");
		cwd = temp.join("project");
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
		const settings = Settings.isolated({ "async.enabled": false, "advisor.enabled": enabled });
		settings.setModelRole("advisor", "openai/gpt-4o-mini");
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Bundled advisor model missing");
		const result = await createAgentSession({
			cwd,
			agentDir: temp.join("user-agent"),
			sessionManager: SessionManager.inMemory(cwd),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;
	}

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		auth?.close();
		await temp?.remove();
	});

	const names = () => session.getAdvisorStatusOverview().advisors.map(advisor => [advisor.name, advisor.status]);

	it("adds, changes, disables and removes entries without rebuilding unchanged advisors", async () => {
		await start(true);
		const alpha = session.getAdvisorAgent();
		if (!alpha) throw new Error("Expected default advisor");
		const file = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Alpha\n  - name: Beta\n");
		await until(() => names().some(([name]) => name === "Beta"));
		const configuredAlpha = session.getAdvisorAgent();
		expect(configuredAlpha).not.toBe(alpha);
		expect(names()).toEqual([
			["Alpha", "running"],
			["Beta", "running"],
		]);

		await Bun.write(file, "advisors:\n  - name: Alpha\n  - name: Beta\n  - name: Gamma\n");
		await until(() => names().length === 3);
		expect(session.getAdvisorAgent()).toBe(configuredAlpha);

		await Bun.write(
			file,
			"advisors:\n  - name: Alpha\n    instructions: Check diffs.\n  - name: Beta\n    enabled: false\n",
		);
		await until(() => names().some(([name, status]) => name === "Beta" && status === "paused"));
		expect(session.getAdvisorAgent()).not.toBe(configuredAlpha);
		expect(names()).toEqual([
			["Alpha", "running"],
			["Beta", "paused"],
		]);

		await fs.rm(file);
		await until(() => !names().some(([name]) => name === "Alpha"));
		expect(session.getAdvisorAgent()).not.toBe(configuredAlpha);
	});

	it("keeps a valid live roster on invalid YAML then detects atomic rename and new .omp directory", async () => {
		await start(true);
		const file = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Alpha\n");
		await until(() => names().some(([name]) => name === "Alpha"));
		const alpha = session.getAdvisorAgent();
		const warn = vi.spyOn(logger, "warn");
		await Bun.write(file, "advisors: [not closed\n");
		await until(() => warn.mock.calls.some(([message]) => message === "Advisor config"));
		expect(session.getAdvisorAgent()).toBe(alpha);
		expect(names()).toEqual([["Alpha", "running"]]);

		const staged = path.join(cwd, "WATCHDOG.yml.tmp");
		await Bun.write(staged, "advisors:\n  - name: Alpha\n  - name: Atomic\n");
		await fs.rename(staged, file);
		await until(() => names().some(([name]) => name === "Atomic"));
		expect(session.getAdvisorAgent()).toBe(alpha);

		await Bun.write(file, "advisors:\n  - name: Alpha\n  - name: Invalid\n    enabled: yes\n");
		await until(() =>
			warn.mock.calls.some(([, context]) => typeof context?.error === "string" && context.error.includes("Invalid")),
		);
		await until(() => !names().some(([name]) => name === "Atomic"));
		expect(session.getAdvisorAgent()).toBe(alpha);

		await fs.rm(file);
		const nested = path.join(cwd, ".omp");
		await fs.mkdir(nested);
		await Bun.write(path.join(nested, "WATCHDOG.yaml"), "advisors:\n  - name: Native\n");
		await until(() => names().some(([name]) => name === "Native"));
		expect(names()).toEqual([["Native", "running"]]);
	});

	it("watches the user roster and preserves project overrides when a user entry changes", async () => {
		await start(true);
		const userFile = temp.join("user-agent", "WATCHDOG.yaml");
		await Bun.write(userFile, "advisors:\n  - name: Shared\n    instructions: User version.\n");
		await until(() => names().some(([name]) => name === "Shared"));

		await Bun.write(
			path.join(cwd, "WATCHDOG.yml"),
			"advisors:\n  - name: Shared\n    instructions: Project version.\n",
		);
		await until(() => session.getAdvisorAgent() !== undefined && names().length === 1);
		// Let the project override complete before asserting identity across a
		// later user-level edit. The project advisor's prompt carries its text.
		await until(() => session.getAdvisorAgent()?.state.systemPrompt?.includes("Project version.") === true);
		const projectAdvisor = session.getAdvisorAgent();

		await Bun.write(
			userFile,
			"advisors:\n  - name: Shared\n    instructions: Changed user version.\n  - name: UserOnly\n",
		);
		await until(() => names().some(([name]) => name === "UserOnly"));
		expect(session.getAdvisorAgent()).toBe(projectAdvisor);
		expect(names()).toEqual([
			["Shared", "running"],
			["UserOnly", "running"],
		]);
	});

	it("stores changes while disabled and starts the discovered roster only after enable", async () => {
		await start(false);
		const file = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Off\n");
		await Bun.sleep(250);
		expect(session.isAdvisorEnabled()).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
		await Bun.write(file, "advisors:\n  - name: Later\n");
		await Bun.sleep(250);
		expect(session.isAdvisorActive()).toBe(false);
		session.toggleAdvisorEnabled();
		expect(names()).toEqual([["Later", "running"]]);
	});
});
