/**
 * Per-step-type forms for the visual builder. Each form takes a strongly-typed
 * step extract and emits a new step of the same type. Common fields (id, when,
 * on_failure, retry, timeout_secs) live in <StepCommonFields/>; this file only
 * renders the type-specific tail.
 *
 * `errors` maps a field name (as it appears in the spec) to the message the
 * validator produced for it; each form hands the message to the field it
 * belongs to, so a problem is shown where it is fixed.
 */
import { Link } from "react-router-dom";
import type { RoutineStep } from "@npi-deck/protocol";
import { useState, type ReactNode } from "react";

import {
	ActionTextField,
	AdvancedNotice,
	Checkbox,
	Field,
	hasAdvancedContent,
	KeyValueEditor,
	NumInput,
	Select,
	TagInput,
	TextArea,
	TextInput,
} from "./form-primitives";
import { cardBodyParts, cardPropertyDocument, setCardBodyContent, setCardBodyProperty, type CardPropertyDocument } from "../../lib/card-frontmatter";

type Extract2<T extends RoutineStep["type"]> = Extract<RoutineStep, { type: T }>;

export type StepFieldErrors = Readonly<Record<string, string>>;

interface FormProps<T extends RoutineStep["type"]> {
	step: Extract2<T>;
	onChange: (next: Extract2<T>) => void;
	advanced?: boolean;
	errors?: StepFieldErrors;
}

function Help({ children }: { children: ReactNode }) {
	return <p className="text-[12px] leading-relaxed text-ink-3">{children}</p>;
}

