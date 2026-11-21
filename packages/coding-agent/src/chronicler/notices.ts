import { isRecord } from "@oh-my-pi/pi-utils";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import type { Settings } from "../config/settings";
import statusNoticeTemplate from "../prompts/chronicler/status-notice.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { cfgChroniclerNotices } from "./settings";

const CHRONICLER_STATUS_TYPE = "chronicler-status";

export type ChroniclerTransition = "enabled" | "disabled" | "paused" | "resumed" | "blinded" | "unblinded";
export type ChroniclerControl = "on" | "off" | "pause" | "resume" | "blind" | "unblind";

/** Startup and explicit enable notices contain the same consent explanation. */
export function isChroniclerEnabledNotice(message: { customType: string; details?: unknown }): boolean {
	return (
		message.customType === CHRONICLER_STATUS_TYPE &&
		isRecord(message.details) &&
		message.details.transition === "enabled"
	);
}

export interface ChroniclerNoticeOptions {
	/** Additional enabled explanation supplied only by builds that implement it. */
	enabledExtra?: string;
}

/** Shared by explicit controls and the canary's separately gated startup consent. */
export function formatChroniclerNotice(
	transition: ChroniclerTransition,
	options: ChroniclerNoticeOptions = {},
): string {
	return renderPromptAsset(
		"chronicler/status-notice.md",
		statusNoticeTemplate,
		{ [transition]: true, enabledExtra: options.enabledExtra },
		{ kind: "notice" },
	).trim();
}

export interface ChroniclerNoticeHost extends Pick<AgentSession, "sendCustomMessage"> {
	settings: Settings;
}

/** A system notice on the next model turn; never starts or interrupts a turn. */
export async function injectChroniclerNotice(
	host: ChroniclerNoticeHost,
	transition: ChroniclerTransition,
	options?: ChroniclerNoticeOptions,
): Promise<void> {
	if (!cfgChroniclerNotices.get(host.settings)) return;
	await host.sendCustomMessage(
		{
			customType: CHRONICLER_STATUS_TYPE,
			content: formatChroniclerNotice(transition, options),
			display: true,
			attribution: "agent",
			details: { transition },
		},
		{ deliverAs: "nextTurn" },
	);
}
