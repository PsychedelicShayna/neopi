import type { Model } from "@oh-my-pi/pi-ai";
import { Input } from "../components/input";
import { SelectList, type SelectItem } from "../components/select-list";
import { matchesKey } from "../keys";
import type { SgrMouseEvent } from "../mouse";
import { node, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { sanitizeDisplayWarning } from "../render/render-utils";
import { provenanceColor, uiProvenance, uiProvenanceSuffix } from "../theme/provenance";
import { getSelectListTheme, theme } from "../theme/theme";
import { truncateToWidth } from "../utils";
import type { HubModelVariant, HubModelVariantDraft, HubModelVariantField, ModelRoleSelectionScope } from "./model-hub";

export const MODEL_VARIANTS_FEATURE = "model-variants";
const TITLE = "Model Variants";
const DESCRIPTION = "Save a named version of a model. Fields set to Inherit follow the base model.";

interface VariantHost {
	scope(): ModelRoleSelectionScope | undefined;
	list(): readonly HubModelVariant[];
	fields(): readonly HubModelVariantField[];
	models(): readonly Model[];
	save(variant: HubModelVariantDraft): void | Promise<void>;
	remove(id: string): void | Promise<void>;
	changed(): void;
	back(): void;
}

interface VariantDraft {
	id?: string;
	name: string;
	baseModel: string;
	overrides: Record<string, unknown>;
}

type View =
	| { kind: "list" }
	| { kind: "editor" }
	| { kind: "base" }
	| { kind: "choice"; field: HubModelVariantField; choices: readonly (string | boolean)[] }
	| { kind: "text"; input: Input; field?: HubModelVariantField }
	| { kind: "delete"; variant: HubModelVariant };

const fieldId = (field: HubModelVariantField) => `field:${field.key}`;
const variantId = (id: string) => `variant:${id}`;
const selectorFor = (model: Model) => `${model.provider}/${model.id}`;

function numberError(field: Extract<HubModelVariantField, { kind: "number" | "number-list" }>, value: unknown) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a finite number.";
	if (field.integer && !Number.isSafeInteger(value)) return "Enter a whole number within the safe integer range.";
	if (field.min !== undefined && value < field.min) return `Use a value of at least ${field.min}.`;
	if (field.max !== undefined && value > field.max) return `Use a value of at most ${field.max}.`;
}

function validationError(field: HubModelVariantField, value: unknown): string | undefined {
	if (field.kind === "number") {
		const error = numberError(field, value);
		if (error) return error;
	} else if (field.kind === "number-list") {
		if (!Array.isArray(value)) return "Enter a JSON array of numbers.";
		for (const item of value) {
			const error = numberError(field, item);
			if (error) return error;
		}
	} else if (field.kind === "string-list") {
		if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
			return "Enter a JSON array of strings.";
		}
	} else if (field.kind === "choice") {
		if (typeof value !== "string" || !field.choices.includes(value)) return "Choose a listed value.";
	} else if (typeof value !== field.kind) return `Enter a ${field.kind} value.`;
	return field.validate?.(value);
}

function decodedInput(field: HubModelVariantField, value: string): unknown {
	if (field.kind === "number") return value.trim() === "" ? NaN : Number(value);
	if (field.kind === "number-list" || field.kind === "string-list") {
		try {
			return JSON.parse(value);
		} catch {
			throw new Error(`Enter a JSON array of ${field.kind === "number-list" ? "numbers" : "strings"}.`);
		}
	}
	return value;
}

function displayedOverride(value: unknown): string {
	return sanitizeDisplayWarning(JSON.stringify(value) ?? String(value));
}

/** The Model Variants editor owns only draft/UI state; the hub source owns persistence and IDs. */
export class ModelVariantsPanel {
	#list = new SelectList([], 12, getSelectListTheme(), { search: "always", activateOnSpace: false });
	#view: View = { kind: "list" };
	#draft?: VariantDraft;
	#entries: readonly HubModelVariant[] = [];
	#scope?: ModelRoleSelectionScope;
	#pending = false;
	#error?: string;
	#listTop = 0;

	constructor(readonly host: VariantHost) {
		this.#list.onSelect = item => this.#activate(item.value);
		this.#list.onCancel = () => this.#back();
		this.reload();
	}

	get editing(): boolean {
		return this.#view.kind === "text" || this.#list.filterFocused;
	}

