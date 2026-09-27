/**
 * `fitHopRequest`: bound an assembled hop request by the target member's
 * window. Individually capped parts plus the conversation, role prompt, and
 * the hop's own messages can still exceed it, so parts are filled in priority
 * order, each first capped by the per-part budget and then by what remains,
 * keeping head and tail around a truncation marker.
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
	/** The envelope rendered with every part empty. */
	frame: string;
	parts: HopParts;
	/** The hop's own messages (tool rounds): irreducible. */
	hopMessages: readonly Message[];
	/** `moa.part_budget_tokens`. */
	partBudgetTokens: number;
}

export type FitHopResult = { ok: true; parts: HopParts } | { ok: false; neededTokens: number; availableTokens: number };

const DEFAULT_RESERVE = 16_384;
/** Priority order after the hop's own messages. */
const PRIORITY: (keyof HopParts)[][] = [["output"], ["input", "reasoning", "toolTrace"], ["conversation"]];

/** Keep the head and tail of `text` within `budget` tokens around an omission marker. */
export function truncateToTokens(text: string, budget: number, tokenizer: Tokenizer): string {
	const tokens = tokenizer.countTokens(text);
	if (tokens <= budget) return text;
	if (budget <= 0) return `[… truncated ${tokens} tokens]`;
	const keepChars = Math.max(0, Math.floor((text.length * budget) / tokens) - 32);
	const head = text.slice(0, Math.ceil(keepChars / 2));
	const tail = keepChars > 1 ? text.slice(text.length - Math.floor(keepChars / 2)) : "";
	const kept = tokenizer.countTokens(head) + tokenizer.countTokens(tail);
	return `${head}\n[… truncated ${Math.max(0, tokens - kept)} tokens]\n${tail}`;
}

export function fitHopRequest(request: FitHopRequest): FitHopResult {
	const tokenizer = new Tokenizer(request.target);
	const reserveOutput = request.maxTokens ?? Math.min(request.target.maxTokens ?? DEFAULT_RESERVE, DEFAULT_RESERVE);
	const fixed = tokenizer.countTokens([...request.systemPrompt, request.frame]);
	// An unknown window cannot be fitted against; parts are still capped by the per-part budget.
	const window = request.target.contextWindow;
	let available = window ? window - reserveOutput - fixed : Number.POSITIVE_INFINITY;
	const hopTokens = tokenizer.countMessages(request.hopMessages);
	if (hopTokens > available) {
		return { ok: false, neededTokens: hopTokens, availableTokens: Math.max(0, available) };
	}
	available -= hopTokens;
	const parts: HopParts = {};
	for (const tier of PRIORITY) {
		for (const name of tier) {
			const text = request.parts[name];
			if (!text) continue;
			const fitted = truncateToTokens(text, Math.min(request.partBudgetTokens, Math.max(0, available)), tokenizer);
			parts[name] = fitted;
			available -= tokenizer.countTokens(fitted);
		}
	}
	return { ok: true, parts };
}
