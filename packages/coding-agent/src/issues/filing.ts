import { resolvePromptAsset, renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
/**
 * Background `/issue` filing (#305). Two agents run inside one async job:
 *
 * 1. The target agent picks the tracker from the operator's prose and a local
 *    + GitHub inventory, or asks her. It has one tool and no project context.
 * 2. The author agent starts in the verified checkout of that tracker, so the
 *    SDK discovers that checkout's own AGENTS.md chain, and files at most one
 *    issue through tools pinned to the selected repository.
 *
 * Both agents appear in the Agent Hub. A question is answered there: the
 * agent stays live while it waits, keeping her request in its transcript.
 * Status reaches the foreground as display-only messages; the job's own
 * completion delivery is acknowledged so it never wakes the foreground model.
 */
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AsyncJobManager } from "../async/job-manager";
import { AgentRegistry } from "../registry/agent-registry";
import * as sdk from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { cfgRetryFallbackChains, cfgRetryModelFallback, cfgRetryUsageAwareFallback } from "../session/settings";
import authorRequestTemplate from "./prompts/author-request.md" with { type: "text" };
import authorSystemTemplate from "./prompts/author-system.md" with { type: "text" };
import noticeTemplate from "./prompts/notice.md" with { type: "text" };
import targetRequestTemplate from "./prompts/target-request.md" with { type: "text" };
import targetSystemPrompt from "./prompts/target-system.md" with { type: "text" };
import { collectIssueTargetInventory, type IssueTargetInventory } from "./target-inventory";
import {
	createIssueAuthorTools,
	createIssueDeclineTool,
	createIssueTargetTool,
	type IssuePublicationState,
	type IssueFilingOutcome,
	type IssueTargetSelection,
} from "./tools";

/** Custom message type of every foreground `/issue` status record. */
export const ISSUE_REQUEST_MESSAGE_TYPE = "issue-request";

/** Read-only tools the author uses to read the target checkout's rules and code. */
const AUTHOR_READ_TOOLS = ["read", "grep", "glob", "find"];

/** One foreground status update for a running `/issue` request. */
export type IssueNotice =
	| { kind: "dispatched"; agentId: string }
	| { kind: "question"; agentId: string; question: string }
	| { kind: "outcome"; outcome: IssueFilingOutcome }
	| { kind: "failed"; agentId?: string; error: string };

/** Everything the background job needs, captured at dispatch. */
export interface IssueFilingRequest {
	requestId: string;
	prose: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	settings: Settings;
	modelRegistry: ModelRegistry;
	asyncJobManager: AsyncJobManager;
	ownerId: string;
	/** Directory holding this request's agent transcripts (inside the parent session's artifacts). */
	sessionDir: string;
	parentSessionFile: string;
	providerSessionPrefix: string;
	/** Display a status record in the foreground transcript without starting a turn. */
	notify: (notice: IssueNotice, details: IssueNoticeDetails) => Promise<void>;
}

/** `details` persisted on each foreground status record. */
export interface IssueNoticeDetails {
	requestId: string;
	prose: string;
	notice: IssueNotice;
}

/** Render one status record's Markdown content. */
export function renderIssueNotice(requestId: string, prose: string, notice: IssueNotice): string {
	const context: Record<string, unknown> = { requestId, prose };
	switch (notice.kind) {
		case "dispatched":
			context.dispatched = true;
			context.agentId = notice.agentId;
			break;
		case "question":
			context.question = notice.question;
			context.agentId = notice.agentId;
			break;
		case "failed":
			context.failed = notice.error;
			context.agentId = notice.agentId;
			break;
		case "outcome":
			if (notice.outcome.kind === "published") {
				context.published = { ...notice.outcome.issue, labels: notice.outcome.issue.labels.join(", ") };
			} else if (notice.outcome.kind === "published-unread") {
				context.unread = notice.outcome.issue;
			} else if (notice.outcome.kind === "publication-uncertain") {
				context.uncertain = notice.outcome;
			} else if (notice.outcome.kind === "existing-owner") {
				context.owner = notice.outcome.owner;
			} else {
				context.declined = notice.outcome.reason;
			}
			break;
	}
	return renderPromptAsset("issues/notice.md", noticeTemplate, context, { kind: "notice" }).trim();
}

function lastAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

/**
 * Arm a waiter for the session's next run (an operator reply) before the
 * question is shown, so a fast reply cannot start its run unobserved. The
 * returned function resolves once that run has started and settled.
 */
function armReplyTurn(session: AgentSession, signal: AbortSignal): () => Promise<void> {
	const started = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") started.resolve();
	});
	return async () => {
		try {
			await untilAborted(signal, started.promise);
		} finally {
			unsubscribe();
		}
		await untilAborted(signal, session.waitForIdle());
	};
}

