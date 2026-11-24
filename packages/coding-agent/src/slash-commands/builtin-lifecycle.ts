import { t } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText, refuseImages, restoreDetachedDraft, runWithDetachedDraft } from "./helpers/draft";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { APP_NAME, logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { rescopeSessionToCwd } from "../session/cwd-rescope";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import { getSessionLaunchProfile } from "../neopi/launch-profile";
import { continuesConversation } from "../modes/utils/conversation-position";
import type { FreshSessionResult } from "../session/agent-session";
import { COMPACT_MODES, findCompactMode, type ParsedCompactArgs, parseCompactArgs } from "../session/compact-modes";
import { runCompactionControl } from "../session/compaction-controls";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveResumableSession, resolveResumeTarget } from "../session/session-listing";
import { toggleSessionPin, unpinSession } from "../session/session-pins";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
} from "../session/session-worktree";
import type { SessionWorktree } from "../worktree/backend";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { resolveToCwd } from "../tools/path-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { completeSshAddArguments, completeSshRemoveArguments, handleSshAcp } from "./helpers/ssh";
import {
	completeAddDirectory,
	completeCleanseArguments,
	completeMentalModelId,
	completeOptionalMentalModelId,
	completeRemoveDirectory,
	sessionArgumentCompletions,
} from "./lifecycle-completions";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

function parseCompactionCommand(command: ParsedSlashCommand): ParsedCompactArgs | { error: string } {
	return command.name === "handoff"
		? { mode: "handoff", instructions: command.args || undefined }
		: parseCompactArgs(command.args);
}

async function handleCompact(command: ParsedSlashCommand, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (/^control(?:\s|$)/u.test(command.args.trim())) {
		try {
			const input = command.args.trim().slice("control".length).trim();
			await runtime.output(
				await runCompactionControl(runtime.settings, input ? JSON.parse(input) : {}, {
					model: runtime.session.model,
					tokens: runtime.session.getContextUsage()?.tokens,
				}),
			);
		} catch (error) {
			await runtime.output(errorMessage(error));
		}
		return commandConsumed();
	}
	const parsed = parseCompactionCommand(command);
	if ("error" in parsed) return usage(parsed.error, runtime);
	let failed = false;
	const run = async (): Promise<void> => {
		const before = runtime.session.getContextUsage?.()?.tokens;
		try {
			const { mode, instructions } = parsed;
			await runtime.session.compact(
				instructions,
				runtime.signal ? { mode, signal: runtime.signal } : mode ? { mode } : undefined,
			);
		} catch (err) {
			// Don't append an out-of-turn notice after the host already reported its interrupt.
			if (
				err instanceof CompactionCancelledError &&
				(err.cause === USER_INTERRUPT_LABEL || runtime.signal?.aborted)
			) {
				return;
			}
			const message = errorMessage(err);
			logger.error("Compaction failed", { error: message });
			failed = true;
			await runtime.output(t("commands.lifecycle.compactError", { error: message }));
			return;
		}
		const after = runtime.session.getContextUsage?.()?.tokens;
		await runtime.output(
			before == null || after == null
				? t("commands.lifecycle.compactComplete")
				: t("commands.lifecycle.compactSavings", { before, after, saved: before - after }),
		);
	};
	if (runtime.runCommandInBackground) {
		runtime.runCommandInBackground(run);
		return commandConsumed();
	}
	await run();
	return commandConsumed({ failed });
}

