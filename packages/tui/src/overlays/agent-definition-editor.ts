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
import { t } from "@oh-my-pi/pi-utils/i18n";
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
	get description() {
		return t("overlays.agent_definition_editor.description_help");
	},
	get systemPrompt() {
		return t("overlays.agent_definition_editor.prompt_help");
	},
	get harness() {
		return t("overlays.agent_definition_editor.harness_help");
	},
	get inherit() {
		return t("overlays.agent_definition_editor.inherit_help");
	},
	get model() {
		return t("overlays.agent_definition_editor.model_help");
	},
	get thinkingLevel() {
		return t("overlays.agent_definition_editor.thinking_help");
	},
	get prewalk() {
		return t("overlays.agent_definition_editor.prewalk_help");
	},
	get advisor() {
		return t("overlays.agent_definition_editor.advisor_help");
	},
	get spawns() {
		return t("overlays.agent_definition_editor.spawns_help");
	},
	get tools() {
		return t("overlays.agent_definition_editor.tools_help");
	},
	get output() {
		return t("overlays.agent_definition_editor.output_help");
	},
	get structured() {
		return t("overlays.agent_definition_editor.structured_help");
	},
	get blocking() {
		return t("overlays.agent_definition_editor.blocking_help");
	},
	get autoloadSkills() {
		return t("overlays.agent_definition_editor.skills_help");
	},
	get readSummarize() {
		return t("overlays.agent_definition_editor.read_help");
	},
};

