/**
 * `validateMixture`: structural rules over a resolved mixture, run at
 * registration and at save. Errors make a mixture unregisterable and block a
 * save; warnings are reported and never block. The capability gate rejects
 * features this build does not implement yet, so "valid" and "runnable" stay
 * the same set at every milestone.
 */
import {
	isFanoutEdge,
	type MixtureDefinition,
	type MixtureEdge,
	mixtureEdgeId,
	TRANSIT_PART_NAMES,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { Settings } from "../config/settings";
import { DEFAULT_EDGE_ENVELOPE, type EnvelopeContext, isInlineTemplate, renderEnvelope } from "./envelopes";
import { cfgMoaHardMaxHops } from "./settings";
import type { MixtureIssue, ResolvedMixture } from "./types";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const KNOWN_PARTS = new Set<string>(TRANSIT_PART_NAMES);
/** The milestone this build implements; the gate names the one that adds a feature. */
const IMPLEMENTED_MILESTONE = "M1";

export interface ValidateMixtureContext {
	/** The settings the mixture runs under: `moa.hard_max_hops` bounds `limits.max_hops`. */
	settings: Settings;
	/** Every mixture name in the merged roster (or the document being saved), including this one. */
	names?: readonly string[];
}

export interface MixtureValidation {
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
}

const SAMPLE_CONTEXT: EnvelopeContext = {
	mixture: { name: "sample", member_count: 2, members: [] },
	topic: "sample",
	conversation: "",
	from: { id: "a", model: "p/m" },
	to: { id: "b", model: "p/m" },
	edge: { id: "a->b", traversal: 1 },
	hop: 1,
	x: { output: "sample" },
};

function snakeToPart(name: string): string {
	return name === "tool_trace" ? "toolTrace" : name;
}

/** Parts an envelope template reads through `x.<part>`, as transit part names. */
function referencedParts(template: string): string[] {
	const parts = new Set<string>();
	for (const match of template.matchAll(/\bx\.([a-z_]+)/g)) parts.add(snakeToPart(match[1]!));
	return [...parts];
}

function declaredParts(edge: MixtureEdge): string[] {
	return Object.keys(edge.x).filter(part => KNOWN_PARTS.has(part));
}

function outgoing(definition: MixtureDefinition, memberId: string): MixtureEdge[] {
	return definition.edges.filter(edge => edge.from === memberId);
}

function edgeTargets(edge: MixtureEdge): string[] {
	return isFanoutEdge(edge) ? [...edge.to, edge.join].filter(Boolean) : [edge.to];
}

function hasCycle(definition: MixtureDefinition): boolean {
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string): boolean => {
		const current = state.get(id);
		if (current === "visiting") return true;
		if (current === "done") return false;
		state.set(id, "visiting");
		for (const edge of outgoing(definition, id)) {
			for (const target of edgeTargets(edge)) if (visit(target)) return true;
		}
		state.set(id, "done");
		return false;
	};
	return definition.members.some(member => visit(member.id));
}

function capabilityGate(resolved: ResolvedMixture, errors: MixtureIssue[]): void {
	const definition = resolved.definition;
	const gate = (path: string, feature: string, milestone: string) =>
		errors.push({
			code: "unsupported.feature",
			path,
			message: `${feature} arrives with ${milestone}; this build implements ${IMPLEMENTED_MILESTONE}`,
		});
	definition.members.forEach((member, index) => {
		const path = `members[${index}]`;
		if (member.kind === "verdict") {
			gate(path, `verdict member ${member.id}`, "M2");
			return;
		}
		if (member.route) gate(`${path}.route`, `route on member ${member.id}`, "M2");
		if (member.terminate) gate(`${path}.terminate`, `terminate on member ${member.id}`, "M2");
		const resolvedMember = resolved.members[member.id];
		if (resolvedMember?.kind === "model" && resolvedMember.toolPolicy !== false) {
			gate(`${path}.tools`, `tools on member ${member.id} (set tools = false)`, "M3");
		}
		if (outgoing(definition, member.id).length > 1) {
			gate(path, `more than one outgoing edge from ${member.id} (routing)`, "M2");
		}
	});
	definition.edges.forEach((edge, index) => {
		const path = `edges[${index}]`;
		const id = mixtureEdgeId(edge);
		if (isFanoutEdge(edge)) gate(path, `fan-out edge ${id}`, "M4");
		if (edge.x.transcript) gate(`${path}.x.transcript`, `x.transcript on edge ${id}`, "M2");
		if (edge.x.toolTrace) gate(`${path}.x.tool_trace`, `x.tool_trace on edge ${id}`, "M2");
		if (edge.maxTraversals !== undefined) gate(`${path}.max_traversals`, `max_traversals on edge ${id}`, "M2");
	});
	if (hasCycle(definition)) gate("edges", "back-edges (cycles)", "M2");
	if (definition.steering) gate("steering", "steering targets", "M3");
	const limits = definition.limits;
	if (limits) {
		if (limits.budgetUsd !== undefined) gate("limits.budget_usd", "limits.budget_usd", "M2");
		if (limits.wallClockMinutes !== undefined) gate("limits.wall_clock_minutes", "limits.wall_clock_minutes", "M2");
		if (limits.onLimit !== undefined) gate("limits.on_limit", "limits.on_limit", "M2");
		if (limits.limitTarget !== undefined) gate("limits.limit_target", "limits.limit_target", "M2");
	}
	if (definition.serve) gate("serve", "serving a mixture through the auth-gateway", "M6");
}

