import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
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
	if (typeof value !== "number" || !Number.isFinite(value)) return t("overlaysModel.variants.error.finite");
	if (field.integer && !Number.isSafeInteger(value)) return t("overlaysModel.variants.error.integer");
	if (field.min !== undefined && value < field.min) return t("overlaysModel.variants.error.min", { min: field.min });
	if (field.max !== undefined && value > field.max) return t("overlaysModel.variants.error.max", { max: field.max });
}

function validationError(field: HubModelVariantField, value: unknown): string | undefined {
	if (field.kind === "number") {
		const error = numberError(field, value);
		if (error) return error;
	} else if (field.kind === "number-list") {
		if (!Array.isArray(value)) return t("overlaysModel.variants.error.numberList");
		for (const item of value) {
			const error = numberError(field, item);
			if (error) return error;
		}
	} else if (field.kind === "string-list") {
		if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
			return t("overlaysModel.variants.error.stringList");
		}
	} else if (field.kind === "choice") {
		if (typeof value !== "string" || !field.choices.includes(value)) return t("overlaysModel.variants.error.choice");
	} else if (typeof value !== field.kind)
		return t("overlaysModel.variants.error.kind", {
			kind:
				field.kind === "boolean"
					? t("overlaysModel.variants.kind.boolean")
					: t("overlaysModel.variants.kind.string"),
		});
	return field.validate?.(value);
}

function decodedInput(field: HubModelVariantField, value: string): unknown {
	if (field.kind === "number") return value.trim() === "" ? NaN : Number(value);
	if (field.kind === "number-list" || field.kind === "string-list") {
		try {
			return JSON.parse(value);
		} catch {
			throw new Error(
				field.kind === "number-list"
					? t("overlaysModel.variants.error.numberList")
					: t("overlaysModel.variants.error.stringList"),
			);
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
	#labelsLocale = getLocale();
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
		if (this.#pending) return t("overlaysModel.variants.saving");
		switch (this.#view.kind) {
			case "list":
				return t("overlaysModel.variants.hint.list");
			case "editor":
				return t("overlaysModel.variants.hint.editor");
			case "base":
				return t("overlaysModel.variants.hint.base");
			case "choice":
				return t("overlaysModel.variants.hint.choice");
			case "text":
				return t("overlaysModel.variants.hint.text");
			case "delete":
				return t("overlaysModel.variants.hint.delete");
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
		this.#labelsLocale = getLocale();
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
				items.push({ value: "new", label: t("overlaysModel.variants.add") });
				break;
			case "editor":
				if (!draft) return;
				items = [
					{
						value: "name",
						label: t("overlaysModel.variants.name"),
						description: sanitizeDisplayWarning(draft.name) || t("overlaysModel.variants.required"),
					},
					{
						value: "base",
						label: t("overlaysModel.variants.base"),
						description: sanitizeDisplayWarning(draft.baseModel) || t("overlaysModel.variants.required"),
					},
					...this.host.fields().map(field => ({
						value: fieldId(field),
						label: field.label,
						description: Object.hasOwn(draft.overrides, field.key)
							? displayedOverride(draft.overrides[field.key])
							: t("overlaysModel.variants.inherit"),
					})),
					{ value: "save", label: t("overlaysModel.variants.save") },
				];
				if (draft.id !== undefined) items.push({ value: "delete", label: t("overlaysModel.variants.delete") });
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
					{ value: "inherit", label: t("overlaysModel.variants.inherit") },
					...view.choices.map((choice, index) => ({ value: `choice:${index}`, label: String(choice) })),
				];
				break;
			case "text":
				items = [{ value: "apply", label: t("overlaysModel.variants.apply") }];
				if (view.field) items.push({ value: "inherit", label: t("overlaysModel.variants.inherit") });
				items.push({ value: "cancel", label: t("overlaysModel.variants.cancel") });
				break;
			case "delete":
				items = [
					{ value: "keep", label: t("overlaysModel.variants.keep") },
					{
						value: "confirm-delete",
						label: t("overlaysModel.variants.deleteNamed", { name: sanitizeDisplayWarning(view.variant.name) }),
						confirmation: t("overlaysModel.variants.confirmDelete"),
					},
				];
				break;
		}
		this.#list.setItems(items);
	}

	#back(): void {
		const view = this.#view;
		switch (view.kind) {
			case "list":
				this.host.back();
				return;
			case "editor": {
				const id = this.#draft?.id;
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
							if (!name) throw new Error(t("overlaysModel.variants.error.name"));
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
			throw new Error(t("overlaysModel.variants.error.name"));
		}
		if (!this.host.models().some(model => !model.variant && selectorFor(model) === draft.baseModel)) {
			this.#list.setSelectedValue("base");
			throw new Error(t("overlaysModel.variants.error.base"));
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
			if (matchesKey(data, "escape")) this.#back();
			else if (matchesKey(data, "enter") || data === "\n") this.#activate("apply");
			else view.input.handleInput(data);
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
				return t("overlaysModel.variants.description");
			case "editor":
				return this.#draft?.id === undefined
					? t("overlaysModel.variants.new")
					: t("overlaysModel.variants.editNamed", { name: sanitizeDisplayWarning(this.#draft.name) });
			case "base":
				return t("overlaysModel.variants.chooseBase");
			case "choice":
				return view.field.label;
			case "text":
				if (view.field?.kind === "number-list" || view.field?.kind === "string-list") {
					return t("overlaysModel.variants.jsonField", { field: view.field.label });
				}
				return view.field?.label ?? t("overlaysModel.variants.variantName");
			case "delete":
				return t("overlaysModel.variants.deleteQuestion");
		}
	}

	render(width: number, rows: number): string[] {
		if (this.#labelsLocale !== getLocale()) this.#rebuild();
		const title =
			theme.bold(t("overlaysModel.variants.title")) + uiProvenanceSuffix("features", MODEL_VARIANTS_FEATURE, true);
		const heading = Bun.wrapAnsi(this.#heading(), width).split("\n");
		const lines = [truncateToWidth(title, width), ...heading.map(line => truncateToWidth(line, width))];
		if (this.#error) lines.push(truncateToWidth(theme.fg("error", this.#error), width));
		if (this.#view.kind === "text") lines.push(...this.#view.input.render(width));
		this.#listTop = lines.length;
		this.#list.setMaxVisible(Math.max(1, rows - this.#listTop));
		return [...lines, ...this.#list.render(width)].slice(0, rows);
	}

	describe(): NativeNode {
		if (this.#labelsLocale !== getLocale()) this.#rebuild();
		return node(
			"col",
			{ gap: "sm", grow: 1 },
			[
				text([
					span(t("overlaysModel.variants.title")),
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
