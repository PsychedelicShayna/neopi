import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { afterEach, beforeAll, describe, expect, test, beforeEach } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CURSOR_MARKER, getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import {
	MODEL_FACT_FIELDS,
	type ModelFactConfig,
	type ModelFactField,
	type ModelFactResolution,
} from "../src/config/model-facts";
import { ModelFactEditorComponent, type ModelFactEditorOptions } from "../src/modes/components/model-fact-editor";

const previousBindings = getKeybindings();
const editors: ModelFactEditorComponent[] = [];

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Dark test theme is unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	for (const editor of editors.splice(0)) editor.dispose();
	setKeybindings(previousBindings);
});

function config(): ModelFactConfig {
	return { enabled: true, sources: ["first", "second"], overrides: {} };
}

function resolution(contextWindow = 4096): ModelFactResolution {
	return {
		model: buildModel({
			provider: "local",
			id: "listed",
			name: "Listed",
			api: "ollama-chat",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow,
			maxTokens: 1024,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		}),
		provenance: {
			cost: { kind: "source", source: "first", provider: "reference", model: "foreign" },
			contextWindow: { kind: "provider", provider: "local", model: "listed" },
		},
		issues: [],
	};
}

function create(overrides: Partial<ModelFactEditorOptions> = {}): ModelFactEditorComponent {
	setKeybindings(KeybindingsManager.inMemory());
	const editor = new ModelFactEditorComponent({
		providers: [
			{ id: "local", models: [{ id: "listed" }] },
			{ id: "reference", models: [{ id: "foreign" }] },
		],
		provider: "local",
		modelId: "listed",
		config: config(),
		rows: 40,
		preview: () => resolution(),
		onSave: () => {},
		onClose: () => {},
		...overrides,
	});
	editor.focused = true;
	editors.push(editor);
	return editor;
}

function text(editor: ModelFactEditorComponent, width = 200): string {
	return stripVTControlCharacters(editor.render(width).join("\n").replaceAll(CURSOR_MARKER, ""));
}

function row(editor: ModelFactEditorComponent, index: number): void {
	editor.handleInput("g");
	editor.handleInput("g");
	for (let offset = 0; offset < index; offset++) editor.handleInput("\x1b[B");
	editor.handleInput("\r");
}

function field(editor: ModelFactEditorComponent, name: ModelFactField): void {
	row(editor, 4 + MODEL_FACT_FIELDS.indexOf(name));
}

function replace(editor: ModelFactEditorComponent, value: string): void {
	editor.handleInput("\x15");
	editor.handleInput(value);
	editor.handleInput("\r");
}

async function save(editor: ModelFactEditorComponent): Promise<void> {
	editor.handleInput("G");
	editor.handleInput("\r");
	await Promise.resolve();
}

