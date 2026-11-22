import type { Model } from "@oh-my-pi/pi-ai";
import { getEffectiveTokenCost, getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import type { ModelBrowserPerf } from "./model-browser";
import { ModelPerformanceLookup } from "./model-performance";

export const MODEL_FOLDER_ATTRIBUTES = {
	slug: { label: "Slug", kind: "text" },
	provider: { label: "Provider", kind: "text" },
	contextWindow: { label: "Context window", kind: "number" },
	maxOutput: { label: "Max output", kind: "number" },
	inputPrice: { label: "Input price ($/M)", kind: "number" },
	outputPrice: { label: "Output price ($/M)", kind: "number" },
	intelligence: { label: "Intelligence", kind: "number" },
	tps: { label: "TPS", kind: "number" },
	ttftMs: { label: "Measured TTFT (ms)", kind: "number" },
	reasoning: { label: "Reasoning", kind: "boolean" },
	vision: { label: "Vision", kind: "boolean" },
} as const;

type Attribute = keyof typeof MODEL_FOLDER_ATTRIBUTES;
const OPERATORS = {
	">=": "At least",
	"<=": "At most",
	">": "Greater than",
	"<": "Less than",
	"==": "Equals",
	"!=": "Does not equal",
	"~=": "Case-insensitive regex",
	in: "Contains text or belongs to a comma-separated list",
	"*=": "Glob",
} as const;
type Operator = keyof typeof OPERATORS;

export interface ModelFolderCondition {
	readonly attribute: Attribute;
	readonly operator: Operator;
	readonly value: string;
	readonly invert?: boolean;
}

export interface ModelFolderRules {
	readonly clauses: readonly (readonly ModelFolderCondition[])[];
	readonly ingest: boolean;
}

type Scalar = string | number | boolean;
type Fact = Scalar | null | undefined;
export type ModelFolderFacts = { readonly [K in Attribute]?: Fact };

export function modelFolderOperators(attribute: Attribute): { value: Operator; label: string }[] {
	return (Object.keys(OPERATORS) as Operator[])
		.filter(operator => allowsOperator(attribute, operator))
		.map(value => ({ value, label: `${value}  ${OPERATORS[value]}` }));
}

function allowsOperator(attribute: Attribute, operator: Operator): boolean {
	const kind = MODEL_FOLDER_ATTRIBUTES[attribute].kind;
	switch (operator) {
		case ">=":
		case "<=":
		case ">":
		case "<":
			return kind === "number";
		case "~=":
		case "*=":
			return kind === "text";
		default:
			return true;
	}
}

function decodeValue(value: string, kind: "text" | "number" | "boolean"): Scalar {
	const text = value.trim();
	if (!text) throw new Error("Enter a comparison value.");
	if (kind === "text") return text.toLowerCase();
	if (kind === "boolean") {
		if (text === "true") return true;
		if (text === "false") return false;
		throw new Error("Enter true or false.");
	}
	const number = Number(text);
	if (!Number.isFinite(number)) throw new Error("Enter a finite number.");
	return number;
}

function compileComparison(condition: ModelFolderCondition): (fact: Scalar) => boolean {
	const { attribute, operator, value } = condition;
	const kind = MODEL_FOLDER_ATTRIBUTES[attribute].kind;
	if (!allowsOperator(attribute, operator)) throw new Error(`Operator ${operator} cannot compare ${kind} values.`);
	if (operator === "~=") {
		if (!value.trim()) throw new Error("Enter a regular expression.");
		let regex: RegExp;
		try {
			regex = new RegExp(value, "i");
		} catch {
			throw new Error("Invalid regular expression.");
		}
		return fact => typeof fact === "string" && regex.test(fact);
	}
	if (operator === "in" && (kind !== "text" || value.includes(","))) {
		const options = new Set(value.split(",").map(item => decodeValue(item, kind)));
		return fact => options.has(fact);
	}
	const expected = decodeValue(value, kind);
	switch (operator) {
		case ">=":
			return fact => typeof fact === "number" && typeof expected === "number" && fact >= expected;
		case "<=":
			return fact => typeof fact === "number" && typeof expected === "number" && fact <= expected;
		case ">":
			return fact => typeof fact === "number" && typeof expected === "number" && fact > expected;
		case "<":
			return fact => typeof fact === "number" && typeof expected === "number" && fact < expected;
		case "==":
			return fact => fact === expected;
		case "!=":
			return fact => fact !== expected;
		case "in":
			return fact => typeof fact === "string" && typeof expected === "string" && fact.includes(expected);
		case "*=": {
			const glob = new Bun.Glob(String(expected));
			return fact => typeof fact === "string" && glob.match(fact);
		}
	}
}

function compileCondition(condition: ModelFolderCondition): (facts: ModelFolderFacts) => boolean {
	const { attribute, invert } = condition;
	const kind = MODEL_FOLDER_ATTRIBUTES[attribute].kind;
	const compare = compileComparison(condition);
	return facts => {
		const fact = facts[attribute];
		if (fact == null || (typeof fact === "number" && !Number.isFinite(fact))) return false;
		if (kind === "text" ? typeof fact !== "string" : typeof fact !== kind) return false;
		return compare(typeof fact === "string" && condition.operator !== "~=" ? fact.toLowerCase() : fact) !== !!invert;
	};
}

export function compileModelFolderRules(clauses: ModelFolderRules["clauses"]): (facts: ModelFolderFacts) => boolean {
	const tests = clauses.map(clause => clause.map(compileCondition));
	return facts => tests.some(clause => clause.length > 0 && clause.every(test => test(facts)));
}

/** Validate persisted data and use the same compiler as the editor and evaluator. */
export function validateModelFolderRules(raw: unknown): void {
	if (
		!raw ||
		typeof raw !== "object" ||
		!("ingest" in raw) ||
		typeof raw.ingest !== "boolean" ||
		!("clauses" in raw) ||
		!Array.isArray(raw.clauses)
	) {
		throw new Error("Folder rules need an ingest toggle and a list of clauses.");
	}
	for (const clause of raw.clauses as unknown[]) {
		if (!Array.isArray(clause) || clause.length === 0) throw new Error("Each folder rule clause needs a condition.");
		for (const condition of clause as unknown[]) {
			if (
				!condition ||
				typeof condition !== "object" ||
				!("attribute" in condition) ||
				typeof condition.attribute !== "string" ||
				!Object.hasOwn(MODEL_FOLDER_ATTRIBUTES, condition.attribute) ||
				!("operator" in condition) ||
				typeof condition.operator !== "string" ||
				!Object.hasOwn(OPERATORS, condition.operator) ||
				!("value" in condition) ||
				typeof condition.value !== "string" ||
				("invert" in condition && condition.invert !== undefined && typeof condition.invert !== "boolean")
			)
				throw new Error("Each folder condition needs an attribute, operator, and value.");
			compileComparison(condition as ModelFolderCondition);
		}
	}
}

/** One pass over the landed catalogue; no auth, picker scope, or network lookups. */
export function createModelFolderMatcher(
	perf: () => ReadonlyMap<string, ModelBrowserPerf> | undefined,
): (
	rules: ModelFolderRules,
	models: readonly Model[],
	existing: readonly string[],
	force?: boolean,
) => readonly string[] {
	let performance: ModelPerformanceLookup | undefined;
	return (rules, models, existing, force = false) => {
		if (rules.clauses.length === 0) return existing;
		const match = compileModelFolderRules(rules.clauses);
		const usesPerf = rules.clauses.some(clause =>
			clause.some(({ attribute }) => attribute === "tps" || attribute === "ttftMs"),
		);
		const usesPrice = rules.clauses.some(clause =>
			clause.some(({ attribute }) => attribute === "inputPrice" || attribute === "outputPrice"),
		);
		if (usesPerf && !performance) performance = new ModelPerformanceLookup(perf());
		const members = new Set(force ? [] : existing);
		const initialSize = members.size;
		for (const model of models) {
			const slug = `${model.provider}/${model.id}`;
			if (members.has(slug)) continue;
			const measured = usesPerf ? performance?.get(slug)?.perf : undefined;
			const status = usesPrice ? getModelPricingStatus(model) : undefined;
			const cost = status === "fixed" || status === "free" ? getEffectiveTokenCost(model.cost) : undefined;
			if (
				match({
					slug,
					provider: model.provider,
					contextWindow: model.discoveryMissingContextWindow ? undefined : model.contextWindow,
					maxOutput: model.discoveryMissingMaxTokens ? undefined : model.maxTokens,
					inputPrice: cost?.input,
					outputPrice: cost?.output,
					intelligence: model.int,
					tps: measured?.tps ?? (model.tps != null && model.tps > 0 ? model.tps : undefined),
					ttftMs: measured?.ttftMs,
					reasoning: model.discoveryMissingReasoningEffort && !model.reasoning ? undefined : model.reasoning,
					vision: model.discoveryMissingInput ? undefined : model.input.includes("image"),
				})
			)
				members.add(slug);
		}
		if (!force) return members.size === initialSize ? existing : [...members];
		// Preserve existing order for retained members, even during force apply.
		const next = [...existing.filter(selector => members.delete(selector)), ...members];
		return next.length === existing.length && next.every((selector, index) => selector === existing[index])
			? existing
			: next;
	};
}
