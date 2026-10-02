import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../../src/session/messages";
import { buildLiveDelegationMessage, LIVE_VOICE_NOTE_ENTRY_TYPE } from "../../src/live/delegation-note";
import { LiveSessionController } from "../../src/live/controller";
import liveClientProtocolTemplate from "../../src/live/prompts/live-client-protocol.md" with { type: "text" };
import liveInstructionsTemplate from "../../src/live/prompts/live-instructions.md" with { type: "text" };
import voiceAgentNoteTemplate from "../../src/live/prompts/voice-agent-note.md" with { type: "text" };
import type { LiveClientMessage, LiveServerEvent } from "../../src/live/protocol";

function delegation(id: string, text: string): LiveServerEvent {
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: text ? [{ type: "input_text", text }] : [] },
	};
}

function harness(includeVoiceNote: () => boolean = () => true) {
	const sent: LiveClientMessage[] = [];
	const received: Array<{
		message: { content: string; details?: { operator: string; voice?: string; noteId?: string } };
		options?: object;
	}> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const spoken: string[] = [];
	const aborted: unknown[] = [];
	let subscriber: (event: AgentSessionEvent) => void = () => {};
	let onEvent: (event: LiveServerEvent) => void = () => {};
	let streaming = false;
	let holdAcceptance = false;
	const accept: Array<() => void> = [];
	let onSend: ((message: { details?: { noteId?: string } }) => void) | undefined;
	const session = {
		modelRegistry: { authStorage: {} },
		sessionId: "delegation-note-test",
		sessionManager: {
			allocateArtifactPath: async () => ({}),
			appendCustomEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
		},
		subscribe(fn: (event: AgentSessionEvent) => void) {
			subscriber = fn;
			return () => {
				subscriber = () => {};
			};
		},
		get isStreaming() {
			return streaming;
		},
		get isBashRunning() {
			return false;
		},
		get isEvalRunning() {
			return false;
		},
		async abort(value: unknown) {
			aborted.push(value);
			streaming = false;
		},
		sendCustomMessageWithReceipt(
			message: { content: string; details?: { operator: string; voice?: string; noteId?: string } },
			options?: object,
		) {
			received.push({ message, options });
			const accepted = Promise.withResolvers<void>();
			accept.push(() => accepted.resolve());
			if (!holdAcceptance) accepted.resolve();
			onSend?.(message);
			return { accepted: accepted.promise, completed: accepted.promise.then(() => true), cancel: () => false };
		},
	} as unknown as AgentSession;
	const controller = new LiveSessionController({
		session,
		includeVoiceNote,
		callbacks: {
			onPhase() {},
			onLevels() {},
			onTranscript() {},
			onTerminal() {},
			onSpeechSent: text => spoken.push(text),
		},
		extractAssistantText: message => (message as unknown as { testText?: string }).testText ?? "",
		createRecorder: () => ({ stop() {} }),
		createTransport: options => {
			onEvent = options.callbacks.onEvent;
			return {
				async connect() {},
				async send(message: LiveClientMessage) {
					sent.push(message);
				},
				async close() {},
				async setMuted() {},
				pushAudio() {
					return true;
				},
			};
		},
	});
	return {
		controller,
		sent,
		received,
		entries,
		spoken,
		aborted,
		fire: (event: LiveServerEvent) => onEvent(event),
		fireSession: (event: AgentSessionEvent) => subscriber(event),
		setStreaming: (next: boolean) => {
			streaming = next;
		},
		hold: () => {
			holdAcceptance = true;
		},
		accept: (index = 0) => accept[index]?.(),
		onSend: (fn: (message: { details?: { noteId?: string } }) => void) => {
			onSend = fn;
		},
	};
}

function consumed(noteId: string): AgentSessionEvent {
	return {
		type: "message_start",
		message: {
			role: "custom",
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: "",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
			details: { noteId },
		},
	} as AgentSessionEvent;
}
function ended(text: string): AgentSessionEvent {
	return {
		type: "agent_end",
		isTerminal: true,
		messages: [{ role: "assistant", testText: text, stopReason: "stop" } as unknown as AgentMessage],
	} as AgentSessionEvent;
}
async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}
function spokenTexts(sent: LiveClientMessage[]): string[] {
	const texts: string[] = [];
	for (const message of sent) {
		if (message.type !== "session.context.append") continue;
		if (message.channel !== "speakable" && message.channel !== undefined) continue;
		texts.push(message.content.map(part => part.text).join(""));
	}
	return texts;
}

