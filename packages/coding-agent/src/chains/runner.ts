/**
 * Runs a post-processing chain: each step is one bare model pass whose system
 * prompt is the step's `systemPrompt` (or the bundled chain default) followed
 * by the step prompt, and whose user message is the previous step's output
 * (the composer text for the first step). The last output is returned.
 */
import { Agent, type AgentMessage, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
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
import chainSystemPrompt from "../prompts/chains/system.md" with { type: "text" };
import { formatSessionHistoryMarkdown } from "../session/session-history-format";

/** Model role a step falls back to when it names no model. */
export const CHAIN_DEFAULT_ROLE = "prose";

/** Bundled system prompt a step uses when it sets no `systemPrompt` override. */
export const CHAIN_SYSTEM_PROMPT = chainSystemPrompt;

const CHAIN_SKIP = "chain step skipped";
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
	/** Skip/abort handle; a private one is used when omitted. */
	control?: ChainControl;
	/** Called before each step starts, for progress display. */
	onStep?: (step: ChainStep, index: number, total: number) => void;
	/** Called after a step completes with its output. */
	onStepDone?: (step: ChainStep, index: number, output: string) => void;
	/** Called when a step was skipped; its input passes to the next step unchanged. */
	onStepSkipped?: (step: ChainStep, index: number) => void;
}

/** The user message for a step: the draft, wrapped with the transcript when the step ingests context. */
export function renderChainInput(step: ChainStep, input: string, messages: readonly AgentMessage[] | undefined): string {
	if (!step.context || !messages?.length) return input;
	const transcript = formatSessionHistoryMarkdown(messages as unknown[]).trim();
	if (!transcript) return input;
	return `<transcript>\n${transcript}\n</transcript>\n\n<draft>\n${input}\n</draft>`;
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
		streamFn: streamSimple,
		intentTracing: false,
	});
	agent.setDisableReasoning(shouldDisableReasoning(thinkingLevel));

	const onAbort = () => agent.abort("chain cancelled");
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await agent.prompt(renderChainInput(step, input, options.messages));
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
	return text;
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
		try {
			stepSignal.throwIfAborted();
			current = await runStep(step, current, options, stepSignal);
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
		options.onStepDone?.(step, index, current);
	}
	control.signal.throwIfAborted();
	return current;
}
