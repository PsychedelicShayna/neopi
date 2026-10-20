import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { prompt } from "@oh-my-pi/pi-utils";
import bundledAnalysisPrompt from "./prompts/analysis.md" with { type: "text" };
import bundledFastPrompt from "./prompts/fast.md" with { type: "text" };
import bundledMapPrompt from "./prompts/map.md" with { type: "text" };
import bundledReducePrompt from "./prompts/reduce.md" with { type: "text" };
import bundledSummaryPrompt from "./prompts/summary.md" with { type: "text" };
import bundledSummaryRewritePrompt from "./prompts/summary-rewrite.md" with { type: "text" };

/** Prompt families used by llm-git's standard commit algorithm. */
export type ConventionalPromptFamily = "analysis" | "fast" | "map" | "reduce" | "summary" | "summary-rewrite";

const PROMPT_BY_FAMILY: Record<ConventionalPromptFamily, string> = {
	get analysis() {
		return resolvePromptAsset("commit/conventional/analysis.md", bundledAnalysisPrompt).text;
	},
	get fast() {
		return resolvePromptAsset("commit/conventional/fast.md", bundledFastPrompt).text;
	},
	get map() {
		return resolvePromptAsset("commit/conventional/map.md", bundledMapPrompt).text;
	},
	get reduce() {
		return resolvePromptAsset("commit/conventional/reduce.md", bundledReducePrompt).text;
	},
	get summary() {
		return resolvePromptAsset("commit/conventional/summary.md", bundledSummaryPrompt).text;
	},
	get "summary-rewrite"() {
		return resolvePromptAsset("commit/conventional/summary-rewrite.md", bundledSummaryRewritePrompt).text;
	},
};

const USER_SEPARATOR = "<!-- USER -->";

/** Render a static system section and Handlebars-templated user section. */
export function renderConventionalPrompt(
	family: ConventionalPromptFamily,
	context: prompt.TemplateContext = {},
): { system: string; user: string } {
	const template = PROMPT_BY_FAMILY[family];
	const separator = template.indexOf(USER_SEPARATOR);
	if (separator < 0) return { system: "", user: prompt.render(template, context).trim() };
	const system = template.slice(0, separator).trim();
	const userTemplate = template.slice(separator + USER_SEPARATOR.length);
	return { system, user: prompt.render(userTemplate, context).trim() };
}
