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
	type MixtureMember,
	mixtureEdgeId,
	TRANSIT_PART_NAMES,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { Settings } from "../config/settings";
import { DEFAULT_EDGE_ENVELOPE, type EnvelopeContext, isInlineTemplate, renderEnvelope } from "./envelopes";
import { codedMixtureIssue } from "./findings";
import { cfgMoaHardMaxHops, cfgMoaOnLimit } from "./settings";
import type { MixtureIssue, ResolvedMixture } from "./types";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const KNOWN_PARTS = new Set<string>(TRANSIT_PART_NAMES);
/** The milestone this build implements; the gate names the one that adds a feature. */
const IMPLEMENTED_MILESTONE = "M2";

// E23 size bounds (spec §11). Code constants, never settings: a project file must not be able to
// raise them. Registration validates every discovered definition at startup, so the work a
// definition can cause is bounded here before any pass that scales with it.
export const MAX_MEMBERS = 32;
export const MAX_EDGES = 128;
/** Sum over edges of the target count (a fan-out's `to` list, else 1) plus one per `join`. */
export const MAX_EDGE_TARGETS = 256;
/** Every `state` array and every fan-out `slices` list. */
export const MAX_STATE_PARTS = 8;
/** Every string the definition hands to a model or a template compiler. */
export const MAX_TEXT_CHARS = 65_536;
/** A `MIXTURES.toml` file, checked by the loader before parsing. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

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

function edgeTargets(edge: MixtureEdge): string[] {
	return isFanoutEdge(edge) ? [...edge.to, edge.join].filter(Boolean) : [edge.to];
}

function sizeIssue(code: "limits.graph_size" | "limits.text_size", path: string, count: number, cap: number) {
	const unit = code === "limits.text_size" ? "characters" : "entries";
	return { code, path, message: `${path} has ${count} ${unit}; the cap is ${cap}` };
}

const preparedBundles = new WeakSet<object>();

/** Immutable snapshot of a document's presets, checked once before its mixtures are resolved. */
export interface PreparedDocumentPresets {
	readonly envelopes: Readonly<Record<string, string>>;
	readonly roles: Readonly<Record<string, string>>;
	readonly sizeIssue: MixtureIssue | undefined;
}

export function prepareDocumentPresets(
	envelopes?: Readonly<Record<string, string>>,
	roles?: Readonly<Record<string, string>>,
): PreparedDocumentPresets {
	const envelopeSnapshot = Object.freeze({ ...envelopes });
	const roleSnapshot = Object.freeze({ ...roles });
	const issue = firstTextSizeIssue({ envelopes: envelopeSnapshot, roles: roleSnapshot });
	const snapshot = Object.freeze({
		envelopes: envelopeSnapshot,
		roles: roleSnapshot,
		sizeIssue: issue ? Object.freeze(issue) : undefined,
	});
	preparedBundles.add(snapshot);
	return snapshot;
}

/** Raw API inputs are snapshotted anew; only module-created immutable bundles skip the scan. */
export function documentPresets(
	value?: PreparedDocumentPresets,
	envelopes?: Readonly<Record<string, string>>,
	roles?: Readonly<Record<string, string>>,
): PreparedDocumentPresets {
	if (
		value &&
		preparedBundles.has(value) &&
		(envelopes === undefined || envelopes === value.envelopes) &&
		(roles === undefined || roles === value.roles)
	)
		return value;
	return prepareDocumentPresets(envelopes, roles);
}

