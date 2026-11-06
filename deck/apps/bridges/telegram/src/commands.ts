import { parseSettingsToml, patchSettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { renderTomlFrontmatter, splitTomlFrontmatter } from "@oh-my-pi/pi-utils/toml-frontmatter";
import type { TelegramMessage } from "./telegram.ts";
import type { TelegramBridgeConfig } from "./config.ts";
import type { SessionSummary } from "@npi-deck/protocol";
import type { ChatSessionMapping } from "./store.ts";

export interface BotIdentity {
	id: number;
	username: string;
}
export interface Command {
	name: string;
	args: string;
}

export function parseCommand(text: string, username: string): Command | undefined {
	const match = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
	if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return undefined;
	return { name: match[1]!.toLowerCase(), args: (match[3] ?? "").trim() };
}

export function effectiveThreadId(message: TelegramMessage): number | undefined {
	if (message.chat.is_forum) return message.message_thread_id ?? 1;
	return message.is_topic_message ? message.message_thread_id : undefined;
}

export function conversationKey(message: TelegramMessage): string {
	if (message.direct_messages_topic) return `${message.chat.id}:dm:${message.direct_messages_topic.topic_id}`;
	const thread = effectiveThreadId(message);
	return thread === undefined ? String(message.chat.id) : `${message.chat.id}:${thread}`;
}

/** Authorization precedes invocation, attachment downloads and session access. */
export function invokedText(
	message: TelegramMessage,
	config: TelegramBridgeConfig,
	bot: BotIdentity,
	paired = false,
): string | undefined {
	if (!message.from || message.from.is_bot || !(paired || config.allowedUserIds.has(String(message.from.id))))
		return undefined;
	const text = (message.text ?? message.caption ?? "").trim();
	if (message.chat.type === "private") {
		if (/^\/[a-z][a-z0-9_]*@/i.test(text) && !parseCommand(text, bot.username)) return undefined;
		return text;
	}
	if (!["group", "supergroup"].includes(message.chat.type) || !config.allowedChatIds.has(String(message.chat.id)))
		return undefined;
	const thread = effectiveThreadId(message);
	const topic = String(thread ?? 1);
	const scopedTopic = `${message.chat.id}:${topic}`;
	const matchesTopic = (topics: Set<string>) => topics.has(topic) || topics.has(scopedTopic);
	if (
		(thread !== undefined && matchesTopic(config.ignoredTopics)) ||
		(config.allowedTopics.size && !matchesTopic(config.allowedTopics))
	)
		return undefined;
	if (/^\//.test(text)) return parseCommand(text, bot.username) ? text : undefined;
	const mention = new RegExp(`^@${bot.username}(?=\\s|$)`, "i");
	const mentioned = mention.test(text);
	const freeResponse =
		config.freeResponseChatIds.has(String(message.chat.id)) || config.freeResponseTopics.has(scopedTopic);
	const wakeWord = config.mentionPatterns.some(pattern => pattern.test(text));
	if (
		config.requireMention &&
		!freeResponse &&
		!wakeWord &&
		!mentioned &&
		message.reply_to_message?.from?.id !== bot.id
	)
		return undefined;
	return text;
}

export interface RetainedSession {
	mapping: ChatSessionMapping;
	title?: string;
}

/** Enrich only this lane's retained history, never enumerate another lane's sessions. */
export function retainedSessions(mappings: ChatSessionMapping[], sessions: SessionSummary[]): RetainedSession[] {
	const titles = new Map(sessions.map(session => [session.id, session.title]));
	return mappings.map(mapping => ({ mapping, title: titles.get(mapping.sessionId) }));
}

export function selectRetainedSession(sessions: RetainedSession[], selector: string): ChatSessionMapping {
	const exactId = sessions.find(session => session.mapping.sessionId === selector);
	if (exactId) return exactId.mapping;
	if (/^[1-9]\d*$/.test(selector)) {
		const numbered = sessions[Number(selector) - 1];
		if (numbered) return numbered.mapping;
	}
	const named = sessions.filter(session => session.title?.toLowerCase() === selector.toLowerCase());
	if (named.length === 1) return named[0]!.mapping;
	if (named.length > 1)
		throw new Error("More than one retained session has that title. Use /sessions and select a number or exact ID.");
	throw new Error("Select a retained session by ID, exact title or number from this conversation's /sessions.");
}

export function unsupportedAttachments(message: TelegramMessage): string[] {
	return [
		"document",
		"audio",
		"voice",
		"video",
		"video_note",
		"animation",
		"sticker",
		"contact",
		"poll",
		"dice",
		"paid_media",
	].filter(kind => message[kind as keyof TelegramMessage] !== undefined);
}

export interface IntakeCard {
	title: string;
	body: string;
	cwd?: string;
	stateId?: string;
}

export function parseProperties(text: string): Record<string, unknown> {
	try {
		return parseSettingsToml(text);
	} catch {
		throw new Error("Card properties must be valid TOML with unique keys.");
	}
}

/** First-pass decomposition is deterministic: explicit list items become cards, prose stays one card. */
export function decomposeTask(text: string, defaults: Record<string, unknown> = {}): IntakeCard[] {
	let body = text.trim();
	let properties = defaults;
	let sourceHeader = "";
	if (/^---\r?\n/.test(body)) throw new Error("Use +++ TOML front matter for card properties.");
	if (/^\+\+\+\r?\n/.test(body)) {
		const parsed = splitTomlFrontmatter(body, parseProperties)!;
		sourceHeader = parsed.header;
		properties = { ...defaults, ...parsed.properties };
		body = parsed.content.trim();
	}
	if (!body) throw new Error("Send a task description after the card properties.");
	if (properties["read-only"] !== undefined && typeof properties["read-only"] !== "boolean")
		throw new Error("read-only must be true or false.");
	for (const key of ["worktree", "model", "role", "cwd", "stateId"]) {
		if (properties[key] !== undefined && (typeof properties[key] !== "string" || !properties[key].trim()))
			throw new Error(`${key} must be a nonempty string.`);
	}
	const lines = body.split("\n");
	const list = lines.flatMap((line, index) => {
		const item = /^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(\S.*)$/.exec(line);
		return item ? [{ index, text: item[1]! }] : [];
	});
	const parts =
		list.length > 1
			? list.map((item, i) => ({
					title: item.text,
					body: [
						...lines.slice(0, list[0]!.index),
						item.text,
						...lines.slice(item.index + 1, list[i + 1]?.index ?? lines.length),
					]
						.join("\n")
						.trim(),
				}))
			: [{ title: body.split("\n")[0]!, body }];
	const { cwd, stateId, ...metadata } = properties;
	const header =
		Object.keys(metadata).length || sourceHeader
			? renderTomlFrontmatter(patchSettingsToml(sourceHeader, metadata), "\n")
			: "";
	return parts.map(part => ({
		title: part.title.slice(0, 200),
		body: `${header}${part.body}`,
		...(typeof cwd === "string" ? { cwd } : {}),
		...(typeof stateId === "string" ? { stateId } : {}),
	}));
}

export const HELP = `NPI deck inbox — tasks become kanban cards, not immediate executions.
Send a task, or a numbered/checklist list for multiple cards.
/task <text> — file task cards
/capture <text> — save an unprocessed inbox capture
/inbox — show unprocessed inbox items
/properties <TOML> — set this chat/topic's default card front matter; /properties clear removes defaults
/chat <text> — explicitly chat with the bound persistent NeoPi session (photos supported)
/session or /status — show binding
/sessions [search <query>] — list/search this conversation's retained sessions; /sessions <ID|title|number> resumes
/bind <session ID> — bind an existing deck session
/resume <ID|title|number> — resume from this conversation's latest session listing
/new or /reset — fresh binding, retaining old transcript
/stop — abort the current NeoPi turn
/title [name] — show or rename the current session title
/model <provider/model> — select session model; /model lists models
/compact [focus] — compact session context
/help or /commands — this help
Use +++ TOML front matter before a task to set read-only, worktree, model, role or any other card property. Execution is managed separately by the deck.`;
