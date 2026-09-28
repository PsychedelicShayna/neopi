import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, THINKING_EFFORTS, type Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts, requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { register } from "./registry";
import { cfgProvidersAutoThinkingMaxEffort } from "../session/settings";
import type { Settings } from "./settings";

/** Only choices without a deliberate caller/manual override are subject to these rules. */
export interface EffortRule {
	selector: string;
	allowed: Effort[];
}

export type EffortSelection =
	| { mode: "fixed"; level: ThinkingLevel }
	| { mode: "auto"; allowed?: Effort[]; selector?: string }
	| { mode: "inherit" };

export type EffortOrigin = "caller" | "manual" | "role" | "fallback" | "inherited" | "default";

function assertEfforts(raw: unknown, label: string): asserts raw is Effort[] {
	if (!Array.isArray(raw) || raw.length === 0 || raw.some(value => !THINKING_EFFORTS.includes(value))) {
		throw new Error(`${label} must contain one or more supported thinking effort names`);
	}
	if (new Set(raw).size !== raw.length) throw new Error(`${label} cannot contain duplicate efforts`);
}

export function validateEffortSelection(raw: unknown): asserts raw is EffortSelection {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("mode" in raw)) {
		throw new Error("Effort selection must specify fixed, auto, or inherit mode");
	}
	if (raw.mode === "inherit") return;
	if (raw.mode === "fixed") {
		if (!("level" in raw) || !Object.values(ThinkingLevel).includes(raw.level as ThinkingLevel)) {
			throw new Error("Fixed effort selection must specify a thinking level");
		}
		return;
	}
	if (raw.mode === "auto") {
		if ("allowed" in raw && raw.allowed !== undefined) assertEfforts(raw.allowed, "Auto allowed efforts");
		if (
			"selector" in raw &&
			raw.selector !== undefined &&
			(typeof raw.selector !== "string" || !raw.selector.trim())
		) {
			throw new Error("Auto effort selector must name its model");
		}
		return;
	}
	throw new Error("Unknown effort selection mode");
}

export const cfgEffortPolicyMode = register({
	id: "effort.mode",
	type: "enum",
	values: ["replacement", "legacy"] as const,
	default: "replacement",
	ui: {
		tab: "model",
		group: "Thinking",
		label: "Effort Policy",
		description: "Replacement implicit effort sets or legacy coarse subagent hints",
		options: [
			{
				value: "replacement",
				label: "Configurable Effort",
				description: "Choose permitted implicit efforts for models and roles",
			},
			{
				value: "legacy",
				label: "Legacy Hints",
				description: "Use coarse lo/med/hi subagent hints and the old effort ceiling",
			},
		],
	},
});

export const cfgEffortRules = register({
	id: "effort.rules",
	type: "array",
	default: [] as EffortRule[],
	validate(raw) {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error("Effort rules must be an ordered list");
		const seen = new Set<string>();
		for (const rule of raw) {
			if (
				!rule ||
				typeof rule !== "object" ||
				Array.isArray(rule) ||
				typeof rule.selector !== "string" ||
				!rule.selector.trim()
			) {
				throw new Error("Each effort rule must name a model selector");
			}
			const slash = rule.selector.indexOf("/");
			if (slash < 1 || slash === rule.selector.length - 1) {
				throw new Error(`Effort rule ${rule.selector} must use a provider/model selector`);
			}
			if (seen.has(rule.selector.toLowerCase())) throw new Error(`Duplicate effort rule ${rule.selector}`);
			seen.add(rule.selector.toLowerCase());
			assertEfforts(rule.allowed, `Effort rule ${rule.selector}`);
			if (isPatternSelector(rule.selector)) new Bun.Glob(rule.selector);
		}
	},
});

export const cfgRoleEffortSelections = register({
	id: "roleEffortSelections",
	type: "record",
	default: {} as Record<string, EffortSelection>,
	validate(raw) {
		if (raw === undefined) return;
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error("Role effort selections must be a record");
		for (const [role, value] of Object.entries(raw)) {
			if (!role.trim()) throw new Error("Role effort selection must name a role");
			validateEffortSelection(value);
		}
	},
});

export const cfgFallbackEffortSelections = register({
	id: "retry.fallbackEffortSelections",
	type: "record",
	default: {} as Record<string, Record<string, EffortSelection>>,
	validate(raw) {
		if (raw === undefined) return;
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error("Fallback effort selections must be a record");
		for (const [chain, entries] of Object.entries(raw)) {
			if (!chain.trim() || !entries || typeof entries !== "object" || Array.isArray(entries))
				throw new Error("Fallback effort chain must name a selector");
			for (const [selector, selection] of Object.entries(entries)) {
				if (!selector.trim()) throw new Error("Fallback effort entry must name a selector");
				validateEffortSelection(selection);
			}
		}
	},
});

export class EffortPolicyError extends Error {
	readonly model: string;
	readonly supported: readonly Effort[];
	readonly permitted: readonly Effort[];
	readonly selector: string | undefined;
	readonly alternatives: readonly string[];
	readonly requested?: string;
	readonly origin?: EffortOrigin;
	constructor(
		model: Model,
		supported: readonly Effort[],
		permitted: readonly Effort[],
		selector?: string,
		alternatives: readonly string[] = [],
		requested?: string,
		origin?: EffortOrigin,
	) {
		const identity = `${model.provider}/${model.id}`;
		super(
			`No permitted effort for ${identity}${requested ? ` requested as ${requested}` : ""}${selector ? ` (rule ${selector})` : ""}. Supported: ${supported.join(", ") || "none"}; permitted: ${permitted.join(", ") || "none"}${alternatives.length ? `; alternatives: ${alternatives.join(", ")}` : "; retry with an explicit supported effort or change the model's permitted set"}`,
		);
		this.name = "EffortPolicyError";
		this.model = identity;
		this.supported = supported;
		this.permitted = permitted;
		this.selector = selector;
		this.alternatives = alternatives;
		this.requested = requested;
		this.origin = origin;
	}
}

