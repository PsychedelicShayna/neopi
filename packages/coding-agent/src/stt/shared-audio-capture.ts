import { AudioCapture } from "@oh-my-pi/pi-natives";

export type AudioSink = (error: Error | null, samples: Float32Array) => void;
type CaptureHandle = { stop(): void };
type CaptureFactory = (sampleRate: number, callback: AudioSink) => CaptureHandle;

/** One 16 kHz microphone stream for live voice and both composer dictation paths.
 * Subscribers receive the same frames; stopping one never closes another's mic.
 */
export function createSharedAudioCapture(
	open: CaptureFactory = (sampleRate, callback) => new AudioCapture(sampleRate, callback),
): CaptureFactory {
	const subscribers = new Set<AudioSink>();
	let capture: CaptureHandle | undefined;
	let rate: number | undefined;
	return (sampleRate, callback) => {
		if (capture && rate !== sampleRate) throw new Error("Shared microphone sample rate differs from active capture");
		subscribers.add(callback);
		if (!capture) {
			try {
				capture = open(sampleRate, (error, samples) => {
					for (const subscriber of subscribers) subscriber(error, samples);
				});
				rate = sampleRate;
			} catch (error) {
				subscribers.delete(callback);
				throw error;
			}
		}
		let stopped = false;
		return {
			stop() {
				if (stopped) return;
				stopped = true;
				subscribers.delete(callback);
				if (subscribers.size === 0) {
					const previous = capture;
					capture = undefined;
					rate = undefined;
					previous?.stop();
				}
			},
		};
	};
}

export const sharedAudioCapture = createSharedAudioCapture();
