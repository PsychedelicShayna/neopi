/** Preprocessing control taps in one window: the 2nd skips, the 3rd cancels. */
export class ChainStepGesture {
	static readonly WINDOW_MS = 3000;
	#first = 0;
	#count = 0;

	press(now = Date.now()): "none" | "skip" | "abort" {
		if (this.#count === 0 || now - this.#first > ChainStepGesture.WINDOW_MS) {
			this.#first = now;
			this.#count = 0;
		}
		this.#count++;
		if (this.#count === 2) return "skip";
		if (this.#count >= 3) {
			this.#count = 0;
			return "abort";
		}
		return "none";
	}
}
