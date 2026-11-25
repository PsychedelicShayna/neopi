import { t } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText } from "./helpers/draft";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import { withNeoProxyLoginUrl } from "../neopi/neoproxy-connect";
import type { AgentSession } from "../session/agent-session";
import type { AgentViewSession } from "../session/agent-session-handle";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount, refreshStatusLine } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import { shortenEmbeddedPaths, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { buildJobTree, jobTreeGuide, jobTreeIndent } from "@oh-my-pi/pi-tui/overlays/job-tree";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { handleMcpAcp } from "./helpers/mcp";
import { markdownFenceFor } from "../utils/markdown-fence";
import { openLocalFileInEditor } from "../modes/local-file-editor";
import { handleIrcCommand } from "./helpers/irc";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import {
	describeRedeemOutcome,
	formatResetUsageAccountLine,
	oneLine,
	resolveResetUsageTarget,
	toResetUsageAccounts,
} from "./helpers/reset-usage";
import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import {
	launchStatsDashboard,
	parseStatsDashboardArgs,
	type StatsDashboardArgs,
	type StatsDashboardLaunchResult,
} from "./helpers/stats-dashboard";
import { StatsNotice } from "@oh-my-pi/pi-tui/overlays/stats-notice";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";
import { mcpServerArgumentValues } from "./builtin-completions";
import {
	completeGitRevision,
	completeHubArguments,
	completeIrcArguments,
	completeLoginArguments,
	completeLogoutArguments,
	completeMcpAddArguments,
	completeMcpRemoveArguments,
	completeSessionPinArguments,
	completeStatsArguments,
	completeTodoPath,
	completeToolArguments,
	resetUsageValues,
	runningJobValues,
	todoPhaseValues,
	todoTargetCompletions,
} from "./session-argument-values";
import { parseHumanToolArguments, parseHumanToolCommand } from "./tool-arguments";

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(t("commands.session.resetsFailed", { error: oneLine(errorMessage(error)) }));
		return;
	}
	if (accounts.length === 0) {
		await output(t("commands.session.noAccounts"));
		return;
	}
	if (!arg.trim()) {
		const lines = [t("commands.session.savedResets"), ...accounts.map(formatResetUsageAccountLine)];
		lines.push("", t("commands.session.spendReset"));
		await output(lines.join("\n"));
		return;
	}
	const resolved = resolveResetUsageTarget(accounts, arg, "/usage reset");
	if ("error" in resolved) {
		await output(resolved.error);
		return;
	}
	const outcome = await session.redeemResetCredit(resolved.account.target);
	await output(oneLine(describeRedeemOutcome(outcome, resolved.account.label)));
}

/**
 * `/jobs kill <id>|all`: cancel one running background job this session owns,
 * or every running one. Routes through the same owner-scoped
 * `AgentSession.cancelAsyncJob` the jobs sheet's `x`-to-cancel and
 * `proc://<id>/kill` use, so it can only touch jobs `/jobs` lists.
 */