async function handleCompactTui(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<void> {
	if (/^control(?:\s|$)/u.test(command.args.trim())) {
		clearSubmittedText(runtime);
		try {
			const input = command.args.trim().slice("control".length).trim();
			runtime.ctx.showStatus(
				await runCompactionControl(runtime.ctx.session.settings, input ? JSON.parse(input) : {}, {
					model: runtime.ctx.session.model,
					tokens: runtime.ctx.session.getContextUsage()?.tokens,
				}),
			);
		} catch (error) {
			runtime.ctx.showWarning(errorMessage(error));
		}
		return;
	}
	const parsed = parseCompactionCommand(command);
	if (!("error" in parsed) && parsed.mode === "handoff" && refuseImages(command, runtime)) return;
	clearSubmittedText(runtime);
	if ("error" in parsed) {
		runtime.ctx.showWarning(parsed.error);
		return;
	}
	const { ctx } = runtime;
	const origin = runtime.followUp;
	// A switch still applying (or rolling back) decides which conversation is live.
	if (origin && ctx.session.isSessionTransitioning) await ctx.session.waitForSessionTransition();
	if (origin && !continuesConversation(ctx.sessionManager, origin)) {
		restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
		ctx.showWarning(t("commands.lifecycle.conversationChanged", { command: command.name }));
		return;
	}
	const background = parsed.mode && findCompactMode(parsed.mode)?.background;
	if (background) {
		// Background compaction doesn't hold the submission slot or its follow-ups.
		void ctx.handleCompactCommand(parsed.instructions, parsed.mode);
	} else if (origin && ctx.session.isStreaming) {
		ctx.yieldCompaction = { ...origin, text: command.text, instructions: parsed.instructions, mode: parsed.mode };
		ctx.updatePendingMessagesDisplay();
		ctx.showStatus(t("commands.lifecycle.compactQueued"));
		ctx.runYieldCompaction();
	} else {
		await ctx.handleCompactCommand(parsed.instructions, parsed.mode);
	}
}

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel =
		result.closedProviderSessions === 1
			? t("commands.lifecycle.providerState")
			: t("commands.lifecycle.providerStates");
	return t("commands.lifecycle.freshStarted", { count: result.closedProviderSessions, state: stateLabel });
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	clearSubmittedText(runtime);
	void runtime.ctx.shutdown();
	return commandConsumed();
};

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	if (verb === "thinking") return "thinking";
	return { error: t("commands.lifecycle.shakeUnknown", { mode: verb }) };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = [
		t("commands.lifecycle.workspaceDirectories"),
		t("commands.lifecycle.workingDirectory", { cwd }),
		...additional.map(d => `  ${d}`),
	];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}
async function fatalMoveFailure(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	await runtime.session.dispose();
	return commandConsumed();
}

/** A move rollback failed: re-align the workspace to wherever the session ended up and report it. */
async function reportFailedRollback(runtime: SlashCommandRuntime, rollbackError: unknown): Promise<SlashCommandResult> {
	const actual = runtime.sessionManager.getCwd();
	try {
		await rescopeHeadlessToCwd(runtime, actual);
	} catch {
		return fatalMoveFailure(
			t("commands.lifecycle.moveRollbackDiverged", {
				error: errorMessage(rollbackError),
				path: actual,
				sessionPath: actual,
			}),
			runtime,
		);
	}
	runtime.session.commitMixtureWorkspaceMove();
	return usage(
		t("commands.lifecycle.moveRollbackFailed", { error: errorMessage(rollbackError), path: actual }),
		runtime,
	);
}

/**
 * Relocate the headless session to `resolvedPath` (an existing directory):
 * flush settings, move the session file, re-scope the process, rolling back
 * on failure. Returns a result when the move did not complete; `undefined`
 * on success so the caller can report its own confirmation.
 */
async function relocateHeadlessSession(
	runtime: SlashCommandRuntime,
	resolvedPath: string,
): Promise<SlashCommandResult | undefined> {
	try {
		await runtime.settings.flush();
	} catch (err) {
		return usage(t("commands.lifecycle.settingsSaveFailed", { error: errorMessage(err) }), runtime);
	}
	const previousState = runtime.sessionManager.captureState();
	try {
		await runtime.session.moveSession(resolvedPath);
	} catch (err) {
		return usage(t("commands.lifecycle.moveFailed", { error: errorMessage(err) }), runtime);
	}
	try {
		setProjectDir(resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			return reportFailedRollback(runtime, rollbackError);
		}
		return usage(t("commands.lifecycle.moveFailed", { error: errorMessage(err) }), runtime);
	}
	try {
		await rescopeHeadlessToCwd(runtime, resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
			await rescopeHeadlessToCwd(runtime, previousState.cwd);
		} catch (rollbackError) {
			return reportFailedRollback(runtime, rollbackError);
		}
		return usage(t("commands.lifecycle.moveFailed", { error: errorMessage(err) }), runtime);
	}
	runtime.session.commitMixtureWorkspaceMove();
	await runtime.notifyConfigChanged?.();
	await runtime.notifyTitleChanged?.();
	return undefined;
}

