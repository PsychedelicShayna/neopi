/**
 * `resolveMixture`: pin every executable dependency of a definition (member
 * models, presets, the judge plan) so a run is unaffected by later edits.
 * Runs at registration and again at every run start. Only reachable helpers
 * are resolved: a linear graph never touches the judge chain, so a mixture
 * selected as `@default` cannot make it see itself. Resolution failures are
 * collected as issues for `validateMixture`, never thrown.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	isFanoutEdge,
	type MixtureDefinition,
	mixtureEdgeId,
	type ModelMember,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ADVISOR_DEFAULT_TOOL_NAMES } from "../advisor/advise-tool";
import type { ModelRegistry } from "../config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelString,
	formatModelStringWithRouting,
	resolveModelRoleValue,
	resolveRoleChain,
} from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { judgeRoleChain } from "../judgment";
import { BUNDLED_ENVELOPES, DEFAULT_EDGE_ENVELOPE, ENTRY_ENVELOPE, isInlineTemplate } from "./envelopes";
import { MIXTURE_API } from "./provider";
import type { MixtureIssue, ResolvedMember, ResolvedMixture, ToolPolicy } from "./types";
import { definitionSizeIssue } from "./validate";

export interface ResolveMixtureContext {
	registry: ModelRegistry;
	settings: Settings;
	/** Document-level presets of the file that declared the mixture. */
	documentEnvelopes?: Record<string, string>;
	documentRoles?: Record<string, string>;
}

function isMixtureApi(model: Model<Api>): boolean {
	return model.api === MIXTURE_API;
}

/**
 * The session's model allow-list (§1.4): a dependency must resolve against
 * `getAvailable()` and then be in this pool. Never resolve against the pool
 * itself, so fuzzy or role matching cannot land on a different allowed model.
 */
function allowedModels(ctx: ResolveMixtureContext, available: Model<Api>[]): (model: Model<Api>) => boolean {
	const patterns = cfgEnabledModels.get(ctx.settings);
	if (patterns.length === 0) return () => true;
	const allowed = new Set(
		filterAvailableModelsByEnabledPatterns(available, patterns, ctx.settings).map(formatModelString),
	);
	return model => allowed.has(formatModelString(model));
}

/** Edge sources and fan-out branches of a definition, computed once per resolution. */
interface GraphShape {
	sources: ReadonlySet<string>;
	branches: ReadonlySet<string>;
}

function graphShape(definition: MixtureDefinition): GraphShape {
	return {
		sources: new Set(definition.edges.map(edge => edge.from)),
		branches: new Set(definition.edges.flatMap(edge => (isFanoutEdge(edge) ? edge.to : []))),
	};
}

/** Effective tool policy: explicit, else on for members whose output reaches the operator (no outgoing edges). */
function effectiveToolPolicy(member: ModelMember, shape: GraphShape): ToolPolicy {
	if (member.tools !== undefined) return member.tools;
	if (shape.branches.has(member.id)) return false;
	return !shape.sources.has(member.id);
}

function lookupPreset(
	name: string,
	local: Record<string, string> | undefined,
	document: Record<string, string> | undefined,
	bundled: Readonly<Record<string, string>>,
): string | undefined {
	return local?.[name] ?? document?.[name] ?? bundled[name];
}

function resolveJudgePlan(
	ctx: ResolveMixtureContext,
	isAllowed: (model: Model<Api>) => boolean,
	issues: MixtureIssue[],
): ResolvedMixture["judgePlan"] {
	const fullPool = roleCandidatePool("judge", ctx.settings, ctx.registry);
	// Explicit configuration that lands on a mixture or an excluded model is an error; the
	// implicit fallback pool is filtered instead.
	for (const candidate of resolveRoleChain("judge", ctx.settings, fullPool)) {
		if (!candidate.explicit) continue;
		if (isMixtureApi(candidate.model)) {
			issues.push({
				code: "helper.unresolved",
				path: "judge",
				message: `the judge role resolves to ${formatModelStringWithRouting(candidate.model)}, a mixture; a mixture cannot judge itself`,
			});
			return undefined;
		}
		if (!isAllowed(candidate.model)) {
			issues.push({
				code: "helper.unresolved",
				path: "judge",
				message: `the judge role resolves to ${formatModelStringWithRouting(candidate.model)}, which is excluded by enabledModels`,
			});
			return undefined;
		}
	}
	const plan = judgeRoleChain(
		ctx.settings,
		ctx.registry,
		fullPool.filter(model => !isMixtureApi(model) && isAllowed(model)),
	);
	if (plan.length === 0) {
		issues.push({
			code: "helper.unresolved",
			path: "judge",
			message: "the graph routes or terminates but no judge model is available",
		});
		return undefined;
	}
	return plan;
}