function CardBodyProperties({ body, onChange, advanced, children }: {
	body: string;
	onChange: (body: string) => void;
	advanced: boolean;
	children?: ReactNode;
}) {
	const [propertyName, setPropertyName] = useState("");
	const [propertyValue, setPropertyValue] = useState("");
	let parsed: CardPropertyDocument;
	try {
		parsed = cardPropertyDocument(body);
	} catch {
		return <details>
			<summary className="cursor-pointer text-[12.5px] text-ink-2">Card properties</summary>
			<Help>Turn on Advanced to correct the existing frontmatter in the body editor.</Help>
			{children}
		</details>;
	}
	const readOnly = parsed.properties["read-only"];
	const worktree = parsed.properties.worktree;
	const properties: Record<string, string> = Object.fromEntries(
		Object.entries(parsed.properties)
			.filter(([key, value]) => key !== "read-only" && key !== "worktree"
				&& (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
				&& !hasAdvancedContent(key) && !hasAdvancedContent(String(value)))
			.map(([key, value]) => [key, String(value)]),
	);
	const hiddenProperties = Object.keys(parsed.properties)
		.some((key) => key !== "read-only" && key !== "worktree" && !(key in properties));
	const newPropertyName = propertyName.trim();
	const canAddProperty = newPropertyName !== "" && newPropertyName !== "read-only"
		&& newPropertyName !== "worktree" && !Object.hasOwn(parsed.properties, newPropertyName)
		&& !hasAdvancedContent(newPropertyName) && !hasAdvancedContent(propertyValue);
	return (
		<details className="space-y-3">
			<summary className="cursor-pointer text-[12.5px] text-ink-2">Card properties</summary>
			{readOnly === undefined || typeof readOnly === "boolean" ? (
				<Checkbox checked={readOnly === true} onChange={(on) => onChange(setCardBodyProperty(body, "read-only", on))}>
					Read-only research
				</Checkbox>
			) : <Help>Edit the existing read-only value in Other properties.</Help>}
			{worktree === undefined || typeof worktree === "string" ? (
				<Field label="Linked worktree" optional>
					{!advanced && typeof worktree === "string" && hasAdvancedContent(worktree) ? (
						<AdvancedNotice>Turn on Advanced to edit the existing worktree expression.</AdvancedNotice>
					) : <TextInput value={worktree ?? ""} placeholder="Absolute worktree directory"
						onChange={(v) => onChange(setCardBodyProperty(body, "worktree", v === "" ? undefined : v))} />}
				</Field>
			) : <Help>Edit the existing worktree value in Other properties.</Help>}
			{children}
			{Object.entries(properties).map(([key, value]) => (
				<Field key={key} label={key}>
					<div className="flex items-center gap-1.5">
						<TextInput value={value} onChange={(next) => onChange(setCardBodyProperty(body, key, next))} />
						<button type="button" className="neo-btn" data-variant="ghost" data-size="sm" data-icon="true" aria-label={`Remove property ${key}`}
							onClick={() => onChange(setCardBodyProperty(body, key, undefined))}>×</button>
					</div>
				</Field>
			))}
			<Field label="Add a property">
				<div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
					<TextInput value={propertyName} onChange={setPropertyName} placeholder="Name" />
					<TextInput value={propertyValue} onChange={setPropertyValue} placeholder="Value" />
					<button type="button" className="neo-btn" data-size="sm" disabled={!canAddProperty}
						onClick={() => {
							onChange(setCardBodyProperty(body, newPropertyName, propertyValue));
							setPropertyName("");
							setPropertyValue("");
						}}>Add</button>
				</div>
			</Field>
			{!advanced && hiddenProperties ? <Help>
				Other existing properties use advanced content. Turn on Advanced to edit them.
			</Help> : null}
			{advanced ? <Field label="Other properties" help="TOML frontmatter, kept verbatim.">
				<TextArea value={parsed.header} rows={4}
					onChange={(header) => onChange(header === "" ? parsed.content : `+++\n${header.endsWith("\n") ? header : `${header}\n`}+++\n${parsed.content}`)} />
			</Field> : null}
		</details>
	);
}

function CardBodyField({ label, body, onChange, advanced, rows, placeholder, optional, error }: {
	label: string;
	body: string;
	onChange: (body: string) => void;
	advanced: boolean;
	rows: number;
	placeholder: string;
	optional?: boolean;
	error?: string;
}) {
	let value = body;
	if (!advanced) {
		try {
			value = cardBodyParts(body).content;
		} catch {
			return <Field label={label} optional={optional}><AdvancedNotice>Turn on Advanced to edit this body.</AdvancedNotice></Field>;
		}
	}
	return <ActionTextField label={label} value={value} advanced={advanced} rows={rows} placeholder={placeholder} optional={optional} error={error} mono={false}
		onChange={(content) => onChange(advanced ? content : setCardBodyContent(body, content))} />;
}

// ─── run ──────────────────────────────────────────────────────────────────

export function RunStepForm({ step, onChange, advanced = true, errors }: FormProps<"run">) {
	return (
		<div className="space-y-3">
			<ActionTextField
				label="Command"
				value={step.command}
				onChange={(v) => onChange({ ...step, command: v })}
				advanced={advanced}
				rows={3}
				placeholder="echo hello"
				error={errors?.command}
				help="Runs in a shell. Output lands in the step's stdout."
			/>
			{advanced ? <Field label="Working directory" optional error={errors?.cwd}>
				<TextInput
					value={step.cwd ?? ""}
					onChange={(v) => {
						const next = { ...step };
						if (v.trim() === "") delete next.cwd;
						else next.cwd = v;
						onChange(next);
					}}
					placeholder="/path/to/repo"
					mono
				/>
			</Field> : null}
		</div>
	);
}

// ─── agent ────────────────────────────────────────────────────────────────

function AllowlistField({ label, allLabel, placeholder, values, onChange }: {
	label: string;
	allLabel: string;
	placeholder: string;
	values?: string[];
	onChange: (values?: string[]) => void;
}) {
	return (
		<Field label={label}>
			<Select
				ariaLabel={`${label} scope`}
				value={values === undefined ? "all" : "listed"}
				onChange={(v) => onChange(v === "all" ? undefined : values ?? [])}
				options={[
					{ value: "all", label: allLabel },
					{ value: "listed", label: "Only the ones listed" },
				]}
			/>
			{values !== undefined && (
				<TagInput values={values} onChange={onChange} placeholder={placeholder} />
			)}
		</Field>
	);
}

export function AgentStepForm({ step, onChange, advanced = true, errors }: FormProps<"agent">) {
	function patch(p: Partial<Extract2<"agent">>): void {
		onChange({ ...step, ...p });
	}
	function updateAllowlist(key: "skills_allowed" | "mcp_servers_allowed", names?: string[]): void {
		const next = { ...step };
		if (names === undefined) delete next[key];
		else next[key] = names;
		onChange(next);
	}
	return (
		<div className="space-y-3">
			<ActionTextField
				label="Prompt"
				value={step.prompt}
				onChange={(v) => patch({ prompt: v })}
				advanced={advanced}
				rows={6}
				mono={false}
				placeholder="Describe what you want the agent to do."
				error={errors?.prompt}
			/>
			<Field label="Notes to read first" optional help="Knowledge-base note paths the agent gets as input." error={errors?.kb_inputs}>
				<TagInput values={step.kb_inputs ?? []} onChange={paths => patch({ kb_inputs: paths })}
					placeholder="projects/neodeck/overview.md" />
			</Field>
			{advanced ? <>
			<Field label="Model" optional help="Defaults to the engine's active model." error={errors?.model}>
				<TextInput
					value={step.model ?? ""}
					onChange={(v) => {
						const next = { ...step };
						if (v.trim() === "") delete next.model;
						else next.model = v;
						onChange(next);
					}}
					placeholder="claude-sonnet-4-5"
					mono
				/>
			</Field>
			<div className="grid grid-cols-2 gap-3">
				<AllowlistField
					label="Skills"
					allLabel="All installed skills"
					placeholder="skill-name"
					values={step.skills_allowed}
					onChange={(names) => updateAllowlist("skills_allowed", names)}
				/>
				<AllowlistField
					label="MCP servers"
					allLabel="All configured servers"
					placeholder="server-name"
					values={step.mcp_servers_allowed}
					onChange={(names) => updateAllowlist("mcp_servers_allowed", names)}
				/>
			</div>
			</> : null}
		</div>
	);
}

// ─── write ────────────────────────────────────────────────────────────────

export function WriteStepForm({ step, onChange, errors }: FormProps<"write">) {
	function patch(p: Partial<Extract2<"write">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-3">
			<Field label="Path" error={errors?.path}>
				<TextInput
					value={step.path}
					onChange={(v) => patch({ path: v })}
					placeholder="inbox/captures/{{ run.date }}-briefing.md"
					mono
				/>
			</Field>
			<Field label="Content" error={errors?.content}>
				<TextArea
					value={step.content}
					onChange={(v) => patch({ content: v })}
					rows={5}
					placeholder="# Heading\n\n{{ steps.summarize.stdout }}"
				/>
			</Field>
			<Checkbox
				checked={step.append === true}
				onChange={(on) => {
					const next = { ...step };
					if (on) next.append = true;
					else delete next.append;
					onChange(next);
				}}
			>
				Append instead of overwriting
			</Checkbox>
		</div>
	);
}

// ─── http ─────────────────────────────────────────────────────────────────

const HTTP_METHODS: Array<{ value: Extract2<"http">["method"]; label: string }> = [
	{ value: "GET", label: "GET" },
	{ value: "POST", label: "POST" },
	{ value: "PUT", label: "PUT" },
	{ value: "PATCH", label: "PATCH" },
	{ value: "DELETE", label: "DELETE" },
];

export function HttpStepForm({ step, onChange, errors }: FormProps<"http">) {
	function patch(p: Partial<Extract2<"http">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-[6.5rem_1fr] gap-3">
				<Field label="Method" error={errors?.method}>
					<Select value={step.method} onChange={(method) => patch({ method })} options={HTTP_METHODS} />
				</Field>
				<Field label="URL" error={errors?.url}>
					<TextInput
						value={step.url}
						onChange={(v) => patch({ url: v })}
						placeholder="http://127.0.0.1:1701/api/tasks"
						mono
					/>
				</Field>
			</div>
			<Field label="Headers" optional>
				<KeyValueEditor
					pairs={(step.headers as Record<string, string>) ?? {}}
					onChange={(v) => {
						const next = { ...step };
						if (Object.keys(v).length === 0) delete next.headers;
						else next.headers = v;
						onChange(next);
					}}
					keyPlaceholder="X-Header"
					valuePlaceholder="value"
				/>
			</Field>
			<Field label="Query parameters" optional>
				<KeyValueEditor
					pairs={objToStringMap(step.query)}
					onChange={(v) => {
						const next = { ...step };
						if (Object.keys(v).length === 0) delete next.query;
						else next.query = v;
						onChange(next);
					}}
					keyPlaceholder="param"
					valuePlaceholder="value"
				/>
			</Field>
			{step.method !== "GET" && step.method !== "DELETE" ? (
				<Field label="Body" optional help="JSON, or a template that renders to JSON." error={errors?.body}>
					<TextArea
						value={bodyToString(step.body)}
						onChange={(v) => {
							const next = { ...step };
							if (v.trim() === "") delete next.body;
							else next.body = v;
							onChange(next);
						}}
						rows={3}
						placeholder='{ "title": "{{ run.id }}" }'
					/>
				</Field>
			) : null}
			<Checkbox
				checked={step.expect_json !== false}
				onChange={(on) => {
					const next = { ...step };
					if (on) delete next.expect_json;
					else next.expect_json = false;
					onChange(next);
				}}
			>
				Expect a JSON response <span className="neo-mono text-ink-3">(steps.{step.id}.json)</span>
			</Checkbox>
		</div>
	);
}

function objToStringMap(o: unknown): Record<string, string> {
	if (!o || typeof o !== "object") return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(o)) {
		out[k] = String(v);
	}
	return out;
}

