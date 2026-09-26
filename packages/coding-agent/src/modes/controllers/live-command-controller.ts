import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type LivePhase,
	LiveSessionController,
	type LiveSessionControllerOptions,
	type LiveTranscript,
} from "../../live/controller";
import { LIVE_MODEL } from "../../live/protocol";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";

import { cfgLiveVoice } from "../../live/settings";

type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;

/** Where Enter sends composer text during a live call. */
export type LiveInputDestination = "primary" | "voice" | "both";
/** What a submit does during a call: continue to the primary agent, stop because the voice agent
 *  took it, or hold the draft because a voice handoff of its speech is landing right now. */
export type LiveSubmitRoute = "primary" | "voice" | "held";
const DESTINATION_ORDER: readonly LiveInputDestination[] = ["primary", "voice", "both"];

const LIVE_MESSAGE_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Operator speech for one realtime user turn, as it is being typed into the composer. */
interface ComposerUtterance {
	turn: number;
	/** Separator placed before the utterance so it does not run into the text before the cursor. */
	prefix: string;
	/** Transcript text last shown as the volatile preview, without {@link prefix}. */
	text: string;
}

/**
 * Owns the realtime session lifecycle for `/live`. The ordinary composer stays mounted
 * and focused: operator speech types into it like hold-space dictation (a volatile
 * preview while speaking, committed when the utterance ends), and utterances the primary
 * agent accepts through a voice handoff leave the draft as one undoable edit.
 */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #createSession: LiveSessionFactory | undefined;

	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#utterance: ComposerUtterance | undefined;
	/** Utterances committed into the draft, by editor utterance id, for removal on handoff. */
	/** Editor utterance id of each ledger turn committed into the draft, for removal on handoff. */
	#committed = new Map<number, number>();
	/** Set while the controller itself edits the draft, so those edits are not operator activity. */
	#editing = false;
	#phase: LivePhase | undefined;
	#destination: LiveInputDestination = "primary";
	#resumeVocalizer: (() => void) | undefined;
	#assistantTranscriptComponent: AssistantMessageComponent | undefined;
	#assistantTranscriptTurn = 0;
	#assistantTranscriptStartedAt = 0;

	constructor(ctx: InteractiveModeContext, createSession?: LiveSessionFactory) {
		this.#ctx = ctx;
		this.#createSession = createSession;
	}

	/** Whether a live session is connected, connecting, or closing. */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	/** Start live mode, or stop the currently active session. */
	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		await this.#start();
	}

	/** Mute or unmute the microphone of the active live session. No-op when live mode is off. */
	async toggleMute(): Promise<void> {
		await this.#session?.toggleMute();
	}

	/** Composer edits count as operator activity: voice-triggering context waits until they settle. */
	noteComposerActivity(): void {
		if (this.#editing) return;
		this.#session?.noteComposerActivity();
	}

	/** Where Enter sends composer text, or undefined when no call is running. */
	get destination(): LiveInputDestination | undefined {
		return this.#session ? this.#destination : undefined;
	}

	/** Advance primary → voice → both → primary. Returns the new destination, or undefined when no call is running. */
	cycleDestination(): LiveInputDestination | undefined {
		if (!this.#session) return undefined;
		const next = DESTINATION_ORDER[(DESTINATION_ORDER.indexOf(this.#destination) + 1) % DESTINATION_ORDER.length];
		this.#destination = next ?? "primary";
		this.#showPhase(this.#phase);
		return this.#destination;
	}

	/**
	 * Route submitted composer text by the current destination. Submitting is the operator's
	 * own handoff: the draft already carries every spoken utterance not yet handed off, so
	 * the voice agent can no longer relay those turns. `voice` hands the text to the voice
	 * agent only, shows it in the transcript with a mic badge, and returns true (consumed).
	 * `both` and `primary` return false so the ordinary submit reaches the primary; `both`
	 * shares the final prompt through {@link shareSubmit} once input hooks have settled it.
	 * Drafts with images always go to the primary. Returns false untouched when no call is
	 * running.
	 */
	routeSubmit(text: string, options: { hasImages: boolean }): LiveSubmitRoute {
		const session = this.#session;
		if (!session) return "primary";
		if (!session.retireComposerSpeech()) return "held";
		this.#committed.clear();
		if (this.#destination !== "voice" || options.hasImages) return "primary";
		session.sendOperatorText(text, "voice");
		const component = new UserMessageComponent(text);
		if (theme.icon.mic) component.setReaction(theme.icon.mic);
		this.#ctx.present(component);
		return "voice";
	}

	/**
	 * The composer's speech is being cleared or sent elsewhere, so no handoff may relay it.
	 * Returns false when a handoff of that speech was accepted at this moment: a submit must then
	 * hold, or the same request would go out twice.
	 */
	discardSpeech(): boolean {
		const settled = this.#session?.retireComposerSpeech() ?? true;
		if (settled) this.#committed.clear();
		return settled;
	}

	/** With the destination `both`, tell the voice agent what the main agent is about to receive. */
	shareSubmit(text: string): void {
		if (this.#destination !== "both" || !this.#session) return;
		this.#session.sendOperatorText(text, "both");
		this.#session.expectOperatorTurn();
	}

	/** Stop the active live session. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: errorFrom(cause).message });
			});
		} else {
			this.#release();
		}
	}

	async #start(): Promise<void> {
		this.#assistantTranscriptTurn = 0;
		this.#assistantTranscriptStartedAt = 0;
		this.#destination = "primary";
		this.#showPhase("connecting");
		this.#utterance = undefined;
		this.#committed.clear();
		this.#resumeVocalizer = vocalizer.suspend();

		const options: LiveSessionControllerOptions = {
			session: this.#ctx.session,
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
			voice: cfgLiveVoice.get(this.#ctx.settings),
			callbacks: {
				onPhase: phase => {
					if (this.#session !== session) return;
					this.#showPhase(phase);
				},
				onLevels: () => {},
				onTranscript: transcript => {
					if (this.#session !== session || !transcript || transcript.role === "user") return;
					this.#presentAssistantTranscript(transcript);
				},
				onUserSpeech: speech => {
					if (this.#session !== session) return;
					this.#typeUserTranscript(speech);
				},
				onDelegated: turns => {
					if (this.#session !== session) return;
					this.#removeDelegated(turns);
				},
				onTerminal: error => this.#finish(session, error),
			},
		};
		const session = this.#createSession ? this.#createSession(options) : new LiveSessionController(options);
		this.#session = session;
		this.#ctx.ui.requestRender();

		try {
			await session.start();
		} catch (cause) {
			if (this.#session === session) {
				await session.stop();
				this.#finish(session, errorFrom(cause));
			}
		}
	}

	/**
	 * Type one user transcript update into the composer. Partials replace a volatile preview;
	 * the final transcript commits as one undoable edit. The editor keeps a preview the
	 * operator edited around and continues with only the rest of the utterance, and drops the
	 * rest when the operator deleted it.
	 */
	#typeUserTranscript(transcript: LiveTranscript): void {
		let utterance = this.#utterance;
		if (!utterance || transcript.turn !== utterance.turn) {
			if (utterance) this.#commitUtterance(utterance, utterance.text);
			utterance = { turn: transcript.turn, prefix: this.#separator("before"), text: "" };
			this.#utterance = utterance;
		}
		if (transcript.final && !transcript.text.trim()) {
			// The recognizer withdrew the utterance.
			this.#utterance = undefined;
			this.#ctx.editor.clearVolatileText();
		} else if (transcript.final) {
			this.#utterance = undefined;
			this.#commitUtterance(utterance, transcript.text);
		} else {
			this.#ctx.editor.setVolatileText(`${utterance.prefix}${transcript.text}`);
			utterance.text = transcript.text;
		}
		this.#ctx.ui.requestRender();
	}

	#commitUtterance(utterance: ComposerUtterance, text: string): void {
		const id = this.#ctx.editor.commitVolatileText(`${utterance.prefix}${text}${this.#separator("after")}`);
		if (id !== undefined && text) this.#committed.set(utterance.turn, id);
	}

	/** A space when the character on that side of the cursor would otherwise touch the speech. */
	#separator(side: "before" | "after"): string {
		const editor = this.#ctx.editor;
		const { line, col } = editor.getCursor();
		const text = editor.getLines()[line] ?? "";
		const neighbour = side === "before" ? (col > 0 ? text[col - 1] : line > 0 ? "\n" : "") : text[col];
		return neighbour && !/\s/.test(neighbour) ? " " : "";
	}

	/** Remove the utterances of the turns the primary agent accepted through a voice handoff. */
	#removeDelegated(turns: readonly number[]): void {
		const ids: number[] = [];
		for (const turn of turns) {
			const id = this.#committed.get(turn);
			if (id === undefined) continue;
			ids.push(id);
			this.#committed.delete(turn);
		}
		if (ids.length === 0) return;
		this.#editing = true;
		try {
			this.#ctx.editor.removeUtterances(ids);
		} finally {
			this.#editing = false;
		}
		this.#ctx.ui.requestRender();
	}

	#presentAssistantTranscript(transcript: LiveTranscript): void {
		if (
			transcript.turn < this.#assistantTranscriptTurn ||
			(transcript.turn === this.#assistantTranscriptTurn && !this.#assistantTranscriptComponent)
		) {
			return;
		}
		if (transcript.turn > this.#assistantTranscriptTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTranscriptTurn = transcript.turn;
		}

		let component = this.#assistantTranscriptComponent;
		if (!component) {
			component = createAssistantMessageComponent(this.#ctx);
			component.setTextColorTransform(text => theme.fg("borderAccent", text));
			this.#assistantTranscriptComponent = component;
			this.#assistantTranscriptStartedAt = Date.now();
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: transcript.text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: LIVE_MODEL,
			usage: { ...LIVE_MESSAGE_USAGE },
			stopReason: "stop",
			timestamp: this.#assistantTranscriptStartedAt,
		};
		component.updateContent(message, { transient: !transcript.final });
		if (transcript.final) {
			component.markTranscriptBlockFinalized();
			this.#assistantTranscriptComponent = undefined;
			this.#assistantTranscriptStartedAt = 0;
		}
		if (!this.#ctx.chatContainer.children.includes(component)) {
			this.#ctx.present(component);
		} else {
			this.#ctx.ui.requestComponentRender(component);
		}
	}

	#finalizeAssistantTranscript(): void {
		const component = this.#assistantTranscriptComponent;
		if (!component) return;
		component.markTranscriptBlockFinalized();
		this.#assistantTranscriptComponent = undefined;
		this.#assistantTranscriptStartedAt = 0;
		this.#ctx.ui.requestComponentRender(component);
	}

	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#release();
		if (error) {
			this.#showPhase("error");
			this.#ctx.showError(error.message);
		}
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: errorFrom(cause).message });
		});
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
		});
	}

	/** Keep any in-flight speech preview as draft text and hand audio output back to TTS. */
	#release(): void {
		this.#finalizeAssistantTranscript();
		const utterance = this.#utterance;
		this.#utterance = undefined;
		if (utterance) this.#commitUtterance(utterance, utterance.text);
		this.#committed.clear();
		this.#showPhase(undefined);
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		this.#ctx.ui.requestRender();
	}

	/** Mirror the call phase and input destination into the status-line mic icon; an error leaves it showing "disconnected". */
	#showPhase(phase: LivePhase | undefined): void {
		this.#phase = phase;
		this.#ctx.statusLine.setLiveStatus(
			phase === undefined
				? null
				: { phase: phase === "error" ? "disconnected" : phase, destination: this.#destination },
		);
		this.#ctx.ui.requestRender();
	}
}
