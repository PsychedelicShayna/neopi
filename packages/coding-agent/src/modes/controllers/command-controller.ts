import { t } from "@oh-my-pi/pi-utils/i18n";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import {
	getEnvApiKey,
	getProviderDetails,
	type Model,
	type ProviderDetails,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
	usageSubscriptionPlan,
} from "@oh-my-pi/pi-ai";
import {
	type Component,
	Loader,
	Markdown,
	padding,
	parseSgrMouse,
	Spacer,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatDuration, logger, PRODUCT_NAME, Snowflake, sanitizeText } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getConfigDirName } from "@oh-my-pi/pi-utils/dirs";
import { getLocale } from "@oh-my-pi/pi-utils/i18n";
import { classifyTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { shouldEnableAppendOnlyContext } from "../../config/append-only-context-mode";
import { type BashResult, isPersistentShellCdCommand } from "../../exec/bash-executor";
import { type LoadedCustomShare, loadCustomShare } from "../../export/custom-share";
import { parseExportArgs } from "../../export/html/args";
import { shareSession } from "../../export/share";
import type { CompactOptions } from "../../extensibility/extensions/types";
import {
	diffMentalModelContent,
	type HindsightClientApi,
	type HindsightSessionState,
	loadHindsightConfig,
	reloadMentalModelsForSession,
	resolveSeedsForScope,
	seedAlreadyExists,
	summarizeMentalModel,
} from "../../hindsight";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../../memory-backend";
import { BashExecutionComponent, bashPtyViewport } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { BorderedLoader } from "@oh-my-pi/pi-tui/overlays/bordered-loader";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { promptCacheDetails } from "@oh-my-pi/pi-tui/status-line/prompt-cache";
import { messageBlock, PresentedBlock } from "@oh-my-pi/pi-tui/chat/transcript-presentation";
import { MoveOverlay, type MoveOverlayResult } from "@oh-my-pi/pi-tui/overlays/move-overlay";
import { moveDirectorySource } from "../move-directory-source";
import { getMarkdownTheme, getSymbolTheme, theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { continuesConversation } from "../utils/conversation-position";
import { ContextViewer } from "@oh-my-pi/pi-tui/overlays/context-viewer";
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import type { TspText } from "@oh-my-pi/pi-wire";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import { buildSessionContextView } from "../../session/context-view";
import { buildHotkeysMarkdown, HotkeysSheetComponent } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { buildToolsMarkdown } from "@oh-my-pi/pi-tui/prompt/tools-markdown";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import { buildJobTree, jobTreeGuide, jobTreeIndent } from "@oh-my-pi/pi-tui/overlays/job-tree";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import { type CompactMode, findCompactMode } from "../../session/compact-modes";
import {
	currentRuntimeIdentity,
	formatRuntimeIdentity,
	runtimeIdentityHistory,
	sameRuntimeIdentity,
} from "../../session/runtime-identity";
import type { NewSessionOptions } from "../../session/session-entries";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
} from "../../session/session-worktree";
import type { SessionWorktree } from "../../worktree/backend";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "../../session/shake-types";
import {
	codexUsagePlan,
	formatActiveAccountLabel,
	formatCodexUsageReportLabel,
	limitMatchesActiveAccount,
} from "../../slash-commands/helpers/active-oauth-account";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import { formatCompactQuota } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { resolveTernPane } from "../../tools/browser/tern/kind";
import { TernError, type TernErrorKind, TernSocketClient } from "../../tools/browser/tern/wire";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../tools/path-utils";
import { replaceTabs, shortenEmbeddedPaths, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../../utils/changelog";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDumpArchiveReport, type SessionDumpArchive } from "../../session/session-dump-format";
import { openPath } from "../../utils/open";
import { resumeCommand } from "../../utils/resume-command";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import {
	collapseSharedUsageReports,
	formatLimitTitle,
	summarizeUsageResetCredits,
} from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatRemainingOnlyTotal, isUsedOnlyAbsoluteAmount } from "@oh-my-pi/pi-tui/prompt/usage-amounts";
import type { UnavailableUsageAccount } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";

import { cfgTerminalShowImages } from "../settings";
import { cfgProviderAppendOnlyContext } from "../../session/settings";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "../../commands/settings";
import { flagConsumesValue, restartArgv } from "../../cli/flag-tables";
import {
	createDefaultTerminalLaunchRequest,
	getTerminalLaunchPlacement,
	launchTerminal,
	scopeEnvCommand,
	TerminalLaunchError,
	type TerminalLaunchRequest,
	type TerminalLaunchResult,
} from "../../subprocess/terminal-launch";
import { resolveCliEntryCmd } from "../../subprocess/worker-client";

/** How long `/fork` waits for Tern to open the fork's pane. */
const TERN_FORK_TIMEOUT_MS = 10_000;

/** Fork failures after which Tern may still open the pane, so `/fork` must not also fork in place. */
const TERN_FORK_UNCONFIRMED: Partial<Record<TernErrorKind, true>> = { closed: true, timeout: true, protocol: true };

/** Rows `/session` spends on the builds that wrote the session, including the elision row. */
const MAX_LISTED_BUILDS = 5;

function formatCreditValue(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

interface ForkTerminalDependencies {
	classifyTerminalMultiplexer: typeof classifyTerminalMultiplexer;
	environment: () => NodeJS.ProcessEnv;
	launchTerminal: (request: TerminalLaunchRequest) => Promise<TerminalLaunchResult>;
	resolveCliEntryCmd: typeof resolveCliEntryCmd;
	getActiveProfile: typeof getActiveProfile;
	argv: () => string[];
}

/**
 * Startup flags the fork child re-supplies from the parent's live state
 * (`--profile`, `--model`, `--thinking`, `--prompt-cache-key`) or that would
 * re-point it at a stale scope (`--config`/`--cwd`/`--provider`; the child
 * gets the effective overlays via `PI_CONFIG_FILES` and the session cwd).
 */
const FORK_LAUNCH_OVERRIDES: Readonly<Record<string, true>> = {
	"--config": true,
	"--cwd": true,
	"--model": true,
	"--profile": true,
	"--prompt-cache-key": true,
	"--provider": true,
	"--thinking": true,
};

function hasForkApiKeyOverride(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--api-key" || arg.startsWith("--api-key=")) return true;
		if (flagConsumesValue(arg, argv[i + 1])) i++;
	}
	return false;
}

export class CommandController {
	/** The open native report sheet and the component it shows. */
	#reportSheet: { handle: OverlayHandle; component: Component } | undefined;
	#forkTerminalDependencies: ForkTerminalDependencies;
	/** The watcher serving the queued `/compact`, while one runs. */
	#yieldCompactionWatcher: Promise<void> | undefined;

	constructor(
		private readonly ctx: InteractiveModeContext,
		forkTerminalDependencies: Partial<ForkTerminalDependencies> = {},
	) {
		this.#forkTerminalDependencies = {
			classifyTerminalMultiplexer,
			environment: () => process.env,
			launchTerminal,
			resolveCliEntryCmd,
			getActiveProfile,
			argv: () => process.argv.slice(2),
			...forkTerminalDependencies,
		};
	}

	/** Esc: take away the report shown above the editor (text mode); false when none is shown. */
	dismissCommandReport(): boolean {
		return this.#clearReport();
	}

	/**
	 * Drop any report — the one above the editor, or a focused sheet/page —
	 * because the transcript or session under it was reset, and its contents
	 * describe what is gone.
	 */
	clearCommandReport(): void {
		this.#clearReport();
		this.#closeReportSheet();
	}

	#clearReport(): boolean {
		const docked = this.ctx.reportContainer;
		if (docked.children.length === 0) return false;
		docked.dispose();
		docked.clear();
		this.ctx.ui.requestRender();
		return true;
	}

	#closeReportSheet(): void {
		const sheet = this.#reportSheet;
		if (!sheet) return;
		this.#reportSheet = undefined;
		sheet.handle.hide();
		// Like the docked report, a closed sheet is never shown again.
		sheet.component.dispose?.();
		this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/** Open `component` as a focused full-screen page; callers close any previous sheet first. */
	#showFullscreenSheet(component: Component): void {
		const handle = this.ctx.ui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.#reportSheet = { handle, component };
		this.ctx.ui.setFocus(component);
	}

	/**
	 * Show a read-only report, replacing the previous one. In text mode one that
	 * fits the rows above the editor shows there like `/btw`: the editor keeps
	 * focus and its Esc takes the report away. A taller one opens as a
	 * full-screen page on the terminal's alternate screen, scrolled with the
	 * arrow/page keys and the wheel, so the main screen is never touched and
	 * Esc returns to it as it was. Natively it is a focused sheet like
	 * `/usage`, its body scrolled by the terminal once it is long, closed by
	 * Esc or Close.
	 */
	showCommandReport(options: { title: string; head?: TspText; body: Component }): void {
		this.#clearReport();
		this.#closeReportSheet();
		const terminal = this.ctx.ui.terminal;
		const inline = this.ctx.commandReportRows() ?? terminal.rows;
		let fullScreen = false;
		const report = new ReportPanel({
			...options,
			closeKey: appKey(this.ctx.keybindings, "app.navigation.dismiss"),
			onClose: () => this.#closeReportSheet(),
			maxRows: () => (fullScreen ? terminal.rows : this.ctx.commandReportRows()),
		});
		const native = isNativeRendering();
		if (native || report.heightAt(terminal.columns) > inline) {
			fullScreen = !native;
			report.holdFocus();
			const menu = this.ctx.openMenu("report-panel", () => this.showCommandReport(options));
			if (!menu) return;
			menu.mount(report, () => {
				const handle = this.ctx.ui.showOverlay(
					report,
					native
						? { anchor: "center", width: "90%", maxHeight: "90%" }
						: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
				);
				const hide = handle.hide.bind(handle);
				handle.hide = () => {
					menu.close();
					if (this.#reportSheet?.handle === handle) this.#reportSheet = undefined;
					hide();
				};
				this.#reportSheet = { handle, component: report };
				this.ctx.ui.setFocus(report);
				return handle;
			});
		} else {
			this.ctx.reportContainer.addChild(report);
		}
		this.ctx.ui.requestRender();
	}

	/** A titled markdown report; see {@link showCommandReport}. */
	#showMarkdownPanel(title: string, markdown: string): void {
		this.showCommandReport({ title, body: new Markdown(markdown.trim(), 0, 0, getMarkdownTheme()) });
	}

	async #restoreAfterMoveFailure(
		previousState: Parameters<InteractiveModeContext["sessionManager"]["rollbackMove"]>[0],
		initialError?: unknown,
	): Promise<void> {
		if (initialError !== undefined) {
			this.ctx.showError(
				t("commands.controller.workspaceSwitchFailed", {
					error: initialError instanceof Error ? initialError.message : String(initialError),
				}),
			);
		}

		try {
			await this.ctx.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			const actual = this.ctx.sessionManager.getCwd();
			let realigned = false;
			try {
				realigned = await this.ctx.applyCwdChange(actual);
			} catch {}
			if (!realigned) {
				this.ctx.showError(
					t("commands.controller.rollbackRealignFailed", {
						error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
						path: actual,
					}),
				);
				await this.ctx.shutdown({ cancellable: false });
				return;
			}
			this.ctx.showError(
				t("commands.controller.rollbackFailed", {
					error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
					path: actual,
				}),
			);
			return;
		}

		let sourceRestored = false;
		try {
			sourceRestored = await this.ctx.applyCwdChange(previousState.cwd);
		} catch {}
		if (sourceRestored) return;

		const actual = this.ctx.sessionManager.getCwd();
		let realigned = false;
		try {
			realigned = await this.ctx.applyCwdChange(actual);
		} catch {}
		if (!realigned) {
			this.ctx.showError(t("commands.controller.restoreWorkspaceFailed", { path: actual }));
			await this.ctx.shutdown({ cancellable: false });
			return;
		}
		this.ctx.showError(t("commands.controller.restoreWorkspaceFailed", { path: actual }));
	}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}

	async handleExportCommand(text: string): Promise<void> {
		try {
			const { outputPath, useUserThemes } = parseExportArgs(text.slice("/export".length));
			if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
				this.ctx.showWarning(t("commands.collaboration.copyDumpHint"));
				return;
			}

			// The viewed session: the focused subagent's transcript (plus its own
			// subagents) from a focused view, otherwise the main session.
			const filePath = await this.ctx.viewSession.exportToHtml(outputPath, useUserThemes);
			this.ctx.showStatus(t("commands.collaboration.exported", { path: filePath }));
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.ctx.showError(
				t("commands.collaboration.exportFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}
	}
	async handleTraceCommand(): Promise<void> {
		const sessionFile = this.ctx.session.sessionFile;
		if (!sessionFile) {
			this.ctx.showWarning(t("commands.collaboration.traceNoFile"));
			return;
		}
		try {
			// Lazy: the stats dashboard (server + sqlite) loads on demand only,
			// matching src/cli/stats-cli.ts, to keep CLI startup fast.
			const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
			const { hostname, port } = await startServer();
			const url = `${formatStatsDashboardUrl(hostname, port, getLocale())}#/traces?s=${encodeURIComponent(sessionFile)}`;
			this.openInBrowser(url);
			this.ctx.showStatus(t("commands.controller.traceUrl", { url }));
		} catch (error: unknown) {
			this.ctx.showError(
				t("commands.collaboration.traceFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError(t("commands.collaboration.noMessagesToDump"));
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : t("commands.controller.unknownError");
			}
			const doc = sidecarPath
				? t("commands.controller.dumpInfo", { transcript: formatted, path: sidecarPath })
				: formatted;
			await copyToClipboard(doc);
			const statusParts = [t("commands.controller.copiedSession")];
			if (sidecarPath) statusParts.push(t("commands.collaboration.llmRequestJson", { path: sidecarPath }));
			if (sidecarError) statusParts.push(t("commands.controller.llmRequestUnavailable", { error: sidecarError }));
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(
				t("commands.controller.copySessionFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}
	}

	handleDumpAllCommand(): Promise<void> {
		return this.#writeDumpArchive(() => this.ctx.session.dumpSessionArchiveToTmpDir());
	}

	handleDumpAnonCommand(): Promise<void> {
		return this.#writeDumpArchive(() => this.ctx.session.dumpAnonymizedArchiveToTmpDir());
	}

	async #writeDumpArchive(write: () => Promise<SessionDumpArchive | undefined>): Promise<void> {
		try {
			const archive = await write();
			if (!archive) {
				this.ctx.showError(t("commands.collaboration.noMessagesToDump"));
				return;
			}
			await copyToClipboard(archive.path);
			this.ctx.showStatus(
				[...formatDumpArchiveReport(archive), t("commands.controller.copiedArchivePath")].join("\n"),
			);
		} catch (error: unknown) {
			this.ctx.showError(
				t("commands.controller.writeDumpFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}
	}

	handleAdvisorDumpCommand(isRaw = false) {
		try {
			const advisorHistory = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
			if (advisorHistory === null) {
				this.ctx.showError(t("commands.collaboration.advisorInactive"));
				return;
			}
			if (!advisorHistory) {
				this.ctx.showError(t("commands.controller.advisorNoHistory"));
				return;
			}
			copyToClipboard(advisorHistory);
			this.ctx.showStatus(t("commands.controller.copiedAdvisorHistory"));
		} catch (error: unknown) {
			this.ctx.showError(
				t("commands.controller.copyAdvisorFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const width = Math.max(1, this.ctx.ui.terminal.columns);
			const renderedLines = this.ctx.chatContainer.render(width).map(line => replaceTabs(Bun.stripANSI(line)));
			const rendered = renderedLines.join("\n").trimEnd();
			if (!rendered) {
				this.ctx.showError(t("commands.collaboration.noMessagesToDump"));
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(t("commands.controller.debugWritten", { path: tmpPath }));
		} catch (error: unknown) {
			this.ctx.showError(
				t("commands.controller.debugWriteFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}
	}

	async handleShareCommand(): Promise<void> {
		let customShare: LoadedCustomShare | null;
		try {
			customShare = await loadCustomShare();
		} catch (err) {
			this.ctx.showError(err instanceof Error ? err.message : String(err));
			return;
		}

		const loader = new BorderedLoader(this.ctx.ui, theme, t("commands.controller.sharing"));
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(loader);
		this.ctx.ui.setFocus(loader);
		this.ctx.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		loader.onAbort = () => {
			restoreEditor();
			this.ctx.showStatus(t("commands.controller.shareCancelled"));
		};

		// Custom share scripts keep their legacy contract: they receive a path
		// to a standalone HTML export. No fallback to the default flow on error.
		if (customShare) {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				await this.ctx.session.exportToHtml(tmpFile);
				const result = await customShare.fn(tmpFile);
				if (loader.signal.aborted) return;
				restoreEditor();

				if (typeof result === "string") {
					this.ctx.showStatus(t("commands.collaboration.shareUrl", { url: result }));
					this.openInBrowser(result);
				} else if (result) {
					const parts: string[] = [];
					if (result.url) parts.push(t("commands.collaboration.shareUrl", { url: result.url }));
					if (result.message) parts.push(result.message);
					if (parts.length > 0) this.ctx.showStatus(parts.join("\n"));
					if (result.url) this.openInBrowser(result.url);
				} else {
					this.ctx.showStatus(t("commands.controller.shared"));
				}
			} catch (err) {
				if (!loader.signal.aborted) {
					restoreEditor();
					this.ctx.showError(
						t("commands.controller.customShareFailed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
				}
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
			return;
		}

		// Default: encrypted snapshot to a secret gist (preferred) or the share
		// server; the key rides in the link fragment and never leaves the client.
		try {
			const result = await shareSession(this.ctx.session.sessionManager, {
				serverUrl: cfgShareServerUrl.get(this.ctx.settings),
				store: cfgShareStore.get(this.ctx.settings),
				state: this.ctx.session.state,
				obfuscator: cfgShareRedactSecrets.get(this.ctx.settings) ? this.ctx.session.obfuscator : undefined,
			});
			if (loader.signal.aborted) return;
			restoreEditor();

			const lines = [t("commands.collaboration.shareUrl", { url: result.url })];
			if (result.gistUrl) lines.push(t("commands.collaboration.gistUrl", { url: result.gistUrl }));
			if (result.truncated) lines.push(t("commands.collaboration.shareTrimmed"));
			this.ctx.showStatus(lines.join("\n"));
			this.openInBrowser(result.url);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.ctx.showError(
					t("commands.collaboration.shareFailed", {
						error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
					}),
				);
			}
		}
	}

	async handleSessionCommand(): Promise<void> {
		const stats = this.ctx.session.getSessionStats();
		const premiumRequests =
			"premiumRequests" in stats && typeof stats.premiumRequests === "number"
				? stats.premiumRequests
				: this.ctx.session.sessionManager.getUsageStatistics().premiumRequests;
		const normalizedPremiumRequests = Math.round((premiumRequests + Number.EPSILON) * 100) / 100;

		let info = "";
		info += `${theme.fg("dim", t("commands.controller.file"))} ${stats.sessionFile ?? t("commands.controller.inMemory")}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n`;
		const builds = runtimeIdentityHistory(this.ctx.session.sessionManager.getEntries());
		const running = currentRuntimeIdentity();
		// A source checkout's diff hash changes with each edit, so a long-lived session can collect
		// many builds: keep the first and the latest few. Every row is keyed so the overlay never
		// mistakes a colourless continuation row for a section heading.
		const hidden = builds.length > MAX_LISTED_BUILDS ? builds.length - MAX_LISTED_BUILDS + 1 : 0;
		for (const [index, build] of builds.entries()) {
			if (hidden > 0 && index > 0 && index <= hidden) {
				if (index === 1)
					info += t("commands.controller.moreBuilds", {
						label: theme.fg("dim", t("commands.controller.buildRange", { end: hidden + 1 })),
						count: hidden,
					});
				continue;
			}
			const key =
				builds.length === 1
					? t("commands.controller.build")
					: t("commands.controller.numberedBuild", { number: index + 1 });
			info += `${theme.fg("dim", key)} ${replaceTabs(sanitizeText(formatRuntimeIdentity(build)))}\n`;
		}
		if (!sameRuntimeIdentity(builds[builds.length - 1], running)) {
			info += `${theme.fg("dim", t("commands.controller.running"))} ${replaceTabs(sanitizeText(formatRuntimeIdentity(running)))}\n`;
		}
		info += `\n${theme.bold(t("commands.controller.provider"))}\n`;
		const model = this.ctx.session.model;
		if (!model) {
			info += `${theme.fg("dim", t("commands.controller.noModelSelected"))}\n`;
		} else {
			const authMode = resolveProviderAuthMode(this.ctx.session.modelRegistry.authStorage, model.provider);
			const credentialSource = this.ctx.session.modelRegistry.authStorage.keys.describe(
				model.provider,
				stats.sessionId,
			);
			const providerDetails = getProviderDetails({
				model,
				sessionId: stats.sessionId,
				authMode,
				credentialSource,
				preferWebsockets: this.ctx.session.preferWebsockets,
				providerSessionState: this.ctx.session.providerSessionState,
			});
			info += renderProviderSection(providerDetails, theme);
			if (stats.routedModels !== undefined) {
				const routed = Object.entries(stats.routedModels)
					.sort(([aId, aCount], [bId, bCount]) => bCount - aCount || aId.localeCompare(bId))
					.map(
						([id, count]) => `${replaceTabs(sanitizeText(id))}${count > 1 ? theme.fg("dim", ` ×${count}`) : ""}`,
					);
				info += `${theme.fg("dim", t("commands.controller.served"))} ${routed.join(", ")}\n`;
			}
		}
		info += `\n`;
		info += `${theme.bold(t("commands.controller.messages"))}\n`;
		info += `${theme.fg("dim", t("commands.controller.user"))} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", t("commands.controller.assistant"))} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", t("commands.controller.toolCalls"))} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", t("commands.controller.toolResults"))} ${stats.toolResults}\n`;
		if (stats.editRejections !== undefined) {
			const kinds = Object.entries(stats.editRejections).sort(
				([aKind, aCount], [bKind, bCount]) => bCount - aCount || aKind.localeCompare(bKind),
			);
			const total = kinds.reduce((sum, [, count]) => sum + count, 0);
			const breakdown = kinds
				.map(([kind, count]) => `${replaceTabs(sanitizeText(kind.replaceAll("_", " ")))} ${count}`)
				.join(", ");
			info += `${theme.fg("dim", t("commands.controller.editRejections"))} ${total} ${theme.fg("dim", `(${breakdown})`)}\n`;
		}
		info += `${theme.fg("dim", t("commands.controller.total"))} ${stats.totalMessages}\n\n`;
		// Append-only context
		{
			const setting = cfgProviderAppendOnlyContext.get(this.ctx.settings);
			const model = this.ctx.session.model;
			const mode = shouldEnableAppendOnlyContext(setting, model);
			const activeLabel = mode
				? theme.fg("success", t("commands.controller.active"))
				: theme.fg("dim", t("commands.controller.inactive"));
			const settingLabel = setting === "auto" ? `${setting} (${model?.provider ?? "?"})` : setting;
			info += t("commands.controller.appendOnlySetting", {
				label: theme.fg("dim", t("commands.controller.appendOnly")),
				value: activeLabel,
				setting: settingLabel,
			});
		}
		info += `${theme.bold(t("commands.controller.tokens"))}\n`;
		info += `${theme.fg("dim", t("commands.controller.input"))} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", t("commands.controller.output"))} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", t("commands.controller.cacheRead"))} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", t("commands.controller.cacheWrite"))} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", t("commands.controller.total"))} ${stats.tokens.total.toLocaleString()}\n`;

		const cacheStatus = this.ctx.session.getPromptCacheStatus();
		if (cacheStatus) {
			info += `\n${theme.bold(t("commands.controller.promptCache"))}\n`;
			for (const row of promptCacheDetails(cacheStatus, Date.now())) {
				const value = row.tone === "warning" ? theme.fg("warning", row.value) : row.value;
				info += `${theme.fg("dim", `${row.label}:`)} ${value}\n`;
			}
		}

		if (stats.cost > 0 || normalizedPremiumRequests > 0 || stats.credits !== undefined) {
			info += `\n${theme.bold(t("commands.controller.costHeading"))}\n`;
			if (stats.cost > 0) {
				info += `${theme.fg("dim", t("commands.controller.total"))} ${stats.cost.toFixed(4)}\n`;
			}
			if (normalizedPremiumRequests > 0) {
				info += `${theme.fg("dim", t("commands.controller.premiumRequests"))} ${normalizedPremiumRequests.toLocaleString()}\n`;
			}
			if (stats.credits !== undefined) {
				info += `${theme.fg("dim", t("commands.controller.credits"))} ${formatCreditValue(stats.credits.cost)}\n`;
				info += `${theme.fg("dim", t("commands.controller.committedCredits"))} ${formatCreditValue(stats.credits.committedCost)}\n`;
				info += `${theme.fg("dim", t("commands.controller.committedAcu"))} ${formatCreditValue(stats.credits.acuCost)}\n`;
			}
		}

		if (this.ctx.lspServers && this.ctx.lspServers.length > 0) {
			info += `\n${theme.bold(t("commands.controller.lspServers"))}\n`;
			for (const server of this.ctx.lspServers) {
				const statusColor =
					server.status === "ready"
						? "success"
						: server.status === "available"
							? "dim"
							: server.status === "connecting"
								? "warning"
								: "error";
				const lspState = t(`commands.controller.lspState.${server.status}`);
				const statusText = server.status === "error" && server.error ? `${lspState}: ${server.error}` : lspState;
				info += `${theme.fg("dim", `${server.name}:`)} ${theme.fg(statusColor, statusText)} ${theme.fg("dim", `(${server.fileTypes.join(", ")})`)}\n`;
			}
		}

		if (this.ctx.mcpManager) {
			const mcpServers = this.ctx.mcpManager.getConnectedServers();
			info += `\n${theme.bold(t("commands.controller.mcpServers"))}\n`;
			if (mcpServers.length === 0) {
				info += `${theme.fg("dim", t("commands.controller.noneConnected"))}\n`;
			} else {
				for (const name of mcpServers) {
					const conn = this.ctx.mcpManager.getConnection(name);
					const toolCount = conn?.tools?.length ?? 0;
					info += `${theme.fg("dim", `${name}:`)} ${theme.fg("success", t("commands.controller.connected"))} ${theme.fg("dim", t("commands.controller.toolCount", { count: toolCount }))}\n`;
				}
			}
		}

		this.ctx.showSessionInfo(info, this.ctx.session.getContextUsage());
	}

	static readonly #advisorStatusGlyph: Record<string, string> = {
		running: "●",
		paused: "○",
		no_model: "○",
		quota_exhausted: "✕",
		error: "✕",
	};

	static readonly #advisorStatusLabel: Record<string, string> = {
		get running() {
			return t("commands.controller.runningStatus");
		},
		get paused() {
			return t("commands.controller.offStatus");
		},
		get no_model() {
			return t("commands.controller.noModel");
		},
		get quota_exhausted() {
			return t("commands.controller.quotaExhausted");
		},
		get error() {
			return t("commands.controller.errorStatus");
		},
	};

	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		if (!stats.configured) {
			this.showCommandReport({
				title: t("commands.controller.advisorStatus"),
				body: new Text(t("commands.controller.advisorDisabled"), 0, 0),
			});
			return;
		}
		// Render cached quota data without waiting for the network. Quota lines
		// are optional, and the refresh below serves the next invocation.
		const usageProvider = this.ctx.session as {
			cachedUsageReports?: UsageReport[];
			fetchUsageReports?: () => Promise<UsageReport[] | null>;
		};
		const usageReports: UsageReport[] | null = usageProvider.cachedUsageReports ?? null;
		// Warm the snapshot for the next invocation. The fetch logs its own
		// failures, and a missing quota line is non-fatal by design.
		void usageProvider.fetchUsageReports?.().catch(() => {});
		// Resolve the active OAuth identity for each advisor's provider so quota
		// filtering matches the credential actually in use (not sibling accounts).
		const resolveActiveAdvisorAccount = (provider: string, sessionId?: string): OAuthAccountIdentity | undefined =>
			this.ctx.session.modelRegistry.authStorage.oauth.identity(provider, sessionId ?? this.ctx.session.sessionId);
		const nowMs = Date.now();
		// Roster view: show every configured advisor with its status, even when
		// none are live (all paused/no-model). The old code returned a generic
		// message that hid the per-advisor state the user needs to act on.
		if (stats.advisors.length > 1 || (stats.configured && !stats.active)) {
			let info = "";
			for (const a of stats.advisors) {
				const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
				const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
				const color =
					a.status === "running"
						? "success"
						: a.status === "quota_exhausted" || a.status === "error"
							? "error"
							: "dim";
				info += `\n${theme.fg(color, glyph)} ${theme.bold(a.name)} ${theme.fg("dim", `[${label}]`)}\n`;
				if (a.model) {
					info += `${theme.fg("dim", t("commands.controller.model"))} ${a.model.provider}/${a.model.id}\n`;
				}
				if (a.model && usageReports) {
					const identity = resolveActiveAdvisorAccount(a.model.provider, a.sessionId);
					const quota = formatCompactQuota(
						a.model.provider,
						collapseSharedUsageReports(usageReports),
						nowMs,
						(report, limit) => !identity || limitMatchesActiveAccount(report, limit, identity),
					);
					if (quota) info += `${theme.fg("dim", quota)}\n`;
				}
				if (a.status === "running" || a.status === "quota_exhausted") {
					const ctx =
						a.contextWindow > 0
							? `${a.contextTokens.toLocaleString()} / ${a.contextWindow.toLocaleString()} (${Math.round((a.contextTokens / a.contextWindow) * 100)}%)`
							: `${a.contextTokens.toLocaleString()}`;
					info += `${theme.fg("dim", t("commands.controller.contextLabel"))} ${ctx}\n`;
					info += `${theme.fg("dim", t("commands.controller.messagesLabel"))} ${a.messages.total.toLocaleString()}\n`;
					info += t("commands.controller.usageDirection", {
						label: theme.fg("dim", t("commands.controller.spendLabel")),
						input: a.tokens.input.toLocaleString(),
						output: a.tokens.output.toLocaleString(),
					});
					if (a.cost > 0) info += `, $${a.cost.toFixed(4)}`;
					info += "\n";
				}
			}
			if (stats.active) {
				info += `\n${theme.bold(t("commands.controller.totals"))}\n`;
				info += `${theme.fg("dim", t("commands.controller.tokensLabel"))} ${stats.tokens.total.toLocaleString()}\n`;
				if (stats.cost > 0) info += `${theme.fg("dim", t("commands.controller.cost"))} $${stats.cost.toFixed(4)}\n`;
			}
			this.showCommandReport({
				title: t("commands.controller.advisorsStatus", { count: stats.advisors.length }),
				body: new Text(info.trim(), 0, 0),
			});
			return;
		}
		// Single active advisor — detailed view.
		const model = stats.model;
		let info = "";
		if (stats.advisors.length === 1) {
			const a = stats.advisors[0];
			const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
			const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
			info += `${theme.fg(a.status === "running" ? "success" : "error", glyph)} ${a.name} ${theme.fg("dim", `[${label}]`)}\n\n`;
		}
		if (model) {
			info += `${theme.bold(t("commands.controller.provider"))}\n`;
			info += `${theme.fg("dim", t("commands.controller.model"))} ${model.provider}/${model.id}\n`;
		}
		if (model && usageReports) {
			const identity = resolveActiveAdvisorAccount(model.provider, stats.advisors[0]?.sessionId);
			const quota = formatCompactQuota(
				model.provider,
				collapseSharedUsageReports(usageReports),
				nowMs,
				(report, limit) => !identity || limitMatchesActiveAccount(report, limit, identity),
			);
			if (quota) {
				info += `\n${theme.bold(t("commands.controller.quota"))}\n`;
				info += `${theme.fg("dim", quota)}\n`;
			}
		}
		info += `\n${theme.bold(t("commands.controller.messages"))}\n`;
		info += `${theme.fg("dim", t("commands.controller.user"))} ${stats.messages.user.toLocaleString()}\n`;
		info += `${theme.fg("dim", t("commands.controller.assistant"))} ${stats.messages.assistant.toLocaleString()}\n`;
		info += `${theme.fg("dim", t("commands.controller.total"))} ${stats.messages.total.toLocaleString()}\n`;
		info += `\n${theme.bold(t("commands.controller.context"))}\n`;
		if (stats.contextWindow > 0) {
			const percent = Math.round((stats.contextTokens / stats.contextWindow) * 100);
			info += `${theme.fg("dim", t("commands.controller.tokensLabel"))} ${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${percent}%)\n`;
		} else {
			info += `${theme.fg("dim", t("commands.controller.tokensLabel"))} ${stats.contextTokens.toLocaleString()}\n`;
		}
		info += `\n${theme.bold(t("commands.controller.spend"))}\n`;
		info += `${theme.fg("dim", t("commands.controller.input"))} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", t("commands.controller.output"))} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", t("commands.controller.cacheRead"))} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.cost > 0) info += `${theme.fg("dim", t("commands.controller.cost"))} $${stats.cost.toFixed(4)}\n`;
		this.showCommandReport({ title: t("commands.controller.advisorStatus"), body: new Text(info.trim(), 0, 0) });
	}

	/**
	 * `/jobs`: natively the live jobs sheet the jobs pill opens (inspect and
	 * cancel included); `/jobs full`, and text mode, a report of the running
	 * and recent jobs (see {@link showCommandReport}). Both list the viewed
	 * session's jobs and its subagents' as a tree (see {@link buildJobTree}).
	 */
	async handleJobsCommand(options?: { full?: boolean }): Promise<void> {
		const full = options?.full === true;
		if (full) this.ctx.viewSession.requestJobCaptions();
		const tree = this.ctx.viewSession.getAsyncJobTree();
		if (!tree) {
			this.ctx.showWarning(t("commands.session.jobsUnavailable"));
			return;
		}
		if (isNativeRendering() && !full) {
			this.ctx.showJobsSheet();
			return;
		}

		const now = Date.now();
		const columns = this.ctx.ui.terminal.columns ?? 100;
		let info = `${theme.fg("dim", t("commands.controller.running"))} ${tree.running.length}\n`;
		if (tree.running.length === 0 && tree.recent.length === 0) {
			info += `\n${theme.fg("dim", t("commands.controller.noJobsYet"))}`;
			this.showCommandReport({ title: t("commands.session.jobsTitle"), body: new Text(info, 0, 0) });
			return;
		}

		// Lines under a row hang off its tree rails. Full mode wraps here so
		// every line, including heredoc lines and wrap continuations, keeps that
		// indent inside the report box.
		info += "\n";
		for (const row of buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId)) {
			const guide = theme.fg("dim", jobTreeGuide(row, theme));
			if (row.kind === "agent") {
				info += `${guide}${theme.bold(row.agent.id)}\n`;
				continue;
			}
			const { job } = row;
			// A spawned subagent's task job takes the agent's id as its id and label: name it once.
			const agent = row.agent && row.agent.id !== job.id ? ` ${theme.bold(row.agent.id)}` : "";
			info += `${guide}${renderJobLine(job, now)}${agent}\n`;
			// What the job is for leads; full mode follows it with what the command does and the whole command.
			const text = full ? (job.command ?? job.label) : (job.intent ?? job.label);
			if (text === job.id) continue;
			const indent = jobTreeIndent(row, theme);
			const prefix = theme.fg("dim", indent);
			if (!full) {
				const label = truncateJobLabel(text, Math.max(24, columns - 22 - visibleWidth(indent)));
				info += `${prefix}${theme.fg("dim", label)}\n`;
				continue;
			}
			for (const line of wrapTextWithAnsi(
				shortenEmbeddedPaths(replaceTabs(sanitizeText([job.intent, job.caption, text].filter(Boolean).join("\n")))),
				Math.max(1, columns - 4 - visibleWidth(indent)),
			)) {
				info += `${prefix}${theme.fg("dim", line)}\n`;
			}
		}

		this.showCommandReport({ title: t("commands.session.jobsTitle"), body: new Text(info.trimEnd(), 0, 0) });
	}

	async handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? null;
		if (!usageReports) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (!provider.fetchUsageReports) {
				this.ctx.showWarning(t("commands.controller.usageNotConfigured"));
				return;
			}
			try {
				usageReports = await provider.fetchUsageReports();
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.usageFetchFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}

		this.ctx.showUsageDashboard(usageReports ?? []);
	}

	async handleChangelogCommand(args = ""): Promise<void> {
		const view = parseChangelogView(args);
		if ("error" in view) {
			this.ctx.showWarning(view.error);
			return;
		}
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const entriesToShow = selectChangelogEntries(allEntries, view);
		const changelogMarkdown =
			entriesToShow.length > 0
				? renderChangelogEntries(entriesToShow).markdown
				: t("commands.session.changelogEmpty");
		const shown = entriesToShow.length;
		const titleCount = shown > 0 ? shown : view.kind === "last" ? view.count : shown;
		const title =
			view.kind === "full"
				? t("commands.controller.fullChangelog")
				: view.kind === "last"
					? titleCount === 1
						? t("commands.controller.lastRelease")
						: t("commands.controller.lastReleases", { count: titleCount })
					: t("commands.controller.recentChanges");
		const hint =
			view.kind === "full"
				? ""
				: t("commands.controller.changelogFullHint", {
						use: theme.fg("dim", t("commands.controller.use")),
						command: theme.bold("/changelog full"),
						purpose: theme.fg("dim", t("commands.controller.fullChangelogPurpose")),
					});

		this.#showMarkdownPanel(title, changelogMarkdown + hint);
	}

	handleHotkeysCommand(): void {
		const bindings = { keybindings: this.ctx.keybindings };
		if (isNativeRendering()) {
			const menu = this.ctx.openMenu("hotkeys", () => this.handleHotkeysCommand());
			if (!menu) return;
			let handle: OverlayHandle | undefined;
			// A native terminal gets a dismissable sheet with keycaps instead of a markdown table.
			const sheet = new HotkeysSheetComponent(
				bindings,
				() => {
					if (!menu.close()) return;
					handle?.hide();
					this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
					this.ctx.ui.requestRender();
				},
				() => this.ctx.ui.terminal.rows,
			);
			menu.mount(sheet, () => {
				handle = this.ctx.ui.showOverlay(sheet, { anchor: "center", width: "90%", maxHeight: "90%" });
				this.ctx.ui.setFocus(sheet);
				return handle;
			});
			this.ctx.ui.requestRender();
			return;
		}
		this.#showMarkdownPanel(t("commands.controller.shortcuts"), buildHotkeysMarkdown(bindings));
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({
			tools: this.ctx.session.agent.state.tools,
			xdevTools: this.ctx.session.getXdevToolEntries(),
		});
		this.#showMarkdownPanel(t("commands.controller.availableTools"), tools);
	}

	handleToolCatalogCommand(name?: string): void {
		this.#showMarkdownPanel(
			name ? t("commands.controller.tool", { name }) : t("commands.controller.enabledTools"),
			this.ctx.session.getToolCatalogDocs(name),
		);
	}

	handleContextCommand(): void {
		const session = this.ctx.session;
		if (!session.model) {
			this.ctx.showWarning(t("commands.contextReport.noModel"));
			return;
		}
		// Validate capacity before tokenizing the whole history into a snapshot.
		const breakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true });
		if (!(breakdown.contextWindow > 0) || !Number.isFinite(breakdown.contextWindow)) {
			this.ctx.showWarning(t("commands.controller.contextInvalid"));
			return;
		}
		const data = buildSessionContextView(session, breakdown);
		this.#clearReport();
		this.#closeReportSheet();
		const viewer = new ContextViewer(data, {
			onClose: () => this.#closeReportSheet(),
			requestRender: () => this.ctx.ui.requestRender(),
			getRows: () => this.ctx.ui.terminal.rows,
		});
		this.#showFullscreenSheet(viewer);
		this.ctx.ui.requestRender();
	}

	async handleMemoryCommand(text: string): Promise<void> {
		const argumentText = text.slice(7).trim();
		const action = argumentText.split(/\s+/, 1)[0]?.toLowerCase() || "view";
		const agentDir = this.ctx.settings.getAgentDir();
		const backend = await resolveMemoryBackend(this.ctx.settings);

		if (action === "view") {
			const payload = await backend.buildDeveloperInstructions(
				agentDir,
				this.ctx.sessionManager.getCwd(),
				this.ctx.settings,
				this.ctx.session,
			);
			if (!payload) {
				this.ctx.showWarning(t("commands.controller.memoryEmpty"));
				return;
			}
			this.#showMarkdownPanel(t("commands.controller.memoryPayload"), payload);
			return;
		}

		if (action === "reset" || action === "clear") {
			try {
				await backend.clear(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				await this.ctx.session.refreshBaseSystemPrompt();
				this.ctx.showStatus(t("commands.controller.memoryCleared"));
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.memoryClearFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (action === "enqueue" || action === "rebuild") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus(t("commands.lifecycle.memoryEnqueued"));
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.memoryEnqueueFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}
		if (action === "queue") {
			try {
				const payload = await backend.queuePreview?.({
					agentDir,
					cwd: this.ctx.sessionManager.getCwd(),
					session: this.ctx.session,
				});
				if (!payload) {
					this.ctx.showWarning(t("commands.lifecycle.memoryQueueUnavailable", { backend: backend.id }));
					return;
				}
				this.#showMarkdownPanel(t("commands.controller.memoryQueue"), payload);
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.memoryQueueFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (action === "sync") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus(t("commands.lifecycle.memoryConsolidated"));
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.memorySyncFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (action === "stats" || action === "diagnose") {
			const hook = action === "stats" ? backend.stats : backend.diagnose;
			try {
				const payload = await hook?.(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				if (!payload) {
					this.ctx.showWarning(memoryStatsUnavailableMessage(backend.id, action));
					return;
				}
				this.#showMarkdownPanel(
					t("commands.controller.memoryReport", {
						report:
							action === "stats"
								? t("commands.controller.memoryStats")
								: t("commands.controller.memoryDiagnostics"),
					}),
					payload,
				);
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.memoryActionFailed", {
						action,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			return;
		}

		if (action === "mm") {
			await this.#handleMentalModelsSubcommand(argumentText);
			return;
		}

		this.ctx.showError(t("commands.controller.memoryUsage"));
	}

	async #handleMentalModelsSubcommand(argumentText: string): Promise<void> {
		// Parse: "mm <verb> [arg]"
		const parts = argumentText.split(/\s+/).slice(1);
		const verb = parts[0]?.toLowerCase() ?? "list";
		const arg = parts[1];

		const state = this.ctx.session.getHindsightSessionState();
		const primary = state && !state.aliasOf ? state : undefined;
		if (!primary) {
			this.ctx.showError(t("commands.controller.hindsightInactive"));
			return;
		}
		if (!primary.config.mentalModelsEnabled) {
			this.ctx.showError(t("commands.controller.mentalModelsDisabled"));
			return;
		}

		switch (verb) {
			case "list":
				await this.#mmList(primary);
				return;
			case "show":
				if (!arg) return this.ctx.showError(t("commands.controller.mmShowUsage"));
				await this.#mmShow(primary, arg);
				return;
			case "refresh":
				await this.#mmRefresh(primary, arg);
				return;
			case "history":
				if (!arg) return this.ctx.showError(t("commands.controller.mmHistoryUsage"));
				await this.#mmHistory(primary, arg);
				return;
			case "seed":
				await this.#mmSeed(primary);
				return;
			case "reload":
				await this.#mmReload(primary);
				return;
			case "delete":
			case "remove":
				if (!arg) return this.ctx.showError(t("commands.controller.mmDeleteUsage"));
				await this.#mmDelete(primary, arg);
				return;
			default:
				this.ctx.showError(t("commands.controller.mmUsage"));
		}
	}

	async #mmList(state: HindsightSessionState): Promise<void> {
		const client: HindsightClientApi = state.client;
		try {
			const response = await client.listMentalModels(state.bankId, { detail: "metadata" });
			const items = response.items ?? [];
			if (items.length === 0) {
				this.ctx.showStatus(t("commands.controller.noMentalModels", { bank: state.bankId }));
				return;
			}
			const lines = items
				.slice()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(summarizeMentalModel);
			this.#showMarkdownPanel(t("commands.controller.mentalModels", { bank: state.bankId }), lines.join("\n"));
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.mmListFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #mmShow(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const model = await state.client.getMentalModel(state.bankId, id, { detail: "content" });
			if (!model) {
				this.ctx.showError(t("commands.controller.mentalModelMissing", { id }));
				return;
			}
			const tags = model.tags && model.tags.length > 0 ? `\n_tags: ${model.tags.join(", ")}_` : "";
			const refreshed = model.last_refreshed_at
				? t("commands.controller.refreshedAt", { time: model.last_refreshed_at })
				: "";
			const sourceQuery = model.source_query
				? t("commands.controller.sourceQuery", { query: model.source_query })
				: "";
			const content = (model.content ?? t("commands.controller.mentalModelEmpty")).trim();
			this.#showMarkdownPanel(model.name, `**id:** \`${model.id}\`${tags}${refreshed}${sourceQuery}\n\n${content}`);
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.mmShowFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #mmRefresh(state: HindsightSessionState, id: string | undefined): Promise<void> {
		try {
			if (id) {
				// Single-model refresh is explicit operator intent: bypass the
				// auto-refresh filter so curated/manual models can still be
				// refreshed on demand.
				await state.client.refreshMentalModel(state.bankId, id);
				this.ctx.showStatus(t("commands.controller.refreshQueued", { id }));
			} else {
				// Bulk refresh: only touch models that opted into automatic
				// refresh via `trigger.refresh_after_consolidation`. Curated
				// models are reviewed before publishing and must not be
				// silently regenerated by a bank-wide refresh sweep. Reading
				// `detail: "content"` here is required because the trigger
				// field is excluded from `detail: "metadata"`.
				const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
				const items = list.items ?? [];
				if (items.length === 0) {
					this.ctx.showStatus(t("commands.controller.noMentalModels", { bank: state.bankId }));
					return;
				}
				const targets = items.filter(m => m.trigger?.refresh_after_consolidation === true);
				const skipped = items.length - targets.length;
				if (targets.length === 0) {
					this.ctx.showStatus(t("commands.controller.noAutoRefresh", { count: skipped }));
					return;
				}
				let queued = 0;
				for (const item of targets) {
					try {
						await state.client.refreshMentalModel(state.bankId, item.id);
						queued++;
					} catch (error) {
						this.ctx.showWarning(
							t("commands.controller.refreshFailed", {
								id: item.id,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					}
				}
				const skippedSuffix = skipped > 0 ? t("commands.controller.refreshSkipped", { count: skipped }) : "";
				this.ctx.showStatus(
					t("commands.controller.autoRefreshQueued", { queued, total: targets.length, skipped: skippedSuffix }),
				);
			}
			// Reload the cache after a brief grace so the new content (if the refresh
			// completes synchronously on the server) flows into the system prompt.
			await Bun.sleep(500);
			await reloadMentalModelsForSession(state.session);
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.mmRefreshFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #mmHistory(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const [model, history] = await Promise.all([
				state.client.getMentalModel(state.bankId, id, { detail: "content" }),
				state.client.getMentalModelHistory(state.bankId, id),
			]);
			if (!model) {
				this.ctx.showError(t("commands.controller.mentalModelMissing", { id }));
				return;
			}
			if (history.length === 0) {
				this.ctx.showStatus(t("commands.controller.noHistory", { id }));
				return;
			}
			// History is most-recent first. Each entry stores the content BEFORE that
			// change. To diff "what changed at entry N", compare entry N's
			// previous_content (= state before that change) with entry N-1's
			// previous_content (= state after that change, which was state before
			// the next change). For the most recent change, compare against the
			// model's CURRENT content.
			const sections: string[] = [];
			for (let i = 0; i < history.length; i++) {
				const before = history[i].previous_content ?? "";
				const after = i === 0 ? (model.content ?? "") : (history[i - 1].previous_content ?? "");
				const diff = diffMentalModelContent(before, after);
				sections.push(`### ${history[i].changed_at}\n\n\`\`\`diff\n${diff}\n\`\`\``);
			}
			this.#showMarkdownPanel(t("commands.controller.history", { name: model.name }), sections.join("\n\n"));
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.mmHistoryFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #mmSeed(state: HindsightSessionState): Promise<void> {
		try {
			const config = loadHindsightConfig(this.ctx.settings);
			const seeds = resolveSeedsForScope(
				{
					bankId: state.bankId,
					retainTags: state.retainTags,
					recallTags: state.recallTags,
					recallTagsMatch: state.recallTagsMatch,
				},
				config.scoping,
			);
			if (seeds.length === 0) {
				this.ctx.showStatus(t("commands.controller.noSeeds", { scope: String(config.scoping) }));
				return;
			}
			const list = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
			const existing = list.items ?? [];
			let created = 0;
			let skipped = 0;
			for (const seed of seeds) {
				if (seedAlreadyExists(seed, existing)) {
					skipped++;
					continue;
				}
				try {
					await state.client.createMentalModel(state.bankId, seed.name, seed.sourceQuery, {
						id: seed.id,
						tags: seed.tags.length > 0 ? seed.tags : undefined,
						maxTokens: seed.maxTokens,
						trigger: seed.trigger,
					});
					created++;
				} catch (error) {
					this.ctx.showWarning(
						t("commands.controller.seedFailed", {
							id: seed.id,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			}
			this.ctx.showStatus(t("commands.controller.seeded", { created, existing: skipped }));
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.mmSeedFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #mmReload(state: HindsightSessionState): Promise<void> {
		const ok = await reloadMentalModelsForSession(state.session);
		if (ok) {
			this.ctx.showStatus(t("commands.controller.mentalModelCacheReloaded"));
		} else {
			this.ctx.showError(t("commands.controller.mentalModelCacheFailed"));
		}
	}

	async #mmDelete(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const removed = await state.client.deleteMentalModel(state.bankId, id);
			if (!removed) {
				this.ctx.showError(t("commands.controller.mentalModelMissing", { id }));
				return;
			}
			// Drop the cached snippet so the closing tag does not silently keep
			// stale content in the system prompt until the next agent_end TTL.
			await reloadMentalModelsForSession(state.session);
			this.ctx.showStatus(t("commands.controller.mentalModelDeleted", { id, bank: state.bankId }));
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.mmDeleteFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}

	async #runNewSessionFlow(
		options?: NewSessionOptions,
		label: string = t("commands.controller.sessionStarted"),
	): Promise<void> {
		this.ctx.clearTransientSessionUi();

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		// A focused subagent view keeps its own history: return to the main session
		// first so the transcript below cannot rebuild from the subagent's surviving
		// conversation, then drop any turn-scoped anchors (coalescing timers,
		// in-flight dispatches) the session boundary orphaned.
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		this.ctx.eventController.resetTranscriptAnchors();
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		this.ctx.present([new Spacer(1), new Text(`${theme.fg("accent", `${theme.status.success} ${label}`)}`, 1, 1)]);
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning(t("commands.lifecycle.freshWait"));
			return;
		}
		const stateLabel =
			result.closedProviderSessions === 1
				? t("commands.lifecycle.providerState")
				: t("commands.lifecycle.providerStates");
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(
			t("commands.lifecycle.freshStarted", { count: result.closedProviderSessions, state: stateLabel }),
		);
	}

	async handleResetContextCommand(): Promise<void> {
		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		const result = await this.ctx.session.resetSessionContext();
		if (!result) {
			this.ctx.showWarning(t("commands.controller.resetWait"));
			return;
		}
		// Drop the rendered transcript so the UI matches the now-empty model
		// context (mirrors #runNewSessionFlow's teardown, minus the new session —
		// the session id, title, and transcript file all survive).
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		const noun =
			result.droppedCount === 1 ? t("commands.controller.resetMessage") : t("commands.controller.resetMessages");
		this.ctx.present([
			new Spacer(1),
			new Text(
				`${theme.fg("accent", t("commands.controller.contextReset", { success: theme.status.success, count: result.droppedCount, items: noun }))}`,
				1,
				1,
			),
		]);
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleDeleteCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError(t("commands.controller.noSessionToDelete"));
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, t("commands.controller.sessionDeleted"));
	}

	async handleForkCommand(placement?: "pane" | "window"): Promise<void> {
		if (placement !== undefined) {
			await this.#handleForkTerminalCommand(placement);
			return;
		}

		// A Tern pane fork leaves this session untouched, so it may run mid-turn.
		if (await this.#forkIntoTernPane()) return;

		// An in-place fork moves this process onto the new file; a running turn
		// would finish there and leave the original transcript cut mid-turn.
		if (this.ctx.session.isStreaming) await this.ctx.session.abort();
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		// After a `/fork`, the current session ID is changed to the forked one,
		// so the session ID before the fork is the one we want to show in the hint.
		const previousSessionId = this.ctx.sessionManager.isSessionOnDisk()
			? this.ctx.sessionManager.getSessionId()
			: undefined;

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError(t("commands.controller.forkFailed"));
			return;
		}

		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();

		this.ctx.present([
			new Spacer(1),
			new Text(
				theme.fg(
					"accent",
					previousSessionId
						? t("commands.controller.sessionForkedResume", {
								success: theme.status.success,
								resume: resumeCommand(previousSessionId),
								id: previousSessionId,
							})
						: t("commands.controller.sessionForked", { success: theme.status.success }),
				),
				1,
				1,
			),
		]);
	}

	async #handleForkTerminalCommand(placement: "pane" | "window"): Promise<void> {
		const dependencies = this.#forkTerminalDependencies;
		const environment = dependencies.environment();
		const multiplexer = dependencies.classifyTerminalMultiplexer(environment);
		const placementInfo = getTerminalLaunchPlacement(multiplexer, placement);
		if ("error" in placementInfo) {
			this.ctx.showError(placementInfo.error);
			return;
		}

		if (this.ctx.session.isStreaming) {
			const confirmed = await this.ctx.showHookConfirm(
				t("commands.controller.confirmForkStreaming"),
				t("commands.controller.forkPartialResponse"),
			);
			if (!confirmed) return;
		}

		const initialSessionFile = this.ctx.sessionManager.getSessionFile();
		if (!initialSessionFile) {
			this.ctx.showError(t("commands.controller.forkNotPersisted"));
			return;
		}

		const childArgs = restartArgv(dependencies.argv(), undefined, FORK_LAUNCH_OVERRIDES);
		if (hasForkApiKeyOverride(childArgs)) {
			this.ctx.showError(t("commands.controller.forkApiKey"));
			return;
		}
		const shellGrammar = placementInfo.shellGrammar;
		if (shellGrammar === "posix") {
			const confirmed = await this.ctx.showHookConfirm(
				t("commands.controller.confirmDestinationShell"),
				t("commands.controller.forkPosixShell"),
			);
			if (!confirmed) {
				this.ctx.showWarning(t("commands.controller.forkPosixCancelled"));
				return;
			}
		}

		try {
			await this.ctx.sessionManager.flush();
		} catch (error) {
			logger.error("Failed to flush the session before opening a terminal fork", { error });
			this.ctx.showError(t("commands.controller.forkSaveFailed"));
			return;
		}

		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError(t("commands.controller.forkNoLongerPersisted"));
			return;
		}
		const sourceSessionFile = path.resolve(sessionFile);
		try {
			await fs.access(sourceSessionFile);
		} catch {
			this.ctx.showError(t("commands.controller.forkTranscriptUnavailable"));
			return;
		}

		try {
			const activeProfile = dependencies.getActiveProfile();
			const activeModel = this.ctx.session.model;
			if (activeProfile) childArgs.push("--profile", activeProfile);
			if (activeModel) childArgs.push("--model", `${activeModel.provider}/${activeModel.id}`);
			const activeThinkingLevel = this.ctx.session.configuredThinkingLevel();
			if (activeThinkingLevel !== undefined) childArgs.push("--thinking", activeThinkingLevel);
			// Forcing --model/--thinking marks the fork's cache shape as changed, which would
			// drop the inherited key. Automatic candidates travel in the source header;
			// forwarding them as --prompt-cache-key would bypass their model gate.
			if (
				this.ctx.session.agent.promptCacheKey !== undefined ||
				this.ctx.sessionManager.getHeader()?.taskPromptCacheKey === undefined
			) {
				childArgs.push("--prompt-cache-key", this.ctx.session.agent.promptCacheKey ?? this.ctx.session.sessionId);
			}
			childArgs.push("--fork", sourceSessionFile);
			// Pin only non-secret scope variables.
			const command = [
				...scopeEnvCommand({
					PI_CODING_AGENT_DIR: this.ctx.settings.getAgentDir(),
					PI_CONFIG_DIR: getConfigDirName(),
					OMP_PROFILE: activeProfile,
					PI_PROFILE: activeProfile,
					PI_CONFIG_FILES: this.ctx.settings.getConfigFiles().join(path.delimiter),
					PI_CODING_AGENT_SESSION_DIR: environment.PI_CODING_AGENT_SESSION_DIR,
					XDG_DATA_HOME: environment.XDG_DATA_HOME,
					XDG_STATE_HOME: environment.XDG_STATE_HOME,
					XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
				}),
				...dependencies.resolveCliEntryCmd(),
				...childArgs,
			];
			const launchPlan = createDefaultTerminalLaunchRequest(
				multiplexer,
				placement,
				command,
				this.ctx.sessionManager.getCwd(),
				shellGrammar,
			);
			if ("error" in launchPlan) {
				this.ctx.showError(launchPlan.error);
				return;
			}

			const result = await dependencies.launchTerminal(launchPlan.request);
			if (result.warning) {
				this.ctx.showWarning(
					t("commands.controller.openedForkWithWarning", {
						terminal: placementInfo.displayName,
						warning: result.warning,
					}),
				);
				return;
			}
			this.ctx.showStatus(
				t("commands.controller.openedFork", {
					terminal: placementInfo.displayName,
					placement: placementInfo.placementLabel,
				}),
			);
		} catch (error) {
			logger.error("Failed to open a terminal fork", { multiplexer, error });
			this.ctx.showError(
				error instanceof TerminalLaunchError
					? t("commands.controller.forkTerminalFailed", {
							terminal: placementInfo.displayName,
							error: error.message,
						})
					: t("commands.controller.forkTerminalLogs", { terminal: placementInfo.displayName }),
			);
		}
	}

	/**
	 * `/fork` inside a Tern pane: ask Tern to run `omp --fork` of this session in a new pane beside
	 * this one, which keeps the original session. False means fork in place instead: outside Tern,
	 * an unsaved session, a Tern without `fork`, or Tern refusing it. Once the request is out, an
	 * unconfirmed one is reported rather than retried in place, since Tern may still open the pane.
	 */
	async #forkIntoTernPane(): Promise<boolean> {
		const tern = resolveTernPane();
		if (!tern || !this.ctx.sessionManager.isSessionOnDisk()) return false;
		const client = new TernSocketClient({ socketPath: tern.socketPath });
		try {
			try {
				await client.connect();
			} catch (error) {
				logger.debug("Tern unreachable for /fork; forking in place", {
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (!client.supports("fork")) return false;
			// The new pane's omp reads the session file as it starts.
			await this.ctx.session.flushToDisk();
			try {
				await client.fork({ block: tern.pane }, { timeoutMs: TERN_FORK_TIMEOUT_MS });
			} catch (error) {
				if (error instanceof TernError && !TERN_FORK_UNCONFIRMED[error.kind]) {
					const details = { kind: error.kind, error: error.message };
					if (error.kind === "failed") logger.warn("Tern could not open the fork pane; forking in place", details);
					else logger.debug("Tern refused the fork; forking in place", details);
					return false;
				}
				this.ctx.showError(
					t("commands.controller.ternUnconfirmed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				return true;
			}
		} finally {
			client.close();
		}
		const note = this.ctx.session.isStreaming ? t("commands.controller.forkContinuesHere") : "";
		this.ctx.present([
			new Spacer(1),
			new Text(
				theme.fg("accent", t("commands.controller.paneForked", { success: theme.status.success, note })),
				1,
				1,
			),
		]);
		return true;
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning(t("commands.controller.moveWait"));
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.ctx.showHookCustom<MoveOverlayResult | undefined>(
				(_tui, _theme, _keybindings, done) =>
					new MoveOverlay(this.ctx.sessionManager.getCwd(), done, moveDirectorySource),
				{ overlay: true },
			);
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError(t("commands.lifecycle.moveUsage"));
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		// If the directory doesn't exist, offer to create it.
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}

		if (!isDirectory) {
			const parentDir = path.dirname(resolvedPath);
			let parentExists = false;
			try {
				parentExists = (await fs.stat(parentDir)).isDirectory();
			} catch {
				parentExists = false;
			}
			if (!parentExists) {
				this.ctx.showError(t("commands.controller.missingParentDirectory", { name: path.basename(resolvedPath) }));
				return;
			}
		}
		const moved = await this.#withSessionMove(async () => {
			if (!isDirectory) {
				const confirmed = await this.ctx.showHookConfirm(
					t("commands.controller.confirmCreateDirectory"),
					t("commands.controller.promptCreateDirectory", { name: path.basename(resolvedPath) }),
				);
				if (!confirmed) return false;
				try {
					await fs.mkdir(resolvedPath, { recursive: true });
				} catch (err) {
					this.ctx.showError(
						t("commands.controller.createDirectoryFailed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
					return false;
				}
			}
			return this.#relocateSession(resolvedPath);
		});
		if (moved) {
			this.ctx.present([
				new Spacer(1),
				new Text(
					`${theme.fg("accent", t("commands.controller.moved", { success: theme.status.success, path: resolvedPath }))}`,
					1,
					1,
				),
			]);
		}
	}

	/**
	 * `/wt [<branch>]` — fork the checkout into a new worktree (an ovnfs
	 * checkout when ovnfs is found, else a linked git worktree) on
	 * `branch` (default `wt/<timestamp>`), carrying uncommitted changes along
	 * unless `keepChanges` is false, then relocate the session there like `/move`.
	 * Returns the worktree only when the session now lives in it.
	 */
	async handleWorktreeCommand(
		branch?: string,
		options: { keepChanges?: boolean } = {},
	): Promise<SessionWorktree | undefined> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning(t("commands.controller.worktreeWait"));
			return undefined;
		}
		let created: SessionWorktree | undefined;
		await this.#withSessionMove(async () => {
			const branchName = branch?.trim() || defaultSessionWorktreeBranch();
			const cwd = this.ctx.sessionManager.getCwd();
			this.ctx.statusContainer.disposeChildren();
			const loader = new Loader(
				this.ctx.ui,
				spinner => theme.fg("accent", spinner),
				text => theme.fg("muted", text),
				t("commands.controller.creatingWorktree", { branch: branchName }),
				getSymbolTheme().spinnerFrames,
			);
			this.ctx.statusContainer.addChild(loader);
			this.ctx.ui.requestRender();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(cwd, this.ctx.settings, branchName, options);
			} catch (err) {
				this.ctx.showError(
					t("commands.lifecycle.worktreeFailed", { error: err instanceof Error ? err.message : String(err) }),
				);
				return false;
			} finally {
				loader.stop();
				this.ctx.statusContainer.disposeChildren();
			}
			if (worktree.cloneError) {
				logger.warn("worktree clone fell back to plain checkout", {
					path: worktree.path,
					error: worktree.cloneError,
				});
			}
			if (!(await this.#relocateSession(worktree.path))) return false;
			created = worktree;
			const cleanup = worktree.keptChanges
				? await cleanSourceCheckoutIfConfigured(cwd, this.ctx.settings)
				: { cleaned: false, errorMessage: undefined };
			if (cleanup.errorMessage !== undefined) {
				this.ctx.showWarning(t("commands.controller.worktreeCleanupFailed", { error: cleanup.errorMessage }));
			}
			this.ctx.present([
				new Spacer(1),
				new Text(
					`${theme.fg("accent", `${theme.status.success} ${formatSessionWorktreeSummary(worktree, cleanup.cleaned)}`)}`,
					1,
					1,
				),
			]);
			return true;
		});
		return created;
	}

	/** Save source settings before acquiring the gate for a complete relocation operation. */
	async #withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		try {
			await this.ctx.settings.flush();
		} catch (err) {
			this.ctx.showError(
				t("commands.lifecycle.settingsSaveFailed", { error: err instanceof Error ? err.message : String(err) }),
			);
			return false;
		}

		return this.ctx.withBtwSessionMove(operation);
	}

	/** Relocate only while #withSessionMove holds the BTW gate; false means no successful move. */
	async #relocateSession(resolvedPath: string): Promise<boolean> {
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		const previousState = this.ctx.sessionManager.captureState();
		try {
			await this.ctx.session.moveSession(resolvedPath);
		} catch (err) {
			this.ctx.showError(
				t("commands.lifecycle.moveFailed", { error: err instanceof Error ? err.message : String(err) }),
			);
			return false;
		}
		let applied = false;
		try {
			applied = await this.ctx.applyCwdChange(resolvedPath);
		} catch (error) {
			await this.#restoreAfterMoveFailure(previousState, error);
			return false;
		}
		if (!applied) {
			await this.#restoreAfterMoveFailure(previousState);
			return false;
		}

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleRenameCommand(title: string): Promise<void> {
		const session = this.ctx.session;
		const sessionManager = this.ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const signal = session.titleGenerationSignal;
		let titleRevision = sessionManager.titleRevision;
		const isCurrent = () =>
			this.ctx.session === session &&
			this.ctx.sessionManager === sessionManager &&
			!signal.aborted &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.titleRevision === titleRevision;
		try {
			const persistence = sessionManager.setSessionName(title, "user");
			titleRevision = sessionManager.titleRevision;
			const stored = await persistence;
			if (!isCurrent()) return;
			if (!stored) {
				this.ctx.showError(t("commands.controller.emptySessionName"));
				return;
			}
			const name = sessionManager.getSessionName()!;
			this.ctx.showStatus(t("commands.controller.renamed", { name }));
		} catch (err) {
			if (!isCurrent()) return;
			this.ctx.showError(
				t("commands.lifecycle.renameFailed", { error: err instanceof Error ? err.message : String(err) }),
			);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		const shouldPersistCwd = isPersistentShellCdCommand(command);
		if (isDeferred && shouldPersistCwd) {
			this.ctx.showWarning(t("commands.controller.directoryChangeWait"));
			return;
		}

		if (shouldPersistCwd) {
			await this.#withSessionMove(() => this.#executeBashCommand(command, excludeFromContext, isDeferred, true));
		} else {
			await this.#executeBashCommand(command, excludeFromContext, isDeferred, false);
		}
	}

	/** Returns whether shell execution committed a cwd relocation, not whether the shell command succeeded. */
	async #executeBashCommand(
		command: string,
		excludeFromContext: boolean,
		isDeferred: boolean,
		shouldPersistCwd: boolean,
	): Promise<boolean> {
		const component = new BashExecutionComponent(command, this.ctx.ui, excludeFromContext);
		this.ctx.bashComponent = component;
		// Provisional until the session records the run.
		const block = new PresentedBlock(
			component,
			messageBlock({
				role: "bashExecution",
				command,
				output: "",
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
				excludeFromContext,
			}),
		);
		block.setExpanded(this.ctx.toolOutputExpanded);
		let detachInput: (() => void) | undefined;
		let finished = false;

		if (isDeferred) {
			this.ctx.pendingShellContainer.addChild(block);
			this.ctx.pendingBashComponents.push(block);
		} else {
			this.ctx.present(block);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executeBash(
				command,
				chunk => {
					if (this.ctx.bashComponent) {
						this.ctx.bashComponent.appendOutput(chunk);
					}
				},
				{
					excludeFromContext,
					onRecorded: message => block.setBlock(messageBlock(message)),
					useUserShell: true,
					// User-shell zsh/fish `!` commands run on a headless PTY; raw
					// bytes render through the component's vterm replay (color-safe).
					pty: {
						...bashPtyViewport(this.ctx.ui),
						onChunk: chunk => this.ctx.bashComponent?.appendPtyChunk(chunk),
						onStdin: write => {
							if (finished) return;
							// A TSP field without a mode handles printable keys itself and sends
							// `edit` packets instead of raw input. Label it while the PTY owns
							// the keyboard so Tern delivers those keys to the input listener.
							detachInput = this.#forwardKeysToPty(component, write);
							this.ctx.editor.nativeKeyPassthrough = true;
							this.ctx.ui.requestRender();
						},
					},
				},
			);
			if (this.ctx.bashComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.bashComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
					artifactError: meta?.artifactError,
					minimized: result.minimized,
					images: result.images,
					showImages: cfgTerminalShowImages.get(this.ctx.settings),
				});
			}
			try {
				if (shouldPersistCwd) return await this.#applyBashResultCwd(result);
			} catch (error) {
				this.ctx.showError(
					t("commands.controller.bashCwdFailed", {
						product: PRODUCT_NAME,
						error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
					}),
				);
			}
		} catch (error) {
			if (this.ctx.bashComponent) {
				this.ctx.bashComponent.setComplete(undefined, false);
			}
			this.ctx.showError(
				t("commands.controller.bashFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		} finally {
			finished = true;
			detachInput?.();
			if (detachInput) this.ctx.editor.nativeKeyPassthrough = false;
			this.ctx.bashComponent = undefined;
			this.ctx.ui.requestRender();
		}
		return false;
	}

	/**
	 * Routes composer keystrokes to a running `!` command's PTY so it can answer
	 * its own prompts (`read`, shell-startup questions), like a foreground job.
	 * The interrupt key still cancels; focused dialogs and mouse reports keep
	 * their input. Returns the detach function.
	 */
	#forwardKeysToPty(component: BashExecutionComponent, write: (data: string) => void): () => void {
		return this.ctx.ui.addInputListener(
			data => {
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (
					this.ctx.keybindings.matches(data, "app.interrupt") ||
					this.ctx.keybindings.matches(data, "app.navigation.dismiss") ||
					this.ctx.keybindings.matches(data, "app.agent.menu") ||
					parseSgrMouse(data)
				)
					return undefined;
				const bytes = component.encodePtyInput(data);
				if (bytes) write(bytes);
				return { consume: true };
			},
			{ prepend: true },
		);
	}

	async #applyBashResultCwd(result: BashResult): Promise<boolean> {
		if (result.cancelled || result.exitCode !== 0 || !result.workingDir) return false;
		if (!path.isAbsolute(result.workingDir)) return false;

		const resolvedPath = path.resolve(result.workingDir);
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return false;

		return this.#relocateSession(resolvedPath);
	}

	async handleEvalCommand(
		language: string,
		code: string,
		excludeFromContext = false,
		reset = false,
		alias = language,
	): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		this.ctx.pythonComponent = new EvalExecutionComponent(code, this.ctx.ui, excludeFromContext, language);
		// Provisional until the session records the cell.
		const block = new PresentedBlock(
			this.ctx.pythonComponent,
			messageBlock({
				role: "evalExecution",
				language,
				code,
				output: "",
				exitCode: undefined,
				cancelled: false,
				timestamp: Date.now(),
				excludeFromContext,
			}),
		);
		block.setExpanded(this.ctx.toolOutputExpanded);

		if (isDeferred) {
			this.ctx.pendingShellContainer.addChild(block);
			this.ctx.pendingPythonComponents.push(block);
		} else {
			this.ctx.present(block);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executeEval(
				language,
				code,
				chunk => {
					if (this.ctx.pythonComponent) {
						this.ctx.pythonComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext, reset, alias, onRecorded: message => block.setBlock(messageBlock(message)) },
			);

			if (this.ctx.pythonComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.pythonComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
					artifactError: meta?.artifactError,
				});
			}
		} catch (error) {
			if (this.ctx.pythonComponent) {
				this.ctx.pythonComponent.setComplete(undefined, false);
			}
			this.ctx.showError(
				t("commands.controller.evalFailed", {
					error: error instanceof Error ? error.message : t("commands.controller.unknownError"),
				}),
			);
		}

		this.ctx.pythonComponent = undefined;
		this.ctx.ui.requestRender();
	}

	handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		return this.handleEvalCommand("py", code, excludeFromContext);
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		options?: Pick<CompactOptions, "internalGuidance" | "readerModel">,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning(t("commands.controller.nothingToCompact"));
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead. That caller also dispatches
		// the execution turn itself, so the compaction must not resume the
		// plan-approval turn it aborted.
		if (options?.internalGuidance) {
			return this.executeCompaction(
				{ internalGuidance: options.internalGuidance, suppressContinuation: true, ...(mode ? { mode } : {}) },
				false,
				beforeFlush,
				mode,
				options.readerModel,
			);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode, options?.readerModel);
	}

	/**
	 * Run the `/compact` queued for the next yield once the session goes quiet. One watcher serves the
	 * request from the moment it is queued, so no single event (a setup that bails without an
	 * `agent_end`) can strand it; later calls join the running watcher.
	 * Follow-ups queued behind the request wait in `compactionQueuedMessages` and flush once it ends.
	 */
	runYieldCompaction(): Promise<void> {
		this.#yieldCompactionWatcher ??= this.#watchYieldCompaction().finally(() => {
			this.#yieldCompactionWatcher = undefined;
		});
		return this.#yieldCompactionWatcher;
	}

	async #watchYieldCompaction(): Promise<void> {
		let request = this.ctx.yieldCompaction;
		if (!request) return;
		const session = this.ctx.session;
		while (true) {
			await session.waitForIdle();
			// Input sent before the request reaches the session first, also while it is still dispatching.
			await this.ctx.waitForSubmissionDispatches();
			await session.waitForAdmittedSubmissions();
			// Let a session switch commit or roll back before judging which conversation is live.
			if (session.isSessionTransitioning) await session.waitForSessionTransition();
			await session.waitForRunEnd();
			if (this.ctx.session !== session) return;
			if (this.ctx.yieldCompaction !== request) {
				// Dequeued (and maybe queued again): serve whatever request is pending now.
				if (!this.ctx.yieldCompaction) return;
				request = this.ctx.yieldCompaction;
				continue;
			}
			// The run yielded only once nothing can continue it: no open run, retry, queued input, pending
			// submission, or transition. Otherwise something is mid-flight; look again.
			if (
				!session.isStreaming &&
				!session.isRetrying &&
				!session.isSessionTransitioning &&
				!session.hasAdmittedSubmission &&
				!session.isRunActive &&
				session.queuedMessageCount === 0 &&
				!this.ctx.hasPendingSubmission()
			) {
				break;
			}
			await Bun.sleep(10);
		}
		if (!continuesConversation(this.ctx.sessionManager, request)) {
			// Switched sessions or navigated the tree (both may reuse this `AgentSession`): nothing queued
			// for the old position may compact or run here.
			this.ctx.restoreCompactionQueueToEditor();
			return;
		}
		this.ctx.yieldCompaction = undefined;
		// The request leaves; its position stays with the follow-ups it held until they flush.
		this.ctx.compactionQueueOrigin = { sessionId: request.sessionId, leafId: request.leafId };
		this.ctx.updatePendingMessagesDisplay();
		if (session.isCompacting) {
			// Another pass (auto, or an extension's `ctx.compact()`) already compacts.
			this.ctx.showStatus(t("commands.controller.compactSkipped"));
			while (session.isCompacting) {
				await Bun.sleep(10);
			}
			await this.ctx.flushCompactionQueue({ willRetry: false });
			return;
		}
		// `executeCompaction` calls the hook right before it flushes the queue; "Nothing to compact"
		// returns before both, so the held follow-ups are released here instead.
		let compactionFlushes = false;
		await this.handleCompactCommand(request.instructions, request.mode, () => {
			compactionFlushes = true;
		});
		if (!compactionFlushes) await this.ctx.flushCompactionQueue({ willRetry: false });
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content,
	 * `images` strips image blocks, and `thinking` drops the thinking blocks the
	 * request rebuilds from them, keeping the turns it replays natively (they
	 * are reported as kept and the transcript is left alone). Rebuilds the chat
	 * and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(
				t("commands.controller.shakeFailed", { error: error instanceof Error ? error.message : String(error) }),
			);
			return;
		}

		const dropped =
			result.toolResultsDropped +
			result.blocksDropped +
			(result.imagesDropped ?? 0) +
			(result.thinkingBlocksDropped ?? 0);
		if (dropped === 0) {
			// Replayed thinking was left in place: nothing to rebuild, but say so.
			this.ctx.showStatus(
				(result.thinkingBlocksKept ?? 0) > 0 ? formatShakeSummary(result) : t("commands.controller.nothingToShake"),
			);
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
		readerModel?: Model,
	): Promise<CompactionOutcome> {
		const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
		const baseOptions = typeof customInstructionsOrOptions === "object" ? customInstructionsOrOptions : undefined;
		const effectiveMode = mode ?? baseOptions?.mode;
		const options =
			baseOptions || effectiveMode || readerModel
				? { ...baseOptions, mode: effectiveMode, readerModel: readerModel ?? baseOptions?.readerModel }
				: undefined;
		const session = this.ctx.session;
		const background = effectiveMode !== undefined && findCompactMode(effectiveMode)?.background === true;
		if (session.isBackgroundCompacting || (background && session.isCompacting)) {
			this.ctx.showWarning(t("commands.controller.compactInProgress"));
			return "failed";
		}
		const sessionId = background ? this.ctx.sessionManager.getSessionId() : undefined;
		const inView = () =>
			!background || (this.ctx.viewSession === session && this.ctx.sessionManager.getSessionId() === sessionId);

		const cancelHint = t("commands.controller.cancelHint", { key: appKey(this.ctx.keybindings, "app.interrupt") });
		const label = isAuto ? t("commands.controller.autoCompacting") : t("commands.controller.compacting");
		let compactingLoader: Loader | undefined;
		if (background) {
			this.ctx.showStatus(t("commands.controller.compactingInBackground", { label, cancel: cancelHint }));
		} else {
			if (this.ctx.loadingAnimation) {
				this.ctx.loadingAnimation.stop();
				this.ctx.loadingAnimation = undefined;
			}
			this.ctx.statusContainer.disposeChildren();
			compactingLoader = new Loader(
				this.ctx.ui,
				spinner => theme.fg("accent", spinner),
				text => theme.fg("muted", text),
				`${label}… ${cancelHint}`,
				getSymbolTheme().spinnerFrames,
			);
			const startedAt = Date.now();
			compactingLoader.setWorkingRow(
				() => ({
					label: `${label}…`,
					startedAt,
					variant: { kind: "compaction" },
					interruptKey: this.ctx.maintenanceInterruptKey(),
				}),
				() => this.ctx.interruptFromPointer(),
			);
			this.ctx.statusContainer.addChild(compactingLoader);
			this.ctx.ui.requestRender();
		}

		let outcome: CompactionOutcome = "ok";
		try {
			try {
				await session.compact(instructions, options);
			} finally {
				if (compactingLoader) {
					compactingLoader.stop();
					this.ctx.statusContainer.removeChild(compactingLoader);
				}
			}
			if (inView()) {
				this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });
				this.ctx.statusLine.invalidate();
				if (background) this.ctx.showStatus(t("commands.controller.compactComplete"));
				// Rebuilding resets the transcript's emission ledger. Clear terminal
				// scrollback before re-emitting its blocks (#12140).
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			}
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				if (inView()) this.ctx.showError(t("commands.controller.compactCancelled"));
			} else {
				outcome = "failed";
				const message = error instanceof Error ? error.message : String(error);
				logger.error("Compaction failed", { error: message });
				if (inView()) this.ctx.showError(t("commands.lifecycle.compactError", { error: message }));
			}
		}
		// A plan approval may switch models before queued input can dispatch.
		if (beforeFlush) await beforeFlush(outcome);
		if (!background) await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}
}

