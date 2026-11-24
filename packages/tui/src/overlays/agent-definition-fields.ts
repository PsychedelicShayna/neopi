import { t } from "@oh-my-pi/pi-utils/i18n";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { AdvisorConfig, AdvisorConfigScope } from "./advisor-config";
import type { ModelBrowserSource } from "./model-browser";

export interface InlineAgentAdvisor extends AdvisorConfig {
	delivery?: Partial<Record<"nit" | "concern" | "blocker", "on-yield" | "next-tool-call">>;
}
export type AgentAdvisor =
	| boolean
	| string
	| { ref: string; scope?: AdvisorConfigScope }
	| { inline: InlineAgentAdvisor };
export const AGENT_INHERITANCE_VALUES = ["all", "context", "system", "none"] as const;
export type AgentInheritance = (typeof AGENT_INHERITANCE_VALUES)[number];

export interface AgentDefinitionDraft {
	name: string;
	description: string;
	systemPrompt: string;
	harness?: "omp" | "claude" | "codex";
	inherit?: AgentInheritance;
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
export type AgentFieldKind = "text" | "list" | "boolean" | "choice" | "tools" | "output" | "advisor";
export interface DefinitionField {
	key: AgentDefinitionField;
	label: string;
	kind: AgentFieldKind;
	description: string;
	choices?: readonly string[];
}
export const AGENT_DEFINITION_FIELDS: readonly DefinitionField[] = [
	{
		key: "name",
		get label() {
			return t("overlays.agent_definition_fields.name_label");
		},
		kind: "text",
		get description() {
			return t("overlays.agent_definition_fields.name_description");
		},
	},
	{
		key: "description",
		get label() {
			return t("overlays.agent_definition_fields.description_label");
		},
		kind: "text",
		get description() {
			return t("overlays.agent_definition_fields.description_help");
		},
	},
	{
		key: "systemPrompt",
		get label() {
			return t("overlays.agent_definition_fields.instructions_label");
		},
		kind: "text",
		get description() {
			return t("overlays.agent_definition_fields.instructions_help");
		},
	},
	{
		key: "harness",
		get label() {
			return t("overlays.agent_definition_fields.harness_label");
		},
		kind: "choice",
		choices: ["omp", "claude", "codex"],
		get description() {
			return t("overlays.agent_definition_fields.harness_help");
		},
	},
	{
		key: "inherit",
		get label() {
			return t("overlays.agent_definition_fields.inherit_label");
		},
		kind: "choice",
		choices: AGENT_INHERITANCE_VALUES,
		get description() {
			return t("overlays.agent_definition_fields.inherit_help");
		},
	},
	{
		key: "model",
		get label() {
			return t("overlays.agent_definition_fields.models_label");
		},
		kind: "list",
		get description() {
			return t("overlays.agent_definition_fields.models_help");
		},
	},
	{
		key: "thinkingLevel",
		get label() {
			return t("overlays.agent_definition_fields.thinking_label");
		},
		kind: "choice",
		choices: ["auto", "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
		get description() {
			return t("overlays.agent_definition_fields.thinking_help");
		},
	},
	{
		key: "prewalk",
		get label() {
			return t("settings.group.prewalk");
		},
		kind: "text",
		get description() {
			return t("overlays.agent_definition_fields.prewalk_help");
		},
	},
	{
		key: "advisor",
		get label() {
			return t("settings.group.advisor");
		},
		kind: "advisor",
		get description() {
			return t("overlays.agent_definition_fields.advisor_help");
		},
	},
	{
		key: "spawns",
		get label() {
			return t("overlays.agent_definition_fields.spawns_label");
		},
		kind: "list",
		get description() {
			return t("overlays.agent_definition_fields.spawns_help");
		},
	},
	{
		key: "tools",
		get label() {
			return t("settings.tab.tools.label");
		},
		kind: "tools",
		get description() {
			return t("overlays.agent_definition_fields.tools_help");
		},
	},
	{
		key: "output",
		get label() {
			return t("overlays.agent_definition_fields.output_label");
		},
		kind: "output",
		get description() {
			return t("overlays.agent_definition_fields.output_help");
		},
	},
	{
		key: "structured",
		get label() {
			return t("overlays.agent_definition_fields.structured_label");
		},
		kind: "boolean",
		get description() {
			return t("overlays.agent_definition_fields.structured_help");
		},
	},
	{
		key: "blocking",
		get label() {
			return t("overlays.agent_definition_fields.blocking_label");
		},
		kind: "boolean",
		get description() {
			return t("overlays.agent_definition_fields.blocking_help");
		},
	},
	{
		key: "autoloadSkills",
		get label() {
			return t("overlays.agent_definition_fields.autoload_label");
		},
		kind: "list",
		get description() {
			return t("overlays.agent_definition_fields.autoload_help");
		},
	},
	{
		key: "readSummarize",
		get label() {
			return t("overlays.agent_definition_fields.read_summarize_label");
		},
		kind: "boolean",
		get description() {
			return t("overlays.agent_definition_fields.read_summarize_help");
		},
	},
];
const inlineAdvisorSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Display name for this private advisor." },
		model: { type: "string", description: "Model or @role selector, optionally suffixed with :effort." },
		instructions: { type: "string", description: "Specialized instructions appended to the advisor's base prompt." },
		systemPrompt: { type: "string", description: "Optional replacement for the bundled base advisor prompt." },
		tools: {
			type: "array",
			items: { type: "string" },
			description: "Tool allowlist; omitted uses advisor defaults and [] grants none.",
		},
		enabled: { type: "boolean", description: "Whether this advisor runs; defaults to true." },
		includeThinking: { type: "boolean", description: "Include the watched agent's reasoning; defaults to true." },
		maxNotesPerUpdate: { type: "integer", minimum: 1, description: "Maximum non-blocker notes per update." },
		reviewMode: {
			type: "string",
			enum: ["turn", "agent-end"],
			description: "Review each turn or after the watched agent yields.",
		},
		reviewInterval: { type: "integer", minimum: 1, description: "Number of turns between reviews." },
		syncBacklog: {
			type: "string",
			enum: ["off", "1", "3", "5", "strict"],
			description: "How much pending context may accumulate before synchronization.",
		},
		scope: {
			type: "string",
			enum: ["main", "subagent", "all"],
			description: "Session kinds this advisor may watch; defaults to all.",
		},
		delivery: {
			type: "object",
			properties: Object.fromEntries(
				["nit", "concern", "blocker"].map(severity => [
					severity,
					{ type: "string", enum: ["on-yield", "next-tool-call"] },
				]),
			),
			additionalProperties: false,
			description: "Optional per-severity delivery timing, local to this agent definition.",
		},
	},
	required: ["name"],
	additionalProperties: false,
};
const advisorFieldSchema = {
	anyOf: [
		{ type: "boolean" },
		{ type: "string", description: "Advisor model or @role selector (not a catalog name)." },
		{
			type: "object",
			properties: {
				ref: { type: "string" },
				scope: { type: "string", enum: ["user", "project", "project-omp", "session"] },
			},
			required: ["ref"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { inline: inlineAdvisorSchema },
			required: ["inline"],
			additionalProperties: false,
		},
	],
};
export const agentDefinitionFieldSchema = {
	type: "object",
	properties: Object.fromEntries(
		AGENT_DEFINITION_FIELDS.map(field => [
			field.key,
			{
				description: field.description,
				...(field.kind === "boolean"
					? { type: "boolean" }
					: field.kind === "list" || field.kind === "tools"
						? {
								anyOf: [
									{ type: "array", items: { type: "string" } },
									...(field.key === "spawns" ? [{ const: "*" }] : []),
								],
							}
						: field.key === "prewalk"
							? { anyOf: [{ type: "boolean" }, { type: "string" }] }
							: field.kind === "output"
								? {}
								: field.kind === "advisor"
									? advisorFieldSchema
									: { type: "string", ...(field.choices ? { enum: field.choices } : {}) }),
			},
		]),
	),
	required: ["name", "description", "systemPrompt"],
};

export interface NamedAgentAdvisor {
	name: string;
	scope: AdvisorConfigScope;
	config: AdvisorConfig;
}

/** One selectable model role, offered as an `@id` selector in model lists. */
export interface AgentEditorRole {
	id: string;
	label: string;
	description?: string;
}

export interface AgentDefinitionFinding {
	level: "warn" | "info";
	text: string;
	/** The definition field the finding concerns, so the field row can carry a marker. */
	field?: AgentDefinitionField;
}

/** What a definition means to the harness right now: effective facts plus problems found. */
export interface AgentDefinitionInspection {
	facts: readonly { k: string; v: string }[];
	findings: readonly AgentDefinitionFinding[];
}

export interface AgentGenerationSource {
	kind: string;
	name: string;
	description?: string;
	content: string;
}

export interface AgentEditorDeps {
	/** Render the detail screen in a parent pane rather than as a standalone editor. */
	embedded?: boolean;
	tools: readonly { name: string; description?: string }[];
	/** Built-in tools the harness classifies as read-only; drives the Read-only preset. */
	readOnlyTools?: readonly string[];
	roles?: readonly AgentEditorRole[];
	skills?: readonly { name: string; description?: string }[];
	browserSource?: ModelBrowserSource;
	getAvailableModels?: () => Model[];
	listAdvisors: () => Promise<readonly NamedAgentAdvisor[]>;
	listGenerationSources?: () => Promise<readonly AgentGenerationSource[]>;
	parse: (raw: string) => AgentDefinitionDraft;
	serialize: (definition: AgentDefinitionDraft) => string;
	generate: (request: {
		definition: AgentDefinitionDraft;
		target: AgentDefinitionField | "all";
		comment?: string;
		baseDefinitions?: readonly AgentDefinitionDraft[];
		sources?: readonly AgentGenerationSource[];
		conversationId?: string;
		signal: AbortSignal;
	}) => Promise<{ fields: Partial<AgentDefinitionDraft>; conversationId?: string }>;
	existing: readonly AgentDefinitionDraft[];
	/** `asCopy` writes a new file from this draft instead of overwriting the definition being edited. */
	save: (definition: AgentDefinitionDraft, scope: "project" | "user", options?: { asCopy?: boolean }) => Promise<void>;
	/** Deletes the file backing the edited definition; absent when there is none. */
	remove?: () => Promise<void>;
	/** Opens a fresh draft with this name, for a `spawns` target that does not exist yet. */
	createMissing?: (name: string) => void;
	/** Effective facts and findings for the live draft; recomputed on every change. */
	inspect?: (definition: AgentDefinitionDraft) => AgentDefinitionInspection;
	externalEditor?: (raw: string) => Promise<string | null>;
	/** Opens the actual backing file, not the draft sent to externalEditor. */
	openDefinitionFile?: () => Promise<void>;
	outputSchemaDialect?: (schema: unknown) => "json-schema" | "jtd";
	saveScopeEditable?: boolean;
}
