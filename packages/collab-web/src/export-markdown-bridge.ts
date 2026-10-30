/** The shared viewer resolves its canonical Marked import to the embedded library. */
import type { Marked as MarkedConstructor } from "@oh-my-pi/pi-utils/marked";

declare global {
	var ompMarkdown: { Marked: typeof MarkedConstructor };
}

export const Marked = globalThis.ompMarkdown.Marked;