/** A TypeScript field name as the TOML key it was read from (`systemPrompt` → `system_prompt`). */
function tomlKey(key: string): string {
	return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Every string a definition and its document presets carry, with its TOML path: each
 * string value, and each key of a keyed table (criteria labels, preset names), as
 * `<table> (key)`. One walk over the data rather than a field list, so a field added
 * later is bounded without anyone remembering to list it: selectors reach the model
 * resolver, labels and prompts reach judgment and member requests, templates reach the
 * compiler. Iterative, and linear in the definition's size.
 */
export function* definitionStrings(
	definition: MixtureDefinition,
	presets: { envelopes?: Readonly<Record<string, string>>; roles?: Readonly<Record<string, string>> } = {},
): Generator<[path: string, text: string]> {
	const stack: [path: string, value: unknown][] = [
		["envelopes", presets.envelopes],
		["roles", presets.roles],
		["", definition],
	];
	while (stack.length > 0) {
		const [path, value] = stack.pop()!;
		if (typeof value === "string") {
			yield [path, value];
		} else if (Array.isArray(value)) {
			for (let index = value.length - 1; index >= 0; index--) stack.push([`${path}[${index}]`, value[index]]);
		} else if (value !== null && typeof value === "object") {
			const entries = Object.entries(value);
			for (const [key] of entries) yield [`${path || "definition"} (key)`, key];
			for (let index = entries.length - 1; index >= 0; index--) {
				const [key, child] = entries[index]!;
				stack.push([path ? `${path}.${tomlKey(key)}` : tomlKey(key), child]);
			}
		}
	}
}

function firstTextSizeIssue(presets: {
	envelopes?: Readonly<Record<string, string>>;
	roles?: Readonly<Record<string, string>>;
}): MixtureIssue | undefined {
	for (const [table, entries] of [
		["roles", presets.roles],
		["envelopes", presets.envelopes],
	] as const) {
		if (!entries) continue;
		for (const key of Object.keys(entries)) {
			if (key.length > MAX_TEXT_CHARS)
				return sizeIssue("limits.text_size", `${table} (key)`, key.length, MAX_TEXT_CHARS);
		}
		for (const [key, text] of Object.entries(entries)) {
			if (text.length > MAX_TEXT_CHARS)
				return sizeIssue("limits.text_size", `${table}.${tomlKey(key)}`, text.length, MAX_TEXT_CHARS);
		}
	}
	return undefined;
}

/**
 * E23: the first size bound a definition breaks, checked before any other pass so an
 * oversized definition costs time linear in its size and gets exactly one error.
 */
export function definitionSizeIssue(
	definition: MixtureDefinition,
	presets: { envelopes?: Readonly<Record<string, string>>; roles?: Readonly<Record<string, string>> } = {},
	prepared?: PreparedDocumentPresets,
): MixtureIssue | undefined {
	if (definition.members.length > MAX_MEMBERS) {
		return sizeIssue("limits.graph_size", "members", definition.members.length, MAX_MEMBERS);
	}
	if (definition.edges.length > MAX_EDGES) {
		return sizeIssue("limits.graph_size", "edges", definition.edges.length, MAX_EDGES);
	}
	let targets = 0;
	for (const [index, edge] of definition.edges.entries()) {
		targets += isFanoutEdge(edge) ? edge.to.length + (edge.join ? 1 : 0) : 1;
		if (targets > MAX_EDGE_TARGETS) {
			return sizeIssue("limits.graph_size", `edges[${index}]`, targets, MAX_EDGE_TARGETS);
		}
	}
	const parts: [path: string, parts: readonly unknown[] | undefined][] = [];
	for (const [index, member] of definition.members.entries()) {
		const path = `members[${index}]`;
		if (member.kind === "verdict") {
			parts.push([`${path}.state`, member.state]);
			continue;
		}
		parts.push([`${path}.route.state`, member.route?.state], [`${path}.terminate.state`, member.terminate?.state]);
	}
	for (const [index, edge] of definition.edges.entries()) {
		if (isFanoutEdge(edge) && Array.isArray(edge.slices)) parts.push([`edges[${index}].slices`, edge.slices]);
	}
	for (const [path, list] of parts) {
		if (list && list.length > MAX_STATE_PARTS) {
			return sizeIssue("limits.graph_size", path, list.length, MAX_STATE_PARTS);
		}
	}
	for (const [path, text] of definitionStrings(definition)) {
		if (text.length > MAX_TEXT_CHARS) return sizeIssue("limits.text_size", path, text.length, MAX_TEXT_CHARS);
	}
	return documentPresets(prepared, presets.envelopes, presets.roles).sizeIssue;
}

/** Adjacency built once per validation; every graph pass reads these maps. */
interface MixtureGraph {
	/** The first member declared under each id. */
	members: Map<string, MixtureMember>;
	outgoing: Map<string, MixtureEdge[]>;
	/** Every member id, and every edge source, to its edge targets. */
	successors: Map<string, string[]>;
}

function graphOf(definition: MixtureDefinition): MixtureGraph {
	const members = new Map<string, MixtureMember>();
	const outgoing = new Map<string, MixtureEdge[]>();
	const successors = new Map<string, string[]>();
	for (const member of definition.members) {
		if (!members.has(member.id)) members.set(member.id, member);
		successors.set(member.id, []);
	}
	for (const edge of definition.edges) {
		const edges = outgoing.get(edge.from);
		if (edges) edges.push(edge);
		else outgoing.set(edge.from, [edge]);
		const targets = successors.get(edge.from);
		if (targets) targets.push(...edgeTargets(edge));
		else successors.set(edge.from, edgeTargets(edge));
	}
	return { members, outgoing, successors };
}

/**
 * Whether the directed graph has a cycle: a three-colour walk on an explicit stack, so
 * its depth is bounded by memory, not the call stack. Targets that are not keys have no
 * successors.
 */
export function hasCycle(successors: ReadonlyMap<string, readonly string[]>): boolean {
	const VISITING = 1;
	const DONE = 2;
	const state = new Map<string, number>();
	const stack: string[] = [];
	const cursors: number[] = [];
	for (const root of successors.keys()) {
		if (state.has(root)) continue;
		state.set(root, VISITING);
		stack.push(root);
		cursors.push(0);
		while (stack.length > 0) {
			const top = stack.length - 1;
			const next = successors.get(stack[top]!) ?? [];
			const cursor = cursors[top]!;
			if (cursor === next.length) {
				state.set(stack[top]!, DONE);
				stack.pop();
				cursors.pop();
				continue;
			}
			cursors[top] = cursor + 1;
			const target = next[cursor]!;
			const seen = state.get(target);
			if (seen === VISITING) return true;
			if (seen === undefined) {
				state.set(target, VISITING);
				stack.push(target);
				cursors.push(0);
			}
		}
	}
	return false;
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
		if (member.kind === "verdict") return;
		const resolvedMember = resolved.members[member.id];
		if (resolvedMember?.kind === "model" && resolvedMember.toolPolicy !== false) {
			gate(`members[${index}].tools`, `tools on member ${member.id} (set tools = false)`, "M3");
		}
	});
	definition.edges.forEach((edge, index) => {
		if (isFanoutEdge(edge)) gate(`edges[${index}]`, `fan-out edge ${mixtureEdgeId(edge)}`, "M4");
	});
	if (definition.steering) gate("steering", "steering targets", "M3");
	if (definition.serve) gate("serve", "serving a mixture through the auth-gateway", "M6");
}

