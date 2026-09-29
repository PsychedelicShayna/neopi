/**
 * Bottom-up node summaries: one overview plus one description per child,
 * generated only from the children's own texts and bounded so a node's whole
 * routing text fits one traversal hop.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import summaryInputTemplate from "../../prompts/chronicler/temporal/summary-input.md" with { type: "text" };
import summarySystemTemplate from "../../prompts/chronicler/temporal/summary-system.md" with { type: "text" };
import { type ChronicleModelClient, parseJsonObject } from "./model";
import { clipText } from "./tree";

/** Bump when the summary prompts or output contract change: every generated node goes stale. */
export const SUMMARY_PROMPT_VERSION = 1;

export interface SummaryNodeInput {
	key: string;
	label: string;
	level: string;
	localStart: string;
	localEnd: string;
	atomCount: number;
	projects: readonly string[];
}

export interface SummaryChildInput extends SummaryNodeInput {
	/** The child's own routing text: its overview and descriptions, or its atom enumeration. */
	text: string;
}

export interface SummaryBudget {
	overviewTokens: number;
	childTokens: number;
}

export interface SummaryOutput {
	overview: string;
	/** One description per child, in input order. */
	descriptions: string[];
	/** A field exceeded its budget and was clipped at a word boundary. */
	truncated: boolean;
}

export interface ChronicleSummarizer {
	readonly identity: string;
	summarize(
		node: SummaryNodeInput,
		children: readonly SummaryChildInput[],
		budget: SummaryBudget,
		signal?: AbortSignal,
	): Promise<SummaryOutput>;
}

function words(tokens: number): number {
	return Math.max(8, Math.floor(tokens * 0.7));
}

export function createSummarizer(client: ChronicleModelClient): ChronicleSummarizer {
	return {
		identity: client.identity,
		async summarize(node, children, budget, signal) {
			const system = prompt.render(summarySystemTemplate, {
				overviewWords: words(budget.overviewTokens),
				childWords: words(budget.childTokens),
			});
			const input = prompt.render(summaryInputTemplate, {
				...node,
				projects: node.projects.join(", ") || "none",
				children: children.map(child => ({ ...child, projects: child.projects.join(", ") || "none" })),
			});
			const maxTokens = Math.max(512, (budget.overviewTokens + budget.childTokens * children.length) * 2 + 256);
			const reply = parseJsonObject(await client.complete(system, input, maxTokens, signal));
			if (typeof reply.overview !== "string" || !Array.isArray(reply.children)) {
				throw new Error(`summary for ${node.key || "root"} lacks overview/children`);
			}
			const byKey = new Map<string, string>();
			for (const item of reply.children) {
				if (typeof item !== "object" || item === null) continue;
				const { key, description } = item as { key?: unknown; description?: unknown };
				if (typeof key === "string" && typeof description === "string") byKey.set(key, description);
			}
			let truncated = false;
			const clip = (text: string, tokens: number): string => {
				const clipped = clipText(text, tokens * 4);
				if (clipped.remainder > 0) truncated = true;
				return clipped.remainder > 0 ? `${clipped.text}…` : clipped.text;
			};
			const descriptions = children.map(child => {
				const description = byKey.get(child.key);
				if (description === undefined || description.trim().length === 0) {
					throw new Error(`summary for ${node.key || "root"} omitted child ${child.key}`);
				}
				return clip(description, budget.childTokens);
			});
			return { overview: clip(reply.overview, budget.overviewTokens), descriptions, truncated };
		},
	};
}
