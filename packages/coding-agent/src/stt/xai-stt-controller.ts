import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { evaluateSubmitTrigger } from "./submit-trigger";
import type { SttState } from "./stt-controller";
import { WavFileRecorder } from "./wav-file-recorder";

/** xAI capture states: the shared STT states plus a post-processing stage after transcription. */
export type XaiSttState = SttState | "postprocessing";

/** Rewrites a raw transcript before it reaches the composer (a voice filter pass). */
export type TranscriptPostProcessor = (text: string, signal: AbortSignal) => Promise<string>;

interface XaiSTTToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: XaiSttState): void;
}

/** The slice of the composer editor used by speech-to-text controllers. */
interface XaiSTTEditor {
	insertText(text: string): void;
	submit(): void;
}

interface CaptureHandle {
	stop(): void;
}

type CaptureFactory = (callback: (error: Error | null, samples: Float32Array) => void) => CaptureHandle;

export interface XaiSTTControllerDependencies {
	settings: Settings;
	transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
	createCapture?: CaptureFactory;
	/** Consulted once per recording after transcription; undefined inserts the raw transcript. */
	resolvePostProcessor?: () => TranscriptPostProcessor | undefined;
}

/**
 * Records one uninterrupted WAV and submits it to xAI only when the user
 * explicitly toggles recording off. Silence never segments or stops capture.
 */
export class XaiSTTController {
	#state: XaiSttState = "idle";
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;
	readonly #settings: Settings;
	readonly #transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
	readonly #createCapture: CaptureFactory;
	readonly #resolvePostProcessor: (() => TranscriptPostProcessor | undefined) | undefined;

	#recorder: CaptureHandle | null = null;
	#file: WavFileRecorder | null = null;
	#editor: XaiSTTEditor | null = null;
	#abort: AbortController | null = null;
	readonly #retainedFiles: WavFileRecorder[] = [];

	constructor({ settings, transcribe, createCapture, resolvePostProcessor }: XaiSTTControllerDependencies) {
		this.#settings = settings;
		this.#transcribe = transcribe;
		this.#createCapture = createCapture ?? (callback => new AudioCapture(16_000, callback));
		this.#resolvePostProcessor = resolvePostProcessor;
	}

	get state(): XaiSttState {
		return this.#state;
	}

