import { resolvePromptAsset, compilePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
/**
 * Envelope presets: Handlebars templates that frame what a member receives for
 * its hop. Compiled with `prompt.compile` (not `render`) so member output
 * whitespace survives. The `moa-parts` partial renders every declared transit
 * part; `registerPartial` is process-global, hence the prefixed name.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { Answer, Question } from "@oh-my-pi/pi-ai/judgment";
import type { JudgeKind } from "../judgment";
import bundledEntryEnvelope from "../prompts/moa/envelopes/entry.md" with { type: "text" };
import bundledDefendEnvelope from "../prompts/moa/envelopes/defend.md" with { type: "text" };
import bundledDisagreeEnvelope from "../prompts/moa/envelopes/disagree.md" with { type: "text" };
import bundledHandoffEnvelope from "../prompts/moa/envelopes/handoff.md" with { type: "text" };
import bundledJudgeEnvelope from "../prompts/moa/envelopes/judge.md" with { type: "text" };
import bundledLimitEnvelope from "../prompts/moa/envelopes/limit.md" with { type: "text" };
import bundledMoaPartsPartial from "../prompts/moa/envelopes/moa-parts.md" with { type: "text" };
import limitNotice from "../prompts/moa/notices/limit.md" with { type: "text" };
import pauseNotice from "../prompts/moa/notices/pause.md" with { type: "text" };
import bundledDefenseRole from "../prompts/moa/roles/defense.md" with { type: "text" };
import bundledJudgeRole from "../prompts/moa/roles/judge.md" with { type: "text" };
import bundledProsecutionRole from "../prompts/moa/roles/prosecution.md" with { type: "text" };
import toolTraceTemplate from "../prompts/moa/tool-trace.md" with { type: "text" };
import bundledVerdictTemplate from "../prompts/moa/verdict.md" with { type: "text" };

/** Envelope presets shipped with this build, by name. */
export const BUNDLED_ENVELOPES: Readonly<Record<string, string>> = {
	get entry() {
		return resolvePromptAsset("moa/envelopes/entry.md", bundledEntryEnvelope).text;
	},
	get handoff() {
		return resolvePromptAsset("moa/envelopes/handoff.md", bundledHandoffEnvelope).text;
	},
	get disagree() {
		return resolvePromptAsset("moa/envelopes/disagree.md", bundledDisagreeEnvelope).text;
	},
	get defend() {
		return resolvePromptAsset("moa/envelopes/defend.md", bundledDefendEnvelope).text;
	},
	get judge() {
		return resolvePromptAsset("moa/envelopes/judge.md", bundledJudgeEnvelope).text;
	},
	get limit() {
		return resolvePromptAsset("moa/envelopes/limit.md", bundledLimitEnvelope).text;
	},
	get verdict() {
		return resolvePromptAsset("moa/verdict.md", bundledVerdictTemplate).text;
	},
};

export const BUNDLED_ROLES: Readonly<Record<string, string>> = {
	get prosecution() {
		return resolvePromptAsset("moa/roles/prosecution.md", bundledProsecutionRole).text;
	},
	get defense() {
		return resolvePromptAsset("moa/roles/defense.md", bundledDefenseRole).text;
	},
	get judge() {
		return resolvePromptAsset("moa/roles/judge.md", bundledJudgeRole).text;
	},
};

/** Default envelope of an edge without one. */
export const DEFAULT_EDGE_ENVELOPE = "handoff";
/** Envelope of the entry hop. */
export const ENTRY_ENVELOPE = "entry";
export const LIMIT_ENVELOPE = "limit";

export interface EnvelopeMember {
	id: string;
	description?: string;
	model: string;
}

export type EnvelopeContext = {
	mixture: { name: string; member_count: number; members: EnvelopeMember[] };
	topic: string;
	conversation: string;
	from?: EnvelopeMember;
	to: EnvelopeMember;
	edge?: { id: string; traversal: number };
	hop: number;
	x: { output?: string; input?: string; reasoning?: string; tool_trace?: string; transcript?: string };
	limit?: { kind: "hops" | "budget" | "wall_clock"; value: string };
};

let registeredPartialSource: string | undefined;

function ensurePartial(): void {
	const text = resolvePromptAsset("moa/envelopes/moa-parts.md", bundledMoaPartsPartial).text;
	if (text === registeredPartialSource) return;
	prompt.registerPartial("moa-parts", text);
	registeredPartialSource = text;
}

/** A preset value containing a newline or `{{` is an inline template, not a preset name. */
export function isInlineTemplate(value: string): boolean {
	return value.includes("\n") || value.includes("{{");
}

/** Render an envelope template; throws when the template does not compile. */
export function renderEnvelope(template: string, context: EnvelopeContext): string {
	ensurePartial();
	return prompt.compile(template)(context).trim();
}

/** The operator-facing notice for a run stopped by a limit. */
export function renderLimitNotice(context: {
	mixture: string;
	hops: number;
	reason: string;
	member?: string;
	output?: string;
}): string {
	return compilePromptAsset("moa/notices/limit.md", limitNotice, { kind: "notice" })(context).trim();
}

/** The operator-facing notice for a run paused at a soft limit. */
export function renderPauseNotice(context: {
	mixture: string;
	member: string;
	reason: string;
	hops: number;
	usd: string;
}): string {
	return compilePromptAsset("moa/notices/pause.md", pauseNotice, { kind: "notice" })(context).trim();
}

export interface VerdictInput {
	member: { id: string; description?: string };
	question: Question;
	answer: Answer;
	confidence?: number;
	judge: string;
	judgeKind: JudgeKind;
}

/** Render a judge's structured answer as operator-facing verdict text. */
export function renderVerdict(template: string, input: VerdictInput): string {
	// Mixtures do not ask image-localization questions, so a box is a malformed verdict.
	if (input.answer.type === "box") throw new Error("mixture verdict unexpectedly returned a bounding box");
	const answer =
		input.answer.type === "choice"
			? { choice: input.answer.choice }
			: input.answer.type === "score"
				? { score: input.answer.score.toFixed(2) }
				: { noul: input.answer.noul.toFixed(2) };
	return prompt
		.compile(template)({
			member: input.member,
			question: { type: input.question.type, instructions: input.question.instructions },
			answer,
			confidence: input.confidence?.toFixed(2),
			judge: input.judge,
			judgeKind: input.judgeKind,
		})
		.trim();
}

/** One compact, readable list of tool calls; omit it for hops with no calls. */
export function renderToolTrace(calls: { name: string; summary: string }[]): string {
	return calls.length === 0 ? "" : compilePromptAsset("moa/tool-trace.md", toolTraceTemplate)({ calls }).trim();
}
