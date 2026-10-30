import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { logger } from "@oh-my-pi/pi-utils";
import { type RoleChainCandidate, resolveConfiguredModelPatterns, resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { type Settings, settings } from "../config/settings";
import { preemptEventAudio } from "../event-audio/activity";
import { resolveXAIHttpTransport, type XAIHttpProvider, type XAIHttpTransportRegistry } from "../lib/xai-http";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";
import { sharedAudioCapture } from "./shared-audio-capture";
import { WavFileRecorder } from "./wav-file-recorder";

import { cfgSttLanguage, cfgSttSubmitTrigger } from "./settings";

export type SttState = "idle" | "recording" | "transcribing";

/** How a capture reports progress and state to its host. */
export interface SttCallbacks {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Keep this capture as a draft, without interpreting submit commands. */
	manualSubmit?: boolean;
}

/** The slice of a text input the controller dictates into. */
export interface SttTarget {
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
}

interface CaptureHandle {
	stop(): void;
}

type CaptureFactory = (onAudio: (error: Error | null, samples: Float32Array) => void) => CaptureHandle;

interface SttRegistry extends ModelBrowserRegistry, XAIHttpTransportRegistry {
	resolver(model: Model<Api>, sessionId?: string): ApiKeyResolver;
}

export interface STTControllerDependencies {
	settings: Settings;
	registry: SttRegistry;
	getSessionId?: () => string;
}

/** Coordinates native microphone capture with streaming local or buffered cloud transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: SttModelKey | null = null;
	#toggling = false;
	#stopAfterStart = false;
	/** Only the held gesture that starts a capture may finalize it. */
	#holdOwned = false;
	/** Cancels the start in flight: its model preflight wait and whatever start step follows it. */
	#startAbort: AbortController | null = null;
	#disposed = false;
	readonly #createCapture: CaptureFactory;
	readonly #settings: Settings;
	readonly #registry: SttRegistry | undefined;
	readonly #getSessionId: (() => string) | undefined;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: SttTarget | null = null;
	/** Callbacks of the running capture, from the {@link start} that began it. */
	#streamCallbacks: SttCallbacks | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";

	// Buffered cloud capture.
	#cloudModel: Model<Api> | null = null;
	#cloudFile: WavFileRecorder | null = null;
	readonly #retainedCloudFiles: WavFileRecorder[] = [];

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor();
	constructor(createCapture: CaptureFactory);
	constructor(dependencies: STTControllerDependencies);
	constructor(createCapture: CaptureFactory, dependencies: STTControllerDependencies);
	constructor(
		createCaptureOrDependencies?: CaptureFactory | STTControllerDependencies,
		dependencies?: STTControllerDependencies,
	) {
		if (typeof createCaptureOrDependencies === "function") {
			this.#createCapture = createCaptureOrDependencies;
			this.#settings = dependencies?.settings ?? settings;
			this.#registry = dependencies?.registry;
			this.#getSessionId = dependencies?.getSessionId;
		} else {
			this.#createCapture = onAudio => sharedAudioCapture(16_000, onAudio);
			this.#settings = createCaptureOrDependencies?.settings ?? settings;
			this.#registry = createCaptureOrDependencies?.registry;
			this.#getSessionId = createCaptureOrDependencies?.getSessionId;
		}
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: SttCallbacks): void {
		this.#state = state;
		if (state !== "idle") preemptEventAudio();
		options.onStateChange(state);
	}

	/** Start dictating into `editor`, reporting to `options` until the capture ends. A no-op while a
	 *  capture is starting, recording, or transcribing. */
	async start(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#disposed) return;
		if (this.#state === "transcribing") options.showStatus("Transcription in progress...");
		if (this.#disposed || this.#toggling || this.#state !== "idle") return;
		await this.#transition(options, () => this.#start(editor, options));
	}

	/** Stop the running capture and transcribe it. A capture still starting is cancelled: a pending
	 *  model preflight stops waiting (the worker keeps loading), otherwise it stops once it is up.
	 *  A no-op unless starting or recording. */
	async stop(): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			if (this.#state === "idle") this.#startAbort?.abort();
			return;
		}
		const callbacks = this.#streamCallbacks;
		if (this.#state === "recording" && callbacks) await this.#transition(callbacks, () => this.#stop(callbacks));
	}

	/** Stop a capture that is starting or recording; otherwise start one into `editor`. */
	async toggle(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#state === "recording" || (this.#toggling && this.#state === "idle")) await this.stop();
		else await this.start(editor, options);
	}

	/** Run one start/stop step, then honor a stop requested while it was in flight. */
	async #transition(options: SttCallbacks, step: () => Promise<void>): Promise<void> {
		this.#toggling = true;
		try {
			await step();
			if (this.#disposed) return;
			if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(options);
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	/** Start a capture owned by a held push-to-talk gesture. A hold never takes over (and so can
	 *  never stop) a capture the toggle chord already started. */
	async holdStart(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#state !== "idle" || this.#toggling) return;
		this.#holdOwned = true;
		await this.start(editor, options);
		if (this.#state === "idle") this.#holdOwned = false;
	}

	/** Stop the capture only when the matching held gesture started it. */
	async holdEnd(): Promise<void> {
		if (!this.#holdOwned) return;
		this.#holdOwned = false;
		await this.stop();
	}

	#resolveCandidate(): RoleChainCandidate | undefined {
		if (!this.#registry) return undefined;
		const pool = roleCandidatePool("dictation", this.#settings, this.#registry);
		return resolveRoleChain("dictation", this.#settings, pool)[0];
	}

	/** Transcribe a complete wake recording once, using the same dictation role. */
	async transcribeRecording(audio: Float32Array, signal: AbortSignal): Promise<string> {
		const model = this.#resolveCandidate()?.model;
		if (model?.api === "openai-transcriptions" || model?.api === "xai-stt") {
			const file = new WavFileRecorder();
			try {
				file.append(audio);
				return await this.#transcribeFile(model, file.finalize(), signal);
			} finally {
				file.dispose();
			}
		}
		if (model && model.api !== "local-inference") throw new Error(`Unsupported speech-to-text API: ${model.api}`);
		const key = this.#resolveModelKey(model);
		await downloadSttModel(key, undefined, { signal });
		return sttClient.transcribe(key, audio, { language: cfgSttLanguage.get(this.#settings), signal });
	}

	async #transcribeFile(model: Model<Api>, recordingPath: string, signal: AbortSignal): Promise<string> {
		if (!this.#registry) throw new Error("No dictation model registry");
		const language = cfgSttLanguage.get(this.#settings);
		let requestModel = model;
		if (model.api === "xai-stt") {
			const transport = await resolveXAIHttpTransport(this.#registry, model.provider as XAIHttpProvider, model.id);
			if (transport.baseURL !== model.baseUrl || transport.headers !== model.headers) {
				requestModel = { ...model, baseUrl: transport.baseURL, headers: transport.headers };
			}
		}
		signal.throwIfAborted();
		const result = await transcribeAudio(
			requestModel,
			{
				audio: Bun.file(recordingPath),
				mimeType: "audio/wav",
				fileName: "dictation.wav",
				responseFormat: "json",
				...(language && { language }),
			},
			{ apiKey: this.#registry.resolver(requestModel, this.#getSessionId?.()), signal },
		);
		return result.text.trim();
	}

	#resolveModelKey(model = this.#resolveCandidate()?.model): SttModelKey {
		return resolveSttModelSpec(model?.id).key;
	}

	async #ensureDeps(options: SttCallbacks, modelKey: SttModelKey, signal: AbortSignal): Promise<SttModelKey | null> {
		// Keyed on the resolved role model rather than a one-shot flag: changing
		// modelRoles.dictation mid-session re-runs preflight for the new model.
		if (this.#resolvedModelKey === modelKey) return modelKey;
		try {
			// Native streaming needs a ready recognizer before the microphone opens;
			// otherwise the first words queue behind a cold model load. Buffered
			// models can still warm in the background while recording.
			const spec = resolveSttModelSpec(modelKey);
			const online = spec.engine === "sherpa" && spec.mode === "online";
			if (!online && (await isSttModelCached(modelKey))) {
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, undefined, { signal });
			}
			if (this.#disposed) return null;
			this.#resolvedModelKey = modelKey;
			return modelKey;
		} catch (err) {
			if (this.#disposed) return null;
			// A cancelled start is not a setup failure; the worker finishes the load for the next start.
			if (signal.aborted) return null;
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return null;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: SttModelKey): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(editor: SttTarget, options: SttCallbacks): Promise<void> {
		const abort = new AbortController();
		this.#startAbort = abort;
		try {
			await this.#startWith(editor, options, abort.signal);
		} finally {
			if (this.#startAbort === abort) this.#startAbort = null;
		}
	}

	async #startWith(editor: SttTarget, options: SttCallbacks, signal: AbortSignal): Promise<void> {
		const first = this.#resolveCandidate();
		if (first?.replaces) {
			options.showWarning(
				`Dictation model ${first.replaces} not found; using ${first.model.provider}/${first.model.id}`,
			);
		} else if (!first && this.#registry) {
			// Empty chain: nothing replaced the configured selector, so the built-in local model runs.
			const role = this.#settings.getModelRole("dictation")?.trim();
			const qualified = role
				? (resolveConfiguredModelPatterns(role, this.#settings) ?? [role]).find(pattern => pattern.includes("/"))
				: undefined;
			if (qualified) options.showWarning(`Dictation model ${qualified} not found; using the built-in local model`);
		}
		let model = first?.model;
		if (model?.api === "openai-transcriptions" || model?.api === "xai-stt") {
			this.#startBuffered(editor, options, model);
			return;
		}
		if (model && model.api !== "local-inference") {
			options.showWarning(`Unsupported speech-to-text API: ${model.api}`);
			return;
		}

		let modelKey = await this.#ensureDeps(options, this.#resolveModelKey(model), signal);
		if (!modelKey || signal.aborted) return;
		model = this.#resolveCandidate()?.model;
		if (model?.api === "openai-transcriptions" || model?.api === "xai-stt") {
			this.#startBuffered(editor, options, model);
			return;
		}
		if (model && model.api !== "local-inference") {
			options.showWarning(`Unsupported speech-to-text API: ${model.api}`);
			return;
		}
		const startModelKey = this.#resolveModelKey(model);
		if (startModelKey !== modelKey) {
			modelKey = await this.#ensureDeps(options, startModelKey, signal);
			if (this.#disposed || !modelKey || signal.aborted) return;
		}
		await this.#startStreaming(editor, options, modelKey);
	}

	async #stop(options: SttCallbacks): Promise<void> {
		if (this.#cloudModel) await this.#stopBuffered(options);
		else await this.#stopStreaming(options);
	}

	// ── Buffered cloud transcription ────────────────────────────────

	#startBuffered(editor: SttTarget, options: SttCallbacks, model: Model<Api>): void {
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		this.#cloudModel = model;

		try {
			const file = new WavFileRecorder();
			this.#cloudFile = file;
			this.#streamRecorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#cloudModel !== model || this.#state !== "recording") return;
				if (!error) {
					try {
						file.append(samples);
						return;
					} catch (cause) {
						error = cause instanceof Error ? cause : new Error(String(cause));
					}
				}
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					const recorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						recorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
					this.#streamAbort?.abort(error);
					this.#streamEditor?.clearVolatileText();
					this.#cleanupCloud();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
			});
		} catch (err) {
			this.#streamAbort?.abort();
			this.#cleanupCloud();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}

		this.#setState("recording", options);
		logger.debug("STT buffered recording started", { model: `${model.provider}/${model.id}` });
	}

	async #stopBuffered(options: SttCallbacks): Promise<void> {
		const model = this.#cloudModel;
		const recorder = this.#streamRecorder;
		const file = this.#cloudFile;
		const abort = this.#streamAbort;
		if (!model || !file || !abort || !this.#registry) {
			this.#cleanupCloud();
			this.#setState("idle", options);
			return;
		}

		this.#setState("transcribing", options);
		options.showStatus("Transcribing...");
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: buffered recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		let recordingPath: string | undefined;
		try {
			if (!file.empty) {
				recordingPath = file.finalize();
				this.#cloudFile = null;
				this.#retainedCloudFiles.push(file);
				if (this.#retainedCloudFiles.length > 5) this.#retainedCloudFiles.shift()?.dispose();
				finalText = await this.#transcribeFile(model, recordingPath, abort.signal);
			}
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(recordingPath ? `${msg}. Recording retained at ${recordingPath}` : msg);
				logger.error("STT cloud transcription failed", { error: msg, recordingPath });
			}
		}
		if (this.#disposed) {
			this.#cleanupCloud();
			return;
		}

		this.#finishTranscript(finalText, failed, options);
		this.#cleanupCloud();
		this.#setState("idle", options);
	}

	#cleanupCloud(): void {
		this.#cloudModel = null;
		this.#cloudFile?.dispose();
		this.#cloudFile = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCallbacks = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: SttTarget, options: SttCallbacks, modelKey: SttModelKey): Promise<void> {
		const language = cfgSttLanguage.get(this.#settings);
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#streamEditor?.setVolatileText(this.#prefixed(text));
			},
			onSegment: text => {
				if (this.#disposed) return;
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamEditor?.commitVolatileText(prefixed);
					this.#streamCommitted = true;
					this.#streamUtterance += prefixed;
				} else {
					this.#streamEditor?.clearVolatileText();
				}
			},
		});
		this.#stream = stream;
		let recorder: CaptureHandle;
		try {
			recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#stream !== stream || this.#state !== "recording") return;
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					const activeRecorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						activeRecorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
					this.#streamAbort?.abort(error);
					stream.cancel();
					this.#streamEditor?.clearVolatileText();
					this.#cleanupStream();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				stream.pushAudio(samples);
			});
		} catch (err) {
			stream.cancel();
			this.#cleanupStream();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey });
	}

	async #stopStreaming(options: SttCallbacks): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		// Stop the mic first so no further audio is fed, then flush the worker.
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		this.#finishTranscript(finalText, failed, options);
		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCallbacks = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	#finishTranscript(finalText: string, failed: boolean, options: SttCallbacks): void {
		if (!this.#streamCommitted && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");

		if (!options.manualSubmit && this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = cfgSttSubmitTrigger.get(this.#settings);
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		const editor = this.#streamEditor;
		const callbacks = this.#streamCallbacks;
		this.#disposed = true;
		this.#holdOwned = false;
		this.#startAbort?.abort();
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		try {
			this.#stream?.cancel();
		} catch {
			// A failed provider cancel must not leave the microphone or composer owned.
		}
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best effort cleanup
		}
		try {
			editor?.clearVolatileText();
		} catch (error) {
			logger.debug("stt: retired editor cleanup failed", { error: String(error) });
		}
		this.#cleanupStream();
		this.#cleanupCloud();
		for (const file of this.#retainedCloudFiles) file.dispose();
		this.#retainedCloudFiles.length = 0;
		this.#state = "idle";
		this.#resolvedModelKey = null;
		callbacks?.onStateChange("idle");
	}
}
