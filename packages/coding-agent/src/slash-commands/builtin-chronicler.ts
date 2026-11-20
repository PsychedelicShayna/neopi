import { dispatchSessionChronicleIndex } from "../chronicler/session-index";
import type { AgentSession } from "../session/agent-session";
import { ChronicleRecallTool } from "../tools/chronicle-recall";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef } from "./types";

const CHRON_USAGE = 'Usage: /chron [status|pause|resume|blind|unblind|off [--confirm]|on|index|recall "question"]';
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
	{ name: "index", description: "Index captured atoms from the current session" },
	{ name: "recall", description: "Recall captured atoms across sessions", usage: '"question"' },
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
	if (verb === "index") {
		if (rest) return { text: CHRON_USAGE, failed: true };
		return { text: dispatchSessionChronicleIndex(session) };
	}
	if (verb === "recall") {
		let question = rest;
		const quote = question[0];
		if (quote === '"' || quote === "'") {
			if (question.length < 2 || !question.endsWith(quote)) return { text: CHRON_USAGE, failed: true };
			question = question.slice(1, -1);
		}
		if (!question.trim()) return { text: CHRON_USAGE, failed: true };
		// The recall setting gates the agent's tool grant, not explicit operator commands.
		const tool = new ChronicleRecallTool(session.getAgentLauncherSession());
		const result = await tool.execute("chron-recall", { query: question, scope: "all" });
		return {
			text: result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n"),
		};
	}
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
	description: "Control Luna, index this session, or recall captured atoms",
	acpInputHint: '[status|pause|resume|blind|unblind|off [--confirm]|on|index|recall "question"]',
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
