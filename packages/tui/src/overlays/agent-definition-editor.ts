import type { ConfiguredThinkingLevel } from "../thinking";
import { type Component, matchesKey, type TUI, truncateToWidth, replaceTabs } from "../index";
import { MenuKeyReader } from "../components/menu-navigation";
import { HookEditorComponent } from "./hook-editor";
import type { AdvisorConfig, AdvisorConfigScope } from "./advisor-config";
import { theme } from "../theme";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { col, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { picker, pickerEvent, CLOSE_ACTION } from "../native/picker";

export interface InlineAgentAdvisor extends AdvisorConfig {
	delivery?: Partial<Record<"nit" | "concern" | "blocker", "on-yield" | "next-tool-call">>;
}
export type AgentAdvisor = boolean | string | { ref: string; scope?: AdvisorConfigScope } | { inline: InlineAgentAdvisor };
export interface AgentDefinitionDraft {
	name: string;
	description: string;
	systemPrompt: string;
	harness?: "omp" | "claude" | "codex";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	prewalk?: boolean | string;
	advisor?: AgentAdvisor;
	spawns?: string[] | "*";
	tools?: string[];
	output?: unknown;
	blocking?: boolean;
	structured?: boolean;
	autoloadSkills?: string[];
	readSummarize?: boolean;
}
export type AgentDefinitionField = keyof AgentDefinitionDraft;
type FieldKind = "text" | "list" | "boolean" | "choice" | "tools" | "output" | "advisor";
interface DefinitionField {
	key: AgentDefinitionField;
	label: string;
	kind: FieldKind;
	description: string;
	choices?: readonly string[];
}
export const AGENT_DEFINITION_FIELDS: readonly DefinitionField[] = [
	{ key: "name", label: "Name", kind: "text", description: "Unique agent identifier (main and sub are reserved)." },
	{ key: "description", label: "Description", kind: "text", description: "When the delegating agent should choose this definition." },
	{ key: "systemPrompt", label: "Instructions / body", kind: "text", description: "Agent system instructions, stored as the Markdown body." },
	{ key: "harness", label: "Harness", kind: "choice", choices: ["omp", "claude", "codex"], description: "Runtime harness used to execute this agent." },
	{ key: "model", label: "Models / roles (priority order)", kind: "list", description: "Prioritized provider/model selectors or @role aliases, with optional :effort suffix." },
	{ key: "thinkingLevel", label: "Thinking level", kind: "choice", choices: ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Thinking effort used by the agent." },
	{ key: "prewalk", label: "Prewalk", kind: "text", description: "true uses the default edit-time handoff target; false disables; a model selector chooses the handoff target." },
	{ key: "advisor", label: "Advisor", kind: "advisor", description: "true uses the advisor role; false disables; a model selector uses that model; ref selects a named advisor; inline attaches a private advisor definition." },
	{ key: "spawns", label: "Allowed child agents", kind: "list", description: "Agent names this agent may spawn, or * for every agent." },
	{ key: "tools", label: "Tools", kind: "tools", description: "Built-in tool allowlist. Omitted uses defaults; [] grants no tools." },
	{ key: "output", label: "Structured output schema", kind: "output", description: "Output JSON Schema or supported shorthand schema, including nested fields, required fields, constraints and unions." },
	{ key: "structured", label: "Always use structured output", kind: "boolean", description: "Keep yield and the output schema even when task.structured is off." },
	{ key: "blocking", label: "Blocking execution", kind: "boolean", description: "Wait for completion instead of launching in the background." },
	{ key: "autoloadSkills", label: "Autoload skills", kind: "list", description: "Skills automatically loaded for this agent." },
	{ key: "readSummarize", label: "Summarize file reads", kind: "boolean", description: "false makes read return verbatim file content instead of structural summaries." },
];
export const agentDefinitionFieldSchema = {
	type: "object",
	properties: Object.fromEntries(AGENT_DEFINITION_FIELDS.map(field => [field.key, {
		description: field.description,
		...(field.kind === "boolean" ? { type: "boolean" } : field.kind === "list" || field.kind === "tools"
			? { anyOf: [{ type: "array", items: { type: "string" } }, ...(field.key === "spawns" ? [{ const: "*" }] : [])] }
			: field.key === "prewalk" ? { anyOf: [{ type: "boolean" }, { type: "string" }] }
			: field.kind === "output" ? {} : field.kind === "advisor" ? { anyOf: [{ type: "boolean" }, { type: "string" }, { type: "object", properties: { ref: { type: "string" }, scope: { type: "string" }, inline: { type: "object" } } }] }
			: { type: "string", ...(field.choices ? { enum: field.choices } : {}) }),
	} ])),
	required: ["name", "description", "systemPrompt"],
};
export interface NamedAgentAdvisor { name: string; scope: AdvisorConfigScope; config: AdvisorConfig }
export interface AgentEditorDeps {
	tools: readonly { name: string; description?: string }[];
	listAdvisors: () => Promise<readonly NamedAgentAdvisor[]>;
	parse: (raw: string) => AgentDefinitionDraft;
	serialize: (definition: AgentDefinitionDraft) => string;
	generate: (request: { definition: AgentDefinitionDraft; target: AgentDefinitionField | "all"; comment?: string; baseDefinitions?: readonly AgentDefinitionDraft[]; conversationId?: string; signal: AbortSignal }) => Promise<{ fields: Partial<AgentDefinitionDraft>; conversationId?: string }>;
	existing: readonly AgentDefinitionDraft[];
	save: (definition: AgentDefinitionDraft, scope: "project" | "user") => Promise<void>;
	externalEditor?: (raw: string) => Promise<string | null>;
}
interface FormRow { id: string; label: string; value?: string; activate: () => void; field?: AgentDefinitionField }
interface FormPage { title: string; rows: () => FormRow[]; index: number }
type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function displayValue(value: unknown): string {
	if (value === undefined) return "Default";
	if (typeof value === "string") return value || "Not set";
	if (Array.isArray(value)) return value.join(", ") || "None";
	if (typeof value === "object") return "Configured";
	return value ? "On" : "Off";
}
/** A single draft owns rich, raw and generated changes; none writes until Save. */
export class AgentDefinitionEditor implements Component {
	#draft: AgentDefinitionDraft;
	#deps: AgentEditorDeps;
	#tui: TUI;
	#close: () => void;
	#scope: "project" | "user";
	#pages: FormPage[] = [];
	#dialog: HookEditorComponent | null = null;
	#keys = new MenuKeyReader();
	#error = "";
	#busy = false;
	#controller: AbortController | undefined;
	#conversationId: string | undefined;
	#closed = false;
	constructor(tui: TUI, deps: AgentEditorDeps, definition: AgentDefinitionDraft, close: () => void, scope: "project" | "user" = "project") {
		this.#tui = tui; this.#deps = deps; this.#draft = structuredClone(definition); this.#close = close; this.#scope = scope;
		this.#pages.push({ title: definition.name ? `Edit ${definition.name}` : "New agent definition", rows: () => this.#definitionRows(), index: 0 });
	}
	get definition(): AgentDefinitionDraft { return structuredClone(this.#draft); }
	get busy(): boolean { return this.#busy; }
	invalidate(): void { this.#dialog?.invalidate(); }
	dispose(): void { this.#closed = true; this.#controller?.abort(); this.#dialog?.dispose(); }
	#render(): void { this.#tui.requestRender(); }
	#push(title: string, rows: () => FormRow[]): void { this.#keys.reset(); this.#pages.push({ title, rows, index: 0 }); this.#render(); }
	#prompt(title: string, value: string, apply: (value: string) => void): void {
		this.#dialog = new HookEditorComponent(this.#tui, title, value, result => {
			try { apply(result); this.#error = ""; this.#dialog?.dispose(); this.#dialog = null; }
			catch (error) { this.#error = error instanceof Error ? error.message : String(error); this.#prompt(title, result, apply); }
			this.#render();
		}, () => { this.#dialog?.dispose(); this.#dialog = null; this.#render(); }, { externalEditor: this.#deps.externalEditor });
		this.#dialog.focused = true;
	}
	#set(key: AgentDefinitionField, value: unknown): void {
		if (value === undefined) delete this.#draft[key];
		else Object.assign(this.#draft, { [key]: value });
	}
	#definitionRows(): FormRow[] {
		return [
			{ id: "generate-all", label: "Generate everything", activate: () => void this.#generate("all") },
			{ id: "from-existing", label: "Generate from existing definitions…", activate: () => this.#existingPicker() },
			{ id: "scope", label: "Save scope", value: this.#scope, activate: () => { this.#scope = this.#scope === "project" ? "user" : "project"; } },
			...AGENT_DEFINITION_FIELDS.map(field => ({ id: field.key, label: field.label, value: displayValue(this.#draft[field.key]), field: field.key, activate: () => this.#editField(field) })),
			{ id: "raw", label: "Edit definition file contents…", activate: () => this.#prompt("Definition file contents", this.#deps.serialize(this.#draft), value => { this.#draft = this.#deps.parse(value); }) },
			{ id: "save", label: "Save definition", activate: () => void this.#save() },
		];
	}
	#editField(field: DefinitionField): void {
		const value = this.#draft[field.key];
		if (field.kind === "tools") { this.#tools(); return; }
		if (field.kind === "output") { this.#output(); return; }
		if (field.kind === "advisor") { this.#advisor(); return; }
		if (field.kind === "boolean") { this.#set(field.key, value === undefined ? true : value === true ? false : undefined); return; }
		if (field.choices) {
			this.#push(field.label, () => [undefined, ...field.choices!].map(choice => ({ id: choice ?? "default", label: choice ?? "Default", value: choice === value ? "✓" : "", field: field.key, activate: () => { this.#set(field.key, choice); this.#pages.pop(); } })));
			return;
		}
		this.#prompt(field.label, Array.isArray(value) ? value.join("\n") : value === undefined ? "" : String(value), result => {
			if (field.kind === "list") this.#set(field.key, result.trim() === "*" && field.key === "spawns" ? "*" : result.trim() ? result.split(/[\n,]/).map(item => item.trim()).filter(Boolean) : undefined);
			else if (field.key === "prewalk") this.#set(field.key, result === "true" ? true : result === "false" ? false : result.trim() || undefined);
			else this.#set(field.key, result);
		});
	}
	#tools(): void {
		this.#push("Tools — Space / Enter toggles", () => [
			{ id: "defaults", label: "Use default tool selection", value: this.#draft.tools === undefined ? "[✓]" : "[ ]", field: "tools", activate: () => { this.#draft.tools = this.#draft.tools === undefined ? [] : undefined; } },
			...Array.from(new Set([...this.#deps.tools.map(tool => tool.name), ...(this.#draft.tools ?? [])])).sort().map(name => ({
				id: name, label: name, value: `${this.#draft.tools?.includes(name) ? "[✓]" : "[ ]"} ${this.#deps.tools.find(tool => tool.name === name)?.description ?? ""}`, field: "tools" as const,
				activate: () => { const selected = this.#draft.tools ?? this.#deps.tools.map(tool => tool.name); this.#draft.tools = selected.includes(name) ? selected.filter(tool => tool !== name) : [...selected, name]; },
			})),
		]);
	}
	#output(): void {
		this.#push("Structured output", () => [
			{ id: "enable", label: "Enable structured output", value: this.#draft.output === undefined || this.#draft.output === false ? "[ ]" : "[✓]", field: "output", activate: () => { this.#draft.output = this.#draft.output === undefined || this.#draft.output === false ? { type: "object", properties: {}, required: [] } : undefined; } },
			...(this.#draft.output === undefined || this.#draft.output === false ? [] : this.#schemaRows(() => this.#draft.output, value => { this.#draft.output = value; })),
		]);
	}
	#schemaRows(get: () => unknown, set: (value: unknown) => void): FormRow[] {
		const schema = record(get());
		const properties = record(schema.properties);
		const update = (key: string, value: unknown): void => { const next = { ...record(get()) }; if (value === undefined) delete next[key]; else next[key] = value; set(next); };
		return [
			{ id: "type", label: "Type", value: displayValue(schema.type), field: "output", activate: () => this.#push("Output type", () => ["object", "array", "string", "number", "integer", "boolean", "null"].map(type => ({ id: type, label: type, activate: () => { update("type", type); this.#pages.pop(); } }))) },
			{ id: "description", label: "Description", value: displayValue(schema.description), field: "output", activate: () => this.#prompt("Field description", typeof schema.description === "string" ? schema.description : "", value => update("description", value || undefined)) },
			...Object.keys(properties).map(name => ({ id: `property:${name}`, label: name, value: `${displayValue(record(properties[name]).type)}${Array.isArray(schema.required) && schema.required.includes(name) ? " · Required" : " · Optional"}`, field: "output" as const, activate: () => this.#schemaProperty(get, set, name) })),
			{ id: "add-field", label: "+ New output field", field: "output", activate: () => this.#prompt("New output field name", "", name => { if (!name.trim()) throw new Error("Field name is required"); const next = record(get()); const props = record(next.properties); if (Object.hasOwn(props, name)) throw new Error("That field already exists"); set({ ...next, type: next.type ?? "object", properties: { ...props, [name]: { type: "string" } } }); }) },
			{ id: "items", label: "Array item schema…", value: displayValue(schema.items), field: "output", activate: () => this.#push("Array items", () => this.#schemaRows(() => record(get()).items, value => update("items", value))) },
			{ id: "keywords", label: "Constraints, unions and other schema keywords…", field: "output", activate: () => this.#jsonObject("Schema keywords", get, set) },
		];
	}
	#schemaProperty(get: () => unknown, set: (value: unknown) => void, initialName: string): void {
		let name = initialName;
		const childGet = (): unknown => record(record(get()).properties)[name];
		const childSet = (value: unknown): void => { const root = record(get()); set({ ...root, properties: { ...record(root.properties), [name]: value } }); };
		this.#push(`Output field: ${name}`, () => [
			{ id: "name", label: "Field name", value: name, field: "output", activate: () => this.#prompt("Field name", name, nextName => {
				if (!nextName.trim()) throw new Error("Field name is required");
				const root = record(get()); const props = { ...record(root.properties) };
				if (nextName !== name && Object.hasOwn(props, nextName)) throw new Error("That field already exists");
				const value = props[name]; delete props[name]; props[nextName] = value;
				set({ ...root, properties: props, ...(Array.isArray(root.required) ? { required: root.required.map(item => item === name ? nextName : item) } : {}) }); name = nextName;
			}) },
			{ id: "required", label: "Required", value: Array.isArray(record(get()).required) && (record(get()).required as unknown[]).includes(name) ? "[✓]" : "[ ]", field: "output", activate: () => { const root = record(get()); const required = Array.isArray(root.required) ? root.required : []; set({ ...root, required: required.includes(name) ? required.filter(item => item !== name) : [...required, name] }); } },
			...this.#schemaRows(childGet, childSet),
			{ id: "delete", label: "Remove this field", activate: () => { const root = record(get()); const props = { ...record(root.properties) }; delete props[name]; set({ ...root, properties: props, ...(Array.isArray(root.required) ? { required: root.required.filter(item => item !== name) } : {}) }); this.#pages.pop(); } },
		]);
	}
	/** Recursive typed data editor keeps every JSON Schema keyword expressible without YAML. */
	#jsonObject(title: string, get: () => unknown, set: (value: unknown) => void): void {
		this.#push(title, () => [
			...Object.entries(record(get())).map(([key, value]) => ({ id: key, label: key, value: displayValue(value), field: "output" as const, activate: () => this.#jsonValue(key, () => record(get())[key], next => { const root = { ...record(get()) }; if (next === undefined) delete root[key]; else root[key] = next; set(root); }) })),
			{ id: "add", label: "+ New keyword", field: "output", activate: () => this.#prompt("Schema keyword (enum, anyOf, minimum, $ref…)", "", key => { if (!key.trim()) throw new Error("Keyword is required"); set({ ...record(get()), [key]: null }); }) },
		]);
	}
	#jsonValue(title: string, get: () => unknown, set: (value: unknown) => void): void {
		this.#push(title, () => [
			{ id: "text", label: "Text", value: typeof get() === "string" ? String(get()) : "", activate: () => this.#prompt(title, typeof get() === "string" ? String(get()) : "", set) },
			{ id: "number", label: "Number", value: typeof get() === "number" ? String(get()) : "", activate: () => this.#prompt(title, typeof get() === "number" ? String(get()) : "", value => { const number = Number(value); if (!value.trim() || !Number.isFinite(number)) throw new Error("Enter a finite number"); set(number); }) },
			{ id: "boolean", label: "Boolean", value: typeof get() === "boolean" ? String(get()) : "", activate: () => set(get() !== true) },
			{ id: "null", label: "Null", activate: () => set(null) },
			{ id: "object", label: "Object…", activate: () => { if (typeof get() !== "object" || get() === null || Array.isArray(get())) set({}); this.#jsonObject(title, get, set); } },
			{ id: "array", label: "List…", activate: () => { if (!Array.isArray(get())) set([]); this.#push(title, () => [
				...(get() as unknown[]).map((value, index) => ({ id: String(index), label: `Item ${index + 1}`, value: displayValue(value), activate: () => this.#jsonValue(`${title} item ${index + 1}`, () => (get() as unknown[])[index], next => { const values = [...get() as unknown[]]; if (next === undefined) values.splice(index, 1); else values[index] = next; set(values); }) })),
				{ id: "add", label: "+ New item", activate: () => set([...get() as unknown[], null]) },
			]); } },
			{ id: "remove", label: "Remove", activate: () => { set(undefined); this.#pages.pop(); } },
		]);
	}
	#advisor(): void {
		this.#push("Advisor", () => [
			{ id: "default", label: "Default (no advisor)", activate: () => { delete this.#draft.advisor; } },
			{ id: "role", label: "Use advisor role", value: this.#draft.advisor === true ? "✓" : "", field: "advisor", activate: () => { this.#draft.advisor = true; } },
			{ id: "off", label: "Disabled", field: "advisor", activate: () => { this.#draft.advisor = false; } },
			{ id: "model", label: "Use a model / role selector…", field: "advisor", activate: () => this.#prompt("Advisor model", typeof this.#draft.advisor === "string" ? this.#draft.advisor : "@advisor", value => { this.#draft.advisor = value.trim() || true; }) },
			{ id: "named", label: "Choose named advisor…", field: "advisor", activate: () => void this.#namedAdvisors() },
			{ id: "inline", label: "Private inline advisor…", field: "advisor", activate: () => this.#inlineAdvisor() },
		]);
	}
	async #namedAdvisors(): Promise<void> {
		try { const advisors = await this.#deps.listAdvisors(); if (this.#closed) return; this.#push("Named advisors", () => advisors.map((advisor, index) => ({ id: String(index), label: advisor.name, value: advisor.scope, field: "advisor", activate: () => { this.#draft.advisor = { ref: advisor.name, scope: advisor.scope }; this.#pages.pop(); } }))); }
		catch (error) { this.#error = String(error); this.#render(); }
	}
	#inlineAdvisor(): void {
		if (typeof this.#draft.advisor !== "object" || !("inline" in this.#draft.advisor)) this.#draft.advisor = { inline: { name: `${this.#draft.name || "agent"} advisor` } };
		const get = (): InlineAgentAdvisor => (this.#draft.advisor as { inline: InlineAgentAdvisor }).inline;
		const fields: { key: keyof AdvisorConfig; label: string; kind: "text" | "boolean" | "number" | "list"; choices?: string[] }[] = [
			{ key: "name", label: "Name", kind: "text" }, { key: "model", label: "Model / role", kind: "text" },
			{ key: "instructions", label: "Instructions", kind: "text" }, { key: "systemPrompt", label: "Base system prompt override", kind: "text" },
			{ key: "enabled", label: "Enabled", kind: "boolean" }, { key: "includeThinking", label: "Include primary thinking", kind: "boolean" },
			{ key: "maxNotesPerUpdate", label: "Maximum notes per update", kind: "number" },
			{ key: "reviewMode", label: "Delivery / review mode", kind: "text", choices: ["turn", "agent-end"] },
			{ key: "reviewInterval", label: "Review interval", kind: "number" },
			{ key: "syncBacklog", label: "Sync backlog", kind: "text", choices: ["off", "1", "3", "5", "strict"] },
			{ key: "scope", label: "Attach to session kinds", kind: "text", choices: ["main", "subagent", "all"] },
		];
		this.#push("Private advisor — not saved to any catalog", () => [
			...fields.map(field => ({ id: field.key, label: field.label, value: displayValue(get()[field.key]), field: "advisor" as const, activate: () => {
				const set = (value: unknown): void => { if (value === undefined) delete get()[field.key]; else Object.assign(get(), { [field.key]: value }); };
				if (field.kind === "boolean") { set(get()[field.key] === undefined ? true : get()[field.key] === true ? false : undefined); return; }
				if (field.choices) { this.#push(field.label, () => [undefined, ...field.choices!].map(value => ({ id: value ?? "default", label: value ?? "Default", activate: () => { set(value); this.#pages.pop(); } }))); return; }
				this.#prompt(field.label, get()[field.key] === undefined ? "" : String(get()[field.key]), value => { if (field.kind === "number") { if (!value.trim()) set(undefined); else { const number = Number(value); if (!Number.isFinite(number) || number < 0) throw new Error("Enter a nonnegative number"); set(number); } } else set(value || undefined); });
			} })),
			...(["nit", "concern", "blocker"] as const).map(severity => ({ id: `delivery:${severity}`, label: `${severity} delivery`, value: get().delivery?.[severity] ?? "Default", field: "advisor" as const, activate: () => this.#push(`${severity} delivery`, () => [undefined, "on-yield", "next-tool-call"].map(value => ({ id: value ?? "default", label: value ?? "Default", activate: () => { const delivery = { ...get().delivery }; if (value === undefined) delete delivery[severity]; else delivery[severity] = value as "on-yield" | "next-tool-call"; get().delivery = delivery; this.#pages.pop(); } }))) })),
			{ id: "tools", label: "Tools…", value: displayValue(get().tools), field: "advisor", activate: () => this.#push("Private advisor tools", () => [
				{ id: "default", label: "Use default tools", value: get().tools === undefined ? "[✓]" : "[ ]", activate: () => { get().tools = get().tools === undefined ? [] : undefined; } },
				...this.#deps.tools.map(tool => ({ id: tool.name, label: tool.name, value: get().tools?.includes(tool.name) ? "[✓]" : "[ ]", activate: () => { const selected = get().tools ?? []; get().tools = selected.includes(tool.name) ? selected.filter(name => name !== tool.name) : [...selected, tool.name]; } })),
			]) },
		]);
	}
	#existingPicker(): void {
		const selected = new Set<number>();
		this.#push("Base definitions — select any, then generate", () => [
			{ id: "generate", label: "Generate from selected definitions", activate: () => { const bases = this.#deps.existing.filter((_, index) => selected.has(index)); if (!bases.length) { this.#error = "Select at least one base definition"; return; } this.#pages.pop(); void this.#generate("all", undefined, bases); } },
			...this.#deps.existing.map((definition, index) => ({ id: String(index), label: definition.name, value: selected.has(index) ? "[✓]" : "[ ]", activate: () => { if (selected.has(index)) selected.delete(index); else selected.add(index); } })),
		]);
	}
	async #generate(target: AgentDefinitionField | "all", comment?: string, baseDefinitions?: readonly AgentDefinitionDraft[]): Promise<void> {
		if (this.#busy) return;
		this.#busy = true; this.#error = ""; const controller = new AbortController(); this.#controller = controller; this.#render();
		try { const result = await this.#deps.generate({ definition: this.definition, target, comment, baseDefinitions, conversationId: this.#conversationId, signal: controller.signal }); if (this.#closed || controller.signal.aborted) return; Object.assign(this.#draft, result.fields); this.#conversationId = result.conversationId; }
		catch (error) { if (!controller.signal.aborted) this.#error = error instanceof Error ? error.message : String(error); }
		finally { this.#busy = false; this.#controller = undefined; this.#render(); }
	}
	async #save(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try { await this.#deps.save(this.definition, this.#scope); this.dispose(); this.#close(); }
		catch (error) { this.#error = error instanceof Error ? error.message : String(error); }
		finally { this.#busy = false; this.#render(); }
	}
	handleInput(data: string): void {
		if (this.#dialog) { if (matchesKey(data, "escape")) { this.#dialog.dispose(); this.#dialog = null; } else this.#dialog.handleInput(data); this.#render(); return; }
		if (matchesKey(data, "escape")) { if (this.#busy) { this.#controller?.abort(); this.#busy = false; } if (this.#pages.length > 1) this.#pages.pop(); else { this.dispose(); this.#close(); } this.#render(); return; }
		if (this.#busy) return;
		const page = this.#pages[this.#pages.length - 1]!; const rows = page.rows(); const selected = rows[page.index];
		// Generation is only bound in row-navigation mode, never in text/Vim editors.
		if (data === "r" || data === "R" || matchesKey(data, "ctrl+r")) {
			const target = selected?.field ?? (selected?.id === "generate-all" ? "all" : undefined);
			if (target) { if (data === "R" || matchesKey(data, "ctrl+r")) this.#prompt("What should change?", "", comment => { void this.#generate(target, comment); }); else void this.#generate(target); }
			this.#render(); return;
		}
		const action = this.#keys.read(data);
		if (action && action !== "pending") {
			if (action.kind === "move") page.index = Math.max(0, Math.min(rows.length - 1, page.index + action.delta));
			else if (action.kind === "boundary") page.index = action.edge === "first" ? 0 : rows.length - 1;
			else if (action.kind === "page" || action.kind === "halfPage" || action.kind === "scroll") page.index = Math.max(0, Math.min(rows.length - 1, page.index + action.delta * (action.kind === "scroll" ? 1 : action.kind === "page" ? 12 : 6)));
			else if (action.kind === "confirm" || action.kind === "toggle") selected?.activate();
			else if (action.kind === "cancel" || action.kind === "horizontal" && action.delta < 0) { if (this.#pages.length > 1) this.#pages.pop(); else { this.dispose(); this.#close(); } }
		}
		this.#render();
	}
	render(width: number): readonly string[] {
		if (this.#dialog) return this.#dialog.render(width);
		const page = this.#pages[this.#pages.length - 1]!; const rows = page.rows(); page.index = Math.max(0, Math.min(rows.length - 1, page.index));
		const height = Math.max(5, (this.#tui.terminal?.rows ?? 30) - 5);
		const top = Math.max(0, Math.min(page.index - Math.floor(height / 2), rows.length - height));
		const lines = [theme.bold(` ${page.title}`), theme.fg("dim", "─".repeat(Math.max(1, width)))];
		for (let index = top; index < Math.min(rows.length, top + height); index++) {
			const row = rows[index]!; const line = ` ${index === page.index ? "›" : " "} ${row.label}${row.value ? `  ${sanitizeDisplaySingleLine(row.value)}` : ""}`;
			lines.push(truncateToWidth(index === page.index ? theme.fg("accent", line) : line, width));
		}
		if (this.#error) lines.push(truncateToWidth(theme.fg("error", replaceTabs(this.#error)), width));
		lines.push(truncateToWidth(theme.fg("muted", this.#busy ? "Working… · Esc leaves / cancels generation" : "Enter / Space edit · ↑↓ / j/k move · r generate · R / Ctrl-R with comment · Esc back"), width));
		return lines;
	}
	nativeSheet(cx: DescribeContext): boolean { return !this.#dialog && cx.supports("picker"); }
	describe(cx: DescribeContext): NativeNode {
		if (this.#dialog) return this.#dialog.describe(cx);
		const page = this.#pages.at(-1)!;
		const rows = page.rows();
		if (!cx.supports("picker")) return col([text(this.render(120).join("\n"))]);
		return picker({ title: page.title, query: null, items: rows.map(row => ({ id: row.id, label: sanitizeDisplaySingleLine(row.label), detail: row.value ? sanitizeDisplaySingleLine(row.value) : undefined })), selected: rows[page.index]?.id, actions: [{ id: "generate", label: "Generate field", keys: ["r"] }, { id: "comment", label: "Generate with comment", keys: ["shift", "r"] }, CLOSE_ACTION], empty: { head: "No entries" } }, this.#error ? [text(this.#error, { tone: "error" })] : []);
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#dialog) { this.#dialog.handleNativeEvent(event); return; }
		const picked = pickerEvent(event);
		if (!picked) return;
		const page = this.#pages.at(-1)!; const rows = page.rows();
		if (picked.kind === "select" || picked.kind === "activate") { const index = rows.findIndex(row => row.id === picked.id); if (index >= 0) { page.index = index; if (picked.kind === "activate") rows[index]?.activate(); } }
		else if (picked.act === "close") this.handleInput("\x1b");
		else if (picked.act === "generate") this.handleInput("r");
		else if (picked.act === "comment") this.handleInput("R");
		this.#render();
	}
}
