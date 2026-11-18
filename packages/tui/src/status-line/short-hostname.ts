import * as os from "node:os";

let cached: string | undefined;

/** Short (first-label) machine hostname; resolved once, since `os.hostname()` is a syscall per call. */
export function shortHostname(): string {
	return (cached ??= os.hostname().split(".")[0]);
}