	get busy(): boolean {
		return this.#pending || this.#view.kind !== "list";
	}

	get hint(): string {
		if (this.#pending) return "Saving…";
		switch (this.#view.kind) {
			case "list":
				return "Enter edit/create · x delete · / search · Esc sidebar · Tab pane";
			case "editor":
				return "Enter edit · x inherit · s save · Ctrl+C discard · Tab pane";
			case "base":
				return "Enter choose base · / search · Esc back";
			case "choice":
				return "Enter choose value · Esc back";
			case "text":
				return "Enter apply · Ctrl+C cancel field";
			case "delete":
				return "Enter confirm · Esc keep variant";
		}
	}

	reload(): void {
		if (this.#pending) return;
		const scope = this.host.scope();
		if (scope !== this.#scope) {
			this.#scope = scope;
			this.#draft = undefined;
			this.#entries = this.host.list();
			this.#enter({ kind: "list" });
			return;
		}
		if (this.#view.kind !== "list") return;
		this.#entries = this.host.list();
		this.#rebuild();
	}

	#enter(view: View, selected?: string): void {
		this.#view = view;
		this.#error = undefined;
		this.#list.restoreNavigationState({ filter: "", selectedValue: undefined, viewportTop: undefined });
		this.#rebuild();
		if (selected !== undefined) this.#list.setSelectedValue(selected);
	}

	#rebuild(): void {
		const view = this.#view;
		const draft = this.#draft;
		let items: SelectItem[];
		switch (view.kind) {
			case "list":
				items = this.#entries.map(entry => ({
					value: variantId(entry.id),
					label: sanitizeDisplayWarning(entry.name),
					description: sanitizeDisplayWarning(entry.baseModel),
				}));
				items.push({ value: "new", label: "+ New variant" });
				break;
			case "editor":
				if (!draft) return;
				items = [
					{ value: "name", label: "Name", description: sanitizeDisplayWarning(draft.name) || "Required" },
					{
						value: "base",
						label: "Base model ▾",
						description: sanitizeDisplayWarning(draft.baseModel) || "Required",
					},
					...this.host.fields().map(field => ({
						value: fieldId(field),
						label: field.label,
						description: Object.hasOwn(draft.overrides, field.key)
							? displayedOverride(draft.overrides[field.key])
							: "Inherit",
					})),
					{ value: "save", label: "Save variant" },
				];
				if (draft.id !== undefined) items.push({ value: "delete", label: "Delete variant…" });
				break;
			case "base": {
				const models = new Map<string, SelectItem>();
				for (const model of this.host.models()) {
					if (model.variant) continue;
					const selector = selectorFor(model);
					models.set(`base:${selector}`, {
						value: `base:${selector}`,
						label: sanitizeDisplayWarning(selector),
						description: model.name === model.id ? undefined : sanitizeDisplayWarning(model.name),
					});
				}
				items = [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
				break;
			}
			case "choice":
				items = [
					{ value: "inherit", label: "Inherit" },
					...view.choices.map((choice, index) => ({ value: `choice:${index}`, label: String(choice) })),
				];
				break;
			case "text":
				items = [{ value: "apply", label: "Apply value" }];
				if (view.field) items.push({ value: "inherit", label: "Inherit" });
				items.push({ value: "cancel", label: "Cancel" });
				break;
			case "delete":
				items = [
					{ value: "keep", label: "Keep variant" },
					{
						value: "confirm-delete",
						label: `Delete ${sanitizeDisplayWarning(view.variant.name)}`,
						confirmation: "Enter again to delete this variant",
					},
				];
				break;
		}
		this.#list.setItems(items);
	}

	#back(discard = false): void {
		const view = this.#view;
		switch (view.kind) {
			case "list":
				this.host.back();
				return;
			case "editor": {
				const id = this.#draft?.id;
				const original = this.#entries.find(entry => entry.id === id) ?? { name: "", baseModel: "", overrides: {} };
				if (!discard && !Bun.deepEquals(this.#draft, original)) return;
				this.#draft = undefined;
				this.#enter({ kind: "list" }, id === undefined ? "new" : variantId(id));
				this.reload();
				return;
			}
			case "base":
				this.#enter({ kind: "editor" }, "base");
				return;
			case "choice":
				this.#enter({ kind: "editor" }, fieldId(view.field));
				return;
			case "text":
				this.#enter({ kind: "editor" }, view.field ? fieldId(view.field) : "name");
				return;
			case "delete":
				if (this.#draft) this.#enter({ kind: "editor" }, "delete");
				else this.#enter({ kind: "list" }, variantId(view.variant.id));
		}
	}

	#editText(field?: HubModelVariantField): void {
		const draft = this.#draft;
		if (!draft) return;
		const input = new Input();
		input.focused = true;
		const value = field ? draft.overrides[field.key] : draft.name;
		input.setValue(value === undefined ? "" : typeof value === "string" ? value : (JSON.stringify(value) ?? ""));
		if (field?.kind === "number-list") input.placeholder = "[1, 2]";
		else if (field?.kind === "string-list") input.placeholder = '["first", "second"]';
		const close = () => this.#back();
		input.onEscape = close;
		input.onCancel = close;
		input.onSubmit = () => this.#activate("apply");
		this.#enter({ kind: "text", input, field }, "apply");
	}

	#setOverride(field: HubModelVariantField, value: unknown): void {
		const draft = this.#draft;
		if (!draft) return;
		const error = validationError(field, value);
		if (error) throw new Error(`${field.label}: ${error}`);
		Object.defineProperty(draft.overrides, field.key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		this.#enter({ kind: "editor" }, fieldId(field));
	}

	#inherit(field: HubModelVariantField): void {
		if (!this.#draft) return;
		delete this.#draft.overrides[field.key];
		this.#enter({ kind: "editor" }, fieldId(field));
	}

	#activate(value: string): void {
		if (this.#pending) return;
		if (this.host.scope() !== this.#scope) {
			this.reload();
			return;
		}
		const view = this.#view;
		const draft = this.#draft;
		try {
			switch (view.kind) {
				case "list": {
					const entry = this.#entries.find(entry => variantId(entry.id) === value);
					if (!entry && value !== "new") return;
					this.#draft = entry
						? { ...entry, overrides: { ...entry.overrides } }
						: { name: "", baseModel: "", overrides: {} };
					this.#enter({ kind: "editor" }, "name");
					return;
				}
				case "editor": {
					if (!draft) return;
					if (value === "name") this.#editText();
					else if (value === "base") this.#enter({ kind: "base" }, `base:${draft.baseModel}`);
					else if (value === "save") this.#save(draft);
					else if (value === "delete") this.#confirmDelete(draft.id);
					else {
						const field = this.host.fields().find(field => fieldId(field) === value);
						if (!field) return;
						if (field.kind === "choice" || field.kind === "boolean") {
							const choices = field.kind === "choice" ? field.choices : [true, false];
							const index = choices.findIndex(choice => choice === draft.overrides[field.key]);
							this.#enter({ kind: "choice", field, choices }, index < 0 ? "inherit" : `choice:${index}`);
						} else this.#editText(field);
					}
					return;
				}
				case "base":
					if (draft && value.startsWith("base:")) {
						draft.baseModel = value.slice("base:".length);
						this.#back();
					}
					return;
				case "choice": {
					if (value === "inherit") this.#inherit(view.field);
					else if (value.startsWith("choice:")) {
						const choice = view.choices[Number(value.slice("choice:".length))];
						if (choice !== undefined) this.#setOverride(view.field, choice);
					}
					return;
				}
				case "text":
					if (value === "cancel") this.#back();
					else if (value === "inherit" && view.field) this.#inherit(view.field);
					else if (draft && value === "apply") {
						const inputValue = view.input.getValue();
						if (view.field) this.#setOverride(view.field, decodedInput(view.field, inputValue));
						else {
							const name = inputValue.trim();
							if (!name) throw new Error("Enter a variant name.");
							draft.name = name;
							this.#back();
						}
					}
					return;
				case "delete":
					if (value === "confirm-delete") void this.#persist(() => this.host.remove(view.variant.id));
					else if (value === "keep") this.#back();
			}
		} catch (error) {
			this.#error = sanitizeDisplayWarning(error instanceof Error ? error.message : String(error));
		}
	}

	#confirmDelete(id: string | undefined): void {
		const variant = this.#entries.find(entry => entry.id === id);
		if (variant) this.#enter({ kind: "delete", variant }, "keep");
	}

	#save(draft: VariantDraft): void {
		if (!draft.name) {
			this.#list.setSelectedValue("name");
			throw new Error("Enter a variant name.");
		}
		if (!this.host.models().some(model => !model.variant && selectorFor(model) === draft.baseModel)) {
			this.#list.setSelectedValue("base");
			throw new Error("Choose an ordinary model as the base.");
		}
		for (const field of this.host.fields()) {
			if (!Object.hasOwn(draft.overrides, field.key)) continue;
			const error = validationError(field, draft.overrides[field.key]);
			if (error) {
				this.#list.setSelectedValue(fieldId(field));
				throw new Error(`${field.label}: ${error}`);
			}
		}
		void this.#persist(() => this.host.save(draft), draft.id);
	}

	async #persist(apply: () => void | Promise<void>, savedId?: string): Promise<void> {
		this.#pending = true;
		this.#error = undefined;
		let applied = false;
		try {
			await apply();
			applied = true;
		} catch (error) {
			this.#error = sanitizeDisplayWarning(error instanceof Error ? error.message : String(error));
		} finally {
			this.#pending = false;
			if (applied) {
				this.#draft = undefined;
				this.#entries = this.host.list();
				this.#enter({ kind: "list" }, savedId === undefined ? undefined : variantId(savedId));
			} else if (this.#view.kind === "delete") {
				this.#list.setSelectedValue("keep");
			}
			this.host.changed();
		}
	}

	handleInput(data: string): void {
		if (this.#pending) return;
		const view = this.#view;
		if (view.kind === "text") {
			view.input.handleInput(data, true);
			return;
		}
		if (!this.#list.filterFocused && matchesKey(data, "ctrl+c")) {
			this.#back(true);
			return;
		}
		if (!this.#list.filterFocused) {
			if (view.kind === "editor" && data === "s") {
				this.#activate("save");
				return;
			}
			if (data === "x" && (view.kind === "list" || view.kind === "editor")) {
				const value = this.#list.getSelectedItem()?.value;
				if (view.kind === "list") {
					this.#confirmDelete(this.#entries.find(entry => variantId(entry.id) === value)?.id);
				} else {
					const field = this.host.fields().find(field => fieldId(field) === value);
					if (field) this.#inherit(field);
				}
				return;
			}
		}
		this.#list.handleInput(data);
	}

	#heading(): string {
		const view = this.#view;
		switch (view.kind) {
			case "list":
				return DESCRIPTION;
			case "editor":
				return this.#draft?.id === undefined ? "New variant" : `Edit ${sanitizeDisplayWarning(this.#draft.name)}`;
			case "base":
				return "Choose a base model";
			case "choice":
				return view.field.label;
			case "text":
				if (view.field?.kind === "number-list" || view.field?.kind === "string-list") {
					return `${view.field.label} · JSON array`;
				}
				return view.field?.label ?? "Variant name";
			case "delete":
				return "Delete variant?";
		}
	}

	render(width: number, rows: number): string[] {
		const title = theme.bold(TITLE) + uiProvenanceSuffix("features", MODEL_VARIANTS_FEATURE, true);
		const heading = Bun.wrapAnsi(this.#heading(), width).split("\n");
		const lines = [truncateToWidth(title, width), ...heading.map(line => truncateToWidth(line, width))];
		if (this.#error) lines.push(truncateToWidth(theme.fg("error", this.#error), width));
		if (this.#view.kind === "text") lines.push(...this.#view.input.render(width));
		this.#listTop = lines.length;
		this.#list.setMaxVisible(Math.max(1, rows - this.#listTop));
		return [...lines, ...this.#list.render(width)].slice(0, rows);
	}

	describe(): NativeNode {
		return node(
			"col",
			{ gap: "sm", grow: 1 },
			[
				text([
					span(TITLE),
					span(
						uiProvenanceSuffix("features", MODEL_VARIANTS_FEATURE),
						provenanceColor(uiProvenance("features", MODEL_VARIANTS_FEATURE)),
					),
				]),
				text([span(this.#heading())], { wrap: "word" }),
				...(this.#error ? [text([span(this.#error, "error")])] : []),
				...(this.#view.kind === "text" ? [this.#view.input] : []),
				this.#list,
			],
			"modelVariants",
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#pending) return;
		if (this.#view.kind === "text" && (event.type === "edit" || event.type === "undo")) {
			this.#view.input.handleNativeEvent(event);
		} else this.#list.handleNativeEvent(event);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!this.#pending) this.#list.routeMouse(event, line - this.#listTop, col);
	}
}
