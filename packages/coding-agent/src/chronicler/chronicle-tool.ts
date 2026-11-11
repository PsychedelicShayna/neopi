import { resolvePromptAsset, renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import bundledChronicleDescription from "../prompts/chronicler/chronicle-tool.md" with { type: "text" };
import bundledFinishDescription from "../prompts/chronicler/finish-tool.md" with { type: "text" };
import bundledReadDescription from "../prompts/chronicler/read-tool.md" with { type: "text" };
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ScopeLike } from "../config/registry";
import { type ChronicleEntry, renderChronicleDelta } from "./render";
import { chroniclerNoteDefinition } from "./note-tool";
import {
	cfgChroniclerCaptureCarryChars,
	cfgChroniclerCaptureReadPageSize,
	cfgChroniclerCaptureReadPageMax,
	cfgChroniclerCaptureReadTitleChars,
} from "./capture-settings";
import {
	type BeatRecord,
	type CaptureBatch,
	type CaptureSource,
	CHRONICLER_BEAT_KINDS,
	type ChroniclerStore,
} from "./store";

const chronicleSchema = type({
	title: "string",
	kind: type.enumerated(...CHRONICLER_BEAT_KINDS),
	body: "string",
	topics: "string[]",
	sources: "string[]",
	"event_time?": "string",
	"related?": "string[]",
	"supersedes?": "string",
	"uncertainty?": "string",
	"chronicler_note?": "string",
});
const finishSchema = type({
	carry: type({ sources: "string[]", text: "string" }).or("null"),
	"recording_limits?": type({ sources: "string[]", text: "string" }).or("null"),
});
function createReadSchema(maximum: number) {
	return type({
		"id?": "string",
		"source?": "string",
		"offset?": type("number.integer >= 0").describe("Metadata page offset; omit id to list beats."),
		"limit?": type("number.integer >= 1")
			.atMost(maximum)
			.describe("Metadata page size; bounded by the configured maximum."),
	});
}
const readSchema = createReadSchema(cfgChroniclerCaptureReadPageMax.default);

const chronicleDefinition = {
	name: "chronicle",
	get description() {
		return resolvePromptAsset("chronicler/chronicle-tool.md", bundledChronicleDescription).text;
	},
	parameters: chronicleSchema,
} as const;
export function getChroniclerToolSchemas(scope?: ScopeLike) {
	const carryChars = scope ? cfgChroniclerCaptureCarryChars.get(scope) : cfgChroniclerCaptureCarryChars.default;
	const pageMax = scope ? cfgChroniclerCaptureReadPageMax.get(scope) : cfgChroniclerCaptureReadPageMax.default;
	const pageSize = Math.min(
		scope ? cfgChroniclerCaptureReadPageSize.get(scope) : cfgChroniclerCaptureReadPageSize.default,
		pageMax,
	);
	return [
		chronicleDefinition,
		{
			name: "finish_chronicle",
			description: renderPromptAsset("chronicler/finish-tool.md", bundledFinishDescription, { carryChars }),
			parameters: finishSchema,
		},
		{
			name: "read_chronicle",
			description: renderPromptAsset("chronicler/read-tool.md", bundledReadDescription, { pageSize, pageMax }),
			parameters: createReadSchema(pageMax),
		},
		chroniclerNoteDefinition,
	] as const;
}

export interface ChronicleDetails {
	id: string;
	path: string;
}
export interface FinishChronicleDetails {
	carry: CaptureBatch["carry"];
	recordingLimits?: CaptureBatch["recordingLimits"];
}
export type ReadChronicleDetails =
	| { id: string; sources: string[] }
	| { source: string }
	| { offset: number; nextOffset: number | null; total: number };

function assertMutable(batch: CaptureBatch, signal?: AbortSignal): void {
	if (signal?.aborted || batch.revoked) throw new ToolError("This capture pass was revoked.");
	if (batch.finalized)
		throw new ToolError("This capture pass is already finalized; no further mutations are allowed.");
}

function validateSources(sources: string[], known: ReadonlyMap<string, CaptureSource>): void {
	if (!sources.length) throw new ToolError("Cite at least one supplied or committed source entry ID.");
	for (const id of sources) {
		if (!known.has(id)) throw new ToolError(`Unknown source entry ID: ${id}`);
	}
}

