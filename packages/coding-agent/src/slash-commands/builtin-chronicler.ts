import { t } from "@oh-my-pi/pi-utils/i18n";
import { dispatchSessionChronicleIndex } from "../chronicler/session-index";
import type { AgentSession } from "../session/agent-session";
import { ChronicleRecallTool } from "../tools/chronicle-recall";
import { argumentValues } from "./builtin-completions";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef } from "./types";

function chronUsage() {
	return t("commands.chron.usage");
}
const chronConfirmValues = argumentValues("--confirm");
const CHRON_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "status",
		get description() {
			return t("commands.chron.statusDescription");
		},
	},
	{
		name: "pause",
		get description() {
			return t("commands.chron.pauseDescription");
		},
	},
	{
		name: "resume",
		get description() {
			return t("commands.chron.resumeDescription");
		},
	},
	{
		name: "blind",
		get description() {
			return t("commands.chron.blindDescription");
		},
	},
	{
		name: "unblind",
		get description() {
			return t("commands.chron.unblindDescription");
		},
	},
	{
		name: "off",
		get description() {
			return t("commands.chron.offDescription");
		},
		usage: "[--confirm]",
		// A bare `off` must still pass through the normal confirmation prompt.
		arguments: [
			prefix => chronConfirmValues(prefix)?.map(item => ({ ...item, preserveInputOnSubmit: true })) ?? null,
		],
	},
	{
		name: "on",
		get description() {
			return t("commands.chron.onDescription");
		},
	},
	{
		name: "index",
		get description() {
			return t("commands.chron.indexDescription");
		},
	},
	{
		name: "recall",
		get description() {
			return t("commands.chron.recallDescription");
		},
		usage: '"question"',
	},
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
	return t("commands.chron.status", {
		enabled: session.chroniclerEnabled ? t("commands.chron.enabled") : t("commands.chron.disabled"),
		capture: t(`commands.chron.capture.${captureMode}`),
		health: t(`commands.chron.health.${health.status}`),
	});
}

async function runChronCommand(
	args: string,
	session: AgentSession,
	confirmOff?: () => Promise<boolean>,
): Promise<{ text: string; failed?: boolean }> {
	const { verb, rest } = parseSubcommand(args);
	if ((!verb || verb === "status") && !rest) return { text: chroniclerStatus(session) };
	if (verb === "index") {
		if (rest) return { text: chronUsage(), failed: true };
		return { text: dispatchSessionChronicleIndex(session) };
	}
	if (verb === "recall") {
		let question = rest;
		const quote = question[0];
		if (quote === '"' || quote === "'") {
			if (question.length < 2 || !question.endsWith(quote)) return { text: chronUsage(), failed: true };
			question = question.slice(1, -1);
		}
		if (!question.trim()) return { text: chronUsage(), failed: true };
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
		return { text: chronUsage(), failed: true };
	}
	if (verb === "off" && rest !== "--confirm") {
		if (!confirmOff) {
			return {
				text: t("commands.chron.confirmUsage", { warning: t("commands.chron.disableWarning") }),
				failed: true,
			};
		}
		if (!(await confirmOff())) return { text: t("commands.chron.disableCancelled") };
	}
	const changed = await session.chroniclerControl(verb);
	return {
		text: `${changed ? t("commands.chron.updated") : t("commands.chron.unchanged")} ${chroniclerStatus(session)}`,
	};
}

export const CHRONICLER_SLASH_COMMAND: SlashCommandSpec = {
	name: "chron",
	icon: "action",
	get description() {
		return t("commands.chron.description");
	},
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
			await runtime.output(t("commands.chron.failed", { error: errorMessage(error) }));
			return commandConsumed({ failed: true });
		}
	},
	handleTui: async (command, runtime) => {
		const ctx = runtime.ctx;
		clearSubmittedText(runtime);
		try {
			const result = await runChronCommand(command.args, ctx.session, () =>
				ctx.showHookConfirm(t("commands.chron.confirmDisable"), t("commands.chron.disableWarning")),
			);
			if (result.failed) ctx.showError(result.text);
			else ctx.showStatus(result.text);
		} catch (error) {
			ctx.showError(t("commands.chron.failed", { error: errorMessage(error) }));
		}
	},
};
