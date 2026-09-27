/**
 * The outer message writer: the only thing that pushes events on a mixture's
 * outer `AssistantMessageEventStream`. Member events are never forwarded (they
 * carry member-local content indices and a member `partial`); the writer emits
 * outer indices with `partial` = the outer message, so the agent loop and wire
 * encoders index the outer message consistently.
 */
import type { Api, AssistantMessage, Model, ToolCall, Usage, UsageBreakdownEntry } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type OuterOutcome =
	| { kind: "done"; reason: "stop" | "length" | "toolUse" }
	| { kind: "error"; reason: "aborted" | "error"; message: string; status?: number; errorId?: number };

export interface OuterFinish {
	outcome: OuterOutcome;
	usage: Usage;
	usageBreakdown?: UsageBreakdownEntry[];
	responseId?: string;
}

export class OuterWriter {
	readonly stream = new AssistantMessageEventStream();
	readonly message: AssistantMessage;
	#textIndex: number | undefined;
	#textOpen = false;
	#finished = false;

	constructor(model: Model<Api>) {
		this.message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.stream.push({ type: "start", partial: this.message });
	}

	get finished(): boolean {
		return this.#finished;
	}

	/** Text emitted so far on the outer message. */
	get text(): string {
		let text = "";
		for (const block of this.message.content) if (block.type === "text") text += block.text;
		return text;
	}

	/** Append to the outer message's single text block, creating it on the first delta. */
	appendText(delta: string): void {
		if (this.#finished || !delta) return;
		if (this.#textIndex === undefined) {
			this.#textIndex = this.message.content.length;
			this.message.content.push({ type: "text", text: "" });
			this.#textOpen = true;
			this.stream.push({ type: "text_start", contentIndex: this.#textIndex, partial: this.message });
		}
		const block = this.message.content[this.#textIndex];
		if (block?.type !== "text") return;
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.#textIndex, delta, partial: this.message });
	}

	endText(): void {
		if (this.#textIndex === undefined || !this.#textOpen) return;
		this.#textOpen = false;
		const block = this.message.content[this.#textIndex];
		if (block?.type !== "text") return;
		this.stream.push({ type: "text_end", contentIndex: this.#textIndex, content: block.text, partial: this.message });
	}

	/** Append a complete, executable tool call with its outer id. */
	toolCall(call: ToolCall): void {
		if (this.#finished) return;
		this.endText();
		const index = this.message.content.length;
		this.message.content.push(call);
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
		this.stream.push({
			type: "toolcall_delta",
			contentIndex: index,
			delta: JSON.stringify(call.arguments),
			partial: this.message,
		});
		this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: this.message });
	}

	/** Push exactly one terminal event. */
	finish(finish: OuterFinish): void {
		if (this.#finished) return;
		this.endText();
		this.#finished = true;
		const message = this.message;
		message.usage = finish.usage;
		if (finish.usageBreakdown && finish.usageBreakdown.length > 0) message.usageBreakdown = finish.usageBreakdown;
		if (finish.responseId) message.responseId = finish.responseId;
		const outcome = finish.outcome;
		if (outcome.kind === "done") {
			message.stopReason = outcome.reason;
			this.stream.push({ type: "done", reason: outcome.reason, message });
			return;
		}
		message.stopReason = outcome.reason;
		message.errorMessage = outcome.message;
		if (outcome.status !== undefined) message.errorStatus = outcome.status;
		if (outcome.errorId !== undefined) message.errorId = outcome.errorId;
		this.stream.push({ type: "error", reason: outcome.reason, error: message });
	}
}
