import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "yaml";
import { parseConfigArgs, runConfigCommand } from "../src/cli/config-cli";
import { Settings } from "../src/config/settings";
import { overlaySettingsToml, parseSettingsToml, stringifySettingsToml } from "../src/config/settings-toml";
import {
	convertMainSettingsToToml,
	convertSettingsFileToToml,
	convertSettingsYamlToToml,
} from "../src/config/settings-to-toml";
import { writeFileAtomically } from "../src/utils/atomic-file";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root = "";
let agentDir: string;
let cwd: string;
let state: SettingsTestState | undefined;
beforeEach(async () => {
	state = beginSettingsTest();
	const cacheDir = path.join(process.env.HOME!, ".cache/npi-canary");
	await fs.mkdir(cacheDir, { recursive: true });
	root = await fs.mkdtemp(path.join(cacheDir, "toml-codec-test-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
});
afterEach(async () => {
	restoreSettingsTestState(state);
	if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("full settings TOML codec", () => {
	it("round trips nested tables, arrays of tables, mixed arrays, empty containers, keys and multiline strings", () => {
		const value = {
			"literal.dot": { "model/a:b~c": 'Unicode 🌌\n\n"quoted"\\path\r\t\n' },
			arrays: [
				{ name: "one", nested: { list: [{ value: 1 }, {}] } },
				{ name: "two", nested: {} },
			],
			mixed: [1, "two", true, { deep: [false, { "odd.key": "line\nbreak" }] }, [3, "four"], [], {}],
			empty: {},
			list: [],
			leadingNewline: "\nfirst\nsecond",
			escapeLike: "literal \\t and \\\\t",
			float: 0.000000000000001,
			negativeZero: -0,
		};
		const content = stringifySettingsToml(value);
		expect(parseSettingsToml(content)).toEqual(value);
		expect(Bun.TOML.parse(content)).toEqual(value);
		expect(stringifySettingsToml(value)).toBe(content);
	});
	it("round trips all null positions without reviving YAML fallback or changing array length", () => {
		const value = {
			roleSettings: { custom: { temperature: null } },
			task: { agentAccountPools: { custom: { provider: null } } },
			"slash/~dot.key": null,
			"": null,
			list: [null, { field: null }, [null], ""],
			clear: null,
		};
		const content = stringifySettingsToml(value);
		expect(parseSettingsToml(content)).toEqual(value);
		expect(
			overlaySettingsToml(
				{ clear: "old", unrelated: 7, roleSettings: { custom: { temperature: 0.8 } } },
				Bun.TOML.parse(content) as Record<string, unknown>,
			),
		).toEqual({ ...value, unrelated: 7 });
		expect(overlaySettingsToml({ clear: "inherited" }, parseSettingsToml(stringifySettingsToml({})))).toEqual({
			clear: "inherited",
		});
	});
	it("rejects reserved user metadata, unsupported values, cycles and unsafe integers without printing values", () => {
		for (const value of [
			{ __npi: { secret: "private-value" } },
			{ value: new Date() },
			{ value: undefined },
			{ value: 9007199254740992 },
			{ value: 42n },
			{ value: "\u0000" },
			{ value: "\f" },
			{ value: "\u007f" },
		])
			expect(() => stringifySettingsToml(value)).toThrow();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => stringifySettingsToml(cyclic)).toThrow("cyclic");
	});
	it.each([
		"[__npi]\nversion = 2\nnull_paths = []",
		'[__npi]\nversion = 1\nnull_paths = ["/__npi"]',
		'[__npi]\nversion = 1\nnull_paths = ["/missing/child"]',
		'[__npi]\nversion = 1\nnull_paths = ["/bad~2escape"]',
		'[__npi]\nversion = 1\nnull_paths = ["/x", "/x"]',
		'x = 1\n[__npi]\nversion = 1\nnull_paths = ["/x"]',
		'xs = ["value"]\n[__npi]\nversion = 1\nnull_paths = ["/xs/0"]',
		'xs = [""]\n[__npi]\nversion = 1\nnull_paths = ["/xs/1"]',
	])("fails closed on invalid metadata %s", content => {
		expect(() => parseSettingsToml(content)).toThrow();
	});
	it("does not traverse or mutate prototypes when decoding user-controlled paths", () => {
		expect(() => parseSettingsToml('[__npi]\nversion = 1\nnull_paths = ["/__proto__/polluted"]')).toThrow();
		const result = parseSettingsToml('[__npi]\nversion = 1\nnull_paths = ["/__proto__"]');
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(result.__proto__).toBeNull();
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	});
});

describe("on-demand full YAML conversion", () => {
	it("preserves unknown keys and effective settings from the full YAML, not registry defaults", async () => {
		const source =
			"# source comment\ncompaction:\n  enabled: false\nunknown-extension:\n  payload: [1, two, true, {key: value}]\n  blank: {}\nroleSettings:\n  custom:\n    temperature: null\n";
		const sourcePath = path.join(agentDir, "config.yml");
		await Bun.write(sourcePath, source);
		const original = await Settings.loadReadOnly({ agentDir, cwd });
		const result = await convertSettingsFileToToml(sourcePath);
		expect(result.targetPath).toBe(path.join(agentDir, "config.toml"));
		expect(parseSettingsToml(await Bun.file(result.targetPath).text())).toEqual(parse(source));
		expect((await Settings.loadReadOnly({ agentDir, cwd })).getGlobalSettings()).toEqual(
			original.getGlobalSettings(),
		);
		expect(result.diagnostics).toContainEqual({ path: "/compaction", message: "YAML comments are not carried over" });
		expect(await Bun.file(sourcePath).text()).toBe(source);
		expect((await fs.stat(result.targetPath)).mode & 0o777).toBe(0o600);
	});
	it("expands acyclic aliases and reports lost anchors, comments and identity by path", () => {
		const source = "template: &defaults\n  text: |\n    line one\n    line two\ncopy: *defaults # keep value\n";
		const converted = convertSettingsYamlToToml(source);
		expect(parseSettingsToml(converted.content)).toEqual(parse(source));
		expect(converted.diagnostics.map(entry => entry.path)).toEqual(["/template", "/copy", "/copy"]);
		expect(converted.diagnostics.some(entry => entry.message.includes("alias expanded"))).toBe(true);
	});
	it.each([
		["value: !!timestamp 2026-10-22", "date/time"],
		["value: !unknown private-value", "custom tags"],
		["? [one, two]\n: value", "non-string"],
		["1: value", "non-string"],
		["value: 9007199254740993", "integer"],
		["value: &loop [*loop]", "cyclic"],
		["first: 1\n---\nsecond: 2", "multiple YAML documents"],
		["[one, two]", "mapping"],
		["value: [private-value", "invalid YAML"],
	])("reports unsupported source %s without quoting secret values", (source, error) => {
		expect(() => convertSettingsYamlToToml(source)).toThrow(error);
		try {
			convertSettingsYamlToToml(source);
		} catch (failure) {
			expect(String(failure)).not.toContain("private-value");
		}
	});
	it("preserves date-looking strings and Bun's effective YAML merge-key expansion", async () => {
		const source = "day: 2026-10-22\nbase: &base {one: 1}\nchild: {<<: *base, two: 2}\n";
		const sourcePath = path.join(agentDir, "config.yml");
		await Bun.write(sourcePath, source);
		const before = await Settings.loadReadOnly({ agentDir, cwd });
		const result = await convertSettingsFileToToml(sourcePath);
		const decoded = parseSettingsToml(await Bun.file(result.targetPath).text());
		expect(decoded).toEqual({ day: "2026-10-22", base: { one: 1 }, child: { one: 1, two: 2 } });
		expect(decoded).toEqual(before.getGlobalSettings());
		expect((await Settings.loadReadOnly({ agentDir, cwd })).getGlobalSettings()).toEqual(before.getGlobalSettings());
	});
	it("converts user and project settings and honors config.yaml when config.yml is absent", async () => {
		await Bun.write(path.join(agentDir, "config.yaml"), "unknown: {user: yes}\n");
		await Bun.write(path.join(cwd, ".omp/config.yml"), "unknown: {project: yes}\n");
		const results = await convertMainSettingsToToml({ agentDir, cwd });
		expect(results).toHaveLength(2);
		const loaded = await Settings.loadReadOnly({ agentDir, cwd });
		expect(loaded.getGlobalSettings()).toEqual({ unknown: { user: "yes" } });
		expect(loaded.getProjectSettings()).toEqual({ unknown: { project: "yes" } });
	});
	it("reports already-published conversions and their diagnostics if a later file fails", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), "# private comment\nvalue: private-value\n");
		await Bun.write(path.join(cwd, ".omp/config.yml"), "date: !!timestamp 2026-10-22\n");
		await expect(convertMainSettingsToToml({ agentDir, cwd })).rejects.toThrow("Already converted");
		expect(await Bun.file(path.join(agentDir, "config.toml")).exists()).toBe(true);
		expect(await Bun.file(path.join(cwd, ".omp/config.toml")).exists()).toBe(false);
	});
	it("loads a canonical TOML-only main settings file", async () => {
		await Bun.write(path.join(agentDir, "config.toml"), stringifySettingsToml({ compaction: { enabled: false } }));
		const loaded = await Settings.loadReadOnly({ agentDir, cwd });
		expect(loaded.getGlobalSettings()).toEqual({ compaction: { enabled: false } });
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);
	});
	it("refuses existing TOML unless forced, without changing existing bytes on failure", async () => {
		const source = path.join(agentDir, "config.yml");
		const target = path.join(agentDir, "config.toml");
		await Bun.write(source, "value: 1\n");
		await Bun.write(target, "value = 2\n");
		await expect(convertSettingsFileToToml(source)).rejects.toThrow("--force");
		expect(await Bun.file(target).text()).toBe("value = 2\n");
		await convertSettingsFileToToml(source, { force: true });
		expect(parseSettingsToml(await Bun.file(target).text())).toEqual({ value: 1 });
		await Bun.write(source, "value: !unsupported private-value\n");
		await expect(convertSettingsFileToToml(source, { force: true })).rejects.toThrow("custom tags");
		expect(parseSettingsToml(await Bun.file(target).text())).toEqual({ value: 1 });
	});
	it("does not clobber a destination symlink without --force", async () => {
		const source = path.join(agentDir, "config.yml");
		const destination = path.join(agentDir, "config.toml");
		const linked = path.join(agentDir, "private.toml");
		await Bun.write(source, "value: 1\n");
		await Bun.write(linked, "keep = true\n");
		await fs.symlink(linked, destination);
		await expect(convertSettingsFileToToml(source)).rejects.toThrow("--force");
		expect(await Bun.file(linked).text()).toBe("keep = true\n");
	});
	it("rejects ambiguous legacy and canonical overlays, including empty legacy files", async () => {
		const source = path.join(agentDir, "config.yml");
		await Bun.write(source, "value: 1\n");
		await Bun.write(path.join(agentDir, "settings.toml"), "");
		await expect(convertSettingsFileToToml(source, { force: true })).rejects.toThrow("Legacy overlay");
		await Bun.write(path.join(agentDir, "config.toml"), "");
		await expect(Settings.loadReadOnly({ agentDir, cwd })).rejects.toThrow("Conflicting settings files");
	});
	it("preserves null masks across real settings reloads and rejects invalid canonical TOML", async () => {
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"roleSettings: {custom: {temperature: 0.8}}\ntask: {agentAccountPools: {custom: {provider: [account]}}}\n",
		);
		await Bun.write(
			path.join(agentDir, "config.toml"),
			stringifySettingsToml({
				roleSettings: { custom: { temperature: null } },
				task: { agentAccountPools: { custom: null } },
			}),
		);
		const loaded = await Settings.init({ agentDir, cwd });
		expect(loaded.getGlobalSettings().roleSettings).toEqual({ custom: { temperature: null } });
		expect(loaded.getGlobalSettings().task).toEqual({ agentAccountPools: { custom: null } });
		await loaded.reloadFromDisk();
		expect(loaded.getGlobalSettings().roleSettings).toEqual({ custom: { temperature: null } });
		await Bun.write(path.join(agentDir, "config.toml"), "broken = [");
		await expect(loaded.reloadFromDisk()).rejects.toThrow("config.toml");
		expect(loaded.getGlobalSettings().roleSettings).toEqual({ custom: { temperature: null } });
	});
	it("routes CLI conversion before settings initialization and prints diagnostics without credentials", async () => {
		const source = path.join(agentDir, "config.yml");
		await Bun.write(source, "# private comment\nunknown: private-value\n");
		const log = spyOn(console, "log").mockImplementation(() => {});
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const command = parseConfigArgs(["config", "to-toml", source, "--force"])!;
			expect(command.flags.force).toBe(true);
			await runConfigCommand(command);
			expect(parseSettingsToml(await Bun.file(path.join(agentDir, "config.toml")).text())).toEqual({
				unknown: "private-value",
			});
			expect(log.mock.calls.flat().join(" ")).toContain("Converted");
			expect(error.mock.calls.flat().join(" ")).toContain("comments");
			expect(error.mock.calls.flat().join(" ")).not.toContain("still write YAML");
			expect([...log.mock.calls, ...error.mock.calls].flat().join(" ")).not.toContain("private-value");
		} finally {
			log.mockRestore();
			error.mockRestore();
		}
	});
	it.each([{ flags: [] }, { flags: ["--force"] }])(
		"converts without the obsolete acknowledgment, including %j",
		async ({ flags }) => {
			const source = path.join(agentDir, "config.yml");
			const target = path.join(agentDir, "config.toml");
			await Bun.write(source, "value: new\n");
			if (flags.length) await Bun.write(target, 'value = "existing"\n');
			const error = spyOn(console, "error").mockImplementation(() => {});
			const log = spyOn(console, "log").mockImplementation(() => {});
			try {
				await runConfigCommand(parseConfigArgs(["config", "to-toml", source, ...flags])!);
				expect(parseSettingsToml(await Bun.file(target).text())).toEqual({ value: "new" });
				expect(error.mock.calls.flat().join(" ")).not.toContain("still write YAML");
				expect(await Bun.file(source).text()).toBe("value: new\n");
			} finally {
				log.mockRestore();
				error.mockRestore();
			}
		},
	);
	it.each(["--help", "-h"])("prints conversion help on %s without converting", async flag => {
		const source = path.join(agentDir, "config.yml");
		await Bun.write(source, "value: example\n");
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			await runConfigCommand(parseConfigArgs(["config", "to-toml", source, flag])!);
			const help = log.mock.calls.flat().join(" ");
			expect(help).toContain("to-toml");
			expect(help).not.toContain("still write YAML");
			expect(await Bun.file(path.join(agentDir, "config.toml")).exists()).toBe(false);
		} finally {
			log.mockRestore();
		}
	});
	it("atomically refuses publication over an existing file", async () => {
		const target = path.join(root, "atomic.toml");
		await writeFileAtomically(target, "first", { noReplace: true });
		await expect(writeFileAtomically(target, "second", { noReplace: true })).rejects.toThrow();
		expect(await Bun.file(target).text()).toBe("first");
		expect((await fs.readdir(root)).sort()).toEqual(["agent", "atomic.toml", "project"]);
	});
	it("preserves a settings symlink while atomically publishing a requested mode", async () => {
		const target = path.join(root, "secret.toml");
		const link = path.join(root, "linked.toml");
		await Bun.write(target, "old");
		await fs.symlink(target, link);
		await writeFileAtomically(link, "new", { mode: 0o640 });
		expect(await fs.readlink(link)).toBe(target);
		expect(await Bun.file(target).text()).toBe("new");
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
	});
	it("publishes private files in a missing parent without replacing an existing symlink", async () => {
		const target = path.join(root, "nested", "secret.toml");
		await writeFileAtomically(target, "secret", { noReplace: true });
		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		const link = path.join(root, "existing-link.toml");
		await fs.symlink(target, link);
		await expect(writeFileAtomically(link, "replacement", { noReplace: true })).rejects.toThrow();
		expect(await fs.readlink(link)).toBe(target);
		expect(await Bun.file(target).text()).toBe("secret");
		expect((await fs.readdir(root)).sort()).toEqual(["agent", "existing-link.toml", "nested", "project"]);
	});
});
