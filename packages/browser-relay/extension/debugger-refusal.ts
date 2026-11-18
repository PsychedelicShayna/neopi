import { DEBUGGER_ACCESS_REFUSAL } from "../../coding-agent/src/tools/browser/relay/protocol";

const UNIDENTIFIED_REFUSAL =
	/^(?:Cannot access a chrome-extension:\/\/ URL of different extension|Another debugger is already attached(?: to the tab with id: \d+)?)\.?$/i;

/** Explain Chrome's refusal without changing another extension or guessing its identity. */
export function debuggerRefusalMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	if (!DEBUGGER_ACCESS_REFUSAL.test(raw)) return raw;
	const identityNotice = UNIDENTIFIED_REFUSAL.test(raw.trim())
		? "Chrome did not identify the conflicting extension or debugger. "
		: "The blocker is unidentified unless Chrome names an extension or debugger in the raw refusal below. ";
	return (
		"Chrome refused CDP access because of an extension or debugger conflict. " +
		identityNotice +
		"Close extension menus and DevTools, or detach the other debugger, then retry. NeoPi will not alter other extensions' frames.\n\n" +
		`Chrome refusal: ${raw}`
	);
}
