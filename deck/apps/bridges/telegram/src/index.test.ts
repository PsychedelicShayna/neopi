import { describe, expect, spyOn, test } from "bun:test";
import type { InboxItem, SessionSummary, Task } from "@npi-deck/protocol";
import { TelegramBridge } from "./index.ts";
import { DeckClient } from "./deck.ts";
import { TelegramApi, type TelegramMessage, type TelegramUpdate } from "./telegram.ts";
import { TelegramBridgeStore } from "./store.ts";
import type { TelegramBridgeConfig } from "./config.ts";
import { parseProperties, type IntakeCard } from "./commands.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
const message: TelegramMessage = {
	message_id: 1,
	chat: { id: -10, type: "supergroup", is_forum: true },
	is_topic_message: true,
	message_thread_id: 42,
	from: { id: 7 },
};

function harness(policy: TelegramBridgeConfig = config) {
	const events: string[] = [];
	const replies: string[] = [];
	const typingThreads: (number | undefined)[] = [];
	const filedCards: IntakeCard[] = [];
	let downloads = 0;
	let promptError = false;
	class Transport extends TelegramApi {
		override async sendMessage(chatId: number | string, text: string) {
			events.push("reply");
			replies.push(text);
			return { message_id: replies.length, chat: { id: Number(chatId) } };
		}
		override async editMessageText(chatId: number | string, messageId: number, text: string) {
			replies.push(text);
			return { message_id: messageId, chat: { id: Number(chatId) } };
		}
		override async sendTyping(_chatId: number | string, thread?: { message_thread_id?: number }) {
			events.push("typing");
			typingThreads.push(thread?.message_thread_id);
			return true;
		}
		override async downloadPhoto() {
			downloads++;
			return { data: "", mimeType: "image/jpeg" };
		}
	}
	class Deck extends DeckClient {
		sessions: SessionSummary[] = ["a", "b", "foreign"].map(id => ({
			id,
			path: `/sessions/${id}`,
			cwd: "/project",
			title: id === "a" ? "Routing" : id === "b" ? "Release" : "Secret",
			createdAt: "1",
			updatedAt: "2",
			messageCount: 1,
		}));
		override async listSessions() {
			events.push("list");
			return this.sessions;
		}
		override async createSession(opts: { cwd: string; resumeFromPath?: string }) {
			events.push("resume");
			const id = opts.resumeFromPath?.split("/").pop() ?? "new";
			return { sessionId: id, sessionFile: `/sessions/${id}`, cwd: opts.cwd };
		}
		override async promptSession() {
			events.push("prompt");
			if (promptError) throw new Error("turn failed");
			return "Finished";
		}
		override async fileCards(cards: IntakeCard[]) {
			events.push("file");
			filedCards.push(...cards);
			return cards.map((card, index) => ({ ...card, displayId: index + 1 })) as Task[];
		}
	}
	const store = new TelegramBridgeStore(":memory:");
	const deck = new Deck(config.deckApiBase, config.deckWsUrl);
	const bridge = new TelegramBridge(policy, {
		telegram: new Transport("offline"),
		deck,
		store,
		identity: { id: 99, username: "deck_bot" },
	});
	return {
		events,
		replies,
		typingThreads,
		filedCards,
		deck,
		store,
		bridge,
		downloads: () => downloads,
		failPrompt: () => {
			promptError = true;
		},
		send: (input: TelegramMessage) => bridge.dispatch({ update_id: input.message_id, message: input }),
	};
}

test("stop in the same batch cancels an earlier queued chat before mapping or prompt startup", async () => {
	const h = harness();
	try {
		await Promise.all([
			h.send({ ...message, text: "/chat do not start" }),
			h.send({ ...message, message_id: 2, text: "/stop" }),
		]);
		expect(h.events).not.toContain("resume");
		expect(h.events).not.toContain("prompt");
		expect(h.replies.some(reply => reply.includes("Cancellation requested"))).toBe(true);
	} finally {
		h.bridge.close();
	}
});