/**
 * Run one agent until `done()` holds. Each time it ends a turn without being
 * done, its last reply is a question for the operator: surface it and wait
 * for her answer in the Agent Hub.
 */
async function converse(options: {
	session: AgentSession;
	agentId: string;
	request: string;
	done: () => boolean;
	signal: AbortSignal;
	notify: (notice: IssueNotice) => Promise<void>;
	reportProgress: (text: string) => Promise<void>;
}): Promise<void> {
	const { session, signal } = options;
	await untilAborted(signal, session.prompt(options.request, { attribution: "user" }));
	await untilAborted(signal, session.waitForIdle());
	while (!options.done()) {
		const question = lastAssistantText(session.getLastAssistantMessage());
		if (!question) throw new Error(`${options.agentId} ended without a result or a question.`);
		await options.reportProgress(`waiting for your answer in the Agent Hub (${options.agentId})`);
		const reply = armReplyTurn(session, signal);
		await options.notify({ kind: "question", agentId: options.agentId, question });
		await reply();
	}
}

/** Settings for an `/issue` agent: the target's project layer, and never a silent model swap. */
async function issueAgentSettings(settings: Settings, cwd: string): Promise<Settings> {
	const scoped = await settings.cloneForCwd(cwd);
	cfgRetryModelFallback.override(scoped, false);
	cfgRetryUsageAwareFallback.override(scoped, false);
	cfgRetryFallbackChains.override(scoped, {});
	return scoped;
}

function describeInventory(inventory: IssueTargetInventory) {
	return inventory.repositories.map(candidate => {
		const flags = [
			candidate.archived ? "archived" : undefined,
			candidate.fork ? "fork" : undefined,
			candidate.issuesEnabled === false ? "issues disabled" : undefined,
		].filter(Boolean);
		return {
			repo: candidate.repo,
			description: candidate.description?.replace(/\s+/g, " ").trim(),
			flags: flags.join(", "),
			checkouts: candidate.checkouts.map(checkout => `\`${shortenPath(checkout.path)}\``).join(", "),
		};
	});
}

/** Keeps a finished agent's transcript in the Agent Hub, like `/tan`; an aborted one is released. */
async function retire(registry: AgentRegistry, session: AgentSession, agentId: string, aborted: boolean) {
	if (aborted) {
		registry.setStatus(agentId, "aborted");
		await session.dispose();
		return;
	}
	registry.setStatus(agentId, "parked");
	await session.dispose();
	registry.detachSession(agentId);
}

async function createIssueAgent(
	request: IssueFilingRequest,
	options: {
		agentId: string;
		displayName: string;
		cwd: string;
		settings: Settings;
		tools: sdk.CreateAgentSessionOptions["customTools"];
		toolNames: string[];
		systemPrompt?: string[];
		appendSystemPrompt?: string;
		discoverContext: boolean;
	},
): Promise<AgentSession> {
	const sessionManager = await SessionManager.open(
		path.join(request.sessionDir, `${options.agentId}.jsonl`),
		undefined,
		undefined,
		{ initialCwd: options.cwd, parentSession: request.parentSessionFile, suppressBreadcrumb: true },
	);
	const { session } = await sdk.createAgentSession({
		cwd: options.cwd,
		sessionManager,
		settings: options.settings,
		model: request.model,
		thinkingLevel: request.thinkingLevel,
		modelRegistry: request.modelRegistry,
		authStorage: request.modelRegistry.authStorage,
		providerSessionId: `${request.providerSessionPrefix}:${options.agentId}`,
		customTools: options.tools,
		toolNames: options.toolNames,
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
		...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
		...(options.discoverContext ? {} : { contextFiles: [], skills: [], rules: [], promptTemplates: [] }),
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableIrc: false,
		enableLsp: false,
		hasUI: false,
		autoApprove: true,
		agentId: options.agentId,
		agentDisplayName: options.displayName,
		parentTaskPrefix: options.agentId,
		parentAgentId: request.ownerId,
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: request.asyncJobManager,
	});
	return session;
}

/**
 * Body of the `/issue` async job. Returns the job's result text; every
 * user-facing status, including the final one, also goes through `notify`.
 */
