import { beforeAll, describe, expect, test } from "bun:test";
import { AgentDefinitionEditor, AGENT_DEFINITION_FIELDS, type AgentDefinitionDraft, type AgentEditorDeps } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { parseAgentDefinitionDocument, serializeAgentDefinitionDocument } from "@oh-my-pi/pi-coding-agent/task/agent-definition-document";
import { listAgentDefinitionTools } from "@oh-my-pi/pi-coding-agent/tools/tool-catalog";
import { isJTDSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";

const tui = { requestRender() {}, stop() {}, start() {}, terminal: { rows: 35 } } as unknown as TUI;
const cx: DescribeContext = { supports: () => true, feature: () => true } as DescribeContext;
beforeAll(async () => { await initTheme(false); });

function setup(definition: AgentDefinitionDraft = { name: "draft", description: "A draft", systemPrompt: "Be useful." }, overrides: Partial<AgentEditorDeps> = {}) {
	let closed = false;
	let externalValue: string | undefined;
	const saves: AgentDefinitionDraft[] = [];
	const requests: Parameters<AgentEditorDeps["generate"]>[0][] = [];
	const editor = new AgentDefinitionEditor(tui, {
		tools: listAgentDefinitionTools([{ name: "extension_tool", description: "Run the extension operation." }]),
		listAdvisors: async () => [{ name: "velvet", scope: "project-omp", config: { name: "velvet", model: "@advisor", instructions: "Watch closely." } }],
		parse: parseAgentDefinitionDocument,
		serialize: serializeAgentDefinitionDocument,
		generate: async request => { requests.push(request); return { fields: request.target === "name" ? { name: "generated" } : { description: "Generated description" }, conversationId: "retained" }; },
		existing: [{ name: "base", description: "A base", systemPrompt: "Base instructions" }],
		save: async draft => { saves.push(parseAgentDefinitionDocument(serializeAgentDefinitionDocument(draft))); },
		externalEditor: async () => externalValue ?? null,
		outputSchemaDialect: schema => isJTDSchema(schema) ? "jtd" : "json-schema",
		...overrides,
	}, definition, () => { closed = true; });
	const rows = () => { const node = editor.describe(cx); if (node.k !== "picker") throw new Error(`Expected a form, got ${node.k}`); return node.p?.items ?? []; };
	const activate = (id: string) => editor.handleNativeEvent({ type: "activate", key: "", item: id });
	const select = (id: string) => editor.handleNativeEvent({ type: "select", key: "", item: id });
	const submit = () => editor.handleNativeEvent({ type: "action", key: "", act: "submit", mods: [] });
	const fill = async (id: string, value: string) => {
		externalValue = value; activate(id);
		editor.handleNativeEvent({ type: "action", key: "", act: "external", mods: [] });
		await Bun.sleep(0); submit(); externalValue = undefined;
	};
	const back = () => editor.handleInput("\x1b");
	return { editor, rows, activate, select, fill, submit, back, requests, saves, closed: () => closed, setExternal: (value: string) => { externalValue = value; } };
}

describe("agent definition rich editor", () => {
	test("shows every supported field even when absent, in the same editor used for a new definition", () => {
		const expected = ["name", "description", "systemPrompt", "harness", "model", "thinkingLevel", "prewalk", "advisor", "spawns", "tools", "output", "structured", "blocking", "autoloadSkills", "readSummarize"];
		for (const draft of [{ name: "", description: "", systemPrompt: "" }, { name: "existing", description: "Existing", systemPrompt: "Instructions" }]) {
			const ui = setup(draft);
			expect(ui.rows().map(row => row.id)).toEqual(expect.arrayContaining(expected));
			expect(AGENT_DEFINITION_FIELDS.map(field => field.key).sort()).toEqual([...expected].sort());
			ui.back(); expect(ui.closed()).toBe(true);
		}
	});

	test("lists registry and dormant built-in tools and round-trips explicit checkbox selections through Markdown", async () => {
		const ui = setup(); ui.activate("tools");
		expect(ui.rows().map(row => row.id)).toEqual(expect.arrayContaining(["read", "bash", "edit", "task", "yield", "extension_tool"]));
		ui.activate("defaults"); // defaults → explicit empty allowlist
		ui.activate("read"); ui.activate("extension_tool"); ui.back(); ui.activate("save");
		await Bun.sleep(0);
		expect(ui.saves[0]?.tools).toEqual(["read", "extension_tool"]);
		expect(ui.closed()).toBe(true);
	});

	test("builds nested required fields, types and descriptions and round-trips the output schema", async () => {
		const ui = setup(); ui.activate("output"); ui.activate("enable");
		await ui.fill("add-field", "result"); ui.activate("property:result"); ui.activate("required");
		ui.activate("type"); ui.activate("object");
		await ui.fill("add-field", "score"); ui.activate("property:score"); ui.activate("required");
		ui.activate("type"); ui.activate("number"); await ui.fill("description", "Confidence rating");
		ui.back(); ui.back(); ui.back(); // score → result → output → definition
		ui.activate("save"); await Bun.sleep(0);
		expect(ui.saves[0]?.output).toEqual({ type: "object", required: ["result"], properties: { result: { type: "object", required: ["score"], properties: { score: { type: "number", description: "Confidence rating" } } } } });
	});

	test("schema keyword forms express arrays and union constraints without raw schema editing", async () => {
		const ui = setup(); ui.activate("output"); ui.activate("enable"); ui.activate("keywords");
		await ui.fill("add", "enum"); ui.activate("enum"); ui.activate("array"); ui.activate("add"); ui.activate("0");
		await ui.fill("text", "approved");
		// enum value editor → list → enum kind → schema keywords → output → root
		for (let i = 0; i < 5; i++) ui.back();
		expect(ui.editor.definition.output).toMatchObject({ enum: ["approved"] });
		ui.editor.dispose();
	});

	test("builds JTD optional and required integer fields with metadata descriptions", async () => {
		const ui = setup(); ui.activate("output"); ui.activate("enable"); ui.activate("format");
		await ui.fill("add-field", "count"); ui.activate("property:count"); ui.activate("required");
		ui.activate("type"); ui.activate("uint32"); await ui.fill("description", "Item count");
		ui.back(); ui.back(); ui.activate("save"); await Bun.sleep(0);
		expect(ui.saves[0]?.output).toEqual({ properties: { count: { type: "uint32", metadata: { description: "Item count" } } }, optionalProperties: {} });
	});

	test("raw file editing updates rich fields and preserves every unrelated schema keyword", async () => {
		const ui = setup();
		const output = { type: "object", additionalProperties: false, properties: { items: { type: "array", items: { anyOf: [{ type: "string", minLength: 2 }, { type: "number", minimum: 0 }] } } }, required: ["items"], $defs: { label: { type: "string", enum: ["x", "y"] } } };
		await ui.fill("raw", serializeAgentDefinitionDocument({ name: "raw-agent", description: "Raw edited", systemPrompt: "New instructions", tools: ["read"], model: ["@task", "@smol"], output }));
		expect(ui.editor.definition).toMatchObject({ name: "raw-agent", description: "Raw edited", systemPrompt: "New instructions", tools: ["read"], model: ["@task", "@smol"], output });
		ui.activate("tools"); ui.activate("bash"); ui.back(); ui.activate("save"); await Bun.sleep(0);
		expect(ui.saves[0]).toMatchObject({ name: "raw-agent", tools: ["read", "bash"], output });
	});

	test("named advisor selection includes source scope and a private advisor exposes all configurable fields", async () => {
		const ui = setup(); ui.activate("advisor"); ui.activate("named"); await Bun.sleep(0);
		expect(ui.rows()[0]).toMatchObject({ label: "velvet", detail: "project-omp" });
		ui.activate("0"); expect(ui.editor.definition.advisor).toEqual({ ref: "velvet", scope: "project-omp" });
		ui.activate("inline");
		expect(ui.rows().map(row => row.id)).toEqual(expect.arrayContaining(["name", "model", "instructions", "systemPrompt", "enabled", "includeThinking", "maxNotesPerUpdate", "reviewMode", "reviewInterval", "syncBacklog", "scope", "tools", "delivery:nit", "delivery:concern", "delivery:blocker"]));
		await ui.fill("instructions", "Private instructions"); ui.activate("delivery:concern"); ui.activate("on-yield");
		expect(ui.editor.definition.advisor).toMatchObject({ inline: { instructions: "Private instructions", delivery: { concern: "on-yield" } } });
		ui.back(); ui.back(); ui.activate("save"); await Bun.sleep(0);
		expect(ui.saves[0]?.advisor).toMatchObject({ inline: { instructions: "Private instructions", delivery: { concern: "on-yield" } } });
	});

	test("R adds a comment to field generation, retains the conversation, and never claims text editor keys", async () => {
		const ui = setup(); ui.select("name"); ui.editor.handleInput("R");
		ui.setExternal("Make the name specific"); ui.editor.handleNativeEvent({ type: "action", key: "", act: "external", mods: [] }); await Bun.sleep(0); ui.submit(); await Bun.sleep(0);
		expect(ui.requests[0]).toMatchObject({ target: "name", comment: "Make the name specific", definition: { name: "draft", description: "A draft" } });
		ui.select("description"); ui.editor.handleInput("r"); await Bun.sleep(0);
		expect(ui.requests[1]).toMatchObject({ target: "description", conversationId: "retained" });
		ui.activate("description"); ui.editor.handleInput("r"); ui.editor.handleInput("R");
		expect(ui.requests).toHaveLength(2); ui.back(); ui.back(); expect(ui.closed()).toBe(true);
	});

	test("nested schema keywords and inline advisor choices retain their field generation targets", async () => {
		const ui = setup();
		ui.activate("output"); ui.activate("enable"); ui.activate("keywords");
		await ui.fill("add", "enum"); ui.activate("enum"); ui.activate("array"); ui.activate("add"); ui.activate("0");
		ui.select("text"); ui.editor.handleInput("r"); await Bun.sleep(0);
		expect(ui.requests[0]?.target).toBe("output");
		ui.activate("advisor"); ui.activate("inline"); ui.activate("reviewMode"); ui.select("turn");
		ui.editor.handleInput("\x12"); // Ctrl-R opens the comment dialog.
		ui.setExternal("Review once per turn");
		ui.editor.handleNativeEvent({ type: "action", key: "", act: "external", mods: [] });
		await Bun.sleep(0); ui.submit(); await Bun.sleep(0);
		expect(ui.requests[1]).toMatchObject({ target: "advisor", comment: "Review once per turn", conversationId: "retained" });
		ui.editor.dispose();
	});

	test("generate from existing sends selected definitions and all preset fields to the generator", async () => {
		const ui = setup({ name: "preset", description: "", systemPrompt: "", blocking: false, tools: [] });
		ui.activate("from-existing"); ui.activate("0"); ui.activate("generate"); await Bun.sleep(0);
		expect(ui.requests[0]).toMatchObject({ target: "all", definition: { name: "preset", blocking: false, tools: [] }, baseDefinitions: [{ name: "base", systemPrompt: "Base instructions" }] });
		ui.editor.dispose();
	});

	test("Esc leaves dialogs, nested schema pages, advisor pages and active generation", async () => {
		const pending = Promise.withResolvers<{ fields: Partial<AgentDefinitionDraft> }>();
		const ui = setup(undefined, { generate: () => pending.promise });
		ui.activate("description"); ui.back(); expect(ui.closed()).toBe(false);
		ui.activate("output"); ui.activate("enable"); ui.activate("items"); ui.back(); ui.back();
		ui.activate("advisor"); ui.activate("inline"); ui.back(); ui.back();
		ui.select("name"); ui.editor.handleInput("r"); expect(ui.editor.busy).toBe(true);
		ui.back(); expect(ui.closed()).toBe(true);
		pending.resolve({ fields: { name: "late-write" } }); await Bun.sleep(0);
		expect(ui.editor.definition.name).toBe("draft");
	});
});
