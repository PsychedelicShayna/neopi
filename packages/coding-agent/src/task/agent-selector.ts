/**
 * Model-selector interpretation for the subagent `agent` field.
 *
 * The task tool and the eval kernel's `agent()` bridge accept, besides a
 * registered agent name, a direct model selector:
 *
 *     <provider/model>[:<effort>]   e.g. openai-codex/gpt-5.6-sol:high
 *     @<role>[:<effort>]            e.g. @smol:low
 *
 * A selector spawns the generic `task` agent crewed with exactly that model
 * and thinking level; an omitted `:<effort>` leaves the model on its default
 * (`auto`) selector. Registered agent names always win: interpretation only
 * begins after agent discovery misses. Detection is shape-based — the string
 * contains a `/`, starts with `@`, or carries a trailing `:<effort>` suffix
 * that parses as a thinking level.
 *
 * Validation is deliberately loud. An unresolvable selector is a preflight
 * error naming the bad part (unknown model vs unsupported effort vs missing
 * credentials) plus the nearest valid alternatives — never a silent fallback
 * to the default crew.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveModelOverride } from "../config/model-resolver";
import { getKnownRoleIds } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { parseSelectorSuffix } from "../config/model-selector-suffix";
import { type ConfiguredThinkingLevel, concreteThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { editDistance } from "../utils/edit-distance";

/** The registry surfaces selector validation needs; tests can stub them. */
export type AgentSelectorModelRegistry = Pick<ModelRegistry, "getAvailable" | "hasConfiguredAuth">;

/** Loud selector-validation failure; adapters wrap it into their own preflight error surface. */
export class AgentSelectorError extends Error {}

/**
 * True when an `agent` value is shaped like a model selector rather than an
 * agent name. Callers MUST try registered-agent lookup first: a registered
 * name always wins over selector interpretation.
 */
export function isAgentModelSelector(value: string): boolean {
	if (value.includes("/")) return true;
	if (value.startsWith("@")) return true;
	return parseSelectorSuffix(value) !== undefined;
}

/**
 * Split `<agent-name>:<effort>` into a registered-agent base and an explicit
 * thinking level. Returns undefined for model selectors (`/`, `@`) and values
 * without a recognized effort suffix. Callers MUST try the exact full value
 * as a registered name first, and only use this split when that lookup misses.
 */
export function splitNamedAgentSelector(value: string): { base: string; level: ConfiguredThinkingLevel } | undefined {
	if (value.includes("/") || value.startsWith("@")) return undefined;
	return parseSelectorSuffix(value);
}

/**
 * Reject an explicit `<agent-name>:<effort>` level that the agent's own resolved
 * model cannot honor. The error names the agent and its model, never a model
 * fuzzy-matched from the agent name. Unresolvable patterns defer to the executor.
 */
export function validateNamedAgentEffort(
	selector: string,
	agentName: string,
	level: ConfiguredThinkingLevel,
	modelPatterns: readonly string[],
	modelRegistry: AgentSelectorModelRegistry | undefined,
	settings: Settings,
): void {
	if (!modelRegistry || modelPatterns.length === 0) return;
	if (modelRegistry.getAvailable().length === 0) return;
	const resolved = resolveModelOverride([...modelPatterns], modelRegistry, settings);
	if (!resolved.model) return;
	const concrete = concreteThinkingLevel(level);
	if (concrete === undefined || concrete === ThinkingLevel.Off) return;
	const effort = toReasoningEffort(concrete);
	if (effort === undefined || getSupportedEfforts(resolved.model).includes(effort)) return;
	throw new AgentSelectorError(
		`Unsupported effort ":${concrete}" in agent selector "${selector}": agent "${agentName}" runs ${formatModelString(resolved.model)}. ${supportedEffortsText(resolved.model)}`,
	);
}

/**
 * Validate a selector-shaped `agent` value against the live model catalog.
 *
 * Resolution reuses the session model-pattern grammar (`resolveModelOverride`),
 * so globs, `@role` expansion, and the `:max`/`:auto` literal-id guards behave
 * exactly like every other model-selector surface. Throws
 * {@link AgentSelectorError} naming the failing part and the nearest valid
 * alternatives. A missing or not-yet-populated registry defers resolution to
 * the executor instead of failing a potentially valid selector on missing data.
 */
