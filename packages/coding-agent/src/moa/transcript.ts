import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import type { HopRecord } from "./types";

/** Only completed outputs cross a transcript edge; never replay the input envelope. */
export function transcriptHeader(hop: Pick<HopRecord, "index" | "memberId" | "edgeInId">): string {
	return `[hop ${hop.index} · ${hop.memberId} ← ${hop.edgeInId ?? "entry"}]`;
}

export function renderTranscript(hops: readonly HopRecord[]): string {
	return hops
		.filter(hop => hop.status === "done")
		.map(hop => `${transcriptHeader(hop)}\n${hop.output}`)
		.join("\n\n");
}

export function transcriptMessages(hops: readonly HopRecord[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const hop of hops) {
		if (hop.status !== "done") continue;
		messages.push({ role: "user", content: transcriptHeader(hop), timestamp: 0 });
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: hop.output }],
			api: "",
			provider: "",
			model: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		});
	}
	return messages;
}

export function toolCallSummaries(messages: readonly Message[]): { name: string; summary: string }[] {
	const calls: { name: string; summary: string }[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const intent = block.arguments.i ?? block.arguments.intent;
			calls.push({
				name: block.name,
				summary: typeof intent === "string" ? intent : JSON.stringify(block.arguments).slice(0, 120),
			});
		}
	}
	return calls;
}
