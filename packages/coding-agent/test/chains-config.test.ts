import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChainsConfigDoc } from "@oh-my-pi/pi-tui/overlays/chain-types";
import { chainsConfigFilePath, discoverChains, loadChainsConfigFile, saveChainsConfigFile } from "../src/chains/config";
import { enabledChainSteps } from "../src/chains/runner";

describe("post-processing chain config", () => {
	let root = "";
	let agentDir = "";
	let project = "";

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "neopi-chains-"));
		agentDir = path.join(root, "agent");
		project = path.join(root, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("round-trips a chain with multiline prompts, models, tools, context, and system prompts through CHAINS.toml", async () => {
		const file = chainsConfigFilePath("user", { projectDir: project, agentDir });
		const doc = {
			chains: [
				{
					name: "decompose",
					description: "Vague request to concrete steps",
					steps: [
						{
							name: "names",
							model: "xai-oauth/grok-4.7:low",
							tools: ["bash"],
							context: true,
							systemPrompt: "You rewrite drafts.\nOutput only the draft.\n",
							prompt: "Fix name spellings.\nKeep everything else.",
						},
						{ name: "tighten", prompt: "Rewrite as numbered instructions.\n\n  Indented: keep.\n" },
					],
				},
			],
		};
		await saveChainsConfigFile(file, doc);
		const loaded = await loadChainsConfigFile(file);
		expect(loaded).toEqual(doc);
		const [withContext, plain] = loaded.chains[0]!.steps;
		expect(withContext!.context).toBe(true);
		expect(withContext!.systemPrompt).toBe("You rewrite drafts.\nOutput only the draft.\n");
		expect(plain!.context).toBeUndefined();
		expect(plain!.systemPrompt).toBeUndefined();
	});

	it("keeps an explicitly empty system prompt instead of restoring the bundled one", async () => {
		const file = chainsConfigFilePath("user", { projectDir: project, agentDir });
		await saveChainsConfigFile(file, {
			chains: [{ name: "bare", steps: [{ name: "raw", systemPrompt: "", prompt: "Rewrite." }] }],
		});
		const loaded = await loadChainsConfigFile(file);
		expect(loaded.chains[0]!.steps[0]!.systemPrompt).toBe("");
	});

	it("keeps a disabled step's prompt, model, and position across save, reload, and re-enable", async () => {
		const file = chainsConfigFilePath("project", { projectDir: project, agentDir });
		const doc: ChainsConfigDoc = {
			chains: [
				{
					name: "polish",
					steps: [
						{ name: "tighten", prompt: "Cut the slop." },
						{
							name: "names",
							enabled: false,
							model: "xai-oauth/grok-4.7:low",
							context: true,
							prompt: "Fix name spellings.\nKeep everything else.",
						},
						{ name: "format", prompt: "Wrap at 80." },
					],
				},
			],
		};
		await saveChainsConfigFile(file, doc);
		expect(await loadChainsConfigFile(file)).toEqual(doc);

		// A fresh discovery is what a restarted session sees.
		const { chains } = await discoverChains(project, agentDir);
		expect(chains[0]!.steps).toEqual(doc.chains[0]!.steps);
		expect(enabledChainSteps(chains[0]!).map(step => step.name)).toEqual(["tighten", "format"]);

		const reenabled = structuredClone(doc);
		delete reenabled.chains[0]!.steps[1]!.enabled;
		await saveChainsConfigFile(file, reenabled);
		const loaded = await loadChainsConfigFile(file);
		expect(loaded).toEqual(reenabled);
		expect(Object.hasOwn(loaded.chains[0]!.steps[1]!, "enabled")).toBe(false);
		expect(enabledChainSteps(loaded.chains[0]!).map(step => step.name)).toEqual(["tighten", "names", "format"]);
	});

	it("loads steps stored without an enabled key as enabled and keeps a chain whose steps are all off", async () => {
		await Bun.write(
			path.join(project, "CHAINS.toml"),
			[
				"[[chains]]",
				'name = "legacy"',
				"[[chains.steps]]",
				'name = "one"',
				'prompt = "first"',
				"[[chains.steps]]",
				'name = "two"',
				"enabled = true",
				'prompt = "second"',
				"[[chains]]",
				'name = "parked"',
				"[[chains.steps]]",
				'name = "only"',
				"enabled = false",
				'prompt = "kept"',
			].join("\n"),
		);

		const { chains, warnings } = await discoverChains(project, agentDir);

		expect(warnings).toEqual([]);
		expect(chains[0]!.steps).toEqual([
			{ name: "one", prompt: "first" },
			{ name: "two", prompt: "second" },
		]);
		expect(enabledChainSteps(chains[0]!)).toHaveLength(2);
		expect(chains[1]!.steps).toEqual([{ name: "only", enabled: false, prompt: "kept" }]);
		expect(enabledChainSteps(chains[1]!)).toEqual([]);
	});

	it("lets a project chain shadow a user chain by name and drops invalid entries with warnings", async () => {
		await Bun.write(
			path.join(agentDir, "CHAINS.toml"),
			[
				"[[chains]]",
				'name = "concise"',
				"[[chains.steps]]",
				'name = "user-step"',
				'prompt = "user version"',
				"[[chains]]",
				'name = "lewd"',
				"[[chains.steps]]",
				'name = "scene"',
				'prompt = "keep the scene"',
				"[[chains]]",
				'name = "broken"',
				"[[chains.steps]]",
				'name = "no-prompt"',
			].join("\n"),
		);
		await Bun.write(
			path.join(project, "CHAINS.toml"),
			[
				"[[chains]]",
				'name = "concise"',
				"[[chains.steps]]",
				'name = "project-step"',
				'tools = ["bash", "not_a_tool"]',
				'prompt = "project version"',
			].join("\n"),
		);

		const { chains, warnings } = await discoverChains(project, agentDir);

		expect(chains.map(chain => [chain.name, chain.steps.map(step => step.name)])).toEqual([
			["concise", ["project-step"]],
			["lewd", ["scene"]],
		]);
		expect(chains[0]!.steps[0]!.tools).toEqual(["bash"]);
		expect(warnings.some(warning => warning.includes("not_a_tool"))).toBe(true);
		expect(warnings.some(warning => warning.includes("broken"))).toBe(true);
	});

	it("removes the file when the last chain is deleted", async () => {
		const file = chainsConfigFilePath("project", { projectDir: project, agentDir });
		await saveChainsConfigFile(file, { chains: [{ name: "one", steps: [{ name: "s", prompt: "p" }] }] });
		await saveChainsConfigFile(file, { chains: [] });
		expect(await Bun.file(file).exists()).toBe(false);
	});
});