function bodyToString(b: unknown): string {
	if (b === undefined) return "";
	if (typeof b === "string") return b;
	try {
		return JSON.stringify(b, null, 2);
	} catch {
		return String(b);
	}
}


// ─── deck ─────────────────────────────────────────────────────────────────

type DeckStep = Extract2<"deck">;

const INBOX_KINDS = [
	{ value: "capture", label: "Capture" },
	{ value: "idea", label: "Idea" },
	{ value: "investigation", label: "Investigation" },
	{ value: "decision", label: "Decision" },
	{ value: "ticket", label: "Ticket" },
	{ value: "email", label: "Email" },
] as const;

export function DeckStepForm({ step, onChange, advanced = true, errors }: FormProps<"deck">) {
	function swapAction(action: DeckStep["action"]): void {
		const common = {
			id: step.id,
			type: "deck" as const,
			when: step.when,
			on_failure: step.on_failure,
			retry: step.retry,
			timeout_secs: step.timeout_secs,
		};
		switch (action) {
			case "create_inbox_item":
				onChange({
					...common,
					action,
					kind: "capture",
					title: step.action === action ? step.title : "Routine capture",
					body:
						step.action === action
							? step.body
							: step.action === "create_task"
								? step.body
								: "",
					source: step.action === action ? step.source : undefined,
				});
				return;
			case "create_task":
				onChange({
					...common,
					action,
					title: step.action === action ? step.title : "Follow up",
					body:
						step.action === action
							? step.body
							: step.action === "create_inbox_item"
								? step.body
								: "",
					state_ref: step.action === action ? step.state_ref : undefined,
					cwd: step.action === action ? step.cwd : undefined,
				});
				return;
			case "move_task":
				onChange({
					...common,
					action,
					task_ref: step.action === action ? step.task_ref : "T-1",
					state_ref: step.action === action ? step.state_ref : "done",
					index: step.action === action ? step.index : 0,
				});
				return;
			case "promote_inbox_item_to_task":
				onChange({
					...common,
					action,
					inbox_ref: step.action === action ? step.inbox_ref : "i_...",
					state_ref: step.action === action ? step.state_ref : undefined,
					mark_processed: step.action === action ? step.mark_processed : undefined,
				});
				return;
			case "list_tasks":
				onChange({
					...common,
					action,
					state_ref: step.action === action ? step.state_ref : "active",
					since_hours: step.action === action ? step.since_hours : undefined,
					include_archived: step.action === action ? step.include_archived : undefined,
					limit: step.action === action ? step.limit : undefined,
				});
				return;
			case "list_inbox":
				onChange({
					...common,
					action,
					kind: step.action === action ? step.kind : undefined,
					since_hours: step.action === action ? step.since_hours : 24,
					include_processed: step.action === action ? step.include_processed : undefined,
					limit: step.action === action ? step.limit : undefined,
				});
				return;
			case "get_task":
				onChange({
					...common,
					action,
					task_ref: step.action === action ? step.task_ref : "T-1",
				});
				return;
			case "get_inbox_item":
				onChange({
					...common,
					action,
					inbox_ref: step.action === action ? step.inbox_ref : "i_...",
				});
				return;
			case "kb_read":
				onChange({ ...common, action, path: step.action === action ? step.path : "README.md" });
				return;
			case "kb_orphan_census":
				onChange({
					...common,
					action,
					limit: step.action === action ? step.limit : 200,
				});
				return;
		}
	}

	return (
		<div className="space-y-3">
			{advanced ? <Field label="Deck action" error={errors?.action}>
				<Select
					value={step.action}
					onChange={(v) => swapAction(v)}
					options={[
						{ value: "create_inbox_item", label: "Create inbox item" },
						{ value: "create_task", label: "Create card" },
						{ value: "move_task", label: "Move card" },
						{ value: "promote_inbox_item_to_task", label: "Make a card from an inbox item" },
						{ value: "list_tasks", label: "Find cards" },
						{ value: "list_inbox", label: "Read inbox" },
						{ value: "get_task", label: "Read card" },
						{ value: "get_inbox_item", label: "Read inbox item" },
						{ value: "kb_orphan_census", label: "Find unlinked notes" },
						{ value: "kb_read", label: "Read a note" },
					]}
				/>
			</Field> : null}
			{step.action === "create_inbox_item" ? (
				<div className="space-y-3">
					<Field label="Kind" error={errors?.kind}>
						<Select
							value={step.kind}
							onChange={(kind) => onChange({ ...step, kind })}
							options={INBOX_KINDS}
						/>
					</Field>
					<ActionTextField label="Title" value={step.title} onChange={(v) => onChange({ ...step, title: v })} advanced={advanced} placeholder="Morning briefing" error={errors?.title} />
					<CardBodyField label="Body" body={step.body ?? ""} onChange={(body) => onChange({ ...step, body: body === "" ? undefined : body })} advanced={advanced} rows={5} placeholder="What should be saved in the inbox?" error={errors?.body} />
					{advanced ? <Field label="Source" optional error={errors?.source}>
						<TextInput value={step.source ?? ""} onChange={(v) => onChange({ ...step, source: v === "" ? undefined : v })} placeholder="routine:daily-briefing" mono />
					</Field> : null}
					<CardBodyProperties body={step.body ?? ""} advanced={advanced} onChange={(body) => onChange({ ...step, body })} />
				</div>
			) : null}
			{step.action === "create_task" ? (
				<div className="space-y-3">
					<ActionTextField label="Title" value={step.title} onChange={(v) => onChange({ ...step, title: v })} advanced={advanced} placeholder="Follow up" error={errors?.title} />
					<CardBodyField label="Body" optional body={step.body ?? ""} onChange={(body) => onChange({ ...step, body: body === "" ? undefined : body })} advanced={advanced} rows={4} placeholder="Describe the card." error={errors?.body} />
					<CardBodyProperties body={step.body ?? ""} advanced={advanced} onChange={(body) => onChange({ ...step, body })}>
					{advanced ? <><Field label="Column" optional error={errors?.state_ref}>
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="backlog or s_backlog" mono />
					</Field>
					<Field label="Working directory" optional error={errors?.cwd}>
						<TextInput value={step.cwd ?? ""} onChange={(v) => onChange({ ...step, cwd: v === "" ? undefined : v })} placeholder="/path/to/repo" mono />
					</Field></> : null}
					</CardBodyProperties>
				</div>
			) : null}
			{advanced && step.action === "move_task" ? (
				<div className="space-y-3">
					<Field label="Card" error={errors?.task_ref}>
						<TextInput value={step.task_ref} onChange={(v) => onChange({ ...step, task_ref: v })} placeholder="T-58 or t_01…" mono />
					</Field>
					<Field label="Destination column" error={errors?.state_ref}>
						<TextInput value={step.state_ref} onChange={(v) => onChange({ ...step, state_ref: v })} placeholder="done or s_done" mono />
					</Field>
					<Field label="Position" help="0 puts the card at the top of the column." error={errors?.index}>
						<NumInput value={step.index} onChange={(v) => onChange({ ...step, index: v ?? 0 })} placeholder="0" />
					</Field>
				</div>
			) : null}
			{step.action === "promote_inbox_item_to_task" ? (
				<div className="space-y-3">
					{advanced ? <>
					<Field label="Inbox item" error={errors?.inbox_ref}>
						<TextInput value={step.inbox_ref} onChange={(v) => onChange({ ...step, inbox_ref: v })} placeholder="i_…" mono />
					</Field>
					<Field label="Destination column" optional error={errors?.state_ref}>
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="backlog or s_backlog" mono />
					</Field>
					</> : <AdvancedNotice>Turn on Advanced to choose the inbox item and destination column.</AdvancedNotice>}
					{advanced ? <>
						<CardBodyField label="Body override" optional body={step.body ?? ""} onChange={(body) => onChange({ ...step, body: body === "" ? undefined : body })} advanced={advanced} rows={5} placeholder="Research this capture" error={errors?.body} />
						<CardBodyProperties body={step.body ?? ""} advanced={advanced} onChange={(body) => onChange({ ...step, body })} />
						<Field label="Working directory" optional help="Project routing; unassigned when empty." error={errors?.cwd}>
							<TextInput value={step.cwd ?? ""} onChange={(v) => onChange({ ...step, cwd: v === "" ? undefined : v })} placeholder="/path/to/repo" mono />
						</Field>
					</> : null}
					<Help>Card text and properties are kept from the inbox item unless overridden in Advanced. <Link to="/legacy/inbox" className="text-accent underline">Edit them in Inbox.</Link></Help>
					<Checkbox
						checked={step.mark_processed !== false}
						onChange={(on) => {
							const next = { ...step };
							if (on) delete next.mark_processed;
							else next.mark_processed = false;
							onChange(next);
						}}
					>
						Mark the inbox item processed afterwards
					</Checkbox>
				</div>
			) : null}
			{step.action === "list_tasks" ? (
				<div className="space-y-3">
					{advanced ? <Field label="Column" optional help="A name like active, or an id like s_active." error={errors?.state_ref}>
						<TextInput value={step.state_ref ?? ""} onChange={(v) => onChange({ ...step, state_ref: v === "" ? undefined : v })} placeholder="active" mono />
					</Field> : null}
					<div className="grid grid-cols-2 gap-3">
						<Field label="Updated within" optional help="Hours." error={errors?.since_hours}>
							<NumInput value={step.since_hours} onChange={(v) => onChange({ ...step, since_hours: v ?? undefined })} placeholder="24" />
						</Field>
						<Field label="Limit" optional error={errors?.limit}>
							<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="50" />
						</Field>
					</div>
					<Checkbox
						checked={step.include_archived === true}
						onChange={(on) => {
							const next = { ...step };
							if (on) next.include_archived = true;
							else delete next.include_archived;
							onChange(next);
						}}
					>
						Include archived cards
					</Checkbox>
				</div>
			) : null}
			{step.action === "list_inbox" ? (
				<div className="space-y-3">
					<Field label="Kind" optional error={errors?.kind}>
						<Select
							value={step.kind ?? ""}
							onChange={(v) => {
								const next = { ...step };
								if (v === "") delete next.kind;
								else next.kind = v as Extract<DeckStep, { action: "list_inbox" }>["kind"];
								onChange(next);
							}}
							options={[{ value: "", label: "Any" }, ...INBOX_KINDS]}
						/>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field label="Received within" optional help="Hours." error={errors?.since_hours}>
							<NumInput value={step.since_hours} onChange={(v) => onChange({ ...step, since_hours: v ?? undefined })} placeholder="24" />
						</Field>
						<Field label="Limit" optional error={errors?.limit}>
							<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="50" />
						</Field>
					</div>
					<Checkbox
						checked={step.include_processed === true}
						onChange={(on) => {
							const next = { ...step };
							if (on) next.include_processed = true;
							else delete next.include_processed;
							onChange(next);
						}}
					>
						Include already-processed items
					</Checkbox>
				</div>
			) : null}
			{advanced && step.action === "get_task" ? (
				<Field label="Card" error={errors?.task_ref}>
					<TextInput value={step.task_ref} onChange={(v) => onChange({ ...step, task_ref: v })} placeholder="T-58 or t_01…" mono />
				</Field>
			) : null}
			{advanced && step.action === "get_inbox_item" ? (
				<Field label="Inbox item" error={errors?.inbox_ref}>
					<TextInput value={step.inbox_ref} onChange={(v) => onChange({ ...step, inbox_ref: v })} placeholder="i_…" mono />
				</Field>
			) : null}
			{step.action === "kb_read" ? (
				<Field label="Note path" error={errors?.path}>
					<TextInput value={step.path} onChange={path => onChange({ ...step, path })} placeholder="README.md" mono />
				</Field>
			) : null}
			{step.action === "kb_orphan_census" ? (
				<Field label="Maximum notes" optional error={errors?.limit}>
					<NumInput value={step.limit} onChange={(v) => onChange({ ...step, limit: v ?? undefined })} placeholder="200" />
				</Field>
			) : null}
			{!advanced && ["move_task", "get_task", "get_inbox_item"].includes(step.action) ? (
				<AdvancedNotice>Turn on Advanced to choose the card, inbox item or destination column.</AdvancedNotice>
			) : null}
		</div>
	);
}