function templateIssues(template: string, path: string, errors: MixtureIssue[]): boolean {
	try {
		renderEnvelope(template, SAMPLE_CONTEXT);
		return true;
	} catch (error) {
		errors.push({
			code: "edge.envelope.compile",
			path,
			message: `envelope does not compile: ${error instanceof Error ? error.message : String(error)}`,
		});
		return false;
	}
}

export function validateMixture(resolved: ResolvedMixture, ctx: ValidateMixtureContext): MixtureValidation {
	const definition = resolved.definition;
	const errors: MixtureIssue[] = [...resolved.issues];
	const warnings: MixtureIssue[] = [];
	const memberIds = new Set(definition.members.map(member => member.id));

	// E1
	if (!NAME_PATTERN.test(definition.name)) {
		errors.push({
			code: "name.invalid",
			path: "name",
			message: `mixture name "${definition.name}" must match [a-z0-9][a-z0-9._-]*`,
		});
	}
	if ((ctx.names ?? []).filter(name => name === definition.name).length > 1) {
		errors.push({ code: "name.duplicate", path: "name", message: `mixture name "${definition.name}" is not unique` });
	}

	// E3
	if (definition.members.length === 0) {
		errors.push({ code: "members.empty", path: "members", message: "a mixture needs at least one member" });
	}
	const seenIds = new Set<string>();
	definition.members.forEach((member, index) => {
		if (!MEMBER_ID_PATTERN.test(member.id) || seenIds.has(member.id)) {
			errors.push({
				code: "member.id",
				path: `members[${index}].id`,
				message: `member id "${member.id}" must match [a-z0-9][a-z0-9_-]* and be unique`,
			});
		}
		seenIds.add(member.id);
	});

	// E5
	const entry = definition.members.find(member => member.id === definition.entry);
	if (!entry) {
		errors.push({
			code: "entry.unresolved",
			path: "entry",
			message: `entry "${definition.entry}" does not name a member`,
		});
	} else if (entry.kind === "verdict") {
		errors.push({
			code: "entry.verdict",
			path: "entry",
			message: `entry "${definition.entry}" is a verdict member; the entry must be a model member`,
		});
	}

	// E6, E7, E8, E9
	const edgeIds = new Set<string>();
	definition.edges.forEach((edge, index) => {
		const path = `edges[${index}]`;
		const id = mixtureEdgeId(edge);
		for (const endpoint of [edge.from, ...edgeTargets(edge)]) {
			if (!memberIds.has(endpoint)) {
				errors.push({
					code: "edge.endpoint",
					path,
					message: `edge ${id}: "${endpoint}" is not a member`,
				});
			}
		}
		if (definition.members.find(member => member.id === edge.from)?.kind === "verdict") {
			errors.push({
				code: "edge.from_verdict",
				path: `${path}.from`,
				message: `edge ${id}: verdict member ${edge.from} cannot have outgoing edges`,
			});
		}
		const keys = Object.keys(edge.x);
		for (const key of keys) {
			if (!KNOWN_PARTS.has(key)) {
				errors.push({
					code: "edge.x.unknown_part",
					path: `${path}.x.${key}`,
					message: `edge ${id}: unknown transit part "${key}"`,
				});
			}
		}
		const declared = declaredParts(edge);
		if (declared.length === 0) {
			errors.push({
				code: "edge.x.empty",
				path: `${path}.x`,
				message: `edge ${id}: x must declare at least one part (${TRANSIT_PART_NAMES.join(", ")})`,
			});
		}
		const reference = edge.envelope ?? DEFAULT_EDGE_ENVELOPE;
		const template = isInlineTemplate(reference) ? reference : resolved.envelopes[reference];
		if (template !== undefined && templateIssues(template, `${path}.envelope`, errors)) {
			for (const part of referencedParts(template)) {
				if (KNOWN_PARTS.has(part) && !declared.includes(part)) {
					errors.push({
						code: "edge.envelope.undeclared_part",
						path: `${path}.envelope`,
						message: `edge ${id}: the envelope reads x.${part} but x does not declare it`,
					});
				}
			}
		}
		if (edgeIds.has(id)) {
			errors.push({ code: "edge.id.duplicate", path: `${path}.id`, message: `edge id "${id}" is not unique` });
		}
		edgeIds.add(id);
	});
	for (const [name, template] of Object.entries(resolved.envelopes)) {
		if (definition.edges.some(edge => (edge.envelope ?? DEFAULT_EDGE_ENVELOPE) === name)) continue;
		templateIssues(template, `envelopes.${name}`, errors);
	}

	// E10, E19 terminate.terminal
	definition.members.forEach((member, index) => {
		const terminal = outgoing(definition, member.id).length === 0;
		if (terminal && member.show === "never") {
			warnings.push({
				code: "member.show.final",
				path: `members[${index}].show`,
				message: `member ${member.id} is terminal; its output is always shown as the answer`,
			});
		}
		if (member.kind !== "verdict" && terminal && member.terminate) {
			warnings.push({
				code: "terminate.terminal",
				path: `members[${index}].terminate`,
				message: `member ${member.id} has no outgoing edges; terminate has nothing to stop`,
			});
		}
		const resolvedMember = resolved.members[member.id];
		if (
			resolvedMember?.kind === "model" &&
			resolvedMember.toolPolicy !== false &&
			resolvedMember.model.supportsTools === false
		) {
			warnings.push({
				code: "member.tools.unsupported",
				path: `members[${index}].tools`,
				message: `member ${member.id}: ${resolvedMember.model.provider}/${resolvedMember.model.id} does not support tools`,
			});
		}
	});

	// E19 edge.x.reasoning.empty
	definition.edges.forEach((edge, index) => {
		const source = resolved.members[edge.from];
		if (edge.x.reasoning && source?.kind === "model" && !source.model.reasoning) {
			warnings.push({
				code: "edge.x.reasoning.empty",
				path: `edges[${index}].x.reasoning`,
				message: `edge ${mixtureEdgeId(edge)}: ${edge.from}'s model exposes no reasoning`,
			});
		}
	});

	// E17
	if (entry) {
		const reachable = new Set<string>([entry.id]);
		const queue = [entry.id];
		while (queue.length > 0) {
			const id = queue.shift()!;
			for (const edge of outgoing(definition, id)) {
				for (const target of edgeTargets(edge)) {
					if (reachable.has(target)) continue;
					reachable.add(target);
					queue.push(target);
				}
			}
		}
		definition.members.forEach((member, index) => {
			if (reachable.has(member.id)) return;
			warnings.push({
				code: "unreachable",
				path: `members[${index}]`,
				message: `member ${member.id} has no path from the entry`,
			});
		});
	}

	// E15 limits.exceeds
	const maxHops = definition.limits?.maxHops;
	const hardMaxHops = cfgMoaHardMaxHops.get(ctx.settings);
	if (maxHops !== undefined && maxHops > hardMaxHops) {
		errors.push({
			code: "limits.exceeds",
			path: "limits.max_hops",
			message: `limits.max_hops (${maxHops}) exceeds moa.hard_max_hops (${hardMaxHops})`,
		});
	}

	// E22
	const branches = new Set(definition.edges.flatMap(edge => (isFanoutEdge(edge) ? edge.to : [])));
	definition.members.forEach((member, index) => {
		if (!branches.has(member.id)) return;
		const controls = member.kind !== "verdict" && (member.route || member.terminate);
		if (controls || outgoing(definition, member.id).length > 0) {
			warnings.push({
				code: "fanout.branch.controls",
				path: `members[${index}]`,
				message: `member ${member.id} is a fan-out branch; its route, terminate, and outgoing edges are ignored there`,
			});
		}
	});

	capabilityGate(resolved, errors);
	return { errors, warnings };
}