export class ChronicleTool implements AgentTool<typeof chronicleSchema, ChronicleDetails> {
	readonly name = chronicleDefinition.name;
	readonly label = "Chronicle";
	readonly description = chronicleDefinition.description;
	readonly parameters = chronicleDefinition.parameters;
	// Omitted strict flags can make providers over-fill optional arguments.
	readonly strict = false;
	readonly intent = "omit" as const;

	constructor(
		private readonly store: ChroniclerStore,
		private readonly batch: CaptureBatch,
		private readonly knownSources: ReadonlyMap<string, CaptureSource>,
	) {}

	async execute(
		_id: string,
		args: typeof chronicleSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ChronicleDetails>> {
		assertMutable(this.batch, signal);
		if (!args.title.trim() || !args.body.trim())
			throw new ToolError("A beat needs a nonblank title and standalone body.");
		validateSources(args.sources, this.knownSources);
		let eventTime = args.event_time;
		if (eventTime !== undefined && !Number.isFinite(Date.parse(eventTime)))
			throw new ToolError("event_time must be a valid timestamp.");
		if (eventTime === undefined) {
			for (const id of args.sources) {
				const timestamp = this.knownSources.get(id)!.timestamp;
				if (eventTime === undefined || Date.parse(timestamp) > Date.parse(eventTime)) eventTime = timestamp;
			}
		}
		const relations = [...(args.related ?? []), ...(args.supersedes ? [args.supersedes] : [])];
		for (const id of relations) {
			if (!this.store.beats.some(beat => beat.id === id) && !this.batch.beats.some(beat => beat.id === id)) {
				throw new ToolError(`Unknown related beat ID: ${id}`);
			}
		}
		let beat: BeatRecord;
		try {
			beat = this.store.stageBeat(this.batch, {
				title: args.title,
				kind: args.kind,
				body: args.body,
				topics: args.topics,
				sources: args.sources,
				eventTime: eventTime!,
				related: args.related ?? [],
				supersedes: args.supersedes,
				uncertainty: args.uncertainty,
				chroniclerNote: args.chronicler_note,
			});
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return {
			content: [
				{ type: "text", text: `Staged beat ${beat.id}; publication awaits completion of this capture pass.` },
			],
			details: { id: beat.id, path: beat.path },
		};
	}
}

export class FinishChronicleTool implements AgentTool<typeof finishSchema, FinishChronicleDetails> {
	readonly name = "finish_chronicle";
	readonly label = "Finish Chronicle";
	readonly description: string;
	readonly parameters = finishSchema;
	readonly strict = false;
	readonly intent = "omit" as const;

	constructor(
		_store: ChroniclerStore,
		private readonly batch: CaptureBatch,
		private readonly knownSources: ReadonlyMap<string, CaptureSource>,
		private readonly scope?: ScopeLike,
	) {
		this.description = getChroniclerToolSchemas(scope)[1].description;
	}

	async execute(
		_id: string,
		args: typeof finishSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FinishChronicleDetails>> {
		assertMutable(this.batch, signal);
		let carry: CaptureBatch["carry"] = null;
		if (args.carry) {
			const limit = this.scope
				? cfgChroniclerCaptureCarryChars.get(this.scope)
				: cfgChroniclerCaptureCarryChars.default;
			if (args.carry.text.length > limit)
				throw new ToolError(`Pending carry may not exceed ${limit.toLocaleString("en-US")} characters.`);
			const text = args.carry.text.trim();
			if (text) {
				validateSources(args.carry.sources, this.knownSources);
				carry = { sources: [...new Set(args.carry.sources)], text };
			}
		}
		this.batch.carry = carry;
		if (args.recording_limits !== undefined) {
			if (args.recording_limits === null) this.batch.recordingLimits = null;
			else {
				validateSources(args.recording_limits.sources, this.knownSources);
				const text = args.recording_limits.text.trim();
				if (!text) throw new ToolError("Active recording limits need nonblank text.");
				this.batch.recordingLimits = {
					sources: [...new Set(args.recording_limits.sources)],
					text,
				};
			}
		}
		this.batch.finalized = true;
		return {
			content: [{ type: "text", text: "Capture pass prepared; publication follows successful completion." }],
			details: { carry, recordingLimits: this.batch.recordingLimits },
		};
	}
}

export class ReadChronicleTool implements AgentTool<typeof readSchema, ReadChronicleDetails> {
	readonly name = "read_chronicle";
	readonly label = "Read Chronicle";
	readonly description: string;
	readonly parameters: typeof readSchema;
	readonly strict = false;
	readonly intent = "omit" as const;
	readonly #sourceEntries?: readonly ChronicleEntry[];

	constructor(
		private readonly store: ChroniclerStore,
		private readonly batch: CaptureBatch,
		private readonly obfuscator?: { obfuscate(text: string): string },
		private readonly scope?: ScopeLike,
		sourceEntries?: readonly ChronicleEntry[],
	) {
		this.#sourceEntries = sourceEntries;
		const definition = getChroniclerToolSchemas(scope)[2];
		this.description = definition.description;
		this.parameters = definition.parameters;
	}

	async execute(
		_id: string,
		args: typeof readSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadChronicleDetails>> {
		if (signal?.aborted || this.batch.revoked) throw new ToolError("This capture pass was revoked.");
		let text: string;
		let details: ReadChronicleDetails;
		if (args.source !== undefined) {
			if (args.id !== undefined || args.offset !== undefined || args.limit !== undefined) {
				throw new ToolError("Supply source alone to reread a transcript entry.");
			}
			if (
				!this.store.sourceEntries.has(args.source) &&
				!this.batch.entries.some(entry => entry.id === args.source)
			) {
				throw new ToolError(`Unknown source entry ID: ${args.source}`);
			}
			const entry = this.#sourceEntries?.find(entry => entry.id === args.source);
			if (!entry)
				throw new ToolError(`Source entry is unavailable in this session's visible transcript: ${args.source}`);
			const rendered = renderChronicleDelta([entry], { includeThinking: false })[0];
			text =
				rendered?.role === "user" && Array.isArray(rendered.content)
					? rendered.content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("\n")
					: "";
			details = { source: args.source };
		} else if (args.id !== undefined) {
			if (args.offset !== undefined || args.limit !== undefined)
				throw new ToolError("Supply id alone to read a beat; omit id to list metadata.");
			const beat =
				this.store.beats.find(beat => beat.id === args.id) ?? this.batch.beats.find(beat => beat.id === args.id);
			if (!beat) throw new ToolError(`Unknown beat ID: ${args.id}`);
			const { body, ...metadata } = beat;
			text = `${JSON.stringify(metadata, null, 2)}\n\n# ${beat.title}\n\n${body}`;
			details = { id: beat.id, sources: [...beat.sources] };
		} else {
			const offset = args.offset ?? 0;
			const maximum = this.scope
				? cfgChroniclerCaptureReadPageMax.get(this.scope)
				: cfgChroniclerCaptureReadPageMax.default;
			const defaultSize = this.scope
				? cfgChroniclerCaptureReadPageSize.get(this.scope)
				: cfgChroniclerCaptureReadPageSize.default;
			const limit = args.limit ?? Math.min(defaultSize, maximum);
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > maximum
			) {
				throw new ToolError(
					`offset must be a nonnegative integer; limit must be an integer from 1 through ${maximum}.`,
				);
			}
			const titleChars = this.scope
				? cfgChroniclerCaptureReadTitleChars.get(this.scope)
				: cfgChroniclerCaptureReadTitleChars.default;
			const committed = this.store.beats;
			const beats: Pick<BeatRecord, "id" | "title" | "kind" | "eventTime">[] = [];
			const end = Math.min(committed.length, offset + limit);
			for (let index = offset; index < end; index++) {
				const beat = committed[committed.length - 1 - index];
				// Redact before clipping, then redact the full page for cross-field secrets.
				const title = this.obfuscator?.obfuscate(beat.title) ?? beat.title;
				beats.push({
					id: beat.id,
					title: title.length > titleChars ? `${title.slice(0, titleChars - 1)}…` : title,
					kind: beat.kind,
					eventTime: beat.eventTime,
				});
			}
			details = { offset, nextOffset: end < committed.length ? end : null, total: committed.length };
			text = JSON.stringify({ ...details, beats }, null, 2);
		}
		return {
			content: [{ type: "text", text: this.obfuscator?.obfuscate(text) ?? text }],
			details,
		};
	}
}