// ─── mcp ──────────────────────────────────────────────────────────────────

export function McpStepForm({ step, onChange, errors }: FormProps<"mcp">) {
	function patch(p: Partial<Extract2<"mcp">>): void {
		onChange({ ...step, ...p });
	}
	return (
		<div className="space-y-3">
			<Help>
				Calls one tool on a server enabled for the routine's working directory, without a model. Arguments are
				templated, then checked against the tool's input schema. Servers and their tools are listed on the{" "}
				<Link to="/legacy/integrations" className="text-accent hover:underline">MCP servers</Link> page.
			</Help>
			<div className="grid grid-cols-2 gap-3">
				<Field label="Server" error={errors?.server}>
					<TextInput
						value={step.server}
						onChange={(v) => patch({ server: v })}
						placeholder="filesystem"
						mono
					/>
				</Field>
				<Field label="Tool" error={errors?.tool}>
					<TextInput
						value={step.tool}
						onChange={(v) => patch({ tool: v })}
						placeholder="read_text_file"
						mono
					/>
				</Field>
			</div>
			<Field label="Arguments" help="JSON." error={errors?.args}>
				<TextArea
					value={step.args ? JSON.stringify(step.args, null, 2) : "{}"}
					onChange={(v) => {
						try {
							const parsed = JSON.parse(v) as Record<string, unknown>;
							patch({ args: parsed });
						} catch {
							// keep prior — invalid JSON noted by the spec validator on save
						}
					}}
					rows={4}
					placeholder='{ "path": "{{ run.date }}.md" }'
				/>
			</Field>
		</div>
	);
}

