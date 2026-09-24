import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chainsConfigFilePath, discoverChains, loadChainsConfigFile, saveChainsConfigFile } from "../src/chains/config";

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

	it("round-trips a chain with multiline prompts, models, tools, context, and system prompts through CHAINS.yml", async () => {
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

	it("lets a project chain shadow a user chain by name and drops invalid entries with warnings", async () => {
		await Bun.write(
			path.join(agentDir, "CHAINS.yml"),
			[
				"chains:",
				"  - name: concise",
				"    steps:",
				"      - name: user-step",
				"        prompt: user version",
				"  - name: lewd",
				"    steps:",
				"      - name: scene",
				"        prompt: keep the scene",
				"  - name: broken",
				"    steps:",
				"      - name: no-prompt",
			].join("\n"),
		);
		await Bun.write(
			path.join(project, "CHAINS.yml"),
			[
				"chains:",
				"  - name: concise",
				"    steps:",
				"      - name: project-step",
				"        tools: [bash, not_a_tool]",
				"        prompt: project version",
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
