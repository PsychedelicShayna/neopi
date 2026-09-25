import { prompt } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import chatModePrompt from "../prompts/chat/chat.md" with { type: "text" };
import chatAdvisorTemplate from "../prompts/chat/advisor.md" with { type: "text" };
import chatCompactionTemplate from "../prompts/chat/compaction.md" with { type: "text" };
import erpModePrompt from "../prompts/chat/erp.md" with { type: "text" };
import chatSystemTemplate from "../prompts/chat/system.md" with { type: "text" };
import { normalizePromptPath } from "../utils/prompt-path";
import { type ChatMode, type ChatModeConfig, chatModeIncludes } from "./chat-mode";

const MODE_PROMPTS: Record<ChatMode, string> = { chat: chatModePrompt, erp: erpModePrompt, raw: "" };

export interface ChatSystemPromptInput {
	config: ChatModeConfig;
	/** Explicit `--system-prompt` text; replaces the mode's built-in prompt. */
	customPrompt?: string;
	/** `--append-system-prompt` text plus any re-included generated blocks (memory). */
	appendPrompt?: string;
	contextFiles: ReadonlyArray<{ path: string; content: string }>;
	cwd: string;
	/** Tools granted to the session; a filesystem tool exposes the working directory. */
	toolNames: readonly string[];
	skills: readonly Skill[];
	rules: readonly Rule[];
}

/**
 * Provider-facing system prompt for a chat-mode session: the mode prompt plus
 * only the categories the session keeps. Returns no blocks when nothing
 * remains (raw mode without prompt flags), so the request carries no system
 * prompt at all.
 */
export function buildChatSystemPrompt(input: ChatSystemPromptInput): string[] {
	const { config, toolNames } = input;
	const rendered = prompt
		.render(chatSystemTemplate, {
			modePrompt: (input.customPrompt ?? MODE_PROMPTS[config.mode]).trim(),
			contextFiles: chatModeIncludes(config, "contextFiles", toolNames) ? input.contextFiles : [],
			cwd: chatModeIncludes(config, "cwd", toolNames) ? normalizePromptPath(input.cwd) : "",
			skills: chatModeIncludes(config, "skills", toolNames) ? input.skills.filter(skill => skill.hide !== true) : [],
			rules: chatModeIncludes(config, "rules", toolNames) ? input.rules : [],
			appendPrompt: input.appendPrompt?.trim() ?? "",
		})
		.trim();
	return rendered.length > 0 ? [rendered] : [];
}

/**
 * Default advisor system prompt in chat mode: spectators of the conversation
 * rather than code reviewers. Raw mode has no framing of its own and uses the
 * neutral chat variant.
 */
export function renderChatAdvisorPrompt(mode: ChatMode, maxNotesPerUpdate: number | undefined): string {
	return prompt.render(chatAdvisorTemplate, { erp: mode === "erp", max_notes_per_update: maxNotesPerUpdate });
}

/**
 * Narrative-preserving compaction prompt for chat and erp sessions. Raw mode
 * keeps the stock summary prompt.
 */
export function renderChatCompactionPrompt(mode: ChatMode): string | undefined {
	if (mode === "raw") return undefined;
	return prompt.render(chatCompactionTemplate, { erp: mode === "erp" });
}
