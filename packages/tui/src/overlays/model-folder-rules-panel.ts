import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
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

type Attribute = ModelFolderCondition["attribute"];

function attributeLabel(attribute: Attribute): string {
	return attribute === "tps"
		? MODEL_FOLDER_ATTRIBUTES.tps.label
		: t(`overlaysModel.folderRules.attribute.${attribute}`);
}

type Operator = ModelFolderCondition["operator"];
export type FolderRulesAction = "save" | "run" | "force";
interface ConditionDraft {
	clause: number;
	index: number;
	condition: ModelFolderCondition;
	adding: boolean;
}
type View = "rules" | "condition" | "attribute" | "operator" | "value";

/** Build new conditions step by step; edit saved rows without replaying the wizard. */
export class ModelFolderRulesPanel {
	#list = new SelectList([], 12, getSelectListTheme(), { activateOnSpace: false });
	#labelsLocale = getLocale();
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
		if (this.#view === "value") return t("overlaysModel.folderRules.hintValue");
		return t("overlaysModel.folderRules.hint");
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
		this.#labelsLocale = getLocale();
		let rows: SelectItem[];
		const draft = this.#draft;
		switch (this.#view) {
			case "rules":
				rows = this.#clauses.flatMap((clause, group) => [
					...clause.map((condition, index) => ({
						value: `condition:${group}:${index}`,
						label: `${index > 0 ? t("overlaysModel.folderRules.and") : group === 0 ? t("overlaysModel.folderRules.if") : t("overlaysModel.folderRules.or")}  ${attributeLabel(condition.attribute)}`,
						description: `${condition.invert ? t("overlaysModel.folderRules.not") : ""}${condition.operator} ${sanitizeDisplayWarning(condition.value)}`,
					})),
					{ value: `and:${group}`, label: t("overlaysModel.folderRules.addAnd") },
				]);
				rows.push(
					{
						value: "or",
						label: this.#clauses.length
							? t("overlaysModel.folderRules.addOr")
							: t("overlaysModel.folderRules.addFirst"),
					},
					{
						value: "ingest",
						label: t("overlaysModel.folderRules.ingest"),
						description: this.#ingest
							? t("overlaysModel.folderRules.ingestOn")
							: t("overlaysModel.folderRules.off"),
					},
					{ value: "save", label: t("overlaysModel.folderRules.save") },
					{
						value: "run",
						label: t("overlaysModel.folderRules.run"),
						description: t("overlaysModel.folderRules.runDescription"),
						disabled: this.#clauses.length === 0,
					},
					{
						value: "force",
						label: t("overlaysModel.folderRules.force"),
						description: t("overlaysModel.folderRules.forceDescription"),
						confirmation: t("overlaysModel.folderRules.forceConfirmation"),
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
						label: t("overlaysModel.folderRules.attribute"),
						description: attributeLabel(condition.attribute),
					},
					{ value: "operator", label: t("overlaysModel.folderRules.operator"), description: condition.operator },
					{
						value: "value",
						label: t("overlaysModel.folderRules.value"),
						description: sanitizeDisplayWarning(condition.value) || t("overlaysModel.folderRules.required"),
					},
					{
						value: "invert",
						label: t("overlaysModel.folderRules.invert"),
						description: condition.invert
							? t("overlaysModel.folderRules.on")
							: t("overlaysModel.folderRules.off"),
					},
					{ value: "done", label: t("overlaysModel.folderRules.applyCondition") },
				];
				if (this.#clauses[draft.clause]?.[draft.index])
					rows.push({ value: "remove", label: t("overlaysModel.folderRules.removeCondition") });
				break;
			}
			case "attribute":
				rows = (Object.keys(MODEL_FOLDER_ATTRIBUTES) as Attribute[]).map(value => ({
					value,
					label: attributeLabel(value),
				}));
				break;
			case "operator":
				if (!draft) return;
				rows = modelFolderOperators(draft.condition.attribute);
				if (draft.adding)
					rows.unshift({
						value: "invert",
						label: t("overlaysModel.folderRules.invert"),
						description: draft.condition.invert
							? t("overlaysModel.folderRules.on")
							: t("overlaysModel.folderRules.off"),
					});
				break;
			case "value":
				rows = [{ value: "applyValue", label: t("overlaysModel.folderRules.applyValue") }];
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
				return t("overlaysModel.folderRules.panelDescription", { name: sanitizeDisplayWarning(this.name) });
			case "condition":
				return t("overlaysModel.folderRules.editCondition");
			case "attribute":
				return t("overlaysModel.folderRules.chooseAttribute");
			case "operator":
				return t("overlaysModel.folderRules.chooseOperator");
			case "value": {
				const condition = this.#draft?.condition;
				if (!condition) return t("overlaysModel.folderRules.enterValue");
				const label = attributeLabel(condition.attribute);
				const { kind } = MODEL_FOLDER_ATTRIBUTES[condition.attribute];
				if (condition.operator === "~=") return t("overlaysModel.folderRules.regexHint", { label });
				if (condition.operator === "in")
					return t("overlaysModel.folderRules.listHint", {
						label,
						prefix: kind === "text" ? t("overlaysModel.folderRules.listHintText") : "",
					});
				if (condition.operator === "*=") return t("overlaysModel.folderRules.globHint", { label });
				return `${label} · ${kind === "boolean" ? "true or false" : t(`overlaysModel.folderRules.kind.${kind}`)}`;
			}
		}
	}

	render(width: number, rows: number): string[] {
		if (this.#labelsLocale !== getLocale()) this.#rebuild();
		const title =
			theme.bold(t("overlaysModel.folderRules.title")) +
			uiProvenanceSuffix("features", MODEL_FOLDER_RULES_FEATURE, true);
		const lines = [title, this.#heading()];
		if (this.#error) lines.push(theme.fg("error", this.#error));
		else if (this.#notice) lines.push(theme.fg("success", this.#notice));
		if (this.#view === "value") lines.push(...this.#input.render(width));
		this.#listTop = lines.length;
		this.#list.setMaxVisible(Math.max(1, rows - this.#listTop));
		return [...lines.map(line => truncateToWidth(line, width)), ...this.#list.render(width)].slice(0, rows);
	}

	describe(): NativeNode {
		if (this.#labelsLocale !== getLocale()) this.#rebuild();
		return node(
			"col",
			{ gap: "sm", grow: 1 },
			[
				text([
					span(t("overlaysModel.folderRules.title")),
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
