/**
 * Runs a post-processing chain: each step is one bare model pass whose system
 * prompt is the step's `systemPrompt` (or the bundled chain default) followed
 * by the step prompt, and whose user message is the previous step's output
 * (the composer text for the first step). The last output is returned.
 */
import { Agent, type AgentMessage, type AgentTool, ThinkingLevel, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type Message, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import type { ChainConfig, ChainStep } from "@oh-my-pi/pi-tui/overlays/chain-types";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelRoleAlias } from "../config/model-roles";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import chainInputWithContext from "../prompts/chains/input-with-context.md" with { type: "text" };
import { obfuscateMessages, obfuscateProviderContext } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import chainSystemPrompt from "../prompts/chains/system.md" with { type: "text" };
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";

/** Model role a step falls back to when it names no model. */
export const CHAIN_DEFAULT_ROLE = "prose";

/** Bundled system prompt a step uses when it sets no `systemPrompt` override. */
export const CHAIN_SYSTEM_PROMPT = chainSystemPrompt;

const CHAIN_SKIP = "chain step skipped";
/** Tokens kept free for message framing when fitting the transcript; tool schemas are counted. */
const CHAIN_FRAMING_RESERVE = 1_000;
/** Output room reserved when the model reports no output limit. */
const CHAIN_DEFAULT_OUTPUT_RESERVE = 8_192;
const CHAIN_ABORT = "chain aborted";

/** Cancels a running chain as a whole or skips just the step in flight. */
export class ChainControl {
	readonly #chain = new AbortController();
	#step: AbortController | undefined;

	get signal(): AbortSignal {
		return this.#chain.signal;
	}

	/** Abort the whole chain; the caller restores the typed draft. */
	abort(): void {
		this.#chain.abort(CHAIN_ABORT);
		this.#step?.abort(CHAIN_ABORT);
	}

	/** Abort only the step in flight; its input passes through unchanged. No-op between steps. */
	skipStep(): void {
		this.#step?.abort(CHAIN_SKIP);
	}

	/** @internal Runner: fresh per-step signal, pre-aborted when the chain is already aborted. */
	beginStep(): AbortSignal {
		this.#step = new AbortController();
		if (this.#chain.signal.aborted) this.#step.abort(CHAIN_ABORT);
		return this.#step.signal;
	}

	/** @internal Runner: drop the step controller so a late `skipStep()` cannot hit a finished step. */
	endStep(): void {
		this.#step = undefined;
	}
}

export interface RunChainOptions {
	settings: Settings;
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "resolver">;
	/** The session's tool instances; each step receives only the ones it names. */
	tools: readonly AgentTool[];
	cwd: string;
	/** Live primary transcript, rendered into steps that set `context`. */
	messages?: readonly AgentMessage[];
	/** The session's secret obfuscator: steps send what the primary session would, never more. */
	obfuscator?: SecretObfuscator;
	/** Skip/abort handle; a private one is used when omitted. */
	control?: ChainControl;
	/** Called before each step starts, for progress display. */
	onStep?: (step: ChainStep, index: number, total: number) => void;
	/** Called after a step completes with its output. */
	onStepDone?: (step: ChainStep, index: number, output: string) => void;
	/** Called when a step was skipped; its input passes to the next step unchanged. */
	onStepSkipped?: (step: ChainStep, index: number) => void;
}

/**
 * The rendered transcript of the newest messages whose rendering fits `budget` tokens. The
 * rendered form is what the step reads (tool results collapsed, reasoning elided), so it is what
 * gets measured. Older history is dropped first: a draft's references almost always point at the
 * most recent turns.
 */
function fitTranscript(messages: readonly AgentMessage[], budget: number, tokenizer: Tokenizer): string {
	const render = (start: number) => formatSessionHistoryMarkdown(messages.slice(start) as unknown[]).trim();
	// Smallest start index whose rendering fits; rendering size only shrinks as start grows.
	let low = 0;
	let high = messages.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (tokenizer.countTokens(render(mid)) <= budget) high = mid;
		else low = mid + 1;
	}
	return low < messages.length ? render(low) : "";
}

