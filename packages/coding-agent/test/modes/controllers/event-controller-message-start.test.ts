import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { ircDmId, ircRoomId } from "@oh-my-pi/pi-coding-agent/irc/client-model";
import { OperatorIrcClient } from "@oh-my-pi/pi-coding-agent/irc/operator";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { Component } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: Date.now(),
	};
}

function createContext(options: {
	editorText: string;
	optimisticSignature?: string;
	locallySubmittedSignatures?: string[];
	pendingImages?: ImageContent[];
}) {
	let currentEditorText = options.editorText;
	const setText = vi.fn((text: string) => {
		currentEditorText = text;
	});
	const editor = {
		setText,
		getText: () => currentEditorText,
		pendingImages: [...(options.pendingImages ?? [])],
	};
	const ctx = createInteractiveModeContext({
		editor,
		optimisticUserMessageSignature: options.optimisticSignature,
		locallySubmittedUserSignatures: new Set<string>(options.locallySubmittedSignatures ?? []),
	});
	const clearOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	const replaceOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	ctx.clearOptimisticUserMessage = clearOptimisticUserMessage;
	ctx.replaceOptimisticUserMessage = replaceOptimisticUserMessage;
	return {
		ctx,
		editor,
		setText,
		addMessageToChat: ctx.addMessageToChat,
		updatePendingMessagesDisplay: ctx.updatePendingMessagesDisplay,
		clearOptimisticUserMessage,
		replaceOptimisticUserMessage,
	};
}

describe("EventController message_start (user role)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an in-progress editor draft when delivering a queued submission", async () => {
		// Reproduces the bug: user sends a message during streaming (queued) and then
		// types a follow-up draft. When the queue drains and message_start fires,
		// the editor MUST keep the draft.
		const message = createUserMessage("queued during streaming");
		const signature = "queued during streaming\u00000";
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "draft typed after queuing",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft typed after queuing");
		// Queued message was not optimistically rendered, so it must still land in chat.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// Pending list always refreshes so the dequeued entry disappears.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Signature is consumed so a future external message with the same shape is
		// not matched to this local submission again. The composer is never cleared
		// on message_start, so consumption no longer affects the draft.
		expect(ctx.locallySubmittedUserSignatures.has(signature)).toBe(false);
	});

	it("preserves the in-progress draft for a user message from an extension", async () => {
		// Regression: a user message this session never submitted locally is a real,
		// non-synthetic prompt (an extension delivering `sendUserMessage`, e.g. HCOM).
		// "Not local" must not mean "reset the editor": the draft being typed — text
		// and pasted images — has to survive the delivery.
		const message = createUserMessage("inbound from an extension");
		const draftImage: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "hello",
			pendingImages: [draftImage],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("hello");
		expect(editor.pendingImages).toEqual([draftImage]);
		// The inbound message still reaches the transcript.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// The pending list still refreshes.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("preserves the editor for an optimistic submission and skips the duplicate chat add", async () => {
		// Optimistic path already added the user message to chat and cleared the
		// editor at submit time. message_start must not re-add or re-clear.
		const message = createUserMessage("optimistic send");
		const signature = "optimistic send\u00000";
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "",
			optimisticSignature: signature,
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
	});

	it("appends a queued image submission synchronously so later events cannot reorder it", async () => {
		// Regression (da636e3f5): AgentSession.#emit dispatches listeners fire-and-forget,
		// so an await between the user message_start and addMessageToChat lets the next
		// synchronously-handled events (assistant message_start, tool execution start/end)
		// append their components first — dropping the user bubble *below* the very tool
		// output it was sent to steer. The append must happen before the handler settles.
		const message: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "steer mid-stream" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};
		const signature = "steer mid-stream\u00001";
		const { ctx, addMessageToChat } = createContext({
			editorText: "",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		// Fire WITHOUT awaiting: the bubble must already be appended synchronously.
		const pending = controller.handleEvent({ type: "message_start", message }).catch(() => {});
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		await pending;
	});
});

function createIrcMessage(timestamp: number): CustomMessage<{ from: string; message: string }> {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: "Ready",
		display: true,
		details: { from: "0-Main", message: `Ready ${timestamp}` },
		timestamp,
	};
}

function createIrcContext(options: { liveBlockAbove?: boolean } = {}) {
	const ctx = createInteractiveModeContext();
	const { chatContainer } = ctx;
	let runningTool: Component | undefined;
	if (options.liveBlockAbove) {
		// A still-running tool: blocks under it stay in the live region, where
		// their rows cannot commit to native scrollback.
		runningTool = {
			render: () => ["running tool"],
			invalidate: () => {},
			isTranscriptBlockFinalized: () => false,
		} as Component;
		chatContainer.addChild(runningTool);
	}
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = vi.fn((message, options) => helpers.addMessageToChat(message, options));
	return {
		ctx,
		chatContainer,
		runningTool,
		requestRender: ctx.ui.requestRender,
		addMessageToChat: ctx.addMessageToChat,
	};
}