const BAR_WIDTH_MAX = 24;
const COLUMN_WIDTH_MIN = 4;

function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, (job.endTime ?? now) - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", t("commands.controller.jobRunning"));
	if (status === "completed") return theme.fg("success", t("commands.controller.jobCompleted"));
	if (status === "cancelled") return theme.fg("dim", t("commands.controller.jobCancelled"));
	return theme.fg("error", t("commands.controller.jobFailed"));
}

function truncateJobLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	if (maxWidth <= 1) return "…";

	let out = "";
	for (const char of label) {
		const next = `${out}${char}`;
		if (visibleWidth(`${next}…`) > maxWidth) break;
		out = next;
	}

	return `${out}…`;
}

function formatNumber(value: number, maxFractionDigits = 1): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(value);
}

function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.credentials.hasOAuth(provider)) {
		return "oauth";
	}
	if (authStorage.credentials.has(provider)) {
		return t("commands.controller.apiKey");
	}
	if (getEnvApiKey(provider)) {
		return t("commands.controller.envApiKey");
	}
	if (authStorage.keys.source(provider) !== undefined) {
		return t("commands.controller.runtimeFallback");
	}
	return t("commands.controller.unknown");
}

export function renderProviderSection(details: ProviderDetails, uiTheme: Pick<Theme, "fg">): string {
	const lines: string[] = [];
	lines.push(`${uiTheme.fg("dim", t("commands.controller.providerName"))} ${details.provider}`);
	for (const field of details.fields) {
		lines.push(`${uiTheme.fg("dim", `${field.label}:`)} ${field.value}`);
	}
	return `${lines.join("\n")}\n`;
}