describe("live delegation provenance", () => {
	it("preserves operator bytes and compiles the wrapper without prompt.render post-formatting", () => {
		const operator = "keep trailing spaces  \n\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
		const voice = "Should I check the tests too?";
		const { content, details } = buildLiveDelegationMessage(operator, voice, true);
		expect(content.startsWith(operator + "\n\n")).toBe(true);
		expect(content.slice(operator.length + 2)).toBe(prompt.compile(voiceAgentNoteTemplate)({ voice }));
		expect(voiceAgentNoteTemplate.endsWith("</voice-agent-note>\n")).toBe(true);
		expect(details).toEqual({ operator, voice });
	});
	it("handles empty, duplicate, disabled and empty-operator notes", () => {
		const operator = "fix the build";
		const voice = "Should I check the tests too?";
		expect(buildLiveDelegationMessage(operator, "", true)).toEqual({ content: operator, details: { operator } });
		expect(buildLiveDelegationMessage(operator, "FIX  the build", true)).toEqual({
			content: operator,
			details: { operator, voice: "FIX  the build" },
		});
		expect(buildLiveDelegationMessage(operator, voice, false)).toEqual({
			content: operator,
			details: { operator, voice },
		});
		expect(buildLiveDelegationMessage(operator, voice, true).content).toBe(
			`${operator}\n\n${prompt.compile(voiceAgentNoteTemplate)({ voice })}`,
		);
		expect(buildLiveDelegationMessage("", voice, true)).toEqual({
			content: prompt.compile(voiceAgentNoteTemplate)({ voice }),
			details: { operator: "", voice },
		});
	});
	it("keeps the bundled client protocol identical to the editable pane fragment", () => {
		expect(liveInstructionsTemplate.endsWith(liveClientProtocolTemplate.trim())).toBe(true);
	});
	it("sends verbatim operator speech first, with separate voice provenance and pure composer history", async () => {
		const h = harness();
		await h.controller.start();
		h.fire({ type: "turn.done", turn: { role: "user", transcript: "fix the build" } });
		h.fire(delegation("d1", "Should I check tests too?"));
		await flush();
		expect(h.received[0]?.message.content).toStartWith("fix the build\n\n<voice-agent-note>");
		expect(h.received[0]?.message.details).toEqual({ operator: "fix the build", voice: "Should I check tests too?" });
		expect(h.spoken).toEqual(["fix the build"]);
		await h.controller.stop();
	});
	it("reads includeVoiceNote at dispatch, and duplicate voice text never adds a wrapper", async () => {
		let include = true;
		const h = harness(() => include);
		await h.controller.start();
		h.fire({ type: "input_transcript.added", item: { text: "pending" } });
		h.fire(delegation("partial", "my note"));
		include = false;
		h.fire({ type: "turn.done", turn: { role: "user", transcript: "the final" } });
		await flush();
		expect(h.received[0]?.message).toMatchObject({
			content: "the final",
			details: { operator: "the final", voice: "my note" },
		});
		h.fire({ type: "turn.done", turn: { role: "user", transcript: "FIX the build" } });
		include = true;
		h.fire(delegation("duplicate", "fix  THE build"));
		await flush();
		expect(h.received[1]?.message.content).toBe("FIX the build");
		await h.controller.stop();
	});
	it("delivers an idle voice-only question and speaks only its consumed answer", async () => {
		const h = harness();
		await h.controller.start();
		h.fire(delegation("voice", "What is the branch?"));
		await flush();
		expect(h.received[0]?.message.details).toMatchObject({ operator: "", voice: "What is the branch?" });
		const noteId = h.received[0]?.message.details?.noteId;
		expect(noteId).toBeString();
		h.fireSession(ended("unrelated"));
		await flush();
		expect(spokenTexts(h.sent)).toEqual([]);
		h.fireSession(consumed(noteId!));
		h.fireSession(ended("On feat/live-ingest"));
		await flush();
		expect(spokenTexts(h.sent)).toEqual(['"Agent Final Message":\n\nOn feat/live-ingest']);
		h.fireSession(ended("later unrelated"));
		await flush();
		expect(spokenTexts(h.sent)).toHaveLength(1);
		await h.controller.stop();
	});
	it("steers a voice-only question without interrupting a streaming primary", async () => {
		const h = harness();
		await h.controller.start();
		h.setStreaming(true);
		h.fire(delegation("voice-steer", "What do you think?"));
		await flush();
		expect(h.received[0]?.options).toEqual({ deliverAs: "steer", steeringInterruptMode: "wait", triggerTurn: true });
		expect(h.aborted).toEqual([]);
		await h.controller.stop();
	});
	it("stores disabled voice-only notes as transcript-only provenance", async () => {
		const h = harness(() => false);
		await h.controller.start();
		h.fire(delegation("voice-off", "Why now?"));
		await flush();
		expect(h.received).toEqual([]);
		expect(h.entries[0]?.type).toBe(LIVE_VOICE_NOTE_ENTRY_TYPE);
		expect(h.entries[0]?.data).toMatchObject({ voice: "Why now?", operator: "", delivered: false });
		await h.controller.stop();
	});
	it("does not supersede an accepted-but-unretired pending handoff with a voice-only note", async () => {
		const h = harness();
		await h.controller.start();
		h.hold();
		h.fire({ type: "turn.done", turn: { role: "user", transcript: "do the first task" } });
		h.fire(delegation("operator", ""));
		await flush();
		h.fire(delegation("voice", "What next?"));
		await flush();
		expect(h.received).toHaveLength(2);
		h.accept(0);
		await flush();
		expect(h.spoken).toEqual(["do the first task"]);
		expect(h.received[0]?.message.content).toBe("do the first task");
		await h.controller.stop();
	});
	it("observes consumption before synchronous idle delivery completion", async () => {
		const h = harness();
		await h.controller.start();
		h.onSend(message => {
			if (message.details?.noteId) {
				h.fireSession(consumed(message.details.noteId));
				h.fireSession(ended("immediate answer"));
			}
		});
		h.fire(delegation("instant", "Question?"));
		await flush();
		expect(spokenTexts(h.sent)).toEqual(['"Agent Final Message":\n\nimmediate answer']);
		await h.controller.stop();
	});
});
