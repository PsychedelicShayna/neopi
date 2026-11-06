import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettingsToml, stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { discoverChains, loadChainsConfigFile, saveChainsConfigFile } from "../src/chains/config";
import { loadSecrets } from "../src/secrets";

describe("native owned configuration import", () => {
	let root: string;
	let project: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-owned-toml-"));
		project = path.join(root, "project");
		agentDir = path.join(root, "agent");
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(path.join(project, ".omp"), { recursive: true });
		await fs.mkdir(agentDir);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("imports chains once with the legacy mode and leaves YAML byte-identical", async () => {
		const legacy = path.join(agentDir, "CHAINS.yml");
		const target = path.join(agentDir, "CHAINS.toml");
		const yaml =
			"# retained legacy source\nchains:\n  - name: Rewrite\n    steps:\n      - name: Polish\n        prompt: Improve clarity\n        systemPrompt: ''\n        enabled: false\n";
		await Bun.write(legacy, yaml);
		await fs.chmod(legacy, 0o640);

		const doc = await loadChainsConfigFile(target);
		expect(doc.chains).toEqual([
			{ name: "Rewrite", steps: [{ name: "Polish", prompt: "Improve clarity", systemPrompt: "", enabled: false }] },
		]);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
		expect(await Bun.file(legacy).text()).toBe(yaml);
		expect(parseSettingsToml(await Bun.file(target).text()).chains).toEqual(doc.chains);
		expect(await Bun.file(target).text()).toContain("# retained legacy source");

		await Bun.write(legacy, "chains:\n  - name: Ignored\n    steps: []\n");
		expect((await loadChainsConfigFile(target)).chains).toEqual(doc.chains);
	});

	it("patches chain and step TOML comments and future fields", async () => {
		const target = path.join(project, "CHAINS.toml");
		await Bun.write(
			target,
			'# root comment\nfuture = "keep"\n\n[[chains]] # chain comment\nname = "Rewrite"\nfutureChain = 7\n\n[[chains.steps]] # step comment\nname = "Polish"\nprompt = "old" # prompt comment\nfutureStep = true\n',
		);
		const doc = await loadChainsConfigFile(target);
		doc.chains[0]!.steps[0]!.prompt = "new\nparagraph";
		await saveChainsConfigFile(target, doc);
		const saved = await Bun.file(target).text();
		for (const comment of ["# root comment", "# chain comment", "# step comment", "# prompt comment"]) {
			expect(saved).toContain(comment);
		}
		expect(parseSettingsToml(saved)).toEqual({
			future: "keep",
			chains: [
				{
					name: "Rewrite",
					futureChain: 7,
					steps: [{ name: "Polish", prompt: "new\nparagraph", futureStep: true }],
				},
			],
		});
	});

	it("preserves chain scopes and project shadowing after import", async () => {
		await Bun.write(
			path.join(agentDir, "CHAINS.yaml"),
			"chains:\n  - name: Shared\n    steps:\n      - name: User\n        prompt: user\n",
		);
		await Bun.write(
			path.join(project, "CHAINS.toml"),
			stringifySettingsToml({ chains: [{ name: "Shared", steps: [{ name: "Project", prompt: "project" }] }] }),
		);
		const discovered = await discoverChains(project, agentDir);
		expect(discovered.chains).toEqual([{ name: "Shared", steps: [{ name: "Project", prompt: "project" }] }]);
		expect(await Bun.file(path.join(agentDir, "CHAINS.toml")).exists()).toBe(true);
	});

	it("imports root-array secrets without changing source permissions or redaction metadata", async () => {
		const legacy = path.join(agentDir, "secrets.yml");
		const yaml =
			"- type: plain\n  content: private-user-token\n  friendlyName: User Token\n- type: regex\n  content: 'secret_[a-z]+'\n  flags: i\n  mode: replace\n  replacement: '[hidden]'\n";
		await Bun.write(legacy, yaml);
		await fs.chmod(legacy, 0o600);
		const entries = await loadSecrets(project, agentDir);
		expect(entries).toMatchObject([
			{ type: "plain", content: "private-user-token", friendlyName: "User Token", mode: "obfuscate" },
			{ type: "regex", content: "secret_[a-z]+", flags: "i", mode: "replace", replacement: "[hidden]" },
		]);
		const target = path.join(agentDir, "secrets.toml");
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect(await Bun.file(legacy).text()).toBe(yaml);
		expect(parseSettingsToml(await Bun.file(target).text()).secrets).toHaveLength(2);
	});

	it("uses TOML secrets only and keeps project content overrides", async () => {
		await Bun.write(
			path.join(agentDir, "secrets.toml"),
			stringifySettingsToml({
				secrets: [{ type: "plain", content: "shared-secret-value", friendlyName: "Global" }],
			}),
		);
		await Bun.write(path.join(agentDir, "secrets.yml"), "not valid: [legacy\n");
		await Bun.write(
			path.join(project, ".omp", "secrets.toml"),
			stringifySettingsToml({
				secrets: [
					{
						type: "plain",
						content: "shared-secret-value",
						friendlyName: "Project",
						mode: "replace",
						replacement: "hidden",
					},
				],
			}),
		);
		expect(await loadSecrets(project, agentDir)).toMatchObject([
			{ content: "shared-secret-value", friendlyName: "Project", mode: "replace", replacement: "hidden" },
		]);
	});
});
