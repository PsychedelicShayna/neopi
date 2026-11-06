import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import {
	parseSettingsToml,
	patchSettingsToml,
	readTomlConfig,
	readTomlConfigSync,
	writeTomlConfigSync,
} from "@oh-my-pi/pi-utils/settings-toml";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import { orderedSettings } from "../src/config/all-settings";
import { dumpSettingsToml } from "../src/config/settings-toml";
import { parseConfigArgs } from "../src/cli/config-cli";
import { cfgCompactionEnabled } from "../src/session/context-settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root = "";
let agentDir: string;
let cwd: string;
let state: SettingsTestState | undefined;
const toml =
	'# Preserve this comment\n[compaction]\nenabled = false\nreserveTokens = 1234\n[modelRoles]\ndefault = "example/model"\nslow = "example/other"\n';
const yaml =
	"# Legacy source stays unchanged\ncompaction:\n  enabled: false\n  reserveTokens: 1234\nmodelRoles:\n  default: example/model\n  slow: example/other\n";
beforeEach(async () => {
	state = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "native-toml-settings-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "project");
	process.env.HOME = root;
	delete process.env.PI_CONFIG_FILES;
	setAgentDir(agentDir);
	setProjectDir(cwd);
	spyOn(logger, "info").mockImplementation(() => {});
	spyOn(logger, "warn").mockImplementation(() => {});
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(agentDir, "config.toml"), toml);
	resetSettingsForTest();
});
afterEach(async () => {
	restoreSettingsTestState(state);
	if (root) await fs.rm(root, { recursive: true, force: true });
});
describe("native config.toml", () => {
	it("loads native settings without creating or rewriting a legacy source", async () => {
		const loaded = await Settings.init({ agentDir, cwd });
		expect(loaded.getGlobalSettings()).toEqual(parseSettingsToml(toml));
		await loaded.flush();
		expect(await Bun.file(path.join(agentDir, "config.toml")).text()).toBe(toml);
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);
		expect(await Bun.file(path.join(agentDir, "settings.toml")).exists()).toBe(false);
	});
	it("uses the whole TOML document and never fills absent keys from YAML", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), yaml);
		await Bun.write(path.join(agentDir, "config.toml"), "[compaction]\nenabled = true\n");
		const loaded = await Settings.loadReadOnly({ agentDir, cwd });
		expect(loaded.getGlobalSettings()).toEqual({ compaction: { enabled: true } });
		expect(loaded.getGlobalModelRole("default")).toBeUndefined();
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(yaml);
	});
	it("treats an empty canonical TOML document as authoritative over YAML", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), yaml);
		await Bun.write(path.join(agentDir, "config.toml"), "# intentionally empty\n");
		const loaded = await Settings.init({ agentDir, cwd });
		expect(loaded.getGlobalSettings()).toEqual({});
		await loaded.flush();
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(yaml);
	});
	it("imports legacy settings.toml once and leaves it unchanged on canonical saves", async () => {
		await fs.rm(path.join(agentDir, "config.toml"));
		const legacyPath = path.join(agentDir, "settings.toml");
		const legacy = "[compaction]\nenabled = true\n";
		await Bun.write(legacyPath, legacy);
		const loaded = await Settings.init({ agentDir, cwd });
		expect(cfgCompactionEnabled.get(loaded)).toBe(true);
		cfgCompactionEnabled.set(loaded, false);
		await loaded.flush();
		expect(parseSettingsToml(await Bun.file(path.join(agentDir, "config.toml")).text())).toEqual({
			compaction: { enabled: false },
		});
		expect(await Bun.file(legacyPath).text()).toBe(legacy);
		await Bun.write(legacyPath, "broken = [");
		await loaded.reloadFromDisk();
		expect(cfgCompactionEnabled.get(loaded)).toBe(false);
	});
	it("applies project TOML at project precedence and preserves explicit config/runtime precedence", async () => {
		await Bun.write(path.join(cwd, ".omp/config.yml"), "compaction:\n  enabled: false\n  reserveTokens: 2222\n");
		await Bun.write(path.join(cwd, ".omp/config.toml"), "[compaction]\nenabled = true\n");
		const overlay = path.join(root, "overlay.toml");
		await Bun.write(overlay, "[compaction]\nenabled = false\n");
		const loaded = await Settings.loadReadOnly({ agentDir, cwd, configFiles: [overlay] });
		expect(loaded.getProjectSettings().compaction).toEqual({ enabled: true });
		expect(cfgCompactionEnabled.get(loaded)).toBe(false);
		cfgCompactionEnabled.override(loaded, true);
		expect(cfgCompactionEnabled.get(loaded)).toBe(true);
	});
	it("rejects malformed TOML and allows singleton initialization to recover", async () => {
		await Bun.write(path.join(agentDir, "config.toml"), "broken = [");
		await expect(Settings.init({ agentDir, cwd })).rejects.toThrow("config.toml");
		await Bun.write(path.join(agentDir, "config.toml"), "");
		expect(await Settings.init({ agentDir, cwd })).toBeInstanceOf(Settings);
	});
	it("rejects malformed project TOML rather than silently falling back to YAML", async () => {
		await Bun.write(path.join(cwd, ".omp/config.yml"), "compaction:\n  enabled: true\n");
		await Bun.write(path.join(cwd, ".omp/config.toml"), "broken = [");
		await expect(Settings.loadReadOnly({ agentDir, cwd })).rejects.toThrow("config.toml");
	});
	it("saves canonical TOML, keeps last-good values on invalid reload, and reloads replacements", async () => {
		const target = path.join(agentDir, "config.toml");
		const loaded = await Settings.init({ agentDir, cwd });
		cfgCompactionEnabled.set(loaded, true);
		await loaded.flush();
		expect(parseSettingsToml(await Bun.file(target).text())).toMatchObject({ compaction: { enabled: true } });
		await Bun.write(target, "broken = [");
		await expect(loaded.reloadFromDisk()).rejects.toThrow("config.toml");
		expect(cfgCompactionEnabled.get(loaded)).toBe(true);
		await Bun.write(target, toml);
		await loaded.reloadFromDisk();
		expect(cfgCompactionEnabled.get(loaded)).toBe(false);
		await fs.rm(target);
		await loaded.reloadFromDisk();
		expect(loaded.getGlobalSettings()).toEqual({});
	});
	it("imports YAML once atomically with the source mode and never rewrites its bytes", async () => {
		const legacy = path.join(agentDir, "config.yaml");
		const target = path.join(agentDir, "config.toml");
		await fs.rm(target);
		await Bun.write(legacy, yaml);
		await fs.chmod(legacy, 0o640);
		const loaded = await Settings.init({ agentDir, cwd });
		expect(await Bun.file(target).text()).toContain("# Legacy source stays unchanged");
		expect(loaded.getGlobalSettings()).toEqual({
			compaction: { enabled: false, reserveTokens: 1234 },
			modelRoles: { default: "example/model", slow: "example/other" },
		});
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
		cfgCompactionEnabled.set(loaded, true);
		await loaded.flush();
		await Bun.write(legacy, "malformed: [private-value");
		await loaded.reloadFromDisk();
		expect(cfgCompactionEnabled.get(loaded)).toBe(true);
		expect(await Bun.file(legacy).text()).toBe("malformed: [private-value");
		expect((await fs.readdir(agentDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
	it("imports explicit YAML overlays into their sibling and uses only TOML thereafter", async () => {
		const legacy = path.join(root, "overlay.yaml");
		const target = path.join(root, "overlay.toml");
		await Bun.write(legacy, "compaction:\n  enabled: true\n");
		await fs.chmod(legacy, 0o640);
		const loaded = await Settings.loadReadOnly({ agentDir, cwd, configFiles: [legacy] });
		expect(cfgCompactionEnabled.get(loaded)).toBe(true);
		expect(loaded.getConfigFiles()).toEqual([target]);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
		await Bun.write(legacy, "compaction: [broken");
		await Bun.write(target, "[compaction]\nenabled = false\n");
		await loaded.reloadFromDisk();
		expect(cfgCompactionEnabled.get(loaded)).toBe(false);
		expect(await Bun.file(legacy).text()).toBe("compaction: [broken");
	});
	it("preserves top-level, nested, inline and untouched comments during settings saves", async () => {
		const target = path.join(agentDir, "config.toml");
		const source =
			"# document title\n[compaction] # table note\n# explain enablement\nenabled = false # inline enabled\nreserveTokens = 1234 # untouched\n\n[unknown.nested]\n# future-key explanation\nvalue = 9 # future inline\n";
		await Bun.write(target, source);
		const loaded = await Settings.init({ agentDir, cwd });
		cfgCompactionEnabled.set(loaded, true);
		await loaded.flush();
		const edited = await Bun.file(target).text();
		for (const comment of [
			"# document title",
			"# table note",
			"# explain enablement",
			"# inline enabled",
			"# untouched",
			"# future-key explanation",
			"# future inline",
		])
			expect(edited).toContain(comment);
		expect(edited).toContain("reserveTokens = 1234 # untouched");
		expect(parseSettingsToml(edited)).toEqual({
			compaction: { enabled: true, reserveTokens: 1234 },
			unknown: { nested: { value: 9 } },
		});
	});
	it("preserves nested table comments across insertions, deletions, clears and scalar replacements", () => {
		const source = '# title\n[root]\n# value note\nvalue = 1 # inline\n[other]\ntext = "literal # text" # keep\n';
		const desired = { root: { inserted: null, child: { added: "new" } }, other: { text: "changed # text" } };
		const edited = patchSettingsToml(source, desired);
		expect(parseSettingsToml(edited)).toEqual(desired);
		expect(edited).toContain("# title");
		expect(edited).toContain("# value note");
		expect(edited).toContain("# keep");
		expect(patchSettingsToml(edited, desired)).toBe(edited);
		expect(parseSettingsToml(patchSettingsToml(source, { root: "scalar", other: {} }))).toEqual({
			root: "scalar",
			other: {},
		});
	});
	it("keeps array-table comments attached to identified rows across edits, reorder and deletion", () => {
		const source =
			'# title\n[[rows]]\nid = "a" # a identity\n# a value note\nvalue = 1 # a inline\n\n[[rows]]\nid = "b" # b identity\n# b value note\nvalue = 2 # b inline\n';
		const reordered = patchSettingsToml(source, {
			rows: [
				{ id: "b", value: 3 },
				{ id: "a", value: 1 },
			],
		});
		expect(parseSettingsToml(reordered)).toEqual({
			rows: [
				{ id: "b", value: 3 },
				{ id: "a", value: 1 },
			],
		});
		expect(reordered.indexOf("# b identity")).toBeLessThan(reordered.indexOf("# a identity"));
		expect(reordered).toContain("# b value note");
		expect(reordered).toContain("# a value note");
		const removed = patchSettingsToml(source, {
			rows: [
				{ id: "b", value: 2 },
				{ id: "c", value: 4 },
			],
		});
		expect(parseSettingsToml(removed)).toEqual({
			rows: [
				{ id: "b", value: 2 },
				{ id: "c", value: 4 },
			],
		});
		expect(removed).toContain("# b identity");
		expect(parseSettingsToml(patchSettingsToml(source, { rows: [] }))).toEqual({ rows: [] });
	});
	it("sync and async imports agree, preserve nulls, and never parse an ignored legacy source", async () => {
		const target = path.join(root, "shared.toml");
		const legacy = path.join(root, "shared.yml");
		await Bun.write(legacy, "value: null\nnested: {items: [null, text]}\n");
		await fs.chmod(legacy, 0o640);
		const [first, second] = await Promise.all([
			readTomlConfig(target, { legacyPaths: [legacy] }),
			readTomlConfig(target, { legacyPaths: [legacy] }),
		]);
		expect(first?.data).toEqual({ value: null, nested: { items: [null, "text"] } });
		expect(second?.data).toEqual(first?.data);
		const parseLegacy = spyOn(
			{
				parse: () => {
					throw new Error("must not read legacy");
				},
			},
			"parse",
		);
		expect(readTomlConfigSync(target, { legacyPaths: [legacy], parseLegacy })?.data).toEqual(first?.data);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
		const changed = { value: "native", nested: { items: [null] } };
		writeTomlConfigSync(target, changed, first!.content);
		expect((await readTomlConfig(target))?.data).toEqual(changed);
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
		expect(parseLegacy).not.toHaveBeenCalled();
		expect(await Bun.file(legacy).text()).toBe("value: null\nnested: {items: [null, text]}\n");
	});
	it("supports synchronous import and an explicitly read-only inherited legacy layer", async () => {
		const legacy = path.join(root, "inherited.yml");
		const target = path.join(root, "inherited.toml");
		await Bun.write(legacy, "value: inherited\n");
		await fs.chmod(legacy, 0o640);
		expect(readTomlConfigSync(target, { legacyPaths: [legacy], migrate: false })).toMatchObject({
			filePath: legacy,
			data: { value: "inherited" },
		});
		expect(await Bun.file(target).exists()).toBe(false);
		expect(readTomlConfigSync(target, { legacyPaths: [legacy] })?.data).toEqual({ value: "inherited" });
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
		expect(await Bun.file(legacy).text()).toBe("value: inherited\n");
	});
	it("reports only paths when canonical TOML ignores malformed YAML or parsing fails", async () => {
		const legacy = path.join(root, "secrets.yml");
		const target = path.join(root, "secrets.toml");
		const warn = spyOn(logger, "warn");
		warn.mockClear();
		await Bun.write(legacy, "value: [private-value");
		await Bun.write(target, "value = 1\n");
		expect((await readTomlConfig(target, { legacyPaths: [legacy] }))?.data).toEqual({ value: 1 });
		expect(JSON.stringify(warn.mock.calls)).toContain(legacy);
		expect(JSON.stringify(warn.mock.calls)).toContain(target);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
		await fs.rm(target);
		await expect(readTomlConfig(target, { legacyPaths: [legacy] })).rejects.toThrow(
			`Failed to import legacy configuration: ${legacy}`,
		);
		await Bun.write(target, 'value = ["private-value"\n');
		await expect(readTomlConfig(target)).rejects.toThrow(`Settings config is invalid: ${target}`);
	});
	it("retains comments inside a replaced multiline array without mistaking string # for a comment", () => {
		const source =
			'values = [\n  "literal # text", # first value note\n  "second", # second value note\n] # array note\n';
		const edited = patchSettingsToml(source, { values: ["new"] });
		expect(parseSettingsToml(edited)).toEqual({ values: ["new"] });
		expect(edited).toContain("# first value note");
		expect(edited).toContain("# second value note");
		expect(edited).toContain("# array note");
		expect(edited).not.toContain("literal # text");
	});
	it("retains actual YAML comments without treating quoted or block scalar # text as comments", async () => {
		const legacy = path.join(root, "commented.yml");
		const target = path.join(root, "commented.toml");
		const source =
			"# file note\nquoted: 'text # quoted-data'\nblock: |\n  # block-data\nnested:\n  # nested note\n  enabled: false # inline note\n";
		await Bun.write(legacy, source);
		const result = await readTomlConfig(target, { legacyPaths: [legacy] });
		expect(result?.data).toEqual({
			quoted: "text # quoted-data",
			block: "# block-data\n",
			nested: { enabled: false },
		});
		const preamble = result!.content.split("\n\n", 1)[0]!;
		expect(preamble).toContain("# file note");
		expect(preamble).toContain("# nested note");
		expect(preamble).toContain("# inline note");
		expect(preamble).toContain("original field associations are not retained");
		expect(preamble).not.toContain("quoted-data");
		expect(preamble).not.toContain("block-data");
		expect(await Bun.file(legacy).text()).toBe(source);
	});
	it("dumps every registered default deterministically as valid TOML without reading user settings", async () => {
		const text = dumpSettingsToml();
		const parsed = parseSettingsToml(text);
		expect(dumpSettingsToml()).toBe(text);
		for (const setting of orderedSettings()) {
			expect(text).toContain(`# ${setting.id} (${setting.type})`);
			if (setting.default === undefined || setting.default === null) continue;
			let actual: unknown = parsed;
			for (const segment of setting.segments) actual = (actual as Record<string, unknown>)[segment];
			expect(actual).toEqual(setting.default);
		}
		await Bun.write(path.join(agentDir, "config.toml"), text);
		expect(await Settings.loadReadOnly({ agentDir, cwd })).toBeInstanceOf(Settings);
		expect(parseConfigArgs(["config", "dump-toml"])?.action).toBe("dump-toml");
	});
});