	#setState(state: XaiSttState, options: XaiSTTToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: XaiSTTEditor, options: XaiSTTToggleOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}

		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(editor, options);
					break;
				case "recording":
					await this.#stop(options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
				case "postprocessing":
					options.showStatus("Voice filter in progress...");
					break;
			}

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

	async #start(editor: XaiSTTEditor, options: XaiSTTToggleOptions): Promise<void> {
		try {
			const file = new WavFileRecorder();
			this.#file = file;
			this.#editor = editor;
			this.#abort = new AbortController();
			this.#recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#file !== file || this.#state !== "recording") return;
				if (!error) {
					try {
						file.append(samples);
						return;
					} catch (cause) {
						error = cause instanceof Error ? cause : new Error(String(cause));
					}
				}
				this.#handleCaptureError(error, options);
			});
			this.#setState("recording", options);
			logger.debug("xAI STT batch recording started", { path: file.path });
		} catch (error) {
			this.#cleanup(true);
			const message = error instanceof Error ? error.message : "Failed to start microphone capture";
			options.showWarning(message);
			logger.error("xAI STT recording failed to start", { error: message });
		}
	}

	async #stop(options: XaiSTTToggleOptions): Promise<void> {
		const file = this.#file;
		const editor = this.#editor;
		const abort = this.#abort;
		if (!file || !editor || !abort) {
			this.#cleanup(false);
			this.#setState("idle", options);
			return;
		}

		this.#setState("transcribing", options);
		options.showStatus("Transcribing...");
		try {
			this.#recorder?.stop();
		} catch (error) {
			logger.debug("xAI STT recorder stop failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.#recorder = null;

		let recordingPath: string | undefined;
		try {
			recordingPath = file.finalize();
			this.#file = null;
			this.#retain(file);

			if (file.empty) {
				options.showStatus("No speech detected.");
			} else {
				const text = (await this.#transcribe(Bun.file(recordingPath, { type: "audio/wav" }), abort.signal)).trim();
				if (this.#disposed) return;
				const processed = text ? await this.#postProcess(text, abort.signal, options) : text;
				if (this.#disposed) return;
				this.#insertTranscript(editor, processed, options);
			}
		} catch (error) {
			if (!this.#disposed) {
				const message = error instanceof Error ? error.message : "xAI transcription failed";
				const retained = recordingPath ? ` Recording retained at ${recordingPath}` : "";
				options.showWarning(`${message}${retained}`);
				logger.error("xAI STT transcription failed", { error: message, path: recordingPath });
			}
		}

		this.#cleanup(false);
		if (!this.#disposed) this.#setState("idle", options);
	}

	/** Run the selected voice filter; on failure keep the raw transcript so dictation is never lost. */
	async #postProcess(text: string, signal: AbortSignal, options: XaiSTTToggleOptions): Promise<string> {
		const processor = this.#resolvePostProcessor?.();
		if (!processor) return text;
		this.#setState("postprocessing", options);
		options.showStatus("Applying voice filter...");
		try {
			const processed = (await processor(text, signal)).trim();
			return processed || text;
		} catch (error) {
			if (this.#disposed) return text;
			const message = error instanceof Error ? error.message : String(error);
			options.showWarning(`${message}. Inserted the raw transcript instead.`);
			logger.error("xAI STT voice filter failed", { error: message });
			return text;
		}
	}

	#insertTranscript(editor: XaiSTTEditor, text: string, options: XaiSTTToggleOptions): void {
		if (!text) {
			options.showStatus("No speech detected.");
			return;
		}

		const trigger = this.#settings.get("stt.submitTrigger");
		const { submit, trimTrailing } = evaluateSubmitTrigger(text, trigger);
		const textToInsert = trimTrailing > 0 ? text.slice(0, -trimTrailing) : text;
		if (textToInsert) editor.insertText(textToInsert);
		options.showStatus("");
		if (submit) editor.submit();
	}

	#handleCaptureError(error: Error, options: XaiSTTToggleOptions): void {
		try {
			this.#recorder?.stop();
		} catch {
			// Best-effort microphone cleanup.
		}
		this.#recorder = null;

		const file = this.#file;
		let retainedPath: string | undefined;
		if (file) {
			try {
				retainedPath = file.finalize();
				if (file.empty) {
					file.dispose();
					retainedPath = undefined;
				} else {
					this.#retain(file);
				}
			} catch (cause) {
				logger.debug("xAI STT recording finalization failed", {
					error: cause instanceof Error ? cause.message : String(cause),
				});
				file.dispose();
			}
		}
		this.#file = null;
		this.#cleanup(false);
		this.#setState("idle", options);

		const retained = retainedPath ? ` Recording retained at ${retainedPath}` : "";
		options.showWarning(`${error.message}${retained}`);
		logger.error("Native microphone capture failed", { error: error.message, path: retainedPath });
	}

	#retain(file: WavFileRecorder): void {
		this.#retainedFiles.push(file);
		while (this.#retainedFiles.length > 5) this.#retainedFiles.shift()?.dispose();
	}

	#cleanup(disposeCurrent: boolean): void {
		if (disposeCurrent) this.#file?.dispose();
		this.#recorder = null;
		this.#file = null;
		this.#editor = null;
		this.#abort = null;
	}

	dispose(): void {
		this.#disposed = true;
		this.#abort?.abort();
		try {
			this.#recorder?.stop();
		} catch {
			// Best-effort microphone cleanup.
		}
		this.#cleanup(true);
		for (const file of this.#retainedFiles.splice(0)) file.dispose();
		this.#state = "idle";
		this.#stopAfterStart = false;
	}
}
