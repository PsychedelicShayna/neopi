/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { CHAT_INCLUDES, CHAT_MODE_SETTING_VALUES } from "./chat-mode";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgChatMode = register({
	id: "chat.mode",
	type: "enum",
	values: CHAT_MODE_SETTING_VALUES,
	default: "off",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Chat Mode",
		description:
			"Default mode for new sessions. Chat modes strip coding-agent context (tools, skills, rules, memory, reminders); --chat overrides, resumed sessions keep their recorded mode",
		options: [
			{ value: "off", label: "Off", description: "Ordinary coding-agent session" },
			{ value: "chat", label: "Chat", description: "Conversation-first system prompt" },
			{ value: "erp", label: "ERP", description: "Explicit erotic roleplay system prompt" },
			{ value: "raw", label: "Raw", description: "Empty system prompt; only the conversation" },
		],
	},
});

export const cfgChatInclude = register({
	id: "chat.include",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Chat Mode Includes",
		description: `Context categories kept in chat mode (${CHAT_INCLUDES.join(", ")}); --chat-include overrides`,
	},
});
