/**
 * Envelope presets: Handlebars templates that frame what a member receives for
 * its hop. Compiled with `prompt.compile` (not `render`) so member output
 * whitespace survives. The `moa-parts` partial renders every declared transit
 * part; `registerPartial` is process-global, hence the prefixed name.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import entryEnvelope from "../prompts/moa/envelopes/entry.md" with { type: "text" };
import handoffEnvelope from "../prompts/moa/envelopes/handoff.md" with { type: "text" };
import moaPartsPartial from "../prompts/moa/envelopes/moa-parts.md" with { type: "text" };
import limitNotice from "../prompts/moa/notices/limit.md" with { type: "text" };

/** Envelope presets shipped with this build, by name. */
export const BUNDLED_ENVELOPES: Readonly<Record<string, string>> = {
	entry: entryEnvelope,
	handoff: handoffEnvelope,
};

/** Default envelope of an edge without one. */
export const DEFAULT_EDGE_ENVELOPE = "handoff";
/** Envelope of the entry hop. */
export const ENTRY_ENVELOPE = "entry";

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
