import { render as renderPrompt } from "@oh-my-pi/pi-utils/prompt";
import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { Settings } from "../../config/settings";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import { redactUrlForLog } from "../../mcp/json-rpc";
import relayGuidance from "../../prompts/system/browser-relay.md" with { type: "text" };
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };
import type { BrowserKind } from "./registry";
import { isLoopbackRelayUrl } from "./relay/daemon";
import { cfgBrowserCdpUrl, cfgBrowserEnabled, cfgBrowserRelayUrl } from "./settings";

/**
 * The browser eval documentation. Its Linux X11 notes follow the browser's host: they reach agents on Linux, and
 * elsewhere when a configured browser (`browser.cdpUrl`, `browser.relayUrl`) is on another machine, which may be Linux.
 */
export function browserDocumentation(
	settings: Settings,
	platform: NodeJS.Platform = process.platform,
	cwd?: string,
): string {
	const remoteBrowser = [cfgBrowserCdpUrl.get(settings), cfgBrowserRelayUrl.get(settings)].some(
		url => typeof url === "string" && url.trim() !== "" && !isLoopbackRelayUrl(url.trim()),
	);
	const { text } = resolvePromptAsset("tools/browser.md", browserDescription, { cwd });
	return renderPrompt(text, { linux: platform === "linux" || remoteBrowser });
}

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status"> & {
		/** Where an open with `app.relay: false` goes; set only while an open without `app` goes to the relay. */
		relayFallback?: BrowserKind;
	},
): EvalPreludeDefinition {
	const fallback = host.relayFallback;
	return {
		name: "browser",
		// Resolve per use: both workspace overrides and the browser host settings can change.
		get documentation(): string {
			return browserDocumentation(session.settings, undefined, session.cwd);
		},
		guidance: fallback
			? renderPrompt(relayGuidance, {
					cdpUrl: fallback.kind === "connected" ? redactUrlForLog(fallback.cdpUrl) : undefined,
					tern: fallback.kind === "tern",
					cmux: fallback.kind === "cmux",
				})
			: undefined,
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		approval: "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