/** Iterative Tarjan walk: cycles warn only if they have no exit control. */
function unboundedCycles(graph: MixtureGraph, edges: readonly MixtureEdge[]): string[][] {
	const order = new Map<string, number>();
	const low = new Map<string, number>();
	const active = new Set<string>();
	const nodes: string[] = [];
	const cycles: string[][] = [];
	let nextOrder = 0;
	for (const root of graph.members.keys()) {
		if (order.has(root)) continue;
		const frames: { id: string; cursor: number; parent?: string }[] = [{ id: root, cursor: 0 }];
		while (frames.length > 0) {
			const frame = frames[frames.length - 1]!;
			if (!order.has(frame.id)) {
				order.set(frame.id, nextOrder);
				low.set(frame.id, nextOrder++);
				nodes.push(frame.id);
				active.add(frame.id);
			}
			const successors = graph.successors.get(frame.id) ?? [];
			if (frame.cursor < successors.length) {
				const target = successors[frame.cursor++]!;
				if (!graph.members.has(target)) continue;
				if (!order.has(target)) {
					frames.push({ id: target, cursor: 0, parent: frame.id });
				} else if (active.has(target)) {
					low.set(frame.id, Math.min(low.get(frame.id)!, order.get(target)!));
				}
				continue;
			}
			frames.pop();
			if (frame.parent) low.set(frame.parent, Math.min(low.get(frame.parent)!, low.get(frame.id)!));
			if (low.get(frame.id) !== order.get(frame.id)) continue;
			const component: string[] = [];
			let id: string;
			do {
				id = nodes.pop()!;
				active.delete(id);
				component.push(id);
			} while (id !== frame.id);
			if (component.length === 1 && !successors.includes(frame.id)) continue;
			const members = new Set(component);
			const bounded =
				component.some(id => {
					const member = graph.members.get(id);
					return member?.kind !== "verdict" && member?.terminate !== undefined;
				}) ||
				edges.some(
					edge =>
						members.has(edge.from) &&
						edgeTargets(edge).some(target => members.has(target)) &&
						edge.maxTraversals !== undefined,
				) ||
				component.some(id => {
					const member = graph.members.get(id);
					return (
						member !== undefined &&
						member.kind !== "verdict" &&
						member.route !== undefined &&
						(graph.successors.get(id) ?? []).some(target => !members.has(target))
					);
				});
			if (!bounded) cycles.push(component);
		}
	}
	return cycles;
}

