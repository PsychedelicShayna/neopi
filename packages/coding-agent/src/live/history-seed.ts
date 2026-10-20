import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { truncateToTokens } from "../moa/budget";
import { renderClassifierProse } from "./ingest-classifier";
import historyTemplate from "./prompts/primary-history.md" with { type: "text" };
import { chunkLiveContext, CONTEXT_CHUNK_BYTES } from "./protocol";

/** Recent authored prose, oldest first, excluding tools and private reasoning.
 * Every chunk is independently marked as silent history, even across wire boundaries.
 * The strict tokenizer counts the labels as well as the captured prose. */
export function buildLiveHistorySeed(messages: readonly AgentMessage[], budget: number, cwd?: string): string[] {
	if (!Number.isSafeInteger(budget) || budget <= 0) return [];
	const tokenizer = new Tokenizer();
	const render = (message: string): string =>
		renderPromptAsset("live/primary-history.md", historyTemplate, { message }, { cwd, kind: "notice" });
	// A nonempty placeholder preserves the separator that rendering trims for empty content.
	const labelBytes = Buffer.byteLength(render("x"), "utf8") - 1;
	const pack = (text: string): string[] => chunkLiveContext(text, CONTEXT_CHUNK_BYTES - labelBytes).map(render);
	const cost = (chunks: string[]): number =>
		chunks.reduce((sum, chunk) => sum + tokenizer.countTokens(chunk, "strict"), 0);
	const chosen: string[][] = [];
	let remaining = budget;
	for (let index = messages.length - 1; index >= 0; index--) {
		const block = renderClassifierProse([messages[index]], false).blocks.join("\n");
		if (!block) continue;
		let chunks = pack(block);
		let tokens = cost(chunks);
		if (tokens > remaining) {
			// Preserve an oversized latest turn rather than falling back to unrelated older work.
			if (chosen.length) break;
			let proseBudget = Math.min(remaining, tokenizer.countTokens(block, "strict"));
			while (tokens > remaining && proseBudget > 0) {
				proseBudget = Math.floor(proseBudget * 0.8);
				const truncated = truncateToTokens(block, proseBudget, tokenizer);
				chunks = truncated ? pack(truncated) : [];
				tokens = cost(chunks);
			}
			if (chunks.length) chosen.push(chunks);
			break;
		}
		chosen.push(chunks);
		remaining -= tokens;
	}
	return chosen.reverse().flat();
}