/** A boundary token that occurs in none of `texts`, so embedded tag-like text cannot close a block. */
function blockBoundary(texts: readonly string[]): string {
	for (;;) {
		const boundary = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
		if (!texts.some(text => text.includes(boundary))) return boundary;
	}
}

/**
 * The user message for a step: the draft, wrapped with the transcript when the step ingests
 * context. With a model, the transcript keeps only the newest messages that fit its context
 * window after the system prompt, the granted tools' schemas, the draft, output, and framing
 * are reserved.
 */
export function renderChainInput(
	step: ChainStep,
	input: string,
	messages: readonly AgentMessage[] | undefined,
	model?: Pick<Model, "contextWindow" | "maxTokens" | "tokenizer">,
	tools: readonly AgentTool[] = [],
): string {
	if (!step.context || !messages?.length) return input;
	let transcript: string;
	if (model?.contextWindow) {
		const tokenizer = new Tokenizer(model);
		const system = step.systemPrompt ?? CHAIN_SYSTEM_PROMPT;
		const reserved =
			tokenizer.countTokens([system, step.prompt, input]) +
			estimateToolSchemaTokens(tools, tokenizer) +
			Math.min(model.maxTokens || CHAIN_DEFAULT_OUTPUT_RESERVE, Math.floor(model.contextWindow / 4)) +
			CHAIN_FRAMING_RESERVE;
		transcript = fitTranscript(messages, Math.max(0, model.contextWindow - reserved), tokenizer);
	} else {
		transcript = formatSessionHistoryMarkdown(messages as unknown[]).trim();
	}
	if (!transcript) return input;
	// compile, not render: the post-render formatter would rewrite the draft's whitespace and tables.
	return prompt
		.compile(chainInputWithContext)({ transcript, draft: input, boundary: blockBoundary([transcript, input]) })
		.trimEnd();
}

/**
 * `message` with its operator-visible text redacted and its structure (roles, block types, ids,
 * custom types) untouched, so the transcript formatter still recognizes it. Standard provider
 * messages go through the session's own transform; other kinds redact their text fields.
 */
function redactMessageText(obfuscator: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer":
		case "assistant":
		case "toolResult":
			return obfuscateMessages(obfuscator, [message as Message])[0] as AgentMessage;
	}
	const redacted: Record<string, unknown> = { ...message };
	for (const field of ["content", "summary", "shortSummary", "command", "output"]) {
		const value = redacted[field];
		if (typeof value === "string") {
			redacted[field] = obfuscator.obfuscate(value);
		} else if (Array.isArray(value)) {
			redacted[field] = value.map(block =>
				block && typeof block === "object" && (block as { type?: unknown }).type === "text"
					? { ...block, text: obfuscator.obfuscate(String((block as { text?: unknown }).text ?? "")) }
					: block,
			);
		}
	}
	return redacted as unknown as AgentMessage;
}