describe("EventController IRC messages", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders an IRC message immediately and keeps it: nothing expires it", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(1);
		const { ctx, chatContainer, requestRender } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });

		expect(chatContainer.children).toHaveLength(2);
		// One requestRender from the IRC handler mounting the block. The blanket
		// pre-render that `handleEvent` used to fire before every dispatch was
		// removed in #4353 (it doubled the paint rate during streaming and did no
		// visible work beyond what the handlers already trigger).
		expect(requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		expect(chatContainer.children).toHaveLength(2);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(Bun.stripANSI(chatContainer.children[0]!.render(80).join("\n"))).toContain("Ready 1");
	});

	it("keeps every message of a burst, in arrival order, above the running block they arrived under", async () => {
		const { ctx, chatContainer, runningTool } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		for (let i = 0; i < 6; i++) {
			await controller.handleEvent({ type: "irc_message", message: createIrcMessage(100 + i) });
		}
		expect(chatContainer.children).toHaveLength(7);
		// The running block stays last: everything above it can scroll into history.
		expect(chatContainer.children[6]).toBe(runningTool!);
		const rendered = chatContainer.children.slice(0, 6).map(child => Bun.stripANSI(child.render(80).join("\n")));
		for (let i = 0; i < 6; i++) expect(rendered[i]).toContain(`Ready ${100 + i}`);
	});

	it("renders a duplicate IRC event once", async () => {
		const message = createIrcMessage(2);
		const { ctx, chatContainer, addMessageToChat } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		await controller.handleEvent({ type: "irc_message", message });

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("shows one group send once, keeping the leg delivered to this session over a leg observed on its way to another member", async () => {
		const text = "Compare findings.";
		const body = `Scout sent this to group council, which you are part of.\n\n${text}`;
		const group = { broadcast: true, group: "council", groupText: text, fanoutId: "f1" };
		const observed: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: body,
			display: true,
			details: { from: "Scout", to: "Operator", body, ...group },
			timestamp: 10,
		};
		const delivered: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: body,
			display: true,
			details: { from: "Scout", message: body, ...group },
			timestamp: 11,
		};
		for (const order of [
			[observed, delivered],
			[delivered, observed],
		]) {
			const { ctx, chatContainer } = createIrcContext();
			const controller = new EventController(ctx);
			for (const message of order) await controller.handleEvent({ type: "irc_message", message });

			expect(chatContainer.children).toHaveLength(1);
			const rendered = Bun.stripANSI(chatContainer.children[0]!.render(80).join("\n"));
			expect(rendered).toContain("#council");
			expect(rendered).toContain(text);
			// The delivered leg has no recipient to name; the observed one named the operator.
			expect(rendered).not.toContain("Operator");
		}
	});
});

/** The operator's own copy of a message, as the bus shows it on her UI: a DM to her, or her leg of a group send. */
function createOperatorNotice(
	timestamp: number,
	extra: Record<string, unknown> = {},
): CustomMessage<Record<string, unknown>> {
	const body = `Decision ${timestamp}`;
	return {
		role: "custom",
		customType: "irc:relay",
		content: body,
		display: true,
		details: { from: "Scout", to: "Operator", body, ...extra },
		timestamp,
	};
}

const operatorCleanup: (() => void)[] = [];

function createOperatorContext(focusedAgentId?: string) {
	const ctx = createInteractiveModeContext({
		ircOperatorId: "Operator",
		focusedAgentId,
		viewSession: focusedAgentId ? {} : undefined,
	});
	const registry = AgentRegistry.global();
	const root = registry.register({ id: "irc-notification-test-root", displayName: "Main", kind: "main", session: ctx.session });
	const ircClient = new OperatorIrcClient(root, ctx.session, {
		operatorId: "Operator",
		operatorName: "Operator",
		requestRender() {},
		reconcileOverlay() {},
	});
	Object.defineProperty(ctx, "ircClient", { value: ircClient });
	operatorCleanup.push(() => {
		ircClient.dispose();
		registry.unregister(root.id, root);
	});
	const { chatContainer } = ctx;
	// A still-running tool, as in createIrcContext: cards under it stay in the live region.
	const runningTool = {
		render: () => ["running tool"],
		invalidate: () => {},
		isTranscriptBlockFinalized: () => false,
	} as Component;
	chatContainer.addChild(runningTool);
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = vi.fn((message, options) => helpers.addMessageToChat(message, options));
	const rendered = () => chatContainer.children.map(child => Bun.stripANSI(child.render(80).join("\n")));
	return { ctx, chatContainer, runningTool, rendered, ircClient, requestRender: ctx.ui.requestRender };
}

