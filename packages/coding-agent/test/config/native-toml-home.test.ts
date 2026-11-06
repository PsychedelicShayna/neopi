import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const sourceRoot = path.resolve(import.meta.dir, "../../src");
const importSource = (relative: string) => JSON.stringify(path.join(sourceRoot, relative));
const childProgram = `
import { getAgentDir } from ${JSON.stringify(path.resolve(sourceRoot, "../../utils/src/index.ts"))};
import { Settings } from ${importSource("config/settings.ts")};
import { createSettingsHost } from ${importSource("config/settings-ui.ts")};
import { ModelRegistry } from ${importSource("config/model-registry.ts")};
import { AuthStorage } from ${importSource("session/auth-storage.ts")};
globalThis.fetch = async () => { throw new Error("Network is forbidden in the isolated TOML home test"); };
const agentDir = getAgentDir();
const settings = await Settings.loadIsolated({ cwd: process.cwd(), agentDir });
const selected = settings.getModelRole("default");
await settings.persistWithReceipt(() => createSettingsHost(settings).set("temperature", 0.6));
await settings.reloadFromDisk();
const auth = await AuthStorage.create(":memory:");
try {
  const registry = new ModelRegistry(auth);
  const entry = registry.modelConfig.list().find(entry => entry.provider === "toml-home-fixture" && entry.id === "fixture");
  if (!entry) throw new Error("The isolated home model was not loaded");
  await registry.modelConfig.save({ ...entry, fields: { ...entry.fields, name: "Saved through the native model editor" } }, entry);
  const reloaded = new ModelRegistry(auth);
  process.stdout.write(JSON.stringify({
    selected,
    temperature: createSettingsHost(settings).get("temperature"),
    modelsPath: registry.getConfigFile(),
    saved: reloaded.getAll().some(model => model.provider === "toml-home-fixture" && model.id === "fixture" && model.name === "Saved through the native model editor"),
  }));
} finally { auth.close(); }
`;

let root: string;
let home: string;
let agentDir: string;
let project: string;
beforeEach(async () => {
	const scratch = "/mnt/alias/m2/agents/scratch/neopi-native-toml-home";
	await fs.mkdir(scratch, { recursive: true });
	root = await fs.mkdtemp(path.join(scratch, "home-"));
	home = path.join(root, "home");
	agentDir = path.join(home, ".omp", "agent");
	project = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(project, ".omp"), { recursive: true });
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function runHome() {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		NO_COLOR: "1",
		XDG_CACHE_HOME: path.join(home, ".cache"),
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
	};
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"OMP_AUTH_BROKER_URL",
		"OMP_AUTH_BROKER_TOKEN",
	])
		delete env[key];
	const child = Bun.spawn([process.execPath, "--eval", childProgram], {
		cwd: project,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as { selected: string; temperature: number; modelsPath: string; saved: boolean };
}

const modelsToml = `# model owner notes
[providers.toml-home-fixture]
baseUrl = "http://127.0.0.1:1/v1"
api = "openai-completions"
auth = "none"
[[providers.toml-home-fixture.models]]
id = "fixture"
name = "Fixture" # keep model annotation
contextWindow = 8192
maxTokens = 1024
input = ["text"]
`;
const modelsYaml = `providers:
  toml-home-fixture:
    baseUrl: http://127.0.0.1:1/v1
    api: openai-completions
    auth: none
    models:
      - id: fixture
        name: Fixture
        contextWindow: 8192
        maxTokens: 1024
        input: [text]
`;

describe("native settings and models in an isolated HOME", () => {
	it("loads and saves both editors with only TOML present, including project scope", async () => {
		await Bun.write(
			path.join(agentDir, "config.toml"),
			'# owner settings\ntemperature = 0.2 # keep preference annotation\n[modelRoles]\ndefault = "toml-home-fixture/global"\n',
		);
		await Bun.write(
			path.join(project, ".omp", "config.toml"),
			'[modelRoles]\ndefault = "toml-home-fixture/fixture"\n',
		);
		await Bun.write(path.join(agentDir, "models.toml"), modelsToml);
		const result = await runHome();
		expect(result).toEqual({
			selected: "toml-home-fixture/fixture",
			temperature: 0.6,
			modelsPath: path.join(agentDir, "models.toml"),
			saved: true,
		});
		const config = await Bun.file(path.join(agentDir, "config.toml")).text();
		const models = await Bun.file(path.join(agentDir, "models.toml")).text();
		expect(config).toContain("# owner settings");
		expect(config).toContain("# keep preference annotation");
		expect(models).toContain("# model owner notes");
		expect(models).toContain("# keep model annotation");
		for (const filename of ["config.yml", "config.yaml", "models.yml", "models.yaml"]) {
			expect(await Bun.file(path.join(agentDir, filename)).exists()).toBe(false);
		}
	}, 30_000);

	it("imports a legacy home once without modifying YAML and subsequently ignores legacy edits", async () => {
		const configPath = path.join(agentDir, "config.yml");
		const modelsPath = path.join(agentDir, "models.yml");
		const yaml = "temperature: 0.2\nmodelRoles:\n  default: toml-home-fixture/fixture\n";
		await Bun.write(configPath, yaml);
		await Bun.write(modelsPath, modelsYaml);
		await fs.chmod(configPath, 0o640);
		await fs.chmod(modelsPath, 0o600);
		expect((await runHome()).saved).toBe(true);
		expect(await Bun.file(configPath).text()).toBe(yaml);
		expect(await Bun.file(modelsPath).text()).toBe(modelsYaml);
		expect((await fs.stat(path.join(agentDir, "config.toml"))).mode & 0o777).toBe(0o640);
		expect((await fs.stat(path.join(agentDir, "models.toml"))).mode & 0o777).toBe(0o600);
		await Bun.write(configPath, "modelRoles:\n  default: stale/yaml\n");
		await Bun.write(modelsPath, "invalid: [legacy\n");
		const second = await runHome();
		expect(second.selected).toBe("toml-home-fixture/fixture");
		expect(second.saved).toBe(true);
		expect(await Bun.file(modelsPath).text()).toBe("invalid: [legacy\n");
	}, 30_000);
});