function isPatternSelector(selector: string): boolean {
	return /[*?[\]{}]/.test(selector);
}

/** Exact provider/model identifiers beat all wildcard rules; wildcard rules retain operator order. */
export function matchEffortRule(settings: Settings, model: Model): EffortRule | undefined {
	const rules = cfgEffortRules.get(settings);
	const identity = `${model.provider}/${model.id}`.toLowerCase();
	const exact = rules.find(rule => !isPatternSelector(rule.selector) && rule.selector.toLowerCase() === identity);
	if (exact) return exact;
	return rules.find(
		rule => isPatternSelector(rule.selector) && new Bun.Glob(rule.selector.toLowerCase()).match(identity),
	);
}

export interface EffortDecision {
	level: ThinkingLevel | undefined;
	candidates: Effort[];
	disclosure?: string;
	rule?: EffortRule;
	origin: EffortOrigin;
}

/** Resolve at the final model boundary; never promote saved defaults to caller overrides. */
export function resolveImplicitEffort(
	settings: Settings,
	model: Model,
	selection?: EffortSelection,
	origin: EffortOrigin = "default",
	options?: { alternatives?: readonly string[] },
): EffortDecision {
	const modelEfforts = getSupportedEfforts(model);
	const supported = THINKING_EFFORTS.filter(effort => modelEfforts.includes(effort));
	const rule = cfgEffortPolicyMode.get(settings) === "replacement" ? matchEffortRule(settings, model) : undefined;
	const explicitFixed =
		selection?.mode === "fixed" &&
		selection.level !== ThinkingLevel.Inherit &&
		(origin === "caller" || origin === "manual");
	const permitted = supported.filter(effort => explicitFixed || !rule || rule.allowed.includes(effort));
	const staleAuto =
		selection?.mode === "auto" &&
		selection.selector &&
		(isPatternSelector(selection.selector)
			? !new Bun.Glob(selection.selector.toLowerCase()).match(`${model.provider}/${model.id}`.toLowerCase())
			: selection.selector.toLowerCase() !== `${model.provider}/${model.id}`.toLowerCase());
	const activeSelection = staleAuto ? { mode: "auto" as const } : selection;
	if (activeSelection?.mode === "fixed" && activeSelection.level === ThinkingLevel.Off) {
		return { level: ThinkingLevel.Off, candidates: permitted, rule, origin };
	}
	// An implicit selection on a model without a controllable effort surface has
	// no effort to request. A caller's concrete effort still needs capability validation.
	if (supported.length === 0 && !explicitFixed) {
		return { level: undefined, candidates: [], rule, origin };
	}
	if (
		activeSelection?.mode === "inherit" ||
		(activeSelection?.mode === "fixed" && activeSelection.level === ThinkingLevel.Inherit)
	) {
		if (permitted.length === 0) {
			throw new EffortPolicyError(
				model,
				supported,
				permitted,
				rule?.selector,
				options?.alternatives,
				undefined,
				origin,
			);
		}
		return { level: undefined, candidates: permitted, rule, origin };
	}
	if (activeSelection?.mode === "fixed" && (origin === "caller" || origin === "manual")) {
		if (activeSelection.level !== ThinkingLevel.Inherit)
			requireSupportedEffort(model, activeSelection.level as Effort);
		return { level: activeSelection.level, candidates: [...supported], origin };
	}
	const savedAuto = activeSelection?.mode === "auto" ? activeSelection.allowed : undefined;
	const authoredLegacyAutoCeiling =
		activeSelection?.mode === "auto" &&
		savedAuto === undefined &&
		settings.getProvenance(cfgProvidersAutoThinkingMaxEffort) !== "default"
			? cfgProvidersAutoThinkingMaxEffort.get(settings)
			: undefined;
	const candidates =
		activeSelection?.mode === "auto"
			? permitted.filter(effort =>
					savedAuto
						? savedAuto.includes(effort)
						: authoredLegacyAutoCeiling
							? authoredLegacyAutoCeiling === "max" ||
								THINKING_EFFORTS.indexOf(effort) <= THINKING_EFFORTS.indexOf(Effort.XHigh)
							: true,
				)
			: permitted;
	if (candidates.length === 0)
		throw new EffortPolicyError(
			model,
			supported,
			candidates,
			rule?.selector,
			options?.alternatives,
			undefined,
			origin,
		);
	if (activeSelection?.mode === "auto")
		return {
			level: undefined,
			candidates,
			rule,
			origin,
			disclosure:
				staleAuto && selection?.mode === "auto"
					? `Saved Auto efforts for ${selection.selector} were not applied to ${model.provider}/${model.id}; edit this model's Auto set to save new choices.`
					: undefined,
		};
	const requested = activeSelection?.mode === "fixed" ? (activeSelection.level as Effort) : undefined;
	if (!requested) return { level: undefined, candidates, rule, origin };
	const index = THINKING_EFFORTS.indexOf(requested);
	const level = [...candidates].reverse().find(effort => THINKING_EFFORTS.indexOf(effort) <= index) ?? candidates[0];
	return {
		level,
		candidates,
		rule,
		origin,
		disclosure:
			level === requested
				? undefined
				: `Implicit effort ${requested} adjusted to ${level} for ${model.provider}/${model.id}${rule ? ` by rule ${rule.selector}` : " (model capability)"}.`,
	};
}