function resolveProviderUsageTotal(reports: UsageReport[]): number {
	return reports
		.flatMap(report => report.limits)
		.map(limit => resolveUsedFraction(limit) ?? 0)
		.reduce((sum, value) => sum + value, 0);
}

function formatWindowSuffix(label: string, windowLabel: string, uiTheme: Theme): string {
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window") return "";
	if (normalizedLabel.includes(normalizedWindow)) return "";
	return uiTheme.fg("dim", `(${windowLabel})`);
}

/** ` (org · plan)` suffix for providers whose orgName is an organization. */
function orgSuffix(report: UsageReport): string {
	const orgName = report.metadata?.orgName;
	const orgId = report.metadata?.orgId;
	const org = typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
	const detail = [org, usageSubscriptionPlan(report)].filter(Boolean).join(" · ");
	return detail ? ` (${detail})` : "";
}

/** Keep the existing TUI `(plan)` layout while using the live Codex usage plan. */
function formatCodexTuiLabel(report: UsageReport, peers: readonly UsageReport[], base: string): string {
	const identity = formatCodexUsageReportLabel(report, peers, base, undefined, false);
	const plan = codexUsagePlan(report);
	return plan ? `${identity} (${plan})` : identity;
}

function formatAccountLabel(
	limit: UsageLimit,
	report: UsageReport,
	peers: readonly UsageReport[],
	index: number,
): string {
	const codex = report.provider === "openai-codex";
	const email = report.metadata?.email;
	if (typeof email === "string" && email)
		return codex ? formatCodexTuiLabel(report, peers, email) : `${email}${orgSuffix(report)}`;
	const accountId =
		typeof report.metadata?.accountId === "string" && report.metadata.accountId
			? report.metadata.accountId
			: limit.scope.accountId || undefined;
	if (accountId) return codex ? formatCodexTuiLabel(report, peers, accountId) : `${accountId}${orgSuffix(report)}`;
	const projectId =
		typeof report.metadata?.projectId === "string" && report.metadata.projectId
			? report.metadata.projectId
			: limit.scope.projectId || undefined;
	const base =
		typeof projectId === "string" && projectId
			? projectId
			: t("commands.controller.accountNumber", { number: index + 1 });
	return codex ? formatCodexTuiLabel(report, peers, base) : base;
}