export async function runIssueFiling(
	request: IssueFilingRequest,
	ctx: { signal: AbortSignal; reportProgress: (text: string) => Promise<void> },
): Promise<string> {
	const { signal } = ctx;
	const registry = AgentRegistry.global();
	const startedAt = Date.now();
	const notify = (notice: IssueNotice) =>
		request.notify(notice, { requestId: request.requestId, prose: request.prose, notice });

	await ctx.reportProgress("collecting repositories");
	const inventory = await collectIssueTargetInventory({ cwd: request.cwd, settings: request.settings, signal });
	if (inventory.repositories.length === 0) {
		throw new Error(`No GitHub issue target could be verified. ${inventory.warnings.join(" ")}`.trim());
	}

	// Phase 1: choose the tracker.
	const targetAgentId = `IssueTarget-${request.requestId}`;
	let selection: IssueTargetSelection | undefined;
	let declined: string | undefined;
	const targetSession = await createIssueAgent(request, {
		agentId: targetAgentId,
		displayName: "issue target",
		cwd: request.cwd,
		settings: await issueAgentSettings(request.settings, request.cwd),
		tools: [
			createIssueTargetTool({ inventory, onSelect: value => (selection = value) }),
			createIssueDeclineTool({
				onDecline: reason => (declined = reason),
				blocked: () => (selection ? "A target was already selected; it cannot be declined here." : undefined),
			}),
		],
		toolNames: ["issue_target", "issue_decline"],
		systemPrompt: [resolvePromptAsset("issues/target-system.md", targetSystemPrompt).text.trim()],
		discoverContext: false,
	});
	await notify({ kind: "dispatched", agentId: targetAgentId });
	const foreground = inventory.foreground;
	try {
		await ctx.reportProgress("choosing the tracker");
		await converse({
			session: targetSession,
			agentId: targetAgentId,
			request: renderPromptAsset("issues/target-request.md", targetRequestTemplate, {
				requestId: request.requestId,
				prose: request.prose,
				foregroundCwd: shortenPath(request.cwd),
				foregroundRepo: foreground?.repo,
				repositories: describeInventory(inventory),
				warnings: inventory.warnings,
			}),
			done: () => selection !== undefined || declined !== undefined,
			signal,
			notify,
			reportProgress: ctx.reportProgress,
		});
	} finally {
		await retire(registry, targetSession, targetAgentId, signal.aborted);
	}
	// A decline that landed first wins over a contradictory selection in the same tool batch.
	if (declined !== undefined) {
		const outcome: IssueFilingOutcome = { kind: "declined", reason: declined };
		await notify({ kind: "outcome", outcome });
		return renderIssueNotice(request.requestId, request.prose, { kind: "outcome", outcome });
	}
	const target = selection;
	if (!target) throw new Error("No tracker was selected.");

	// Phase 2: author in the target's own checkout and policy.
	const authorAgentId = `Issue-${request.requestId}`;
	let outcome: IssueFilingOutcome | undefined;
	let publicationState: IssuePublicationState | undefined;
	const checkoutPath = target.checkout.path;
	const authorSession = await createIssueAgent(request, {
		agentId: authorAgentId,
		displayName: "issue",
		cwd: checkoutPath,
		settings: await issueAgentSettings(request.settings, checkoutPath),
		tools: createIssueAuthorTools({
			repo: target.candidate.repo,
			checkout: target.checkout,
			startedAt,
			onOutcome: value => (outcome = value),
			onPublication: value => (publicationState = value),
		}),
		toolNames: [
			...AUTHOR_READ_TOOLS,
			"issue_labels",
			"issue_samples",
			"issue_search",
			"issue_view",
			"issue_publish",
			"issue_existing_owner",
			"issue_decline",
		],
		appendSystemPrompt: renderPromptAsset("issues/author-system.md", authorSystemTemplate, {
			repo: target.candidate.repo,
			checkoutPath,
			modelName: request.model.name ?? formatModelString(request.model),
		}),
		discoverContext: true,
	});
	// Keep known or uncertain publication authoritative if the next read or model
	// turn fails; neither cancellation nor a lookup failure proves nothing was filed.
	let conversationError: unknown;
	try {
		await ctx.reportProgress(`authoring for ${target.candidate.repo}`);
		await converse({
			session: authorSession,
			agentId: authorAgentId,
			request: renderPromptAsset("issues/author-request.md", authorRequestTemplate, {
				requestId: request.requestId,
				prose: request.prose,
				repo: target.candidate.repo,
				checkoutPath,
				targetReason: target.reason,
				foregroundCwd: shortenPath(request.cwd),
				foregroundRepo: foreground?.repo,
			}),
			done: () => outcome !== undefined || publicationState !== undefined,
			signal,
			notify,
			reportProgress: ctx.reportProgress,
		});
	} catch (error) {
		conversationError = error;
	} finally {
		await retire(
			registry,
			authorSession,
			authorAgentId,
			signal.aborted && outcome === undefined && publicationState === undefined,
		);
	}
	const settled: IssueFilingOutcome | undefined =
		outcome ??
		(publicationState?.kind === "created"
			? { kind: "published-unread", issue: publicationState.issue }
			: publicationState
				? { kind: "publication-uncertain", repo: publicationState.repo, title: publicationState.title }
				: undefined);
	if (!settled) throw conversationError ?? new Error("The authoring agent ended without an outcome.");
	await notify({ kind: "outcome", outcome: settled });
	return renderIssueNotice(request.requestId, request.prose, { kind: "outcome", outcome: settled });
}
