import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { cfgChroniclerRecallEnabled } from "../chronicler/settings";
import { parseTimeBound } from "../chronicler/temporal/calendar";
import { recallDefaultsFromSettings, resolveRanker, resolveViewRoot } from "../chronicler/temporal/config";
import { formatRecallResult } from "../chronicler/temporal/format";
import { recallChronicle } from "../chronicler/temporal/recall";
import chronicleRecallDescription from "../prompts/tools/chronicle-recall.md" with { type: "text" };
import type { ToolSession } from ".";

const chronicleRecallSchema = type({
	query: type("string").describe("what you remember, in any wording"),
	"from?": type("string").describe("earliest time: ISO instant or local YYYY, YYYY-MM, YYYY-MM-DD"),
	"to?": type("string").describe("latest time, same forms as from (prefixes are inclusive)"),
	"project?": type("string").describe("substring of the project (session cwd) path"),
	"session?": type("string").describe("session id or id prefix"),
	"hint?": type("string").describe("an adjacent event remembered from around the same time"),
	"resolution?": type("'year' | 'month' | 'week' | 'day' | 'hour' | 'atom'").describe(
		"stop at this level and return candidate periods (default atom)",
	),
	"node?": type("string").describe("candidate period key from a previous call to search inside"),
	"budget?": type("number").describe("maximum atoms to return"),
});

export type ChronicleRecallParams = typeof chronicleRecallSchema.infer;

/**
 * Explicit recall over the Chronicler temporal view. Granted by
 * `chronicler.recall.enabled`; never injected, never on by default.
 */
export class ChronicleRecallTool implements AgentTool<typeof chronicleRecallSchema> {
	readonly name = "chronicle_recall";
	readonly approval = "read" as const;
	readonly label = "Chronicle Recall";
	readonly description = chronicleRecallDescription;
	readonly parameters = chronicleRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Find captured Chronicler atoms by coarse-to-fine temporal descent";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ChronicleRecallTool | null {
		return cfgChroniclerRecallEnabled.get(session.settings) ? new ChronicleRecallTool(session) : null;
	}

	async execute(_id: string, params: ChronicleRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const settings = this.session.settings;
			const defaults = recallDefaultsFromSettings(settings);
			const result = await recallChronicle({
				root: resolveViewRoot(settings, settings.getAgentDir()),
				query: params.query,
				from: params.from ? parseTimeBound(params.from) : undefined,
				to: params.to ? parseTimeBound(params.to) : undefined,
				project: params.project,
				session: params.session,
				hint: params.hint,
				resolution: params.resolution,
				node: params.node,
				budget: params.budget ?? defaults.budget,
				beam: defaults.beam,
				neighborhoodMinutes: defaults.neighborhoodMinutes,
				ranker: resolveRanker(settings, this.session.modelRegistry),
				signal,
			});
			return {
				content: [{ type: "text", text: formatRecallResult(result) }],
				details: result,
				...(result.results.length === 0 && result.candidates.length === 0 ? { useless: true } : {}),
			};
		});
	}
}
