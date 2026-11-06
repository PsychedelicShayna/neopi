import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { parseSettingsToml, stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { ModelConfigEditor } from "../src/config/model-config-editor";
import { ModelsConfigFile } from "../src/config/models-config";

let directory: TempDir;
beforeEach(() => {
	directory = TempDir.createSync("@models-native-toml-");
});
afterEach(async () => {
	await directory.remove();
});

function config(name: string) {
	return {
		providers: {
			fixture: {
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				auth: "none",
				models: [{ id: "fixture", name }],
			},
		},
	};
}

const yaml = [
	"# Keep the original import source",
	"providers:",
	"  fixture:",
	"    baseUrl: https://example.invalid/v1",
	"    api: openai-completions",
	"    auth: none",
	"    models:",
	"      - id: fixture",
	"        name: Imported",
	"",
].join("\n");

describe("native model configuration", () => {
	test.each(["yml", "yaml", "json", "jsonc"])(
		"imports %s once to a same-mode TOML sibling without changing the source",
		async extension => {
			const legacyPath = directory.join(`models.${extension}`);
			const canonicalPath = directory.join("models.toml");
			const original =
				extension === "jsonc"
					? `// legacy JSONC\n${JSON.stringify(config("Imported"))}`
					: extension === "json"
						? JSON.stringify(config("Imported"))
						: yaml;
			await Bun.write(legacyPath, original);
			await fs.chmod(legacyPath, 0o640);
			const file = ModelsConfigFile.relocate(canonicalPath);
			expect(file.tryLoad(true)).toMatchObject({ status: "ok", value: config("Imported") });
			expect(file.path()).toBe(canonicalPath);
			expect(await Bun.file(legacyPath).text()).toBe(original);
			expect((await fs.stat(legacyPath)).mode & 0o777).toBe(0o640);
			expect((await fs.stat(canonicalPath)).mode & 0o777).toBe(0o640);
			const imported = await Bun.file(canonicalPath).text();
			expect(parseSettingsToml(imported)).toEqual(config("Imported"));
			if (extension === "yml" || extension === "yaml") {
				expect(imported).toContain("# Keep the original import source");
			}

			// Legacy edits cannot become a second active configuration after import.
			await Bun.write(
				legacyPath,
				extension === "json" || extension === "jsonc"
					? JSON.stringify(config("Ignored"))
					: yaml.replace("Imported", "Ignored"),
			);
			file.invalidate();
			expect(file.tryLoad(true)).toMatchObject({ status: "ok", value: config("Imported") });
			expect((await fs.readdir(directory.path())).sort()).toEqual([`models.${extension}`, "models.toml"].sort());
		},
	);

	test("uses TOML exclusively when legacy siblings coexist, even if legacy YAML is malformed", async () => {
		const canonicalPath = directory.join("models.toml");
		const canonical = stringifySettingsToml(config("Canonical"));
		await Bun.write(canonicalPath, canonical);
		await Bun.write(directory.join("models.yml"), "providers: [broken");
		await Bun.write(directory.join("models.json"), JSON.stringify(config("Legacy")));
		const file = ModelsConfigFile.relocate(canonicalPath);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(file.tryLoad(true)).toMatchObject({ status: "ok", value: config("Canonical") });
			expect(warning.mock.calls).toEqual([
				[
					"Ignoring legacy configuration in favor of TOML",
					{ sourcePath: directory.join("models.yml"), targetPath: canonicalPath },
				],
				[
					"Ignoring legacy configuration in favor of TOML",
					{ sourcePath: directory.join("models.json"), targetPath: canonicalPath },
				],
			]);
		} finally {
			warning.mockRestore();
		}
		expect(await Bun.file(canonicalPath).text()).toBe(canonical);
		expect(await Bun.file(directory.join("models.yml")).text()).toBe("providers: [broken");
	});

	test("rejects invalid canonical TOML rather than falling back to a valid legacy file", async () => {
		await Bun.write(directory.join("models.toml"), "[providers");
		await Bun.write(directory.join("models.yml"), yaml);
		expect(ModelsConfigFile.relocate(directory.join("models.toml")).tryLoad().status).toBe("error");
		expect(await Bun.file(directory.join("models.toml")).text()).toBe("[providers");
	});

	test("reports invalid legacy input without publishing TOML or modifying YAML", async () => {
		const legacy = "providers: [broken";
		await Bun.write(directory.join("models.yaml"), legacy);
		expect(ModelsConfigFile.relocate(directory.join("models.toml")).tryLoad().status).toBe("error");
		expect(await Bun.file(directory.join("models.toml")).exists()).toBe(false);
		expect(await Bun.file(directory.join("models.yaml")).text()).toBe(legacy);
	});

	test("legacy constructor paths import and editor saves always target TOML", async () => {
		const legacyPath = directory.join("models.jsonc");
		const legacy = `// original source\n${JSON.stringify(config("Before"))}`;
		await Bun.write(legacyPath, legacy);
		const editor = new ModelConfigEditor(ModelsConfigFile.relocate(legacyPath));
		const entry = editor.list()[0];
		await editor.save({ ...entry, fields: { ...entry.fields, name: "After" } }, entry);
		expect(editor.file.path()).toBe(directory.join("models.toml"));
		expect(parseSettingsToml(await Bun.file(editor.file.path()).text())).toEqual(config("After"));
		expect(await Bun.file(legacyPath).text()).toBe(legacy);
	});

	test("creates only models.toml for an initially absent configuration", async () => {
		const editor = new ModelConfigEditor(ModelsConfigFile.relocate(directory.join("models.toml")));
		expect(editor.list()).toEqual([]);
		await editor.save({ provider: "fixture", id: "new", kind: "override", fields: { maxTokens: 128 } });
		expect(await fs.readdir(directory.path())).toEqual(["models.toml"]);
		expect(parseSettingsToml(await Bun.file(editor.file.path()).text())).toEqual({
			providers: { fixture: { modelOverrides: { new: { maxTokens: 128 } } } },
		});
	});
});