async function handleJobsKillCommand(
	arg: string,
	session: Pick<AgentViewSession, "getAsyncJobSnapshot" | "cancelAsyncJob">,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	const target = arg.trim();
	if (!target) {
		await output(t("commands.session.killUsage"));
		return;
	}
	const snapshot = session.getAsyncJobSnapshot({ recentLimit: 0 });
	if (!snapshot) {
		await output(t("commands.session.jobsUnavailable"));
		return;
	}
	if (target === "all") {
		let cancelled = 0;
		for (const job of snapshot.running) {
			if (session.cancelAsyncJob(job.id)) cancelled += 1;
		}
		await output(
			cancelled === 0
				? t("commands.session.noJobsToCancel")
				: t("commands.session.jobsCancelled", { count: cancelled, plural: cancelled === 1 ? "" : "s" }),
		);
		return;
	}
	const safeTarget = truncateToWidth(sanitizeText(target).replace(/\s+/g, " ").trim(), 60);
	if (!snapshot.running.some(job => job.id === target)) {
		await output(t("commands.session.jobNotFound", { id: safeTarget }));
		return;
	}
	await output(
		session.cancelAsyncJob(target)
			? t("commands.session.jobCancelled", { id: safeTarget })
			: t("commands.session.jobCancelFailed", { id: safeTarget }),
	);
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output(t("commands.session.pinStreaming"));
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(t("commands.session.accountsFailed", { error: errorMessage(error) }));
		return;
	}
	if (!accountList) {
		await output(t("commands.session.selectModelBeforePin"));
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.keys.describe(accountList.provider, session.sessionId);
		await output(
			source
				? t("commands.session.noOauthAccountsWithSource", { provider: providerName, source })
				: t("commands.session.noOauthAccounts", { provider: providerName }),
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [t("commands.session.oauthAccounts", { provider: providerName })];
		for (const account of accounts) {
			lines.push(`${account.position + 1}. ${account.label}${account.active ? " (active)" : ""}`);
		}
		lines.push("", t("commands.session.pinHint"));
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(t("commands.session.unmatchedAccount", { provider: providerName, selector }));
		return;
	}
	if (matches.length > 1) {
		await output(
			t("commands.session.ambiguousAccount", {
				selector,
				provider: providerName,
				accounts: matches.map(account => `${account.position + 1}. ${account.label}`).join(", "),
			}),
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(t("commands.session.accountUnavailable", { account: account?.label ?? selector }));
		return;
	}
	await output(t("commands.session.accountPinned", { account: account.label, provider: providerName }));
}

/**
 * Start (or reuse) the stats dashboard for this session. The Frustration page
 * judges through this session's settings and registry; its cost lands on this
 * session's ledger.
 */
function launchSessionStatsDashboard(
	args: StatsDashboardArgs,
	owner: Pick<SlashCommandRuntime, "settings" | "session" | "sessionManager">,
): Promise<StatsDashboardLaunchResult> {
	const judge = resolveJudge({
		settings: owner.settings,
		registry: owner.session.modelRegistry,
		sessionModel: owner.session.model,
		sessionId: owner.session.sessionId,
		purpose: "stats_frustration",
		onUsage: journalJudgmentUsage(owner.sessionManager),
		telemetry: owner.session.agent.telemetry,
		cache: sharedJudgmentCache(),
	});
	return launchStatsDashboard(args, async () => judge);
}

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		icon: "todo",
		get description() {
			return t("commands.session.todoDescription");
		},
		get acpDescription() {
			return t("commands.session.todoAcpDescription");
		},
		acpInputHint: "<subcommand>",
		subcommands: [
			{
				name: "edit",
				get description() {
					return t("commands.session.todoEditDescription");
				},
			},
			{
				name: "copy",
				get description() {
					return t("commands.session.todoCopyDescription");
				},
			},
			{
				name: "expand",
				get description() {
					return t("commands.session.todoExpandDescription");
				},
			},
			{
				name: "collapse",
				get description() {
					return t("commands.session.todoCollapseDescription");
				},
			},
			{
				name: "export",
				get description() {
					return t("commands.session.todoExportDescription");
				},
				usage: "[<path>]",
				getArgumentCompletions: completeTodoPath,
			},
			{
				name: "import",
				get description() {
					return t("commands.session.todoImportDescription");
				},
				usage: "[<path>]",
				getArgumentCompletions: completeTodoPath,
			},
			{
				name: "append",
				get description() {
					return t("commands.session.todoAddDescription");
				},
				usage: "[<phase>] <task...>",
				arguments: [todoPhaseValues, null],
			},
			{
				name: "start",
				get description() {
					return t("commands.session.todoStartDescription");
				},
				usage: "<task>",
				getArgumentCompletions: todoTargetCompletions(false),
			},
			{
				name: "done",
				get description() {
					return t("commands.session.todoDoneDescription");
				},
				usage: "[<task|phase>]",
				getArgumentCompletions: todoTargetCompletions(true),
			},
			{
				name: "drop",
				get description() {
					return t("commands.session.todoAbandonDescription");
				},
				usage: "[<task|phase>]",
				getArgumentCompletions: todoTargetCompletions(true),
			},
			{
				name: "rm",
				get description() {
					return t("commands.session.todoRemoveDescription");
				},
				usage: "[<task|phase>]",
				getArgumentCompletions: todoTargetCompletions(true),
			},
		],
		subcommandOptional: true,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return t("commands.session.noTodos");
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return t("commands.session.todos", { open: pending + inProgress, inProgress, completed });
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args, runtime.focusedSession);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "session",
		icon: "session",
		get description() {
			return t("commands.session.description");
		},
		get acpDescription() {
			return t("commands.session.acpDescription");
		},
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{
				name: "info",
				get description() {
					return t("commands.session.infoDescription");
				},
			},
			{
				name: "delete",
				get description() {
					return t("commands.session.deleteDescription");
				},
			},
			{
				name: "pin",
				get description() {
					return t("commands.session.pinDescription");
				},
				usage: "[account]",
				getArgumentCompletions: completeSessionPinArguments,
			},
		],
		subcommandOptional: true,
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						t("commands.session.sessionId", { id: runtime.session.sessionId }),
						t("commands.session.sessionTitle", { title: String(runtime.session.sessionName) }),
						t("commands.session.cwd", { path: runtime.cwd }),
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage(t("commands.session.deleteStreaming"), runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage(t("commands.session.deleteInMemory"), runtime);
				// Detach the live agent before deleting its file; the next prompt must
				// belong to a fresh session with a valid header and no old history.
				// `drop` deletes the old file and keeps the successor lazy, so deleting
				// never leaves an empty session behind.
				try {
					if (!(await runtime.session.newSession({ drop: true })))
						return usage(t("commands.session.deleteCancelled"), runtime);
				} catch (err) {
					return usage(t("commands.session.newFailed", { error: errorMessage(err) }), runtime);
				}
				try {
					// `drop` only logs a failed delete; retry here to report it (ENOENT is success).
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(
						t("commands.session.deleteFailed", {
							id: runtime.session.sessionId,
							file: sessionFile,
							error: errorMessage(err),
						}),
						runtime,
					);
				}
				await runtime.output(
					t("commands.session.deleted", {
						file: sessionFile,
						id: runtime.session.sessionId,
						newFile: String(runtime.session.sessionFile),
					}),
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage(t("commands.session.usage"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				clearSubmittedText(runtime);
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				clearSubmittedText(runtime);
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus(t("commands.session.usage"));
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "jobs",
		icon: "jobs",
		get description() {
			return t("commands.session.jobsDescription");
		},
		get acpDescription() {
			return t("commands.session.jobsAcpDescription");
		},
		acpInputHint: "[full|kill <id>|kill all]",
		subcommands: [
			{
				name: "full",
				get description() {
					return t("commands.session.jobsFullDescription");
				},
			},
			{
				name: "kill",
				get description() {
					return t("commands.session.jobsKillDescription");
				},
				usage: "<id>|all",
				arguments: [runningJobValues],
			},
		],
		subcommandOptional: true,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.viewSession.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0))
				return t("commands.session.noJobs");
			return t("commands.session.jobsStatus", { running: snapshot.running.length, recent: snapshot.recent.length });
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			if (rest || (verb && verb !== "full")) return usage(t("commands.session.jobsUsage"), runtime);
			const full = verb === "full";
			if (full) runtime.session.requestJobCaptions();
			const tree = runtime.session.getAsyncJobTree();
			if (!tree || (tree.running.length === 0 && tree.recent.length === 0)) {
				await runtime.output(t("commands.session.jobsEmptyExplanation"));
				return commandConsumed();
			}
			// One fenced block keeps the tree rails aligned; the fence outgrows any run inside a command.
			const now = Date.now();
			const rows: string[] = [];
			for (const row of buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId)) {
				const guide = jobTreeGuide(row, theme);
				if (row.kind === "agent") {
					rows.push(`${guide}${row.agent.id}`);
					continue;
				}
				const { job } = row;
				// A spawned subagent's task job takes the agent's id as its id and label: name it once.
				const agent = row.agent && row.agent.id !== job.id ? ` ${row.agent.id}` : "";
				rows.push(
					`${guide}[${job.id}] ${job.type} (${job.status}) — ${formatCoarseDuration((job.endTime ?? now) - job.startTime)}${agent}`,
				);
				// What the job is for leads; full mode follows it with what the command does and the whole command.
				const lines = full ? [job.intent, job.caption, job.command ?? job.label] : [job.intent ?? job.label];
				const indent = jobTreeIndent(row, theme);
				for (const entry of lines) {
					if (!entry) continue;
					const text = shortenEmbeddedPaths(sanitizeText(entry));
					if (text === job.id) continue;
					for (const line of text.split("\n")) rows.push(`${indent}${line}`);
				}
			}
			const body = rows.join("\n");
			const fence = markdownFenceFor(body);
			await runtime.output(
				[
					t("commands.session.jobsTitle"),
					t("commands.session.jobsRunning", { count: tree.running.length }),
					"",
					`${fence}text`,
					body,
					fence,
				].join("\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				const { ctx } = runtime;
				await handleJobsKillCommand(rest, runtime.focusedSession ?? ctx.session, text => ctx.showStatus(text));
			} else if (rest || (verb && verb !== "full")) {
				runtime.ctx.showStatus(t("commands.session.jobsUsage"));
			} else {
				await runtime.ctx.handleJobsCommand({ full: verb === "full" });
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "usage",
		icon: "gauge",
		get description() {
			return t("commands.session.usageDescription");
		},
		get acpDescription() {
			return t("commands.session.usageAcpDescription");
		},
		acpInputHint: "[show|reset [provider/credential-id|provider/active]]",
		subcommands: [
			{
				name: "show",
				get description() {
					return t("commands.session.usageDescription");
				},
			},
			{
				name: "reset",
				get description() {
					return t("commands.session.resetDescription");
				},
				usage: "[provider/credential-id|provider/active]",
				arguments: [resetUsageValues],
			},
		],
		subcommandOptional: true,
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage(t("commands.session.usageGuide"), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(t("commands.session.usageGuide"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "stats",
		icon: "stats",
		get description() {
			return t("commands.session.statsDescription");
		},
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		getTuiArgumentCompletions: completeStatsArguments,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output(t("commands.session.statsSyncing"));
			try {
				const result = await launchSessionStatsDashboard(parsed, runtime);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(t("commands.session.statsFailed", { error: errorMessage(error) }));
				// Mark the failure like `usage()` does, for hosts that report a
				// failed builtin (print mode does not dispatch `/stats`).
				return commandConsumed({ failed: true });
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) {
				ctx.showStatus(parsed.error);
				return;
			}
			try {
				const result = await launchSessionStatsDashboard(parsed, ctx);
				ctx.presentCommandOutput(new StatsNotice(result.message, result.url));
			} catch (error) {
				ctx.showError(t("commands.session.statsFailed", { error: errorMessage(error) }));
			}
		},
	},
	{
		name: "changelog",
		icon: "news",
		get description() {
			return t("commands.session.changelogDescription");
		},
		get acpDescription() {
			return t("commands.session.changelogAcpDescription");
		},
		acpInputHint: "[full|last [N]]",
		subcommands: [
			{
				name: "full",
				get description() {
					return t("commands.session.changelogFullDescription");
				},
			},
			{
				name: "last",
				get description() {
					return t("commands.session.changelogCountDescription");
				},
				usage: "[N]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const view = parseChangelogView(command.args);
			if ("error" in view) return usage(view.error, runtime);
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const entriesToShow = selectChangelogEntries(allEntries, view);
			if (entriesToShow.length === 0) {
				await runtime.output(t("commands.session.changelogEmpty"));
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleChangelogCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "hotkeys",
		icon: "keyboard",
		get description() {
			return t("commands.session.hotkeysDescription");
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "tool",
		icon: "tools",
		get description() {
			return t("commands.session.toolDescription");
		},
		allowArgs: true,
		getTuiArgumentCompletions: completeToolArguments,
		handle: async ({ args }, runtime) => {
			const { name, argumentsText: rest } = parseHumanToolCommand(args);
			if (!rest) {
				await runtime.output(runtime.session.getToolCatalogDocs(name || undefined));
				return commandConsumed();
			}
			const invoke = async (): Promise<void> => {
				try {
					await runtime.session.invokeTool(name, parseHumanToolArguments(rest), runtime.signal);
				} catch (error) {
					await runtime.output(errorMessage(error));
				}
			};
			if (runtime.runCommandInBackground) runtime.runCommandInBackground(invoke);
			else await invoke();
			return commandConsumed();
		},
		handleTui: async ({ args }, runtime) => {
			const { name, argumentsText: rest } = parseHumanToolCommand(args);
			clearSubmittedText(runtime);
			if (!rest) {
				runtime.ctx.handleToolCatalogCommand(name || undefined);
				return;
			}
			try {
				await runtime.ctx.session.invokeTool(name, parseHumanToolArguments(rest));
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "tools",
		icon: "tools",
		get description() {
			return t("commands.session.toolsDescription");
		},
		get acpDescription() {
			return t("commands.session.toolsAcpDescription");
		},
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0
				? t("commands.session.noTools")
				: t("commands.session.toolCounts", { active, available: all });
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output(t("commands.session.noAvailableTools"));
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "context",
		icon: "context",
		get description() {
			return t("commands.session.contextDescription");
		},
		get acpDescription() {
			return t("commands.session.contextAcpDescription");
		},
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return t("commands.session.contextUnavailable");
			return t("commands.session.contextUsage", {
				percent: Math.round(usage.percent),
				used: formatTokenCount(usage.tokens),
				total: formatTokenCount(usage.contextWindow),
			});
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		icon: "extension",
		get description() {
			return t("commands.session.extensionsDescription");
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "agents",
		icon: "agents",
		get description() {
			return t("commands.session.agentsDescription");
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "git",
		icon: "branch",
		get description() {
			return t("commands.session.gitDescription");
		},
		inlineHint: "[revision]",
		allowArgs: true,
		getTuiArgumentCompletions: completeGitRevision,
		handleTui: (command, runtime) => {
			runtime.ctx.showGitUi(command.args.trim() || undefined);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "local",
		icon: "pencil",
		get description() {
			return t("commands.session.editDescription");
		},
		inlineHint: "[name]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await openLocalFileInEditor(runtime.ctx, command.args, runtime.focusedSession);
		},
	},
	{
		name: "hub",
		aliases: ["subagents"],
		icon: "agents",
		get description() {
			return t("commands.session.agentHubDescription");
		},
		inlineHint: "[agent]",
		allowArgs: true,
		getTuiArgumentCompletions: completeHubArguments,
		handleTui: (command, runtime) => {
			clearSubmittedText(runtime);
			const id = command.args.trim();
			runtime.ctx.showAgentHub(id ? { initialTranscript: id } : { initialSection: "activity" });
		},
	},
	{
		name: "irc",
		icon: "agents",
		get description() {
			return t("commands.session.ircDescription");
		},
		inlineHint: "[<peer>|#<group>|all <message> | group <operation>]",
		allowArgs: true,
		getTuiArgumentCompletions: completeIrcArguments,
		handleTui: handleIrcCommand,
	},
	{
		name: "branch",
		aliases: ["rewind"],
		icon: "branch",
		get description() {
			return t("commands.session.rewindDescription");
		},
		handleTui: (_command, runtime) => {
			clearSubmittedText(runtime);
			runtime.ctx.showUserMessageSelector(undefined, runtime.focusedSession);
		},
	},
	{
		name: "fork",
		icon: "branch",
		get description() {
			return t("commands.session.forkDescription");
		},
		subcommands: [
			{
				name: "pane",
				get description() {
					return t("commands.session.forkPaneDescription");
				},
			},
			{
				name: "window",
				get description() {
					return t("commands.session.forkWindowDescription");
				},
			},
			{
				name: "tab",
				get description() {
					return t("commands.session.forkTabDescription");
				},
			},
		],
		subcommandOptional: true,
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			let placement: "pane" | "window" | undefined;
			if (args) {
				const [keyword, ...extra] = args.split(/\s+/);
				if (extra.length > 0) {
					clearSubmittedText(runtime);
					runtime.ctx.showError(t("commands.session.forkUsage"));
					return;
				}
				switch (keyword?.toLowerCase()) {
					case "pane":
						placement = "pane";
						break;
					case "window":
					case "tab":
						placement = "window";
						break;
					default:
						clearSubmittedText(runtime);
						runtime.ctx.showError(t("commands.session.forkUsage"));
						return;
				}
			}
			clearSubmittedText(runtime);
			if (placement) await runtime.ctx.handleForkCommand(placement, runtime.focusedSession);
			else await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		icon: "tree",
		get description() {
			return t("commands.session.treeDescription");
		},
		handleTui: (_command, runtime) => {
			clearSubmittedText(runtime);
			runtime.ctx.showTreeSelector(runtime.focusedSession);
		},
	},
	{
		name: "login",
		icon: "signIn",
		get description() {
			return t("commands.session.loginDescription");
		},
		inlineHint: "[provider|neoproxy <url>|redirect URL]",
		allowArgs: true,
		getTuiArgumentCompletions: completeLoginArguments,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? t("commands.session.loginWaiting", {
						provider: runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth",
					})
				: t("commands.session.loginChoose"),
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const [requestedProvider = "", ...urlParts] = args.split(/\s+/);
				const loginUrl = urlParts.join(" ");
				const matchedProvider = getOAuthProviders().find(provider => provider.id === requestedProvider);
				// Only NeoProxy takes an argument (its server URL); other providers
				// followed by text keep the redirect-URL paste path below.
				if (matchedProvider && (!loginUrl || matchedProvider.id === "neoproxy")) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? t("commands.session.loginInProgressForProvider", { provider: pendingProvider })
							: t("commands.session.loginInProgress");
						runtime.ctx.showWarning(message);
						clearSubmittedText(runtime);
						return;
					}
					if (loginUrl) {
						void withNeoProxyLoginUrl(runtime.ctx.session.modelRegistry, loginUrl, () =>
							runtime.ctx.showOAuthSelector("login", "neoproxy"),
						);
					} else {
						void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					}
					clearSubmittedText(runtime);
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus(t("commands.session.loginCallbackReceived"));
				} else {
					runtime.ctx.showWarning(t("commands.session.loginCallbackNotExpected"));
				}
				clearSubmittedText(runtime);
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? t("commands.session.loginInProgressForProvider", { provider })
					: t("commands.session.loginInProgress");
				runtime.ctx.showWarning(message);
				clearSubmittedText(runtime);
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "logout",
		icon: "signOut",
		get description() {
			return t("commands.session.logoutDescription");
		},
		inlineHint: "[provider]",
		allowArgs: true,
		getTuiArgumentCompletions: completeLogoutArguments,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(t("commands.session.unknownOauthProvider", { provider: providerId }));
					clearSubmittedText(runtime);
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				clearSubmittedText(runtime);
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "mcp",
		icon: "mcp",
		get description() {
			return t("commands.session.mcpDescription");
		},
		get acpDescription() {
			return t("commands.session.mcpAcpDescription");
		},
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				get description() {
					return t("commands.session.mcpAddDescription");
				},
				usage: "<name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]",
				getArgumentCompletions: completeMcpAddArguments,
			},
			{
				name: "list",
				get description() {
					return t("commands.session.mcpListDescription");
				},
			},
			{
				name: "remove",
				get description() {
					return t("commands.session.mcpRemoveDescription");
				},
				usage: "<name> [--scope project|user]",
				getArgumentCompletions: completeMcpRemoveArguments,
			},
			{
				name: "test",
				get description() {
					return t("commands.session.mcpTestDescription");
				},
				usage: "<name>",
				arguments: [mcpServerArgumentValues("test")],
			},
			{
				name: "reauth",
				get description() {
					return t("commands.session.mcpAuthDescription");
				},
				usage: "<name>",
				arguments: [mcpServerArgumentValues("reauth")],
			},
			{
				name: "unauth",
				get description() {
					return t("commands.session.mcpUnauthDescription");
				},
				usage: "<name>",
				arguments: [mcpServerArgumentValues("unauth")],
			},
			{
				name: "enable",
				get description() {
					return t("commands.session.mcpEnableDescription");
				},
				usage: "<name>",
				arguments: [mcpServerArgumentValues("enable")],
			},
			{
				name: "disable",
				get description() {
					return t("commands.session.mcpDisableDescription");
				},
				usage: "<name>",
				arguments: [mcpServerArgumentValues("disable")],
			},
			{
				name: "reconnect",
				get description() {
					return t("commands.session.mcpReconnectDescription");
				},
				usage: "<name>",
				arguments: [mcpServerArgumentValues("reconnect")],
			},
			{
				name: "reload",
				get description() {
					return t("commands.session.mcpReloadDescription");
				},
			},
			{
				name: "resources",
				get description() {
					return t("commands.session.mcpResourcesDescription");
				},
			},
			{
				name: "prompts",
				get description() {
					return t("commands.session.mcpPromptsDescription");
				},
			},
			{
				name: "notifications",
				get description() {
					return t("commands.session.mcpNotificationsDescription");
				},
			},
			{
				name: "help",
				get description() {
					return t("commands.session.mcpHelpDescription");
				},
			},
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
];
