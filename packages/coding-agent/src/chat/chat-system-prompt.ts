import { resolvePromptAsset, renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";

import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import bundledChatModePrompt from "../prompts/chat/chat.md" with { type: "text" };
import chatAdvisorTemplate from "../prompts/chat/advisor.md" with { type: "text" };
import chatCompactionTemplate from "../prompts/chat/compaction.md" with { type: "text" };
import bundledErpModePrompt from "../prompts/chat/erp.md" with { type: "text" };
import chatSystemTemplate from "../prompts/chat/system.md" with { type: "text" };
import { normalizePromptPath } from "../utils/prompt-path";
import { type ChatMode, type ChatModeConfig, chatModeIncludes } from "./chat-mode";

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
	const modePrompt =
		input.customPrompt ??
		(config.mode === "chat"
			? resolvePromptAsset("chat/chat.md", bundledChatModePrompt, { cwd: input.cwd }).text
			: config.mode === "erp"
				? resolvePromptAsset("chat/erp.md", bundledErpModePrompt, { cwd: input.cwd }).text
				: "");
	const rendered = renderPromptAsset(
		"chat/system.md",
		chatSystemTemplate,
		{
			modePrompt: modePrompt.trim(),
			contextFiles: chatModeIncludes(config, "contextFiles", toolNames) ? input.contextFiles : [],
			cwd: chatModeIncludes(config, "cwd", toolNames) ? normalizePromptPath(input.cwd) : "",
			skills: chatModeIncludes(config, "skills", toolNames) ? input.skills.filter(skill => skill.hide !== true) : [],
			rules: chatModeIncludes(config, "rules", toolNames) ? input.rules : [],
			appendPrompt: input.appendPrompt?.trim() ?? "",
		},
		{ cwd: input.cwd },
	).trim();
	return rendered.length > 0 ? [rendered] : [];
}

/**
 * Default advisor system prompt in chat mode: spectators of the conversation
 * rather than code reviewers. Raw mode has no framing of its own and uses the
 * neutral chat variant.
 */
export function renderChatAdvisorPrompt(mode: ChatMode, maxNotesPerUpdate: number | undefined, cwd?: string): string {
	return renderPromptAsset(
		"chat/advisor.md",
		chatAdvisorTemplate,
		{ erp: mode === "erp", max_notes_per_update: maxNotesPerUpdate },
		{ cwd },
	);
}

/**
 * Narrative-preserving compaction prompt for chat and erp sessions. Raw mode
 * keeps the stock summary prompt.
 */
export function renderChatCompactionPrompt(mode: ChatMode, cwd?: string): string | undefined {
	if (mode === "raw") return undefined;
	return renderPromptAsset("chat/compaction.md", chatCompactionTemplate, { erp: mode === "erp" }, { cwd });
}