/** Run one step over `input` and return the model's final text. */
export async function runChainStep(
	step: ChainStep,
	input: string,
	options: RunChainOptions,
	signal?: AbortSignal,
): Promise<string> {
	// `agent.abort` is a no-op before `prompt` starts, and a listener never replays an earlier abort.
	signal?.throwIfAborted();
	const selector = step.model ?? formatModelRoleAlias(CHAIN_DEFAULT_ROLE);
	const resolved = resolveModelRoleValue(selector, options.modelRegistry.getAvailable(), {
		settings: options.settings,
		matchPreferences: getModelMatchPreferences(options.settings),
	});
	if (!resolved.model) throw new Error(`Chain step "${step.name}": no model available for ${selector}`);
	// Without an explicit level the model's own default applies.
	const requested = concreteThinkingLevel(resolved.thinkingLevel);
	const thinkingLevel =
		(requested && resolveThinkingLevelForModel(resolved.model, requested)) ?? ThinkingLevel.Inherit;

	const granted = new Set(step.tools ?? []);
	const tools = options.tools.filter(tool => granted.has(tool.name));
	const providerSessionId = Bun.randomUUIDv7();
	const obfuscator = options.obfuscator;
	const hidesSecrets = obfuscator?.obfuscates() === true;
	const agent = new Agent({
		initialState: {
			systemPrompt: [step.systemPrompt ?? CHAIN_SYSTEM_PROMPT, step.prompt],
			model: resolved.model,
			thinkingLevel: toReasoningEffort(thinkingLevel),
			tools,
		},
		sessionId: providerSessionId,
		cwdResolver: () => options.cwd,
		getApiKey: requestModel => options.modelRegistry.resolver(requestModel, providerSessionId),
		// Same provider boundary as the primary session: configured secrets leave as placeholders.
		streamFn: hidesSecrets
			? (streamModel, context, streamOptions) =>
					streamSimple(streamModel, obfuscateProviderContext(obfuscator, context), streamOptions)
			: streamSimple,
		intentTracing: false,
	});
	agent.setDisableReasoning(shouldDisableReasoning(thinkingLevel));

	const onAbort = () => agent.abort("chain cancelled");
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		// Redact before rendering: the transcript formatter truncates text, which can cut a secret
		// pattern's delimiters so a later pass on the rendered text no longer matches it.
		const messages =
			hidesSecrets && obfuscator && options.messages
				? options.messages.map(message => redactMessageText(obfuscator, message))
				: options.messages;
		await agent.prompt(renderChainInput(step, input, messages, resolved.model, tools));
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}

	const last = agent.state.messages.findLast(message => message.role === "assistant");
	if (!last || last.role !== "assistant") throw new Error(`Chain step "${step.name}" produced no response`);
	if (last.stopReason === "error" || last.stopReason === "aborted") {
		throw new Error(`Chain step "${step.name}" failed: ${last.errorMessage ?? last.stopReason}`);
	}
	const text = last.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
	if (!text) throw new Error(`Chain step "${step.name}" returned empty text`);
	// Placeholders the model echoed back become the operator's own text again.
	return hidesSecrets && obfuscator ? obfuscator.deobfuscate(text) : text;
}

/**
 * Pass `text` through every step of `chain` in order and return the last output.
 * A skipped step passes its input through; an aborted chain rejects with
 * `options.control.signal.aborted` set. `runStep` is replaceable for tests.
 */
export async function runChain(
	chain: ChainConfig,
	text: string,
	options: RunChainOptions,
	runStep: typeof runChainStep = runChainStep,
): Promise<string> {
	const control = options.control ?? new ChainControl();
	let current = text;
	for (const [index, step] of chain.steps.entries()) {
		control.signal.throwIfAborted();
		// Before onStep: a skip/abort issued from the callback targets this step.
		const stepSignal = control.beginStep();
		options.onStep?.(step, index, chain.steps.length);
		let output: string;
		try {
			stepSignal.throwIfAborted();
			output = await runStep(step, current, options, stepSignal);
		} catch (error) {
			// A whole-chain abort wins even if the step signal's first reason was a skip.
			if (control.signal.aborted) throw error;
			if (stepSignal.aborted && stepSignal.reason === CHAIN_SKIP) {
				options.onStepSkipped?.(step, index);
				continue;
			}
			throw error;
		} finally {
			control.endStep();
		}
		// An abort that raced a successful completion must not be sent.
		control.signal.throwIfAborted();
		// So must a skip: the step's input passes through as promised.
		if (stepSignal.aborted && stepSignal.reason === CHAIN_SKIP) {
			options.onStepSkipped?.(step, index);
			continue;
		}
		current = output;
		options.onStepDone?.(step, index, current);
	}
	control.signal.throwIfAborted();
	return current;
}
