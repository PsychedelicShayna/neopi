/**
 * Synthesize text with the local TTS engine and play it (or save it with --out).
 *
 * Text comes from the argument or --file. Input is segmented into
 * sentence-sized chunks ({@link SpeakableStream}) and synthesized through the
 * streaming TTS worker, so arbitrarily long text starts playing after its first
 * sentence and plays gaplessly. --out concatenates the streamed segments into
 * one WAV. The first run downloads the configured local model into the cache.
 */

import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { sayHelp as commandHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { TTS_LOCAL_VOICE_VALUES } from "../tts/models";
import { createPacedSpeechStream, SpeechPacer, speechTimingEstimate } from "../tts/paced-stream";
import { SpeakableStream } from "../tts/speakable";
import { StreamingAudioPlayer } from "../tts/streaming-player";
import { shutdownTtsClient, ttsClient } from "../tts/tts-client";
import { resolveLocalSpeechModelId } from "../tts/vocalizer";
import { encodeWav } from "../tts/wav";

import {
	cfgTtsLocalSpeed,
	cfgTtsLocalVoice,
	cfgTtsPacing,
	speechPacingMargin,
	speechPacingThreads,
	speechSegmentOptions,
} from "../tts/settings";

export default class Say extends Command {
	static description = commandHelp.description;
	static args = {
		text: Args.string({ description: "Text to speak (or use --file)" }),
	};

	static flags = {
		voice: Flags.string({ description: "Voice id", options: TTS_LOCAL_VOICE_VALUES }),
		speed: Flags.string({ description: "Speaking rate, 0.8–1.3 (1 = normal; default: tts.localSpeed)" }),
		model: Flags.string({ description: "Local TTS model key" }),
		file: Flags.string({ char: "f", description: "Read the text to speak from this file" }),
		out: Flags.string({ char: "o", description: "Write WAV to this path instead of playing" }),
	};

	static examples = [
		`${APP_NAME} say "hello world"`,
		`${APP_NAME} say --file notes.md --voice bm_fable --speed 1.25`,
		`${APP_NAME} say "hello world" --out /tmp/hello.wav`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Say);
		if (args.text && flags.file) {
			process.stderr.write(chalk.red(t("cli.commands.say.text_or_file")));
			process.exit(1);
		}

		const settings = await Settings.init({ cwd: getProjectDir() });
		const model = flags.model ?? (await this.#resolveDefaultModel(settings));
		const voice = flags.voice ?? cfgTtsLocalVoice.get(settings);
		const speed = flags.speed === undefined ? cfgTtsLocalSpeed.get(settings) : Number(flags.speed);
		if (!Number.isFinite(speed) || speed <= 0) {
			process.stderr.write(chalk.red(t("cli.commands.say.invalid_speed", { speed: String(flags.speed) })));
			process.exit(1);
		}

		let exitCode = 0;
		const unsubscribe = ttsClient.onProgress(event => {
			if (event.status === "progress" && typeof event.progress === "number") {
				const status = t("cli.commands.say.downloading", {
					file: event.file ?? model,
					progress: Math.round(event.progress),
				});
				process.stderr.write(`\r${chalk.dim(status)}`);
			} else if (event.status === "done" || event.status === "ready") {
				// Clear the progress line once the download finishes.
				process.stderr.write("\r\x1b[K");
			}
		});

		try {
			const text = flags.file ? await Bun.file(flags.file).text() : (args.text ?? "");
			const splitter = new SpeakableStream(model === "kokoro-paced" ? speechSegmentOptions(settings) : undefined);
			const segments = [...splitter.push(text), ...splitter.flush()];
			if (segments.length === 0) {
				process.stderr.write(chalk.red(t("cli.commands.say.empty")));
				exitCode = 1;
				return;
			}

			const stream =
				model === "kokoro-paced"
					? createPacedSpeechStream({
							synthesize: text =>
								ttsClient.synthesize(model, text, { voice, speed, threads: speechPacingThreads(settings) }),
							pacer: new SpeechPacer(speechTimingEstimate, speechPacingMargin(settings)),
							enabled: !flags.out && cfgTtsPacing.get(settings),
						})
					: ttsClient.synthesizeStream(model, { voice, speed });
			for (const segment of segments) stream.push(segment);
			stream.end();

			if (flags.out) {
				const pcms: Float32Array[] = [];
				let total = 0;
				let sampleRate = 0;
				for await (const chunk of stream.chunks) {
					pcms.push(chunk.pcm);
					total += chunk.pcm.length;
					sampleRate = chunk.sampleRate;
				}
				if (total === 0) {
					this.#synthesisFailed(model);
					exitCode = 1;
					return;
				}
				const pcm = new Float32Array(total);
				let offset = 0;
				for (const part of pcms) {
					pcm.set(part, offset);
					offset += part.length;
				}
				const wav = encodeWav(pcm, sampleRate);
				await Bun.write(flags.out, wav);
				const details = t("cli.commands.say.saved_details", {
					voice,
					model,
					seconds: (total / sampleRate).toFixed(1),
					bytes: wav.byteLength,
				});
				process.stdout.write(`${chalk.green(t("cli.commands.say.saved"))} ${flags.out} ${chalk.dim(details)}\n`);
				return;
			}

			const player = new StreamingAudioPlayer();
			let spoken = 0;
			let seconds = 0;
			for await (const chunk of stream.chunks) {
				player.start(chunk.sampleRate);
				player.write(chunk.pcm);
				spoken++;
				seconds += chunk.pcm.length / chunk.sampleRate;
			}
			if (spoken === 0) {
				player.stop();
				this.#synthesisFailed(model);
				exitCode = 1;
				return;
			}
			await player.end();
			const details = t("cli.commands.say.spoke_details", {
				voice,
				model,
				seconds: seconds.toFixed(1),
				segments: spoken,
			});
			process.stdout.write(`${chalk.green(t("cli.commands.say.spoke"))} ${chalk.dim(details)}\n`);
		} catch (err) {
			process.stderr.write(
				chalk.red(t("cli.commands.say.error", { message: err instanceof Error ? err.message : String(err) })),
			);
			exitCode = 1;
		} finally {
			unsubscribe();
			await shutdownTtsClient();
		}

		if (exitCode !== 0) process.exit(exitCode);
	}

	async #resolveDefaultModel(settings: Settings): Promise<string> {
		const authStorage = await discoverAuthStorage(undefined, { settings });
		try {
			const registry = new ModelRegistry(authStorage, undefined, { settings });
			return resolveLocalSpeechModelId({ settings, registry });
		} finally {
			authStorage.close();
		}
	}

	#synthesisFailed(model: string): void {
		process.stderr.write(chalk.red(t("cli.commands.say.synthesis_failed", { model, app: APP_NAME })));
	}
}
