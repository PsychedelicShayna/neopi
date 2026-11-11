import type { AgentSession } from "../session/agent-session";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef } from "./types";

const CHRON_USAGE = "Usage: /chron [status|pause|resume|blind|unblind|off [--confirm]|on]";
const CHRON_OFF_WARNING = "Turning off the Chronicler will wipe Luna's context window.";
const CHRON_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "status", description: "Show enabled state, capture mode, and health" },
	{ name: "pause", description: "Pause ingest, retaining Luna's context; resume catches up" },
	{ name: "resume", description: "Resume ingest and catch up on the paused window" },
	{ name: "blind", description: "Stop ingest and permanently exclude this window from automatic capture" },
	{ name: "unblind", description: "Resume ingest without recording the blinded window" },
	{
		name: "off",
		description: "Disable the Chronicler and wipe Luna's context (confirmation required)",
		usage: "[--confirm]",
	},
	{ name: "on", description: "Enable the Chronicler for this session" },
];

type ChroniclerAction = "on" | "off" | "pause" | "resume" | "blind" | "unblind";

function isChroniclerAction(verb: string): verb is ChroniclerAction {
	return (
		verb === "on" || verb === "off" || verb === "pause" || verb === "resume" || verb === "blind" || verb === "unblind"
	);
}

function chroniclerStatus(session: AgentSession): string {
	const health = session.chroniclerHealth;
	const captureMode = session.chroniclerEnabled ? (health.captureMode ?? "running") : "inactive";
	return `Chronicler: ${session.chroniclerEnabled ? "enabled" : "disabled"}; capture: ${captureMode}; health: ${health.status}.`;
}

async function runChronCommand(
	args: string,
	session: AgentSession,
	confirmOff?: () => Promise<boolean>,
): Promise<{ text: string; failed?: boolean }> {
	const { verb, rest } = parseSubcommand(args);
	if ((!verb || verb === "status") && !rest) return { text: chroniclerStatus(session) };
	if (!isChroniclerAction(verb) || (rest && !(verb === "off" && rest === "--confirm"))) {
		return { text: CHRON_USAGE, failed: true };
	}
	if (verb === "off" && rest !== "--confirm") {
		if (!confirmOff) {
			return {
				text: `${CHRON_OFF_WARNING}\nTo confirm, run /chron off --confirm. No state was changed.`,
				failed: true,
			};
		}
		if (!(await confirmOff())) return { text: "Chronicler off cancelled. No state was changed." };
	}
	const changed = await session.chroniclerControl(verb);
	return { text: `${changed ? "Chronicler state updated." : "No state change."} ${chroniclerStatus(session)}` };
}

export const CHRONICLER_SLASH_COMMAND: SlashCommandSpec = {
	name: "chron",
	icon: "action",
	description: "Control Luna, the session Chronicler (status, pause, blind, on, off)",
	acpInputHint: "[status|pause|resume|blind|unblind|off [--confirm]|on]",
	allowArgs: true,
	subcommandOptional: true,
	subcommands: CHRON_SUBCOMMANDS,
	handle: async (command, runtime) => {
		try {
			const result = await runChronCommand(command.args, runtime.session);
			await runtime.output(result.text);
			return commandConsumed({ failed: result.failed });
		} catch (error) {
			await runtime.output(`Chronicler command failed: ${errorMessage(error)}`);
			return commandConsumed({ failed: true });
		}
	},
	handleTui: async (command, runtime) => {
		const ctx = runtime.ctx;
		clearSubmittedText(runtime);
		try {
			const result = await runChronCommand(command.args, ctx.session, () =>
				ctx.showHookConfirm("Turn off the Chronicler?", CHRON_OFF_WARNING),
			);
			if (result.failed) ctx.showError(result.text);
			else ctx.showStatus(result.text);
		} catch (error) {
			ctx.showError(`Chronicler command failed: ${errorMessage(error)}`);
		}
	},
};
