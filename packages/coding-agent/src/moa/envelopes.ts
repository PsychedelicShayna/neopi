/**
 * Envelope presets: Handlebars templates that frame what a member receives for
 * its hop. Compiled with `prompt.compile` (not `render`) so member output
 * whitespace survives. The `moa-parts` partial renders every declared transit
 * part; `registerPartial` is process-global, hence the prefixed name.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { Answer, Question } from "@oh-my-pi/pi-ai/judgment";
import type { JudgeKind } from "../judgment";
import entryEnvelope from "../prompts/moa/envelopes/entry.md" with { type: "text" };
import defendEnvelope from "../prompts/moa/envelopes/defend.md" with { type: "text" };
import disagreeEnvelope from "../prompts/moa/envelopes/disagree.md" with { type: "text" };
import handoffEnvelope from "../prompts/moa/envelopes/handoff.md" with { type: "text" };
import judgeEnvelope from "../prompts/moa/envelopes/judge.md" with { type: "text" };
import limitEnvelope from "../prompts/moa/envelopes/limit.md" with { type: "text" };
import moaPartsPartial from "../prompts/moa/envelopes/moa-parts.md" with { type: "text" };
import limitNotice from "../prompts/moa/notices/limit.md" with { type: "text" };
import pauseNotice from "../prompts/moa/notices/pause.md" with { type: "text" };
import defenseRole from "../prompts/moa/roles/defense.md" with { type: "text" };
import judgeRole from "../prompts/moa/roles/judge.md" with { type: "text" };
import prosecutionRole from "../prompts/moa/roles/prosecution.md" with { type: "text" };
import toolTraceTemplate from "../prompts/moa/tool-trace.md" with { type: "text" };
import verdictTemplate from "../prompts/moa/verdict.md" with { type: "text" };

/** Envelope presets shipped with this build, by name. */
export const BUNDLED_ENVELOPES: Readonly<Record<string, string>> = {
	entry: entryEnvelope,
	handoff: handoffEnvelope,
	disagree: disagreeEnvelope,
	defend: defendEnvelope,
	judge: judgeEnvelope,
	limit: limitEnvelope,
	verdict: verdictTemplate,
};

export const BUNDLED_ROLES: Readonly<Record<string, string>> = {
	prosecution: prosecutionRole,
	defense: defenseRole,
	judge: judgeRole,
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

let partialRegistered = false;

function ensurePartial(): void {
	if (partialRegistered) return;
	prompt.registerPartial("moa-parts", moaPartsPartial);
	partialRegistered = true;
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
	return prompt.compile(limitNotice)(context).trim();
}

/** The operator-facing notice for a run paused at a soft limit. */
export function renderPauseNotice(context: {
	mixture: string;
	member: string;
	reason: string;
	hops: number;
	usd: string;
}): string {
	return prompt.compile(pauseNotice)(context).trim();
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
	return calls.length === 0 ? "" : prompt.compile(toolTraceTemplate)({ calls }).trim();
}
