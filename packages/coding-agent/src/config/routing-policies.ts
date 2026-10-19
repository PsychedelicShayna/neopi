import { THINKING_EFFORTS, type Effort } from "@oh-my-pi/pi-catalog/effort";
import { isRecord } from "@oh-my-pi/pi-utils";
import { parseSelectorSuffix } from "./model-selector-suffix";
import { register } from "./registry";
import type { Settings } from "./settings";

/** Reusable routing templates, not assignment lifecycle records or retry chains. */
export interface RoutingPolicySlot {
	model: string;
	effort?: `${Effort}`;
	boundary: string;
	/** Specialist hull; omitted slots use the session's normal default agent. */
	agent?: string;
}

export interface RoutingPolicy {
	slots: Record<string, RoutingPolicySlot>;
}

const EMPTY_ROUTING_POLICIES: Record<string, RoutingPolicy> = {};

/** Operator-declared workflow templates, separate from model roles and retry fallbacks. */
export const cfgRoutingPolicies = register({
	id: "routingPolicies",
	type: "record",
	default: EMPTY_ROUTING_POLICIES,
	validate: validateRoutingPolicies,
});

/** Fields the assignment owner may supply; existing values always win. */
export interface RoutingPolicyFields {
	policy?: string;
	slot?: string;
	model?: string | string[];
	effort?: string;
	boundary?: string;
	agent?: string;
}

const NAME = /^[A-Za-z0-9_-]+$/;

export function validateRoutingPolicies(value: unknown): void {
	if (value === undefined || value === null) return;
	if (!isRecord(value)) throw new Error("routingPolicies must be a named map");
	for (const [name, policy] of Object.entries(value)) {
		if (!NAME.test(name) || !isRecord(policy) || !isRecord(policy.slots) || !Object.keys(policy.slots).length) {
			throw new Error(`routingPolicies.${name} requires a stable name and at least one slot`);
		}
		for (const [slotName, slot] of Object.entries(policy.slots)) {
			const label = `routingPolicies.${name}.slots.${slotName}`;
			if (!NAME.test(slotName) || !isRecord(slot)) throw new Error(`${label} is not a named slot`);
			if (typeof slot.model !== "string" || !slot.model.trim()) throw new Error(`${label}.model is required`);
			if (typeof slot.boundary !== "string" || !slot.boundary.trim()) throw new Error(`${label}.boundary is required`);
			const suffix = parseSelectorSuffix(slot.model);
			const effort = slot.effort ?? (suffix ? slot.model.slice(slot.model.lastIndexOf(":") + 1) : undefined);
			if (!THINKING_EFFORTS.some(candidate => candidate === effort)) {
				throw new Error(`${label} requires an explicit effort (minimal, low, medium, high, xhigh, max)`);
			}
			if (suffix && slot.effort !== undefined && slot.model.slice(slot.model.lastIndexOf(":") + 1) !== slot.effort) {
				throw new Error(`${label} has conflicting model suffix and effort`);
			}
			if (slot.agent !== undefined && (typeof slot.agent !== "string" || !NAME.test(slot.agent))) {
				throw new Error(`${label}.agent must name a registered specialist`);
			}
		}
	}
}

/** Copy only missing fields. No shared references survive into a delivered assignment. */
export function fillRoutingPolicy<T extends RoutingPolicyFields>(settings: Settings, fields: T): T & RoutingPolicyFields {
	const result: T & RoutingPolicyFields = structuredClone(fields);
	if (fields.policy === undefined) return result;
	const policies = cfgRoutingPolicies.get(settings);
	validateRoutingPolicies(policies);
	const policy = Object.hasOwn(policies, fields.policy) ? policies[fields.policy] : undefined;
	if (!policy) throw new Error(`Unknown routing policy "${fields.policy}". Declare it in routingPolicies first.`);
	const slotName = fields.slot ?? (Object.keys(policy.slots).length === 1 ? Object.keys(policy.slots)[0] : undefined);
	if (!slotName) throw new Error(`Routing policy "${fields.policy}" requires a slot: ${Object.keys(policy.slots).join(", ")}`);
	const slot = Object.hasOwn(policy.slots, slotName) ? policy.slots[slotName] : undefined;
	if (!slot) throw new Error(`Unknown slot "${slotName}" in routing policy "${fields.policy}".`);
	const suffix = parseSelectorSuffix(slot.model);
	result.slot ??= slotName;
	result.model ??= suffix?.base ?? slot.model;
	result.effort ??= slot.effort ?? slot.model.slice(slot.model.lastIndexOf(":") + 1);
	result.boundary ??= slot.boundary;
	result.agent ??= slot.agent;
	return result;
}

/** Explicit task/eval selector; never infer a policy from a model role or prose. */
export function parseRoutingPolicySelector(selector: string): { policy: string; slot?: string } | undefined {
	if (!selector.startsWith("policy:")) return undefined;
	const match = /^policy:([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(selector);
	if (!match) throw new Error(`Invalid routing selector "${selector}". Use policy:<name>/<slot>.`);
	return { policy: match[1]!, ...(match[2] ? { slot: match[2] } : {}) };
}