test("stop during mapping startup prevents its later prompt but does not cancel a subsequent chat", async () => {
	const h = harness();
	const entered = Promise.withResolvers<void>();
	const created = Promise.withResolvers<{ sessionId: string; sessionFile: string; cwd: string }>();
	const original = h.deck.createSession.bind(h.deck);
	const spy = spyOn(h.deck, "createSession").mockImplementation(() => {
		entered.resolve();
		return created.promise;
	});
	try {
		const pending = h.send({ ...message, text: "/chat blocked mapping" });
		await entered.promise;
		await h.send({ ...message, message_id: 2, text: "/stop" });
		created.resolve({ sessionId: "created", sessionFile: "/sessions/created", cwd: "/project" });
		await pending;
		expect(h.events).not.toContain("prompt");
		spy.mockImplementation(original);
		await h.send({ ...message, message_id: 3, text: "/chat next allowed turn" });
		expect(h.events.filter(event => event === "prompt")).toHaveLength(1);
	} finally {
		created.resolve({ sessionId: "created", sessionFile: "/sessions/created", cwd: "/project" });
		spy.mockRestore();
		h.bridge.close();
	}
});

test("cancelling an in-flight WebSocket subscription cannot submit a late prompt", async () => {
	const subscribed = Promise.withResolvers<() => void>();
	const prompts: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, listener) {
			return listener.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 });
		},
		websocket: {
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as { type: string; sessionId: string };
				if (frame.type === "subscribe")
					subscribed.resolve(() => {
						socket.send(JSON.stringify({ type: "subscribed", sessionId: frame.sessionId, snapshot: {} }));
					});
				if (frame.type === "prompt") prompts.push(frame.sessionId);
			},
		},
	});
	const controller = new AbortController();
	const client = new DeckClient(`http://127.0.0.1:${server.port}`, `ws://127.0.0.1:${server.port}`);
	try {
		const pending = client.promptSession({
			sessionId: "cancel-start",
			text: "must not submit",
			signal: controller.signal,
			onText() {},
		});
		const lateSubscription = await subscribed.promise;
		controller.abort();
		lateSubscription();
		await expect(pending).rejects.toThrow("Prompt cancelled");
		expect(prompts).toEqual([]);
	} finally {
		controller.abort();
		await server.stop(true);
	}
});