function formatUnlimitedReportLabel(report: UsageReport, peers: readonly UsageReport[], index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email)
		return report.provider === "openai-codex"
			? formatCodexTuiLabel(report, peers, email)
			: `${email}${orgSuffix(report)}`;
	const accountId = report.metadata?.accountId;
	if (typeof accountId === "string" && accountId)
		return report.provider === "openai-codex"
			? formatCodexTuiLabel(report, peers, accountId)
			: `${accountId}${orgSuffix(report)}`;
	const projectId = report.metadata?.projectId;
	const base =
		typeof projectId === "string" && projectId
			? projectId
			: t("commands.controller.accountNumber", { number: index + 1 });
	return report.provider === "openai-codex" ? formatCodexTuiLabel(report, peers, base) : base;
}

function formatResetShort(limit: UsageLimit, nowMs: number): string | undefined {
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt === undefined) return undefined;
	// Codex returns the prior window's reset_at until a new request opens a fresh window —
	// rendering a negative delta is meaningless, so drop the suffix in that case.
	if (resetsAt <= nowMs) return undefined;
	return formatDuration(resetsAt - nowMs);
}

function formatAccountHeaderRow(
	limits: UsageLimit[],
	reports: UsageReport[],
	peers: readonly UsageReport[],
	nowMs: number,
	columnWidth: number,
	uiTheme: Theme,
	activeAccount?: OAuthAccountIdentity,
): string[] {
	const parts = limits.map((limit, index) => {
		const reset = formatResetShort(limit, nowMs);
		const report = reports[index];
		const active = report !== undefined && limitMatchesActiveAccount(report, limit, activeAccount);
		const label = formatAccountLabel(limit, report, peers, index);
		return {
			label: active ? `● ${label}` : label,
			suffix: reset ? `(${reset})` : "",
			active,
			daybreak: report?.metadata?.daybreak === true,
		};
	});
	const maxSuffixWidth = parts.reduce((max, p) => Math.max(max, visibleWidth(p.suffix)), 0);
	const gap = maxSuffixWidth > 0 ? 1 : 0;
	const prefixBudget = columnWidth - maxSuffixWidth - gap;

	// If suffix can't share the cell with at least `x…`, fall back to whole-label truncation.
	if (prefixBudget < 2) {
		return parts.map(p => {
			const full = `${p.label}${p.daybreak ? " daybreak" : ""}${p.suffix ? ` ${p.suffix}` : ""}`;
			const cell = padColumn(truncateJobLabel(full, columnWidth), columnWidth);
			return p.active ? uiTheme.fg("accent", cell) : cell;
		});
	}

	return parts.map(p => {
		// Keep the full badge visible by taking its columns from the account label.
		const badge = p.daybreak && prefixBudget >= 10 ? " daybreak" : "";
		const label = truncateJobLabel(p.label, prefixBudget - visibleWidth(badge));
		const prefix = `${p.active ? uiTheme.fg("accent", label) : label}${badge ? uiTheme.fg("success", badge) : ""}`;
		const prefixCell = prefix + " ".repeat(prefixBudget - visibleWidth(prefix));
		if (!p.suffix) return prefixCell + " ".repeat(maxSuffixWidth + gap);
		const suffixPad = " ".repeat(maxSuffixWidth - visibleWidth(p.suffix));
		return `${prefixCell} ${suffixPad}${uiTheme.fg("dim", p.suffix)}`;
	});
}

