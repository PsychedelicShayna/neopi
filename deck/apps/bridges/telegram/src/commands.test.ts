import { describe, expect, test } from "bun:test";
import { splitTomlFrontmatter } from "@oh-my-pi/pi-utils/toml-frontmatter";
import {
	conversationKey,
	decomposeTask,
	invokedText,
	parseCommand,
	parseProperties,
	retainedSessions,
	selectRetainedSession,
} from "./commands.ts";
import type { TelegramBridgeConfig } from "./config.ts";
import type { TelegramMessage } from "./telegram.ts";
import { parseMentionPatterns, parseTopics } from "./config.ts";

const config: TelegramBridgeConfig = {
	botToken: "offline",
	allowedUserIds: new Set(["7"]),
	allowedChatIds: new Set(["-10"]),
	requireMention: true,
	mentionPatterns: [],
	freeResponseChatIds: new Set(),
	freeResponseTopics: new Set(),
	allowedTopics: new Set(),
	ignoredTopics: new Set(),
	deckApiBase: "http://127.0.0.1:1",
	deckWsUrl: "ws://127.0.0.1:1/ws",
	dbPath: ":memory:",
	defaultCwd: "/project",
	pollTimeoutSeconds: 1,
	editIntervalMs: 250,
};
const bot = { id: 99, username: "deck_bot" };
const group: TelegramMessage = {
	message_id: 1,
	chat: { id: -10, type: "supergroup", is_forum: true },
	from: { id: 7 },
	text: "/task@deck_bot investigate",
};