test("poll confirmation never outruns durable pending intake and restart replays queued tasks and captures", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-pending-intake-"));
	const dbPath = path.join(root, "bridge.db");
	const updates: TelegramUpdate[] = [
		{ update_id: 101, message: { ...message, message_id: 101, text: "/task First durable task" } },
		{ update_id: 102, message: { ...message, message_id: 102, text: "/task Queued durable task" } },
		{ update_id: 103, message: { ...message, message_id: 103, text: "/capture Durable capture" } },
	];
	const gate = Promise.withResolvers<void>();
	const replayed: string[] = [];
	let broken = true;
	let firstPoll = true;
	let store = new TelegramBridgeStore(dbPath);
	let bridge: TelegramBridge;
	class Transport extends TelegramApi {
		override async getMe() {
			return { id: 99, username: "deck_bot" };
		}
		override async setCommands() {
			return true;
		}
		override async sendMessage(chatId: number | string) {
			return { message_id: 1, chat: { id: Number(chatId) } };
		}
		override async getUpdates(offset: number | undefined): Promise<TelegramUpdate[]> {
			if (firstPoll) {
				firstPoll = false;
				return updates;
			}
			await Promise.resolve();
			expect(offset).toBe(104);
			expect(store.pendingIntakes().map(update => update.update_id)).toEqual([101, 102, 103]);
			bridge.stop();
			gate.resolve();
			return [];
		}
	}
	class Deck extends DeckClient {
		override async fileCards(cards: IntakeCard[]) {
			await gate.promise;
			if (broken) throw new Error("Interrupted before durable filing");
			replayed.push(...cards.map(card => card.title));
			return cards.map((card, index) => ({ ...card, displayId: index + 1 })) as Task[];
		}
		override async capture(title: string, body: string, source: string): Promise<InboxItem> {
			if (broken) throw new Error("Interrupted capture");
			replayed.push(title);
			return { id: "capture", kind: "capture", title, body, source, createdAt: "2026-10-19T00:00:00Z" };
		}
	}
	const deck = new Deck(config.deckApiBase, config.deckWsUrl);
	try {
		bridge = new TelegramBridge({ ...config, dbPath }, { telegram: new Transport("offline"), deck, store });
		await bridge.run();
		store = new TelegramBridgeStore(dbPath);
		expect(store.pendingIntakes()).toEqual(updates);
		broken = false;
		class RecoveryTransport extends Transport {
			override async getUpdates(): Promise<TelegramUpdate[]> {
				bridge.stop();
				return [];
			}
		}
		bridge = new TelegramBridge({ ...config, dbPath }, { telegram: new RecoveryTransport("offline"), deck, store });
		await bridge.run();
		store = new TelegramBridgeStore(dbPath);
		expect(store.pendingIntakes()).toEqual([]);
		expect(replayed).toEqual(["First durable task", "Queued durable task", "Durable capture"]);
	} finally {
		gate.resolve();
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("attachment intake boundaries", () => {
	test("captioned unsupported media warns before a chat turn or task filing", async () => {
		const h = harness();
		try {
			for (const kind of ["document", "audio", "voice", "video", "video_note", "animation", "sticker"] as const) {
				h.events.length = 0;
				h.replies.length = 0;
				await h.send({ ...message, caption: "/chat summarize this", [kind]: { file_id: "not-downloaded" } });
				expect(h.replies[0]).toContain(`${kind} attachment not downloaded or processed`);
				expect(h.replies[0]).toContain("Only the caption text");
				expect(h.events.indexOf("reply")).toBeLessThan(h.events.indexOf("prompt"));
			}
			h.events.length = 0;
			h.replies.length = 0;
			await h.send({
				...message,
				caption: "/task 1. Research\n2. Write report",
				document: { file_id: "not-downloaded" },
			});
			expect(h.replies[0]).toContain("document attachment not downloaded");
			expect(h.replies.at(-1)).toContain("Filed 2 kanban cards");
			expect(h.events.indexOf("reply")).toBeLessThan(h.events.indexOf("file"));
			expect(h.downloads()).toBe(0);
		} finally {
			h.bridge.close();
		}
	});
	test("a video captioned /help receives the attachment notice and still shows help", async () => {
		const h = harness();
		try {
			await h.send({
				...message,
				chat: { id: 7, type: "private" },
				caption: "/help",
				video: { file_id: "not-downloaded" },
			});
			expect(h.replies[0]).toContain("video attachment not downloaded or processed");
			expect(h.replies[0]).toContain("Only the caption text");
			expect(h.replies[1]).toContain("/help or /commands");
			expect(h.events).toEqual(["reply", "reply"]);
			expect(h.downloads()).toBe(0);
		} finally {
			h.bridge.close();
		}
	});
	test("unauthorized, ambient and ignored captions have no transport, session or card effects", async () => {
		const h = harness({ ...config, ignoredTopics: new Set(["-10:43"]) });
		try {
			for (const input of [
				{ ...message, from: { id: 8 }, caption: "/chat inspect" },
				{ ...message, caption: "ambient caption" },
				{ ...message, message_thread_id: 43, caption: "/chat inspect" },
				{ ...message, caption: "/chat@other_bot inspect" },
			])
				await h.send({ ...input, document: { file_id: "not-downloaded" } });
			expect(h.events).toEqual([]);
			expect(h.store.list("-10:42")).toEqual([]);
			expect(h.downloads()).toBe(0);
			await h.send({ ...message, chat: { id: 7, type: "private" }, document: { file_id: "not-downloaded" } });
			expect(h.replies[0]).toContain("not downloaded or processed");
			expect(h.events).toEqual(["reply"]);
		} finally {
			h.bridge.close();
		}
	});
});

describe("mention-gated task contents", () => {
	test("quoted usernames survive text and caption intake, including card ownership", async () => {
		const h = harness();
		try {
			const prose = "Investigate the literal '@deck_bot' without editing it";
			await h.send({ ...message, text: prose, reply_to_message: { from: { id: 99 } } });
			await h.send({
				...message,
				message_id: 2,
				caption: "+++\nread-only = true\nowner = '@deck_bot'\n+++\nResearch the '@deck_bot' identifier",
				reply_to_message: { from: { id: 99 } },
			});
			expect(h.filedCards[0]).toEqual({ title: prose, body: prose });
			const body = h.filedCards[1]!.body!;
			const properties = parseProperties(body.slice(4, body.indexOf("\n+++", 4)));
			expect(properties.owner).toBe("@deck_bot");
			expect(properties["read-only"]).toBe(true);
			expect(h.filedCards[1]!.title).toBe("Research the '@deck_bot' identifier");
			expect(body).toContain("Research the '@deck_bot' identifier");
		} finally {
			h.bridge.close();
		}
	});
	test("bot references in ambient prose, URLs and TOML do not invoke task intake", async () => {
		const h = harness();
		try {
			for (const text of [
				"See https://t.me/deck_bot",
				"Investigate the literal '@deck_bot'",
				"+++\nowner = '@deck_bot'\n+++\nAmbient card example",
				"@deck_bot_other task",
			]) {
				await h.send({ ...message, text });
				await h.send({ ...message, text: undefined, caption: text });
			}
			expect(h.filedCards).toEqual([]);
			const invocation = "@DeCk_BoT investigate the literal '@deck_bot'";
			await h.send({ ...message, text: invocation });
			expect(h.filedCards).toEqual([{ title: invocation, body: invocation }]);
		} finally {
			h.bridge.close();
		}
	});
});

describe("retained conversation commands", () => {
	test("search numbers select the displayed lane result and title reads do not create sessions", async () => {
		const h = harness();
		try {
			await h.send({ ...message, text: "/title" });
			expect(h.replies.at(-1)).toContain("No bound session");
			expect(h.events).toEqual(["reply"]);
			for (const [id, lane] of [
				["a", "-10:42"],
				["b", "-10:42"],
				["foreign", "-10:43"],
			])
				h.store.upsert({
					chatId: lane!,
					sessionId: id!,
					sessionFile: `/sessions/${id}`,
					cwd: "/project",
					createdAt: "1",
					updatedAt: id === "a" ? "3" : "2",
				});
			await h.send({ ...message, text: "/sessions search releas" });
			expect(h.replies.at(-1)).toBe("1. Release · b · /project");
			await h.send({ ...message, text: "/resume 1" });
			expect(h.store.get("-10:42")?.sessionId).toBe("b");
			await h.send({ ...message, text: "/sessions routing" });
			expect(h.store.get("-10:42")?.sessionId).toBe("a");
			h.events.length = 0;
			await h.send({ ...message, text: "/title" });
			expect(h.replies.at(-1)).toBe("Current title: Routing");
			expect(h.events).not.toContain("resume");
			await h.send({ ...message, text: "/sessions search Secret" });
			expect(h.replies.at(-1)).toBe("No matching retained sessions in this conversation.");
			await h.send({ ...message, text: "/resume 1" });
			expect(h.store.get("-10:42")?.sessionId).toBe("a");
		} finally {
			h.bridge.close();
		}
	});
	test("forum General typing keeps topic 1 even when message replies omit it", async () => {
		const h = harness();
		try {
			await h.send({ ...message, is_topic_message: undefined, message_thread_id: undefined, text: "/chat inspect" });
			expect(h.typingThreads).toEqual([1]);
			expect(h.store.get("-10:1")?.sessionId).toBe("new");
			h.failPrompt();
			await h.send({ ...message, text: "/chat fail" });
			expect(h.replies.at(-1)).toContain("Bridge error: Error: turn failed");
		} finally {
			h.bridge.close();
		}
	});
});

describe("TOML card default commands", () => {
	test("properties accepts and displays native TOML and refuses YAML without replacing defaults", async () => {
		const h = harness();
		try {
			await h.send({
				...message,
				text: "/properties read-only = true\nowner = 'Captain'\n[custom]\ntags = ['one', 'two']",
			});
			const response = h.replies.at(-1)!;
			expect(response).toContain("Default card properties");
			expect(parseProperties(response.slice(response.indexOf(":\n") + 2))).toEqual({
				"read-only": true,
				owner: "Captain",
				custom: { tags: ["one", "two"] },
			});
			await h.send({ ...message, message_id: 2, text: "/properties owner: Pilot" });
			expect(h.replies.at(-1)).toContain("TOML");
			expect(h.store.getProperties("-10:42").owner).toBe("Captain");
		} finally {
			h.bridge.close();
		}
	});
});