function padColumn(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	return `${text}${padding(width - visible)}`;
}

type AggregateDisplayStatus = NonNullable<UsageLimit["status"]> | "neutral";

function resolveAggregateStatus(limits: UsageLimit[]): AggregateDisplayStatus {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (!hasOk && !hasWarning && !hasExhausted) {
		return limits.length > 0 && limits.every(isUsedOnlyAbsoluteAmount) ? "neutral" : "unknown";
	}
	if (hasOk) {
		return hasWarning || hasExhausted ? "warning" : "ok";
	}
	if (hasWarning) return "warning";
	return "exhausted";
}

function formatAggregateAmount(limits: UsageLimit[]): string {
	const fractions = limits
		.map(limit => resolveUsedFraction(limit))
		.filter((value): value is number => value !== undefined);
	if (fractions.length === limits.length && fractions.length > 0) {
		const sum = fractions.reduce((total, value) => total + value, 0);
		const avgRemaining = Math.max(0, ((limits.length - sum) / limits.length) * 100);
		return `${formatNumber(avgRemaining)}% free`;
	}

	const amounts = limits
		.map(limit => limit.amount)
		.filter(amount => amount.used !== undefined && amount.limit !== undefined && amount.limit > 0);
	if (amounts.length === limits.length && amounts.length > 0) {
		const totalUsed = amounts.reduce((sum, amount) => sum + (amount.used ?? 0), 0);
		const totalLimit = amounts.reduce((sum, amount) => sum + (amount.limit ?? 0), 0);
		const remainingPct = totalLimit > 0 ? Math.max(0, 100 - (totalUsed / totalLimit) * 100) : 0;
		return `${formatNumber(remainingPct)}% free`;
	}

	if (limits.length > 0 && limits.every(isUsedOnlyAbsoluteAmount)) return "";

	// Prepaid balances have no total to divide by. `totalRemainingOnly`
	// collapses account-wide pools seen once per stored key and sums only
	// genuinely distinct ones, so a multi-key provider is never double-counted.
	const remaining = formatRemainingOnlyTotal(limits);
	if (remaining !== undefined) return remaining;

	// Count unique accounts from limit scopes — not limits.length.
	const uniqueAccountIds = new Set(
		limits.map(limit => limit.scope.accountId).filter((id): id is string => typeof id === "string" && id.length > 0),
	);
	if (uniqueAccountIds.size > 0)
		return t("commands.controller.accountCount", {
			count: uniqueAccountIds.size,
			label:
				uniqueAccountIds.size === 1
					? t("commands.controller.accountCountSingular")
					: t("commands.controller.accountCountPlural"),
		});
	// No account IDs available — keep the pre-existing fallback so providers
	// that don't populate scope.accountId still show a summary.
	return t("commands.controller.countAccounts", { count: limits.length });
}