export function resolveMixture(input: MixtureDefinition, ctx: ResolveMixtureContext): ResolvedMixture {
	const presets = { envelopes: { ...ctx.documentEnvelopes }, roles: { ...ctx.documentRoles } };
	// E23 first: an oversized definition is resolved no further, so nothing below scales with it.
	const oversized = definitionSizeIssue(input, presets);
	if (oversized) {
		return {
			definition: structuredClone(input),
			members: {},
			envelopes: {},
			presets,
			uses: { judge: false, summary: false, slicer: false },
			judgePlan: undefined,
			readOnlyTools: new Set(ADVISOR_DEFAULT_TOOL_NAMES),
			issues: [oversized],
			revision: Bun.hash(`${input.name}:${oversized.code}:${oversized.path}`).toString(16),
		};
	}
	const definition = structuredClone(input);
	const issues: MixtureIssue[] = [];
	const available = ctx.registry.getAvailable();
	const isAllowed = allowedModels(ctx, available);
	const shape = graphShape(definition);
	const members: Record<string, ResolvedMember> = {};
	definition.members.forEach((member, index) => {
		const show = member.show ?? "always";
		if (member.kind === "verdict") {
			members[member.id] = {
				kind: "verdict",
				id: member.id,
				description: member.description,
				question: member.question,
				state: member.state,
				render:
					lookupPreset(
						member.render ?? "verdict",
						definition.envelopes,
						ctx.documentEnvelopes,
						BUNDLED_ENVELOPES,
					) ?? "",
				show,
			};
			return;
		}
		const path = `members[${index}]`;
		const resolved = resolveModelRoleValue(member.model, available, { settings: ctx.settings });
		let rolePrompt = member.systemPrompt;
		if (rolePrompt === undefined && member.role !== undefined) {
			rolePrompt = lookupPreset(member.role, definition.roles, ctx.documentRoles, {});
			if (rolePrompt === undefined) {
				issues.push({
					code: "member.role.unresolved",
					path: `${path}.role`,
					message: `member ${member.id}: role preset "${member.role}" does not exist`,
				});
			}
		} else if (rolePrompt === undefined) {
			issues.push({
				code: "member.prompt.missing",
				path,
				message: `member ${member.id} needs a system_prompt or a role`,
			});
		}
		if (!resolved.model) {
			issues.push({
				code: "member.model.unresolved",
				path: `${path}.model`,
				message: `member ${member.id}: model "${member.model}" does not resolve to an available model`,
			});
			return;
		}
		if (isMixtureApi(resolved.model)) {
			issues.push({
				code: "member.model.recursive",
				path: `${path}.model`,
				message: `member ${member.id}: "${member.model}" resolves to ${formatModelStringWithRouting(resolved.model)}, a mixture; mixtures cannot nest`,
			});
			return;
		}
		if (!isAllowed(resolved.model)) {
			issues.push({
				code: "member.model.excluded",
				path: `${path}.model`,
				message: `member ${member.id}: ${formatModelStringWithRouting(resolved.model)} is excluded by enabledModels`,
			});
			return;
		}
		const level = resolved.thinkingLevel;
		const toolPolicy = effectiveToolPolicy(member, shape);
		members[member.id] = {
			kind: "model",
			id: member.id,
			description: member.description,
			model: resolved.model,
			effort: level === undefined || level === "auto" ? undefined : toReasoningEffort(level),
			reasoningOff: level === ThinkingLevel.Off ? true : undefined,
			maxTokens: member.maxTokens,
			rolePrompt: rolePrompt ?? "",
			toolPolicy,
			inherit: member.inherit ?? toolPolicy !== false,
			show,
		};
	});

	const envelopes: Record<string, string> = {};
	const entryEnvelope = lookupPreset(ENTRY_ENVELOPE, definition.envelopes, ctx.documentEnvelopes, BUNDLED_ENVELOPES);
	if (entryEnvelope !== undefined) envelopes[ENTRY_ENVELOPE] = entryEnvelope;
	definition.edges.forEach((edge, index) => {
		const reference = edge.envelope ?? DEFAULT_EDGE_ENVELOPE;
		if (isInlineTemplate(reference) || envelopes[reference] !== undefined) return;
		const preset = lookupPreset(reference, definition.envelopes, ctx.documentEnvelopes, BUNDLED_ENVELOPES);
		if (preset === undefined) {
			issues.push({
				code: "edge.envelope.unresolved",
				path: `edges[${index}].envelope`,
				message: `edge ${mixtureEdgeId(edge)}: envelope preset "${reference}" does not exist`,
			});
			return;
		}
		envelopes[reference] = preset;
	});

	const uses = {
		judge:
			definition.steering?.target === "auto" ||
			definition.members.some(
				member => member.kind === "verdict" || member.route !== undefined || member.terminate !== undefined,
			),
		summary: definition.edges.some(
			edge =>
				typeof edge.x.transcript === "object" &&
				(edge.x.transcript.optimize === "compact" || edge.x.transcript.optimize === "snapcompact"),
		),
		slicer: definition.edges.some(edge => isFanoutEdge(edge) && edge.slices === "auto"),
	};
	// The summary and slicer helpers ship with the milestones that can reach them (M2, M4);
	// until then the capability gate rejects any definition whose `uses` names them.
	const judgePlan = uses.judge ? resolveJudgePlan(ctx, isAllowed, issues) : undefined;
	const readOnlyTools = new Set(ADVISOR_DEFAULT_TOOL_NAMES);

	const revision = Bun.hash(
		JSON.stringify({
			definition,
			members: Object.values(members).map(member =>
				member.kind === "model"
					? [member.id, `${formatModelStringWithRouting(member.model)}:${member.effort ?? ""}`, member.rolePrompt]
					: [member.id, member.render],
			),
			envelopes,
			judgePlan: judgePlan?.map(candidate => formatModelStringWithRouting(candidate.model)),
			readOnlyTools: [...readOnlyTools],
		}),
	).toString(16);

	return { definition, members, envelopes, presets, uses, judgePlan, readOnlyTools, issues, revision };
}