// ─── transform ────────────────────────────────────────────────────────────

export function TransformStepForm({ step, onChange, errors }: FormProps<"transform">) {
	return (
		<div className="space-y-3">
			<Field
				label="Expression"
				help={<>JavaScript; whatever it returns becomes this step's JSON output. Sandboxed (100 ms). Globals: <code>run</code>, <code>trigger</code>, <code>steps</code>, <code>state</code>, <code>env</code>, <code>secrets</code>.</>}
				error={errors?.body}
			>
				<TextArea
					value={step.body}
					onChange={(v) => onChange({ ...step, body: v })}
					rows={6}
					placeholder={"const tasks = steps.fetch_tasks.json.tasks;\nreturn { count: tasks.length };"}
				/>
			</Field>
		</div>
	);
}

// ─── wait ─────────────────────────────────────────────────────────────────

export function WaitStepForm({ step, onChange, errors }: FormProps<"wait">) {
	return (
		<Field label="Duration" help="Seconds." error={errors?.duration_secs}>
			<NumInput
				value={step.duration_secs}
				onChange={(v) => onChange({ ...step, duration_secs: v ?? 0 })}
				placeholder="5"
			/>
		</Field>
	);
}

// ─── set_state ────────────────────────────────────────────────────────────

export function SetStateStepForm({ step, onChange, errors }: FormProps<"set_state">) {
	return (
		<Field label="Values to remember" help="Keys are upserted into the routine's state; values may use {{ templates }}." error={errors?.state}>
			<KeyValueEditor
				pairs={objToStringMap(step.state)}
				onChange={(v) => onChange({ ...step, state: v })}
				keyPlaceholder="last_run_date"
				valuePlaceholder="{{ run.date }}"
			/>
		</Field>
	);
}