function templateIssues(template: string, path: string, errors: MixtureIssue[]): boolean {
	try {
		renderEnvelope(template, SAMPLE_CONTEXT);
		return true;
	} catch (error) {
		errors.push(
			codedMixtureIssue("edge.envelope.compile", path, {
				detail: error instanceof Error ? error.message : String(error),
			}),
		);
		return false;
	}
}

export function validateMixture(resolved: ResolvedMixture, ctx: ValidateMixtureContext): MixtureValidation {
	const definition = resolved.definition;
	// E23 first and alone: nothing else runs over an oversized definition.
	const oversized = definitionSizeIssue(definition, resolved.presets, resolved.presets);
	if (oversized) return { errors: [oversized], warnings: [] };
	const errors: MixtureIssue[] = [...resolved.issues];
	const warnings: MixtureIssue[] = [];
	const graph = graphOf(definition);
	const memberIds = graph.members;

	// E1
	if (!NAME_PATTERN.test(definition.name)) {
		errors.push(codedMixtureIssue("name.invalid", "name", { name: definition.name }));
	}
	if ((ctx.names ?? []).filter(name => name === definition.name).length > 1) {
		errors.push(codedMixtureIssue("name.duplicate", "name", { name: definition.name }));
	}

	// E3
	if (definition.members.length === 0) {
		errors.push(codedMixtureIssue("members.empty", "members"));
	}
	const seenIds = new Set<string>();
	definition.members.forEach((member, index) => {
		if (!MEMBER_ID_PATTERN.test(member.id) || seenIds.has(member.id)) {
			errors.push(codedMixtureIssue("member.id", `members[${index}].id`, { member: member.id }));
		}
		seenIds.add(member.id);
	});

	// E5
	const entry = graph.members.get(definition.entry);
	if (!entry) {
		errors.push(codedMixtureIssue("entry.unresolved", "entry", { entry: definition.entry }));
	} else if (entry.kind === "verdict") {
		errors.push(codedMixtureIssue("entry.verdict", "entry", { entry: definition.entry }));
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
		if (graph.members.get(edge.from)?.kind === "verdict") {
			errors.push(codedMixtureIssue("edge.from_verdict", `${path}.from`, { edge: id, from: edge.from }));
		}
		const keys = Object.keys(edge.x);
		for (const key of keys) {
			if (!KNOWN_PARTS.has(key)) {
				errors.push(codedMixtureIssue("edge.x.unknown_part", `${path}.x.${key}`, { edge: id, part: key }));
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
			errors.push(codedMixtureIssue("edge.id.duplicate", `${path}.id`, { edge: id }));
		}
		edgeIds.add(id);
	});
	const edgeEnvelopes = new Set(definition.edges.map(edge => edge.envelope ?? DEFAULT_EDGE_ENVELOPE));
	for (const [name, template] of Object.entries(resolved.envelopes)) {
		if (edgeEnvelopes.has(name)) continue;
		templateIssues(template, `envelopes.${name}`, errors);
	}

	// E10, E19 terminate.terminal
	definition.members.forEach((member, index) => {
		const terminal = !graph.outgoing.has(member.id);
		if (terminal && member.show === "never") {
			warnings.push(codedMixtureIssue("member.show.final", `members[${index}].show`, { member: member.id }));
		}
		if (member.kind !== "verdict" && terminal && member.terminate) {
			warnings.push(codedMixtureIssue("terminate.terminal", `members[${index}].terminate`, { member: member.id }));
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
			warnings.push(
				codedMixtureIssue("edge.x.reasoning.empty", `edges[${index}].x.reasoning`, {
					edge: mixtureEdgeId(edge),
					from: edge.from,
				}),
			);
		}
	});

	// E17
	if (entry) {
		const reachable = new Set<string>([entry.id]);
		const order = [entry.id];
		for (let index = 0; index < order.length; index++) {
			for (const target of graph.successors.get(order[index]!) ?? []) {
				if (reachable.has(target)) continue;
				reachable.add(target);
				order.push(target);
			}
		}
		definition.members.forEach((member, index) => {
			if (reachable.has(member.id)) return;
			warnings.push(codedMixtureIssue("unreachable", `members[${index}]`, { member: member.id }));
		});
	}
	// E11/E12/E18: decisions must have a valid graph and meaningful rubrics.
	definition.members.forEach((member, index) => {
		const outgoing = graph.outgoing.get(member.id) ?? [];
		const path = `members[${index}]`;
		if (member.kind === "verdict") {
			if (
				(member.question.type === "choice" && Object.keys(member.question.criteria).length < 2) ||
				(member.question.type === "score" && member.question.criteria.length < 2)
			) {
				errors.push(codedMixtureIssue("verdict.question", `${path}.question`, { member: member.id }));
			}
			return;
		}
		if (outgoing.length > 1 && !member.route) {
			errors.push(codedMixtureIssue("route.required", path, { member: member.id }));
		}
		if (!member.route) return;
		if (outgoing.length === 0) {
			errors.push(codedMixtureIssue("route.options", `${path}.route`, { member: member.id }));
		}
		const fallback = member.route.fallback;
		if (fallback && fallback !== "pause" && !outgoing.some(edge => mixtureEdgeId(edge) === fallback)) {
			errors.push(codedMixtureIssue("route.fallback", `${path}.route.fallback`, { fallback }));
		}
		if (outgoing.length > 1) {
			for (const edge of outgoing) {
				if (edge.when !== undefined) continue;
				warnings.push(
					codedMixtureIssue("route.when.missing", `edges[${definition.edges.indexOf(edge)}].when`, {
						edge: mixtureEdgeId(edge),
					}),
				);
			}
		}
	});

	// E13: each unbounded strongly connected component gets one warning.
	for (const ids of unboundedCycles(graph, definition.edges)) {
		warnings.push({ code: "cycle.unbounded", path: "edges", message: `cycle ${ids.join(", ")} has no exit control` });
	}

	// E14: snapcompact frames require vision at the target.
	definition.edges.forEach((edge, index) => {
		if (typeof edge.x.transcript !== "object" || edge.x.transcript.optimize !== "snapcompact") return;
		if (isFanoutEdge(edge)) return;
		const member = resolved.members[edge.to];
		if (member?.kind === "model" && !member.model.input.includes("image")) {
			errors.push(
				codedMixtureIssue("x.transcript.snapcompact.vision", `edges[${index}].x.transcript`, {
					to: edge.to,
				}),
			);
		}
	});

	// E15: judge-on-limit must name the final model member explicitly.
	if ((definition.limits?.onLimit ?? cfgMoaOnLimit.get(ctx.settings)) === "judge") {
		const target = definition.limits?.limitTarget;
		if (!target || !graph.members.has(target) || graph.members.get(target)?.kind === "verdict") {
			errors.push(codedMixtureIssue("limits.target", "limits.limit_target"));
		}
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
		if (controls || graph.outgoing.has(member.id)) {
			warnings.push(codedMixtureIssue("fanout.branch.controls", `members[${index}]`, { member: member.id }));
		}
	});

	capabilityGate(resolved, errors);
	return { errors, warnings };
}
