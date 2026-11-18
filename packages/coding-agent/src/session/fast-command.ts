import { serviceTierFamily } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "./agent-session";
import type { AgentSessionHandle } from "./agent-session-handle";

export const FAST_USAGE = "Usage: /fast [on|ultra|off|status]";

export function formatFastModeStatus(
	session: Pick<AgentSessionHandle, "model" | "serviceTierByFamily" | "isFastModeEnabled">,
): string {
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
	const enabled = arg === "" || arg === "toggle" ? !session.isFastModeEnabled() : arg === "on";
	switch (arg) {
		case "":
		case "toggle":
		case "on":
		case "off": {
			const success = session.setFastMode(enabled);
			return {
				success,
				message: success
					? `Fast mode ${enabled ? "enabled" : "disabled"}.`
					: "Fast mode is unavailable for the current model.",
			};
		}
		case "ultra":
		case "ultrafast": {
			const success = session.setUltrafastMode(true);
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
