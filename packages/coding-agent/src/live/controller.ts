import { appendFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { CustomMessageDelivery } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { sharedAudioCapture } from "../stt/shared-audio-capture";
import { resolveLiveInstructions } from "./personas";
import agentFinalMessageTemplate from "./prompts/agent-final-message.md" with { type: "text" };
import operatorSharedMessageTemplate from "./prompts/operator-shared-message.md" with { type: "text" };
import operatorTypedMessageTemplate from "./prompts/operator-typed-message.md" with { type: "text" };
import {
	buildDelegationContextAppend,
	buildSessionClose,
	buildSessionContextAppend,
	CONTEXT_CHUNK_BYTES,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol";
import { CodexLiveTransport } from "./transport";
import { DEFAULT_LIVE_VOICE } from "./voices";

const OUTPUT_ACTIVE_LEVEL = 0.015;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
const OUTPUT_SILENCE_MS = 250;
/** Quiet time after operator activity (speech or composer edits) before held voice-triggering context is delivered. */
const DEFAULT_SPEAKABLE_IDLE_MS = 10_000;
/** Minimum gap between reasoning narrations. Tests may shorten it. */
const DEFAULT_THINKING_FLUSH_MS = 3_000;
/** Voice-triggering items retained while the operator is active. Thinking and progress collapse to one slot each. */
const HELD_CONTEXT_CAP = 8;

interface UserLedgerTurn {
	turn: number;
	text: string;
	final: boolean;
	claim?: number;
}

type HeldContextKind = "report" | "thinking" | "progress";

interface HeldContextItem {
	kind: HeldContextKind;
	send: () => void;
}

/** Distinct states of a realtime call connection. */
export type LivePhase = "connecting" | "listening" | "working" | "speaking" | "muted" | "error";

/** Incremental or final transcript for one realtime conversational turn. */
export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	/** Monotonic role-local turn number used to coalesce streaming updates. */
	turn: number;
	final: boolean;
}

/** UI notifications emitted during a live session. */
export interface LiveSessionCallbacks {
	/** Reports connection and activity phase changes. */
	onPhase(phase: LivePhase): void;
	/** Reports clamped microphone and speaker RMS levels. */
	onLevels(input: number, output: number): void;
	/** Reports the latest available conversational transcript. */
	onTranscript(transcript: LiveTranscript | undefined): void;
	/** Reports one terminal stop, optionally carrying its cause. */
	onTerminal(error?: Error): void;
	/** Reports the ledger turns (as numbered by {@link onUserSpeech}) the primary agent accepted
	 *  through a voice handoff. */
	onDelegated?(turns: readonly number[]): void;
	/** Reports each update to an operator turn exactly as the handoff ledger records it: every
	 *  turn, repeats included, with the final text authoritative. Composer input follows this,
	 *  not the coalesced display transcript. */
	onUserSpeech?(speech: LiveTranscript): void;
}

/** Structural transport surface the controller needs (test seam). */
export type LiveTransportLike = Pick<CodexLiveTransport, "connect" | "send" | "close" | "setMuted" | "pushAudio"> & {
	playbackQueueStats?(): { queuedMs: number; droppedMs: number };
};

/** Structural recorder surface the controller needs (test seam). */
export interface LiveRecorderLike {
	stop(): void;
}

/** Dependencies and presentation callbacks for a live session. */
export interface LiveSessionControllerOptions {
	/** Agent session that performs all delegated coding work. */
	session: AgentSession;
	/** UI callbacks for live session state. */
	callbacks: LiveSessionCallbacks;
	/** Extracts visible assistant text using the caller's normal UI rules. */
	extractAssistantText(message: AssistantMessage): string;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/** Test seam: quiet time after operator activity before held context sends; defaults to 10000 ms. */
	speakableIdleMs?: number;
	/** Test seam: minimum gap between reasoning narrations; defaults to 3000 ms. */
	thinkingFlushMs?: number;
	/** Test seam: builds the realtime transport; defaults to CodexLiveTransport. */
	createTransport?(options: ConstructorParameters<typeof CodexLiveTransport>[0]): LiveTransportLike;
	/** Test seam: builds the microphone recorder; defaults to the shared native capture. */
	createRecorder?(
		sampleRate: number,
		callback: (error: Error | null, samples: Float32Array) => void,
	): LiveRecorderLike;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

function microphoneLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return clampLevel(Math.sqrt(sumSquares / samples.length));
}

function currentUser(): { username: string; firstName: string } {
	let username = "user";
	try {
		const candidate = os.userInfo().username.trim();
		if (candidate) username = candidate;
	} catch {
		// Sandboxed runtimes may not expose OS account information.
	}
	const firstPart = username.split(/[._\-\s]+/).find(part => part.length > 0);
	return { username, firstName: firstPart ?? "there" };
}

/** How one `agent_end` settle drives the voice relay. */
export interface RelaySettleAction {
	/** Whether this settle carries an answer the relay must speak. */
	relay: boolean;
	/** Whether the delegation is finished and its id may be released. */
	closeDelegation: boolean;
}

/**
 * Classify an `agent_end` settle for the voice relay.
 *
 * A terminal settle ends the delegation and speaks its answer. A non-terminal
 * settle is normally a scheduling pause with no answer yet — but when background
 * async work is the only thing keeping the session alive, the main lane already
 * answered (`hasFinalResponse`). The caller is on a phone call and cannot wait for
 * subagents, so that answer is spoken immediately while the delegation stays open
 * to also relay the answer of the turn a later async delivery wakes.
 */
export function classifyRelaySettle(event: { isTerminal?: boolean; hasFinalResponse?: boolean }): RelaySettleAction {
	if (event.isTerminal !== false) return { relay: true, closeDelegation: true };
	return { relay: event.hasFinalResponse === true, closeDelegation: false };
}

/** Coordinates the realtime conversational surface with normal AgentSession turns. */
export class LiveSessionController {
	readonly #session: AgentSession;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #extractAssistantText: (message: AssistantMessage) => string;
	readonly #voice: string;
	readonly #speakableIdleMs: number;

	readonly #createTransport: (options: ConstructorParameters<typeof CodexLiveTransport>[0]) => LiveTransportLike;
	readonly #createRecorder: (
		sampleRate: number,
		callback: (error: Error | null, samples: Float32Array) => void,
	) => LiveRecorderLike;
	#transport: LiveTransportLike | undefined;
	#recorder: LiveRecorderLike | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#sendChain: Promise<void> = Promise.resolve();
	#stopPromise: Promise<void> | undefined;
	#started = false;
	#stopped = false;
	#terminalEmitted = false;
	#failure: Error | undefined;
	#muted = false;
	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	#outputSilenceTimer: NodeJS.Timeout | undefined;
	#outputSilenceDeadline = 0;
	#microphoneFrames = 0;
	#framesSent = 0;
	#framesDroppedAtGate = 0;
	#framesDroppedAtNativeQueue = 0;
	#activeDelegationId: string | undefined;
	/**
	 * Last assistant message already relayed for the active delegation. A settle
	 * that pauses for background jobs relays the answer while the delegation stays
	 * open, so the next settle must not repeat an answer the caller already heard.
	 */
	#lastRelayedResponse: AgentMessage | undefined;
	/** Monotonic voice-handoff generation; the newest survivor owns dispatch. */
	#delegationGeneration = 0;
	/** Canonical controller-owned user turns awaiting or undergoing a handoff. */
	#userTurns = new Map<number, UserLedgerTurn>();
	/** Insertion-order tail of {@link #userTurns}. Partial updates land here. */
	#tailTurnNumber: number | undefined;
	/** Ledger turns already final and unclaimed when the voice agent began its current response:
	 *  the turns that response answers. Undefined while no response is under way. */
	#answeredTurns: number[] | undefined;
	/** The transport finished connecting; context sent before then waits in {@link #pendingOperatorText}. */
	#connected = false;
	/** Ledger number of a partial turn the operator retired from the composer; the rest of that
	 *  utterance is ignored so its authoritative final cannot re-enter the ledger. */
	#retiredPartialTurn: number | undefined;
	/** Voice-triggering context (reports, final answers, typed prompts) went out since the voice
	 *  agent's last response ended. A response that may be answering it retires no spoken turns. */
	#contextSinceResponse = false;
	/** The voice agent is mid-response (between its first output and its turn.done). */
	#responding = false;
	#pendingOperatorText: Array<{ message: LiveClientMessage; sent: (delivered: boolean) => void }> = [];
	/** See {@link expectOperatorTurn}. */
	#operatorTurnPending = false;
	#userLedgerTurn = 0;
	readonly #seenDelegationIds = new Set<string>();
	#pendingDelegation:
		| { id: string; generation: number; turns: number[]; dispatchEnabled: boolean; dispatching: boolean }
		| undefined;
	#pendingDelivery: CustomMessageDelivery | undefined;
	/** Coalesced in-flight live abort, so rapid handoffs never overlap AgentSession.abort(). */
	#liveAbortPromise: Promise<void> | undefined;
	/**
	 * Expected obsolete aborted settles, one per live-handoff abort. Consumed by
	 * the matching `agent_end` whose assistant message has stopReason "aborted".
	 * Covers the bounded drain's timeout tail: a late settle from the torn-down
	 * turn must not relay into — or close — the newly claimed delegation, which
	 * would leave the genuine answer with nowhere to go.
	 */
	#expectedAbortedSettles = 0;
	/** Chars of the current assistant message's thinking already narrated to the voice surface. */
	#thinkingRelayedLength = 0;
	#lastThinkingFlushAt = 0;
	#thinkingFlushMs = DEFAULT_THINKING_FLUSH_MS;
	/**
	 * Voice-triggering context (crew reports, reasoning narration, final answers) held while the
	 * operator is speaking or editing the composer, in arrival order. Anything delivered then
	 * would make the voice agent talk over the operator and lose the in-progress utterance.
	 */
	#heldContext: HeldContextItem[] = [];
	#speakableIdleDeadline = 0;
	#speakableIdleTimer: NodeJS.Timeout | undefined;
	/** Serialized persistence tail for the live-transcript artifact (order + no double allocation). */
	#transcriptLogChain: Promise<void> = Promise.resolve();
	/** undefined = not yet allocated; null = permanently unavailable. */
	#transcriptLogPath: string | undefined | null;
	#userTranscript = "";
	#assistantTranscript = "";
	#userTranscriptFinal = false;
	#assistantTranscriptFinal = false;
	#userTranscriptTurn = 0;
	#assistantTranscriptTurn = 0;
	#lastTranscript: LiveTranscript | undefined;

	constructor(options: LiveSessionControllerOptions) {
		this.#session = options.session;
		this.#callbacks = options.callbacks;
		this.#extractAssistantText = options.extractAssistantText;
		this.#voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
		const speakableIdleMs = options.speakableIdleMs;
		this.#speakableIdleMs =
			typeof speakableIdleMs === "number" && Number.isFinite(speakableIdleMs) && speakableIdleMs >= 0
				? speakableIdleMs
				: DEFAULT_SPEAKABLE_IDLE_MS;
		const thinkingFlushMs = options.thinkingFlushMs;
		this.#thinkingFlushMs =
			typeof thinkingFlushMs === "number" && Number.isFinite(thinkingFlushMs) && thinkingFlushMs >= 0
				? thinkingFlushMs
				: DEFAULT_THINKING_FLUSH_MS;
		this.#createTransport = options.createTransport ?? (transportOptions => new CodexLiveTransport(transportOptions));
		this.#createRecorder = options.createRecorder ?? sharedAudioCapture;
	}

	/** Current realtime call phase. */
	get phase(): LivePhase {
		return this.#phase;
	}

	/** Whether microphone input is currently muted. */
	get muted(): boolean {
		return this.#muted;
	}

	/** Canonical user turns still awaiting a handoff or an answer. */
	pendingUserTurnCount(): number {
		return this.#userTurns.size;
	}

	/** Voice-triggering items held while the operator is active. */
	heldContextCount(): number {
		return this.#heldContext.length;
	}

	/** Connects the realtime surface and starts microphone streaming. */
	async start(): Promise<void> {
		if (this.#stopped) {
			throw (
				this.#failure ?? new Error("This live session has already stopped; create a new controller to reconnect.")
			);
		}
		if (this.#started) return;
		this.#started = true;
		this.#emitPhase("connecting", true);
		this.#emitTranscript(undefined);
		if (this.#stopped) {
			throw this.#failure ?? new Error("The live session stopped while starting.");
		}

		try {
			const user = currentUser();
			const instructions = prompt.render(await resolveLiveInstructions(), user);
			const transport = this.#createTransport({
				authStorage: this.#session.modelRegistry.authStorage,
				sessionId: this.#session.sessionId,
				instructions,
				voice: this.#voice,
				callbacks: {
					onEvent: event => this.#guardEvent(() => this.#handleLiveEvent(event)),
					onOutputLevel: level => this.#guardEvent(() => this.#handleOutputLevel(level)),
				},
			});
			this.#transport = transport;
			await transport.connect();
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped while connecting.");
			}
			this.#connected = true;
			const queued = this.#pendingOperatorText;
			this.#pendingOperatorText = [];
			for (const { message, sent } of queued) void this.#queueSend(message).then(sent);
			this.#unsubscribeSession = this.#session.subscribe(event =>
				this.#guardEvent(() => this.#handleSessionEvent(event)),
			);
			if (this.#muted) await transport.setMuted(true);
			if (this.#stopped) {
				throw this.#failure ?? new Error("The live session stopped before recording began.");
			}
			const recorder = this.#createRecorder(16_000, (error, samples) => {
				if (error) {
					this.#reportFailure(error);
					return;
				}
				this.#handleMicrophoneAudio(samples);
			});
			if (this.#stopped) {
				try {
					recorder.stop();
				} catch {
					// Preserve the failure that stopped startup.
				}
				throw this.#failure ?? new Error("The live session stopped while recording began.");
			}
			this.#recorder = recorder;
			this.#refreshAudioPhase();
		} catch (cause) {
			const error = errorFrom(cause);
			this.#reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	/** Toggles microphone capture while leaving output and the session connected. */
	toggleMute(): void {
		if (this.#stopped) return;
		this.#muted = !this.#muted;
		if (this.#muted) {
			this.#inputLevel = 0;
			this.#emitLevels();
		}
		this.#refreshAudioPhase();
		const transport = this.#transport;
		if (transport) {
			void transport.setMuted(this.#muted).catch(cause => this.#reportFailure(errorFrom(cause)));
		}
	}

	/** Stops recording, closes the live session, and emits one terminal callback. */
	stop(): Promise<void> {
		if (!this.#stopPromise) this.#stopPromise = this.#stop();
		return this.#stopPromise;
	}

	async #stop(): Promise<void> {
		// A handoff still in flight either never starts, or already belongs to the main agent; in
		// that case retire its speech from the composer now, while the caller still listens.
		const pending = this.#pendingDelegation;
		if (pending?.dispatching && this.#pendingDelivery && !this.#pendingDelivery.cancel()) {
			const turns = this.#turnsWhere(turn => turn.claim === pending.generation).map(turn => turn.turn);
			if (turns.length > 0) this.#emitDelegated(turns);
		} else {
			this.#pendingDelivery?.cancel();
		}
		this.#pendingDelegation = undefined;
		this.#pendingDelivery = undefined;
		this.#stopped = true;
		clearTimeout(this.#outputSilenceTimer);
		this.#outputSilenceTimer = undefined;
		clearTimeout(this.#speakableIdleTimer);
		this.#speakableIdleTimer = undefined;
		this.#speakableIdleDeadline = 0;
		this.#heldContext = [];
		for (const { sent } of this.#pendingOperatorText) sent(false);
		this.#pendingOperatorText = [];
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		// Flush a mid-utterance user transcript (VAD-split or aborted turn) so the
		// literal every-utterance guarantee covers interrupted speech, then drain
		// pending transcript writes before teardown.
		if (this.#userTranscript && !this.#userTranscriptFinal) {
			this.#recordLiveTranscript("user", this.#userTranscript, false);
		}
		let cleanupError: Error | undefined;

		const recorder = this.#recorder;
		this.#recorder = undefined;
		if (recorder) {
			try {
				recorder.stop();
			} catch (cause) {
				cleanupError = errorFrom(cause);
			}
		}
		this.#recordAudioDropSummary();
		await this.#transcriptLogChain;

		await this.#sendChain;
		const transport = this.#transport;
		this.#transport = undefined;
		if (transport) {
			try {
				await transport.send(buildSessionClose());
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
			try {
				await transport.close();
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
		}

		if (cleanupError) this.#emitPhaseSafely("error");
		this.#emitTerminal(cleanupError);
	}

	#guardEvent(handler: () => void): void {
		if (this.#stopped) return;
		try {
			handler();
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				this.#emitPhase("listening");
				break;
			case "session.updated":
			case "output_audio.delta":
			case "unknown":
				break;
			case "input_transcript.added":
				this.#recordLiveTranscript("user", event.item.text, false);
				this.#ingestUserTurn(event.item.text, false);
				this.#addTranscript("user", event.item.text);
				break;
			case "output_transcript.added":
				this.#noteResponseStart();
				this.#addTranscript("assistant", event.item.text);
				break;
			case "turn.done":
				this.#recordLiveTranscript(event.turn.role, event.turn.transcript, true);
				if (event.turn.role === "user") this.#ingestUserTurn(event.turn.transcript, true);
				else this.#retireAnsweredTurns();
				this.#finishTranscript(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				// This response hands the operator's words off rather than answering them.
				this.#answeredTurns = undefined;
				void this.#handleDelegation(event).catch(cause => this.#reportFailure(errorFrom(cause)));
				break;
			case "error":
				this.#reportFailure(new Error(event.message));
				break;
		}
	}

	/**
	 * Deliver a Codex Realtime coding handoff to the main agent session.
	 * The event contributes only its routing id. Prompt text is assembled from
	 * canonical user turns recorded by this controller. Newest intent wins:
	 * unaccepted claims move to the newest routing id, while accepted turns are
	 * retired and later speech barges into the active work as a new handoff.
	 */
	async #handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): Promise<void> {
		if (this.#seenDelegationIds.has(event.item.id)) return;
		this.#seenDelegationIds.add(event.item.id);

		const generation = ++this.#delegationGeneration;
		const previousGeneration = this.#pendingDelegation?.generation;
		const previousDelivery = this.#pendingDelivery;
		const cancelledPrevious = previousDelivery?.cancel() === true;
		if (previousDelivery && !cancelledPrevious && previousGeneration !== undefined) {
			// Acceptance won the race. Those turns already belong to the old
			// agent turn and must never be folded into this handoff. The old
			// continuation stops at the generation check, so retire their speech
			// from the composer here.
			const accepted = this.#deleteTurns(turn => turn.claim === previousGeneration);
			if (accepted.length > 0) this.#emitDelegated(accepted.map(turn => turn.turn));
		}
		this.#pendingDelivery = undefined;
		if (cancelledPrevious) {
			await previousDelivery.completed.catch(() => false);
		}
		if (generation !== this.#delegationGeneration) return;
		const claimed = this.#turnsWhere(
			turn => turn.claim === undefined || turn.claim === this.#pendingDelegation?.generation,
		);
		if (claimed.length === 0) return;
		// The voice agent is acting on the operator's words now; hold nothing back.
		this.#releaseHeldContext();
		for (const turn of claimed) turn.claim = generation;
		this.#pendingDelegation = {
			id: event.item.id,
			generation,
			turns: claimed.map(turn => turn.turn),
			dispatchEnabled: false,
			dispatching: false,
		};
		this.#emitPhase("working");
		if (this.#session.isStreaming || this.#session.isBashRunning || this.#session.isEvalRunning) {
			// Coalesce concurrent live aborts: AgentSession.abort() is not
			// reentrant-safe, and every waiter only needs "some abort finished
			// after I arrived". One expected settle per real abort, not per waiter.
			if (!this.#liveAbortPromise) {
				this.#expectedAbortedSettles += 1;
				this.#liveAbortPromise = this.#session
					.abort({ reason: USER_INTERRUPT_LABEL, drainSubscribers: true })
					.finally(() => {
						this.#liveAbortPromise = undefined;
					});
			}
			await this.#liveAbortPromise;
		}
		if (this.#stopped) return;
		// Superseded while awaiting: the newest survivor owns the ledger claims.
		if (generation !== this.#delegationGeneration) return;
		if (this.#pendingDelegation?.generation === generation) {
			this.#pendingDelegation.dispatchEnabled = true;
		}
		await this.#dispatchPendingDelegation(generation);
	}

	async #dispatchPendingDelegation(generation: number): Promise<void> {
		const pending = this.#pendingDelegation;
		if (!pending || pending.generation !== generation || !pending.dispatchEnabled || pending.dispatching) {
			return;
		}
		const turns = pending.turns
			.map(turnNumber => this.#userTurns.get(turnNumber))
			.filter((turn): turn is UserLedgerTurn => turn !== undefined && turn.claim === generation);
		if (turns.length === 0 || turns.some(turn => !turn.final)) return;
		const merged = turns
			.map(turn => turn.text)
			.join("\n\n")
			.trim();
		if (!merged) return;
		pending.dispatching = true;
		const delivery = this.#session.sendCustomMessageWithReceipt(
			{
				customType: LIVE_DELEGATION_MESSAGE_TYPE,
				content: merged,
				display: true,
				attribution: "agent",
			},
			{ triggerTurn: true },
		);
		this.#pendingDelivery = delivery;
		void delivery.completed.catch(() => {});
		let accepted = false;
		try {
			await delivery.accepted;
			accepted = true;
			if (generation !== this.#delegationGeneration) return;
			this.#deleteTurns(turn => turn.claim === generation);
			this.#pendingDelegation = undefined;
			this.#pendingDelivery = undefined;
			this.#activeDelegationId = pending.id;
			this.#lastRelayedResponse = undefined;
			this.#thinkingRelayedLength = 0;
			this.#emitDelegated(turns.map(turn => turn.turn));
			await delivery.completed;
		} catch (cause) {
			// A newer delegation barging in aborts this turn mid-await; that
			// rejection is expected and must not kill the live call.
			if (generation !== this.#delegationGeneration) return;
			if (!accepted) {
				// Normalization/preflight/drop failures occur before ownership.
				// Release the claim but retain the canonical transcript so a
				// later, distinct delegation trigger can retry it.
				for (const turn of this.#userTurns.values()) {
					if (turn.claim === generation) turn.claim = undefined;
				}
				this.#pendingDelegation = undefined;
				this.#pendingDelivery = undefined;
				this.#refreshAudioPhase();
				return;
			}
			throw cause;
		}
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (event.type === "irc_message") {
			this.#relayCrewMessage(event.message);
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			this.#relayThinkingProgress(event.message);
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#thinkingRelayedLength = 0;
			if (event.message.stopReason === "toolUse") this.#appendProgress(event.message);
			return;
		}
		if (event.type !== "agent_end") return;
		// Expected obsolete settle from a live-handoff abort: agent-core emits a
		// fresh empty assistant message with stopReason "aborted" for a deliberate
		// abort. Consume the token and ignore the settle entirely — relaying would
		// be empty and closing would retire the delegation the NEW turn owns. All
		// other terminal settles (including genuinely empty completions) keep
		// closing unconditionally so a stale delegation id can never route later
		// unrelated output into the voice call.
		if (this.#expectedAbortedSettles > 0) {
			const settled = [...event.messages].reverse().find(message => message?.role === "assistant");
			if (settled?.role === "assistant" && settled.stopReason === "aborted") {
				this.#expectedAbortedSettles -= 1;
				return;
			}
		}
		const { relay, closeDelegation } = classifyRelaySettle(event);
		if (!relay) return;
		this.#appendFinalResponse(event.messages, { closeDelegation });
	}

	#appendProgress(message: AssistantMessage): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) return;
		const progress = this.#extractAssistantText(message).trim();
		if (!progress) return;
		const chunks = chunkLiveContext(progress);
		this.#deliverOrHold("progress", () => {
			for (const chunk of chunks) {
				this.#queueSend(buildDelegationContextAppend(delegationId, chunk, "commentary"));
			}
		});
	}

	/**
	 * The voice agent began a response. Only a response to the operator's speech answers it;
	 * narration of released context (reports, final answers) must not retire turns awaiting a
	 * handoff. Classified once per response, before output releases any held context.
	 */
	#noteResponseStart(): void {
		if (this.#responding) return;
		this.#responding = true;
		// The response consumes the context sent before it; context sent during it counts for the next.
		const fromContext = this.#contextSinceResponse;
		this.#contextSinceResponse = false;
		if (this.#answeredTurns || fromContext) return;
		this.#answeredTurns = this.#turnsWhere(turn => turn.final && turn.claim === undefined).map(turn => turn.turn);
	}

	/** A main-agent turn the operator started from the composer with the destination `both`:
	 *  its final answer goes to the voice agent like a delegated one. */
	expectOperatorTurn(): void {
		if (!this.#stopped) this.#operatorTurnPending = true;
	}

	#appendFinalResponse(messages: readonly AgentMessage[], options: { closeDelegation: boolean }): void {
		const delegationId = this.#activeDelegationId;
		if (!delegationId) {
			if (this.#operatorTurnPending) this.#relayOperatorTurnResult(messages, options);
			return;
		}
		// A shared operator prompt folded into the delegated turn is answered by this settle.
		if (options.closeDelegation) this.#operatorTurnPending = false;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			// Already relayed at an earlier pause: a wake that produced no new answer
			// must not make the relay repeat itself.
			if (message === this.#lastRelayedResponse) break;
			const text = this.#extractAssistantText(message).trim();
			if (!text) continue;
			this.#lastRelayedResponse = message;
			const finalContext = prompt.render(agentFinalMessageTemplate, { message: text });
			// The operator asked for this answer: deliver it now. The speakable hold is for
			// unsolicited context only; holding a final answer delays it until the next handoff.
			this.#contextSinceResponse = true;
			for (const chunk of chunkLiveContext(finalContext)) {
				this.#queueSend(buildDelegationContextAppend(delegationId, chunk));
			}
			break;
		}
		if (options.closeDelegation) {
			this.#activeDelegationId = undefined;
			this.#lastRelayedResponse = undefined;
		}
		this.#refreshAudioPhase();
	}

	/** Relay the final answer of an operator-started turn at session level, labeled per chunk. */
	#relayOperatorTurnResult(messages: readonly AgentMessage[], options: { closeDelegation: boolean }): void {
		const message = messages.findLast(candidate => candidate?.role === "assistant");
		const text = message && message !== this.#lastRelayedResponse ? this.#extractAssistantText(message).trim() : "";
		if (text && message) {
			this.#lastRelayedResponse = message;
			const labelBytes = Buffer.byteLength(prompt.render(agentFinalMessageTemplate, { message: "" }), "utf8");
			this.#contextSinceResponse = true;
			for (const part of chunkLiveContext(text, CONTEXT_CHUNK_BYTES - labelBytes)) {
				this.#queueSend(buildSessionContextAppend(prompt.render(agentFinalMessageTemplate, { message: part })));
			}
		}
		if (options.closeDelegation) {
			this.#operatorTurnPending = false;
			this.#lastRelayedResponse = undefined;
		}
	}

	/**
	 * Hand composer text the operator typed to the voice model. `voice` addresses it to the
	 * voice agent, which answers it and must not delegate it; `both` marks text already sent
	 * to the main agent as silent awareness. Sent immediately: the operator is the source,
	 * so the speakable hold does not apply. Resolves whether every chunk reached the
	 * transport; text still waiting for the connection resolves false if the call ends first.
	 */
	sendOperatorText(text: string, audience: "voice" | "both"): Promise<boolean> {
		const message = text.trim();
		if (!message || this.#stopped) return Promise.resolve(false);
		const template = audience === "voice" ? operatorTypedMessageTemplate : operatorSharedMessageTemplate;
		// A typed prompt makes the voice agent answer it, not the speech around it.
		if (audience === "voice") this.#contextSinceResponse = true;
		const channel = audience === "voice" ? undefined : "commentary";
		// Every chunk carries the routing label: the voice agent routes each context item by it.
		const labelBytes = Buffer.byteLength(prompt.render(template, { message: "" }), "utf8");
		const deliveries: Promise<boolean>[] = [];
		for (const part of chunkLiveContext(message, CONTEXT_CHUNK_BYTES - labelBytes)) {
			const context = buildSessionContextAppend(prompt.render(template, { message: part }), channel);
			if (this.#connected) {
				deliveries.push(this.#queueSend(context));
			} else {
				const { promise, resolve } = Promise.withResolvers<boolean>();
				this.#pendingOperatorText.push({ message: context, sent: resolve });
				deliveries.push(promise);
			}
		}
		return Promise.all(deliveries).then(results => results.every(Boolean));
	}

	/**
	 * The operator submitted the composer, which already holds every spoken utterance not yet
	 * handed off. Drop the unclaimed ledger turns and cancel a handoff that has claimed turns but
	 * is not yet accepted, so neither a later delegation nor the pending one relays words the
	 * operator already sent, edited, or deleted. Turns the main agent already accepted stay
	 * with it. Returns false when a handoff was accepted but has not yet retired its speech from
	 * the composer: submitting now would send those words a second time.
	 */
	retireComposerSpeech(): boolean {
		const pending = this.#pendingDelegation;
		const last = this.#tailTurn();
		let settled = true;
		if (pending && !(this.#pendingDelivery?.cancel() ?? true)) {
			settled = false;
		} else if (pending) {
			// Supersede the handoff: its in-flight abort/dispatch sees a newer generation and stops.
			this.#delegationGeneration += 1;
			this.#pendingDelegation = undefined;
			this.#pendingDelivery = undefined;
			this.#deleteTurns(turn => turn.claim === pending.generation);
			this.#refreshAudioPhase();
		}
		this.#deleteTurns(turn => turn.claim === undefined);
		// A partial turn retired mid-utterance: the rest of it, final included, is already handled.
		if (last && !last.final && !this.#userTurns.has(last.turn)) this.#retiredPartialTurn = last.turn;
		this.#answeredTurns = undefined;
		return settled;
	}

	/** The voice agent finished answering: the turns it answered are its own and must not ride a
	 *  later handoff. Speech that arrived during the answer stays for a later delegation. */
	#retireAnsweredTurns(): void {
		this.#responding = false;
		const answered = this.#answeredTurns;
		this.#answeredTurns = undefined;
		if (!answered?.length) return;
		this.#deleteTurns(turn => turn.claim === undefined && answered.includes(turn.turn));
	}

	/** Fleet feed: relay a crew IRC message onto the speakable channel for background awareness. */
	#relayCrewMessage(message: CustomMessage): void {
		const details = message.details as { from?: string; message?: string } | undefined;
		const from = details?.from?.trim() || "unknown crew";
		const body = details?.message?.trim() ?? "";
		if (!body) return;
		// Headline-sized: the operator reads the full text in the TUI; the voice
		// surface only needs enough to narrate the development.
		this.#appendSpeakable(`Crew report from ${from}: ${body}`);
	}

	/**
	 * Narrate the main agent's in-progress reasoning: boundary-cut, rate-capped,
	 * explicitly labeled provisional so the voice surface can say "the main
	 * agent is currently thinking about…" without presenting it as a result.
	 */
	#relayThinkingProgress(message: AssistantMessage): void {
		let thinking = "";
		for (const block of message.content) {
			if ((block as { type?: string }).type !== "thinking") continue;
			thinking += (block as { thinking?: string }).thinking ?? "";
		}
		if (thinking.length <= this.#thinkingRelayedLength) return;
		const unsent = thinking.slice(this.#thinkingRelayedLength);
		if (unsent.length < 280) return;
		if (Date.now() - this.#lastThinkingFlushAt < this.#thinkingFlushMs) return;
		const boundary = Math.max(unsent.lastIndexOf(". "), unsent.lastIndexOf("\n"));
		if (boundary < 120) return;
		const cut = unsent.slice(0, boundary + 1).trim();
		if (!cut) return;
		this.#thinkingRelayedLength += boundary + 1;
		this.#lastThinkingFlushAt = Date.now();
		this.#appendSpeakable(`Main agent reasoning (live, provisional): ${cut}`, "thinking");
	}

	/**
	 * Append one labeled item on the speakable channel — delegation-scoped when
	 * one is active. A speakable item MUST fit a single wire chunk: independent
	 * chunks would reach the voice model as unlabeled fragments and be spoken
	 * mid-assembly (the exact failure that killed voicing final-answer chunks),
	 * so overflow is truncated at the byte cap, never split.
	 */
	#appendSpeakable(text: string, kind: HeldContextKind = "report"): void {
		const chunks = chunkLiveContext(text);
		let item = chunks[0] ?? "";
		if (!item) return;
		if (chunks.length > 1) {
			// Reserve room for the ellipsis without splitting a surrogate pair:
			// chunkLiveContext is the code-point-safe truncation primitive.
			let units = [...item];
			while (units.length > 0 && Buffer.byteLength(units.join(""), "utf8") > CONTEXT_CHUNK_BYTES - 3) {
				units = units.slice(0, -4);
			}
			item = `${units.join("").trimEnd()}…`;
		}
		this.#deliverOrHold(kind, () => this.#sendSpeakable(item));
	}

	/**
	 * Deliver voice-triggering context now, or hold it while operator activity is recent.
	 * Held items release in order on the quiet deadline, when the voice agent starts
	 * speaking anyway, or when it delegates.
	 */
	#deliverOrHold(kind: HeldContextKind, send: () => void): void {
		if (Date.now() < this.#speakableIdleDeadline) {
			if (kind === "thinking" || kind === "progress") {
				const existing = this.#heldContext.findIndex(item => item.kind === kind);
				if (existing >= 0) {
					this.#heldContext[existing] = { kind, send };
					return;
				}
			}
			this.#heldContext.push({ kind, send });
			this.#trimHeldContext();
			return;
		}
		this.#releaseHeldContext();
		send();
	}

	/** Drop the oldest crew reports first so the latest thinking and progress survive the cap. */
	#trimHeldContext(): void {
		while (this.#heldContext.length > HELD_CONTEXT_CAP) {
			const oldestReport = this.#heldContext.findIndex(item => item.kind === "report");
			if (oldestReport >= 0) this.#heldContext.splice(oldestReport, 1);
			else this.#heldContext.shift();
		}
	}

	/** Record composer edits as operator activity, holding voice-triggering context meanwhile. */
	noteComposerActivity(): void {
		this.#markUserActivity();
	}

	#sendSpeakable(item: string): void {
		this.#contextSinceResponse = true;
		const delegationId = this.#activeDelegationId;
		this.#queueSend(
			delegationId
				? buildDelegationContextAppend(delegationId, item, "speakable")
				: buildSessionContextAppend(item, "speakable"),
		);
	}

	#markUserActivity(): void {
		if (this.#stopped) return;
		this.#speakableIdleDeadline = Date.now() + this.#speakableIdleMs;
		this.#speakableIdleTimer ??= setTimeout(() => this.#handleSpeakableIdle(), this.#speakableIdleMs);
	}

	#handleSpeakableIdle(): void {
		this.#speakableIdleTimer = undefined;
		if (this.#stopped) return;
		const remaining = this.#speakableIdleDeadline - Date.now();
		if (remaining > 0) {
			this.#speakableIdleTimer = setTimeout(() => this.#handleSpeakableIdle(), remaining);
			return;
		}
		this.#releaseHeldContext();
	}

	#releaseHeldContext(): void {
		clearTimeout(this.#speakableIdleTimer);
		this.#speakableIdleTimer = undefined;
		this.#speakableIdleDeadline = 0;
		if (this.#stopped) return;
		const held = this.#heldContext;
		this.#heldContext = [];
		for (const item of held) item.send();
	}

	#handleOutputLevel(level: number): void {
		const wasActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
		this.#outputSilenceDeadline = Date.now() + OUTPUT_SILENCE_MS;
		this.#outputSilenceTimer ??= setTimeout(() => this.#expireOutputLevel(), OUTPUT_SILENCE_MS);
		this.#outputLevel = clampLevel(level);
		this.#emitLevels();
		if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL && this.#heldContext.length > 0) {
			// Classify the response now starting before its output releases held context.
			if (!wasActive) this.#noteResponseStart();
			this.#releaseHeldContext();
		}
		if (!this.#activeDelegationId) this.#refreshAudioPhase();
	}

	#expireOutputLevel(): void {
		this.#outputSilenceTimer = undefined;
		if (this.#stopped) return;
		const remaining = this.#outputSilenceDeadline - Date.now();
		if (remaining > 0) {
			this.#outputSilenceTimer = setTimeout(() => this.#expireOutputLevel(), remaining);
			return;
		}
		this.#outputLevel = 0;
		this.#emitLevels();
		if (!this.#activeDelegationId) this.#refreshAudioPhase();
	}

	#handleMicrophoneAudio(samples: Float32Array): void {
		if (this.#stopped || !this.#transport) return;
		if (this.#muted) return;
		this.#inputLevel = microphoneLevel(samples);
		this.#emitLevels();
		this.#microphoneFrames += 1;
		// Until the native audio path has AEC, suppress likely speaker echo
		// during playback. The speaker level expires when packets stop arriving.
		const outputActive = this.#outputLevel > OUTPUT_ACTIVE_LEVEL;
		const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.#outputLevel * OUTPUT_ECHO_RATIO);
		if (outputActive && this.#inputLevel < echoThreshold) {
			this.#framesDroppedAtGate += 1;
			return;
		}
		if (this.#inputLevel >= MIN_BARGE_IN_LEVEL) this.#markUserActivity();
		try {
			if (this.#transport.pushAudio(samples)) this.#framesSent += 1;
			else this.#framesDroppedAtNativeQueue += 1;
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		if (role === "user" && text.trim()) this.#markUserActivity();
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.#startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.#startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = current + text;
		}
		this.#storeTranscript(role, next, false);
	}

	#finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		if (role === "user" && text.trim()) this.#markUserActivity();
		const current = role === "user" ? this.#userTranscript : this.#assistantTranscript;
		const wasFinal = role === "user" ? this.#userTranscriptFinal : this.#assistantTranscriptFinal;
		if (!current) {
			this.#startTranscriptTurn(role);
		} else if (wasFinal) {
			if (text === current) return;
			this.#startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.#storeTranscript(role, next, true);
	}

	#startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") {
			this.#userTranscriptTurn += 1;
		} else {
			this.#assistantTranscriptTurn += 1;
		}
	}

	#storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		const turn = role === "user" ? this.#userTranscriptTurn : this.#assistantTranscriptTurn;
		if (role === "user") {
			this.#userTranscript = normalized;
			this.#userTranscriptFinal = final;
		} else {
			this.#assistantTranscript = normalized;
			this.#assistantTranscriptFinal = final;
		}
		if (
			this.#lastTranscript?.role === role &&
			this.#lastTranscript.turn === turn &&
			this.#lastTranscript.text === normalized &&
			this.#lastTranscript.final === final
		) {
			return;
		}
		this.#emitTranscript({ role, turn, text: normalized, final });
	}

	#ingestUserTurn(text: string, final: boolean): void {
		const normalized = text.trim();
		const retired = this.#retiredPartialTurn;
		if (retired !== undefined) {
			if (final) this.#retiredPartialTurn = undefined;
			this.#emitUserSpeech({ role: "user", turn: retired, text: normalized, final });
			return;
		}
		let current = this.#tailTurn();
		if (!normalized) {
			// An empty authoritative final retracts the partial it closes.
			if (final && current && !current.final) this.#retractPartialTurn(current);
			return;
		}
		if (!current || current.final) {
			current = { turn: ++this.#userLedgerTurn, text: normalized, final };
			this.#putTurn(current);
		} else if (final) {
			// turn.done is authoritative, including contractions of a partial.
			current.text = normalized;
			current.final = true;
		} else if (normalized.startsWith(current.text)) {
			current.text = normalized;
		} else if (!current.text.startsWith(normalized)) {
			// Incremental chunks carry their own leading space (" a", " bug"); a chunk without
			// one continues the previous word. Trimming it away glued words together.
			current.text += /^\s/.test(text) ? ` ${normalized}` : normalized;
		}
		this.#emitUserSpeech({ role: "user", turn: current.turn, text: current.text, final: current.final });
		const pendingGeneration = this.#pendingDelegation?.generation;
		if (final && pendingGeneration !== undefined) {
			void this.#dispatchPendingDelegation(pendingGeneration).catch(cause => this.#reportFailure(errorFrom(cause)));
		}
	}

	/** Drop a partial turn the recognizer withdrew, clearing its composer preview. A pending handoff
	 *  that claimed it either dispatches its remaining turns or, with none left, ends. */
	#retractPartialTurn(turn: { turn: number; claim?: number }): void {
		this.#deleteTurns(entry => entry.turn === turn.turn);
		this.#emitUserSpeech({ role: "user", turn: turn.turn, text: "", final: true });
		const pending = this.#pendingDelegation;
		if (!pending || turn.claim !== pending.generation) return;
		pending.turns = pending.turns.filter(number => number !== turn.turn);
		if (pending.turns.length === 0) {
			this.#delegationGeneration += 1;
			this.#pendingDelegation = undefined;
			this.#pendingDelivery = undefined;
			this.#refreshAudioPhase();
			return;
		}
		void this.#dispatchPendingDelegation(pending.generation).catch(cause => this.#reportFailure(errorFrom(cause)));
	}

	#recordAudioDropSummary(): void {
		const playback = this.#transport?.playbackQueueStats?.() ?? { queuedMs: 0, droppedMs: 0 };
		if (
			this.#framesDroppedAtGate === 0 &&
			this.#framesDroppedAtNativeQueue === 0 &&
			playback.droppedMs === 0 &&
			playback.queuedMs === 0
		) {
			return;
		}
		const summary = {
			captured: this.#microphoneFrames,
			sent: this.#framesSent,
			droppedAtGate: this.#framesDroppedAtGate,
			droppedAtNativeQueue: this.#framesDroppedAtNativeQueue,
			playbackQueuedMs: playback.queuedMs,
			playbackDroppedMs: playback.droppedMs,
		};
		logger.warn("Live microphone frame drops", summary);
		this.#queueTranscriptLine(
			JSON.stringify({ ts: new Date().toISOString(), type: "audio-frame-summary", ...summary }),
		);
	}

	#tailTurn(): UserLedgerTurn | undefined {
		if (this.#tailTurnNumber === undefined) return undefined;
		return this.#userTurns.get(this.#tailTurnNumber);
	}

	#putTurn(turn: UserLedgerTurn): void {
		this.#userTurns.set(turn.turn, turn);
		this.#tailTurnNumber = turn.turn;
	}

	#turnsWhere(predicate: (turn: UserLedgerTurn) => boolean): UserLedgerTurn[] {
		const matched: UserLedgerTurn[] = [];
		for (const turn of this.#userTurns.values()) {
			if (predicate(turn)) matched.push(turn);
		}
		return matched;
	}

	/** Delete matching turns and keep the tail pointing at the newest survivor. */
	#deleteTurns(predicate: (turn: UserLedgerTurn) => boolean): UserLedgerTurn[] {
		const removed: UserLedgerTurn[] = [];
		for (const turn of this.#userTurns.values()) {
			if (predicate(turn)) removed.push(turn);
		}
		for (const turn of removed) this.#userTurns.delete(turn.turn);
		if (this.#tailTurnNumber !== undefined && !this.#userTurns.has(this.#tailTurnNumber)) {
			this.#tailTurnNumber = undefined;
			for (const number of this.#userTurns.keys()) this.#tailTurnNumber = number;
		}
		return removed;
	}

	/**
	 * Persist one raw transcript line to the session-scoped live-transcript
	 * artifact. Recorded BEFORE UI dedupe on purpose: repeated identical
	 * utterances and VAD-split fragments must all survive — the point of this
	 * buffer is recovering utterances the voice model consumed. Serialized on a
	 * single promise tail (ordering + no double allocation); never fatal to the
	 * call; transcript text never appears in error logs (PII).
	 */
	#recordLiveTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		if (!text.trim()) return;
		this.#queueTranscriptLine(JSON.stringify({ ts: new Date().toISOString(), role, final, text }));
	}

	#queueTranscriptLine(line: string): void {
		this.#transcriptLogChain = this.#transcriptLogChain
			.then(() => this.#appendTranscriptLine(line))
			.catch(error => {
				logger.warn("Live transcript persistence failed", { error: String(error) });
			});
	}

	async #appendTranscriptLine(line: string): Promise<void> {
		if (this.#transcriptLogPath === null) return;
		if (this.#transcriptLogPath === undefined) {
			const allocated = await this.#session.sessionManager.allocateArtifactPath("live-transcript");
			if (allocated.path) {
				this.#transcriptLogPath = allocated.path;
				logger.info("Live transcript artifact allocated", { id: allocated.id, path: allocated.path });
			} else {
				// Unpersisted session: keep the guarantee with a private tmp file
				// (0600, wiped with tmp) rather than silently dropping utterances —
				// but never a durable home-directory copy (voice transcripts are PII).
				const fallback = join(os.tmpdir(), `omp-live-transcript-${Date.now()}.jsonl`);
				this.#transcriptLogPath = fallback;
				logger.warn("Session has no artifact store; live transcript using tmp fallback", { path: fallback });
			}
		}
		await appendFile(this.#transcriptLogPath, `${line}\n`, { mode: 0o600 });
	}

	/** Queue one message behind earlier sends; resolves whether the transport accepted it. */
	#queueSend(message: LiveClientMessage): Promise<boolean> {
		const transport = this.#transport;
		if (!transport || this.#stopped) return Promise.resolve(false);
		const sent = this.#sendChain.then(async () => {
			if (this.#stopped) return false;
			await transport.send(message);
			return true;
		});
		this.#sendChain = sent.then(
			() => {},
			cause => this.#reportFailure(errorFrom(cause)),
		);
		return sent.catch(() => false);
	}

	#refreshAudioPhase(): void {
		if (this.#stopped) return;
		if (this.#muted) {
			this.#emitPhase("muted");
		} else if (this.#activeDelegationId) {
			this.#emitPhase("working");
		} else if (this.#outputLevel > OUTPUT_ACTIVE_LEVEL) {
			this.#emitPhase("speaking");
		} else {
			this.#emitPhase("listening");
		}
	}

	#emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.#phase === phase) return;
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitPhaseSafely(phase: LivePhase): void {
		this.#phase = phase;
		try {
			this.#callbacks.onPhase(phase);
		} catch {
			// Terminal callback is the final error boundary for UI failures.
		}
	}

	#emitLevels(): void {
		try {
			this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitTranscript(transcript: LiveTranscript | undefined): void {
		this.#lastTranscript = transcript;
		try {
			this.#callbacks.onTranscript(transcript);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitUserSpeech(speech: LiveTranscript): void {
		try {
			this.#callbacks.onUserSpeech?.(speech);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#emitDelegated(turns: readonly number[]): void {
		try {
			this.#callbacks.onDelegated?.(turns);
		} catch (cause) {
			this.#reportFailure(errorFrom(cause));
		}
	}

	#reportFailure(error: Error): void {
		if (this.#terminalEmitted) return;
		this.#failure = error;
		this.#emitPhaseSafely("error");
		this.#emitTerminal(error);
		void this.stop();
	}

	#emitTerminal(error?: Error): void {
		if (this.#terminalEmitted) return;
		this.#terminalEmitted = true;
		try {
			this.#callbacks.onTerminal(error);
		} catch {
			// Nothing remains above the terminal callback to receive its error.
		}
	}
}
