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
	/** Separator placed before the utterance so it does not run into the existing draft. */
	prefix: string;
	/** Text currently shown as the volatile preview, including {@link prefix}. */
	preview: string;
	/** Preview text the operator edited around, now ordinary draft text. */
	adopted: string | undefined;
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
	 * Route submitted composer text by the current destination. `voice` hands the text to
	 * the voice agent only, shows it in the transcript with a mic badge, and returns true
	 * (consumed). `both` also shares it with the voice agent as silent awareness and returns
	 * false so the ordinary submit still reaches the primary. `primary`, or no call, returns
	 * false untouched.
	 */
	routeSubmit(text: string): boolean {
		const session = this.#session;
		if (!session || this.#destination === "primary") return false;
		if (this.#destination === "both") {
			session.sendOperatorText(text, "both");
			return false;
		}
		session.sendOperatorText(text, "voice");
		const component = new UserMessageComponent(text);
		if (theme.icon.mic) component.setReaction(theme.icon.mic);
		this.#ctx.present(component);
		return true;
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
					if (this.#session !== session || !transcript) return;
					if (transcript.role === "user") {
						this.#typeUserTranscript(transcript);
					} else {
						this.#presentAssistantTranscript(transcript);
					}
				},
				onDelegated: texts => {
					if (this.#session !== session) return;
					this.#ctx.editor.removeText(texts);
					this.#ctx.ui.requestRender();
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
	 * Type one user transcript update into the composer. Partials replace a volatile
	 * preview; the final transcript commits as one undoable edit. When the operator edits
	 * around the preview, the preview becomes ordinary draft text and later updates for
	 * that turn only append what was not already shown.
	 */
	#typeUserTranscript(transcript: LiveTranscript): void {
		const editor = this.#ctx.editor;
		let utterance = this.#utterance;
		if (!utterance || transcript.turn !== utterance.turn) {
			if (utterance && editor.hasVolatileText) editor.commitVolatileText(utterance.preview);
			const draft = editor.getText();
			utterance = {
				turn: transcript.turn,
				prefix: draft.length > 0 && !/\s$/.test(draft) ? " " : "",
				preview: "",
				adopted: undefined,
			};
			this.#utterance = utterance;
		}
		if (utterance.preview && utterance.adopted === undefined && !editor.hasVolatileText) {
			utterance.adopted = utterance.preview;
		}
		const shown = `${utterance.prefix}${transcript.text}`;
		if (utterance.adopted !== undefined) {
			if (transcript.final) {
				const rest = shown.startsWith(utterance.adopted) ? shown.slice(utterance.adopted.length) : "";
				if (rest.trim()) editor.commitVolatileText(rest);
				this.#utterance = undefined;
			}
		} else if (transcript.final) {
			editor.commitVolatileText(shown);
			this.#utterance = undefined;
		} else {
			editor.setVolatileText(shown);
			utterance.preview = shown;
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
		if (utterance && this.#ctx.editor.hasVolatileText) {
			this.#ctx.editor.commitVolatileText(utterance.preview);
		}
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