describe("command parsing and authorization", () => {
	test("parses addressed commands and multiline TOML without admitting another bot", () => {
		expect(parseCommand(" /TASK@Deck_Bot\n+++\nread-only = true\n+++\nResearch", bot.username)).toEqual({
			name: "task",
			args: "+++\nread-only = true\n+++\nResearch",
		});
		expect(parseCommand("/reset@other_bot", bot.username)).toBeUndefined();
		expect(parseCommand("/resettable", bot.username)?.name).toBe("resettable");
		expect(parseCommand("ordinary /reset", bot.username)).toBeUndefined();
	});
	test("requires allowed sender AND group, including for commands", () => {
		expect(invokedText(group, config, bot)).toBe(group.text);
		expect(invokedText({ ...group, from: { id: 8 } }, config, bot)).toBeUndefined();
		expect(invokedText({ ...group, chat: { id: -11, type: "group" } }, config, bot)).toBeUndefined();
		expect(invokedText({ ...group, from: { id: 7, is_bot: true } }, config, bot)).toBeUndefined();
		expect(invokedText({ ...group, from: undefined }, config, bot)).toBeUndefined();
		expect(invokedText({ ...group, text: "/task@other_bot steal" }, config, bot)).toBeUndefined();
	});
	test("drops ambient conversation and admits only mentions or replies by default", () => {
		expect(invokedText({ ...group, text: "ordinary chat" }, config, bot)).toBeUndefined();
		expect(invokedText({ ...group, text: "@deck_bot_other investigate" }, config, bot)).toBeUndefined();
		expect(invokedText({ ...group, text: "follow up", reply_to_message: { from: { id: 99 } } }, config, bot)).toBe(
			"follow up",
		);
		expect(
			invokedText({ ...group, text: "follow up", reply_to_message: { from: { id: 100 } } }, config, bot),
		).toBeUndefined();
		expect(invokedText({ ...group, text: "ordinary task" }, { ...config, requireMention: false }, bot)).toBe(
			"ordinary task",
		);
	});
	test("wake words and scoped free response never bypass authorization or topic exclusions", () => {
		const topic = { ...group, is_topic_message: true, message_thread_id: 42, text: "DECK investigate" };
		const wake = { ...config, mentionPatterns: parseMentionPatterns('["\\\\bdeck\\\\b"]') };
		expect(invokedText(topic, wake, bot)).toBe("DECK investigate");
		expect(invokedText({ ...topic, text: undefined, caption: "deck caption" }, wake, bot)).toBe("deck caption");
		expect(invokedText({ ...topic, text: "deckchair" }, wake, bot)).toBeUndefined();
		const free = { ...config, freeResponseTopics: parseTopics("-10:42", true) };
		expect(invokedText({ ...topic, text: "task" }, free, bot)).toBe("task");
		expect(invokedText({ ...topic, text: "task", message_thread_id: 43 }, free, bot)).toBeUndefined();
		expect(invokedText({ ...topic, text: "task" }, { ...config, freeResponseChatIds: new Set(["-10"]) }, bot)).toBe(
			"task",
		);
		for (const policy of [wake, free, { ...config, requireMention: false }]) {
			expect(invokedText({ ...topic, from: { id: 8 } }, policy, bot)).toBeUndefined();
			expect(invokedText({ ...topic, chat: { id: -11, type: "supergroup" } }, policy, bot)).toBeUndefined();
			expect(invokedText({ ...topic, text: "/chat@other_bot hello" }, policy, bot)).toBeUndefined();
			expect(
				invokedText({ ...topic, text: "/chat hello" }, { ...policy, ignoredTopics: parseTopics("-10:42") }, bot),
			).toBeUndefined();
			expect(
				invokedText({ ...topic, text: "/chat hello" }, { ...policy, allowedTopics: parseTopics("43") }, bot),
			).toBeUndefined();
		}
		expect(invokedText(group, { ...config, allowedTopics: parseTopics("1") }, bot)).toBe(group.text);
		expect(
			invokedText(group, { ...config, allowedTopics: parseTopics("1"), ignoredTopics: parseTopics("1") }, bot),
		).toBeUndefined();
		expect(
			invokedText(
				{ ...group, chat: { id: 7, type: "private" } },
				{ ...config, allowedTopics: parseTopics("42"), ignoredTopics: parseTopics("1") },
				bot,
			),
		).toBe(group.text);
		const plainGroup = { ...group, chat: { id: -10, type: "group" }, message_thread_id: 123 };
		expect(invokedText(plainGroup, { ...config, ignoredTopics: parseTopics("1,123") }, bot)).toBe(group.text);
		expect(invokedText(plainGroup, { ...config, allowedTopics: parseTopics("123") }, bot)).toBeUndefined();
		expect(invokedText(topic, { ...config, mentionPatterns: parseMentionPatterns("[Dd]eck") }, bot)).toBe(
			"DECK investigate",
		);
	});
	test("invalid invocation configuration refuses ambiguous or broken gates", () => {
		expect(() => parseTopics("42", true)).toThrow("pairs");
		expect(() => parseTopics("-10:0")).toThrow("positive");
		expect(() => parseMentionPatterns('["["]')).toThrow("invalid regex");
		expect(() => parseMentionPatterns("[3]")).toThrow("nonempty regex");
	});
});

describe("conversation lanes", () => {
	test("normalizes forum General and isolates topics from chats and native DM lanes", () => {
		expect(conversationKey(group)).toBe("-10:1");
		expect(conversationKey({ ...group, is_topic_message: true, message_thread_id: 1 })).toBe("-10:1");
		expect(conversationKey({ ...group, is_topic_message: true, message_thread_id: 42 })).toBe("-10:42");
		const dm = { ...group, chat: { id: 7, type: "private" } };
		expect(conversationKey({ ...dm, message_thread_id: 42 })).toBe("7");
		expect(conversationKey({ ...dm, is_topic_message: true, message_thread_id: 42 })).toBe("7:42");
		expect(conversationKey({ ...dm, direct_messages_topic: { topic_id: 42 } })).toBe("7:dm:42");
		expect(conversationKey({ ...group, chat: { id: -10, type: "group" }, message_thread_id: 42 })).toBe("-10");
	});
});

