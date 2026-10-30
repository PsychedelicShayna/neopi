import { APP_NAME } from "@oh-my-pi/pi-utils";
import { type PauseWorkStatus, runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { cfgLiveModel } from "../live/settings";
import { eventAudioCommand } from "../event-audio/observer";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { clearApprovalGrants } from "../tools/approval-cache";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { configureAgentMonitor } from "../monitor/configure";
import { agentMonitorFor, startAgentMonitor, stopAgentMonitor } from "../monitor/controller";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/** Advisors with review work they can still run (not parked, yielded, or quota-paused). */
function advisorUnsettledCount(session: AgentSession): number {
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
		description: "Enable, silence or reload owner-assigned event sounds for this session",
		allowArgs: true,
		inlineHint: "[on|off|reload|status]",
		subcommands: [
			{ name: "on", description: "Enable assigned event sounds for this session" },
			{ name: "off", description: "Stop event sounds immediately" },
			{ name: "reload", description: "Reread curated assignments and changed audio" },
			{ name: "status", description: "Show mappings, playback and dropped events" },
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
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
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
		description: "Start Codex-backed realtime voice mode or choose its model",
		allowArgs: true,
		inlineHint: "[model [slug]]",
		subcommands: [{ name: "model", description: "Show or set the model for the next live call", usage: "[slug]" }],
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "model") {
				try {
					if (rest) cfgLiveModel.set(runtime.ctx.settings, rest);
					runtime.ctx.showStatus(
						`Live model: ${cfgLiveModel.get(runtime.ctx.settings)}${rest ? " (applies to the next live call)" : ""}`,
					);
				} catch (error) {
					runtime.ctx.showError(errorMessage(error));
				}
				return;
			}
			if (verb) {
				runtime.ctx.showError("Usage: /live [model [slug]]");
				return;
			}
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: `Start or stop recording this screen to a replayable file (${APP_NAME} play)`,
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			const ctx = runtime.ctx;
			await runPauseScreen(ctx, { getWorkStatus: () => pauseWorkStatus(ctx.session) });
		},
	},
	{
		name: "forget-approvals",
		icon: "trash",
		description: "Forget every file and folder approval Ask and remember has recorded",
		handle: async (_command, runtime) => {
			clearApprovalGrants(runtime.settings.getAgentDir());
			await runtime.output("Remembered approvals forgotten; the next read or write asks again.");
			return commandConsumed();
		},
	},
	{
		name: "monitor",
		icon: "eye",
		description: "Open a tmux session with one live pane per subagent and advisor",
		inlineHint: "[on|off|status|configure]",
		subcommands: [
			{ name: "on", description: "Start the monitor session (default)" },
			{ name: "off", description: "Close the monitor session and its panes" },
			{ name: "status", description: "Show the monitor session and its panes" },
			{ name: "configure", description: "Configure monitor layout, counts, and pane sizes" },
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
					ctx.showStatus(stopped ? "Agent monitor closed." : "The agent monitor is not running.");
					return;
				}
				if (action === "status") {
					const manager = agentMonitorFor(ctx.session);
					if (!manager) {
						ctx.showStatus("The agent monitor is not running. /monitor on starts it.");
						return;
					}
					const status = manager.status();
					const panes =
						status.panes.map(pane => `${pane.agentId} (${pane.paneId})`).join(", ") || "no agent panes";
					ctx.showStatus(`Agent monitor: tmux session ${status.sessionName} · ${panes}`);
					return;
				}
				if (action !== "on") {
					ctx.showError("Usage: /monitor [on|off|status|configure]");
					return;
				}
				const status = await startAgentMonitor(ctx.session, ctx.settings);
				ctx.showStatus(
					`Agent monitor running in tmux session ${status.sessionName}. View it from another terminal: tmux attach -t ${status.sessionName}`,
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
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
