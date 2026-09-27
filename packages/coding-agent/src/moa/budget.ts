/**
 * `fitHopRequest`: bound an assembled hop request by the target member's
 * window. Individually capped parts plus the conversation, role prompt, and
 * the hop's own messages can still exceed it, so parts are filled in priority
 * order, each first capped by the per-part budget and then by what remains,
 * keeping head and tail around a truncation marker. The marker counts against
 * the part's budget; a part whose marker cannot fit is omitted. The fitted
 * request is re-assembled and checked against the window before it is returned.
 */
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Api, Message, Model } from "@oh-my-pi/pi-ai";

export interface HopParts {
	output?: string;
	input?: string;
	reasoning?: string;
	toolTrace?: string;
	conversation?: string;
}

export interface FitHopRequest {
	target: Model<Api>;
	/** The member's own `max_tokens`, when set. */
	maxTokens?: number;
	systemPrompt: readonly string[];
	/** Render the hop's envelope with these parts; an absent part renders nothing. */
	assemble(parts: HopParts): string;
	parts: HopParts;
	/** The hop's own messages (tool rounds): irreducible. */
	hopMessages: readonly Message[];
	/** `moa.part_budget_tokens`. */
	partBudgetTokens: number;
}

export type FitHopResult =
	| { ok: true; parts: HopParts; envelope: string }
	| { ok: false; neededTokens: number; availableTokens: number };

const DEFAULT_RESERVE = 16_384;
/** Priority order after the hop's own messages. */
const PRIORITY: (keyof HopParts)[][] = [["output"], ["input", "reasoning", "toolTrace"], ["conversation"]];
/** Refits after the assembled request overflowed; each pass shrinks the parts by the overflow. */
const MAX_FIT_PASSES = 4;

function truncationMarker(tokens: number): string {
	return `[… truncated ${tokens} tokens]`;
}

/**
 * Keep the head and tail of `text` within `budget` tokens around an omission
 * marker. The result never exceeds `budget`: when not even the marker fits,
 * the text is omitted (`""`).
 */
export function truncateToTokens(text: string, budget: number, tokenizer: Tokenizer): string {
	const tokens = tokenizer.countTokens(text);
	if (tokens <= budget) return text;
	const bare = truncationMarker(tokens);
	if (tokenizer.countTokens(bare) > budget) return "";
	let keepChars = Math.floor((text.length * budget) / tokens);
	while (keepChars > 1) {
		const head = text.slice(0, Math.ceil(keepChars / 2));
		const tail = text.slice(text.length - Math.floor(keepChars / 2));
		const kept = tokenizer.countTokens(head) + tokenizer.countTokens(tail);
		const candidate = `${head}\n${truncationMarker(Math.max(0, tokens - kept))}\n${tail}`;
		if (tokenizer.countTokens(candidate) <= budget) return candidate;
		keepChars = Math.floor(keepChars * 0.8);
	}
	return bare;
}

function fillParts(request: FitHopRequest, available: number, tokenizer: Tokenizer): HopParts {
	const parts: HopParts = {};
	let remaining = available;
	for (const tier of PRIORITY) {
		for (const name of tier) {
			const text = request.parts[name];
			if (!text) continue;
			const fitted = truncateToTokens(text, Math.min(request.partBudgetTokens, Math.max(0, remaining)), tokenizer);
			if (!fitted) continue;
			parts[name] = fitted;
			remaining -= tokenizer.countTokens(fitted);
		}
	}
	return parts;
}

export function fitHopRequest(request: FitHopRequest): FitHopResult {
	const tokenizer = new Tokenizer(request.target);
	const reserveOutput = request.maxTokens ?? Math.min(request.target.maxTokens ?? DEFAULT_RESERVE, DEFAULT_RESERVE);
	// An unknown window cannot be fitted against; parts are still capped by the per-part budget.
	const window = request.target.contextWindow;
	const budget = window ? window - reserveOutput : Number.POSITIVE_INFINITY;
	const hopTokens = tokenizer.countMessages(request.hopMessages);
	const measure = (envelope: string) => tokenizer.countTokens([...request.systemPrompt, envelope]) + hopTokens;
	const fixed = measure(request.assemble({}));
	if (fixed > budget) return { ok: false, neededTokens: fixed, availableTokens: Math.max(0, budget) };

	// Envelope markup around each part is not in `fixed`; the assembled total decides.
	let available = budget - fixed;
	let needed = fixed;
	for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
		const parts = fillParts(request, available, tokenizer);
		const envelope = request.assemble(parts);
		needed = measure(envelope);
		if (needed <= budget) return { ok: true, parts, envelope };
		available = Math.max(0, available - (needed - budget));
	}
	return { ok: false, neededTokens: needed, availableTokens: Math.max(0, budget) };
}
