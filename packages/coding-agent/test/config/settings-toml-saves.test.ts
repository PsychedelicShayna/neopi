import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { createSettingsHost } from "../../src/config/settings-ui";
import { parseSettingsToml, patchSettingsToml } from "../../src/config/settings-toml";
import { cfgCompactionEnabled } from "../../src/session/context-settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let root: string;
let agentDir: string;
let cwd: string;
let state: SettingsTestState | undefined;
beforeEach(async () => {
	state = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-toml-saves-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "project");
	await fs.mkdir(agentDir);
	await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
});
afterEach(async () => {
	restoreSettingsTestState(state);
	await fs.rm(root, { recursive: true, force: true });
});

for (const scope of ["global", "project"] as const) {
	describe(`${scope} format-aware settings saves`, () => {
		const directory = () => (scope === "global" ? agentDir : path.join(cwd, ".omp"));
		const write = (settings: Settings, value: boolean) =>
			scope === "global"
				? createSettingsHost(settings).set("compaction.enabled", value)
				: settings.writeProjectValue(cfgCompactionEnabled, value);
		for (const filename of ["config.toml", "settings.toml", "config.yml"]) {
			it(`saves through the UI persistence path to ${filename} and reloads`, async () => {
				const target = path.join(directory(), filename);
				const yaml = "compaction:\n  enabled: true\n  reserveTokens: 1234\n";
				await Bun.write(path.join(directory(), "config.yml"), yaml);
				if (filename.endsWith("toml"))
					await Bun.write(target, "# owner notes\n[unrelated]\nanswer = 42 # keep this\n");
				const settings = await Settings.init({ agentDir, cwd });
				expect((await settings.persistWithReceipt(() => write(settings, false))).status).toBe("applied");
				await settings.reloadFromDisk();
				expect(cfgCompactionEnabled.get(settings)).toBe(false);
				const text = await Bun.file(target).text();
				const persisted = filename.endsWith("toml") ? parseSettingsToml(text) : Bun.YAML.parse(text);
				expect(persisted).toMatchObject({ compaction: { enabled: false, reserveTokens: 1234 } });
				if (filename.endsWith("toml")) {
					expect(text).toContain("# owner notes\n[unrelated]\nanswer = 42 # keep this\n");
					expect(await Bun.file(path.join(directory(), "config.yml")).text()).toBe(yaml);
				}
			});
		}
		it("rejects a stale TOML intent even when it requests the winning value", async () => {
			await Bun.write(path.join(directory(), "config.toml"), "[compaction]\nenabled = true\n");
			const first = await Settings.loadIsolated({ agentDir, cwd });
			const stale = await Settings.loadIsolated({ agentDir, cwd });
			expect((await first.persistWithReceipt(() => write(first, false))).status).toBe("applied");
			expect(await stale.persistWithReceipt(() => write(stale, false))).toEqual({
				status: "conflict",
				conflicts: [`${scope}:compaction.enabled`],
			});
			expect(cfgCompactionEnabled.get(stale)).toBe(false);
		});
		it("merges a disjoint external TOML edit within the same top-level table", async () => {
			const target = path.join(directory(), "config.toml");
			await Bun.write(target, "[compaction]\nenabled = true\nreserveTokens = 1234\n");
			const settings = await Settings.loadIsolated({ agentDir, cwd });
			await Bun.write(target, "[compaction]\nenabled = true\nreserveTokens = 2345\n");
			expect((await settings.persistWithReceipt(() => write(settings, false))).status).toBe("applied");
			expect(parseSettingsToml(await Bun.file(target).text()).compaction).toEqual({
				enabled: false,
				reserveTokens: 2345,
			});
		});
		it("writes the physical TOML target without replacing a symlink", async () => {
			const physical = path.join(root, "physical.toml");
			const target = path.join(directory(), "config.toml");
			await Bun.write(physical, "[compaction]\nenabled = true\n");
			await fs.symlink(physical, target);
			const settings = await Settings.loadIsolated({ agentDir, cwd });
			expect((await settings.persistWithReceipt(() => write(settings, false))).status).toBe("applied");
			expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
			expect(parseSettingsToml(await Bun.file(physical).text()).compaction).toEqual({ enabled: false });
		});
		it("rejects a stale paired model and effort edit", async () => {
			await Bun.write(path.join(directory(), "config.toml"), "# empty\n");
			const first = await Settings.loadIsolated({ agentDir, cwd });
			const stale = await Settings.loadIsolated({ agentDir, cwd });
			await first.persistWithReceipt(() =>
				first.setRoleModelAndEffort("smol", "anthropic/winner", { mode: "fixed", level: ThinkingLevel.Low }, scope),
			);
			const receipt = await stale.persistWithReceipt(() =>
				stale.setRoleModelAndEffort("smol", "anthropic/stale", { mode: "fixed", level: ThinkingLevel.High }, scope),
			);
			expect(receipt.status).toBe("conflict");
			expect(receipt.conflicts).toContain(`${scope}:modelRoles.smol`);
			expect(receipt.conflicts).toContain(`${scope}:roleEffortSelections.smol`);
		});
		it("does not revive a YAML role underneath a TOML clear", async () => {
			await Bun.write(path.join(directory(), "config.yml"), "modelRoles:\n  smol: anthropic/underneath\n");
			await Bun.write(path.join(directory(), "config.toml"), "# empty\n");
			const settings = await Settings.loadIsolated({ agentDir, cwd });
			await settings.persistWithReceipt(() =>
				scope === "global" ? settings.setModelRole("smol", undefined) : settings.clearProjectModelRole("smol"),
			);
			await settings.reloadFromDisk();
			expect(
				scope === "global" ? settings.getGlobalModelRole("smol") : settings.getProjectModelRole("smol"),
			).toBeUndefined();
		});
		for (const operation of ["create", "remove"] as const) {
			it(`rejects source changes when another writer ${operation}s TOML`, async () => {
				const target = path.join(directory(), "config.toml");
				await Bun.write(path.join(directory(), "config.yml"), "compaction:\n  enabled: true\n");
				if (operation === "remove") await Bun.write(target, "[compaction]\nenabled = true\n");
				const settings = await Settings.loadIsolated({ agentDir, cwd });
				if (operation === "create") await Bun.write(target, "[compaction]\nenabled = true\n");
				else await fs.unlink(target);
				expect((await settings.persistWithReceipt(() => write(settings, false))).status).toBe("conflict");
				expect(Bun.YAML.parse(await Bun.file(path.join(directory(), "config.yml")).text())).toEqual({
					compaction: { enabled: true },
				});
			});
		}
		it("fails closed on invalid TOML without overwriting it", async () => {
			const target = path.join(directory(), "config.toml");
			await Bun.write(target, "[compaction]\nenabled = true\n");
			const settings = await Settings.loadIsolated({ agentDir, cwd });
			await Bun.write(target, "broken = [");
			await expect(settings.persistWithReceipt(() => write(settings, false))).rejects.toThrow("config.toml");
			expect(await Bun.file(target).text()).toBe("broken = [");
		});
	});
}