describe("EventController IRC notifications to the operator", () => {
	afterEach(() => {
		for (const clean of operatorCleanup.splice(0)) clean();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shows a message addressed to her as a short card that retires after ten seconds, while a message delivered to the agent stays", async () => {
		vi.useFakeTimers();
		const { ctx, chatContainer, rendered, requestRender } = createOperatorContext();
		const controller = new EventController(ctx);
		const lines = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join("\n");
		const notice = createOperatorNotice(1, { body: lines });

		await controller.handleEvent({ type: "irc_message", message: createIrcMessage(2) });
		await controller.handleEvent({ type: "irc_message", message: notice });

		expect(chatContainer.children).toHaveLength(3);
		const card = rendered().find(text => text.includes("line 1"));
		// A preview, not the message: she reads the whole of it in the IRC viewer.
		expect(card).toContain("Scout");
		expect(card).toContain("Operator");
		expect(card).not.toContain("line 6");
		expect(requestRender).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(9_999);
		expect(chatContainer.children).toHaveLength(3);

		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(2);
		expect(rendered().some(text => text.includes("line 1"))).toBe(false);
		expect(rendered().some(text => text.includes("Ready 2"))).toBe(true);
		expect(requestRender).toHaveBeenCalledTimes(3);

		vi.advanceTimersByTime(60_000);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("applies room and DM policies to operator cards while viewing a child's transcript", async () => {
		const { ctx, rendered, ircClient } = createOperatorContext("Scout");
		const controller = new EventController(ctx);
		const room = ircRoomId("council");
		const text = "@Operator compare findings.";
		const body = `Scout sent this to group council, which you are part of.\n\n${text}`;
		try {
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(3, {
					body: "passive room chat",
					broadcast: true,
					group: "council",
					groupText: "passive room chat",
				}),
			});
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(4, { body: "a direct decision" }),
			});
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(8, { from: "irc-notification-test-root", body: "already shown in the main tool call" }),
			});
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(3, { body, broadcast: true, group: "council", groupText: text, fanoutId: "f3" }),
			});
			ircClient.model.setNotificationLevel(room, "none");
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(5, { group: "council", groupText: "@Operator quiet room" }),
			});
			ircClient.model.setNotificationLevel(room, "all");
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(6, { group: "council", groupText: "all room activity" }),
			});
			ircClient.model.setNotificationLevel(ircDmId("Scout", "Operator"), "none");
			await controller.handleEvent({
				type: "irc_message",
				message: createOperatorNotice(7, { body: "a quiet direct decision" }),
			});
		} finally {
			controller.dispose();
		}
		expect(rendered().join("\n")).not.toContain("passive room chat");
		expect(rendered().join("\n")).not.toContain("already shown in the main tool call");
		expect(rendered().join("\n")).toContain("a direct decision");
		expect(rendered().join("\n")).toContain("all room activity");
		expect(rendered().join("\n")).not.toContain("quiet room");
		expect(rendered().join("\n")).not.toContain("a quiet direct decision");

		const card = rendered().find(row => row.includes(text));
		expect(card).toContain("#council");
		expect(card).not.toContain("sent this to group");
	});

	it("evicts the oldest notification beyond four at once", async () => {
		vi.useFakeTimers();
		const { ctx, chatContainer, rendered } = createOperatorContext();
		const controller = new EventController(ctx);

		for (let i = 0; i < 5; i++) {
			await controller.handleEvent({ type: "irc_message", message: createOperatorNotice(100 + i) });
		}

		// The running block and four cards: the fifth notification evicted the first.
		expect(chatContainer.children).toHaveLength(5);
		const text = rendered().join("\n");
		expect(text).not.toContain("Decision 100");
		for (let i = 1; i < 5; i++) expect(text).toContain(`Decision ${100 + i}`);

		// The evicted card's timer is gone with it: the other four retire together, once.
		vi.advanceTimersByTime(10_000);
		expect(chatContainer.children).toHaveLength(1);
	});

	it("never shows a message between two other agents on the main screen", async () => {
		const { ctx, chatContainer, requestRender } = createOperatorContext();
		const controller = new EventController(ctx);

		// As the bus reports traffic she is not part of: an observation, not a display record.
		await controller.handleEvent({
			type: "irc_message",
			message: { ...createOperatorNotice(200, { to: "Builder" }), display: false },
		});

		expect(chatContainer.children).toHaveLength(1);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("clears pending notification timers on dispose", async () => {
		vi.useFakeTimers();
		const { ctx, chatContainer, requestRender } = createOperatorContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message: createOperatorNotice(4) });
		controller.dispose();
		vi.advanceTimersByTime(10_000);

		expect(chatContainer.children).toHaveLength(2);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