export function validateAgentModelSelector(
	selector: string,
	modelRegistry: AgentSelectorModelRegistry | undefined,
	settings: Settings,
): void {
	if (!modelRegistry) return;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return;

	// Check the REQUESTED suffix from our own parse: the pattern grammar clamps
	// an out-of-range level to the model's nearest supported one and drops an
	// unparseable token with only a warning — both are silent fallbacks the
	// selector contract forbids.
	const suffix = parseSelectorSuffix(selector);
	const colonIdx = selector.lastIndexOf(":");
	const rawToken = colonIdx > 0 && colonIdx < selector.length - 1 ? selector.slice(colonIdx + 1) : undefined;

	const resolved = resolveModelOverride([selector], modelRegistry, settings);
	if (resolved.model) {
		if (suffix !== undefined) {
			assertEffortSupported(selector, resolved.model, suffix.level);
		} else if (resolved.warning !== undefined && rawToken !== undefined && !rawToken.includes("/")) {
			// Resolved only because the grammar discarded an invalid trailing
			// token (literal ids containing ":" match exactly and warn-free).
			throw new AgentSelectorError(
				`Unsupported effort ":${rawToken}" in agent selector "${selector}". ${supportedEffortsText(resolved.model)}`,
			);
		}
		if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			const authed = nearestModels(
				selector,
				available.filter(candidate => modelRegistry.hasConfiguredAuth(candidate)),
			);
			throw new AgentSelectorError(
				`Model "${formatModelString(resolved.model)}" from agent selector "${selector}" has no configured credentials.${
					authed.length > 0 ? ` Authenticated alternatives: ${authed.join(", ")}.` : ""
				}`,
			);
		}
		return;
	}

	// Unresolved: decompose to name the failing part. A trailing token that is
	// not a recognized effort, on a base that DOES resolve, is a bad effort.
	if (suffix === undefined && rawToken !== undefined) {
		const base = selector.slice(0, colonIdx);
		const token = selector.slice(colonIdx + 1);
		const baseResolved = resolveModelOverride([base], modelRegistry, settings);
		if (baseResolved.model) {
			throw new AgentSelectorError(
				`Unsupported effort ":${token}" in agent selector "${selector}". ${supportedEffortsText(baseResolved.model)}`,
			);
		}
	}
	const base = suffix?.base ?? selector;
	if (base.startsWith("@")) {
		const roles = getKnownRoleIds(settings)
			.map(role => `@${role}`)
			.join(", ");
		throw new AgentSelectorError(
			`Unknown model role "${base}" in agent selector "${selector}". Known roles: ${roles}.`,
		);
	}
	const nearest = nearestModels(base, available);
	throw new AgentSelectorError(
		`Unknown model "${base}" in agent selector "${selector}".${
			nearest.length > 0 ? ` Nearest available: ${nearest.join(", ")}.` : ""
		}`,
	);
}

/** Reject a fixed explicit level the resolved model cannot honor. Auto and off need no wire effort. */
function assertEffortSupported(selector: string, model: Model<Api>, level: ConfiguredThinkingLevel | undefined): void {
	const concrete = concreteThinkingLevel(level);
	if (concrete === undefined || concrete === ThinkingLevel.Off) return;
	const effort = toReasoningEffort(concrete);
	if (effort === undefined) return;
	if (getSupportedEfforts(model).includes(effort)) return;
	throw new AgentSelectorError(
		`Unsupported effort ":${concrete}" in agent selector "${selector}". ${supportedEffortsText(model)}`,
	);
}

function supportedEffortsText(model: Model<Api>): string {
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) {
		return `${formatModelString(model)} has no controllable thinking effort; omit the ":<effort>" suffix or use ":auto".`;
	}
	return `${formatModelString(model)} supports: ${supported.join(", ")} (plus "auto" and "off").`;
}

/** Up to `limit` catalog entries closest to `input` by edit distance over `provider/id` and bare `id`. */
function nearestModels(input: string, available: readonly Model<Api>[], limit = 3): string[] {
	const needle = input.toLowerCase();
	const scored = available.map(model => {
		const full = formatModelString(model);
		const score = Math.min(editDistance(needle, full.toLowerCase()), editDistance(needle, model.id.toLowerCase()));
		return { full, score };
	});
	scored.sort((a, b) => a.score - b.score || a.full.localeCompare(b.full));
	// A ceiling keeps absurd suggestions out when nothing is remotely close.
	const ceiling = Math.max(needle.length, 8);
	return scored
		.filter(entry => entry.score <= ceiling)
		.slice(0, limit)
		.map(entry => entry.full);
}