describe("task decomposition", () => {
	test("retains all metadata on each card, merging overrides without losing custom values", () => {
		const cards = decomposeTask(
			"+++\n# keep this comment\nread-only = true\nworktree = '/linked'\nmodel = 'provider/model'\nrole = 'researcher'\ncustom = { tags = ['routing', 'sessions'] }\ncwd = '/project'\nstateId = 's_ready'\n+++\nInvestigate:\n1. Trace ingress\n   Keep source quotes\n2. Check lifecycle",
			{ "read-only": false, owner: "Captain" },
		);
		expect(cards.map(card => card.title)).toEqual(["Trace ingress", "Check lifecycle"]);
		for (const card of cards) {
			const end = card.body.indexOf("\n+++", 4);
			expect(parseProperties(card.body.slice(4, end))).toEqual({
				"read-only": true,
				worktree: "/linked",
				model: "provider/model",
				role: "researcher",
				custom: { tags: ["routing", "sessions"] },
				owner: "Captain",
			});
			expect(card.cwd).toBe("/project");
			expect(card.stateId).toBe("s_ready");
			expect(card.body).toContain("Investigate:");
			expect(card.body).toContain("# keep this comment");
		}
		expect(cards[0]!.body).toContain("Keep source quotes");
		expect(cards[1]!.body).not.toContain("Keep source quotes");
	});
	test("keeps prose as one card and rejects malformed execution metadata", () => {
		expect(decomposeTask("Investigate routing\nWith a detailed description")).toEqual([
			{ title: "Investigate routing", body: "Investigate routing\nWith a detailed description" },
		]);
		expect(() => decomposeTask("+++\nread-only = 'yes'\n+++\nTask")).toThrow("read-only");
		expect(() => decomposeTask("+++\nworktree = 3\n+++\nTask")).toThrow("worktree");
		expect(() => decomposeTask("+++\nrole = 'a'\nrole = 'b'\n+++\nTask")).toThrow("unique keys");
		expect(() => decomposeTask("+++\nrole = 'researcher'")).toThrow("Close");
		expect(() => decomposeTask("+++\nrole = 'researcher'\n+++")).toThrow("description");
		expect(() => decomposeTask("---\nrole: researcher\n---\nTask")).toThrow("TOML");
		expect(() => parseProperties("role: researcher")).toThrow("TOML");
	});
});

describe("retained session selection", () => {
	test("resolves title/index/ID only inside retained history and rejects ambiguous titles", () => {
		const mapping = (id: string) => ({
			chatId: "-10:42",
			sessionId: id,
			cwd: "/project",
			sessionFile: `/sessions/${id}`,
			createdAt: "1",
			updatedAt: "2",
		});
		const summary = (id: string, title: string) => ({
			id,
			title,
			cwd: "/project",
			path: `/sessions/${id}`,
			createdAt: "1",
			updatedAt: "2",
			messageCount: 1,
		});
		const sessions = retainedSessions(
			[mapping("a"), mapping("b")],
			[summary("a", "Routing"), summary("b", "Other"), summary("foreign", "Private")],
		);
		expect(selectRetainedSession(sessions, "routing").sessionId).toBe("a");
		expect(selectRetainedSession(sessions, "2").sessionId).toBe("b");
		expect(selectRetainedSession(sessions, "a").sessionId).toBe("a");
		expect(() => selectRetainedSession(sessions, "Private")).toThrow("retained");
		expect(() => selectRetainedSession(sessions, "foreign")).toThrow("retained");
		expect(() => selectRetainedSession(sessions, "0")).toThrow("retained");
		expect(() => selectRetainedSession(sessions, "3")).toThrow("retained");
		expect(() =>
			selectRetainedSession([{ ...sessions[0]! }, { ...sessions[1]!, title: "Routing" }], "Routing"),
		).toThrow("More than one");
	});
});

test("Telegram raw and default properties retain multiline fence-shaped string data", () => {
	const raw = '+++\n# retained\nnotes = """before\n+++\nafter"""\n+++\nInvestigate\n';
	const card = decomposeTask(raw)[0]!;
	const parsed = splitTomlFrontmatter(card.body, parseProperties)!;
	expect(parsed.properties.notes).toBe("before\n+++\nafter");
	expect(parsed.header).toContain("# retained\n");
	expect(parsed.content.trim()).toBe("Investigate");
	const rich = decomposeTask("Investigate", { notes: "before\n+++\nafter" })[0]!;
	expect(splitTomlFrontmatter(rich.body, parseProperties)?.properties.notes).toBe("before\n+++\nafter");
});
