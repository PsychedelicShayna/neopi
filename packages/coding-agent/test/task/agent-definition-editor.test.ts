import { beforeAll, describe, expect, test } from "bun:test";
import {
	AgentDefinitionEditor,
	type AgentDefinitionDraft,
	type AgentEditorDeps,
} from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	parseAgentDefinitionDocument,
	serializeAgentDefinitionDocument,
} from "@oh-my-pi/pi-coding-agent/task/agent-definition-document";
import { listAgentDefinitionTools } from "@oh-my-pi/pi-coding-agent/tools/tool-catalog";
import { isJTDSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";

const tui = { requestRender() {}, stop() {}, start() {}, terminal: { rows: 35 } } as unknown as TUI;
const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const ANSI = /\x1b\[[0-9;]*m/g;
beforeAll(async () => {
	await initTheme(false);
});

interface SaveCall {
	draft: AgentDefinitionDraft;
	scope: "project" | "user";
	asCopy?: boolean;
}

function setup(
	definition: AgentDefinitionDraft = { name: "draft", description: "A draft", systemPrompt: "Be useful." },
	overrides: Partial<AgentEditorDeps> = {},
) {
	let closed = false;
	let externalValue: string | undefined;
	const saves: SaveCall[] = [];
	const requests: Parameters<AgentEditorDeps["generate"]>[0][] = [];
	const editor = new AgentDefinitionEditor(
		tui,
		{
			tools: listAgentDefinitionTools([{ name: "extension_tool", description: "Run the extension operation." }]),
			readOnlyTools: ["read", "grep"],
			roles: [{ id: "smol", label: "Smol", description: "Fast model" }],
			listAdvisors: async () => [
				{
					name: "velvet",
					scope: "project-omp",
					config: { name: "velvet", model: "@advisor", instructions: "Watch closely." },
				},
			],
			parse: parseAgentDefinitionDocument,
			serialize: serializeAgentDefinitionDocument,
			generate: async request => {
				requests.push(request);
				return {
					fields: request.target === "name" ? { name: "generated" } : { description: "Generated description" },
					conversationId: "retained",
				};
			},
			existing: [{ name: "base", description: "A base", systemPrompt: "Base instructions" }],
			save: async (draft, scope, options) => {
				saves.push({
					draft: parseAgentDefinitionDocument(serializeAgentDefinitionDocument(draft)),
					scope,
					asCopy: options?.asCopy,
				});
			},
			externalEditor: async () => externalValue ?? null,
			outputSchemaDialect: schema => (isJTDSchema(schema) ? "jtd" : "json-schema"),
			...overrides,
		},
		definition,
		() => {
			closed = true;
		},
	);
	const rows = () => {
		const node = editor.describe(cx);
		if (node.k !== "picker") throw new Error(`Expected a picker, got ${node.k}`);
		return node.p?.items ?? [];
	};
	const activate = (id: string) => editor.handleNativeEvent({ type: "activate", key: "", item: id });
	const select = (id: string) => editor.handleNativeEvent({ type: "select", key: "", item: id });
	const submit = () => editor.handleNativeEvent({ type: "action", key: "", act: "submit", mods: [] });
	/** Multiline fields go through the external editor path, as a user's $EDITOR would. */
	const fill = async (id: string, value: string) => {
		externalValue = value;
		activate(id);
		editor.handleNativeEvent({ type: "action", key: "", act: "external", mods: [] });
		await Bun.sleep(0);
		submit();
		externalValue = undefined;
	};
	/** Single-line fields are typed and submitted with Enter. */
	const type = (value: string) => {
		editor.handleInput(value);
		editor.handleInput("\r");
	};
	const back = () => editor.handleInput("\x1b");
	const screen = () => editor.render(140).join("\n").replace(ANSI, "");
	return {
		editor,
		rows,
		activate,
		select,
		fill,
		type,
		submit,
		back,
		screen,
		requests,
		saves,
		closed: () => closed,
		setExternal: (value: string) => {
			externalValue = value;
		},
	};
}

describe("agent definition editor", () => {
	test("inline authoring help preserves the draft and exposes no function-key actions", () => {
		const ui = setup({ name: "", description: "A draft", systemPrompt: "Be useful." });
		ui.activate("name");
		ui.type("unsaved-draft");
		ui.select("description");
		expect(ui.screen()).toContain("Shown to the delegating agent");
		const before = ui.screen();
		ui.editor.handleInput("\x1bOP");
		expect(ui.screen()).toBe(before);
		const root = ui.editor.describe(cx);
		if (root.k !== "picker") throw new Error(`Expected a picker, got ${root.k}`);
		expect(root.p?.actions?.flatMap(action => action.keys ?? [])).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/^f\d+$/i)]),
		);
		expect(root.p?.selected).toBe("description");
		expect(ui.editor.definition.name).toBe("unsaved-draft");
		expect(ui.closed()).toBe(false);
	});

	test("Ctrl+G opens the backing file on detail and edits the draft on text screens", async () => {
		let opens = 0;
		const ui = setup(undefined, {
			openDefinitionFile: async () => {
				opens++;
			},
			externalEditor: async raw => `${raw} External draft change.`,
		});
		expect(ui.screen()).toContain("Ctrl+G open file");
		ui.editor.handleInput("\x07");
		await Promise.resolve();
		expect(opens).toBe(1);
		ui.editor.handleNativeEvent({ type: "action", key: "", act: "open-file", mods: [] });
		await Promise.resolve();
		expect(opens).toBe(2);
		ui.activate("systemPrompt");
		ui.editor.handleInput("\x07");
		await Promise.resolve();
		ui.submit();
		expect(ui.editor.definition.systemPrompt).toBe("Be useful. External draft change.");
		expect(opens).toBe(2);
		expect(ui.rows().find(row => row.id === "open-file")?.disabled).toBe(true);
		ui.editor.handleInput("\x07");
		expect(opens).toBe(2);
		expect(ui.screen()).toContain("Save or discard draft changes before opening the backing file.");
	});

	test("embedded detail exposes live field sections and respects the parent height", () => {
		const ui = setup(undefined, { embedded: true });
		expect(ui.editor.rosterVisible).toBe(true);
		expect(ui.editor.render(70, 9)).toHaveLength(9);
		expect(ui.editor.render(70, 2)).toHaveLength(2);
		const identity = ui.editor.detailSections().find(section => section.id === "identity");
		expect(identity?.rows.find(row => row.id === "inherits")?.disabled).toBeDefined();
		ui.select("description");
		expect(ui.editor.selectedDetailItem).toBe("description");
		ui.activate("description");
		expect(ui.editor.rosterVisible).toBe(false);
		expect(ui.editor.detailSections()).toEqual([]);
		ui.back();
		expect(ui.editor.rosterVisible).toBe(true);
	});

	test("Inherits is rendered but cannot be selected or persisted", () => {
		const ui = setup();
		expect(ui.screen()).toContain("not yet available");
		expect(ui.rows().find(row => row.id === "inherits")).toMatchObject({ disabled: true });
		ui.select("systemPrompt");
		ui.select("inherits");
		ui.activate("inherits");
		ui.editor.handleInput("\x1b[B");
		const root = ui.editor.describe(cx);
		if (root.k !== "picker") throw new Error(`Expected a picker, got ${root.k}`);
		expect(root.p?.selected).toBe("model");
		expect(ui.editor.definition).not.toHaveProperty("inherits");
	});

	test("lists every manifest field for new and existing definitions; a clean draft closes on Esc", () => {
		const expected = [
			"name",
			"description",
			"systemPrompt",
			"harness",
			"model",
			"thinkingLevel",
			"prewalk",
			"advisor",
			"spawns",
			"tools",
			"output",
			"structured",
			"blocking",
			"autoloadSkills",
			"readSummarize",
		];
		for (const draft of [
			{ name: "", description: "", systemPrompt: "" },
			{ name: "existing", description: "Existing", systemPrompt: "Instructions" },
		]) {
			const ui = setup(draft);
			expect(ui.rows().map(row => row.id)).toEqual(expect.arrayContaining(expected));
			ui.back();
			expect(ui.closed()).toBe(true);
		}
	});

	test("tool checklist offers catalog, hidden and extension tools and round-trips an explicit list", async () => {
		const ui = setup();
		ui.activate("tools");
		expect(ui.rows().map(row => row.id)).toEqual(
			expect.arrayContaining([
				"__defaults",
				"__readonly",
				"__none",
				"item:read",
				"item:yield",
				"item:extension_tool",
			]),
		);
		ui.activate("__none");
		ui.activate("item:read");
		ui.activate("item:extension_tool");
		ui.back(); // Esc applies the checklist
		expect(ui.editor.definition.tools).toEqual(["read", "extension_tool"]);
		ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.draft.tools).toEqual(["read", "extension_tool"]);
		expect(ui.closed()).toBe(true);
	});

	test("the read-only preset selects only read-only catalog tools; default selection omits the field", () => {
		const ui = setup({ name: "d", description: "D", systemPrompt: "", tools: ["bash"] });
		ui.activate("tools");
		ui.activate("__readonly");
		ui.activate(ui.rows().find(row => row.id === "__done")!.id);
		expect(ui.editor.definition.tools).toEqual(["read", "grep"]);
		ui.activate("tools");
		ui.activate("__defaults");
		ui.back();
		expect(ui.editor.definition.tools).toBeUndefined();
		ui.editor.dispose();
	});

	test("ordinary tool toggles grant and remove explicitly without silently replacing omitted defaults", () => {
		const ui = setup();
		ui.activate("tools");
		ui.back();
		expect(ui.editor.definition.tools).toBeUndefined();
		expect(ui.editor.dirty).toBe(false);
		ui.activate("tools");
		ui.activate("item:read");
		ui.activate("item:bash");
		ui.activate("item:read");
		ui.activate("__done");
		expect(ui.editor.definition.tools).toEqual(["bash"]);
		ui.activate("tools");
		ui.activate("item:bash");
		ui.back();
		expect(ui.editor.definition.tools).toEqual([]);
		ui.activate("tools");
		ui.activate("__defaults");
		ui.back();
		expect(ui.editor.definition.tools).toBeUndefined();
	});

	test("spawns keep selection order, accept unknown names and offer to create a missing target", () => {
		const created: string[] = [];
		const ui = setup(undefined, { createMissing: name => created.push(name) });
		ui.activate("spawns");
		ui.activate("item:base");
		ui.activate("__custom");
		ui.type("later");
		expect(ui.rows().find(row => row.id === "item:later")?.label).toContain("[2]");
		ui.back();
		expect(ui.editor.definition.spawns).toEqual(["base", "later"]);
		expect(ui.rows().map(row => row.id)).toContain("create:later");
		ui.activate("create:later");
		expect(created).toEqual([]); // unsaved draft is never replaced silently
		ui.activate("spawns");
		ui.activate("__any");
		ui.back();
		expect(ui.editor.definition.spawns).toBe("*");
		ui.editor.dispose();
	});

	test("model fallbacks are added from roles and selectors, then reordered", () => {
		const ui = setup();
		ui.activate("model");
		ui.activate("add-pattern");
		ui.type("anthropic/claude-x:high");
		ui.activate("add-role");
		ui.activate("@smol");
		expect(ui.editor.definition.model).toEqual(["anthropic/claude-x:high", "@smol"]);
		ui.activate("entry:1");
		ui.activate("up");
		expect(ui.editor.definition.model).toEqual(["@smol", "anthropic/claude-x:high"]);
		ui.activate("entry:1");
		ui.activate("remove");
		expect(ui.editor.definition.model).toEqual(["@smol"]);
		ui.editor.dispose();
	});

	test("prewalk and booleans write the manifest values the parser reads back", async () => {
		const ui = setup();
		ui.activate("prewalk");
		ui.activate("pattern");
		ui.type("@smol");
		ui.activate("blocking");
		ui.activate("readSummarize");
		ui.activate("readSummarize");
		ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.draft).toMatchObject({ prewalk: "@smol", blocking: true, readSummarize: false });
	});

	test("builds nested required fields, types and descriptions and round-trips the output schema", async () => {
		const ui = setup();
		ui.activate("output");
		ui.activate("enable");
		await ui.fill("add-field", "result");
		ui.activate("property:result");
		ui.activate("required");
		ui.activate("type");
		ui.activate("object");
		await ui.fill("add-field", "score");
		ui.activate("property:score");
		ui.activate("required");
		ui.activate("type");
		ui.activate("number");
		await ui.fill("description", "Confidence rating");
		ui.back();
		ui.back();
		ui.back(); // score → result → output → definition
		ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.draft.output).toEqual({
			type: "object",
			required: ["result"],
			properties: {
				result: {
					type: "object",
					required: ["score"],
					properties: { score: { type: "number", description: "Confidence rating" } },
				},
			},
		});
	});

	test("schema keyword forms express enums without raw schema editing", async () => {
		const ui = setup();
		ui.activate("output");
		ui.activate("enable");
		ui.activate("keywords");
		await ui.fill("add", "enum");
		ui.activate("enum");
		ui.activate("array");
		ui.activate("add");
		ui.activate("0");
		await ui.fill("text", "approved");
		for (let i = 0; i < 5; i++) ui.back();
		expect(ui.editor.definition.output).toMatchObject({ enum: ["approved"] });
		ui.editor.dispose();
	});

	test("an output schema pasted as JSON replaces the structured schema", async () => {
		const ui = setup();
		ui.activate("output");
		await ui.fill("json", '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}');
		expect(ui.editor.definition.output).toEqual({
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		});
		ui.editor.dispose();
	});

	test("builds JTD optional and required integer fields with metadata descriptions", async () => {
		const ui = setup();
		ui.activate("output");
		ui.activate("enable");
		ui.activate("format");
		await ui.fill("add-field", "count");
		ui.activate("property:count");
		ui.activate("required");
		ui.activate("type");
		ui.activate("uint32");
		await ui.fill("description", "Item count");
		ui.back();
		ui.back();
		ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.draft.output).toEqual({
			properties: { count: { type: "uint32", metadata: { description: "Item count" } } },
			optionalProperties: {},
		});
	});

	test("raw file editing updates rich fields and preserves unrelated schema keywords", async () => {
		const ui = setup();
		const output = {
			type: "object",
			additionalProperties: false,
			properties: {
				items: {
					type: "array",
					items: {
						anyOf: [
							{ type: "string", minLength: 2 },
							{ type: "number", minimum: 0 },
						],
					},
				},
			},
			required: ["items"],
			$defs: { label: { type: "string", enum: ["x", "y"] } },
		};
		await ui.fill(
			"raw",
			serializeAgentDefinitionDocument({
				name: "raw-agent",
				description: "Raw edited",
				systemPrompt: "New instructions",
				tools: ["read"],
				model: ["@task", "@smol"],
				output,
			}),
		);
		expect(ui.editor.definition).toMatchObject({
			name: "raw-agent",
			tools: ["read"],
			model: ["@task", "@smol"],
			output,
		});
		ui.activate("tools");
		ui.activate("item:bash");
		ui.back();
		ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.draft).toMatchObject({ name: "raw-agent", tools: ["read", "bash"], output });
	});

	test("named advisors carry their source scope; a private advisor exposes every configurable field", async () => {
		const ui = setup();
		ui.activate("advisor");
		ui.activate("named");
		await Bun.sleep(0);
		expect(ui.rows()[0]).toMatchObject({ label: "velvet", detail: "project-omp · @advisor" });
		ui.activate(ui.rows()[0]!.id);
		expect(ui.editor.definition.advisor).toEqual({ ref: "velvet", scope: "project-omp" });
		ui.activate("advisor");
		ui.activate("inline");
		expect(ui.rows().map(row => row.id)).toEqual(
			expect.arrayContaining([
				"name",
				"model",
				"instructions",
				"systemPrompt",
				"enabled",
				"includeThinking",
				"maxNotesPerUpdate",
				"reviewMode",
				"reviewInterval",
				"syncBacklog",
				"scope",
				"tools",
				"delivery:nit",
				"delivery:concern",
				"delivery:blocker",
			]),
		);
		await ui.fill("instructions", "Private instructions");
		ui.activate("delivery:concern");
		ui.activate("on-yield");
		expect(ui.editor.definition.advisor).toMatchObject({
			inline: { instructions: "Private instructions", delivery: { concern: "on-yield" } },
		});
		ui.back();
		ui.back();
		ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.draft.advisor).toMatchObject({
			inline: { instructions: "Private instructions", delivery: { concern: "on-yield" } },
		});
	});

	test("R adds a comment to field generation, retains the conversation, and never claims text field keys", async () => {
		const ui = setup();
		ui.select("name");
		ui.editor.handleInput("R");
		ui.setExternal("Make the name specific");
		ui.editor.handleNativeEvent({ type: "action", key: "", act: "external", mods: [] });
		await Bun.sleep(0);
		ui.submit();
		await Bun.sleep(0);
		expect(ui.requests[0]).toMatchObject({
			target: "name",
			comment: "Make the name specific",
			definition: { name: "draft", description: "A draft" },
		});
		ui.select("description");
		ui.editor.handleInput("r");
		await Bun.sleep(0);
		expect(ui.requests[1]).toMatchObject({ target: "description", conversationId: "retained" });
		ui.activate("description");
		ui.editor.handleInput("r");
		ui.editor.handleInput("R");
		expect(ui.requests).toHaveLength(2);
		ui.back(); // leaves the text field
		ui.back(); // generated changes are unsaved: the leave guard asks
		expect(ui.closed()).toBe(false);
		ui.activate("discard");
		expect(ui.closed()).toBe(true);
	});

	test("a field's own screens regenerate that field", async () => {
		const ui = setup();
		ui.activate("output");
		ui.activate("enable");
		ui.activate("keywords");
		await ui.fill("add", "enum");
		ui.activate("enum");
		ui.activate("array");
		ui.activate("add");
		ui.activate("0");
		ui.select("text");
		ui.editor.handleInput("r");
		await Bun.sleep(0);
		expect(ui.requests[0]?.target).toBe("output");
		ui.activate("advisor");
		ui.activate("inline");
		ui.activate("reviewMode");
		ui.select("turn");
		ui.editor.handleInput("\x12"); // Ctrl-R opens the comment dialog.
		ui.setExternal("Review once per turn");
		ui.editor.handleNativeEvent({ type: "action", key: "", act: "external", mods: [] });
		await Bun.sleep(0);
		ui.submit();
		await Bun.sleep(0);
		expect(ui.requests[1]).toMatchObject({
			target: "advisor",
			comment: "Review once per turn",
			conversationId: "retained",
		});
		ui.editor.dispose();
	});

	test("generate from existing sends selected definitions and preset fields", async () => {
		const ui = setup({ name: "preset", description: "", systemPrompt: "", blocking: false, tools: [] });
		ui.activate("from-existing");
		ui.activate("item:base:0");
		ui.activate("generate");
		ui.submit(); // no extra comment
		await Bun.sleep(0);
		expect(ui.requests[0]).toMatchObject({
			target: "all",
			definition: { name: "preset", blocking: false, tools: [] },
			baseDefinitions: [{ name: "base", systemPrompt: "Base instructions" }],
		});
		expect(ui.requests[0]?.comment).toBeUndefined();
		ui.editor.dispose();
	});

	test("generation can combine an existing agent, other sources, and free text without choosing a model", async () => {
		const sources = [
			{ kind: "advisor", name: "base", content: "Review correctness." },
			{ kind: "prompt", name: "example", description: "An example", content: "Show your work." },
			{ kind: "agent", name: "shadow", content: "Full scoped definition." },
			{ kind: "skill", name: "unused", content: "Do not select." },
		];
		const ui = setup(undefined, {
			listGenerationSources: async () => sources,
			existing: [
				{ name: "base", description: "A base", systemPrompt: "Base instructions" },
				{ name: "shadow", description: "Duplicate", systemPrompt: "Fallback" },
			],
		});
		ui.activate("from-existing");
		await Promise.resolve();
		expect(ui.rows().map(row => row.label)).toEqual(
			expect.arrayContaining([
				"[ ] agent: base",
				"[ ] advisor: base",
				"[ ] prompt: example",
				"[ ] agent: shadow",
				"[ ] skill: unused",
			]),
		);
		expect(ui.rows().filter(row => row.label === "[ ] agent: shadow")).toHaveLength(1);
		ui.activate("item:base:0");
		ui.activate("item:source:0");
		ui.activate("item:source:1");
		ui.activate("item:source:2");
		ui.activate("item:source:3");
		ui.activate("item:source:3");
		ui.activate("generate");
		ui.editor.pasteText("Combine the agent and the examples.");
		ui.submit();
		expect(ui.requests).toHaveLength(1);
		expect(ui.requests[0]).toMatchObject({
			target: "all",
			comment: "Combine the agent and the examples.",
			baseDefinitions: [{ name: "base" }],
			sources: sources.slice(0, 3),
		});
	});

	test("Esc backs out of field dialogs and nested pages, then prompts before closing a dirty draft", () => {
		const ui = setup();
		const rowIds = () => ui.rows().map(row => row.id);
		const fields = rowIds();
		const title = () => {
			const node = ui.editor.describe(cx);
			if (node.k !== "picker") throw new Error(`Expected a picker, got ${node.k}`);
			return node.p?.title;
		};

		ui.activate("description");
		expect(ui.screen()).toContain("Description · Enter save · Esc cancel");
		ui.back();
		expect(ui.closed()).toBe(false);
		expect(rowIds()).toEqual(fields);

		ui.activate("output");
		ui.activate("enable");
		ui.activate("items");
		expect(title()).toBe("Array items");
		ui.back();
		expect(ui.closed()).toBe(false);
		expect(title()).toBe("Structured output");
		expect(rowIds()).toContain("enable");
		ui.back();
		expect(ui.closed()).toBe(false);
		expect(rowIds()).toEqual(fields);

		ui.activate("advisor");
		expect(title()).toBe("Advisor");
		ui.activate("inline");
		expect(title()).toBe("Private advisor — saved in this definition only");
		ui.back();
		expect(ui.closed()).toBe(false);
		expect(title()).toBe("Advisor");
		expect(rowIds()).toContain("inline");
		ui.back();
		expect(ui.closed()).toBe(false);
		expect(rowIds()).toEqual(fields);

		ui.back();
		expect(ui.closed()).toBe(false);
		expect(title()).toBe("Unsaved changes");
		expect(ui.rows().map(row => row.label)).toEqual(["Keep editing", "Save and close", "Discard changes"]);
		ui.editor.dispose();
	});

	test("Esc cancels generation without applying its late result", async () => {
		const pending = Promise.withResolvers<{ fields: Partial<AgentDefinitionDraft> }>();
		const ui = setup(undefined, { generate: () => pending.promise });
		ui.select("name");
		ui.editor.handleInput("r");
		expect(ui.editor.busy).toBe(true);
		ui.back();
		expect(ui.editor.busy).toBe(false);
		pending.resolve({ fields: { name: "late-write" } });
		await Bun.sleep(0);
		expect(ui.editor.definition.name).toBe("draft");
		ui.back();
		expect(ui.closed()).toBe(true);
	});

	test("save as copy writes a new definition under a new name", async () => {
		const ui = setup();
		ui.editor.handleInput("c");
		ui.editor.handleInput("\r");
		await Bun.sleep(0);
		expect(ui.saves[0]).toMatchObject({ draft: { name: "draft-copy" }, asCopy: true });
		expect(ui.closed()).toBe(true);
	});

	test("delete asks for confirmation before removing the file", async () => {
		let removed = 0;
		const ui = setup(undefined, {
			remove: async () => {
				removed++;
			},
		});
		ui.activate("delete");
		ui.activate("cancel");
		expect(removed).toBe(0);
		ui.activate("delete");
		ui.activate("confirm");
		await Bun.sleep(0);
		expect(removed).toBe(1);
		expect(ui.closed()).toBe(true);
	});

	test("the preview shows the inspection and marks the field a warning concerns", () => {
		const ui = setup(undefined, {
			inspect: () => ({
				facts: [{ k: "Spawns", v: "any type (default task)" }],
				findings: [{ level: "warn", text: "The task tool without spawns grants everything.", field: "spawns" }],
			}),
		});
		const screen = ui.screen();
		expect(screen).toContain("What the harness will do");
		expect(screen).toContain("any type (default task)");
		expect(screen).toContain("The task tool without spawns grants everything.");
		expect(ui.rows().find(row => row.id === "spawns")?.label).toContain("⚠");
		ui.editor.dispose();
	});
});
