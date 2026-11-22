import { Input } from "../components/input";
import { type SelectItem, SelectList } from "../components/select-list";
import { matchesKey } from "../keys";
import type { SgrMouseEvent } from "../mouse";
import { node, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { sanitizeDisplayWarning } from "../render/render-utils";
import { provenanceColor, uiProvenance, uiProvenanceSuffix } from "../theme/provenance";
import { getSelectListTheme, theme } from "../theme/theme";
import { truncateToWidth } from "../utils";
import {
	MODEL_FOLDER_ATTRIBUTES,
	type ModelFolderCondition,
	type ModelFolderRules,
	modelFolderOperators,
	validateModelFolderRules,
} from "./model-folder-rules";

export const MODEL_FOLDER_RULES_FEATURE = "model-folder-rules";
const TITLE = "Folder rules";

type Attribute = ModelFolderCondition["attribute"];
type Operator = ModelFolderCondition["operator"];
export type FolderRulesAction = "save" | "run" | "force";
interface ConditionDraft {
	clause: number;
	index: number;
	condition: ModelFolderCondition;
	adding: boolean;
}
type View = "rules" | "condition" | "attribute" | "operator" | "value";
const attributes = Object.entries(MODEL_FOLDER_ATTRIBUTES).map(([value, { label }]) => ({ value, label }));

/** Build new conditions step by step; edit saved rows without replaying the wizard. */
export class ModelFolderRulesPanel {
	#list = new SelectList([], 12, getSelectListTheme(), { activateOnSpace: false });
	#clauses: ModelFolderCondition[][];
	#ingest: boolean;
	#view: View = "rules";
	#draft?: ConditionDraft;
	#input = new Input();
	#listTop = 0;
	#error?: string;
	#notice?: string;

	constructor(
		readonly name: string,
		rules: ModelFolderRules | undefined,
		readonly apply: (rules: ModelFolderRules, action: FolderRulesAction) => string,
		readonly close: () => void,
	) {
		this.#clauses = rules?.clauses.map(clause => [...clause]) ?? [];
		this.#ingest = rules?.ingest ?? false;
		this.#list.onSelect = item => this.#activate(item.value);
		this.#list.onCancel = () => this.#back();
		this.#rebuild();
	}

	get editing(): boolean {
		return this.#view === "value" || this.#list.filterFocused;
	}

	get hint(): string {
		if (this.#view === "value") return "Enter add to expression · Esc back · Ctrl+C cancel editor";
		return "Enter select · Space toggle · Esc back · Ctrl+C cancel editor";
	}

	#enter(view: View, selected?: string): void {
		this.#view = view;
		this.#error = undefined;
		this.#notice = undefined;
		this.#list.restoreNavigationState({ filter: "", selectedValue: undefined, viewportTop: undefined });
		this.#rebuild();
		if (selected !== undefined) this.#list.setSelectedValue(selected);
	}

	#rebuild(): void {
		let rows: SelectItem[];
		const draft = this.#draft;
		switch (this.#view) {
			case "rules":
				rows = this.#clauses.flatMap((clause, group) => [
					...clause.map((condition, index) => ({
						value: `condition:${group}:${index}`,
						label: `${index > 0 ? "And" : group === 0 ? "If" : "Or"}  ${MODEL_FOLDER_ATTRIBUTES[condition.attribute].label}`,
						description: `${condition.invert ? "NOT " : ""}${condition.operator} ${sanitizeDisplayWarning(condition.value)}`,
					})),
					{ value: `and:${group}`, label: "  + And condition" },
				]);
				rows.push(
					{ value: "or", label: this.#clauses.length ? "+ Or clause" : "+ First condition" },
					{
						value: "ingest",
						label: "Ingest filter",
						description: this.#ingest ? "On · adds matches on refresh" : "Off",
					},
					{ value: "save", label: "Save rules" },
					{
						value: "run",
						label: "Run once",
						description: "Save and add matching models now",
						disabled: this.#clauses.length === 0,
					},
					{
						value: "force",
						label: "Force apply",
						description: "Save and replace membership with matches",
						confirmation: "Enter again to remove non-matching models",
						disabled: this.#clauses.length === 0,
					},
				);
				break;
			case "condition": {
				if (!draft) return;
				const { condition } = draft;
				rows = [
					{
						value: "attribute",
						label: "Attribute ▾",
						description: MODEL_FOLDER_ATTRIBUTES[condition.attribute].label,
					},
					{ value: "operator", label: "Operator ▾", description: condition.operator },
					{ value: "value", label: "Value", description: sanitizeDisplayWarning(condition.value) || "Required" },
					{ value: "invert", label: "Invert", description: condition.invert ? "On" : "Off" },
					{ value: "done", label: "Apply condition" },
				];
				if (this.#clauses[draft.clause]?.[draft.index]) rows.push({ value: "remove", label: "Remove condition" });
				break;
			}
			case "attribute":
				rows = attributes;
				break;
			case "operator":
				if (!draft) return;
				rows = modelFolderOperators(draft.condition.attribute);
				if (draft.adding)
					rows.unshift({ value: "invert", label: "Invert", description: draft.condition.invert ? "On" : "Off" });
				break;
			case "value":
				rows = [{ value: "applyValue", label: "Apply value" }];
				break;
		}
		this.#list.setItems(rows);
	}

	#editCondition(clause: number, index: number): void {
		const condition = this.#clauses[clause]?.[index];
		this.#draft = {
			clause,
			index,
			adding: condition === undefined,
			condition: condition ?? { attribute: "slug", operator: "==", value: "" },
		};
		if (condition) this.#enter("condition", "attribute");
		else this.#enter("attribute", "slug");
	}

	#back(): void {
		const draft = this.#draft;
		switch (this.#view) {
			case "rules":
				this.close();
				break;
			case "condition":
				this.#leaveCondition();
				break;
			case "attribute":
				if (draft?.adding) this.#leaveCondition();
				else this.#enter("condition", "attribute");
				break;
			case "operator":
				if (draft?.adding) this.#enter("attribute", draft.condition.attribute);
				else this.#enter("condition", "operator");
				break;
			case "value":
				if (draft?.adding) this.#enter("operator", draft.condition.operator);
				else this.#enter("condition", "value");
				break;
		}
	}

	#leaveCondition(): void {
		const draft = this.#draft;
		this.#draft = undefined;
		this.#enter("rules", draft ? this.#conditionRow(draft) : undefined);
	}

	#openValue(value: string): void {
		this.#input.setValue(value);
		this.#input.focused = true;
		this.#enter("value");
	}

	#commitCondition(draft: ConditionDraft, condition: ModelFolderCondition): void {
		validateModelFolderRules({ clauses: [[condition]], ingest: false });
		(this.#clauses[draft.clause] ??= [])[draft.index] = condition;
		this.#leaveCondition();
	}

	#conditionRow({ clause, index }: ConditionDraft): string {
		return this.#clauses[clause]?.[index]
			? `condition:${clause}:${index}`
			: this.#clauses[clause]
				? `and:${clause}`
				: "or";
	}

	#activate(row: string): void {
		this.#error = undefined;
		this.#notice = undefined;
		try {
			if (this.#view === "rules") {
				if (row === "ingest") {
					this.#ingest = !this.#ingest;
					this.#rebuild();
				} else if (row === "save" || row === "run" || row === "force") {
					const rules = { clauses: this.#clauses.map(clause => [...clause]), ingest: this.#ingest };
					this.#notice = this.apply(rules, row);
				} else if (row === "or") this.#editCondition(this.#clauses.length, 0);
				else if (row.startsWith("and:")) {
					const clause = Number(row.slice(4));
					const group = this.#clauses[clause];
					if (group) this.#editCondition(clause, group.length);
				} else if (row.startsWith("condition:")) {
					const [, clause, index] = row.split(":");
					this.#editCondition(Number(clause), Number(index));
				}
				return;
			}
			const draft = this.#draft;
			if (!draft) return;
			const condition = draft.condition;
			if (this.#view === "attribute") {
				const attribute = row as Attribute;
				const operator = modelFolderOperators(attribute).some(option => option.value === condition.operator)
					? condition.operator
					: "==";
				const sameKind =
					MODEL_FOLDER_ATTRIBUTES[attribute].kind === MODEL_FOLDER_ATTRIBUTES[condition.attribute].kind;
				draft.condition = { ...condition, attribute, operator, value: sameKind ? condition.value : "" };
				if (draft.adding) this.#enter("operator", operator);
				else this.#enter("condition", "attribute");
			} else if (row === "invert") {
				draft.condition = { ...condition, invert: !condition.invert };
				this.#rebuild();
			} else if (this.#view === "operator") {
				draft.condition = { ...condition, operator: row as Operator };
				if (draft.adding) this.#openValue(condition.value);
				else this.#enter("condition", "operator");
			} else if (this.#view === "value") {
				this.#commitCondition(draft, { ...condition, value: this.#input.getValue() });
			} else if (row === "attribute" || row === "operator") {
				this.#enter(row, condition[row]);
			} else if (row === "value") {
				this.#openValue(condition.value);
			} else if (row === "done") {
				this.#commitCondition(draft, condition);
			} else if (row === "remove") {
				const clause = this.#clauses[draft.clause];
				clause.splice(draft.index, 1);
				if (!clause.length) this.#clauses.splice(draft.clause, 1);
				this.#leaveCondition();
			}
		} catch (error) {
			this.#error = sanitizeDisplayWarning(error instanceof Error ? error.message : String(error));
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (this.#view === "value") {
			if (matchesKey(data, "escape")) this.#back();
			else if (matchesKey(data, "enter") || data === "\n") this.#activate("applyValue");
			else this.#input.handleInput(data);
			return;
		}
		if (!this.#list.filterFocused && matchesKey(data, "space")) {
			const row = this.#list.getSelectedItem()?.value;
			if (row === "ingest" || row === "invert") this.#activate(row);
			return;
		}
		this.#list.handleInput(data);
	}

	#heading(): string {
		switch (this.#view) {
			case "rules":
				return `${sanitizeDisplayWarning(this.name)} · Match every condition in any clause. Save to keep changes.`;
			case "condition":
				return "Edit condition";
			case "attribute":
				return "Choose model attribute";
			case "operator":
				return "Choose comparison operator";
			case "value": {
				const condition = this.#draft?.condition;
				if (!condition) return "Enter comparison value";
				const { label, kind } = MODEL_FOLDER_ATTRIBUTES[condition.attribute];
				if (condition.operator === "~=") return `${label} · case-insensitive regex`;
				if (condition.operator === "in")
					return `${label} · ${kind === "text" ? "substring or " : ""}comma-separated values`;
				if (condition.operator === "*=") return `${label} · glob pattern`;
				return `${label} · ${kind === "boolean" ? "true or false" : kind}`;
			}
		}
	}

	render(width: number, rows: number): string[] {
		const title = theme.bold(TITLE) + uiProvenanceSuffix("features", MODEL_FOLDER_RULES_FEATURE, true);
		const lines = [title, this.#heading()];
		if (this.#error) lines.push(theme.fg("error", this.#error));
		else if (this.#notice) lines.push(theme.fg("success", this.#notice));
		if (this.#view === "value") lines.push(...this.#input.render(width));
		this.#listTop = lines.length;
		this.#list.setMaxVisible(Math.max(1, rows - this.#listTop));
		return [...lines.map(line => truncateToWidth(line, width)), ...this.#list.render(width)].slice(0, rows);
	}

	describe(): NativeNode {
		return node(
			"col",
			{ gap: "sm", grow: 1 },
			[
				text([
					span(TITLE),
					span(
						uiProvenanceSuffix("features", MODEL_FOLDER_RULES_FEATURE),
						provenanceColor(uiProvenance("features", MODEL_FOLDER_RULES_FEATURE)),
					),
				]),
				text([span(this.#heading())], { wrap: "word" }),
				...(this.#error ? [text([span(this.#error, "error")])] : []),
				...(this.#notice ? [text([span(this.#notice, "success")])] : []),
				...(this.#view === "value" ? [this.#input] : []),
				this.#list,
			],
			"modelFolderRules",
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#view === "value" && (event.type === "edit" || event.type === "undo"))
			this.#input.handleNativeEvent(event);
		else this.#list.handleNativeEvent(event);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#list.routeMouse(event, line - this.#listTop, col);
	}
}
