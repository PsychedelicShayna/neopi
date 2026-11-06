import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseSettingsToml, stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { stripVTControlCharacters } from "node:util";
import { ModelConfigEditor } from "../src/config/model-config-editor";
import { ModelsConfigFile } from "../src/config/models-config";
import { getModelsConfigSchemaBundle } from "../src/config/models-config-schema-bundle";
import { ModelConfigFields } from "@oh-my-pi/pi-tui/overlays/model-config-fields";
import { ModelOverridesPanel, type HubModelConfigEntry } from "@oh-my-pi/pi-tui/overlays/model-overrides";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const dirs: string[] = [];
beforeAll(async () => {
	setThemeInstance((await getThemeByName("dark"))!);
});
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(config?: Record<string, unknown>): Promise<ModelConfigEditor> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-overrides-"));
	dirs.push(dir);
	const file = ModelsConfigFile.relocate(path.join(dir, "models.toml"));
	if (config) await Bun.write(file.path(), stringifySettingsToml(config));
	return new ModelConfigEditor(file);
}

function originalConfig() {
	return {
		futureRoot: { keep: true },
		providers: {
			local: {
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				auth: "none",
				futureProvider: "keep",
				modelOverrides: {
					existing: {
						name: "Before",
						maxTokens: 100,
						future: { keep: [1, 2] },
						thinking: { mode: "effort", efforts: ["low", "high"], futureThinking: "keep" },
						compat: { supportsStore: true, futureCompat: { nested: "keep" } },
					},
				},
				models: [{ id: "custom", name: "Custom", futureCustom: { keep: true } }],
			},
		},
	};
}

function view(panel: ModelOverridesPanel): string {
	return stripVTControlCharacters(panel.render(160, 60).join("\n"));
}
function type(panel: ModelOverridesPanel, value: string): void {
	panel.handleInput("\x15");
	panel.handleInput(value);
	panel.handleInput("\r");
}
function field(editor: ModelConfigFields, key: string, value: string): void {
	editor.activate(`field:${key}`);
	expect(editor.input).toBeDefined();
	editor.input!.input.setValue(value);
	editor.acceptInput();
}

function panelFor(editor: ModelConfigEditor): { panel: ModelOverridesPanel; settled(): Promise<void> } {
	let done = Promise.withResolvers<void>();
	const panel = new ModelOverridesPanel({
		list: () => editor.list(),
		schema: kind => editor.schema(kind),
		save: (entry, original) => editor.save(entry, original),
		remove: entry => editor.remove(entry),
		changed: () => done.resolve(),
		back: () => {},
	});
	return {
		panel,
		settled: async () => {
			await done.promise;
			done = Promise.withResolvers<void>();
		},
	};
}

