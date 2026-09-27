/**
 * `resolveMixture`: pin every executable dependency of a definition (member
 * models, presets, the judge plan) so a run is unaffected by later edits.
 * Runs at registration and again at every run start. Only reachable helpers
 * are resolved: a linear graph never touches the judge chain, so a mixture
 * selected as `@default` cannot make it see itself. Resolution failures are
 * collected as issues for `validateMixture`, never thrown.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { isFanoutEdge, type MixtureDefinition, mixtureEdgeId } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ADVISOR_DEFAULT_TOOL_NAMES } from "../advisor/advise-tool";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveModelRoleValue, resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { judgeRoleChain } from "../judgment";
import { BUNDLED_ENVELOPES, DEFAULT_EDGE_ENVELOPE, ENTRY_ENVELOPE, isInlineTemplate } from "./envelopes";
import { MIXTURE_API } from "./provider";
import type { MixtureIssue, ResolvedMember, ResolvedMixture, ToolPolicy } from "./types";

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

/** Effective tool policy: explicit, else on for members whose output reaches the operator (no outgoing edges). */
export function effectiveToolPolicy(definition: MixtureDefinition, memberId: string): ToolPolicy {
	const member = definition.members.find(candidate => candidate.id === memberId);
	if (!member || member.kind === "verdict") return false;
	if (member.tools !== undefined) return member.tools;
	const isBranch = definition.edges.some(edge => isFanoutEdge(edge) && edge.to.includes(memberId));
	if (isBranch) return false;
	return !definition.edges.some(edge => edge.from === memberId);
}

function lookupPreset(
	name: string,
	local: Record<string, string> | undefined,
	document: Record<string, string> | undefined,
	bundled: Readonly<Record<string, string>>,
): string | undefined {
	return local?.[name] ?? document?.[name] ?? bundled[name];
}

function resolveJudgePlan(ctx: ResolveMixtureContext, issues: MixtureIssue[]): ResolvedMixture["judgePlan"] {
	const fullPool = roleCandidatePool("judge", ctx.settings, ctx.registry);
	// Explicit configuration that lands on a mixture is an error; the implicit fallback pool is filtered instead.
	for (const candidate of resolveRoleChain("judge", ctx.settings, fullPool)) {
		if (candidate.explicit && isMixtureApi(candidate.model)) {
			issues.push({
				code: "helper.unresolved",
				path: "judge",
				message: `the judge role resolves to ${formatModelStringWithRouting(candidate.model)}, a mixture; a mixture cannot judge itself`,
			});
			return undefined;
		}
	}
	const plan = judgeRoleChain(
		ctx.settings,
		ctx.registry,
		fullPool.filter(model => !isMixtureApi(model)),
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
	const definition = structuredClone(input);
	const issues: MixtureIssue[] = [];
	const available = ctx.registry.getAvailable();
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
		const level = resolved.thinkingLevel;
		const toolPolicy = effectiveToolPolicy(definition, member.id);
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
	const judgePlan = uses.judge ? resolveJudgePlan(ctx, issues) : undefined;
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

	return { definition, members, envelopes, uses, judgePlan, readOnlyTools, issues, revision };
}
