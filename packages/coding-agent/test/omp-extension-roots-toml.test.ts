import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@oh-my-pi/pi-utils";
import { listOmpExtensionRoots, withOmpExtensionRootScope } from "../src/discovery/omp-extension-roots";
import * as plugins from "../src/extensibility/plugins/loader";

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-extension-roots-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "project");
	await fs.mkdir(path.join(cwd, "extension"), { recursive: true });
	vi.spyOn(utils, "getAgentDir").mockReturnValue(agentDir);
	vi.spyOn(plugins, "getEnabledPlugins").mockResolvedValue([]);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});
function roots() {
	return withOmpExtensionRootScope([], "merge", () => listOmpExtensionRoots({ cwd, home: root, repoRoot: null }));
}
for (const scope of ["user", "project"] as const) {
	for (const filename of ["config.toml", "settings.toml"]) {
		test(`${scope} ${filename} supplies TOML-only extension roots`, async () => {
			const directory = scope === "user" ? agentDir : path.join(cwd, ".omp");
			await Bun.write(path.join(directory, filename), 'extensions = ["./extension"]\n');
			expect(await roots()).toEqual([{ path: path.join(cwd, "extension"), name: "extension", level: scope }]);
		});
	}
	test(`${scope} TOML explicit null and empty array hide YAML and legacy roots`, async () => {
		const directory = scope === "user" ? agentDir : path.join(cwd, ".omp");
		await Bun.write(path.join(agentDir, "config.yml"), 'extensions: ["./extension"]\n');
		await Bun.write(path.join(directory, "config.yml"), 'extensions: ["./extension"]\n');
		await Bun.write(path.join(directory, "settings.json"), '{"extensions":["./extension"]}');
		for (const content of ["extensions = []\n", '[__npi]\nversion = 1\nnull_paths = ["/extensions"]\n']) {
			await Bun.write(path.join(directory, "config.toml"), content);
			expect(await roots()).toEqual([]);
		}
	});
	test(`${scope} invalid TOML rejects instead of returning stale YAML roots`, async () => {
		const directory = scope === "user" ? agentDir : path.join(cwd, ".omp");
		await Bun.write(path.join(directory, "config.yml"), 'extensions: ["./extension"]\n');
		await Bun.write(path.join(directory, "config.toml"), "broken = [");
		await expect(roots()).rejects.toThrow("config.toml");
	});
	test(`${scope} YAML-only extension roots import once and keep their scope`, async () => {
		const directory = scope === "user" ? agentDir : path.join(cwd, ".omp");
		await Bun.write(path.join(directory, "config.yml"), 'extensions: ["./extension"]\n');
		expect(await roots()).toEqual([{ path: path.join(cwd, "extension"), name: "extension", level: scope }]);
		expect(await Bun.file(path.join(directory, "config.toml")).exists()).toBe(true);
		await Bun.write(path.join(directory, "config.yml"), "extensions: []\n");
		expect(await roots()).toEqual([{ path: path.join(cwd, "extension"), name: "extension", level: scope }]);
	});
}
