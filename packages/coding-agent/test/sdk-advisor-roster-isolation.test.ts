import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AdvisorConfig } from "@oh-my-pi/pi-coding-agent/advisor/config";
import { cfgAdvisorEnabled, cfgAdvisorMaxNotesPerUpdate } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const FLEET_SENTINEL = "fleet-shared-instructions-must-not-reach-private-advisors";
const PRIVATE_SENTINEL = "private-sol-advisor-instructions";
const MODEL_SELECTOR = "openai-codex/gpt-6.1-sol";

let dir: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	const scratch = path.join(os.homedir(), ".cache/npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	dir = await fs.mkdtemp(path.join(scratch, "sdk-advisor-roster-"));
	cwd = path.join(dir, "project");
	agentDir = path.join(dir, "profile");
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(
		path.join(cwd, "WATCHDOG.yml"),
		`enabled: not-a-boolean\ninstructions: ${FLEET_SENTINEL}\nmaxNotesPerUpdate: 7\nadvisors:\n  - name: Fleet reviewer\n  - name: Other fleet reviewer\n`,
	);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("SDK advisor roster isolation", () => {
	it.each(["private", "empty", "discovery"] as const)(
		"%s roster keeps only its own shared instructions, budget and warnings",
		async mode => {
			const settings = Settings.isolated({});
			cfgAdvisorEnabled.set(settings, true);
			cfgAdvisorMaxNotesPerUpdate.set(settings, 2);
			settings.setModelRole("advisor", MODEL_SELECTOR);
			const model = getBundledModel("openai-codex", "gpt-6.1-sol");
			const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.keys.setRuntime(model.provider, "test-key");
			const advisorConfigs: AdvisorConfig[] | undefined =
				mode === "discovery"
					? undefined
					: mode === "empty"
						? []
						: [{ name: "Private Sol", model: MODEL_SELECTOR, instructions: PRIVATE_SENTINEL }];
			try {
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					settings,
					model,
					modelRegistry: new ModelRegistry(authStorage, path.join(agentDir, "models.json")),
					sessionManager: SessionManager.inMemory(cwd),
					advisorConfigs,
					disableExtensionDiscovery: true,
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					toolNames: [],
					restrictToolNames: true,
					skipPythonPreflight: true,
				});
				try {
					const advisors = session.liveAdvisors();
					const prompts = advisors.map(advisor => advisor.agent.state.systemPrompt.join("\n"));
					if (mode === "discovery") {
						expect(advisors.map(advisor => advisor.name)).toEqual(["Fleet reviewer", "Other fleet reviewer"]);
						for (const prompt of prompts) {
							expect(prompt).toContain(FLEET_SENTINEL);
							expect(prompt).toContain("max 7 non-blockers/update");
							expect(prompt).not.toContain(PRIVATE_SENTINEL);
						}
						expect(session.getAdvisorConfigWarnings()).toEqual([
							expect.stringContaining("enabled must be a boolean"),
						]);
					} else {
						expect(prompts.join("\n")).not.toContain(FLEET_SENTINEL);
						expect(session.getAdvisorConfigWarnings()).toEqual([]);
						if (mode === "empty") {
							expect(advisors).toEqual([]);
							expect(session.getAdvisorAgent()).toBeUndefined();
							expect(session.isAdvisorActive()).toBe(false);
						} else {
							expect(advisors.map(advisor => advisor.name)).toEqual(["Private Sol"]);
							expect(advisors[0].agent.state.model?.id).toBe("gpt-6.1-sol");
							expect(prompts[0]).toContain(PRIVATE_SENTINEL);
							expect(prompts[0]).toContain("max 2 non-blockers/update");
						}
					}
				} finally {
					await session.dispose();
				}
			} finally {
				authStorage.close();
			}
		},
	);
});