describe("model override configuration UI", () => {
	test("initializes real Settings and an empty model editor when the feature is absent", async () => {
		const editor = await setup();
		const process = Bun.spawn(
			[
				Bun.which("bun")!,
				path.join(import.meta.dir, "fixtures/model-overrides-startup-probe.ts"),
				path.dirname(editor.file.path()),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const error = await new Response(process.stderr).text();
		expect(await process.exited, error).toBe(0);
	});
	test("lists every custom entry and override, including fields absent from the catalog", async () => {
		const editor = await setup(originalConfig());
		const entries = editor.list();
		expect(entries.map(entry => [entry.provider, entry.id, entry.kind])).toEqual([
			["local", "existing", "override"],
			["local", "custom", "custom"],
		]);
		const { panel } = panelFor(editor);
		expect(view(panel)).toContain("local/existing");
		expect(view(panel)).toContain("local/custom");
		panel.handleInput("\r");
		expect(view(panel)).toContain("future");
		expect(view(panel)).toContain("read-only");
		expect(view(panel)).toContain("Before");
	});

	test("edits through the panel and retains unknown root, provider, model, compat and morphed thinking fields", async () => {
		const editor = await setup(originalConfig());
		const { panel, settled } = panelFor(editor);
		panel.handleInput("\r"); // existing override, selected name field
		panel.handleInput("\r");
		type(panel, "After");
		panel.handleInput("s");
		await settled();
		const saved = parseSettingsToml(await Bun.file(editor.file.path()).text());
		const expected = originalConfig();
		expected.providers.local.modelOverrides.existing.name = "After";
		expect(saved).toEqual(expected);
	});

	test("adds and deletes an override from an initially absent file through the panel", async () => {
		const editor = await setup();
		const { panel, settled } = panelFor(editor);
		panel.handleInput("\r"); // new override
		panel.handleInput("\r");
		type(panel, "local");
		panel.handleInput("j");
		panel.handleInput("\r");
		type(panel, "new");
		panel.handleInput("s");
		await settled();
		expect(editor.list()).toEqual([{ provider: "local", id: "new", kind: "override", fields: {} }]);
		panel.handleInput("g");
		panel.handleInput("g");
		panel.handleInput("x");
		expect(view(panel)).toContain("Keep entry");
		panel.handleInput("j");
		panel.handleInput("\r");
		panel.handleInput("\r");
		await settled();
		expect(editor.list()).toEqual([]);
		expect(parseSettingsToml(await Bun.file(editor.file.path()).text())).toEqual({ providers: {} });
	});

	test("adds a custom model and edits its native ID through the panel", async () => {
		const editor = await setup(originalConfig());
		const { panel, settled } = panelFor(editor);
		panel.handleInput("G");
		panel.handleInput("\r");
		panel.handleInput("\r");
		type(panel, "local");
		panel.handleInput("j");
		panel.handleInput("\r");
		type(panel, "ui-custom");
		panel.handleInput("s");
		await settled();
		expect(editor.list().some(entry => entry.kind === "custom" && entry.id === "ui-custom")).toBe(true);
		panel.handleInput("/");
		panel.handleInput("ui-custom");
		panel.handleInput("\x1b");
		panel.handleInput("\r");
		panel.handleInput("g");
		panel.handleInput("g");
		panel.handleInput("j");
		panel.handleInput("\r");
		type(panel, "ui-renamed");
		panel.handleInput("s");
		await settled();
		expect(editor.list().some(entry => entry.id === "ui-custom")).toBe(false);
		expect(editor.list().some(entry => entry.kind === "custom" && entry.id === "ui-renamed")).toBe(true);
	});

	test("renames an override without losing its unknown fields or overwriting another override", async () => {
		const editor = await setup(originalConfig());
		const entry = editor.list()[0];
		await editor.save({ ...entry, id: "renamed" }, entry);
		const renamed = editor.list().find(candidate => candidate.id === "renamed")!;
		expect(renamed.fields).toEqual(entry.fields);
		expect(editor.list().some(candidate => candidate.id === "existing")).toBe(false);
		await expect(editor.save({ provider: "local", id: "renamed", kind: "override", fields: {} })).rejects.toThrow(
			"already exists",
		);
	});

	test("persists custom additions, edits and deletion without touching provider credentials or siblings", async () => {
		const editor = await setup(originalConfig());
		editor.list();
		const entry: HubModelConfigEntry = {
			provider: "local",
			id: "added",
			kind: "custom",
			fields: { name: "Added", maxTokens: 512, input: ["text", "image"] },
		};
		await editor.save(entry);
		const added = editor.list().find(candidate => candidate.id === "added")!;
		await editor.save({ ...added, fields: { ...added.fields, maxTokens: 1024 } }, added);
		expect(editor.list().find(candidate => candidate.id === "added")?.fields.maxTokens).toBe(1024);
		await editor.remove(editor.list().find(candidate => candidate.id === "added")!);
		expect(parseSettingsToml(await Bun.file(editor.file.path()).text())).toEqual(originalConfig());
	});

	test("rejects invalid fields without replacing the file and leaves the draft editable", async () => {
		const editor = await setup(originalConfig());
		const entry = editor.list()[0];
		const before = await Bun.file(editor.file.path()).text();
		await expect(editor.save({ ...entry, fields: { ...entry.fields, api: "not-an-api" } }, entry)).rejects.toThrow();
		expect(await Bun.file(editor.file.path()).text()).toBe(before);
	});

	test("preserves disjoint disk edits and rejects stale overlapping writes", async () => {
		const editor = await setup(originalConfig());
		const entry = editor.list()[0];
		const external = originalConfig();
		external.providers.local.futureProvider = "external";
		await Bun.write(editor.file.path(), stringifySettingsToml(external));
		await editor.save({ ...entry, fields: { ...entry.fields, name: "UI" } }, entry);
		let saved = parseSettingsToml(await Bun.file(editor.file.path()).text()) as typeof external;
		expect(saved.providers.local.futureProvider).toBe("external");
		expect(saved.providers.local.modelOverrides.existing.name).toBe("UI");
		const reopened = editor.list()[0];
		saved.providers.local.modelOverrides.existing.name = "external name";
		await Bun.write(editor.file.path(), stringifySettingsToml(saved));
		await expect(
			editor.save({ ...reopened, fields: { ...reopened.fields, name: "stale UI" } }, reopened),
		).rejects.toThrow("changed on disk");
		saved = parseSettingsToml(await Bun.file(editor.file.path()).text()) as typeof saved;
		expect(saved.providers.local.modelOverrides.existing.name).toBe("external name");
	});

	test("retains top-level, provider and nested override comments through a native TOML save", async () => {
		const editor = await setup();
		await Bun.write(
			editor.file.path(),
			[
				"# Operator model notes",
				"[providers.local]",
				'baseUrl = "https://example.invalid/v1" # endpoint',
				'api = "openai-completions"',
				'auth = "none"',
				"# Nested model notes",
				"[providers.local.modelOverrides.existing]",
				'name = "Before" # display name',
				"maxTokens = 100 # output limit",
				"",
			].join("\n"),
		);
		const entry = editor.list()[0];
		await editor.save({ ...entry, fields: { ...entry.fields, name: "After" } }, entry);
		const source = await Bun.file(editor.file.path()).text();
		for (const comment of [
			"# Operator model notes",
			"# endpoint",
			"# Nested model notes",
			"# display name",
			"# output limit",
		]) {
			expect(source).toContain(comment);
		}
		expect(parseSettingsToml(source)).toMatchObject({
			providers: { local: { modelOverrides: { existing: { name: "After", maxTokens: 100 } } } },
		});
		expect(await Bun.file(path.join(path.dirname(editor.file.path()), "models.yml")).exists()).toBe(false);
	});

	test("schema-driven fields expose every native top-level field, including future schema additions", async () => {
		const store = await setup();
		for (const kind of ["override", "custom"] as const) {
			const fields = new ModelConfigFields({}, store.schema(kind));
			const bundle = getModelsConfigSchemaBundle();
			const expected = (kind === "custom" ? bundle.ModelDefinitionSchema : bundle.ModelOverrideSchema).props
				.map(prop => String(prop.key))
				.filter(key => key !== "id");
			expect(fields.items().map(item => item.value)).toEqual(expected.map(key => `field:${key}`));
			for (const item of fields.items()) expect(item.description).not.toContain("read-only");
		}
	});

	test("edits nested compat intersections, arbitrary record values, arrays, enums and thinking fields without raw config text", async () => {
		const store = await setup();
		const values: Record<string, unknown> = { future: { untouched: true } };
		const fields = new ModelConfigFields(values, store.schema("override"));
		fields.activate("field:compat");
		expect(fields.items().map(item => item.value)).toContain("field:supportsThinkingBindingControls");
		fields.activate("field:supportsStore");
		fields.activate("choice:0");
		fields.activate("field:extraBody");
		fields.activate("append");
		fields.input!.input.setValue("customFlag");
		fields.acceptInput();
		fields.activate("choice:2");
		fields.activate("choice:0");
		fields.back();
		fields.back();
		fields.activate("field:input");
		fields.activate("append");
		fields.activate("choice:1");
		fields.back();
		fields.activate("field:thinking");
		fields.activate("field:mode");
		fields.activate("choice:0");
		fields.activate("field:efforts");
		fields.activate("append");
		fields.activate("choice:1");
		fields.back();
		fields.back();
		fields.activate("field:cost");
		field(fields, "input", "0.25");
		fields.back();
		fields.activate("field:future"); // unknown cannot open or be removed
		fields.remove("field:future");
		expect(values).toEqual({
			future: { untouched: true },
			compat: { supportsStore: true, extraBody: { customFlag: true } },
			input: ["image"],
			thinking: { mode: "effort", efforts: ["low"] },
			cost: { input: 0.25 },
		});
	});

	test("clears fields and removes array items without deleting unknown neighbors", async () => {
		const store = await setup();
		const values: Record<string, unknown> = { name: "name", input: ["text", "image"], unknown: true };
		const fields = new ModelConfigFields(values, store.schema("override"));
		fields.remove("field:name");
		fields.activate("field:input");
		fields.remove("field:0");
		fields.back();
		expect(values).toEqual({ input: ["image"], unknown: true });
	});
});
