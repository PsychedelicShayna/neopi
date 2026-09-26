/** Escape presses inside one window: the 2nd is a skip, the 3rd an abort, then the window resets. */
export class EscapeGesture {
	static readonly WINDOW_MS = 3000;
	#first = 0;
	#count = 0;

	press(now = Date.now()): "none" | "skip" | "abort" {
		if (this.#count === 0 || now - this.#first > EscapeGesture.WINDOW_MS) {
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