it("keeps a UI clear explicit over a YAML scalar after reload and another save", async () => {
	await Bun.write(path.join(agentDir, "config.yml"), "temperature: 0.4\n");
	await Bun.write(path.join(agentDir, "config.toml"), "# preferences\n");
	const settings = await Settings.init({ agentDir, cwd });
	await settings.persistWithReceipt(() => createSettingsHost(settings).unset("temperature"));
	const target = path.join(agentDir, "config.toml");
	expect(parseSettingsToml(await Bun.file(target).text()).temperature).toBeNull();
	await settings.reloadFromDisk();
	expect(createSettingsHost(settings).get("temperature")).not.toBe(0.4);
	await settings.persistWithReceipt(() => createSettingsHost(settings).set("compaction.enabled", false));
	await settings.reloadFromDisk();
	expect(parseSettingsToml(await Bun.file(target).text()).temperature).toBeNull();
});

it("preserves unrelated multiline strings, dotted keys, comments and table arrays", () => {
	const source =
		'# header\ntemperature = 0.4 # edited\n"literal.key" = "keep"\n[custom]\ntext = """line\n[not_a_table]\n# not a comment\nend"""\nvalues = [\n  1, # retain\n  2,\n]\n[[items]]\nname = \'one\' # retain too\n[[items]]\nname = "two"\n';
	const expected = { ...parseSettingsToml(source), temperature: 0.7 };
	const result = patchSettingsToml(source, expected);
	expect(parseSettingsToml(result)).toEqual(expected);
	expect(result).toContain(source.slice(source.indexOf('"literal.key"')));
	expect(result).toContain("# header");
});
