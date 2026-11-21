/**
 * The `/agents` definition editor, built on the `/advisor configure` pattern:
 * a field list on the left, a live preview on the right (what the definition
 * means to the harness, the problems found, the file as it will be saved), and
 * one purpose-built screen per field — the model browser with its effort
 * step, ordered model fallbacks, tool and spawn checklists, the advisor and
 * prewalk choices, the structured-output schema editor — so every manifest
 * field is picked rather than memorized. One draft owns rich, raw and
 * generated changes; nothing touches disk until Save.
 */
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import type { TspPrefsRow, TspPrefsSection } from "@oh-my-pi/pi-wire";
import {
	type Component,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "../index";
import { Checklist, type ChecklistOptions as ChecklistSelectionOptions } from "../components/checklist";
import { MenuKeyReader } from "../components/menu-navigation";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { extractPrintableText } from "../keys";
import { interruptKey } from "../chrome/keybinding-hints";
import { matchesAppInterrupt } from "../keybinding-matchers";
import { col, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import {
	CLOSE_ACTION,
	picker,
	pickerAction,
	pickerEvent,
	routeSelectListPicker,
	type SelectPickerOptions,
	selectListPicker,
} from "../native/picker";
import { getSelectListTheme, theme } from "../theme";
import { uiProvenanceSuffix } from "../theme/provenance";
import { getThinkingLevelMetadata, parseThinkingLevel } from "../thinking";
import type { AdvisorConfig } from "./advisor-config";
import {
	AGENT_DEFINITION_FIELDS,
	AGENT_INHERITANCE_VALUES,
	type AgentDefinitionDraft,
	type AgentDefinitionField,
	type AgentDefinitionInspection,
	type AgentEditorDeps,
	type AgentGenerationSource,
	type DefinitionField,
	type InlineAgentAdvisor,
} from "./agent-definition-fields";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { HookEditorComponent } from "./hook-editor";
import { buildBrowserItems, ModelBrowser, sortModelItems } from "./model-browser";

export * from "./agent-definition-fields";

/** What each field means to the harness; shown beside the field while it is highlighted or edited. */
const FIELD_HELP: Record<AgentDefinitionField, string> = {
	name: "Exact identifier used by spawns lists and task calls. main and sub are reserved. Saved as <name>.md in the chosen scope; the first definition found with a name wins (project, then user, then plugins, then bundled).",
	description:
		"Shown to the delegating agent in the task catalog; it decides when this type is chosen. Say what the type is for and when not to use it.",
	systemPrompt:
		"The Markdown body becomes the child's Role. Write standing instructions in second person: the job, judgment calls, expected result, and what to do if blocked. The harness supplies each assignment and the mechanics of returning a result.",
	harness:
		"omp runs natively (default). claude runs through the Claude adapter with the subset of tools it can represent. codex parses but cannot be spawned.",
	inherit:
		"For native NeoPi agents, all keeps context files and the harness prompt (default); context keeps only files; system keeps only the harness prompt; none keeps neither. Agent instructions always apply. Claude supports only all.",
	model: "Ordered fallbacks: @role aliases or provider/model selectors, each with an optional :effort suffix. The first available one is used; an empty list inherits the parent's model. A per-call model and the task.agentModelOverrides setting win over this list.",
	thinkingLevel:
		"Reasoning effort when the chosen model selector carries no :effort suffix; a per-call effort wins over both. inherit follows the parent, auto lets the harness choose.",
	prewalk:
		"After the agent's first completed edit or write (and a todo, while the todo tool is active) its session switches to another model and effort. It changes model and effort only, not the role or its advisors. On uses the configured prewalk target; a selector chooses the target. task.agentPrewalk overrides this field.",
	advisor:
		"Subagents run without an advisor unless their definition opts in. Advisor role uses the advisor role and catalog; a selector changes the advisor's model; a named advisor binds one WATCHDOG entry; a private advisor is defined here for this type only. Role activation sets are separate settings.",
	spawns:
		"Exact-name allowlist of agent types this agent may start; the first listed is its default. * allows any type. Omitted means none, except that a tools list containing task silently grants *. Chains (A spawns B, B spawns C) are enforced and bounded by task.maxRecursionDepth.",
	tools: "Omitted uses the default built-ins; [] selects none explicitly. Structured runs still get yield, and spawns adds task below the depth cap. This is not a sandbox: MCP and custom tools stay available unless the caller restricts them.",
	output:
		"A JSON Schema or JTD object the agent's yield {data} is validated against; a caller's outputSchema overrides it. Omit it for free-text results. true and null are rejected before dispatch.",
	structured:
		"On keeps yield and the output schema even when the task.structured setting is off. Off cannot veto a caller that keeps structured mode on.",
	blocking:
		"On runs the agent inline, so its result is in hand before the delegating turn continues. Otherwise it runs detached when async execution is available.",
	autoloadSkills:
		"Exact skill names delivered to the agent before its assignment. Names the session does not have are silently dropped.",
	readSummarize: "Off makes read return verbatim file content instead of structural summaries for this agent.",
};

/** Detail list: field rows grouped by purpose, then actions. */
const DETAIL_GROUPS: readonly { title: string; fields: readonly AgentDefinitionField[] }[] = [
	{ title: "Identity", fields: ["name", "description", "systemPrompt", "inherit"] },
	{ title: "Model", fields: ["model", "thinkingLevel", "harness"] },
	{ title: "Powers", fields: ["tools", "spawns", "autoloadSkills", "readSummarize"] },
	{ title: "Lifecycle", fields: ["blocking", "prewalk", "advisor"] },
	{ title: "Result", fields: ["output", "structured"] },
];
const FIELD_BY_KEY = new Map(AGENT_DEFINITION_FIELDS.map(field => [field.key, field]));
const FIELD_KEYS = new Set<string>(AGENT_DEFINITION_FIELDS.map(field => field.key));
const EFFORT_SUFFIX = /:(minimal|low|medium|high|xhigh|max)$/;
const DONE = "__done";

type Screen =
	| "detail"
	| "form"
	| "choice"
	| "checklist"
	| "models"
	| "model-browser"
	| "input"
	| "text"
	| "confirm"
	| "generating";

interface FormRow {
	id: string;
	label: string;
	value?: string;
	activate: () => void;
	field?: AgentDefinitionField;
}
interface FormPage {
	title: string;
	rows: () => FormRow[];
	selected?: string;
}
interface ChoiceOption {
	value: string;
	label: string;
	description?: string;
}
interface ChecklistOptions extends Omit<ChecklistSelectionOptions, "selected"> {
	selected: readonly string[] | undefined;
	title: string;
	subtitle: string;
	field: AgentDefinitionField;
	/** Row label for adding a name not in the catalog. */
	custom?: string;
	apply: (selected: string[] | undefined) => void;
}
type GenerationReferences = Pick<Parameters<AgentEditorDeps["generate"]>[0], "baseDefinitions" | "sources">;
type PreviewBlock =
	| { kind: "title"; text: string; sub?: string }
	| { kind: "section"; text: string }
	| { kind: "kv"; items: readonly { k: string; v: string }[] }
	| { kind: "finding"; level: "warn" | "info"; text: string }
	| { kind: "text"; text: string; tone?: "muted" | "dim" }
	| { kind: "code"; lines: readonly string[] };
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function displayValue(value: unknown): string {
	if (value === undefined) return "Default";
	if (typeof value === "string") return value || "Not set";
	if (Array.isArray(value)) return value.join(", ") || "None";
	if (typeof value === "object") return "Configured";
	return value ? "On" : "Off";
}
function triState(value: boolean | undefined, on: string, off: string, unset: string): string {
	return value === undefined ? unset : value ? on : off;
}
function firstLine(value: string, fallback: string): string {
	const line = value.trim().split("\n", 1)[0] ?? "";
	return line ? (line.length > 60 ? `${line.slice(0, 59)}…` : line) : fallback;
}
function wrap(value: string, width: number): string[] {
	if (!value) return [""];
	return Bun.wrapAnsi(value, Math.max(1, width), { trim: false }).split("\n");
}
function splitList(value: string): string[] | undefined {
	const items = value
		.split(/[\n,]/)
		.map(item => item.trim())
		.filter(Boolean);
	return items.length ? items : undefined;
}

export class AgentDefinitionEditor implements Component {
	#draft: AgentDefinitionDraft;
	#deps: AgentEditorDeps;
	#tui: TUI;
	#close: () => void;
	#scope: "project" | "user";
	#saved: string;
	#title: string;
	#screen: Screen = "detail";
	#active: Component;
	#sheet: SelectPickerOptions | undefined;
	#hint = "";
	#notice = "";
	#preview = true;
	/** The field whose help the preview shows while its own screen is open. */
	#helpField: AgentDefinitionField | undefined;
	/** Rebuilds the current list screen in place after a row changed the draft. */
	#rebuild: ((selected: string | undefined) => void) | undefined;
	#revision = 0;
	#pages: FormPage[] = [];
	#formBack: (() => void) | undefined;
	#keys = new MenuKeyReader();
	#busy = false;
	#controller: AbortController | undefined;
	#conversationId: string | undefined;
	#closed = false;
	#inspection: { key: string; value: AgentDefinitionInspection | undefined } | undefined;
	#previewScroll = 0;
	#bodyRows = 3;
	readonly #split = new SplitPane({
		left: (width, height) => this.#renderActive(width, height),
		right: (width, height) => this.#renderPreview(width, height),
		leftSize: { ratio: 0.46, min: 34, max: 72 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #frameTop = new PanelRows();
	readonly #frameDivider = new PanelRows();
	readonly #frameFooter = new PanelRows();
	readonly #frameBottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#frameTop, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#frameDivider, height: 1 },
			{ content: this.#frameFooter, height: 1 },
			{ content: this.#frameBottom, height: 1 },
		],
	});

	constructor(
		tui: TUI,
		deps: AgentEditorDeps,
		definition: AgentDefinitionDraft,
		close: () => void,
		scope: "project" | "user" = "project",
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#draft = structuredClone(definition);
		this.#close = close;
		this.#scope = scope;
		this.#saved = deps.serialize(this.#draft);
		if (deps.embedded) this.#split.setLeftSize({ ratio: 0.46, min: 22, max: 72 });
		this.#title = definition.name ? `Edit ${definition.name}` : "New agent definition";
		this.#active = new SelectList([], 1, getSelectListTheme());
		this.#showDetail();
	}

	get definition(): AgentDefinitionDraft {
		return structuredClone(this.#draft);
	}
	get busy(): boolean {
		return this.#busy;
	}
	get dirty(): boolean {
		return this.#deps.serialize(this.#draft) !== this.#saved;
	}
	get rosterVisible(): boolean {
		return !this.#closed && this.#screen === "detail";
	}
	get selectedDetailItem(): string | undefined {
		return this.rosterVisible && this.#active instanceof SelectList
			? this.#active.getSelectedItem()?.value
			: undefined;
	}
	get detailNotice(): string | undefined {
		return this.rosterVisible ? this.#notice || undefined : undefined;
	}
	detailSections(): readonly TspPrefsSection[] {
		if (!this.rosterVisible || !(this.#active instanceof SelectList)) return [];
		const sections: { id: string; title: string; rows: TspPrefsRow[] }[] = [];
		const selected = this.selectedDetailItem;
		let section: (typeof sections)[number] | undefined;
		for (const item of this.#active.pickerView().items) {
			if (item.value.startsWith("group:")) {
				const group = item.value.slice("group:".length);
				section = { id: group.toLowerCase(), title: group === "actions" ? "Author & file" : group, rows: [] };
				sections.push(section);
				continue;
			}
			const field = FIELD_BY_KEY.get(item.value as AgentDefinitionField);
			section?.rows.push({
				id: item.value,
				label: item.label.trim(),
				hint: field && item.value === selected ? FIELD_HELP[field.key] : undefined,
				disabled: item.disabled ? item.description || "Not available" : undefined,
				control: { k: "action", label: item.description || "Open", act: "edit" },
			});
		}
		return sections;
	}
	invalidate(): void {
		this.#active.invalidate?.();
	}
	dispose(): void {
		this.#closed = true;
		this.#controller?.abort();
		this.#active.dispose?.();
	}

	// ───────────────────────────── screens ─────────────────────────────

	#setScreen(
		screen: Screen,
		active: Component,
		hint: string,
		options: {
			sheet?: SelectPickerOptions;
			preview?: boolean;
			rebuild?: (selected: string | undefined) => void;
			field?: AgentDefinitionField;
		} = {},
	): void {
		this.#revision++;
		if (this.#active !== active) this.#active.dispose?.();
		this.#screen = screen;
		this.#active = active;
		this.#hint = hint;
		this.#sheet = options.sheet;
		this.#preview = options.preview ?? false;
		this.#rebuild = options.rebuild;
		this.#helpField = options.field;
		this.#previewScroll = 0;
		this.#keys.reset();
		this.#render();
	}
	#render(): void {
		this.#tui.requestRender();
	}
	#list(items: SelectItem[], selected: string | undefined): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), { search: "always" });
		if (selected !== undefined) list.setSelectedValue(selected);
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#render();
		};
		return list;
	}
	/** Run a row's action, then rebuild the screen in place unless the action opened another screen. */
	#run(action: () => void): void {
		const revision = this.#revision;
		const selected = this.#active instanceof SelectList ? this.#active.getSelectedItem()?.value : undefined;
		this.#notice = "";
		try {
			action();
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		}
		if (revision === this.#revision && !this.#closed) this.#rebuild?.(selected);
		this.#render();
	}
	#set(key: AgentDefinitionField, value: unknown): void {
		if (value === undefined) delete this.#draft[key];
		else Object.assign(this.#draft, { [key]: value });
	}

	#inspect(): AgentDefinitionInspection | undefined {
		if (!this.#deps.inspect) return undefined;
		const key = JSON.stringify(this.#draft);
		if (this.#inspection?.key !== key) {
			let value: AgentDefinitionInspection | undefined;
			try {
				value = this.#deps.inspect(this.#draft);
			} catch (error) {
				value = { facts: [], findings: [{ level: "warn", text: `Inspection failed: ${String(error)}` }] };
			}
			this.#inspection = { key, value };
		}
		return this.#inspection.value;
	}

	#fieldSummary(key: AgentDefinitionField): string {
		const draft = this.#draft;
		switch (key) {
			case "name":
				return draft.name || "(required)";
			case "description":
				return firstLine(draft.description, "(required)");
			case "systemPrompt": {
				const lines = draft.systemPrompt.trim() ? draft.systemPrompt.trim().split("\n").length : 0;
				return lines ? `${lines} line${lines === 1 ? "" : "s"} · ${firstLine(draft.systemPrompt, "")}` : "(empty)";
			}
			case "harness":
				return draft.harness ?? "omp (default)";
			case "inherit":
				return draft.inherit ?? "all (default)";
			case "model":
				return draft.model?.length ? draft.model.join(" → ") : "inherit the parent's model";
			case "thinkingLevel":
				return draft.thinkingLevel ?? "inherit";
			case "tools":
				return draft.tools === undefined
					? "default selection"
					: draft.tools.length
						? `${draft.tools.length}: ${draft.tools.join(", ")}`
						: "none";
			case "spawns":
				return draft.spawns === "*"
					? "any type (*)"
					: draft.spawns?.length
						? draft.spawns.join(", ")
						: draft.tools?.includes("task")
							? "omitted → * (task tool)"
							: "none";
			case "autoloadSkills":
				return draft.autoloadSkills?.length ? draft.autoloadSkills.join(", ") : "none";
			case "readSummarize":
				return triState(draft.readSummarize, "on", "off — verbatim reads", "inherit");
			case "blocking":
				return triState(draft.blocking, "on — inline", "off — detached", "default (detached)");
			case "structured":
				return triState(draft.structured, "always", "off", "default");
			case "prewalk":
				return draft.prewalk === undefined
					? "default (off)"
					: draft.prewalk === true
						? "on — configured target"
						: draft.prewalk === false
							? "off"
							: `target ${draft.prewalk}`;
			case "advisor":
				return this.#advisorSummary();
			case "output":
				return this.#outputSummary();
		}
	}
	#advisorSummary(): string {
		const advisor = this.#draft.advisor;
		if (advisor === undefined) return "none (default)";
		if (advisor === true) return "advisor role";
		if (advisor === false) return "disabled";
		if (typeof advisor === "string") return `model ${advisor}`;
		if ("ref" in advisor) return `named ${advisor.ref}${advisor.scope ? ` (${advisor.scope})` : ""}`;
		return `private ${advisor.inline.name}`;
	}
	#outputSummary(): string {
		const output = this.#draft.output;
		if (output === undefined) return "none — free-text result";
		if (output === null || typeof output !== "object") return `⚠ ${String(output)}`;
		const jtd = this.#deps.outputSchemaDialect?.(output) === "jtd";
		const schema = record(output);
		const fields = Object.keys({ ...record(schema.properties), ...(jtd ? record(schema.optionalProperties) : {}) });
		return `${jtd ? "JTD" : "JSON Schema"}${fields.length ? ` · ${fields.join(", ")}` : ""}`;
	}

	#showDetail(selected?: string): void {
		this.#pages = [];
		const dirty = this.dirty;
		const inspection = this.#inspect();
		const warned = new Set(
			inspection?.findings.filter(finding => finding.level === "warn").map(finding => finding.field) ?? [],
		);
		const items: SelectItem[] = [];
		for (const group of DETAIL_GROUPS) {
			items.push({
				value: `group:${group.title}`,
				label: theme.fg("dim", group.title.toUpperCase()),
				disabled: true,
			});
			for (const key of group.fields) {
				const field = FIELD_BY_KEY.get(key)!;
				items.push({
					value: key,
					label: `${warned.has(key) ? "⚠ " : "  "}${field.label}`,
					description: this.#fieldSummary(key),
				});
			}
		}
		items.push({ value: "group:actions", label: theme.fg("dim", "AUTHOR & FILE"), disabled: true });
		items.push(
			{
				value: "generate",
				label: "  Generate with the author…",
				description: "Describe the agent; filled fields are kept",
			},
			{
				value: "from-existing",
				label: "  Generate from sources…",
				description: "Mix definitions and other harness sources",
			},
		);
		for (const missing of this.#missingSpawnTargets())
			if (this.#deps.createMissing)
				items.push({
					value: `create:${missing}`,
					label: `  Create missing "${missing}"…`,
					description: "Spawn target",
				});
		if (this.#deps.openDefinitionFile)
			items.push({
				value: "open-file",
				label: "  Open backing file",
				description: dirty ? "Save or discard draft changes first" : "Ctrl+G",
				disabled: dirty,
			});
		items.push(
			{ value: "raw", label: "  Edit definition file contents…", description: "Front matter and body as text" },
			{
				value: "scope",
				label: this.#deps.saveScopeEditable === false ? "  File scope (edit in place)" : "  Save scope",
				description: this.#scope,
			},
			{ value: "save", label: "  Save definition", description: dirty ? "● unsaved changes" : "no changes" },
			{ value: "copy", label: "  Save as a new copy…", description: "New name, new file" },
		);
		if (this.#deps.remove) items.push({ value: "delete", label: "  Delete definition file…" });
		const list = this.#list(items, selected ?? "name");
		list.onSelect = item => this.#run(() => this.#onDetailSelect(item.value));
		list.onCancel = () => this.#leave();
		this.#setScreen(
			"detail",
			list,
			`${this.#deps.openDefinitionFile ? "Ctrl+G open file · " : ""}Enter edit · r regenerate · R with comment · c copy${this.#deps.remove ? " · Del delete" : ""} · ←/Esc close`,
			{ preview: true, rebuild: next => this.#showDetail(next) },
		);
	}

	#onDetailSelect(value: string): void {
		if (FIELD_KEYS.has(value)) {
			this.#editField(FIELD_BY_KEY.get(value as AgentDefinitionField)!);
			return;
		}
		if (value.startsWith("create:")) {
			// Opening the spawn target replaces this draft; never drop unsaved work silently.
			if (this.dirty) throw new Error("Save this definition first, then create its spawn target.");
			this.#deps.createMissing?.(value.slice("create:".length));
			return;
		}
		switch (value) {
			case "generate":
				this.#showText(
					"Describe the agent for the author",
					"",
					comment => void this.#generate("all", comment.trim() || undefined),
					() => this.#showDetail("generate"),
				);
				return;
			case "from-existing":
				void this.#generationSourcePicker();
				return;
			case "open-file":
				void this.#openDefinitionFile();
				return;
			case "raw":
				this.#showText(
					"Definition file contents",
					this.#deps.serialize(this.#draft),
					raw => {
						this.#draft = this.#deps.parse(raw);
					},
					() => this.#showDetail("raw"),
				);
				return;
			case "scope":
				if (this.#deps.saveScopeEditable !== false) this.#scope = this.#scope === "project" ? "user" : "project";
				return;
			case "save":
				void this.#save();
				return;
			case "copy":
				this.#showCopy();
				return;
			case "delete":
				this.#confirmDelete();
				return;
		}
	}

	#missingSpawnTargets(): string[] {
		if (!Array.isArray(this.#draft.spawns)) return [];
		const known = new Set(this.#deps.existing.map(definition => definition.name));
		return this.#draft.spawns.filter(name => name !== this.#draft.name && !known.has(name));
	}

	#editField(field: DefinitionField): void {
		const back = (): void => this.#showDetail(field.key);
		switch (field.key) {
			case "name":
			case "description": {
				const key = field.key;
				this.#showInput(
					field.label,
					this.#draft[key],
					value => {
						if (key === "name" && !value.trim()) throw new Error("A name is required.");
						this.#draft[key] = value.trim();
					},
					back,
					key,
				);
				return;
			}
			case "systemPrompt":
				this.#showText(
					"Instructions / body",
					this.#draft.systemPrompt,
					value => {
						this.#draft.systemPrompt = value;
					},
					back,
					field.key,
				);
				return;
			case "harness":
				this.#choose({
					title: "Harness",
					field: field.key,
					current: this.#draft.harness ?? "",
					options: [
						{ value: "", label: "omp (default)", description: "Native NeoPi session." },
						{ value: "claude", label: "claude", description: "Claude adapter; only representable tools." },
						{ value: "codex", label: "codex", description: "Parses, but cannot be spawned today." },
					],
					pick: value => this.#set("harness", value || undefined),
					back,
				});
				return;
			case "inherit":
				this.#choose({
					title: field.label,
					field: field.key,
					current: this.#draft.inherit ?? "all",
					options: AGENT_INHERITANCE_VALUES.map(value => ({
						value,
						label: value === "all" ? "all (default)" : value,
					})),
					pick: value => this.#set("inherit", value === "all" ? undefined : value),
					back,
				});
				return;
			case "model":
				this.#showModels();
				return;
			case "thinkingLevel":
				this.#choose({
					title: "Thinking level",
					field: field.key,
					current: this.#draft.thinkingLevel ?? "",
					options: [
						{ value: "", label: "Not set", description: "Omit the field; the parent's effort applies." },
						...(field.choices ?? []).map(level => ({
							value: level,
							label: level,
							description:
								level === "inherit"
									? "Follow the parent's effort."
									: level === "auto"
										? "Let the harness pick per request."
										: parseThinkingLevel(level)
											? getThinkingLevelMetadata(parseThinkingLevel(level)!).description
											: undefined,
						})),
					],
					pick: value => this.#set("thinkingLevel", value || undefined),
					back,
				});
				return;
			case "tools":
				this.#showTools();
				return;
			case "spawns":
				this.#showSpawns();
				return;
			case "autoloadSkills":
				this.#checklist({
					title: "Autoload skills",
					subtitle: "Delivered before the assignment; missing names are dropped.",
					field: field.key,
					entries: (this.#deps.skills ?? []).map(skill => ({
						value: skill.name,
						label: skill.name,
						description: skill.description,
					})),
					selected: this.#draft.autoloadSkills ?? [],
					presets: [{ value: "__none", label: "None", description: "Omit the field.", apply: () => undefined }],
					custom: "+ Add skill name…",
					apply: selected => this.#set("autoloadSkills", selected?.length ? selected : undefined),
				});
				return;
			case "readSummarize":
			case "blocking":
			case "structured":
				this.#set(
					field.key,
					this.#draft[field.key] === undefined ? true : this.#draft[field.key] ? false : undefined,
				);
				return;
			case "prewalk":
				this.#showPrewalk();
				return;
			case "advisor":
				this.#advisor();
				return;
			case "output":
				this.#output();
				return;
		}
	}

	// ───────────────────────────── generic screens ─────────────────────────────

	#showInput(
		title: string,
		value: string,
		apply: (value: string) => void,
		back: () => void,
		field?: AgentDefinitionField,
	): void {
		const input = new Input();
		input.setValue(value);
		input.onSubmit = next => {
			try {
				apply(next);
				this.#notice = "";
				back();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#render();
			}
		};
		input.onEscape = back;
		this.#setScreen("input", input, `${title} · Enter save · Esc cancel`, { field, preview: true });
	}

	#showText(
		title: string,
		value: string,
		apply: (value: string) => void,
		back: () => void,
		field?: AgentDefinitionField,
		question?: string,
	): void {
		const editor = new HookEditorComponent(
			this.#tui,
			title,
			value,
			result => {
				try {
					const revision = this.#revision;
					this.#notice = "";
					apply(result);
					if (!this.#closed && revision === this.#revision) back();
				} catch (error) {
					this.#showText(
						title,
						result,
						apply,
						back,
						field,
						error instanceof Error ? error.message : String(error),
					);
				}
			},
			() => back(),
			{ externalEditor: this.#deps.externalEditor, question },
		);
		editor.focused = true;
		this.#setScreen("text", editor, "", { field });
	}

	#choose(options: {
		title: string;
		subtitle?: string;
		field?: AgentDefinitionField;
		current: string;
		options: readonly ChoiceOption[];
		pick: (value: string) => void;
		back: () => void;
	}): void {
		const items = options.options.map(option => ({
			value: option.value,
			label: option.value === options.current ? `${option.label}  ✓` : option.label,
			description: option.description,
		}));
		const list = this.#list(items, options.current);
		// A pick that opens a further screen owns the return; otherwise go back.
		list.onSelect = item =>
			this.#run(() => {
				const revision = this.#revision;
				options.pick(item.value);
				if (revision === this.#revision) options.back();
			});
		list.onCancel = options.back;
		this.#setScreen("choice", list, `${options.title} · Enter choose · Esc back`, {
			preview: true,
			field: options.field,
			sheet: {
				title: options.title,
				subtitle: options.subtitle ?? (options.field ? FIELD_HELP[options.field] : undefined),
				noun: "options",
				current: [options.current],
			},
		});
	}

	/** Enter toggles; Done or Esc applies, like the advisor tools editor. */
	#checklist(options: ChecklistOptions): void {
		const checklist = new Checklist({ ...options, selected: options.selected ?? [] });
		if (options.selected === undefined) checklist.selected = undefined;
		const back = (): void => this.#showDetail(options.field);
		const apply = (): void => {
			options.apply(checklist.selected);
			back();
		};
		const build = (cursor: string | undefined): void => {
			const items: SelectItem[] = [
				...checklist
					.items()
					.map(item =>
						item.value === "__defaults" && checklist.selected === undefined
							? { ...item, label: `${item.label}  ✓` }
							: item,
					),
				...(options.custom ? [{ value: "__custom", label: options.custom }] : []),
				{ value: DONE, label: "Done" },
			];
			const list = this.#list(items, cursor);
			list.onSelect = item =>
				this.#run(() => {
					if (item.value === DONE) return apply();
					if (item.value === "__custom")
						return this.#showInput(
							options.custom!.replace(/^\+\s*/, "").replace(/…$/, ""),
							"",
							value => {
								checklist.add(splitList(value) ?? []);
							},
							() => build(DONE),
							options.field,
						);
					checklist.toggle(item.value);
				});
			list.onCancel = apply;
			this.#setScreen("checklist", list, `${options.title} · Enter toggle · Done / Esc apply`, {
				preview: true,
				field: options.field,
				rebuild: build,
				sheet: {
					title: options.title,
					subtitle: options.subtitle,
					noun: "entries",
					current: checklist.current,
					confirm: "Toggle",
				},
			});
		};
		build(undefined);
	}

	// ───────────────────────────── field screens ─────────────────────────────

	#showTools(): void {
		const all = this.#deps.tools;
		const readOnly = this.#deps.readOnlyTools ?? [];
		this.#checklist({
			title: "Tools",
			subtitle: FIELD_HELP.tools,
			field: "tools",
			entries: [...all]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(tool => ({
					value: tool.name,
					label: tool.name,
					description: `${readOnly.includes(tool.name) ? "read-only · " : ""}${tool.description ?? ""}`,
				})),
			selected: this.#draft.tools,
			presets: [
				{
					value: "__defaults",
					label: "Default selection",
					description: "Omit the field; toggling individual tools starts an explicit list.",
					apply: () => undefined,
				},
				...(readOnly.length
					? [
							{
								value: "__readonly",
								label: "Read-only set",
								description: readOnly.filter(name => all.some(tool => tool.name === name)).join(", "),
								apply: () => readOnly.filter(name => all.some(tool => tool.name === name)),
							},
						]
					: []),
				{
					value: "__none",
					label: "No tools",
					description: "Select no built-ins explicitly; automatic, MCP, and custom tools can still be available.",
					apply: () => [],
				},
			],
			custom: "+ Add tool name (MCP or extension)…",
			apply: selected => this.#set("tools", selected),
		});
	}

	#showSpawns(): void {
		this.#checklist({
			title: "Allowed child agents",
			subtitle: FIELD_HELP.spawns,
			field: "spawns",
			ordered: true,
			entries: this.#deps.existing
				.filter(definition => definition.name !== this.#draft.name)
				.map(definition => ({
					value: definition.name,
					label: definition.name,
					description: firstLine(definition.description, ""),
				})),
			selected: Array.isArray(this.#draft.spawns) ? this.#draft.spawns : [],
			presets: [
				{
					value: "__none",
					label: "None",
					description: "Omit the field (a tools list with task still grants *).",
					apply: () => undefined,
				},
				{ value: "__any", label: "Any type (*)", description: "Every discovered agent.", apply: () => ["*"] },
			],
			custom: "+ Add agent name…",
			apply: selected =>
				this.#set(
					"spawns",
					!selected?.length ? undefined : selected.includes("*") ? "*" : selected.filter(name => name !== "*"),
				),
		});
	}

	#showModels(selected?: string): void {
		const models = this.#draft.model ?? [];
		const items: SelectItem[] = [
			...models.map((selector, index) => ({
				value: `entry:${index}`,
				label: `${index + 1}. ${selector}`,
				description: index === 0 ? "tried first" : "fallback",
			})),
			{ value: "add-model", label: "+ Add model…", description: "Pick from available models, then an effort" },
			{ value: "add-role", label: "+ Add role alias…", description: "@role follows the role's configured model" },
			{
				value: "add-pattern",
				label: "+ Add selector…",
				description: "provider/model, glob or regex, optional :effort",
			},
			...(models.length ? [{ value: "clear", label: "Clear (inherit the parent's model)" }] : []),
			{ value: DONE, label: "Done" },
		];
		const list = this.#list(items, selected ?? (models.length ? "entry:0" : "add-model"));
		const back = (): void => this.#showDetail("model");
		const add = (selector: string): void => this.#set("model", [...(this.#draft.model ?? []), selector]);
		list.onSelect = item =>
			this.#run(() => {
				const reopen = (): void => this.#showModels(item.value);
				if (item.value === DONE) return back();
				if (item.value === "clear") return this.#set("model", undefined);
				if (item.value === "add-model") return this.#pickModel("Add model", undefined, add, reopen);
				if (item.value === "add-role") return this.#pickRole(add, reopen);
				if (item.value === "add-pattern")
					return this.#showInput(
						"Model selector",
						"",
						value => {
							if (value.trim()) add(value.trim());
						},
						reopen,
						"model",
					);
				this.#modelEntry(Number(item.value.slice("entry:".length)));
			});
		list.onCancel = back;
		this.#setScreen("models", list, "Models in priority order · Enter edit entry · Esc back", {
			preview: true,
			field: "model",
			rebuild: next => this.#showModels(next),
			sheet: { title: "Models / roles", subtitle: FIELD_HELP.model, noun: "entries" },
		});
	}

	#modelEntry(index: number): void {
		const models = [...(this.#draft.model ?? [])];
		const selector = models[index];
		if (selector === undefined) return this.#showModels();
		const reopen = (): void => this.#showModels(`entry:${index}`);
		const replace = (next: string): void => {
			models[index] = next;
			this.#set("model", models);
		};
		const move = (delta: number): void => {
			const target = index + delta;
			if (target < 0 || target >= models.length) return;
			[models[index], models[target]] = [models[target]!, models[index]!];
			this.#set("model", models);
		};
		this.#choose({
			title: `Model entry ${index + 1}: ${selector}`,
			field: "model",
			current: "",
			options: [
				{ value: "model", label: "Replace with a model…" },
				{ value: "role", label: "Replace with a role alias…" },
				{ value: "edit", label: "Edit selector text…" },
				...(index > 0 ? [{ value: "up", label: "Move up" }] : []),
				...(index < models.length - 1 ? [{ value: "down", label: "Move down" }] : []),
				{ value: "remove", label: "Remove" },
			],
			pick: value => {
				if (value === "model") return this.#pickModel(`Replace ${selector}`, selector, replace, reopen);
				if (value === "role") return this.#pickRole(replace, reopen);
				if (value === "edit")
					return this.#showInput(
						"Model selector",
						selector,
						next => {
							if (!next.trim()) throw new Error("Use Remove to delete an entry.");
							replace(next.trim());
						},
						reopen,
						"model",
					);
				if (value === "up") move(-1);
				else if (value === "down") move(1);
				else if (value === "remove")
					this.#set(
						"model",
						models.filter((_, i) => i !== index).length ? models.filter((_, i) => i !== index) : undefined,
					);
			},
			back: reopen,
		});
	}

	#pickRole(apply: (selector: string) => void, back: () => void): void {
		const roles = this.#deps.roles ?? [];
		if (!roles.length) {
			this.#showInput("Role alias (@role)", "@", value => apply(value.trim()), back, "model");
			return;
		}
		this.#choose({
			title: "Role alias",
			field: "model",
			current: "",
			options: roles.map(role => ({
				value: `@${role.id}`,
				label: `@${role.id}`,
				description: role.description ?? role.label,
			})),
			pick: apply,
			back,
		});
	}

	/** The rich model browser, then an effort step for models that support one. */
	#pickModel(title: string, current: string | undefined, apply: (selector: string) => void, back: () => void): void {
		const source = this.#deps.browserSource;
		if (!source) {
			this.#showInput(
				title,
				current ?? "",
				value => {
					if (value.trim()) apply(value.trim());
				},
				back,
				this.#helpField,
			);
			return;
		}
		let models: readonly Model[] = [];
		try {
			models = this.#deps.getAvailableModels?.() ?? [];
		} catch {
			models = [];
		}
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder: source.mruOrder });
		const browser = new ModelBrowser(source, {});
		browser.setMruOrder(source.mruOrder);
		browser.setPerfStats(source.modelPerf);
		browser.setItems(items);
		const base = current?.replace(EFFORT_SUFFIX, "");
		if (base) browser.selectSelector(base);
		browser.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			if (!efforts.length) {
				apply(item.selector);
				back();
				return;
			}
			this.#choose({
				title: `Effort for ${item.selector}`,
				current: current?.startsWith(`${item.selector}:`) ? current.slice(item.selector.length + 1) : "",
				options: [
					{
						value: "",
						label: "No suffix",
						description: "The agent's thinking level or the model default applies.",
					},
					...efforts.map(effort => ({
						value: effort,
						label: effort,
						description: parseThinkingLevel(effort)
							? getThinkingLevelMetadata(parseThinkingLevel(effort)!).description
							: undefined,
					})),
				],
				pick: effort => apply(effort ? `${item.selector}:${effort}` : item.selector),
				back,
			});
		};
		browser.onCancel = back;
		this.#setScreen("model-browser", browser, `${title} · / search · Enter pick · Esc back`, {
			field: this.#helpField,
		});
	}

	#showPrewalk(): void {
		const back = (): void => this.#showDetail("prewalk");
		const prewalk = this.#draft.prewalk;
		this.#choose({
			title: "Prewalk",
			field: "prewalk",
			current: prewalk === undefined ? "" : prewalk === true ? "on" : prewalk === false ? "off" : "target",
			options: [
				{
					value: "",
					label: "Default",
					description: "Omit the field: off (the bundled task agent follows task.prewalk).",
				},
				{
					value: "on",
					label: "On — configured target",
					description: "Hand off to the prewalk target after the first edit.",
				},
				{ value: "off", label: "Off", description: "Never hand off." },
				{
					value: "model",
					label: "Choose a target model…",
					description:
						typeof prewalk === "string" ? `Current: ${prewalk}` : "Model and effort after the first edit.",
				},
				{
					value: "pattern",
					label: "Enter a target selector…",
					description: "@role, pattern or provider/model:effort.",
				},
			],
			pick: value => {
				if (value === "model")
					return this.#pickModel(
						"Prewalk target",
						typeof prewalk === "string" ? prewalk : undefined,
						selector => this.#set("prewalk", selector),
						back,
					);
				if (value === "pattern")
					return this.#showInput(
						"Prewalk target selector",
						typeof prewalk === "string" ? prewalk : "",
						selector => this.#set("prewalk", selector.trim() || undefined),
						back,
						"prewalk",
					);
				this.#set("prewalk", value === "on" ? true : value === "off" ? false : undefined);
			},
			back,
		});
	}

	#advisor(): void {
		const back = (): void => this.#showDetail("advisor");
		const advisor = this.#draft.advisor;
		const current =
			advisor === undefined
				? ""
				: advisor === true
					? "role"
					: advisor === false
						? "off"
						: typeof advisor === "string"
							? "model"
							: "ref" in advisor
								? "named"
								: "inline";
		this.#choose({
			title: "Advisor",
			field: "advisor",
			current,
			options: [
				{ value: "", label: "None (default)", description: "Subagents run without an advisor." },
				{ value: "role", label: "Advisor role", description: "Opt in with the advisor role and catalog." },
				{ value: "off", label: "Disabled", description: "advisor: false" },
				{
					value: "model",
					label: "Advisor role with another model…",
					description:
						typeof advisor === "string" ? `Current: ${advisor}` : "A model or @role selector for the advisor.",
				},
				{
					value: "named",
					label: "Named advisor…",
					description:
						typeof advisor === "object" && "ref" in advisor ? `Current: ${advisor.ref}` : "One WATCHDOG entry.",
				},
				{
					value: "inline",
					label: "Private advisor…",
					description:
						typeof advisor === "object" && "inline" in advisor
							? `Current: ${advisor.inline.name}`
							: "Defined in this file only.",
				},
			],
			pick: value => {
				if (value === "") delete this.#draft.advisor;
				else if (value === "role") this.#draft.advisor = true;
				else if (value === "off") this.#draft.advisor = false;
				else if (value === "model")
					this.#showInput(
						"Advisor model or @role",
						typeof advisor === "string" ? advisor : "@advisor",
						selector => {
							this.#draft.advisor = selector.trim() || true;
						},
						back,
						"advisor",
					);
				else if (value === "named") void this.#namedAdvisors(back);
				else if (value === "inline") this.#inlineAdvisor(() => this.#advisor());
			},
			back,
		});
	}

	async #namedAdvisors(back: () => void): Promise<void> {
		try {
			const advisors = await this.#deps.listAdvisors();
			// The advisor choice already returned to the detail list; open only if the user is still there.
			if (this.#closed || this.#screen !== "detail") return;
			if (!advisors.length) {
				this.#notice = "No named advisors are configured (WATCHDOG.yml).";
				this.#render();
				return;
			}
			const current =
				typeof this.#draft.advisor === "object" && "ref" in this.#draft.advisor ? this.#draft.advisor : undefined;
			this.#choose({
				title: "Named advisors",
				field: "advisor",
				current: current ? `${current.ref}\u0000${current.scope ?? ""}` : "",
				options: advisors.map(advisor => ({
					value: `${advisor.name}\u0000${advisor.scope}`,
					label: advisor.name,
					description: `${advisor.scope} · ${advisor.config.model ?? "advisor role"}`,
				})),
				pick: value => {
					const [ref, scope] = value.split("\u0000");
					const match = advisors.find(advisor => advisor.name === ref && advisor.scope === scope);
					if (match) this.#draft.advisor = { ref: match.name, scope: match.scope };
				},
				back,
			});
		} catch (error) {
			this.#notice = String(error);
			this.#render();
		}
	}

	// ───────────────────────────── nested forms (advisor, output) ─────────────────────────────

	#push(title: string, rows: () => FormRow[]): void {
		const current = this.#pages.at(-1);
		if (current && this.#active instanceof SelectList) current.selected = this.#active.getSelectedItem()?.value;
		this.#pages.push({ title, rows });
		this.#showForm();
	}
	#pop(): void {
		this.#pages.pop();
		if (this.#pages.length) this.#showForm(this.#pages.at(-1)!.selected);
		else if (this.#formBack) this.#formBack();
		else this.#showDetail(this.#helpField);
	}
	#showForm(selected?: string): void {
		const page = this.#pages.at(-1);
		if (!page) return this.#showDetail(this.#helpField);
		const field = this.#helpField;
		const rows = page.rows();
		const list = this.#list(
			rows.map(formRow => ({
				value: formRow.id,
				label: formRow.label,
				description: formRow.value ? sanitizeDisplaySingleLine(formRow.value) : undefined,
			})),
			selected ?? page.selected,
		);
		list.onSelect = item =>
			this.#run(() => {
				const formRow = page.rows().find(candidate => candidate.id === item.value);
				formRow?.activate();
			});
		list.onCancel = () => this.#pop();
		this.#setScreen("form", list, `${page.title} · Enter edit · Esc back`, {
			preview: true,
			field,
			rebuild: next => {
				if (this.#pages.at(-1) === page) this.#showForm(next);
			},
			sheet: { title: page.title, subtitle: field ? FIELD_HELP[field] : undefined, noun: "fields" },
		});
	}
	/** A text edit opened from a form returns to the same form row. */
	#prompt(title: string, value: string, apply: (value: string) => void): void {
		const page = this.#pages.at(-1);
		const selected = this.#active instanceof SelectList ? this.#active.getSelectedItem()?.value : undefined;
		const field = this.#helpField;
		this.#showText(
			title,
			value,
			apply,
			() => {
				if (page && this.#pages.at(-1) === page) {
					this.#helpField = field;
					this.#showForm(selected);
				} else this.#showDetail(field);
			},
			field,
		);
	}
	/** `back` is where Esc on the form's first page returns; omitted, it returns to the field list. */
	#enterForm(field: AgentDefinitionField, title: string, rows: () => FormRow[], back?: () => void): void {
		this.#pages = [];
		this.#helpField = field;
		this.#formBack = back;
		this.#push(title, rows);
	}

	#inlineAdvisor(back: () => void): void {
		if (typeof this.#draft.advisor !== "object" || !("inline" in this.#draft.advisor))
			this.#draft.advisor = { inline: { name: `${this.#draft.name || "agent"} advisor` } };
		const get = (): InlineAgentAdvisor => (this.#draft.advisor as { inline: InlineAgentAdvisor }).inline;
		const fields: {
			key: keyof AdvisorConfig;
			label: string;
			kind: "text" | "boolean" | "number";
			choices?: string[];
		}[] = [
			{ key: "name", label: "Name", kind: "text" },
			{ key: "model", label: "Model / role", kind: "text" },
			{ key: "instructions", label: "Instructions", kind: "text" },
			{ key: "systemPrompt", label: "Base system prompt override", kind: "text" },
			{ key: "enabled", label: "Enabled", kind: "boolean" },
			{ key: "includeThinking", label: "Include primary thinking", kind: "boolean" },
			{ key: "maxNotesPerUpdate", label: "Maximum notes per update", kind: "number" },
			{ key: "reviewMode", label: "Review mode", kind: "text", choices: ["turn", "agent-end"] },
			{ key: "reviewInterval", label: "Review interval", kind: "number" },
			{ key: "syncBacklog", label: "Sync backlog", kind: "text", choices: ["off", "1", "3", "5", "strict"] },
			{ key: "scope", label: "Attach to session kinds", kind: "text", choices: ["main", "subagent", "all"] },
		];
		this.#enterForm(
			"advisor",
			"Private advisor — saved in this definition only",
			() => [
				...fields.map(field => ({
					id: field.key,
					label: field.label,
					value: displayValue(get()[field.key]),
					field: "advisor" as const,
					activate: () => {
						const set = (value: unknown): void => {
							if (value === undefined) delete get()[field.key];
							else Object.assign(get(), { [field.key]: value });
						};
						if (field.kind === "boolean") {
							set(get()[field.key] === undefined ? true : get()[field.key] === true ? false : undefined);
							return;
						}
						if (field.choices) {
							this.#push(field.label, () =>
								[undefined, ...field.choices!].map(value => ({
									id: value ?? "default",
									label: value ?? "Default",
									value: get()[field.key] === value ? "✓" : "",
									field: "advisor",
									activate: () => {
										set(value);
										this.#pop();
									},
								})),
							);
							return;
						}
						this.#prompt(field.label, get()[field.key] === undefined ? "" : String(get()[field.key]), value => {
							if (field.kind === "number") {
								if (!value.trim()) set(undefined);
								else {
									const number = Number(value);
									if (!Number.isSafeInteger(number) || number < 1)
										throw new Error("Enter a positive whole number");
									set(number);
								}
							} else if (field.key === "name" && !value.trim())
								throw new Error("A private advisor needs a name");
							else set(value || undefined);
						});
					},
				})),
				...(["nit", "concern", "blocker"] as const).map(severity => ({
					id: `delivery:${severity}`,
					label: `${severity} delivery`,
					value: get().delivery?.[severity] ?? "Default",
					field: "advisor" as const,
					activate: () =>
						this.#push(`${severity} delivery`, () =>
							[undefined, "on-yield", "next-tool-call"].map(value => ({
								id: value ?? "default",
								label: value ?? "Default",
								field: "advisor",
								activate: () => {
									const delivery = { ...get().delivery };
									if (value === undefined) delete delivery[severity];
									else delivery[severity] = value as "on-yield" | "next-tool-call";
									get().delivery = delivery;
									this.#pop();
								},
							})),
						),
				})),
				{
					id: "tools",
					label: "Tools…",
					value: displayValue(get().tools),
					field: "advisor",
					activate: () =>
						this.#push("Private advisor tools", () => [
							{
								id: "default",
								label: "Use default tools",
								field: "advisor",
								value: get().tools === undefined ? "[x]" : "[ ]",
								activate: () => {
									get().tools = get().tools === undefined ? [] : undefined;
								},
							},
							...this.#deps.tools.map(tool => ({
								id: tool.name,
								label: tool.name,
								field: "advisor" as const,
								value: get().tools?.includes(tool.name) ? "[x]" : "[ ]",
								activate: () => {
									const selected = get().tools ?? [];
									get().tools = selected.includes(tool.name)
										? selected.filter(name => name !== tool.name)
										: [...selected, tool.name];
								},
							})),
						]),
				},
			],
			back,
		);
	}

	#output(): void {
		if (typeof this.#draft.output === "string") {
			try {
				this.#draft.output = JSON.parse(this.#draft.output);
			} catch {
				this.#notice =
					"The output schema is not valid JSON. Edit it as JSON or in the raw definition to repair it.";
			}
		}
		let jtd = this.#deps.outputSchemaDialect?.(this.#draft.output) === "jtd";
		const variants = new Map<boolean, unknown>();
		const blank = (): unknown =>
			jtd ? { properties: {}, optionalProperties: {} } : { type: "object", properties: {}, required: [] };
		const enabled = (): boolean =>
			this.#draft.output !== undefined && this.#draft.output !== null && this.#draft.output !== false;
		this.#enterForm("output", "Structured output", () => [
			{
				id: "enable",
				label: "Enable structured output",
				value: enabled() ? "[x]" : "[ ]",
				field: "output",
				activate: () => {
					this.#draft.output = enabled() ? undefined : blank();
				},
			},
			{
				id: "format",
				label: "Schema format",
				value: jtd ? "JSON Type Definition" : "JSON Schema",
				field: "output",
				activate: () => {
					variants.set(jtd, this.#draft.output);
					jtd = !jtd;
					this.#draft.output = variants.get(jtd) ?? blank();
				},
			},
			{
				id: "json",
				label: "Edit schema as JSON…",
				field: "output",
				activate: () =>
					this.#prompt(
						"Output schema (JSON)",
						this.#draft.output === undefined ? "" : JSON.stringify(this.#draft.output, null, 2),
						value => {
							if (!value.trim()) {
								delete this.#draft.output;
								return;
							}
							const parsed: unknown = JSON.parse(value);
							if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
								throw new Error("The schema must be a JSON object.");
							this.#draft.output = parsed;
							jtd = this.#deps.outputSchemaDialect?.(parsed) === "jtd";
						},
					),
			},
			...(!enabled()
				? []
				: this.#schemaRows(
						() => this.#draft.output,
						value => {
							this.#draft.output = value;
						},
						jtd,
					)),
		]);
	}

	#schemaRows(get: () => unknown, set: (value: unknown) => void, jtd = false): FormRow[] {
		const schema = record(get());
		const properties = { ...record(schema.properties), ...(jtd ? record(schema.optionalProperties) : {}) };
		const update = (key: string, value: unknown): void => {
			const next = { ...record(get()) };
			if (value === undefined) delete next[key];
			else next[key] = value;
			set(next);
		};
		const description = jtd ? record(schema.metadata).description : schema.description;
		const types = jtd
			? [
					"object",
					"array",
					"string",
					"boolean",
					"timestamp",
					"float32",
					"float64",
					"int8",
					"uint8",
					"int16",
					"uint16",
					"int32",
					"uint32",
				]
			: ["object", "array", "string", "number", "integer", "boolean", "null"];
		const schemaType =
			schema.type ??
			(schema.elements ? "array" : schema.properties || schema.optionalProperties ? "object" : undefined);
		return [
			{
				id: "type",
				label: "Type",
				value: displayValue(schemaType),
				field: "output",
				activate: () =>
					this.#push("Output type", () =>
						types.map(type => ({
							id: type,
							label: type,
							value: type === schemaType ? "✓" : "",
							field: "output",
							activate: () => {
								if (!jtd) update("type", type);
								else {
									const next = { ...record(get()) };
									for (const key of [
										"type",
										"elements",
										"values",
										"enum",
										"ref",
										"discriminator",
										"mapping",
										"properties",
										"optionalProperties",
									])
										delete next[key];
									if (type === "object")
										Object.assign(next, {
											properties: schema.properties ?? {},
											optionalProperties: schema.optionalProperties ?? {},
										});
									else if (type === "array") next.elements = schema.elements ?? {};
									else next.type = type;
									set(next);
								}
								this.#pop();
							},
						})),
					),
			},
			{
				id: "description",
				label: "Description",
				value: displayValue(description),
				field: "output",
				activate: () =>
					this.#prompt("Field description", typeof description === "string" ? description : "", value => {
						if (jtd) {
							const metadata = { ...record(record(get()).metadata) };
							if (value) metadata.description = value;
							else delete metadata.description;
							update("metadata", metadata);
						} else update("description", value || undefined);
					}),
			},
			...Object.keys(properties).map(name => ({
				id: `property:${name}`,
				label: name,
				value: `${displayValue(record(properties[name]).type)}${jtd ? (Object.hasOwn(record(schema.properties), name) ? " · Required" : " · Optional") : Array.isArray(schema.required) && schema.required.includes(name) ? " · Required" : " · Optional"}`,
				field: "output" as const,
				activate: () => this.#schemaProperty(get, set, name, jtd),
			})),
			{
				id: "add-field",
				label: "+ New output field",
				field: "output",
				activate: () =>
					this.#prompt("New output field name", "", name => {
						if (!name.trim()) throw new Error("Field name is required");
						const next = { ...record(get()) };
						if (
							Object.hasOwn(record(next.properties), name) ||
							(jtd && Object.hasOwn(record(next.optionalProperties), name))
						)
							throw new Error("That field already exists");
						const bucket = jtd ? "optionalProperties" : "properties";
						if (jtd)
							for (const key of ["type", "elements", "values", "enum", "ref", "discriminator", "mapping"])
								delete next[key];
						else next.type ??= "object";
						next[bucket] = { ...record(next[bucket]), [name]: { type: "string" } };
						set(next);
					}),
			},
			{
				id: "items",
				label: "Array item schema…",
				value: displayValue(jtd ? schema.elements : schema.items),
				field: "output",
				activate: () =>
					this.#push("Array items", () =>
						this.#schemaRows(
							() => record(get())[jtd ? "elements" : "items"],
							value => update(jtd ? "elements" : "items", value),
							jtd,
						),
					),
			},
			{
				id: "keywords",
				label: jtd
					? "Enums, records, tagged unions, references and metadata…"
					: "Constraints, unions and other schema keywords…",
				field: "output",
				activate: () => this.#jsonObject("Schema keywords", get, set),
			},
		];
	}

	#schemaProperty(get: () => unknown, set: (value: unknown) => void, initialName: string, jtd = false): void {
		let name = initialName;
		const bucket = (): string =>
			jtd && Object.hasOwn(record(record(get()).optionalProperties), name) ? "optionalProperties" : "properties";
		const childGet = (): unknown => record(record(get())[bucket()])[name];
		const childSet = (value: unknown): void => {
			const root = record(get());
			const key = bucket();
			set({ ...root, [key]: { ...record(root[key]), [name]: value } });
		};
		this.#push(`Output field: ${name}`, () => [
			{
				id: "name",
				label: "Field name",
				value: name,
				field: "output",
				activate: () =>
					this.#prompt("Field name", name, nextName => {
						if (!nextName.trim()) throw new Error("Field name is required");
						const root = record(get());
						const key = bucket();
						const props = { ...record(root[key]) };
						if (
							nextName !== name &&
							(Object.hasOwn(record(root.properties), nextName) ||
								(jtd && Object.hasOwn(record(root.optionalProperties), nextName)))
						)
							throw new Error("That field already exists");
						const value = props[name];
						delete props[name];
						props[nextName] = value;
						set({
							...root,
							[key]: props,
							...(!jtd && Array.isArray(root.required)
								? { required: root.required.map(item => (item === name ? nextName : item)) }
								: {}),
						});
						name = nextName;
					}),
			},
			{
				id: "required",
				label: "Required",
				value: jtd
					? bucket() === "properties"
						? "[x]"
						: "[ ]"
					: Array.isArray(record(get()).required) && (record(get()).required as unknown[]).includes(name)
						? "[x]"
						: "[ ]",
				field: "output",
				activate: () => {
					const root = record(get());
					if (jtd) {
						const from = bucket();
						const to = from === "properties" ? "optionalProperties" : "properties";
						const properties = { ...record(root[from]) };
						const value = properties[name];
						delete properties[name];
						set({ ...root, [from]: properties, [to]: { ...record(root[to]), [name]: value } });
					} else {
						const required = Array.isArray(root.required) ? root.required : [];
						set({
							...root,
							required: required.includes(name) ? required.filter(item => item !== name) : [...required, name],
						});
					}
				},
			},
			...this.#schemaRows(childGet, childSet, jtd),
			{
				id: "delete",
				label: "Remove this field",
				activate: () => {
					const root = record(get());
					const key = bucket();
					const props = { ...record(root[key]) };
					delete props[name];
					set({
						...root,
						[key]: props,
						...(!jtd && Array.isArray(root.required)
							? { required: root.required.filter(item => item !== name) }
							: {}),
					});
					this.#pop();
				},
			},
		]);
	}

	/** Recursive typed data editor keeps every JSON Schema keyword expressible without YAML. */
	#jsonObject(title: string, get: () => unknown, set: (value: unknown) => void): void {
		this.#push(title, () => [
			...Object.entries(record(get())).map(([key, value]) => ({
				id: key,
				label: key,
				value: displayValue(value),
				field: "output" as const,
				activate: () =>
					this.#jsonValue(
						key,
						() => record(get())[key],
						next => {
							const root = { ...record(get()) };
							if (next === undefined) delete root[key];
							else root[key] = next;
							set(root);
						},
					),
			})),
			{
				id: "add",
				label: "+ New keyword",
				field: "output",
				activate: () =>
					this.#prompt("Schema keyword (enum, anyOf, minimum, $ref…)", "", key => {
						if (!key.trim()) throw new Error("Keyword is required");
						set({ ...record(get()), [key]: null });
					}),
			},
		]);
	}

	#jsonValue(title: string, get: () => unknown, set: (value: unknown) => void): void {
		this.#push(title, () => [
			{
				id: "text",
				label: "Text",
				field: "output",
				value: typeof get() === "string" ? String(get()) : "",
				activate: () => this.#prompt(title, typeof get() === "string" ? String(get()) : "", set),
			},
			{
				id: "number",
				label: "Number",
				field: "output",
				value: typeof get() === "number" ? String(get()) : "",
				activate: () =>
					this.#prompt(title, typeof get() === "number" ? String(get()) : "", value => {
						const number = Number(value);
						if (!Number.isFinite(number)) throw new Error("Enter a finite number");
						set(number);
					}),
			},
			{
				id: "boolean",
				label: "Boolean",
				field: "output",
				value: typeof get() === "boolean" ? String(get()) : "",
				activate: () => set(get() !== true),
			},
			{ id: "null", label: "Null", field: "output", value: get() === null ? "✓" : "", activate: () => set(null) },
			{
				id: "object",
				label: "Object…",
				field: "output",
				value: get() && typeof get() === "object" && !Array.isArray(get()) ? "Configured" : "",
				activate: () => {
					if (!get() || typeof get() !== "object" || Array.isArray(get())) set({});
					this.#jsonObject(title, get, set);
				},
			},
			{
				id: "array",
				label: "Array…",
				field: "output",
				value: Array.isArray(get()) ? `${(get() as unknown[]).length} items` : "",
				activate: () => {
					if (!Array.isArray(get())) set([]);
					this.#jsonArray(title, get, set);
				},
			},
			{
				id: "delete",
				label: "Remove keyword",
				field: "output",
				activate: () => {
					set(undefined);
					this.#pop();
				},
			},
		]);
	}

	#jsonArray(title: string, get: () => unknown, set: (value: unknown) => void): void {
		const items = (): unknown[] => (Array.isArray(get()) ? (get() as unknown[]) : []);
		this.#push(`${title} items`, () => [
			...items().map((value, index) => ({
				id: String(index),
				label: `${index + 1}`,
				value: displayValue(value),
				field: "output" as const,
				activate: () =>
					this.#jsonValue(
						`${title}[${index}]`,
						() => items()[index],
						next => {
							const array = [...items()];
							if (next === undefined) array.splice(index, 1);
							else array[index] = next;
							set(array);
						},
					),
			})),
			{
				id: "add",
				label: "+ New item",
				field: "output",
				activate: () => set([...items(), null]),
			},
		]);
	}

	// ───────────────────────────── generation, save, delete ─────────────────────────────

	async #generationSourcePicker(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#render();
		let sources: readonly AgentGenerationSource[];
		try {
			sources = this.#deps.listGenerationSources ? await this.#deps.listGenerationSources() : [];
		} catch (error) {
			if (!this.#closed) this.#notice = error instanceof Error ? error.message : String(error);
			return;
		} finally {
			this.#busy = false;
			this.#render();
		}
		if (this.#closed) return;
		const knownAgents = new Set(sources.filter(source => source.kind === "agent").map(source => source.name));
		const bases = this.#deps.existing.filter(definition => !knownAgents.has(definition.name));
		const entries: SelectItem[] = [
			...bases.map((definition, index) => ({
				value: `base:${index}`,
				label: `agent: ${sanitizeDisplaySingleLine(definition.name)}`,
				description: sanitizeDisplaySingleLine(firstLine(definition.description, "")),
			})),
			...sources.map((source, index) => ({
				value: `source:${index}`,
				label: `${sanitizeDisplaySingleLine(source.kind)}: ${sanitizeDisplaySingleLine(source.name)}`,
				description: sanitizeDisplaySingleLine(firstLine(source.description ?? "", "")),
			})),
		];
		const checklist = new Checklist({ entries, selected: [] });
		const next = { value: "generate", label: "Continue to instructions…" };
		const build = (cursor: string | undefined): void => {
			const list = this.#list([next, ...checklist.items()], cursor);
			list.onSelect = item =>
				this.#run(() => {
					if (item.value !== "generate") {
						checklist.toggle(item.value);
						list.setItems([next, ...checklist.items()]);
						if (this.#sheet) this.#sheet = { ...this.#sheet, current: checklist.current };
						return;
					}
					const selected = new Set(checklist.selected);
					const baseDefinitions = bases.filter((_, index) => selected.has(`base:${index}`));
					const pickedSources = sources.filter((_, index) => selected.has(`source:${index}`));
					this.#showText(
						"What should the new agent do?",
						"",
						comment => {
							const instructions = comment.trim();
							if (!instructions && !selected.size)
								throw new Error("Describe the agent or select at least one source.");
							void this.#generate("all", instructions || undefined, {
								...(baseDefinitions.length ? { baseDefinitions } : {}),
								...(pickedSources.length ? { sources: pickedSources } : {}),
							});
						},
						() => build("generate"),
						undefined,
						"Describe what to use from the selected sources; optional when sources are selected.",
					);
				});
			list.onCancel = () => this.#showDetail("from-existing");
			this.#setScreen("checklist", list, "Generation sources · Enter toggle or continue · Esc back", {
				sheet: {
					title: "Generation sources",
					subtitle: "Select references to give to the author, then continue to instructions.",
					noun: "sources",
					current: checklist.current,
					confirm: "Select",
				},
			});
		};
		build(undefined);
	}

	async #generate(
		target: AgentDefinitionField | "all",
		comment?: string,
		references?: GenerationReferences,
	): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#notice = "";
		const controller = new AbortController();
		this.#controller = controller;
		const returnTo = target === "all" ? (references ? "from-existing" : "generate") : target;
		const cancel = this.#list([{ value: "cancel", label: "The author is writing…" }], "cancel");
		cancel.onSelect = cancel.onCancel = () => {
			controller.abort();
			this.#busy = false;
			this.#showDetail(returnTo);
		};
		this.#setScreen("generating", cancel, `Generating · ${interruptKey()} cancel`, {
			preview: true,
			field: target === "all" ? undefined : target,
		});
		try {
			const result = await this.#deps.generate({
				definition: this.definition,
				target,
				comment,
				...references,
				conversationId: this.#conversationId,
				signal: controller.signal,
			});
			if (this.#closed || controller.signal.aborted) return;
			Object.assign(this.#draft, result.fields);
			this.#conversationId = result.conversationId;
			this.#notice =
				target === "all"
					? "Generated; review every field before saving."
					: `Regenerated ${FIELD_BY_KEY.get(target)?.label}.`;
		} catch (error) {
			if (!controller.signal.aborted) this.#notice = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.#controller === controller) {
				this.#busy = false;
				this.#controller = undefined;
				if (!this.#closed && !controller.signal.aborted) this.#showDetail(returnTo);
			}
			this.#render();
		}
	}

	async #openDefinitionFile(): Promise<void> {
		const open = this.#deps.openDefinitionFile;
		if (!open || !this.rosterVisible || this.#busy) return;
		if (this.dirty) {
			this.#notice = "Save or discard draft changes before opening the backing file.";
			this.#render();
			return;
		}
		this.#busy = true;
		this.#notice = "";
		this.#render();
		try {
			await open();
		} catch (error) {
			if (!this.#closed) this.#notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
			this.#render();
		}
	}

	async #save(options?: { asCopy?: boolean }, draft: AgentDefinitionDraft = this.#draft): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			await this.#deps.save(structuredClone(draft), this.#scope, options);
			if (!this.#closed) {
				this.dispose();
				this.#close();
			}
		} catch (error) {
			this.#notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.#busy = false;
			this.#render();
		}
	}

	#showCopy(): void {
		const taken = new Set(this.#deps.existing.map(definition => definition.name));
		let suggestion = `${this.#draft.name || "agent"}-copy`;
		for (let suffix = 2; taken.has(suggestion); suffix++)
			suggestion = `${this.#draft.name || "agent"}-copy-${suffix}`;
		this.#showInput(
			"Name for the new copy",
			suggestion,
			value => {
				const name = value.trim();
				if (!name) throw new Error("A name is required.");
				if (taken.has(name)) throw new Error(`An agent named "${name}" already exists.`);
				void this.#save({ asCopy: true }, { ...this.#draft, name });
			},
			() => {
				if (!this.#closed) this.#showDetail("copy");
			},
			"name",
		);
	}

	#confirmDelete(): void {
		const remove = this.#deps.remove;
		if (!remove) return;
		const list = this.#list(
			[
				{ value: "cancel", label: "Cancel", description: "Keep the file" },
				{ value: "confirm", label: "Delete definition file", description: this.#draft.name },
			],
			"cancel",
		);
		list.onCancel = () => this.#showDetail("delete");
		list.onSelect = item => {
			if (item.value !== "confirm") return this.#showDetail("delete");
			this.#busy = true;
			void remove().then(
				() => {
					this.#busy = false;
					if (!this.#closed) {
						this.dispose();
						this.#close();
					}
				},
				error => {
					this.#busy = false;
					this.#notice = error instanceof Error ? error.message : String(error);
					this.#showDetail("delete");
				},
			);
		};
		this.#setScreen("confirm", list, `Delete ${this.#draft.name}? · Enter choose · Esc cancel`, {
			sheet: {
				title: `Delete ${this.#draft.name}?`,
				subtitle: "Removes the file; a bundled agent of the same name reappears.",
				noun: "options",
			},
		});
	}

	/** Leaving with unsaved changes asks first; a clean draft closes at once. */
	#leave(): void {
		if (!this.dirty) {
			this.dispose();
			this.#close();
			return;
		}
		const list = this.#list(
			[
				{ value: "keep", label: "Keep editing" },
				{ value: "save", label: "Save and close" },
				{ value: "discard", label: "Discard changes" },
			],
			"keep",
		);
		list.onCancel = () => this.#showDetail();
		list.onSelect = item => {
			if (item.value === "save") void this.#save();
			else if (item.value === "discard") {
				this.dispose();
				this.#close();
			} else this.#showDetail();
		};
		this.#setScreen("confirm", list, "Unsaved changes · Enter choose · Esc keep editing", {
			sheet: { title: "Unsaved changes", subtitle: "Save, discard, or keep editing.", noun: "options" },
		});
	}

	// ───────────────────────────── preview ─────────────────────────────

	#previewField(): AgentDefinitionField | undefined {
		if (this.#helpField) return this.#helpField;
		if (this.#screen !== "detail" || !(this.#active instanceof SelectList)) return undefined;
		const value = this.#active.getSelectedItem()?.value;
		return value && FIELD_KEYS.has(value) ? (value as AgentDefinitionField) : undefined;
	}

	#previewBlocks(): PreviewBlock[] {
		const blocks: PreviewBlock[] = [
			{ kind: "title", text: this.#draft.name || "(unnamed agent)", sub: firstLine(this.#draft.description, "") },
		];
		const field = this.#previewField();
		const inspection = this.#inspect();
		if (field) {
			const findings = inspection?.findings.filter(finding => finding.field === field) ?? [];
			blocks.push({ kind: "section", text: FIELD_BY_KEY.get(field)!.label });
			blocks.push({ kind: "text", text: FIELD_HELP[field], tone: "muted" });
			for (const finding of findings) blocks.push({ kind: "finding", level: finding.level, text: finding.text });
		}
		if (inspection?.facts.length) {
			blocks.push({ kind: "section", text: "What the harness will do" });
			blocks.push({ kind: "kv", items: inspection.facts });
		}
		const others = inspection?.findings.filter(finding => finding.field !== field) ?? [];
		if (others.length) {
			blocks.push({ kind: "section", text: "Findings" });
			for (const finding of others) blocks.push({ kind: "finding", level: finding.level, text: finding.text });
		}
		let file: string;
		try {
			file = this.#deps.serialize(this.#draft);
		} catch (error) {
			file = `# cannot serialize: ${String(error)}`;
		}
		const lines = file.split("\n");
		const end = lines.indexOf("---", 1);
		const head = end > 0 ? lines.slice(0, end + 1) : lines;
		const body = end > 0 ? lines.slice(end + 1).filter((line, index) => index > 0 || line.trim()) : [];
		blocks.push({ kind: "section", text: `File · ${this.#scope} scope` });
		blocks.push({
			kind: "code",
			lines: [...head, ...body.slice(0, 8), ...(body.length > 8 ? [`… ${body.length - 8} more body lines`] : [])],
		});
		return blocks;
	}

	#previewLines(width: number): string[] {
		const lines: string[] = [];
		for (const block of this.#previewBlocks()) {
			switch (block.kind) {
				case "title":
					lines.push(theme.bold(sanitizeDisplaySingleLine(block.text)));
					if (block.sub)
						lines.push(...wrap(sanitizeDisplaySingleLine(block.sub), width).map(line => theme.fg("dim", line)));
					break;
				case "section":
					lines.push("", theme.fg("accent", block.text));
					break;
				case "kv":
					for (const item of block.items)
						lines.push(...wrap(`${theme.fg("dim", `${item.k}:`)} ${sanitizeDisplaySingleLine(item.v)}`, width));
					break;
				case "finding":
					lines.push(
						...wrap(`${block.level === "warn" ? "⚠" : "ℹ"} ${sanitizeDisplaySingleLine(block.text)}`, width).map(
							line => theme.fg(block.level === "warn" ? "warning" : "muted", line),
						),
					);
					break;
				case "text":
					lines.push(
						...wrap(sanitizeDisplaySingleLine(block.text), width).map(line =>
							theme.fg(block.tone ?? "muted", line),
						),
					);
					break;
				case "code":
					for (const line of block.lines)
						lines.push(...wrap(sanitizeDisplaySingleLine(line), width).map(part => theme.fg("dim", part)));
					break;
			}
		}
		return lines.map(line => truncateToWidth(line, width));
	}

	#nativePreview(): NativeChild[] {
		const children: NativeChild[] = [];
		for (const block of this.#previewBlocks()) {
			switch (block.kind) {
				case "title":
					children.push(text([span(block.text, "strong")]));
					if (block.sub) children.push(text([span(block.sub, "muted")], { wrap: "word" }));
					break;
				case "section":
					children.push(text([span(block.text, "accent")]));
					break;
				case "kv":
					children.push(node("kv", { items: block.items.map(item => ({ k: item.k, v: item.v })) }));
					break;
				case "finding":
					children.push(
						text(
							[
								span(
									`${block.level === "warn" ? "⚠" : "ℹ"} ${block.text}`,
									block.level === "warn" ? "warning" : "muted",
								),
							],
							{
								wrap: "word",
							},
						),
					);
					break;
				case "text":
					children.push(text([span(block.text, "muted")], { wrap: "word" }));
					break;
				case "code":
					children.push(node("code", { text: block.lines.join("\n"), lang: "yaml" }));
					break;
			}
		}
		return children;
	}

	// ───────────────────────────── render ─────────────────────────────

	#renderActive(width: number, height: number | undefined): readonly string[] {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRows));
		if (this.#active instanceof SelectList) this.#active.setMaxVisible(Math.max(1, rows - 1));
		else if (this.#active instanceof ModelBrowser) this.#active.setMaxVisible(Math.max(1, rows - 5));
		const lines = [...this.#active.render(width)];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#renderPreview(width: number, height: number | undefined): readonly string[] {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRows));
		const lines = this.#previewLines(width);
		const contentRows = rows > 1 && lines.length > rows ? rows - 1 : rows;
		const maxScroll = Math.max(0, lines.length - contentRows);
		this.#previewScroll = Math.min(this.#previewScroll, maxScroll);
		const window = lines.slice(this.#previewScroll, this.#previewScroll + contentRows);
		if (contentRows < rows)
			window.push(
				theme.fg(
					"dim",
					this.#previewScroll < maxScroll
						? `  ↓ ${maxScroll - this.#previewScroll} more · Ctrl-E/Ctrl-Y scroll`
						: "  (end)",
				),
			);
		while (window.length < rows) window.push("");
		return window.slice(0, rows);
	}

	#frameTitle(): string {
		const state = this.#busy ? "  ◐ working" : this.dirty ? "  ● unsaved" : "";
		return `${sanitizeDisplaySingleLine(this.#title)}${uiProvenanceSuffix("features", "agent-definition-editor", true)}${state}`;
	}

	render(width: number, availableHeight?: number): readonly string[] {
		const height =
			this.#deps.embedded && availableHeight !== undefined
				? Math.max(0, Math.floor(availableHeight))
				: Math.max(14, this.#tui.terminal?.rows ?? process.stdout.rows ?? 40);
		const bodyRows = Math.max(0, height - 4);
		this.#bodyRows = bodyRows;
		const title = this.#frameTitle();
		this.#split.setNarrowPane(!this.#preview || this.#deps.embedded ? "left" : undefined);
		this.#split.setSplitAt(this.#preview ? (this.#deps.embedded ? 54 : 0) : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([isSplit ? topBorderSplit(width, title, leftWidth) : topBorder(width, title)]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		this.#frameFooter.setLines([
			row(
				this.#notice ? theme.fg("warning", sanitizeDisplaySingleLine(this.#notice)) : theme.fg("dim", this.#hint),
				width,
			),
		]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(height);
		return this.#frame.render(width);
	}

	// ───────────────────────────── input ─────────────────────────────

	#textFocused(): boolean {
		const active = this.#active;
		return (
			active instanceof Input ||
			active instanceof HookEditorComponent ||
			(active instanceof SelectList && active.filterFocused) ||
			(active instanceof ModelBrowser && active.filterFocused)
		);
	}

	handleInput(data: string): void {
		if (this.rosterVisible && this.#deps.openDefinitionFile && matchesKey(data, "ctrl+g")) {
			this.#keys.reset();
			void this.#openDefinitionFile();
			return;
		}
		if (data.startsWith("\x1b[<")) {
			this.#keys.reset();
			routeSgrMouseInput(data, event => this.routeMouse(event));
			return;
		}
		const active = this.#active;
		if (this.#textFocused()) {
			this.#keys.reset();
			const printable = active instanceof Input ? extractPrintableText(data) : undefined;
			if (printable !== undefined && active instanceof Input) active.insertText(printable);
			else active.handleInput?.(data);
			this.#render();
			return;
		}
		if (this.#screen === "generating" && active instanceof SelectList) {
			if (matchesAppInterrupt(data)) active.onCancel?.();
			else if (matchesKey(data, "enter")) active.handleInput(data);
			return;
		}
		if (this.#busy) return;
		if (this.#screen === "detail" && active instanceof SelectList) {
			const value = active.getSelectedItem()?.value;
			if (data === "r" || data === "R" || matchesKey(data, "ctrl+r")) {
				const target =
					value && FIELD_KEYS.has(value)
						? (value as AgentDefinitionField)
						: value === "generate"
							? "all"
							: undefined;
				if (target) {
					if (data === "r") void this.#generate(target);
					else
						this.#showText(
							"What should change?",
							"",
							comment => void this.#generate(target, comment),
							() => this.#showDetail(value),
						);
				}
				return;
			}
			if (data === "c") {
				this.#showCopy();
				return;
			}
			if (matchesKey(data, "delete") && this.#deps.remove) {
				this.#confirmDelete();
				return;
			}
		} else if (
			this.#helpField &&
			active instanceof SelectList &&
			(this.#screen === "form" ||
				this.#screen === "choice" ||
				this.#screen === "checklist" ||
				this.#screen === "models") &&
			(data === "r" || data === "R" || matchesKey(data, "ctrl+r"))
		) {
			// A field's own screens regenerate that field, as its detail row does.
			const target = this.#helpField;
			if (data === "r") void this.#generate(target);
			else
				this.#showText(
					"What should change?",
					"",
					comment => void this.#generate(target, comment),
					() => this.#showDetail(target),
				);
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action && this.#preview && action.kind === "scroll") {
			this.#previewScroll = Math.max(0, this.#previewScroll + action.delta);
			this.#render();
			return;
		}
		if (action?.kind === "horizontal") {
			if (action.delta < 0) {
				if (active instanceof SelectList) active.onCancel?.();
				else if (active instanceof ModelBrowser) active.handleCancel();
			} else if (active instanceof SelectList && this.#screen === "detail") {
				const item = active.getSelectedItem();
				const field = item && FIELD_BY_KEY.get(item.value as AgentDefinitionField);
				if (item && field && field.kind !== "boolean") active.onSelect?.(item);
			}
			this.#render();
			return;
		}
		if (action && (active instanceof SelectList || active instanceof ModelBrowser)) active.handleNavigation(action);
		else active.handleInput?.(data);
		this.#render();
	}

	pasteText(value: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(value);
	}

	routeMouse(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (!hit || hit.index !== 1) return false;
		if (this.#busy && this.#screen !== "generating") return true;
		const pane = this.#split.locate(hit.line, hit.col);
		if (pane?.pane === "right") {
			if (event.wheel !== null) {
				this.#previewScroll = Math.max(0, this.#previewScroll + event.wheel);
				this.#render();
			}
			return true;
		}
		if (pane?.pane === "left" && isLayoutMouseRoutable(this.#active))
			this.#active.routeMouse(event, pane.line, pane.col);
		this.#render();
		return true;
	}

	// ───────────────────────────── native ─────────────────────────────

	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker") && (this.#active instanceof SelectList || this.#active instanceof ModelBrowser);
	}

	describe(cx: DescribeContext): NativeNode {
		const active = this.#active;
		if (!cx.supports("picker")) return col([text(this.render(cx.cols).join("\n"))]);
		const notice = this.#notice ? [text(this.#notice, { tone: "warning" })] : [];
		if (active instanceof ModelBrowser) {
			const order = active.pickerOrder({ providers: false, rest: active.query.trim() ? "Matches" : "All" });
			const catalogue = active.pickerItems(buildBrowserItems(this.#deps.getAvailableModels?.() ?? []));
			return picker(
				{
					title: "Choose a model",
					subtitle: this.#hint,
					icon: "model",
					noun: "models",
					size: "md",
					layout: "rows",
					preview: "below",
					placeholder: "Search models…",
					...active.pickerRows(catalogue, order, undefined),
					empty: "No models available",
					actions: [
						pickerAction("use", "Use model", "enter", { primary: true }),
						{ ...CLOSE_ACTION, label: active.filterFocused ? "Back to list" : "Back" },
					],
				},
				[...notice, ...active.pickerPreview("compact")],
			);
		}
		if (active instanceof SelectList) {
			const props = selectListPicker(
				active,
				this.#sheet ?? {
					title: `${this.#title}${uiProvenanceSuffix("features", "agent-definition-editor")}${this.dirty ? " · unsaved" : ""}`,
					noun: "fields",
				},
			);
			const actions =
				this.#screen === "detail"
					? [
							pickerAction("confirm", "Edit", "enter", { primary: true }),
							{ id: "generate", label: "Regenerate field", keys: ["r"] },
							{ id: "comment", label: "Regenerate with comment", keys: ["shift", "r"] },
							...(this.#deps.openDefinitionFile && !this.dirty
								? [pickerAction("open-file", "Open file", "ctrl+g")]
								: []),
							CLOSE_ACTION,
						]
					: props.actions;
			return picker({ ...props, actions }, [...notice, ...(this.#preview ? this.#nativePreview() : [])]);
		}
		return col([active, ...notice]);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const active = this.#active;
		if (!(active instanceof SelectList) && !(active instanceof ModelBrowser)) {
			active.handleNativeEvent?.(event);
			this.#render();
			return;
		}
		const picked = pickerEvent(event);
		if (!picked) return;
		if (this.#busy && this.#screen !== "generating" && !(picked.kind === "action" && picked.act === "close")) return;
		if (picked.kind === "action" && picked.act === "open-file") {
			void this.#openDefinitionFile();
			return;
		}
		if (active instanceof ModelBrowser) {
			if (picked.kind !== "action") active.routePickerItem(picked.item, picked.kind === "activate");
			else if (picked.act === "close") active.handleCancel();
			else if (picked.act === "use" && active.pickerSelected) active.routePickerItem(active.pickerSelected, true);
		} else if (picked.kind === "action" && (picked.act === "generate" || picked.act === "comment")) {
			this.handleInput(picked.act === "generate" ? "r" : "R");
			return;
		} else routeSelectListPicker(active, event);
		this.#render();
	}
}