function resolveResetRange(limits: UsageLimit[], nowMs: number): string | null {
	const windows = limits
		.map(limit => limit.window)
		.filter(
			(window): window is NonNullable<UsageLimit["window"]> =>
				window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > nowMs,
		);
	if (windows.length === 0) return null;
	// Use the shared verb when every contributing window agrees (e.g. all "tick");
	// mixed or absent labels fall back to the generic "resets".
	const labels = new Set(windows.map(window => window.resetLabel ?? "resets"));
	const resetLabel = labels.size === 1 ? [...labels][0]! : "resets";
	const verb = resetLabel === "resets" ? t("commands.usage.resets") : resetLabel;
	const offsets = windows.map(window => window.resetsAt! - nowMs);
	const minReset = Math.min(...offsets);
	const maxReset = Math.max(...offsets);
	if (maxReset - minReset > 60_000) {
		return t("commands.controller.quotaResetRange", {
			verb,
			start: formatDuration(minReset),
			end: formatDuration(maxReset),
		});
	}
	return t("commands.controller.quotaReset", { verb, duration: formatDuration(minReset) });
}

function resolveStatusIcon(status: AggregateDisplayStatus, uiTheme: Theme): string {
	if (status === "neutral") return uiTheme.fg("dim", uiTheme.status.info);
	if (status === "exhausted") return uiTheme.fg("error", uiTheme.status.error);
	if (status === "warning") return uiTheme.fg("warning", uiTheme.status.warning);
	if (status === "ok") return uiTheme.fg("success", uiTheme.status.success);
	return uiTheme.fg("dim", uiTheme.status.pending);
}

function resolveStatusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

function renderUsageBar(limit: UsageLimit, uiTheme: Theme, barWidth: number): string {
	const usedAmount = limit.amount.used;
	if (usedAmount !== undefined && isUsedOnlyAbsoluteAmount(limit)) {
		const used =
			limit.amount.unit === "usd"
				? `$${usedAmount.toFixed(2)}`
				: `${formatNumber(usedAmount, 2)} ${limit.amount.unit}`;
		return uiTheme.fg("dim", truncateJobLabel(t("commands.controller.used", { amount: used }), barWidth));
	}
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) {
		return uiTheme.fg("dim", "·".repeat(barWidth));
	}
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const exact = clamped * barWidth;
	const fullCells = Math.floor(exact);
	const remainder = exact - fullCells;
	let partial = "";
	if (remainder >= 2 / 3) partial = "▓";
	else if (remainder >= 1 / 3) partial = "▒";
	const leading = "█".repeat(fullCells) + partial;
	const empty = "░".repeat(Math.max(0, barWidth - fullCells - (partial ? 1 : 0)));
	const color = resolveStatusColor(limit.status);
	return `${uiTheme.fg(color, leading)}${uiTheme.fg("dim", empty)}`;
}

/**
 * Pick a per-account column width so the columns and trailing amount fit in `available`.
 * Falls back to the minimum when the terminal is too narrow rather than wrapping.
 */