/** Session id `/pin` and `/unpin` act on (the argument's match, else the active session), or the usage result. */
async function resolvePinTarget(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
	verb: "pin" | "unpin",
): Promise<string | SlashCommandResult> {
	const sessionArg = command.args.trim();
	if (sessionArg) {
		const match = await resolveResumableSession(sessionArg, runtime.cwd, runtime.sessionManager.getSessionDir(), {
			allowGlobalFallback: true,
		});
		return match ? match.session.id : usage(t("commands.lifecycle.sessionNotFound", { id: sessionArg }), runtime);
	}
	return (
		runtime.sessionManager.getSessionId() || usage(t("commands.lifecycle.noActiveSession", { action: verb }), runtime)
	);
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "launch-profile",
		get description() {
			return t("commands.lifecycle.profileDescription");
		},
		handle: async (_command, runtime) => {
			await runtime.output(getSessionLaunchProfile(runtime.session) ?? t("commands.lifecycle.noMemoryPreloaded"));
			return commandConsumed();
		},
	},
	{
		name: "ssh",
		icon: "host",
		get description() {
			return t("commands.lifecycle.sshDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.sshAcpDescription");
		},
		inlineHint: "<subcommand>",
		subcommandOptional: true,
		subcommands: [
			{
				name: "add",
				get description() {
					return t("commands.lifecycle.sshAddDescription");
				},
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
				getArgumentCompletions: completeSshAddArguments,
			},
			{
				name: "list",
				get description() {
					return t("commands.lifecycle.sshListDescription");
				},
			},
			{
				name: "remove",
				get description() {
					return t("commands.lifecycle.sshRemoveDescription");
				},
				usage: "<name> [--scope project|user]",
				getArgumentCompletions: completeSshRemoveArguments,
			},
			{
				name: "rm",
				get description() {
					return t("commands.lifecycle.sshAliasDescription");
				},
				usage: "<name> [--scope project|user]",
				getArgumentCompletions: completeSshRemoveArguments,
			},
			{
				name: "help",
				get description() {
					return t("commands.lifecycle.sshHelpDescription");
				},
			},
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		icon: "plus",
		get description() {
			return t("commands.lifecycle.newDescription");
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleNewCommand();
		},
	},
	{
		name: "fresh",
		icon: "restart",
		get description() {
			return t("commands.lifecycle.freshDescription");
		},
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? t("commands.lifecycle.freshStreaming") : t("commands.lifecycle.freshReady"),
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(t("commands.lifecycle.freshWait"));
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "clear",
		icon: "eraser",
		get description() {
			return t("commands.lifecycle.clearDescription");
		},
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming ? t("commands.lifecycle.clearStreaming") : t("commands.lifecycle.clearReady"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "delete",
		icon: "trash",
		get description() {
			return t("commands.lifecycle.resetDescription");
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleDeleteCommand();
		},
	},
	{
		name: "compact",
		icon: "compress",
		get description() {
			return t("commands.lifecycle.compactDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.compactAcpDescription");
		},
		subcommands: [
			{
				name: "control",
				get description() {
					return t("commands.lifecycle.compactPolicyDescription");
				},
				usage: "[JSON request]",
			},
			...COMPACT_MODES.map(mode => ({
				name: mode.name,
				description: mode.description,
				usage: mode.rejectsFocus ? undefined : "[focus]",
			})),
		],
		acpInputHint: `control [JSON request] | [${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage
				? t("commands.lifecycle.compactContext", { percent: Math.round(usage.percent) })
				: t("commands.lifecycle.compactUnavailable");
		},
		handle: handleCompact,
		handleTui: handleCompactTui,
	},
	{
		name: "shake",
		icon: "vibrate",
		get description() {
			return t("commands.lifecycle.shakeDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.shakeAcpDescription");
		},
		subcommands: [
			{
				name: "elide",
				get description() {
					return t("commands.lifecycle.shakeElideDescription");
				},
			},
			{
				name: "images",
				get description() {
					return t("commands.lifecycle.shakeImagesDescription");
				},
			},
			{
				name: "thinking",
				get description() {
					return t("commands.lifecycle.shakeThinkingDescription");
				},
			},
		],
		acpInputHint: "[elide|images|thinking]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		icon: "handoff",
		get description() {
			return t("commands.lifecycle.handoffDescription");
		},
		get inlineHint() {
			return t("commands.lifecycle.handoffHint");
		},
		allowArgs: true,
		handle: handleCompact,
		handleTui: handleCompactTui,
	},
	{
		name: "resume",
		icon: "history",
		get description() {
			return t("commands.lifecycle.resumeDescription");
		},
		inlineHint: "[session id|@claude|@codex]",
		allowArgs: true,
		getTuiArgumentCompletions: sessionArgumentCompletions("resume"),
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			clearSubmittedText(runtime);
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const target = await resolveResumeTarget(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!target) {
				runtime.ctx.showError(t("commands.lifecycle.resumeNotFound", { id: sessionArg }));
				return;
			}
			try {
				await runtime.ctx.handleResumeSession(target.session.path, { continuation: target.continuation });
			} catch (error) {
				// The picker reports a failed switch itself; `/resume <id>` has no picker.
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "pin",
		icon: "pin",
		get description() {
			return t("commands.lifecycle.pinDescription");
		},
		inlineHint: "[session id]",
		allowArgs: true,
		getTuiArgumentCompletions: sessionArgumentCompletions("pin"),
		handle: async (command, runtime) => {
			const sessionId = await resolvePinTarget(command, runtime, "pin");
			if (typeof sessionId !== "string") return sessionId;
			const pinned = await toggleSessionPin(sessionId);
			await runtime.notifySessionPinChanged?.(sessionId, pinned);
			await runtime.output(pinned ? t("commands.lifecycle.pinned") : t("commands.lifecycle.unpinned"));
			return commandConsumed();
		},
	},
	{
		name: "unpin",
		icon: "pin",
		get description() {
			return t("commands.lifecycle.unpinDescription");
		},
		inlineHint: "[session id]",
		allowArgs: true,
		getTuiArgumentCompletions: sessionArgumentCompletions("unpin"),
		handle: async (command, runtime) => {
			const sessionId = await resolvePinTarget(command, runtime, "unpin");
			if (typeof sessionId !== "string") return sessionId;
			const wasPinned = await unpinSession(sessionId);
			await runtime.notifySessionPinChanged?.(sessionId, false);
			await runtime.output(wasPinned ? t("commands.lifecycle.unpinned") : t("commands.lifecycle.notPinned"));
			return commandConsumed();
		},
	},
	{
		name: "btw",
		icon: "question",
		get description() {
			return t("commands.lifecycle.btwDescription");
		},
		inlineHint: "[question]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			await runWithDetachedDraft(
				command,
				runtime,
				() => runtime.ctx.handleBtwCommand(question, runtime.input?.images),
				{ restoreText: true },
			);
		},
	},
	{
		name: "tan",
		icon: "rocket",
		get description() {
			return t("commands.lifecycle.btwAgentDescription");
		},
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			await runWithDetachedDraft(command, runtime, () => runtime.ctx.handleTanCommand(work, runtime.input?.images), {
				restoreText: true,
			});
		},
	},
	{
		name: "issue",
		icon: "rule",
		get description() {
			return t("commands.lifecycle.issueDescription");
		},
		get inlineHint() {
			return t("commands.lifecycle.issueHint");
		},
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const prose = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleIssueCommand(prose);
		},
	},
	{
		name: "omfg",
		icon: "rule",
		get description() {
			return t("commands.lifecycle.ttsrDescription");
		},
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "cleanse",
		icon: "stethoscope",
		get description() {
			return t("commands.lifecycle.diagnosticsDescription");
		},
		inlineHint: "[request] [--all]",
		allowArgs: true,
		getTuiArgumentCompletions: completeCleanseArguments,
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const args = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleCleanseCommand(args);
		},
	},
	{
		name: "retry",
		icon: "redo",
		get description() {
			return t("commands.lifecycle.retryDescription");
		},
		handle: async (_command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage(t("commands.lifecycle.retryWait"), runtime);
			}
			const didRetry = await runtime.session.retry();
			if (!didRetry) {
				return usage(t("commands.lifecycle.nothingToRetry"), runtime);
			}
			await runtime.output(t("commands.lifecycle.retrying"));
			// `AgentSession.retry()` only schedules the continuation as a
			// post-prompt task; it returns before the retried turn streams. Hosts
			// whose prompt turn owns the event subscription (ACP) must stay open
			// across that turn — `AcpAgent.prompt` installs the subscription
			// before running the command and `#finishPrompt` unsubscribes, so
			// returning early would silently swallow the entire retried turn
			// (model output and tool calls). RPC and TUI omit this hook: they
			// stream the continuation through their own session subscription, and
			// blocking their command queue here would strand a follow-up `abort`.
			await runtime.keepTurnOpenUntilIdle?.();
			// `retry()` returned true, so a real agent turn is now scheduled — RPC
			// hosts must not be told this was local-only work.
			return commandConsumed({ agentInvoked: true });
		},
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus(t("commands.lifecycle.nothingToRetryShort"));
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "debug",
		icon: "bug",
		get description() {
			return t("commands.lifecycle.debugDescription");
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "memory",
		icon: "memory",
		get description() {
			return t("commands.lifecycle.memoryDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.memoryAcpDescription");
		},
		acpInputHint: "<subcommand>",
		subcommandOptional: true,
		subcommands: [
			{
				name: "view",
				get description() {
					return t("commands.lifecycle.memoryViewDescription");
				},
			},
			{
				name: "stats",
				get description() {
					return t("commands.lifecycle.memoryStatsDescription");
				},
			},
			{
				name: "diagnose",
				get description() {
					return t("commands.lifecycle.memoryDiagnoseDescription");
				},
			},
			{
				name: "queue",
				get description() {
					return t("commands.lifecycle.memoryQueueDescription");
				},
			},
			{
				name: "sync",
				get description() {
					return t("commands.lifecycle.memorySyncDescription");
				},
			},
			{
				name: "clear",
				get description() {
					return t("commands.lifecycle.memoryClearDescription");
				},
			},
			{
				name: "reset",
				get description() {
					return t("commands.lifecycle.memoryResetDescription");
				},
			},
			{
				name: "enqueue",
				get description() {
					return t("commands.lifecycle.memoryEnqueueDescription");
				},
			},
			{
				name: "rebuild",
				get description() {
					return t("commands.lifecycle.memoryRebuildDescription");
				},
			},
			{
				name: "mm list",
				get description() {
					return t("commands.lifecycle.memoryModelListDescription");
				},
			},
			{
				name: "mm show",
				get description() {
					return t("commands.lifecycle.memoryModelShowDescription");
				},
				usage: "<id>",
				arguments: [completeMentalModelId],
			},
			{
				name: "mm refresh",
				get description() {
					return t("commands.lifecycle.memoryModelRefreshDescription");
				},
				usage: "[id]",
				arguments: [completeOptionalMentalModelId],
			},
			{
				name: "mm history",
				get description() {
					return t("commands.lifecycle.memoryModelHistoryDescription");
				},
				usage: "<id>",
				arguments: [completeMentalModelId],
			},
			{
				name: "mm seed",
				get description() {
					return t("commands.lifecycle.memoryModelSeedDescription");
				},
			},
			{
				name: "mm delete",
				get description() {
					return t("commands.lifecycle.memoryModelDeleteDescription");
				},
				usage: "<id>",
				arguments: [completeMentalModelId],
			},
			{
				name: "mm remove",
				get description() {
					return t("commands.lifecycle.memoryModelRemoveDescription");
				},
				usage: "<id>",
				arguments: [completeMentalModelId],
			},
			{
				name: "mm reload",
				get description() {
					return t("commands.lifecycle.memoryModelReloadDescription");
				},
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.cwd,
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || t("commands.lifecycle.memoryEmpty"));
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output(t("commands.lifecycle.memoryCleared"));
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(t("commands.lifecycle.memoryEnqueued"));
					return commandConsumed();
				}
				case "queue": {
					const payload = await backend.queuePreview?.({
						agentDir: runtime.settings.getAgentDir(),
						cwd: runtime.cwd,
						session: runtime.session,
					});
					await runtime.output(payload ?? t("commands.lifecycle.memoryQueueUnavailable", { backend: backend.id }));
					return commandConsumed();
				}
				case "sync": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(t("commands.lifecycle.memoryConsolidated"));
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(t("commands.lifecycle.memoryModelAcpUnsupported"), runtime);
				default:
					return usage(t("commands.lifecycle.memoryUsage"), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		icon: "pencil",
		get description() {
			return t("commands.lifecycle.renameDescription");
		},
		inlineHint: "[title]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const session = runtime.session;
			const sessionManager = runtime.sessionManager;
			const runRename = async (): Promise<void> => {
				const sessionId = sessionManager.getSessionId();
				const titleSignal = session.titleGenerationSignal;
				let titleRevision = sessionManager.titleRevision;
				const isCurrent = () =>
					runtime.session === session &&
					runtime.sessionManager === sessionManager &&
					!runtime.signal?.aborted &&
					// An interrupt cancels a generated title; a typed one applies regardless.
					!(titleSignal.aborted && !command.args) &&
					sessionManager.getSessionId() === sessionId &&
					sessionManager.titleRevision === titleRevision;
				try {
					const generation = session.renameTitle(command.args, runtime.signal);
					titleRevision = sessionManager.titleRevision;
					const title = await generation;
					if (!isCurrent() || title === undefined) return;
					if (!title) {
						await runtime.output(t("commands.lifecycle.titleGenerationFailed"));
						return;
					}
					const persistence = sessionManager.setSessionName(title, "user");
					titleRevision = sessionManager.titleRevision;
					const ok = await persistence;
					if (!isCurrent()) return;
					if (!ok) {
						await runtime.output(t("commands.lifecycle.renameUnchanged"));
						return;
					}
					await runtime.notifyTitleChanged?.();
					if (!isCurrent()) return;
					await runtime.output(t("commands.lifecycle.renamed", { title }));
				} catch (err) {
					if (!isCurrent()) return;
					if (command.args || !runtime.runCommandInBackground) throw err;
					await runtime.output(t("commands.lifecycle.renameFailed", { error: errorMessage(err) }));
				}
			};
			if (!command.args && runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runRename);
				return commandConsumed();
			}
			await runRename();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const session = runtime.ctx.session;
			const sessionManager = runtime.ctx.sessionManager;
			const sessionId = sessionManager.getSessionId();
			// `renameTitle` resolves undefined for a generated title an interrupt cancelled.
			const generation = session.renameTitle(command.args.trim());
			const titleRevision = sessionManager.titleRevision;
			const title = await generation;
			if (
				runtime.ctx.session !== session ||
				runtime.ctx.sessionManager !== sessionManager ||
				sessionManager.getSessionId() !== sessionId ||
				sessionManager.titleRevision !== titleRevision ||
				title === undefined
			)
				return;
			if (!title) {
				runtime.ctx.showStatus(t("commands.lifecycle.titleGenerationFailed"));
				return;
			}
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		icon: "folderMove",
		get description() {
			return t("commands.lifecycle.moveDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.moveDescription");
		},
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("commands.lifecycle.moveStreaming"), runtime);
			if (!command.args) return usage(t("commands.lifecycle.moveUsage"), runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(t("commands.lifecycle.notDirectory", { path: resolvedPath }), runtime);
				}
			} catch {
				return usage(t("commands.lifecycle.missingDirectory", { path: resolvedPath }), runtime);
			}
			const failure = await relocateHeadlessSession(runtime, resolvedPath);
			if (failure) return failure;
			await runtime.output(t("commands.lifecycle.moved", { path: runtime.sessionManager.getCwd() }));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "wt",
		aliases: ["worktree"],
		icon: "folderMove",
		get description() {
			return t("commands.lifecycle.worktreeDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.worktreeDescription");
		},
		inlineHint: "[<branch>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("commands.lifecycle.worktreeStreaming"), runtime);
			const branch = command.args.trim() || defaultSessionWorktreeBranch();
			const sourceCwd = runtime.sessionManager.getCwd();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(sourceCwd, runtime.settings, branch);
			} catch (err) {
				return usage(t("commands.lifecycle.worktreeFailed", { error: errorMessage(err) }), runtime);
			}
			const failure = await relocateHeadlessSession(runtime, worktree.path);
			if (failure) return failure;
			const cleanup = await cleanSourceCheckoutIfConfigured(sourceCwd, runtime.settings);
			if (cleanup.errorMessage !== undefined) {
				await runtime.output(t("commands.lifecycle.worktreeCleanupFailed", { error: cleanup.errorMessage }));
			}
			await runtime.output(formatSessionWorktreeSummary(worktree, cleanup.cleaned));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleWorktreeCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		icon: "folderPlus",
		get description() {
			return t("commands.lifecycle.addDirectoryDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.addDirectoryAcpDescription");
		},
		inlineHint: "<path>",
		allowArgs: true,
		getTuiArgumentCompletions: completeAddDirectory,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("commands.lifecycle.addDirectoryStreaming"), runtime);
			if (!command.args)
				return usage(formatWorkspaceDirectories(runtime, t("commands.lifecycle.addDirectoryUsage")), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(t("commands.lifecycle.notDirectory", { path: resolved }), runtime);
			} catch {
				return usage(t("commands.lifecycle.missingDirectory", { path: resolved }), runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(t("commands.lifecycle.alreadyInWorkspace", { path: resolved }));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(
				formatWorkspaceDirectories(runtime, t("commands.lifecycle.directoryAdded", { path: added })),
			);
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		icon: "folderMinus",
		get description() {
			return t("commands.lifecycle.removeDirectoryDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.removeDirectoryDescription");
		},
		inlineHint: "<path>",
		allowArgs: true,
		getTuiArgumentCompletions: completeRemoveDirectory,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(t("commands.lifecycle.removeDirectoryStreaming"), runtime);
			if (!command.args) return usage(t("commands.lifecycle.removeDirectoryUsage"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage(t("commands.lifecycle.cannotRemoveCwd"), runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(t("commands.lifecycle.notWorkspaceDirectory", { path: resolved }));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(
				formatWorkspaceDirectories(runtime, t("commands.lifecycle.directoryRemoved", { path: removed })),
			);
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		get description() {
			return t("commands.lifecycle.listDirectoriesDescription");
		},
		get acpDescription() {
			return t("commands.lifecycle.listDirectoriesDescription");
		},
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		get description() {
			return t("commands.lifecycle.exitDescription");
		},
		handleTui: shutdownHandlerTui,
	},
	{
		name: "restart",
		icon: "restart",
		get description() {
			return t("commands.lifecycle.restartDescription", { app: APP_NAME });
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.restart();
		},
	},
];
async function rescopeHeadlessToCwd(runtime: SlashCommandRuntime, cwd: string): Promise<void> {
	setProjectDir(cwd);
	await rescopeSessionToCwd(runtime.session, runtime.settings, cwd);
	await runtime.session.rebindMixturesForCwd(cwd, true);
	await runtime.refreshCommands?.();
	await runtime.reloadPlugins();
}
