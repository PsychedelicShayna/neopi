import { t } from "@oh-my-pi/pi-utils/i18n";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { resolveIssuesRoleSelection } from "../../config/model-resolver";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import {
	ISSUE_REQUEST_MESSAGE_TYPE,
	type IssueNotice,
	type IssueNoticeDetails,
	renderIssueNotice,
	runIssueFiling,
} from "../../issues/filing";
import { github } from "../../utils/github";
import type { InteractiveModeContext } from "../types";

const ISSUE_LABEL_PREVIEW_LENGTH = 80;

function previewProse(prose: string): string {
	const singleLine = prose.trim().replace(/\s+/g, " ");
	if (singleLine.length <= ISSUE_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, ISSUE_LABEL_PREVIEW_LENGTH - 1)}…`;
}

/** One-line status for a record that waits behind a streaming foreground turn. */
function statusLine(notice: IssueNotice): string {
	switch (notice.kind) {
		case "dispatched":
			return t("overlays.issue_command_controller.dispatched", { part1: `${notice.agentId}` });
		case "question":
			return t("overlays.issue_command_controller.needs_answer", { part1: `${notice.agentId}` });
		case "failed":
			return t("overlays.issue_command_controller.failed", { part1: `${notice.error}` });
		case "outcome":
			if (notice.outcome.kind === "published")
				return t("overlays.issue_command_controller.filed", { part1: `${notice.outcome.issue.url}` });
			if (notice.outcome.kind === "published-unread")
				return t("overlays.issue_command_controller.filed_no_record", { part1: `${notice.outcome.issue.url}` });
			if (notice.outcome.kind === "publication-uncertain")
				return t("overlays.issue_command_controller.not_confirmed", { part1: `${notice.outcome.repo}` });
			if (notice.outcome.kind === "existing-owner") {
				return t("overlays.issue_command_controller.already_owned", { part1: `${notice.outcome.owner.url}` });
			}
			return t("overlays.issue_command_controller.not_filed", { part1: `${notice.outcome.reason}` });
	}
}

/**
 * `/issue <prose>`: file the operator's words as an issue in the right
 * tracker from a background job (#305). The foreground conversation keeps
 * going; status arrives as display-only records that never start a turn.
 */
export class IssueCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async start(prose: string): Promise<void> {
		const trimmed = prose.trim();
		if (!trimmed) {
			this.ctx.showStatus(t("overlays.issue_command_controller.usage"));
			return;
		}
		const session = this.ctx.session;
		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError(t("overlays.issue_command_controller.jobs_disabled"));
			return;
		}
		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError(t("overlays.issue_command_controller.persisted_session"));
			return;
		}
		if (!github.available()) {
			this.ctx.showError(t("overlays.issue_command_controller.needs_gh"));
			return;
		}
		const modelRegistry = session.modelRegistry;
		const selection = resolveIssuesRoleSelection(this.ctx.settings, modelRegistry.getAvailable());
		if (!selection) {
			this.ctx.showError(t("overlays.issue_command_controller.needs_role"));
			return;
		}

		const requestId = Snowflake.next();
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const cwd = this.ctx.sessionManager.getCwd();
		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		const notify = async (notice: IssueNotice, details: IssueNoticeDetails): Promise<void> => {
			const wasStreaming = session.isStreaming;
			await session.sendCustomMessage(
				{
					customType: ISSUE_REQUEST_MESSAGE_TYPE,
					content: renderIssueNotice(details.requestId, details.prose, notice),
					display: true,
					attribution: "agent",
					details,
				},
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);
			// Mid-turn, the record joins the transcript when the next turn starts;
			// the status line shows it now without touching the running turn.
			if (wasStreaming) this.ctx.showStatus(statusLine(notice));
			else this.ctx.rebuildChatFromMessages();
		};

		let jobId = "";
		try {
			jobId = manager.register(
				"task",
				`/issue ${previewProse(trimmed)}`,
				async ({ jobId: id, signal, reportProgress }) => {
					// Status reaches the foreground through `notify`; the job's own
					// completion delivery would wake the foreground model, so it is
					// acknowledged up front and only kept on the job row (proc://).
					manager.acknowledgeDeliveries([id]);
					try {
						return await runIssueFiling(
							{
								requestId,
								prose: trimmed,
								cwd,
								model: selection.model,
								thinkingLevel: selection.thinkingLevel,
								settings: this.ctx.settings,
								modelRegistry,
								asyncJobManager: manager,
								ownerId,
								sessionDir: parentFile.slice(0, -6),
								parentSessionFile: parentFile,
								providerSessionPrefix: `${session.sessionId}:issue:${requestId}`,
								notify,
							},
							{ signal, reportProgress: text => reportProgress(text) },
						);
					} catch (error) {
						const message = signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error);
						const notice: IssueNotice = { kind: "failed", error: message };
						await notify(notice, { requestId, prose: trimmed, notice }).catch(() => {});
						throw error;
					}
				},
				{ ownerId },
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		this.ctx.showStatus(t("overlays.issue_command_controller.dispatch_status", { part1: `${jobId}` }));
	}
}
