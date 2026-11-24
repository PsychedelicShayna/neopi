import { APP_NAME } from "@oh-my-pi/pi-utils";
import { type PauseWorkStatus, runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { LIVE_MODEL_OPTIONS } from "../live/protocol";
import { cfgLiveModel } from "../live/settings";
import { eventAudioCommand } from "../event-audio/observer";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { clearApprovalGrants } from "../tools/approval-cache";
import { argumentValues, completeArguments } from "./builtin-completions";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { configureAgentMonitor } from "../monitor/configure";
import { agentMonitorFor, startAgentMonitor, stopAgentMonitor } from "../monitor/controller";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { activeToolValues } from "./session-argument-values";
import type { SlashCommandSpec } from "./types";

const liveModelValues = argumentValues(...LIVE_MODEL_OPTIONS.map(option => option.value));

/** Advisors with review work they can still run (not parked, yielded, or quota-paused). */
function advisorUnsettledCount(session: AgentSessionHandle): number {
	return session
		.getAdvisorStatusOverview()
		.advisors.filter(advisor => advisor.backlog > 0 && !advisor.isPaused && !advisor.yielded).length;
}

/**
 * Outstanding work for the `/pause` screen. A subagent counts as a turn only
 * while its session streams and is not parked; its task job is deduplicated
 * against that same live set, so a pre-live or stale `running` ref still
 * counts through its job. Advisors of the root and every live subagent count.
 */
function pauseWorkStatus(root: AgentSession): PauseWorkStatus {
	const registry = AgentRegistry.global();
	const liveSubagents = registry.list().filter(ref => ref.kind === "sub" && registry.isRunning(ref));
	const liveSubagentIds = new Set(liveSubagents.map(ref => ref.id));
	let unsettledTurns = Number(root.isStreaming && !root.agent.isPaused) + advisorUnsettledCount(root);
	for (const ref of liveSubagents) {
		if (!ref.session) continue;
		if (!ref.session.agent.isPaused) unsettledTurns++;
		unsettledTurns += advisorUnsettledCount(ref.session);
	}
	const unfinishedJobs =
		root
			.getAsyncJobTree({ recentLimit: 0 })
			?.running.filter(job => job.type !== "task" || job.agentId === undefined || !liveSubagentIds.has(job.agentId))
			.length ?? 0;
	return { unsettledTurns, unfinishedJobs };
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "sounds",
		icon: "voice",
		get description() {
			return t("commands.control.chimeDescription");
		},
		allowArgs: true,
		inlineHint: "[on|off|reload|status]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.control.chimeOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.control.chimeOffDescription");
				},
			},
			{
				name: "reload",
				get description() {
					return t("commands.control.chimeReloadDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.control.chimeStatusDescription");
				},
			},
		],
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			try {
				runtime.ctx.showStatus(await eventAudioCommand(runtime.ctx.session, command.args));
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "force",
		icon: "hammer",
		get description() {
			return t("commands.control.forceDescription");
		},
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiArgumentCompletions: (prefix, runtime) => completeArguments(prefix, runtime, activeToolValues, null),
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? t("commands.control.noActiveTools") : t("commands.control.activeTools", { count });
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage(t("commands.control.forceUsage"), runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(t("commands.control.toolForced", { tool: toolName }));
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError(t("commands.control.forceUsage"));
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(t("commands.control.toolForced", { tool: toolName }));
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		get description() {
			return t("commands.control.liveDescription");
		},
		allowArgs: true,
		inlineHint: "[model [slug]]",
		subcommands: [
			{
				name: "model",
				get description() {
					return t("commands.control.liveModelDescription");
				},
				usage: "[slug]",
				arguments: [
					prefix => liveModelValues(prefix)?.map(item => ({ ...item, preserveInputOnSubmit: true })) ?? null,
				],
			},
		],
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "model") {
				try {
					if (rest) cfgLiveModel.set(runtime.ctx.settings, rest);
					runtime.ctx.showStatus(
						t("commands.control.liveModel", {
							model: cfgLiveModel.get(runtime.ctx.settings),
							detail: rest ? t("commands.control.liveModelNext") : t("commands.control.liveModelUnknown"),
						}),
					);
				} catch (error) {
					runtime.ctx.showError(errorMessage(error));
				}
				return;
			}
			if (verb) {
				runtime.ctx.showError(t("commands.control.liveUsage"));
				return;
			}
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "live-transcript",
		icon: "voice",
		get description() {
			return t("commands.control.voiceDescription");
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand("transcript");
		},
	},
	{
		name: "record",
		icon: "export",
		get description() {
			return t("commands.control.recordDescription", { app: APP_NAME });
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		get description() {
			return t("commands.control.freezeDescription");
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			const ctx = runtime.ctx;
			await runPauseScreen(ctx, { getWorkStatus: () => pauseWorkStatus(ctx.session) });
		},
	},
	{
		name: "forget-approvals",
		icon: "trash",
		get description() {
			return t("commands.control.forgetDescription");
		},
		handle: async (_command, runtime) => {
			clearApprovalGrants(runtime.settings.getAgentDir());
			await runtime.output(t("commands.control.approvalsForgotten"));
			return commandConsumed();
		},
	},
	{
		name: "monitor",
		icon: "eye",
		get description() {
			return t("commands.control.monitorDescription");
		},
		inlineHint: "[on|off|status|configure]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.control.monitorOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.control.monitorOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.control.monitorStatusDescription");
				},
			},
			{
				name: "configure",
				get description() {
					return t("commands.control.monitorConfigureDescription");
				},
			},
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			const action = command.args.trim() || "on";
			try {
				if (action === "configure") {
					await configureAgentMonitor(ctx);
					return;
				}
				if (action === "off") {
					const stopped = await stopAgentMonitor(ctx.session);
					ctx.showStatus(stopped ? t("commands.control.monitorClosed") : t("commands.control.monitorNotRunning"));
					return;
				}
				if (action === "status") {
					const manager = agentMonitorFor(ctx.session);
					if (!manager) {
						ctx.showStatus(t("commands.control.monitorStartHint"));
						return;
					}
					const status = manager.status();
					const panes =
						status.panes.map(pane => `${pane.agentId} (${pane.paneId})`).join(", ") ||
						t("commands.control.noPanes");
					ctx.showStatus(t("commands.control.monitorStatus", { session: status.sessionName, panes }));
					return;
				}
				if (action !== "on") {
					ctx.showError(t("commands.control.monitorUsage"));
					return;
				}
				const status = await startAgentMonitor(ctx.session, ctx.settings);
				ctx.showStatus(
					t("commands.control.monitorStarted", { session: status.sessionName, target: status.sessionName }),
				);
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		get description() {
			return t("commands.control.quitDescription");
		},
		handleTui: shutdownHandlerTui,
	},
];
