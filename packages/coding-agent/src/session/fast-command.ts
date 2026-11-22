import { serviceTierFamily } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "./agent-session";
import type { AgentSessionHandle } from "./agent-session-handle";

export const FAST_USAGE = "Usage: /fast [on|ultra|off|status|force fast|force ultra]";

export function formatFastModeStatus(
	session: Pick<AgentSessionHandle, "model" | "serviceTierByFamily" | "isFastModeEnabled"> &
		Partial<Pick<AgentSession, "forcedOpenAITier">>,
): string {
	const forced = session.forcedOpenAITier?.();
	if (forced) return forced === "ultrafast" ? "forced ultra" : "forced fast";
	const model = session.model;
	if (model && serviceTierFamily(model) === "openai" && session.serviceTierByFamily.openai === "ultrafast") {
		return "ultra";
	}
	return session.isFastModeEnabled() ? "on" : "off";
}

export interface FastCommandResult {
	message: string;
	success: boolean;
}

/** Session-only /fast behavior shared by main and focused-agent commands. */
export function runFastCommand(arg: string, session: AgentSession): FastCommandResult | undefined {
	const enabled =
		arg === "" || arg === "toggle" ? !session.forcedOpenAITier() && !session.isFastModeEnabled() : arg === "on";
	switch (arg) {
		case "force fast":
		case "force ultra": {
			const tier = arg === "force ultra" ? "ultrafast" : "priority";
			const success = session.setForcedOpenAITier(tier);
			return {
				success,
				message: success
					? `Forcing service_tier=${tier} for the current model this session.`
					: "Forced service tiers require an OpenAI-compatible model.",
			};
		}
		case "":
		case "toggle":
		case "on":
		case "off": {
			const success = session.setFastMode(enabled);
			const cleared = (!enabled || success) && session.setForcedOpenAITier(undefined);
			return {
				success: success || cleared,
				message:
					success || cleared
						? `Fast mode ${enabled ? "enabled" : "disabled"}.`
						: "Fast mode is unavailable for the current model.",
			};
		}
		case "ultra":
		case "ultrafast": {
			const success = session.setUltrafastMode(true);
			if (success) session.setForcedOpenAITier(undefined);
			return {
				success,
				message: success ? "Ultrafast mode enabled." : "Ultrafast is unavailable for the current model.",
			};
		}
		case "status":
			return { success: true, message: `Fast mode is ${formatFastModeStatus(session)}.` };
		default:
			return undefined;
	}
}