/** Detail list: field rows grouped by purpose, then actions. */
const DETAIL_GROUPS: readonly { title: string; fields: readonly AgentDefinitionField[] }[] = [
	{
		get title() {
			return t("overlays.agent_definition_editor.identity_section");
		},
		fields: ["name", "description", "systemPrompt", "inherit"],
	},
	{
		get title() {
			return t("settings.tab.model.label");
		},
		fields: ["model", "thinkingLevel", "harness"],
	},
	{
		get title() {
			return t("overlays.agent_definition_editor.powers_section");
		},
		fields: ["tools", "spawns", "autoloadSkills", "readSummarize"],
	},
	{
		get title() {
			return t("overlays.agent_definition_editor.lifecycle_section");
		},
		fields: ["blocking", "prewalk", "advisor"],
	},
	{
		get title() {
			return t("overlays.agent_definition_editor.result_section");
		},
		fields: ["output", "structured"],
	},
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
	if (value === undefined) return t("settings.option.statusLine.preset.default.label");
	if (typeof value === "string") return value || t("overlays.agent_definition_editor.not_set_value");
	if (Array.isArray(value)) return value.join(", ") || t("settings.option.statusLine.separator.none.label");
	if (typeof value === "object") return t("overlays.agent_definition_editor.configured_value");
	return value
		? t("overlays.agent_definition_editor.on_value")
		: t("settings.option.paste.largeMenuThreshold.0.label");
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
		this.#title = definition.name
			? t("overlays.agent_definition_editor.edit_title", { name: `${definition.name}` })
			: t("overlays.agent_definition_editor.new_title");
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
				section = {
					id: group.toLowerCase(),
					title: group === "actions" ? t("overlays.agent_definition_editor.author_file_section") : group,
					rows: [],
				};
				sections.push(section);
				continue;
			}
			const field = FIELD_BY_KEY.get(item.value as AgentDefinitionField);
			section?.rows.push({
				id: item.value,
				label: item.label.trim(),
				hint: field && item.value === selected ? FIELD_HELP[field.key] : undefined,
				disabled: item.disabled ? item.description || t("overlays.agent_definition_editor.unavailable") : undefined,
				control: {
					k: "action",
					label: item.description || t("overlays.agent_definition_editor.open"),
					act: "edit",
				},
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
				value = {
					facts: [],
					findings: [
						{
							level: "warn",
							text: t("overlays.agent_definition_editor.inspection_failed", { error: `${String(error)}` }),
						},
					],
				};
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
				return lines
					? t("overlays.agent_definition_editor.prompt_lines", {
							lines: `${lines}`,
							plural: `${lines === 1 ? "" : "s"}`,
							firstLine: `${firstLine(draft.systemPrompt, "")}`,
						})
					: "(empty)";
			}
			case "harness":
				return draft.harness ?? t("overlays.agent_definition_editor.harness_default");
			case "inherit":
				return draft.inherit ?? t("overlays.agent_definition_editor.inherit_default");
			case "model":
				return draft.model?.length
					? draft.model.join(" → ")
					: t("overlays.agent_definition_editor.model_inherited");
			case "thinkingLevel":
				return draft.thinkingLevel ?? "inherit";
			case "tools":
				return draft.tools === undefined
					? t("overlays.agent_definition_editor.tools_default")
					: draft.tools.length
						? `${draft.tools.length}: ${draft.tools.join(", ")}`
						: t("overlays.agent_definition_editor.tools_none");
			case "spawns":
				return draft.spawns === "*"
					? t("overlays.agent_definition_editor.spawns_any")
					: draft.spawns?.length
						? draft.spawns.join(", ")
						: draft.tools?.includes("task")
							? t("overlays.agent_definition_editor.spawns_omitted")
							: t("overlays.agent_definition_editor.spawns_none");
			case "autoloadSkills":
				return draft.autoloadSkills?.length
					? draft.autoloadSkills.join(", ")
					: t("overlays.agent_definition_editor.skills_none");
			case "readSummarize":
				return triState(draft.readSummarize, "on", t("overlays.agent_definition_editor.read_verbatim"), "inherit");
			case "blocking":
				return triState(
					draft.blocking,
					t("overlays.agent_definition_editor.blocking_inline"),
					t("overlays.agent_definition_editor.blocking_detached"),
					t("overlays.agent_definition_editor.blocking_default"),
				);
			case "structured":
				return triState(
					draft.structured,
					t("overlays.agent_definition_editor.structured_always"),
					"off",
					"default",
				);
			case "prewalk":
				return draft.prewalk === undefined
					? t("overlays.agent_definition_editor.prewalk_default")
					: draft.prewalk === true
						? t("overlays.agent_definition_editor.prewalk_on")
						: draft.prewalk === false
							? "off"
							: t("overlays.agent_definition_editor.prewalk_target_2", { prewalk: `${draft.prewalk}` });
			case "advisor":
				return this.#advisorSummary();
			case "output":
				return this.#outputSummary();
		}
	}
	#advisorSummary(): string {
		const advisor = this.#draft.advisor;
		if (advisor === undefined) return t("overlays.agent_definition_editor.advisor_default");
		if (advisor === true) return t("overlays.agent_definition_editor.advisor_role_2");
		if (advisor === false) return t("overlays.agent_definition_editor.advisor_disabled");
		if (typeof advisor === "string")
			return t("overlays.agent_definition_editor.advisor_model", { advisor: `${advisor}` });
		if ("ref" in advisor)
			return t("overlays.agent_definition_editor.advisor_named", {
				ref: `${advisor.ref}`,
				value: `${advisor.scope ? ` (${advisor.scope})` : ""}`,
			});
		return t("overlays.agent_definition_editor.advisor_private", { name: `${advisor.inline.name}` });
	}
	#outputSummary(): string {
		const output = this.#draft.output;
		if (output === undefined) return t("overlays.agent_definition_editor.output_free_text");
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
		items.push({
			value: "group:actions",
			label: theme.fg("dim", t("overlays.agent_definition_editor.author_file_heading")),
			disabled: true,
		});
		items.push(
			{
				value: "generate",
				label: t("overlays.agent_definition_editor.generate_author"),
				description: t("overlays.agent_definition_editor.generate_author_hint"),
			},
			{
				value: "from-existing",
				label: t("overlays.agent_definition_editor.generate_sources"),
				description: t("overlays.agent_definition_editor.generate_sources_hint"),
			},
		);
		for (const missing of this.#missingSpawnTargets())
			if (this.#deps.createMissing)
				items.push({
					value: `create:${missing}`,
					label: t("overlays.agent_definition_editor.create_missing", { missing: `${missing}` }),
					description: t("overlays.agent_definition_editor.spawn_target"),
				});
		if (this.#deps.openDefinitionFile)
			items.push({
				value: "open-file",
				label: t("overlays.agent_definition_editor.open_file_2"),
				description: dirty ? t("overlays.agent_definition_editor.save_or_discard") : "Ctrl+G",
				disabled: dirty,
			});
		items.push(
			{
				value: "raw",
				label: t("overlays.agent_definition_editor.edit_file_contents"),
				description: t("overlays.agent_definition_editor.file_contents_hint"),
			},
			{
				value: "scope",
				label:
					this.#deps.saveScopeEditable === false
						? t("overlays.agent_definition_editor.file_scope_in_place")
						: t("overlays.agent_definition_editor.save_scope"),
				description: this.#scope,
			},
			{
				value: "save",
				label: t("overlays.agent_definition_editor.save_definition"),
				description: dirty
					? t("overlays.agent_definition_editor.unsaved_changes")
					: t("overlays.agent_definition_editor.no_changes"),
			},
			{
				value: "copy",
				label: t("overlays.agent_definition_editor.save_copy"),
				description: t("overlays.agent_definition_editor.save_copy_hint"),
			},
		);
		if (this.#deps.remove) items.push({ value: "delete", label: t("overlays.agent_definition_editor.delete_file") });
		const list = this.#list(items, selected ?? "name");
		list.onSelect = item => this.#run(() => this.#onDetailSelect(item.value));
		list.onCancel = () => this.#leave();
		this.#setScreen(
			"detail",
			list,
			t("overlays.agent_definition_editor.detail_keys", {
				value: `${this.#deps.openDefinitionFile ? t("overlays.agent_definition_editor.open_file_key") : ""}`,
				value2: `${this.#deps.remove ? t("overlays.agent_definition_editor.delete_key") : ""}`,
			}),
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
					t("overlays.agent_definition_editor.describe_agent"),
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
					t("overlays.agent_definition_editor.definition_contents"),
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
					t("overlays.agent_definition_editor.instructions_body"),
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
					title: t("overlays.agent_definition_editor.harness_title"),
					field: field.key,
					current: this.#draft.harness ?? "",
					options: [
						{
							value: "",
							label: t("overlays.agent_definition_editor.harness_option_default"),
							description: t("overlays.agent_definition_editor.harness_native_hint"),
						},
						{
							value: "claude",
							label: "claude",
							description: t("overlays.agent_definition_editor.harness_claude_hint"),
						},
						{
							value: "codex",
							label: "codex",
							description: t("overlays.agent_definition_editor.harness_codex_hint"),
						},
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
						label: value === "all" ? t("overlays.agent_definition_editor.inherit_option_default") : value,
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
					title: t("overlays.agent_definition_editor.thinking_title"),
					field: field.key,
					current: this.#draft.thinkingLevel ?? "",
					options: [
						{
							value: "",
							label: t("overlays.agent_definition_editor.thinking_unset"),
							description: t("overlays.agent_definition_editor.thinking_unset_hint"),
						},
						...(field.choices ?? []).map(level => ({
							value: level,
							label: level,
							description:
								level === "inherit"
									? t("overlays.agent_definition_editor.thinking_inherit_hint")
									: level === "auto"
										? t("overlays.agent_definition_editor.thinking_auto_hint")
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
					title: t("overlays.agent_definition_editor.autoload_title"),
					subtitle: t("overlays.agent_definition_editor.autoload_hint"),
					field: field.key,
					entries: (this.#deps.skills ?? []).map(skill => ({
						value: skill.name,
						label: skill.name,
						description: skill.description,
					})),
					selected: this.#draft.autoloadSkills ?? [],
					presets: [
						{
							value: "__none",
							label: t("overlays.agent_definition_editor.autoload_none"),
							description: t("overlays.agent_definition_editor.autoload_none_hint"),
							apply: () => undefined,
						},
					],
					custom: t("overlays.agent_definition_editor.add_skill"),
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
		this.#setScreen("input", input, t("overlays.agent_definition_editor.input_keys", { title: `${title}` }), {
			field,
			preview: true,
		});
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
		this.#setScreen(
			"choice",
			list,
			t("overlays.agent_definition_editor.choice_keys", { title: `${options.title}` }),
			{
				preview: true,
				field: options.field,
				sheet: {
					title: options.title,
					subtitle: options.subtitle ?? (options.field ? FIELD_HELP[options.field] : undefined),
					noun: "options",
					current: [options.current],
				},
			},
		);
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
				{ value: DONE, label: t("overlays.agent_definition_editor.checklist_done") },
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
			this.#setScreen(
				"checklist",
				list,
				t("overlays.agent_definition_editor.checklist_keys", { title: `${options.title}` }),
				{
					preview: true,
					field: options.field,
					rebuild: build,
					sheet: {
						title: options.title,
						subtitle: options.subtitle,
						noun: "entries",
						current: checklist.current,
						confirm: t("overlays.agent_definition_editor.checklist_toggle"),
					},
				},
			);
		};
		build(undefined);
	}

	// ───────────────────────────── field screens ─────────────────────────────

	#showTools(): void {
		const all = this.#deps.tools;
		const readOnly = this.#deps.readOnlyTools ?? [];
		this.#checklist({
			title: t("settings.tab.tools.label"),
			subtitle: FIELD_HELP.tools,
			field: "tools",
			entries: [...all]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(tool => ({
					value: tool.name,
					label: tool.name,
					description: `${readOnly.includes(tool.name) ? t("overlays.agent_definition_editor.read_only_prefix") : ""}${tool.description ?? ""}`,
				})),
			selected: this.#draft.tools,
			presets: [
				{
					value: "__defaults",
					label: t("overlays.agent_definition_editor.tools_default_option"),
					description: t("overlays.agent_definition_editor.tools_default_hint"),
					apply: () => undefined,
				},
				...(readOnly.length
					? [
							{
								value: "__readonly",
								label: t("overlays.agent_definition_editor.tools_read_only"),
								description: readOnly.filter(name => all.some(tool => tool.name === name)).join(", "),
								apply: () => readOnly.filter(name => all.some(tool => tool.name === name)),
							},
						]
					: []),
				{
					value: "__none",
					label: t("overlays.agent_definition_editor.tools_none_option"),
					description: t("overlays.agent_definition_editor.tools_none_hint"),
					apply: () => [],
				},
			],
			custom: t("overlays.agent_definition_editor.add_tool"),
			apply: selected => this.#set("tools", selected),
		});
	}

	#showSpawns(): void {
		this.#checklist({
			title: t("overlays.agent_definition_editor.children_title"),
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
					label: t("settings.option.statusLine.separator.none.label"),
					description: t("overlays.agent_definition_editor.children_none_hint"),
					apply: () => undefined,
				},
				{
					value: "__any",
					label: t("overlays.agent_definition_editor.children_any"),
					description: t("overlays.agent_definition_editor.children_any_hint"),
					apply: () => ["*"],
				},
			],
			custom: t("overlays.agent_definition_editor.add_agent"),
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
				description: index === 0 ? t("overlays.agent_definition_editor.model_first") : "fallback",
			})),
			{
				value: "add-model",
				label: t("overlays.agent_definition_editor.add_model"),
				description: t("overlays.agent_definition_editor.add_model_hint"),
			},
			{
				value: "add-role",
				label: t("overlays.agent_definition_editor.add_role"),
				description: t("overlays.agent_definition_editor.add_role_hint"),
			},
			{
				value: "add-pattern",
				label: t("overlays.agent_definition_editor.add_selector"),
				description: t("overlays.agent_definition_editor.selector_hint"),
			},
			...(models.length ? [{ value: "clear", label: t("overlays.agent_definition_editor.clear_models") }] : []),
			{ value: DONE, label: t("overlays.agent_definition_editor.models_done") },
		];
		const list = this.#list(items, selected ?? (models.length ? "entry:0" : "add-model"));
		const back = (): void => this.#showDetail("model");
		const add = (selector: string): void => this.#set("model", [...(this.#draft.model ?? []), selector]);
		list.onSelect = item =>
			this.#run(() => {
				const reopen = (): void => this.#showModels(item.value);
				if (item.value === DONE) return back();
				if (item.value === "clear") return this.#set("model", undefined);
				if (item.value === "add-model")
					return this.#pickModel(t("overlays.agent_definition_editor.add_model_title"), undefined, add, reopen);
				if (item.value === "add-role") return this.#pickRole(add, reopen);
				if (item.value === "add-pattern")
					return this.#showInput(
						t("overlays.agent_definition_editor.selector_title"),
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
		this.#setScreen("models", list, t("overlays.agent_definition_editor.models_keys"), {
			preview: true,
			field: "model",
			rebuild: next => this.#showModels(next),
			sheet: {
				title: t("overlays.agent_definition_editor.models_roles_title"),
				subtitle: FIELD_HELP.model,
				noun: "entries",
			},
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
			title: t("overlays.agent_definition_editor.model_entry_title", {
				value: `${index + 1}`,
				selector: `${selector}`,
			}),
			field: "model",
			current: "",
			options: [
				{ value: "model", label: t("overlays.agent_definition_editor.replace_model") },
				{ value: "role", label: t("overlays.agent_definition_editor.replace_role") },
				{ value: "edit", label: t("overlays.agent_definition_editor.edit_selector") },
				...(index > 0 ? [{ value: "up", label: t("overlays.agent_definition_editor.move_up") }] : []),
				...(index < models.length - 1
					? [{ value: "down", label: t("overlays.agent_definition_editor.move_down") }]
					: []),
				{ value: "remove", label: t("overlays.agent_definition_editor.remove_entry") },
			],
			pick: value => {
				if (value === "model")
					return this.#pickModel(
						t("overlays.agent_definition_editor.replace_title", { selector: `${selector}` }),
						selector,
						replace,
						reopen,
					);
				if (value === "role") return this.#pickRole(replace, reopen);
				if (value === "edit")
					return this.#showInput(
						t("overlays.agent_definition_editor.edit_selector_title"),
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
			this.#showInput(
				t("overlays.agent_definition_editor.role_alias_input"),
				"@",
				value => apply(value.trim()),
				back,
				"model",
			);
			return;
		}
		this.#choose({
			title: t("overlays.agent_definition_editor.role_alias_title"),
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
				title: t("overlays.agent_definition_editor.effort_title", { selector: `${item.selector}` }),
				current: current?.startsWith(`${item.selector}:`) ? current.slice(item.selector.length + 1) : "",
				options: [
					{
						value: "",
						label: t("overlays.agent_definition_editor.no_suffix"),
						description: t("overlays.agent_definition_editor.no_suffix_hint"),
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
		this.#setScreen(
			"model-browser",
			browser,
			t("overlays.agent_definition_editor.model_browser_keys", { title: `${title}` }),
			{
				field: this.#helpField,
			},
		);
	}

	#showPrewalk(): void {
		const back = (): void => this.#showDetail("prewalk");
		const prewalk = this.#draft.prewalk;
		this.#choose({
			title: t("settings.group.prewalk"),
			field: "prewalk",
			current: prewalk === undefined ? "" : prewalk === true ? "on" : prewalk === false ? "off" : "target",
			options: [
				{
					value: "",
					label: t("settings.option.statusLine.preset.default.label"),
					description: t("overlays.agent_definition_editor.prewalk_default_hint"),
				},
				{
					value: "on",
					label: t("overlays.agent_definition_editor.prewalk_option_on"),
					description: t("overlays.agent_definition_editor.prewalk_on_hint"),
				},
				{
					value: "off",
					label: t("settings.option.paste.largeMenuThreshold.0.label"),
					description: t("overlays.agent_definition_editor.prewalk_off_hint"),
				},
				{
					value: "model",
					label: t("overlays.agent_definition_editor.choose_target_model"),
					description:
						typeof prewalk === "string"
							? t("overlays.agent_definition_editor.current_prewalk", { prewalk: `${prewalk}` })
							: t("overlays.agent_definition_editor.prewalk_description"),
				},
				{
					value: "pattern",
					label: t("overlays.agent_definition_editor.target_selector_prompt"),
					description: t("overlays.agent_definition_editor.target_selector_help"),
				},
			],
			pick: value => {
				if (value === "model")
					return this.#pickModel(
						t("overlays.agent_definition_editor.prewalk_target"),
						typeof prewalk === "string" ? prewalk : undefined,
						selector => this.#set("prewalk", selector),
						back,
					);
				if (value === "pattern")
					return this.#showInput(
						t("overlays.agent_definition_editor.prewalk_selector"),
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
			title: t("settings.group.advisor"),
			field: "advisor",
			current,
			options: [
				{
					value: "",
					label: t("overlays.agent_definition_editor.advisor_none"),
					description: t("overlays.agent_definition_editor.advisor_none_help"),
				},
				{
					value: "role",
					label: t("overlays.agent_definition_editor.advisor_role"),
					description: t("overlays.agent_definition_editor.advisor_role_help"),
				},
				{ value: "off", label: t("settings.option.ask.timeout.0.label"), description: "advisor: false" },
				{
					value: "model",
					label: t("overlays.agent_definition_editor.advisor_other_model"),
					description:
						typeof advisor === "string"
							? t("overlays.agent_definition_editor.current_advisor_model", { advisor: `${advisor}` })
							: t("overlays.agent_definition_editor.advisor_selector_help"),
				},
				{
					value: "named",
					label: t("overlays.agent_definition_editor.named_advisor"),
					description:
						typeof advisor === "object" && "ref" in advisor
							? t("overlays.agent_definition_editor.current_named_advisor", { ref: `${advisor.ref}` })
							: t("overlays.agent_definition_editor.watchdog_entry"),
				},
				{
					value: "inline",
					label: t("overlays.agent_definition_editor.private_advisor"),
					description:
						typeof advisor === "object" && "inline" in advisor
							? t("overlays.agent_definition_editor.current_private_advisor", { name: `${advisor.inline.name}` })
							: t("overlays.agent_definition_editor.private_advisor_help"),
				},
			],
			pick: value => {
				if (value === "") delete this.#draft.advisor;
				else if (value === "role") this.#draft.advisor = true;
				else if (value === "off") this.#draft.advisor = false;
				else if (value === "model")
					this.#showInput(
						t("overlays.agent_definition_editor.advisor_model_input"),
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
				this.#notice = t("overlays.agent_definition_editor.no_named_advisors");
				this.#render();
				return;
			}
			const current =
				typeof this.#draft.advisor === "object" && "ref" in this.#draft.advisor ? this.#draft.advisor : undefined;
			this.#choose({
				title: t("overlays.agent_definition_editor.named_advisors"),
				field: "advisor",
				current: current ? `${current.ref}\u0000${current.scope ?? ""}` : "",
				options: advisors.map(advisor => ({
					value: `${advisor.name}\u0000${advisor.scope}`,
					label: advisor.name,
					description: `${advisor.scope} · ${advisor.config.model ?? t("overlays.agent_definition_editor.advisor_role_fallback")}`,
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
		this.#setScreen("form", list, t("overlays.agent_definition_editor.form_navigation", { title: `${page.title}` }), {
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
			{ key: "name", label: t("overlays.agent_definition_editor.name"), kind: "text" },
			{ key: "model", label: t("overlays.agent_definition_editor.model_role"), kind: "text" },
			{ key: "instructions", label: t("overlays.agent_definition_editor.instructions"), kind: "text" },
			{ key: "systemPrompt", label: t("overlays.agent_definition_editor.system_prompt_override"), kind: "text" },
			{ key: "enabled", label: t("overlays.agent_definition_editor.enabled"), kind: "boolean" },
			{ key: "includeThinking", label: t("overlays.agent_definition_editor.include_thinking"), kind: "boolean" },
			{ key: "maxNotesPerUpdate", label: t("overlays.agent_definition_editor.max_notes"), kind: "number" },
			{
				key: "reviewMode",
				label: t("overlays.agent_definition_editor.review_mode"),
				kind: "text",
				choices: ["turn", "agent-end"],
			},
			{ key: "reviewInterval", label: t("overlays.agent_definition_editor.review_interval"), kind: "number" },
			{
				key: "syncBacklog",
				label: t("overlays.agent_definition_editor.sync_backlog"),
				kind: "text",
				choices: ["off", "1", "3", "5", "strict"],
			},
			{
				key: "scope",
				label: t("overlays.agent_definition_editor.session_kinds"),
				kind: "text",
				choices: ["main", "subagent", "all"],
			},
		];
		this.#enterForm(
			"advisor",
			t("overlays.agent_definition_editor.private_advisor_form"),
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
									label: value ?? t("settings.option.statusLine.preset.default.label"),
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
					label: t("overlays.agent_definition_editor.delivery_label", { severity: `${severity}` }),
					value: get().delivery?.[severity] ?? t("settings.option.statusLine.preset.default.label"),
					field: "advisor" as const,
					activate: () =>
						this.#push(t("overlays.agent_definition_editor.delivery_title", { severity: `${severity}` }), () =>
							[undefined, "on-yield", "next-tool-call"].map(value => ({
								id: value ?? "default",
								label: value ?? t("settings.option.statusLine.preset.default.label"),
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
					label: t("overlays.agent_definition_editor.tools"),
					value: displayValue(get().tools),
					field: "advisor",
					activate: () =>
						this.#push(t("overlays.agent_definition_editor.private_advisor_tools"), () => [
							{
								id: "default",
								label: t("overlays.agent_definition_editor.default_tools"),
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
				this.#notice = t("overlays.agent_definition_editor.invalid_schema_notice");
			}
		}
		let jtd = this.#deps.outputSchemaDialect?.(this.#draft.output) === "jtd";
		const variants = new Map<boolean, unknown>();
		const blank = (): unknown =>
			jtd ? { properties: {}, optionalProperties: {} } : { type: "object", properties: {}, required: [] };
		const enabled = (): boolean =>
			this.#draft.output !== undefined && this.#draft.output !== null && this.#draft.output !== false;
		this.#enterForm("output", t("overlays.agent_definition_editor.structured_output"), () => [
			{
				id: "enable",
				label: t("overlays.agent_definition_editor.enable_structured_output"),
				value: enabled() ? "[x]" : "[ ]",
				field: "output",
				activate: () => {
					this.#draft.output = enabled() ? undefined : blank();
				},
			},
			{
				id: "format",
				label: t("overlays.agent_definition_editor.schema_format"),
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
				label: t("overlays.agent_definition_editor.edit_schema_json"),
				field: "output",
				activate: () =>
					this.#prompt(
						t("overlays.agent_definition_editor.output_schema_json"),
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
				label: t("overlays.agent_definition_editor.type"),
				value: displayValue(schemaType),
				field: "output",
				activate: () =>
					this.#push(t("overlays.agent_definition_editor.output_type"), () =>
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
				label: t("overlays.agent_definition_editor.description"),
				value: displayValue(description),
				field: "output",
				activate: () =>
					this.#prompt(
						t("overlays.agent_definition_editor.field_description"),
						typeof description === "string" ? description : "",
						value => {
							if (jtd) {
								const metadata = { ...record(record(get()).metadata) };
								if (value) metadata.description = value;
								else delete metadata.description;
								update("metadata", metadata);
							} else update("description", value || undefined);
						},
					),
			},
			...Object.keys(properties).map(name => ({
				id: `property:${name}`,
				label: name,
				value: `${displayValue(record(properties[name]).type)}${jtd ? (Object.hasOwn(record(schema.properties), name) ? t("overlays.agent_definition_editor.required_suffix_jtd") : t("overlays.agent_definition_editor.optional_suffix_jtd")) : Array.isArray(schema.required) && schema.required.includes(name) ? t("overlays.agent_definition_editor.required_suffix_json") : t("overlays.agent_definition_editor.optional_suffix_json")}`,
				field: "output" as const,
				activate: () => this.#schemaProperty(get, set, name, jtd),
			})),
			{
				id: "add-field",
				label: t("overlays.agent_definition_editor.new_output_field"),
				field: "output",
				activate: () =>
					this.#prompt(t("overlays.agent_definition_editor.new_field_name"), "", name => {
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
				label: t("overlays.agent_definition_editor.array_item_schema"),
				value: displayValue(jtd ? schema.elements : schema.items),
				field: "output",
				activate: () =>
					this.#push(t("overlays.agent_definition_editor.array_items"), () =>
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
					? t("overlays.agent_definition_editor.jtd_keywords")
					: t("overlays.agent_definition_editor.schema_constraints"),
				field: "output",
				activate: () => this.#jsonObject(t("overlays.agent_definition_editor.schema_keywords"), get, set),
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
		this.#push(t("overlays.agent_definition_editor.output_field_title", { name: `${name}` }), () => [
			{
				id: "name",
				label: t("overlays.agent_definition_editor.field_name_label"),
				value: name,
				field: "output",
				activate: () =>
					this.#prompt(t("overlays.agent_definition_editor.field_name_prompt"), name, nextName => {
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
				label: t("overlays.agent_definition_editor.required"),
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
				label: t("overlays.agent_definition_editor.remove_field"),
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
				label: t("overlays.agent_definition_editor.new_keyword"),
				field: "output",
				activate: () =>
					this.#prompt(t("overlays.agent_definition_editor.keyword_prompt"), "", key => {
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
				label: t("settings.option.tui.vimModeDisplay.text.label"),
				field: "output",
				value: typeof get() === "string" ? String(get()) : "",
				activate: () => this.#prompt(title, typeof get() === "string" ? String(get()) : "", set),
			},
			{
				id: "number",
				label: t("overlays.agent_definition_editor.number_type"),
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
				label: t("overlays.agent_definition_editor.boolean_type"),
				field: "output",
				value: typeof get() === "boolean" ? String(get()) : "",
				activate: () => set(get() !== true),
			},
			{
				id: "null",
				label: t("overlays.agent_definition_editor.null_type"),
				field: "output",
				value: get() === null ? "✓" : "",
				activate: () => set(null),
			},
			{
				id: "object",
				label: t("overlays.agent_definition_editor.object_type"),
				field: "output",
				value:
					get() && typeof get() === "object" && !Array.isArray(get())
						? t("overlays.agent_definition_editor.configured")
						: "",
				activate: () => {
					if (!get() || typeof get() !== "object" || Array.isArray(get())) set({});
					this.#jsonObject(title, get, set);
				},
			},
			{
				id: "array",
				label: t("overlays.agent_definition_editor.array_type"),
				field: "output",
				value: Array.isArray(get())
					? t("overlays.agent_definition_editor.item_count", { length: `${(get() as unknown[]).length}` })
					: "",
				activate: () => {
					if (!Array.isArray(get())) set([]);
					this.#jsonArray(title, get, set);
				},
			},
			{
				id: "delete",
				label: t("overlays.agent_definition_editor.remove_keyword"),
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
		this.#push(t("overlays.agent_definition_editor.items_title", { title: `${title}` }), () => [
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
				label: t("overlays.agent_definition_editor.new_item"),
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
				label: t("overlays.agent_definition_editor.agent_source", {
					name: `${sanitizeDisplaySingleLine(definition.name)}`,
				}),
				description: sanitizeDisplaySingleLine(firstLine(definition.description, "")),
			})),
			...sources.map((source, index) => ({
				value: `source:${index}`,
				label: `${sanitizeDisplaySingleLine(source.kind)}: ${sanitizeDisplaySingleLine(source.name)}`,
				description: sanitizeDisplaySingleLine(firstLine(source.description ?? "", "")),
			})),
		];
		const checklist = new Checklist({ entries, selected: [] });
		const next = { value: "generate", label: t("overlays.agent_definition_editor.continue_instructions") };
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
						t("overlays.agent_definition_editor.new_agent_prompt"),
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
						t("overlays.agent_definition_editor.source_instructions_help"),
					);
				});
			list.onCancel = () => this.#showDetail("from-existing");
			this.#setScreen("checklist", list, t("overlays.agent_definition_editor.sources_navigation"), {
				sheet: {
					title: t("overlays.agent_definition_editor.generation_sources"),
					subtitle: t("overlays.agent_definition_editor.sources_help"),
					noun: "sources",
					current: checklist.current,
					confirm: t("tui.picker.select"),
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
		const cancel = this.#list(
			[{ value: "cancel", label: t("overlays.agent_definition_editor.author_writing") }],
			"cancel",
		);
		cancel.onSelect = cancel.onCancel = () => {
			controller.abort();
			this.#busy = false;
			this.#showDetail(returnTo);
		};
		this.#setScreen(
			"generating",
			cancel,
			t("overlays.agent_definition_editor.generating", { interruptKey: `${interruptKey()}` }),
			{
				preview: true,
				field: target === "all" ? undefined : target,
			},
		);
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
					? t("overlays.agent_definition_editor.generated_notice")
					: t("overlays.agent_definition_editor.regenerated_notice", {
							label: `${FIELD_BY_KEY.get(target)?.label}`,
						});
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
			this.#notice = t("overlays.agent_definition_editor.save_before_open");
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
			t("overlays.agent_definition_editor.copy_name"),
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
				{
					value: "cancel",
					label: t("tui.components.loader.cancel"),
					description: t("overlays.agent_definition_editor.keep_file"),
				},
				{
					value: "confirm",
					label: t("overlays.agent_definition_editor.delete_definition"),
					description: this.#draft.name,
				},
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
		this.#setScreen(
			"confirm",
			list,
			t("overlays.agent_definition_editor.delete_navigation", { name: `${this.#draft.name}` }),
			{
				sheet: {
					title: t("overlays.agent_definition_editor.delete_title", { name: `${this.#draft.name}` }),
					subtitle: t("overlays.agent_definition_editor.delete_help"),
					noun: "options",
				},
			},
		);
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
				{ value: "keep", label: t("overlays.agent_definition_editor.keep_editing") },
				{ value: "save", label: t("overlays.agent_definition_editor.save_close") },
				{ value: "discard", label: t("overlays.agent_definition_editor.discard_changes") },
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
		this.#setScreen("confirm", list, t("overlays.agent_definition_editor.unsaved_navigation"), {
			sheet: {
				title: t("overlays.agent_definition_editor.unsaved_title"),
				subtitle: t("overlays.agent_definition_editor.unsaved_help"),
				noun: "options",
			},
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
			{
				kind: "title",
				text: this.#draft.name || t("overlays.agent_definition_editor.unnamed_agent"),
				sub: firstLine(this.#draft.description, ""),
			},
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
			blocks.push({ kind: "section", text: t("overlays.agent_definition_editor.harness_summary") });
			blocks.push({ kind: "kv", items: inspection.facts });
		}
		const others = inspection?.findings.filter(finding => finding.field !== field) ?? [];
		if (others.length) {
			blocks.push({ kind: "section", text: t("overlays.agent_definition_editor.findings") });
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
		blocks.push({
			kind: "section",
			text: t("overlays.agent_definition_editor.file_scope", { scope: `${this.#scope}` }),
		});
		blocks.push({
			kind: "code",
			lines: [
				...head,
				...body.slice(0, 8),
				...(body.length > 8
					? [t("overlays.agent_definition_editor.more_body_lines", { value: `${body.length - 8}` })]
					: []),
			],
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
						? t("overlays.agent_definition_editor.preview_more", { value: `${maxScroll - this.#previewScroll}` })
						: t("overlays.agent_definition_editor.preview_end"),
				),
			);
		while (window.length < rows) window.push("");
		return window.slice(0, rows);
	}

	#frameTitle(): string {
		const state = this.#busy
			? t("overlays.agent_definition_editor.working_state")
			: this.dirty
				? t("overlays.agent_definition_editor.unsaved_state")
				: "";
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
							t("overlays.agent_definition_editor.change_prompt"),
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
					t("overlays.agent_definition_editor.change_prompt_field"),
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
			const order = active.pickerOrder({
				providers: false,
				rest: active.query.trim()
					? t("overlays.agent_definition_editor.model_matches")
					: t("overlays.agent_definition_editor.model_all"),
			});
			const catalogue = active.pickerItems(buildBrowserItems(this.#deps.getAvailableModels?.() ?? []));
			return picker(
				{
					title: t("overlays.agent_definition_editor.choose_model"),
					subtitle: this.#hint,
					icon: "model",
					noun: "models",
					size: "md",
					layout: "rows",
					preview: "below",
					placeholder: t("overlays.agent_definition_editor.search_models"),
					...active.pickerRows(catalogue, order, undefined),
					empty: t("overlays.agent_definition_editor.no_models"),
					actions: [
						pickerAction("use", t("overlays.agent_definition_editor.use_model"), "enter", { primary: true }),
						{
							...CLOSE_ACTION,
							label: active.filterFocused
								? t("tui.picker.back_to_list")
								: t("overlays.agent_definition_editor.back"),
						},
					],
				},
				[...notice, ...active.pickerPreview("compact")],
			);
		}
		if (active instanceof SelectList) {
			const props = selectListPicker(
				active,
				this.#sheet ?? {
					title: `${this.#title}${uiProvenanceSuffix("features", "agent-definition-editor")}${this.dirty ? t("overlays.agent_definition_editor.unsaved_suffix") : ""}`,
					noun: "fields",
				},
			);
			const actions =
				this.#screen === "detail"
					? [
							pickerAction("confirm", t("overlays.agent_definition_editor.edit_action"), "enter", {
								primary: true,
							}),
							{ id: "generate", label: t("overlays.agent_definition_editor.regenerate_field"), keys: ["r"] },
							{
								id: "comment",
								label: t("overlays.agent_definition_editor.regenerate_comment"),
								keys: ["shift", "r"],
							},
							...(this.#deps.openDefinitionFile && !this.dirty
								? [pickerAction("open-file", t("overlays.agent_definition_editor.open_file"), "ctrl+g")]
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