describe("model fact editor", () => {
	test("shows ignored persisted-field warnings in the facts preview", async () => {
		const preview = resolution();
		preview.issues = ["Invalid model facts: local/listed.contextWindow must be a positive integer or null"];
		const editor = create({ preview: () => preview });
		await Promise.resolve();
		expect(text(editor)).toContain(
			"Warning: Invalid model facts: local/listed.contextWindow must be a positive integer or null",
		);
	});

	test("adds an unlisted model, writes literal facts, and saves a detached settings snapshot", async () => {
		const original = config();
		const saved: ModelFactConfig[] = [];
		let closed = 0;
		const editor = create({
			config: original,
			onSave: value => {
				saved.push(value);
			},
			onClose: () => {
				closed++;
			},
		});
		row(editor, 3);
		editor.handleInput("G");
		editor.handleInput("\r");
		editor.handleInput("custom/unknown");
		editor.handleInput("\r");
		field(editor, "contextWindow");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		replace(editor, "500000");
		await save(editor);
		expect(saved).toHaveLength(1);
		expect(saved[0]!.overrides["local/custom/unknown"]).toEqual({ contextWindow: 500000 });
		expect(original.overrides).toEqual({});
		expect(closed).toBe(1);
		saved[0]!.overrides["local/custom/unknown"]!.contextWindow = 1;
		expect(original.overrides).toEqual({});
	});

	test("borrows only the selected field and retains other model overrides", async () => {
		const draft = config();
		draft.overrides["local/listed"] = { contextWindow: 8192 };
		const saved: ModelFactConfig[] = [];
		const editor = create({
			config: draft,
			onSave: value => {
				saved.push(value);
			},
		});
		field(editor, "cost");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		editor.handleInput("\r");
		await save(editor);
		expect(saved[0]!.overrides["local/listed"]).toEqual({
			contextWindow: 8192,
			cost: { from: "reference/foreign" },
		});
	});

	test("edits literal values for every supported fact and validates invalid input before saving", async () => {
		const cases: readonly { name: ModelFactField; input: string; expected: unknown }[] = [
			{
				name: "cost",
				input: '{"input":2,"output":4,"cacheRead":0,"cacheWrite":0}',
				expected: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
			},
			{ name: "contextWindow", input: "null", expected: null },
			{ name: "maxTokens", input: "9000", expected: 9000 },
			{ name: "input", input: "text, image", expected: ["text", "image"] },
			{ name: "reasoning", input: "true", expected: true },
			{ name: "efforts", input: "low, high, xhigh", expected: ["low", "high", "xhigh"] },
		];
		for (const item of cases) {
			const saved: ModelFactConfig[] = [];
			const editor = create({
				onSave: value => {
					saved.push(value);
				},
			});
			field(editor, item.name);
			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			replace(editor, item.input);
			await save(editor);
			expect(saved[0]!.overrides["local/listed"]![item.name] as unknown).toEqual(item.expected);
		}
		const editor = create();
		field(editor, "contextWindow");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		replace(editor, "-4");
		expect(text(editor)).toContain("Context window");
		expect(editor.filterFocused).toBe(true);
		replace(editor, "6000");
		expect(editor.filterFocused).toBe(false);
	});

	test("returns a pinned field to automatic without removing an added model", async () => {
		const draft = config();
		draft.overrides["local/listed"] = { contextWindow: 8192 };
		const saved: ModelFactConfig[] = [];
		const editor = create({
			config: draft,
			onSave: value => {
				saved.push(value);
			},
		});
		field(editor, "contextWindow");
		editor.handleInput("g");
		editor.handleInput("g");
		editor.handleInput("\r");
		await save(editor);
		expect(saved[0]!.overrides).toEqual({ "local/listed": {} });
	});

	test("updates enabled and ordered sources without requiring an authenticated source", async () => {
		const saved: ModelFactConfig[] = [];
		const editor = create({
			onSave: value => {
				saved.push(value);
			},
		});
		row(editor, 0);
		row(editor, 1);
		replace(editor, "extension-only, public-source");
		await save(editor);
		expect(saved[0]!.enabled).toBe(false);
		expect(saved[0]!.sources).toEqual(["extension-only", "public-source"]);
	});

	test("Escape leaves text editing first, then closes without persisting drafts", () => {
		let saves = 0;
		let closes = 0;
		const editor = create({
			onSave: () => {
				saves++;
			},
			onClose: () => {
				closes++;
			},
		});
		row(editor, 1);
		editor.handleInput("hjklggG / ");
		editor.handleInput("\x1b");
		expect(closes).toBe(0);
		expect(text(editor)).toContain("first → second");
		editor.handleInput("\x1b");
		expect(closes).toBe(1);
		expect(saves).toBe(0);
	});

	test("ignores stale asynchronous previews and displays provenance for the winning preview", async () => {
		const first = Promise.withResolvers<ModelFactResolution>();
		const second = Promise.withResolvers<ModelFactResolution>();
		let calls = 0;
		const editor = create({ preview: () => (calls++ === 0 ? first.promise : second.promise) });
		row(editor, 0);
		second.resolve(resolution(7777));
		await Promise.resolve();
		first.resolve(resolution(1111));
		await Promise.resolve();
		const rendered = text(editor);
		expect(rendered).toContain("7777");
		expect(rendered).not.toContain("1111");
		expect(rendered).toContain("source · first · reference/foreign");
		expect(rendered).toContain("provider · local/listed");
	});

	test("surfaces preview failures and a later refresh can recover", async () => {
		let fail = true;
		const editor = create({
			preview: () => {
				if (fail) throw new Error("Source unavailable");
				return resolution();
			},
		});
		expect(text(editor)).toContain("Preview failed: Source unavailable");
		fail = false;
		row(editor, 4 + MODEL_FACT_FIELDS.length);
		await Promise.resolve();
		expect(text(editor)).toContain("Resolved preview");
		expect(text(editor)).not.toContain("Source unavailable");
	});

	test("blocks duplicate pending saves and leaves a rejected save open for retry", async () => {
		const pending = Promise.withResolvers<void>();
		let saves = 0;
		let closes = 0;
		const editor = create({
			onSave: () => {
				saves++;
				return saves === 1 ? pending.promise : undefined;
			},
			onClose: () => {
				closes++;
			},
		});
		await save(editor);
		editor.handleInput("\r");
		expect(saves).toBe(1);
		expect(editor.blocksMenuHistory).toBe(true);
		pending.reject(new Error("Settings are read-only"));
		await Promise.resolve();
		expect(text(editor)).toContain("Settings are read-only");
		expect(closes).toBe(0);
		await save(editor);
		expect(saves).toBe(2);
		expect(closes).toBe(1);
	});

	test("native controls edit and submit through the same settings callback", async () => {
		const saved: ModelFactConfig[] = [];
		const editor = create({
			onSave: value => {
				saved.push(value);
			},
		});
		const action = (act: string): void => editor.handleNativeEvent({ type: "action", key: "", act, mods: [] });
		action("sources");
		const before = "first, second";
		const after = "extension-only";
		editor.handleNativeEvent({
			type: "edit",
			key: "",
			from: 0,
			to: before.length,
			text: after,
			cursor: after.length,
			len: before.length,
		});
		action("submit-field");
		action("save");
		await Promise.resolve();
		expect(saved[0]!.sources).toEqual(["extension-only"]);
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