function resolveColumnWidth(count: number, available: number, trailing: number): number {
	if (count <= 0) return BAR_WIDTH_MAX;
	const indent = 2;
	const gaps = count - 1;
	const spaceForBars = available - indent - gaps - (trailing > 0 ? trailing + 1 : 0);
	const ideal = Math.floor(spaceForBars / count);
	if (ideal < COLUMN_WIDTH_MIN) return COLUMN_WIDTH_MIN;
	return ideal;
}

export function renderUsageReports(
	reports: UsageReport[],
	uiTheme: Theme,
	nowMs: number,
	availableWidth: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
	unavailableAccounts: readonly UnavailableUsageAccount[] = [],
): string {
	const displayReports = collapseSharedUsageReports(reports);
	const lines: string[] = [];
	const latestFetchedAt = Math.max(0, ...reports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt
		? t("commands.usage.age", { duration: formatDuration(nowMs - latestFetchedAt) })
		: "";
	lines.push(uiTheme.bold(uiTheme.fg("accent", t("commands.usage.headingFetched", { age: headerSuffix }))));
	const grouped = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}
	for (const account of unavailableAccounts) {
		if (!grouped.has(account.provider)) grouped.set(account.provider, []);
	}
	const providerEntries = Array.from(grouped.entries())
		.map(([provider, providerReports]) => ({
			provider,
			providerReports,
			totalUsage: resolveProviderUsageTotal(providerReports),
		}))
		.sort((a, b) => {
			if (a.totalUsage !== b.totalUsage) return a.totalUsage - b.totalUsage;
			return a.provider.localeCompare(b.provider);
		});

	for (const { provider, providerReports } of providerEntries) {
		lines.push("");
		const providerName = formatProviderName(provider);
		const activeAccount = resolveActiveAccount?.(provider);

		const limitGroups = new Map<
			string,
			{ label: string; windowLabel: string; limits: UsageLimit[]; reports: UsageReport[] }
		>();
		for (const report of providerReports) {
			for (const limit of report.limits) {
				const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
				// Distinct buckets can share a label and window (Antigravity's Gemini
				// vs Gemini (Argon) weekly) and must stay separate rows instead of
				// averaging into "50% free", so the id joins the key. Label and window
				// stay in it too: some providers build ids positionally or per plan
				// (kimi's `${index}`, copilot's allowance), where ids differ across
				// accounts for the same quota. `sharedGroup` keeps the routing copies
				// of one shared bucket together.
				const key = limit.scope.sharedGroup ?? `${formatLimitTitle(limit)}|${windowId}|${limit.id}`;
				const windowLabel = limit.window?.label ?? windowId;
				const entry = limitGroups.get(key) ?? {
					label: formatLimitTitle(limit),
					windowLabel,
					limits: [],
					reports: [],
				};
				entry.limits.push(limit);
				entry.reports.push(report);
				limitGroups.set(key, entry);
			}
		}

		lines.push(uiTheme.bold(uiTheme.fg("accent", providerName)));
		const activeReport =
			provider === "openai-codex" && activeAccount
				? ((activeAccount.accountId
						? providerReports.find(
								report =>
									report.metadata?.orgId === activeAccount.orgId &&
									report.metadata?.accountId === activeAccount.accountId,
							)
						: undefined) ??
					providerReports.find(
						report =>
							report.metadata?.orgId === activeAccount.orgId &&
							!!activeAccount.email &&
							report.metadata?.email === activeAccount.email &&
							(!activeAccount.accountId || !report.metadata?.accountId),
					))
				: undefined;
		const activeAccountLabel =
			provider === "openai-codex"
				? activeReport
					? formatCodexTuiLabel(
							activeReport,
							providerReports,
							activeAccount?.email || activeAccount?.accountId || t("commands.controller.accountLabel"),
						)
					: activeAccount?.email || activeAccount?.accountId || activeAccount?.projectId
				: formatActiveAccountLabel(activeAccount);
		if (activeAccountLabel) {
			lines.push(`  ${uiTheme.fg("accent", t("commands.controller.usageInUse"))} ${activeAccountLabel}`);
		}
		const reportingModels = usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`));
		if (reportingModels.length > 0) {
			lines.push(`  ${uiTheme.fg("accent", t("commands.controller.modelsWithUsage"))}`);
			for (const selector of reportingModels) {
				lines.push(`    ${replaceTabs(truncateToWidth(sanitizeText(selector), availableWidth - 4))}`);
			}
		}
		for (const account of unavailableAccounts) {
			if (account.provider !== provider) continue;
			const label = replaceTabs(sanitizeText(account.label.replace(/[\r\n]+/g, " ")));
			const status = t("commands.controller.usageUnavailable");
			const boundedLabel = truncateToWidth(label, Math.max(0, availableWidth - 2 - visibleWidth(status)));
			lines.push(`  ${uiTheme.fg("dim", truncateToWidth(`${boundedLabel}${status}`, availableWidth - 2))}`);
		}

		// Provider-wide disclaimers (e.g. "NeoPi-observed spend only") render once
		// above the per-account sections instead of duplicating onto every limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		if (providerNotes.length > 0) {
			lines.push(
				`  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(providerNotes.map(n => n.replace(/[\r\n]+/g, " ")).join(" • ")), 110)))}`.trimEnd(),
			);
		}

		const resetAccountLines: string[] = [];
		for (const report of providerReports) {
			const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
			if (!resets || resets.bankedCount <= 0) continue;
			const identityLabel =
				typeof report.metadata?.email === "string" && report.metadata.email
					? report.metadata.email
					: typeof report.metadata?.accountId === "string" && report.metadata.accountId
						? report.metadata.accountId
						: t("commands.controller.accountLabel");
			const orgName = report.metadata?.orgName;
			const orgId = report.metadata?.orgId;
			const orgLabel =
				typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
			const rawLabel =
				provider === "openai-codex"
					? formatCodexTuiLabel(report, providerReports, identityLabel)
					: orgLabel && orgLabel !== identityLabel
						? `${identityLabel} (${orgLabel})`
						: identityLabel;
			const label = sanitizeText(rawLabel.replace(/[\r\n\t]+/g, " "));
			const activeOrg = activeAccount?.orgId;
			const reportOrg = typeof report.metadata?.orgId === "string" ? report.metadata.orgId : undefined;
			const orgMatches = !activeOrg && !reportOrg ? true : activeOrg === reportOrg;
			const isActive =
				provider === "openai-codex"
					? activeReport === report
					: orgMatches &&
						!!activeAccount &&
						((!!activeAccount.accountId && activeAccount.accountId === report.metadata?.accountId) ||
							(!!activeAccount.email && activeAccount.email === report.metadata?.email));
			const availability =
				resets.redeemableCount === resets.bankedCount
					? ""
					: t("commands.controller.resetsUsable", { count: resets.redeemableCount });
			resetAccountLines.push(
				t("commands.controller.savedResetRow", {
					name: label,
					count: resets.bankedCount,
					plural: resets.bankedCount === 1 ? "" : "s",
					availability,
					active: isActive ? t("commands.controller.activeAccount") : "",
				}),
			);
			if (resets.soonestExpiry) {
				const expiryMs = Date.parse(resets.soonestExpiry);
				const remaining = expiryMs - nowMs;
				const expiryDate = resets.soonestExpiry.slice(0, 10);
				if (remaining > 0) {
					resetAccountLines.push(
						t("commands.controller.resetExpires", { duration: formatDuration(remaining), date: expiryDate }),
					);
				} else {
					resetAccountLines.push(t("commands.controller.resetExpired", { date: expiryDate }));
				}
			}
			if (resets.redeemableCount === 0 && resets.unavailableReason) {
				const reason = sanitizeText(resets.unavailableReason.replace(/[\r\n\t]+/g, " "));
				resetAccountLines.push(`        unavailable: ${reason}`);
			}
		}
		if (resetAccountLines.length > 0) {
			lines.push(
				`  ${uiTheme.fg("accent", t("commands.controller.savedResets"))} ${uiTheme.fg("dim", t("commands.controller.resetRedeem"))}`,
			);
			for (const line of resetAccountLines) lines.push(uiTheme.fg("dim", line));
		}

		// Order account columns ONCE per provider (worst-first), then apply that
		// same order to every window group. Sorting each group independently by
		// its own used fraction (issue #6067) desynchronized the columns: an
		// account exhausted on its 5h window but light on the weekly window would
		// land in different column positions on each row, so the positional
		// `account N` labels denoted different credentials per row and an
		// exhausted limit appeared under a sibling that still had quota.
		const accountRank = new Map<UsageReport, number>();
		providerReports.forEach((report, position) => {
			const worst = report.limits.reduce((max, limit) => {
				const fraction = resolveUsedFraction(limit) ?? -1;
				return fraction > max ? fraction : max;
			}, -1);
			// Encode worst-first primary key with the stable position as tiebreak
			// so accounts tied on pressure keep their discovery order.
			accountRank.set(report, -worst * 1000 + position);
		});

		const renderableGroups = Array.from(limitGroups.values()).map(group => {
			const entries = group.limits.map((limit, index) => ({
				limit,
				report: group.reports[index],
				index,
			}));
			entries.sort((a, b) => {
				const aRank = accountRank.get(a.report) ?? a.index;
				const bRank = accountRank.get(b.report) ?? b.index;
				if (aRank !== bRank) return aRank - bRank;
				return a.index - b.index;
			});
			const sortedLimits = entries.map(entry => entry.limit);
			const sortedReports = entries.map(entry => entry.report);
			return { group, sortedLimits, sortedReports, amountText: formatAggregateAmount(sortedLimits) };
		});

		const sectionCount = renderableGroups.reduce((max, g) => Math.max(max, g.sortedLimits.length), 0);
		const sectionTrailing = renderableGroups.reduce((max, g) => Math.max(max, visibleWidth(g.amountText)), 0);
		const sectionColumnWidth = resolveColumnWidth(sectionCount, availableWidth, sectionTrailing);
		const sectionBarWidth = Math.min(sectionColumnWidth, BAR_WIDTH_MAX);

		for (const { group, sortedLimits, sortedReports, amountText } of renderableGroups) {
			const status = resolveAggregateStatus(sortedLimits);
			const statusIcon = resolveStatusIcon(status, uiTheme);

			const windowSuffix = formatWindowSuffix(group.label, group.windowLabel, uiTheme);
			lines.push(`${statusIcon} ${uiTheme.bold(group.label)} ${windowSuffix}`.trim());
			const accountLabels = formatAccountHeaderRow(
				sortedLimits,
				sortedReports,
				providerReports,
				nowMs,
				sectionColumnWidth,
				uiTheme,
				activeAccount,
			);
			lines.push(`  ${accountLabels.join(" ")}`.trimEnd());
			const bars = sortedLimits.map(limit =>
				padColumn(renderUsageBar(limit, uiTheme, sectionBarWidth), sectionColumnWidth),
			);
			lines.push(`  ${bars.join(" ")} ${amountText}`.trimEnd());
			const resetText = sortedLimits.length <= 1 ? resolveResetRange(sortedLimits, nowMs) : null;
			if (resetText) {
				lines.push(`  ${uiTheme.fg("dim", resetText)}`.trimEnd());
			}
			const notes = [...new Set(sortedLimits.flatMap(limit => limit.notes ?? []))];
			if (notes.length > 0) {
				lines.push(
					`  ${uiTheme.fg("dim", replaceTabs(truncateToWidth(sanitizeText(notes.map(n => n.replace(/[\r\n]+/g, " ")).join(" • ")), 110)))}`.trimEnd(),
				);
			}
		}

		// Render accounts with no rate limits (e.g. business/enterprise plans).
		const unlimitedReports = providerReports.filter(report => report.limits.length === 0);
		for (const report of unlimitedReports) {
			const label = formatUnlimitedReportLabel(report, providerReports, 0);
			const tier = report.provider === "openai-codex" ? undefined : report.metadata?.planType;
			const tierSuffix = typeof tier === "string" && tier ? ` ${uiTheme.fg("dim", `(${tier})`)}` : "";
			const daybreakSuffix = report.metadata?.daybreak === true ? uiTheme.fg("success", " daybreak") : "";
			lines.push(
				`${uiTheme.fg("success", uiTheme.status.success)} ${label}${daybreakSuffix}${tierSuffix} ${uiTheme.fg("dim", t("commands.controller.noLimits"))}`,
			);
		}
		// No per-provider footer; global header shows last check.
	}

	return lines.join("\n");
}
