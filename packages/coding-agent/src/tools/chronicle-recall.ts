import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { cfgChroniclerRecallEnabled } from "../chronicler/settings";
import { parseTimeBound } from "../chronicler/temporal/calendar";
import {
	recallDefaultsFromSettings,
	recallFormatFromSettings,
	resolveRanker,
	resolveViewRoot,
} from "../chronicler/temporal/config";
import { formatRecallResult } from "../chronicler/temporal/format";
import { recallChronicle } from "../chronicler/temporal/recall";
import { parseKeywords, resolveRecallSessions } from "../chronicler/temporal/prefilter";
import { render as renderPrompt } from "@oh-my-pi/pi-utils/prompt";
import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import chronicleRecallDescription from "../prompts/tools/chronicle-recall.md" with { type: "text" };
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const chronicleRecallSchema = type({
	query: type("string").describe("what you remember, in any wording"),
	"from?": type("string").describe("earliest time: ISO instant or local YYYY, YYYY-MM, YYYY-MM-DD"),
	"to?": type("string").describe("latest time, same forms as from (prefixes are inclusive)"),
	"project?": type("string").describe("substring of the project (session cwd) path"),
	"session?": type("string").describe("session id or id prefix"),
	"scope?": type("'current' | 'all' | 'session' | 'sessions'").describe(
		"current session by default; all searches across sessions; session/sessions select ids",
	),
	"sessions?": type("string[]").describe("session ids or prefixes; selects this list instead of the current session"),
	"keywords?": type("string").describe(
		"literal transcript prefilter: AND, OR, parentheses, quoted phrases; AND binds first; searches all sessions unless scope is current",
	),
	"keywordCaseSensitive?": type("boolean").describe("case-sensitive transcript matching (default false)"),
	"hint?": type("string").describe("an adjacent event remembered from around the same time"),
	"resolution?": type("'year' | 'month' | 'week' | 'day' | 'hour' | 'atom'").describe(
		"stop at this level and return candidate periods (default atom)",
	),
	"node?": type("string").describe("candidate period key from a previous call to search inside"),
	"budget?": type("number").describe("maximum atoms to return"),
});

export type ChronicleRecallParams = typeof chronicleRecallSchema.infer;

export interface ChronicleRecallToolDetails {
	async: { state: "running"; jobId: string; type: "chronicle" };
}

/**
 * Explicit recall over the Chronicler temporal view. Granted by
 * `chronicler.recall.enabled`; never injected, never on by default.
 */
export class ChronicleRecallTool implements AgentTool<typeof chronicleRecallSchema, ChronicleRecallToolDetails> {
	readonly name = "chronicle_recall";
	readonly approval = "read" as const;
	readonly label = "Chronicle Recall";
	get description(): string {
		const { text } = resolvePromptAsset("tools/chronicle-recall.md", chronicleRecallDescription, {
			cwd: this.session.cwd,
		});
		return text === chronicleRecallDescription ? text : renderPrompt(text);
	}
	readonly parameters = chronicleRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Find captured Chronicler atoms by coarse-to-fine temporal descent";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ChronicleRecallTool | null {
		return cfgChroniclerRecallEnabled.get(session.settings) ? new ChronicleRecallTool(session) : null;
	}

	async execute(
		_id: string,
		params: ChronicleRecallParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ChronicleRecallToolDetails>> {
		throwIfAborted(signal);
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("Background job manager is unavailable for chronicle recall.");
		const ownerId = this.session.getAgentId?.();
		if (!ownerId) throw new ToolError("Could not identify the session owner for chronicle recall.");

		const settings = this.session.settings;
		const defaults = recallDefaultsFromSettings(settings);
		const root = resolveViewRoot(settings, settings.getAgentDir());
		const ranker = resolveRanker(settings, this.session.modelRegistry);
		const from = params.from ? parseTimeBound(params.from) : undefined;
		const to = params.to ? parseTimeBound(params.to) : undefined;
		if (params.keywords !== undefined) parseKeywords(params.keywords);
		const sessions = resolveRecallSessions({
			...params,
			currentSessionId: this.session.sessionManager?.getSessionId?.() ?? this.session.getSessionId?.() ?? undefined,
		});
		const jobId = manager.register(
			"chronicle",
			params.query.trim().replace(/\s+/g, " ").slice(0, 120) || "Chronicle recall",
			async ({ jobId, signal: jobSignal, reportProgress }) => {
				const asyncDetails = { async: { state: "running" as const, jobId, type: "chronicle" as const } };
				const result = await recallChronicle({
					root,
					query: params.query,
					from,
					to,
					project: params.project,
					sessions,
					keywords: params.keywords,
					keywordCaseSensitive: params.keywordCaseSensitive,
					sessionsDir: path.join(settings.getAgentDir(), "sessions"),
					hint: params.hint,
					resolution: params.resolution,
					node: params.node,
					budget: params.budget ?? defaults.budget,
					beam: defaults.beam,
					neighborhoodMinutes: defaults.neighborhoodMinutes,
					policy: defaults.policy,
					ranker,
					signal: jobSignal,
					onProgress: text => reportProgress(text, asyncDetails),
				});
				return formatRecallResult(result, recallFormatFromSettings(settings));
			},
			{ ownerId },
		);
		return {
			content: [
				{
					type: "text",
					text: `Chronicle recall is running as background job ${jobId}. Results will be delivered automatically when it finishes.`,
				},
			],
			details: { async: { state: "running", jobId, type: "chronicle" } },
		};
	}
}
