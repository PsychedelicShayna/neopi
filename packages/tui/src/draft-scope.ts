/**
 * Detached draft scope for control-socket submissions (#171).
 *
 * A control submission runs inside {@link runWithDetachedDraft}. Editor writes
 * (`setText`, `clearDraft`, image arrays) land on the detached surface instead
 * of the human's composer, including writes that happen after an await, because
 * the scope follows the async call chain. Keyboard handlers are not inside the
 * scope, so the human's draft is never overwritten.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface DetachedDraft {
	text: string;
	images: ImageContent[];
	imageLinks: (string | undefined)[];
}

const draftScope = new AsyncLocalStorage<DetachedDraft>();

/** The detached draft of the current control submission, if any. */
export function currentDetachedDraft(): DetachedDraft | undefined {
	return draftScope.getStore();
}

/** Run `fn` so editor writes land on a fresh detached draft. */
export function runWithDetachedDraft<T>(fn: () => T): T {
	return draftScope.run({ text: "", images: [], imageLinks: [] }, fn);
}
