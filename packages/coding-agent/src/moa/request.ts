/**
 * Request identity and anchoring (step 0 of the turn algorithm). The engine
 * receives the post-conversion context, so everything here works on
 * `Message[]`. A request's identity (`lastRequest`) is separate from the
 * committed consumption boundary (`cursor`): a repeat is recognised before the
 * cursor is consulted, whether or not the previous response was committed.
 */
import type { ImageContent, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ConsumptionBoundary, MixtureRun } from "./types";

function digest(value: string): string {
	return Bun.hash(value).toString(16);
}

function blockProjection(block: {
	type: string;
	text?: string;
	data?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}) {
	switch (block.type) {
		case "text":
			return ["t", block.text ?? ""];
		case "image":
			return ["i", digest(block.data ?? "")];
		case "toolCall":
			return ["c", block.id ?? "", block.name ?? "", JSON.stringify(block.arguments ?? {})];
		default:
			return undefined;
	}
}

/**
 * Wire-neutral projection of one message: role and replayable content only.
 * Timestamps, usage, response ids, and provider payloads are left out because
 * wires rebuild or drop them.
 */
function messageProjection(message: Message): unknown[] {
	if (message.role === "toolResult") {
		return ["toolResult", message.toolCallId, ...message.content.map(blockProjection)];
	}
	if (message.role === "assistant") {
		return ["assistant", ...message.content.map(blockProjection).filter(block => block !== undefined)];
	}
	const content =
		typeof message.content === "string" ? [["t", message.content]] : message.content.map(blockProjection);
	return [message.role, ...content];
}

export function hashMessages(messages: readonly Message[]): string {
	return digest(JSON.stringify(messages.map(messageProjection)));
}

export function textHash(text: string): string {
	return digest(text);
}

export function assistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}

function userText(message: Message): string {
	if (message.role !== "user" && message.role !== "developer") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.flatMap(block => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

/** The request's full input as a boundary the cursor can later advance to. */
export function consumptionOf(messages: readonly Message[]): ConsumptionBoundary {
	return { count: messages.length, hash: hashMessages(messages) };
}

/**
 * Step 0a: whether `messages` repeats the run's last request. Re-derives that
 * request's tail against the prefix it was computed on; reads only `lastRequest`.
 */
export function isRepeatRequest(run: MixtureRun, messages: readonly Message[]): boolean {
	const last = run.lastRequest;
	if (last.consumedCount > messages.length) return false;
	if (hashMessages(messages.slice(0, last.consumedCount)) !== last.consumedHash) return false;
	return hashMessages(messages.slice(last.consumedCount)) === last.fingerprint;
}

export type AnchorKind = "responseId" | "cursor" | "text" | "none";

/**
 * Step 0b: the index of the last message the run already consumed, found by
 * (1) an outer `responseId`, (2) the committed cursor, (3) the text of the
 * newest outer response, else none (`-1`, the whole list is the tail).
 */
export function findAnchor(run: MixtureRun, messages: readonly Message[]): { index: number; kind: AnchorKind } {
	const responseIds = new Set(run.outerResponses.map(response => response.responseId));
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant" && message.responseId && responseIds.has(message.responseId)) {
			return { index, kind: "responseId" };
		}
	}
	const cursor = run.cursor;
	if (cursor && cursor.count <= messages.length && hashMessages(messages.slice(0, cursor.count)) === cursor.hash) {
		return { index: cursor.count - 1, kind: "cursor" };
	}
	const newest = run.outerResponses.at(-1);
	if (newest) {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role === "assistant" && textHash(assistantText(message)) === newest.textHash) {
				return { index, kind: "text" };
			}
		}
	}
	return { index: -1, kind: "none" };
}

export interface ClassifiedTail {
	/** The operator's prompt: the trailing run of user messages, folded in order. */
	operator?: { text: string; images: ImageContent[]; index: number };
	toolResults: ToolResultMessage[];
}

/**
 * Walk a tail. `toolResult` messages are collected; developer messages and
 * history-rewrite summaries are ignored for classification; the user messages
 * after the tail's last assistant message form the operator prompt (queued
 * prompts fold in order). Earlier tail history is conversation, not prompt.
 */
export function classifyTail(tail: readonly Message[]): ClassifiedTail {
	const toolResults: ToolResultMessage[] = [];
	let operatorStart = -1;
	tail.forEach((message, index) => {
		if (message.role === "toolResult") toolResults.push(message);
		if (message.role === "assistant") operatorStart = -1;
		if (message.role === "user" && message.historyRewriteAt === undefined && operatorStart < 0) operatorStart = index;
	});
	if (operatorStart < 0) return { toolResults };
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const message of tail.slice(operatorStart)) {
		if (message.role !== "user" || message.historyRewriteAt !== undefined) continue;
		const text = userText(message);
		if (text) texts.push(text);
		if (typeof message.content !== "string") {
			for (const block of message.content) if (block.type === "image") images.push(block);
		}
	}
	return { operator: { text: texts.join("\n\n"), images, index: operatorStart }, toolResults };
}

/**
 * `{{conversation}}`: operator-facing history before the prompt: user text and
 * assistant text, thinking and tool traffic excluded, compaction summaries
 * included as text.
 */
export function conversationText(messages: readonly Message[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = userText(message);
			if (text) lines.push(`${message.historyRewriteAt !== undefined ? "Summary" : "User"}: ${text}`);
		} else if (message.role === "assistant") {
			const text = assistantText(message).trim();
			if (text) lines.push(`Assistant: ${text}`);
		}
	}
	return lines.join("\n\n");
}
