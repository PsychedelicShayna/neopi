/**
 * The Mixture of Agents engine. `streamMixture` is model-shaped: invoked like a
 * provider, `(model, context, options) → AssistantMessageEventStream`, and
 * inside one call it walks the graph. Each hop is a fresh, stateless call to a
 * member model with `[role prompt] + [envelope(x)]`; continuity between hops is
 * only the declared transit context. The outer message carries only what a
 * caller may replay (the terminal member's text); the trace is a side channel
 * of `MixtureEvent`s. Nothing here knows about the TUI.
 *
 * This build implements the M1 slice: linear graphs, tools off, no conditions,
 * no back-edges. Phases and checkpoints follow the full design so later
 * milestones extend the dispatcher rather than replace it.
 */
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Usage,
	UsageBreakdownEntry,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import type { JudgmentRequest, JudgmentResult } from "@oh-my-pi/pi-ai/judgment";
import { NON_VISION_IMAGE_PLACEHOLDER, sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_RESERVE_TOKENS, generateSummary } from "@oh-my-pi/pi-agent-core/compaction";
import type {
	MixtureCheckpointReason,
	MixtureEdge,
	MixtureDecision,
	MixtureTraceDetails,
	MixtureTraceHeader,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { mixtureEdgeId } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import {
	FRAME_TOKEN_ESTIMATE,
	compact,
	getPreservedArchive,
	historyBlocks,
	providerFrameBudget,
} from "@oh-my-pi/snapcompact";
import { logger } from "@oh-my-pi/pi-utils";
import type { JudgeKind } from "../judgment";
import { thinkingFromContent } from "../session/messages";
import { clampProviderContextImages, dropUnreadableContextImages } from "../session/provider-image-budget";
import { fitHopRequest, type HopParts, truncateToTokens } from "./budget";
import { decisionState, describeOutcome, failedChoice, routeQuestion, terminateQuestion } from "./decisions";
import {
	DEFAULT_EDGE_ENVELOPE,
	ENTRY_ENVELOPE,
	type EnvelopeContext,
	isInlineTemplate,
	LIMIT_ENVELOPE,
	renderEnvelope,
	renderLimitNotice,
	renderPauseNotice,
	renderVerdict,
	renderToolTrace,
} from "./envelopes";
import { memberSessionId, normalizeToolChoice, prepareHelperCall, prepareMemberCall } from "./member-call";
import { type OuterOutcome, type OuterSettled, OuterWriter, zeroUsage } from "./outer-stream";
import {
	assistantText,
	classifyTail,
	consumptionOf,
	conversationText,
	findAnchor,
	hashMessages,
	isRepeatRequest,
	textHash,
} from "./request";
import type { MixtureRunEntry, MixtureRunLease } from "./run-store";
import {
	cfgMoaBudgetUsd,
	cfgMoaConversationBudgetTokens,
	cfgMoaHardMaxHops,
	cfgMoaMaxHops,
	cfgMoaHardBudgetUsd,
	cfgMoaDecisionStateTokens,
	cfgMoaJudgeMinConfidence,
	cfgMoaOnLimit,
	cfgMoaPartBudgetTokens,
	cfgMoaTranscriptBudgetTokens,
	cfgMoaWallClockMinutes,
} from "./settings";
import { renderTranscript, toolCallSummaries, transcriptMessages } from "./transcript";
import type {
	HopRecord,
	MixtureCheckpoint,
	MixtureEvent,
	MixtureHost,
	MixtureRun,
	MixtureRunKey,
	OuterResponseRecord,
	OuterStreamOptions,
	PendingResponse,
	ResolvedMixture,
	ResolvedModelMember,
	SerializedMixtureRun,
	Settlement,
	ToolRequirement,
} from "./types";

/** Error codes the engine puts at the start of an outer error message. */
const ERROR_PREFIX = {
	contextExceeded: "hop.context_exceeded",
	toolForbidden: "member.tool.forbidden",
	unsatisfiable: "toolchoice.unsatisfiable",
	unsupported: "toolchoice.unsupported",
} as const;

/** The outer error message of a caller abort; the caller's loop words its own copy. */
const CALLER_ABORT_MESSAGE = "Request was aborted";
const FINALIZED = new Error("mixture request finalized");

function limitReason(limit: "hops" | "budget" | "wall_clock" | "hard_cap", value: string): string {
	switch (limit) {
		case "hops":
			return `the ${value}-hop limit was reached`;
		case "budget":
			return `the ${value} budget limit was reached`;
		case "wall_clock":
			return `the ${value} wall-clock limit was reached`;
		case "hard_cap":
			return `the hard cap of ${value} was reached`;
	}
}

/** Add each reported counter of `add` into `total`; a counter no attempt reported stays absent. */
function addCounters<T extends Record<string, number | undefined>>(
	total: T | undefined,
	add: T | undefined,
): T | undefined {
	if (!add) return total;
	const sum: Record<string, number | undefined> = { ...total };
	for (const [key, value] of Object.entries(add)) {
		if (value !== undefined) sum[key] = (sum[key] ?? 0) + value;
	}
	return sum as T;
}

/**
 * Sum one settled attempt into a response total. Every additive meter is kept
 * (premium requests, credits, server tools, cache TTLs, orchestration);
 * `contextTokens` is not additive and is set from the outer context instead.
 */
function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.reasoningTokens !== undefined)
		total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens;
	if (usage.premiumRequests !== undefined)
		total.premiumRequests = (total.premiumRequests ?? 0) + usage.premiumRequests;
	const credits = addCounters(total.credits, usage.credits);
	if (credits) total.credits = credits;
	const server = addCounters(total.server, usage.server);
	if (server) total.server = server;
	const cttl = addCounters(total.cttl, usage.cttl);
	if (cttl) total.cttl = cttl;
	const orchestration = addCounters(total.orchestration, usage.orchestration);
	if (orchestration) total.orchestration = orchestration;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

function sumSettlements(settlements: readonly Settlement[]): Usage {
	const total = zeroUsage();
	for (const settlement of settlements) addUsage(total, settlement.usage);
	return total;
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** A run as persisted: the resolution reduced to its revision and definition. */
export function serializeRun(run: MixtureRun): SerializedMixtureRun {
	const { resolved, ...rest } = run;
	return {
		...structuredClone(rest),
		resolved: { revision: resolved.revision, definition: structuredClone(resolved.definition) },
	};
}

/**
 * The host's acknowledgement that it durably recorded the outer response:
 * marks it committed and advances the reporting watermark and the cursor. The
 * one place either advances. Returns the committed record, or undefined when
 * the run holds no uncommitted response with that id.
 */
export function commitMixtureResponse(run: MixtureRun, responseId: string): OuterResponseRecord | undefined {
	const record = run.outerResponses.find(response => response.responseId === responseId);
	if (!record || record.committed) return undefined;
	record.committed = true;
	run.reportedThrough = Math.max(run.reportedThrough, record.report.to);
	run.cursor = record.consumed;
	return record;
}

/**
 * The step-0 rejection for a caller that requires a tool call (`any`/`named`) no
 * member may produce; undefined when the requirement is satisfiable or optional.
 */
function unsatisfiableRequirement(resolved: ResolvedMixture, requirement: ToolRequirement): string | undefined {
	if (requirement.kind !== "any" && requirement.kind !== "named") return undefined;
	const satisfiable = Object.values(resolved.members).some(
		member =>
			member.kind === "model" &&
			member.toolPolicy !== false &&
			(requirement.kind === "any" || member.toolPolicy === true || member.toolPolicy.includes(requirement.name)),
	);
	if (satisfiable) return undefined;
	const wanted = requirement.kind === "any" ? "a tool call" : `a call to ${requirement.name}`;
	return `${ERROR_PREFIX.unsatisfiable}: the caller requires ${wanted}, but no member of mixture/${resolved.definition.name} may call tools`;
}

/** Run a mixture as a model. The session host is the only M1 caller. */
export function streamMixture(
	model: Model<Api>,
	context: Context,
	options: OuterStreamOptions | undefined,
	host: MixtureHost,
) {
	const writer = new OuterWriter(model);
	void new MixtureCall(model, context, options ?? {}, host, writer).run().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("mixture engine failed", { mixture: model.id, error: message });
		writer.finish({ outcome: { kind: "error", reason: "error", message }, usage: zeroUsage() });
	});
	return writer.stream;
}

type MemberOutcome =
	| { kind: "done"; message: AssistantMessage; truncated: boolean }
	| { kind: "failed"; message: string; status?: number; errorId?: number }
	| { kind: "deadline" };

class MixtureCall {
	readonly #model: Model<Api>;
	readonly #context: Context;
	readonly #options: OuterStreamOptions;
	readonly #host: MixtureHost;
	readonly #writer: OuterWriter;
	#entry!: MixtureRunEntry;
	#lease: MixtureRunLease | undefined;
	/** The run this call drives, once classification picked or started one. */
	#run: MixtureRun | undefined;
	/** Terminal member text streamed live on this call. */
	#streamedLive = false;
	#liveHop: number | undefined;
	/**
	 * A caller abort finished this request's outer response. What is still in
	 * flight afterwards only settles usage, late.
	 */
	#finalized = false;
	#deadline: AbortSignal | undefined;
	readonly #onCallerAbort = (): void => {
		try {
			this.#finalizeAbort();
		} catch (error) {
			logger.error("mixture abort finalization failed", {
				mixture: this.#model.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	constructor(
		model: Model<Api>,
		context: Context,
		options: OuterStreamOptions,
		host: MixtureHost,
		writer: OuterWriter,
	) {
		this.#model = model;
		this.#context = context;
		this.#options = options;
		this.#host = host;
		this.#writer = writer;
	}

	async run(): Promise<void> {
		const name = this.#model.id;
		const requirement = normalizeToolChoice(this.#options.toolChoice);
		if ("unsupported" in requirement) {
			return this.#reject(
				`${ERROR_PREFIX.unsupported}: mixture/${name} cannot promise the native tool choice "${requirement.unsupported}"`,
			);
		}
		const signal = this.#options.signal;
		// Aborted before the engine could register its finalizer: touch no run state.
		if (signal?.aborted) {
			return this.#writer.finish({
				outcome: { kind: "error", reason: "aborted", message: CALLER_ABORT_MESSAGE },
				usage: zeroUsage(),
			});
		}
		const key: MixtureRunKey = {
			host: this.#host.id,
			mixture: name,
			lineage: [],
			conversation: this.#host.conversationKey(this.#context, this.#options),
		};
		const lease = this.#host.runs.acquire(key);
		if (!lease) return this.#reject(`mixture run ${name} is busy`);
		this.#lease = lease;
		this.#entry = lease.entry;
		this.#writer.holdTerminal();
		// Registered before streamMixture returns: every abort listener runs inside the
		// same abort() call, while the caller's loop copies the outer message only on a
		// later microtask, so the finalizer's writes are always in that copy.
		signal?.addEventListener("abort", this.#onCallerAbort, { once: true });
		try {
			await this.#classify(key, requirement);
		} finally {
			signal?.removeEventListener("abort", this.#onCallerAbort);
			lease.release();
			this.#writer.releaseTerminal();
		}
	}

	/** An outer error that never touched run state: nothing to report, nothing to replay. */
	#reject(message: string): void {
		this.#writer.finish({ outcome: { kind: "error", reason: "error", message }, usage: zeroUsage() });
	}

	// -----------------------------------------------------------------------
	// Step 0: classify the call
	// -----------------------------------------------------------------------

	async #classify(key: MixtureRunKey, requirement: ToolRequirement): Promise<void> {
		const messages = this.#context.messages;
		const existing = this.#entry.run;

		// Step 0a: a repeat of the last request, checked before the cursor. The requirement
		// belongs to this call, not to the request it repeats: check it before any replay.
		if (existing && existing.status !== "done" && isRepeatRequest(existing, messages)) {
			const unsatisfiable = unsatisfiableRequirement(existing.resolved, requirement);
			if (unsatisfiable) return this.#reject(unsatisfiable);
			const outcome = existing.lastRequest.outcome;
			if (outcome === "responded") {
				const pending = existing.outerResponses.find(
					response => response.responseId === existing.lastRequest.responseId,
				);
				if (pending) return this.#replay(existing, pending);
			}
			// in_progress resumes; failed retries: both continue at the pinned phase.
			existing.status = "running";
			return this.#loop(existing);
		}
		if (existing?.status === "done" && isRepeatRequest(existing, messages)) {
			const pending = existing.outerResponses.find(
				response => response.responseId === existing.lastRequest.responseId,
			);
			if (pending) {
				const unsatisfiable = unsatisfiableRequirement(existing.resolved, requirement);
				if (unsatisfiable) return this.#reject(unsatisfiable);
				return this.#replay(existing, pending);
			}
		}

		// Step 0b: anchor, then walk the tail.
		const found = existing ? findAnchor(existing, messages) : undefined;
		const anchor = found?.index ?? -1;
		const tail = messages.slice(anchor + 1);
		const classified = classifyTail(tail);
		const request = {
			fingerprint: hashMessages(tail),
			consumedCount: anchor + 1,
			consumedHash: hashMessages(messages.slice(0, anchor + 1)),
			outcome: "in_progress" as const,
		};
		if (existing?.status === "paused" && classified.operator) {
			const unsatisfiable = unsatisfiableRequirement(existing.resolved, requirement);
			if (unsatisfiable) return this.#reject(unsatisfiable);
			return this.#resume(existing, request);
		}

		if (classified.operator) {
			// A prompt on a finished, errored, or checkpointed run starts a new run; steering
			// into a checkpointed run arrives with M3.
			const prompt = classified.operator;
			const conversation = conversationText(messages.slice(0, anchor + 1 + prompt.index));
			return this.#startRun(key, requirement, request, prompt.text, prompt.images, conversation);
		}
		if (classified.toolResults.length > 0) {
			return this.#reject("mixture run state does not match these tool results; send a new message");
		}
		if (existing?.status === "checkpoint") {
			const unsatisfiable = unsatisfiableRequirement(existing.resolved, requirement);
			if (unsatisfiable) return this.#reject(unsatisfiable);
			existing.lastRequest = request;
			existing.status = "running";
			return this.#loop(existing);
		}
		// Recovery retry: a cursor anchor means no message carries any response of this run, so
		// the session dropped the one it was given (empty-stop recovery, a loop-detector retry)
		// and continued with its own reminder. Re-run the request; the reminder reaches no member.
		if ((existing?.status === "done" || existing?.status === "error") && found?.kind === "cursor") {
			return this.#startRun(
				key,
				requirement,
				request,
				existing.topic,
				this.#entry.topicImages,
				this.#entry.conversation,
			);
		}
		return this.#reject("mixture received no new input");
	}

	#resume(run: MixtureRun, request: MixtureRun["lastRequest"]): Promise<void> {
		run.window = { hops: 0, usd: 0, startedAt: Date.now() };
		run.status = "running";
		run.lastRequest = request;
		this.#emit({
			type: "resume",
			run,
			note: `${run.key.mixture} resumed with a fresh window; your message was not forwarded to the members (steering arrives with M3)`,
		});
		return this.#loop(run);
	}

	async #startRun(
		key: MixtureRunKey,
		requirement: ToolRequirement,
		request: MixtureRun["lastRequest"],
		topic: string,
		images: MixtureRunEntry["topicImages"],
		conversation: string,
	): Promise<void> {
		const resolved = this.#host.resolveRun(key.mixture);
		if (typeof resolved === "string") return this.#reject(resolved);
		const unsatisfiable = unsatisfiableRequirement(resolved, requirement);
		if (unsatisfiable) return this.#reject(unsatisfiable);
		const now = Date.now();
		const run: MixtureRun = {
			id: Bun.randomUUIDv7(),
			key,
			resolved,
			topic,
			lastRequest: request,
			status: "running",
			phase: { kind: "hop_ready", memberId: resolved.definition.entry },
			hops: [],
			activeMemberId: resolved.definition.entry,
			traversals: {},
			summaries: {},
			settlements: [],
			reportedThrough: 0,
			appliedToolResultIds: [],
			window: { hops: 0, usd: 0, startedAt: now },
			lifetime: { hops: 0, usd: 0, startedAt: now },
			outerResponses: [],
			toolRequirement: requirement.kind === "any" || requirement.kind === "named" ? requirement : undefined,
			seq: 0,
		};
		this.#host.runs.install(this.#entry, run);
		this.#entry.topicImages = images;
		this.#entry.providerState = new Map();
		this.#entry.conversation = conversation;
		this.#emit({
			type: "run_start",
			run,
			trace: {
				...this.#header(run),
				kind: "run_start",
				topic,
				members: Object.values(resolved.members).map(member => ({
					id: member.id,
					description: member.description,
					model: member.kind === "model" ? modelLabel(member.model) : undefined,
				})),
			},
		});
		return this.#loop(run);
	}

	// -----------------------------------------------------------------------
	// Step 1: the phase loop
	// -----------------------------------------------------------------------

	async #loop(run: MixtureRun): Promise<void> {
		this.#run = run;
		while (run.status === "running" && !this.#finalized) {
			const phase = run.phase;
			switch (phase.kind) {
				case "hop_ready":
					await this.#hopReady(run, phase.memberId, phase.edgeInId);
					break;
				case "decision_pending":
					await this.#decide(run, phase.hop);
					if (this.#finalized) return;
					break;
				case "finalizing":
					return this.#finalize(run);
				case "ended":
					return;
				default:
					return this.#fail(run, undefined, {
						kind: "failed",
						message: `mixture phase ${phase.kind} is not supported by this build`,
					});
			}
		}
	}

	async #hopReady(run: MixtureRun, memberId: string, edgeInId: string | undefined): Promise<void> {
		if (this.#checkLimits(run, "hop_ready")) return;
		const settings = this.#host.settings;

		const edge =
			edgeInId && edgeInId !== "limit"
				? run.resolved.definition.edges.find(candidate => mixtureEdgeId(candidate) === edgeInId)
				: undefined;
		const source =
			edgeInId === "limit"
				? run.hops.findLast(hop => hop.status === "done")
				: edge
					? run.hops.findLast(hop => hop.memberId === edge.from && hop.status === "done")
					: undefined;
		const member = run.resolved.members[memberId];
		if (member?.kind === "verdict") return this.#verdictHop(run, member, edge, source);
		if (member?.kind !== "model") {
			return this.#fail(run, undefined, { kind: "failed", message: `member ${memberId} is not defined` });
		}
		const template =
			edgeInId === "limit"
				? run.resolved.envelopes[LIMIT_ENVELOPE]
				: edge
					? this.#edgeTemplate(run.resolved, edge)
					: run.resolved.envelopes[ENTRY_ENVELOPE];
		if (template === undefined) {
			return this.#fail(run, undefined, {
				kind: "failed",
				message: `mixture ${run.key.mixture}: ${edgeInId === "limit" ? "limit " : ""}envelope missing`,
			});
		}

		const envelopeContext = this.#envelopeContext(run, member, edge, source);
		if (edgeInId === "limit") {
			envelopeContext.limit = run.limitHop;
			if (source) {
				const from = run.resolved.members[source.memberId];
				envelopeContext.from = {
					id: source.memberId,
					description: from?.description,
					model: from?.kind === "model" ? modelLabel(from.model) : "verdict",
				};
			}
			envelopeContext.x.transcript = this.#verbatimTranscript(
				run.hops.filter(hop => hop.status === "done"),
				cfgMoaTranscriptBudgetTokens.get(settings),
				new Tokenizer(member.model),
			);
		}
		const systemPrompt = [...(member.inherit ? (this.#context.systemPrompt ?? []) : []), member.rolePrompt].filter(
			text => text !== "",
		);
		const settlementsBefore = run.settlements.length;
		let transcript: { text: string; blocks: (TextContent | ImageContent)[] } = { text: "", blocks: [] };
		if (edge?.x.transcript) {
			try {
				transcript = await this.#transcriptPart(run, edge, member, systemPrompt);
			} catch (error) {
				if (this.#finalized) return;
				if (this.#deadlineFired()) return this.#onTranscriptDeadline(run);
				return this.#fail(run, undefined, {
					kind: "failed",
					message: `helper.failed: transcript for edge ${mixtureEdgeId(edge)}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		if (this.#finalized) return;
		if (settlementsBefore !== run.settlements.length && this.#checkLimits(run, "hop_ready")) return;
		if (edge?.x.transcript) envelopeContext.x.transcript = transcript.text;
		const assemble = (parts: HopParts) =>
			renderEnvelope(template, {
				...envelopeContext,
				conversation: parts.conversation ?? "",
				x: {
					output: parts.output,
					input: parts.input,
					reasoning: parts.reasoning,
					tool_trace: parts.toolTrace,
					transcript: parts.transcript,
				},
			});
		// Match the member's outbound image transforms before fitting. Reuse their
		// surviving blocks in the request, so discarded or wire-stripped images
		// are neither charged nor sent a second time.
		const entryImages = edgeInId === undefined ? this.#entry.topicImages : [];
		let entryContext: Context | undefined;
		if (entryImages.length > 0) {
			const imageMessage: UserMessage = { role: "user", content: entryImages, timestamp: 0 };
			entryContext = sendsImageInputOnWire(member.model)
				? await dropUnreadableContextImages(
						clampProviderContextImages({ systemPrompt: [], messages: [imageMessage] }, member.model),
						member.model,
					)
				: {
						systemPrompt: [],
						messages: [
							{
								...imageMessage,
								content: [{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER }],
							},
						],
					};
		}
		// An abort may finalize and checkpoint this run while image decoding is
		// pending; do not append a hop after that terminal transition.
		if (this.#finalized) return;
		const entryMessage = entryContext?.messages[0];
		const entryParts =
			entryMessage?.role === "user" && Array.isArray(entryMessage.content) ? entryMessage.content : [];
		const fitted = fitHopRequest({
			target: member.model,
			maxTokens: member.maxTokens,
			systemPrompt,
			assemble,
			parts: { ...partsOf(envelopeContext.x), conversation: envelopeContext.conversation },
			attachments: transcript.blocks,
			// The entry blocks join the envelope after fitting. Count them now
			// without counting the envelope's text twice.
			hopMessages: entryContext?.messages ?? [],
			partBudgetTokens: cfgMoaPartBudgetTokens.get(settings),
		});
		if (!fitted.ok) {
			return this.#fail(run, undefined, {
				kind: "failed",
				message: `${ERROR_PREFIX.contextExceeded}: member ${member.id}'s hop needs ${fitted.neededTokens} tokens but ${fitted.availableTokens} fit; lower max_traversals or narrow the tool allow-list`,
			});
		}
		const input = fitted.envelope;

		const hop: HopRecord = {
			index: run.hops.length + 1,
			memberId,
			edgeInId,
			input,
			messages: [],
			output: "",
			reasoning: "",
			toolTrace: "",
			decisions: [],
			status: "running",
			startedAt: Date.now(),
		};
		run.hops.push(hop);
		run.lifetime.hops++;
		run.window.hops++;
		run.activeMemberId = memberId;
		// Transient: never persisted; an error or abort stores the hop_ready continuation instead.
		run.phase = { kind: "generating", hop: hop.index };
		this.#emit({ type: "hop_start", run, hop, model: member.model, trace: this.#hopTrace(run, hop, member) });

		const envelopeMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: input }, ...transcript.blocks, ...entryParts],
			attribution: "agent",
			timestamp: Date.now(),
		};
		const memberContext: Context = {
			systemPrompt,
			messages: [envelopeMessage, ...hop.messages],
		};
		const prepared = await this.#host.prepareContext(memberContext, member.model);
		// A caller abort finalized the request meanwhile: start no member call.
		if (this.#finalized) return;
		const outcome = await this.#generate(run, hop, member, prepared);
		if (this.#finalized) return;
		this.#afterGenerate(run, hop, member, outcome);
	}

	#edgeTemplate(resolved: ResolvedMixture, edge: MixtureEdge): string | undefined {
		const reference = edge.envelope ?? DEFAULT_EDGE_ENVELOPE;
		return isInlineTemplate(reference) ? reference : resolved.envelopes[reference];
	}

	#onTranscriptDeadline(run: MixtureRun): void {
		this.#onSoftLimit(run, "wall_clock", this.#wallClockValue(run));
	}

	#guard(): void {
		if (this.#finalized) throw FINALIZED;
	}

	#deadlineFired(): boolean {
		return this.#deadline?.aborted === true && this.#options.signal?.aborted !== true;
	}

	#callSignal(run: MixtureRun, hop?: Pick<HopRecord, "edgeInId">): AbortSignal {
		if (hop?.edgeInId === "limit") {
			this.#deadline = undefined;
			return this.#options.signal ?? new AbortController().signal;
		}
		const minutes =
			run.resolved.definition.limits?.wallClockMinutes ?? cfgMoaWallClockMinutes.get(this.#host.settings);
		const remaining = run.window.startedAt + minutes * 60_000 - Date.now();
		this.#deadline = AbortSignal.timeout(Math.max(1, remaining));
		return this.#options.signal ? AbortSignal.any([this.#options.signal, this.#deadline]) : this.#deadline;
	}

	#verbatimTranscript(done: readonly HopRecord[], budget: number, tokenizer: Tokenizer): string {
		const full = renderTranscript(done);
		if (done.length <= 2 || tokenizer.countTokens(full) <= budget) return full;
		return `[… ${done.length - 2} earlier hops omitted]\n\n${renderTranscript(done.slice(-2))}`;
	}

	/** Fold only completed hop outputs; the two newest hops remain verbatim. */
	async #transcriptPart(
		run: MixtureRun,
		edge: MixtureEdge,
		member: ResolvedModelMember,
		systemPrompt: string[],
	): Promise<{ text: string; blocks: (TextContent | ImageContent)[] }> {
		const spec = edge.x.transcript === true ? {} : edge.x.transcript;
		const budget = spec?.budgetTokens ?? cfgMoaTranscriptBudgetTokens.get(this.#host.settings);
		const tokenizer = new Tokenizer(member.model);
		const done = run.hops.filter(hop => hop.status === "done");
		const full = renderTranscript(done);
		if (tokenizer.countTokens(full) <= budget) return { text: full, blocks: [] };
		const recent = done.slice(-2);
		const fold = done.slice(0, -2);
		if (fold.length === 0) return { text: full, blocks: [] };
		const edgeId = mixtureEdgeId(edge);
		const cursor = run.summaries[edgeId] ?? { throughHop: 0 };
		const newFold = fold.filter(hop => hop.index > cursor.throughHop);
		if ((spec?.optimize ?? "verbatim") === "verbatim") {
			return { text: `[… ${fold.length} earlier hops omitted]\n\n${renderTranscript(recent)}`, blocks: [] };
		}
		const compactText = async (): Promise<{ text: string; blocks: (TextContent | ImageContent)[] }> => {
			const summaryModel = run.resolved.summaryModel;
			if (!summaryModel) throw new Error("helper.unresolved: moa.summary_model is not resolved for this run");
			if (newFold.length > 0) {
				const apiKey = this.#host.resolver(summaryModel, memberSessionId(run, "summary"), () => {});
				if (!apiKey) throw new Error("helper.unresolved: no credential for the summary model");
				const summary = await generateSummary(
					transcriptMessages(newFold),
					summaryModel,
					DEFAULT_RESERVE_TOKENS,
					apiKey,
					this.#callSignal(run),
					undefined,
					cursor.text,
					{ completeImpl: (model, context, options) => this.#completeViaHost(run, model, context, options) },
				);
				this.#guard();
				run.summaries[edgeId] = { text: summary, throughHop: fold.at(-1)!.index };
			}
			return {
				text: `[hops 1–${fold.at(-1)!.index} summarized]\n${run.summaries[edgeId]?.text ?? ""}\n\n${renderTranscript(recent)}`,
				blocks: [],
			};
		};
		if (spec?.optimize === "compact") return compactText();
		const reserveOutput = member.maxTokens ?? Math.min(member.model.maxTokens ?? 16_384, 16_384);
		const remaining = Math.max(
			0,
			(member.model.contextWindow ?? Number.POSITIVE_INFINITY) -
				reserveOutput -
				tokenizer.countTokens(systemPrompt) -
				budget,
		);
		const frames = Math.min(providerFrameBudget(member.model.provider), Math.floor(remaining / FRAME_TOKEN_ESTIMATE));
		if (frames < 1) {
			logger.warn("mixture transcript degraded to compact", {
				mixture: run.key.mixture,
				edge: edgeId,
				reason: "no frame budget",
			});
			return compactText();
		}
		if (newFold.length > 0) {
			const result = await compact(
				{
					firstKeptEntryId: `moa:${run.id}:${edgeId}:${cursor.throughHop}`,
					messagesToSummarize: transcriptMessages(newFold),
					turnPrefixMessages: [],
					tokensBefore: tokenizer.countMessages(transcriptMessages(fold)),
					previousPreserveData: cursor.preserveData,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				},
				{ model: member.model, includeThinking: false, maxFrames: frames },
			);
			this.#guard();
			if (!getPreservedArchive(result.preserveData)) {
				logger.warn("mixture transcript degraded to compact", {
					mixture: run.key.mixture,
					edge: edgeId,
					reason: "no archive",
				});
				return compactText();
			}
			run.summaries[edgeId] = {
				text: result.summary,
				preserveData: result.preserveData,
				throughHop: fold.at(-1)!.index,
			};
		}
		const summary = run.summaries[edgeId];
		const archive = getPreservedArchive(summary?.preserveData);
		return {
			text: `${summary?.text ?? ""}\n\n${renderTranscript(recent)}`,
			blocks: archive ? historyBlocks(archive) : [],
		};
	}

	/** Drain and settle helper streams even when an abort finalized the outer response. */
	async #completeViaHost(
		run: MixtureRun,
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions,
	): Promise<AssistantMessage> {
		const prepared = await this.#host.prepareContext(context, model);
		this.#guard();
		const stream = await this.#host.stream(model, prepared, {
			...options,
			...prepareHelperCall(this.#options, run, model, "summary", this.#host, this.#entry),
			signal: options.signal,
		});
		let final: AssistantMessage | undefined;
		let failed = false;
		for await (const event of stream) {
			if (event.type === "done") final = event.message;
			else if (event.type === "error") {
				final = event.error;
				failed = true;
			}
		}
		if (final?.usage) {
			this.#settle(run, undefined, {
				kind: "summary",
				api: final.api,
				provider: final.provider,
				model: final.model,
				usage: final.usage,
				stopReason: final.stopReason,
				errorMessage: final.errorMessage,
				failed: failed || undefined,
			});
		}
		this.#guard();
		if (failed || !final) throw new Error(final?.errorMessage ?? "summary stream ended without a result");
		return final;
	}

	#envelopeContext(
		run: MixtureRun,
		member: ResolvedModelMember,
		edge: MixtureEdge | undefined,
		source: HopRecord | undefined,
	): EnvelopeContext {
		const members = Object.values(run.resolved.members).map(candidate => ({
			id: candidate.id,
			description: candidate.description,
			model: candidate.kind === "model" ? modelLabel(candidate.model) : "verdict",
		}));
		const find = (id: string) => members.find(candidate => candidate.id === id);
		const x: EnvelopeContext["x"] = {};
		if (edge && source) {
			if (edge.x.output) x.output = source.output;
			if (edge.x.input) x.input = source.input;
			if (edge.x.reasoning) x.reasoning = source.reasoning;
			if (edge.x.toolTrace) x.tool_trace = source.toolTrace;
		}
		const tokenizer = new Tokenizer(member.model);
		const conversation = this.#entry.conversation
			? truncateToTokens(
					this.#entry.conversation,
					cfgMoaConversationBudgetTokens.get(this.#host.settings),
					tokenizer,
				)
			: "";
		return {
			mixture: { name: run.resolved.definition.name, member_count: members.length, members },
			topic: run.topic,
			conversation,
			from: edge ? find(edge.from) : undefined,
			to: find(member.id) ?? { id: member.id, model: modelLabel(member.model) },
			edge: edge ? { id: mixtureEdgeId(edge), traversal: run.traversals[mixtureEdgeId(edge)] ?? 0 } : undefined,
			hop: run.hops.length + 1,
			x,
		};
	}

	async #generate(
		run: MixtureRun,
		hop: HopRecord,
		member: ResolvedModelMember,
		context: Context,
	): Promise<MemberOutcome> {
		const options = prepareMemberCall(
			{ ...this.#options, signal: this.#callSignal(run, hop) },
			run,
			member,
			this.#host,
			this.#entry,
		);
		const definition = run.resolved.definition;
		const definitionMember = definition.members.find(candidate => candidate.id === member.id);
		const structurallyTerminal =
			!definition.edges.some(edge => edge.from === member.id) &&
			!(definitionMember && definitionMember.kind !== "verdict" && definitionMember.terminate);
		const live = structurallyTerminal && !run.toolRequirement;
		let final: AssistantMessage | undefined;
		let terminal: "done" | "error" | undefined;
		try {
			const stream = await this.#host.stream(member.model, context, options);
			for await (const event of stream) {
				if (event.type === "text_delta" && live) {
					if (this.#liveHop !== hop.index) {
						if (this.#streamedLive) this.#writer.appendText("\n\n");
						this.#liveHop = hop.index;
					}
					this.#writer.appendText(event.delta);
					this.#streamedLive = true;
				} else if (event.type === "done") {
					final = event.message;
					terminal = "done";
				} else if (event.type === "error") {
					final = event.error;
					terminal = "error";
				}
			}
		} catch (error) {
			logger.warn("mixture member stream threw", {
				mixture: run.key.mixture,
				member: member.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (final?.usage) {
			const stopReason = final.stopReason;
			this.#settle(run, hop, {
				kind: "member",
				hop: hop.index,
				api: final.api,
				provider: final.provider,
				model: final.model,
				usage: final.usage,
				stopReason,
				errorMessage: final.errorMessage,
				failed: stopReason === "error" || stopReason === "aborted" || undefined,
			});
		}
		if (this.#deadlineFired() && (!final || final.stopReason === "aborted")) return { kind: "deadline" };
		if (!final || !terminal) {
			return { kind: "failed", message: `member ${member.id} stream ended without a result` };
		}
		if (terminal === "error") {
			return {
				kind: "failed",
				message: final.errorMessage ?? `member ${member.id} failed`,
				status: final.errorStatus,
				errorId: final.errorId,
			};
		}
		return { kind: "done", message: final, truncated: final.stopReason === "length" };
	}

	#afterGenerate(run: MixtureRun, hop: HopRecord, member: ResolvedModelMember, outcome: MemberOutcome): void {
		hop.elapsedMs = Date.now() - hop.startedAt;
		if (outcome.kind === "deadline") {
			hop.status = "aborted";
			hop.output = "";
			this.#normalizeContinuation(run, hop);
			this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, member) });
			return this.#onSoftLimit(run, "wall_clock", this.#wallClockValue(run));
		}
		if (outcome.kind === "failed") return this.#fail(run, hop, outcome);
		const message = outcome.message;
		const calls = message.content.filter(block => block.type === "toolCall");
		if (calls.length > 0 && !outcome.truncated) {
			// Tools are off for every member in this build: any executable call is outside the policy.
			const names = calls.map(call => (call.type === "toolCall" ? call.name : "")).join(", ");
			return this.#fail(run, hop, {
				kind: "failed",
				message: `${ERROR_PREFIX.toolForbidden}: member ${member.id} called ${names}, but its tools are off`,
			});
		}
		hop.messages = [message];
		hop.output = assistantText(message);
		hop.reasoning = thinkingFromContent(message.content);
		hop.toolTrace = renderToolTrace(toolCallSummaries(hop.messages));
		if (outcome.truncated) {
			hop.truncated = true;
			logger.warn("mixture member stopped at its length limit", { mixture: run.key.mixture, member: member.id });
		}
		hop.status = "done";
		run.phase = { kind: "decision_pending", hop: hop.index };
		this.#checkpoint(run, "hop");
	}

	#decisionTokenizer(run: MixtureRun): Tokenizer {
		return new Tokenizer(run.resolved.judgePlan?.[0]?.model ?? null);
	}

	#decisionState(
		run: MixtureRun,
		hop: HopRecord,
		selected: readonly ("output" | "input" | "toolTrace")[] = [],
	): Record<string, string> {
		const parts: Record<string, string | undefined> = { topic: run.topic, output: hop.output };
		for (const part of selected) parts[part] = hop[part];
		return decisionState(parts, cfgMoaDecisionStateTokens.get(this.#host.settings), this.#decisionTokenizer(run));
	}

	async #judge(
		run: MixtureRun,
		hop: HopRecord,
		request: JudgmentRequest,
	): Promise<{ result: JudgmentResult; kind: JudgeKind }> {
		const plan = run.resolved.judgePlan;
		if (!plan) throw new Error("no judge plan");
		const judge = this.#host.judge(plan, attempt =>
			this.#settle(run, hop, {
				kind: "judge",
				hop: hop.index,
				api: attempt.api,
				provider: attempt.provider,
				model: attempt.model,
				usage: attempt.usage,
				stopReason: attempt.stopReason,
				errorMessage: attempt.errorMessage,
				failed: attempt.stopReason === "error" || attempt.stopReason === "aborted" || undefined,
			}),
		);
		const signal = this.#callSignal(run);
		return judge.withCandidate(
			async (candidate, kind) => ({ result: await candidate.judge(request, { signal }), kind }),
			{ signal },
		);
	}

	#recordDecision(run: MixtureRun, hop: HopRecord, decision: MixtureDecision): void {
		hop.decisions.push(decision);
		this.#emit({
			type: "decision",
			run,
			hop,
			trace: {
				...this.#header(run),
				kind: "decision",
				hop: hop.index,
				memberId: hop.memberId,
				decision,
			},
		});
	}

	#publishHop(
		run: MixtureRun,
		hop: HopRecord,
		member: ResolvedMixture["members"][string] | undefined,
		edgeOutId?: string,
	): void {
		if (hop.published) return;
		hop.published = true;
		this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, member, edgeOutId) });
	}

	#leaveDecision(run: MixtureRun, hop: HopRecord, member: ResolvedMixture["members"][string] | undefined): void {
		if (hop.visible === undefined) hop.visible = member?.show === "always";
		this.#publishHop(run, hop, member);
	}

	#pause(run: MixtureRun, member: string, reason: string): void {
		run.status = "paused";
		const text = renderPauseNotice({
			mixture: run.key.mixture,
			member,
			reason,
			hops: run.lifetime.hops,
			usd: run.lifetime.usd.toFixed(2),
		});
		this.#writer.appendText(this.#streamedLive ? `\n\n${text}` : text);
		const pending: PendingResponse = {
			responseId: this.#nextResponseId(run),
			content: structuredClone(this.#writer.message.content),
			stopReason: "stop",
		};
		const record = this.#recordResponse(run, pending, "responded");
		this.#checkpoint(run, "pause", record, `paused at ${member}`);
		this.#finishWith(run, record, { kind: "done", reason: "stop" });
	}

	#onJudgeFailure(
		run: MixtureRun,
		hop: HopRecord,
		member: ResolvedMixture["members"][string] | undefined,
		kind: "route" | "terminate",
		error: unknown,
	): void {
		this.#leaveDecision(run, hop, member);
		if (this.#deadlineFired()) return this.#onSoftLimit(run, "wall_clock", this.#wallClockValue(run));
		this.#pause(
			run,
			hop.memberId,
			`${kind} judgment at ${hop.memberId} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	#judgeDeadline(_error: unknown): boolean {
		return this.#deadlineFired();
	}

	#onVerdictDeadline(run: MixtureRun, hop: HopRecord): void {
		hop.status = "aborted";
		hop.output = "";
		hop.elapsedMs = Date.now() - hop.startedAt;
		this.#normalizeContinuation(run, hop);
		this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, run.resolved.members[hop.memberId]) });
		this.#onSoftLimit(run, "wall_clock", this.#wallClockValue(run));
	}

	#takeEdge(
		run: MixtureRun,
		hop: HopRecord,
		member: ResolvedMixture["members"][string] | undefined,
		edge: MixtureEdge,
	): void {
		const edgeId = mixtureEdgeId(edge);
		run.traversals[edgeId] = (run.traversals[edgeId] ?? 0) + 1;
		hop.visible = (edge.show ?? member?.show ?? "always") === "always";
		run.phase = {
			kind: "hop_ready",
			memberId: typeof edge.to === "string" ? edge.to : edge.to[0]!,
			edgeInId: edgeId,
		};
		run.activeMemberId = run.phase.memberId;
		this.#publishHop(run, hop, member, edgeId);
		this.#checkpoint(run, "decision");
	}

	async #verdictHop(
		run: MixtureRun,
		member: Extract<ResolvedMixture["members"][string], { kind: "verdict" }>,
		edge: MixtureEdge | undefined,
		source: HopRecord | undefined,
	): Promise<void> {
		const hop: HopRecord = {
			index: run.hops.length + 1,
			memberId: member.id,
			edgeInId: edge && mixtureEdgeId(edge),
			input: "",
			messages: [],
			output: "",
			reasoning: "",
			toolTrace: "",
			decisions: [],
			status: "running",
			startedAt: Date.now(),
		};
		run.hops.push(hop);
		run.lifetime.hops++;
		run.window.hops++;
		run.activeMemberId = member.id;
		run.phase = { kind: "generating", hop: hop.index };
		const judgeModel = run.resolved.judgePlan?.[0]?.model;
		if (!judgeModel) return this.#fail(run, hop, { kind: "failed", message: "verdict.failed: no judge plan" });
		this.#emit({ type: "hop_start", run, hop, model: judgeModel, trace: this.#hopTrace(run, hop, member) });
		const available: Record<string, string | undefined> = { topic: run.topic };
		if (source && edge) {
			if (edge.x.output) available.output = source.output;
			if (edge.x.input) available.input = source.input;
			if (edge.x.reasoning) available.reasoning = source.reasoning;
			if (edge.x.toolTrace) available.toolTrace = source.toolTrace;
			if (edge.x.transcript) available.transcript = renderTranscript(run.hops);
		}
		const selected: Record<string, string | undefined> = { topic: run.topic };
		for (const name of member.state ?? Object.keys(available)) selected[name] = available[name];
		let judged: { result: JudgmentResult; kind: JudgeKind };
		try {
			judged = await this.#judge(run, hop, {
				state: decisionState(
					selected,
					cfgMoaDecisionStateTokens.get(this.#host.settings),
					this.#decisionTokenizer(run),
				),
				questions: { verdict: member.question },
			});
		} catch (error) {
			if (this.#finalized) return;
			if (this.#judgeDeadline(error)) return this.#onVerdictDeadline(run, hop);
			return this.#fail(run, hop, {
				kind: "failed",
				message: `verdict.failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		if (this.#finalized) return;
		const answer = judged.result.answers.verdict;
		if (!answer) return this.#fail(run, hop, { kind: "failed", message: "verdict.failed: no answer" });
		const confidence = answer.type === "noul" ? undefined : answer.confidence;
		const judge = `${judged.result.provider}/${judged.result.model}`;
		const decision: MixtureDecision = {
			kind: "verdict",
			answer,
			confidence,
			judge,
			judgeKind: judged.kind,
			outcome: describeOutcome({ kind: "verdict", answer, confidence, judgeKind: judged.kind }),
		};
		hop.output = renderVerdict(member.render, {
			member: { id: member.id, description: member.description },
			question: member.question,
			answer,
			confidence,
			judge,
			judgeKind: judged.kind,
		});
		hop.status = "done";
		hop.elapsedMs = Date.now() - hop.startedAt;
		hop.visible = false;
		this.#recordDecision(run, hop, decision);
		run.final = { text: hop.output, hop: hop.index };
		run.endReason = "verdict";
		run.phase = { kind: "finalizing" };
		this.#publishHop(run, hop, member);
		this.#checkpoint(run, "decision");
	}

	async #decide(run: MixtureRun, hopIndex: number): Promise<void> {
		const hop = run.hops[hopIndex - 1];
		if (!hop) return this.#fail(run, undefined, { kind: "failed", message: `hop ${hopIndex} is missing` });
		const member = run.resolved.members[hop.memberId];
		const outgoing = run.resolved.definition.edges.filter(edge => edge.from === hop.memberId);
		if (
			hop.edgeInId !== "limit" &&
			outgoing.length > 0 &&
			this.#checkLimits(run, "decision_pending", () => this.#leaveDecision(run, hop, member))
		)
			return;
		if (hop.edgeInId === "limit") {
			hop.visible = false;
			run.final = { text: hop.output, hop: hop.index };
			run.endReason = `limit:${run.limitHop!.kind}`;
			run.phase = { kind: "finalizing" };
			this.#publishHop(run, hop, member);
			this.#checkpoint(run, "decision");
			return;
		}
		const definitionMember = run.resolved.definition.members.find(candidate => candidate.id === hop.memberId);
		let terminationJudged = false;
		if (definitionMember?.kind !== "verdict" && definitionMember?.terminate) {
			const terminate = definitionMember.terminate;
			const threshold = terminate.threshold ?? 0.5;
			let judged: { result: JudgmentResult; kind: JudgeKind };
			try {
				judged = await this.#judge(run, hop, {
					state: this.#decisionState(run, hop, terminate.state),
					questions: { terminate: terminateQuestion(terminate) },
				});
			} catch (error) {
				if (this.#finalized) return;
				return this.#onJudgeFailure(run, hop, member, "terminate", error);
			}
			if (this.#finalized) return;
			const answer = judged.result.answers.terminate;
			if (answer?.type !== "noul")
				return this.#fail(run, undefined, {
					kind: "failed",
					message: "terminate judgment returned no probability",
				});
			const decision: MixtureDecision = {
				kind: "terminate",
				answer,
				judge: `${judged.result.provider}/${judged.result.model}`,
				judgeKind: judged.kind,
				outcome: describeOutcome({ kind: "terminate", answer, judgeKind: judged.kind }, { floor: threshold }),
			};
			this.#recordDecision(run, hop, decision);
			terminationJudged = true;
			if (answer.noul >= threshold) {
				hop.visible = false;
				run.final = { text: hop.output, hop: hop.index };
				run.endReason = "terminate";
				run.phase = { kind: "finalizing" };
				this.#publishHop(run, hop, member);
				this.#checkpoint(run, "decision");
				return;
			}
		}
		const eligible = outgoing.filter(
			edge => edge.maxTraversals === undefined || (run.traversals[mixtureEdgeId(edge)] ?? 0) < edge.maxTraversals,
		);
		if (
			terminationJudged &&
			eligible.length >= 2 &&
			this.#checkLimits(run, "decision_pending", () => this.#leaveDecision(run, hop, member))
		)
			return;
		if (eligible.length === 0) {
			hop.visible = false;
			run.final = { text: hop.output, hop: hop.index };
			run.endReason = "terminal";
			run.phase = { kind: "finalizing" };
			this.#publishHop(run, hop, member);
			this.#checkpoint(run, "decision");
			return;
		}
		if (eligible.length === 1) return this.#takeEdge(run, hop, member, eligible[0]!);
		const route = definitionMember?.kind === "verdict" ? undefined : definitionMember?.route;
		if (!route) return this.#fail(run, undefined, { kind: "failed", message: `route.required: ${hop.memberId}` });
		const floor = route.minConfidence ?? cfgMoaJudgeMinConfidence.get(this.#host.settings);
		let answer: MixtureDecision["answer"];
		let judgeKind: JudgeKind;
		let judge: string;
		let failed = false;
		try {
			const judged = await this.#judge(run, hop, {
				state: this.#decisionState(run, hop, route.state),
				questions: { route: routeQuestion(route, eligible) },
			});
			if (this.#finalized) return;
			answer = judged.result.answers.route!;
			judgeKind = judged.kind;
			judge = `${judged.result.provider}/${judged.result.model}`;
			if (answer.type !== "choice") throw new Error("route judgment returned no choice");
		} catch (error) {
			if (this.#finalized) return;
			if (this.#judgeDeadline(error)) return this.#onJudgeFailure(run, hop, member, "route", error);
			failed = true;
			answer = failedChoice(eligible.map(edge => mixtureEdgeId(edge)));
			judgeKind = "online";
			judge = "failed";
		}
		if (answer.type !== "choice")
			return this.#fail(run, undefined, { kind: "failed", message: "route judgment returned no choice" });
		const confidence = answer.confidence;
		const below = failed || (judgeKind === "native" && confidence < floor);
		const selected = below ? route.fallback : answer.choice;
		const edge = eligible.find(candidate => mixtureEdgeId(candidate) === selected);
		const fallbackTo = below ? (edge ? mixtureEdgeId(edge) : "pause") : undefined;
		const decision: MixtureDecision = {
			kind: "route",
			answer,
			confidence,
			judge,
			judgeKind,
			outcome: describeOutcome(
				{ kind: "route", answer, confidence, judgeKind },
				{ fallbackTo, floor, failed: failed || undefined },
			),
		};
		this.#recordDecision(run, hop, decision);
		if (edge) return this.#takeEdge(run, hop, member, edge);
		this.#leaveDecision(run, hop, member);
		this.#pause(
			run,
			hop.memberId,
			failed
				? `route judgment at ${hop.memberId} failed and its fallback is pause`
				: `route from ${hop.memberId} fell below its confidence floor (${confidence.toFixed(2)} < ${floor.toFixed(2)}) and its fallback is pause`,
		);
	}

	#wallClockValue(run: MixtureRun): string {
		return `${run.resolved.definition.limits?.wallClockMinutes ?? cfgMoaWallClockMinutes.get(this.#host.settings)}m`;
	}

	/** A fixed precedence: lifetime caps always stop; soft limits obey the run's policy. */
	#checkLimits(run: MixtureRun, at: "hop_ready" | "decision_pending", onFire?: () => void): boolean {
		const settings = this.#host.settings;
		const limitHop = at === "hop_ready" && run.phase.kind === "hop_ready" && run.phase.edgeInId === "limit";
		const hardHops = cfgMoaHardMaxHops.get(settings);
		if (at === "hop_ready" && run.lifetime.hops >= hardHops) {
			onFire?.();
			this.#limitStop(run, "hard_cap", `${hardHops} hops`);
			return true;
		}
		const hardBudget = cfgMoaHardBudgetUsd.get(settings);
		if (hardBudget > 0 && run.lifetime.usd >= hardBudget) {
			onFire?.();
			this.#limitStop(run, "hard_cap", `$${hardBudget}`);
			return true;
		}
		if (limitHop) return false;
		const maxHops = run.resolved.definition.limits?.maxHops ?? cfgMoaMaxHops.get(settings);
		if (at === "hop_ready" && run.window.hops >= maxHops) {
			onFire?.();
			this.#onSoftLimit(run, "hops", String(maxHops));
			return true;
		}
		const budget = run.resolved.definition.limits?.budgetUsd ?? cfgMoaBudgetUsd.get(settings);
		if (budget > 0 && run.window.usd >= budget) {
			onFire?.();
			this.#onSoftLimit(run, "budget", `$${budget}`);
			return true;
		}
		const minutes = run.resolved.definition.limits?.wallClockMinutes ?? cfgMoaWallClockMinutes.get(settings);
		if (Date.now() - run.window.startedAt >= minutes * 60_000) {
			onFire?.();
			this.#onSoftLimit(run, "wall_clock", `${minutes}m`);
			return true;
		}
		return false;
	}

	#onSoftLimit(run: MixtureRun, kind: "hops" | "budget" | "wall_clock", value: string): void {
		const action = run.resolved.definition.limits?.onLimit ?? cfgMoaOnLimit.get(this.#host.settings);
		if (action === "stop") return this.#limitStop(run, kind, value);
		if (action === "judge") {
			const target = run.resolved.definition.limits?.limitTarget;
			const last = run.hops.findLast(hop => hop.status === "done");
			if (!target || run.resolved.members[target]?.kind !== "model" || last?.memberId === target) {
				return this.#limitStop(run, kind, value);
			}
			run.limitHop = { kind, value };
			run.phase = { kind: "hop_ready", memberId: target, edgeInId: "limit" };
			run.activeMemberId = target;
			this.#emit({
				type: "limit",
				run,
				trace: { ...this.#header(run), kind: "limit", limit: kind, action: "judge", value },
			});
			this.#checkpoint(run, "decision");
			return;
		}
		this.#emit({
			type: "limit",
			run,
			trace: { ...this.#header(run), kind: "limit", limit: kind, action: "pause", value },
		});
		this.#pause(run, run.activeMemberId ?? run.resolved.definition.entry, limitReason(kind, value));
	}

	#limitStop(run: MixtureRun, limit: "hops" | "budget" | "wall_clock" | "hard_cap", value: string): void {
		const last = run.hops.findLast(hop => hop.status === "done");
		run.endReason = limit === "hard_cap" ? "hard_cap" : `limit:${limit}`;
		run.final = {
			text: renderLimitNotice({
				mixture: run.key.mixture,
				hops: run.lifetime.hops,
				reason: limitReason(limit, value),
				member: last?.memberId,
				output: last?.output,
			}),
			hop: last?.index ?? 0,
		};
		run.phase = { kind: "finalizing" };
		this.#emit({
			type: "limit",
			run,
			trace: { ...this.#header(run), kind: "limit", limit, action: "stop", value },
		});
		this.#checkpoint(run, "decision");
	}

	/** Step 1.7: the only place terminal text reaches the outer message. */
	#finalize(run: MixtureRun): void {
		const final = run.final ?? { text: "", hop: 0 };
		const streamedFinal = this.#streamedLive && final.hop === this.#liveHop;
		if (!streamedFinal) this.#writer.appendText(this.#streamedLive ? `\n\n${final.text}` : final.text);
		const text = this.#writer.text;
		run.status = "done";
		run.phase = { kind: "ended" };
		const pending: PendingResponse = {
			responseId: this.#nextResponseId(run),
			content: text ? [{ type: "text", text }] : [],
			stopReason: "stop",
		};
		const record = this.#recordResponse(run, pending, "responded");
		this.#checkpoint(run, "done", record);
		this.#finishWith(run, record, { kind: "done", reason: "stop" });
		const usage = sumSettlements(run.settlements);
		this.#emit({
			type: "run_end",
			run,
			trace: { ...this.#header(run), kind: "run_end", endReason: run.endReason ?? "terminal", usage },
		});
	}

	#fail(run: MixtureRun, hop: HopRecord | undefined, failure: Extract<MemberOutcome, { kind: "failed" }>): void {
		if (hop) {
			hop.status = "failed";
			hop.error = { message: failure.message, status: failure.status, errorId: failure.errorId };
			this.#normalizeContinuation(run, hop);
			this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, run.resolved.members[hop.memberId]) });
		}
		run.status = "error";
		const pending: PendingResponse = {
			responseId: this.#nextResponseId(run),
			content: structuredClone(this.#writer.message.content),
			stopReason: "error",
			errorMessage: failure.message,
			errorStatus: failure.status,
			errorId: failure.errorId,
		};
		const record = this.#recordResponse(run, pending, "failed");
		this.#checkpoint(run, "error", record);
		this.#finishWith(run, record, {
			kind: "error",
			reason: "error",
			message: failure.message,
			status: failure.status,
			errorId: failure.errorId,
		});
	}

	/**
	 * The caller aborted: finish the request now, inside the signal's abort
	 * dispatch, with no await. The caller's loop copies the live outer message on
	 * a later microtask, so the persisted abort carries this response's identity
	 * and usage. The in-flight member call is left to settle late.
	 */
	#finalizeAbort(): void {
		const run = this.#run;
		if (this.#finalized || this.#writer.finished || run?.status !== "running") return;
		this.#finalized = true;
		const hop = run.hops.at(-1);
		let note: string | undefined;
		if (hop?.status === "running") {
			hop.status = "aborted";
			hop.output = "";
			hop.elapsedMs = Date.now() - hop.startedAt;
			this.#normalizeContinuation(run, hop);
			this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, run.resolved.members[hop.memberId]) });
			note = `aborted during hop ${hop.index} (${hop.memberId})`;
		}
		run.status = "checkpoint";
		const pending: PendingResponse = {
			responseId: this.#nextResponseId(run),
			content: structuredClone(this.#writer.message.content),
			stopReason: "aborted",
			errorMessage: CALLER_ABORT_MESSAGE,
		};
		const record = this.#recordResponse(run, pending, "failed");
		this.#checkpoint(run, "abort", record, note);
		this.#writer.seal(this.#reported(run, record));
		this.#lease?.release();
	}

	/** A failed or aborted call is redone from a resumable phase, never `generating`. */
	#normalizeContinuation(run: MixtureRun, hop: HopRecord): void {
		run.phase = { kind: "hop_ready", memberId: hop.memberId, edgeInId: hop.edgeInId };
		run.activeMemberId = hop.memberId;
	}

	/** Step 0a `responded`: replay the stored response verbatim; the run does not move. */
	#replay(run: MixtureRun, record: OuterResponseRecord): void {
		for (const block of record.pending.content) {
			if (block.type === "text") this.#writer.appendText(block.text);
			else if (block.type === "toolCall") this.#writer.toolCall(block);
		}
		const pending = record.pending;
		this.#finishWith(
			run,
			record,
			pending.stopReason === "error" || pending.stopReason === "aborted"
				? {
						kind: "error",
						reason: pending.stopReason,
						message: pending.errorMessage ?? "mixture error",
						status: pending.errorStatus,
						errorId: pending.errorId,
					}
				: { kind: "done", reason: pending.stopReason },
		);
	}

	// -----------------------------------------------------------------------
	// Settlement, responses, checkpoints, traces
	// -----------------------------------------------------------------------

	#settle(run: MixtureRun, hop: HopRecord | undefined, settlement: Omit<Settlement, "attempt" | "late">): void {
		const record: Settlement = { attempt: `${run.id}:${run.settlements.length + 1}`, ...settlement };
		// After finalization no outer response of this request can report the attempt.
		if (this.#finalized) record.late = true;
		run.settlements.push(record);
		run.lifetime.usd += record.usage.cost.total;
		run.window.usd += record.usage.cost.total;
		if (hop) {
			const hopUsage = hop.usage ?? zeroUsage();
			addUsage(hopUsage, record.usage);
			hop.usage = hopUsage;
		}
		this.#host.onSettlement?.(run, record);
		if (record.late) this.#host.onLateSettlement?.(run, record);
	}

	#nextResponseId(run: MixtureRun): string {
		return `moa:${run.id}:${run.outerResponses.length + 1}`;
	}

	/** Store the outer response for replay with its reporting range; `commit` later advances the watermark. */
	#recordResponse(run: MixtureRun, pending: PendingResponse, outcome: "responded" | "failed"): OuterResponseRecord {
		const text = pending.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
		const record: OuterResponseRecord = {
			responseId: pending.responseId,
			textHash: textHash(text),
			report: { from: run.reportedThrough, to: run.settlements.length },
			committed: false,
			pending,
			consumed: consumptionOf(this.#context.messages),
		};
		run.outerResponses.push(record);
		run.lastRequest = { ...run.lastRequest, outcome, responseId: pending.responseId };
		return record;
	}

	#finishWith(run: MixtureRun, record: OuterResponseRecord, outcome: OuterOutcome): void {
		this.#writer.finish({ outcome, ...this.#reported(run, record) });
	}

	/** What an outer response reports: its range's settlements, never a late one. */
	#reported(run: MixtureRun, record: OuterResponseRecord): OuterSettled {
		const reported = run.settlements
			.slice(record.report.from, record.report.to)
			.filter(settlement => !settlement.late);
		const usage = sumSettlements(reported);
		usage.contextTokens = this.#contextTokens();
		const usageBreakdown: UsageBreakdownEntry[] = reported.map(settlement => ({
			provider: settlement.provider,
			model: settlement.model,
			kind: settlement.kind,
			usage: settlement.usage,
		}));
		return { usage, usageBreakdown, responseId: record.responseId };
	}

	/** Outer conversation occupancy, not the sum of member prompts. */
	#contextTokens(): number {
		const tokenizer = new Tokenizer(this.#model);
		const emitted: Message = {
			role: "user",
			content: this.#writer.text,
			timestamp: 0,
		};
		return (
			tokenizer.countMessages(this.#context.messages) +
			tokenizer.countTokens([...(this.#context.systemPrompt ?? [])]) +
			tokenizer.countMessages([emitted])
		);
	}

	#checkpoint(run: MixtureRun, reason: MixtureCheckpointReason, record?: OuterResponseRecord, note?: string): void {
		const checkpoint: MixtureCheckpoint = {
			v: 1,
			reason,
			run: serializeRun(run),
			committedThrough: run.reportedThrough,
			outerResponseId: record?.responseId,
			report: record ? { ...record.report } : undefined,
		};
		// Abort and pause leave a resumable card; hop and decision checkpoints do not.
		const trace: Extract<MixtureTraceDetails, { kind: "checkpoint" }> | undefined =
			reason === "abort" || reason === "pause"
				? { ...this.#header(run), kind: "checkpoint", reason, note }
				: undefined;
		this.#emit({
			type: "checkpoint",
			run,
			reason,
			checkpoint,
			report: checkpoint.report,
			outerResponseId: checkpoint.outerResponseId,
			trace,
		});
	}

	#header(run: MixtureRun): MixtureTraceHeader {
		run.seq++;
		return {
			v: 1,
			runId: run.id,
			mixture: run.key.mixture,
			seq: run.seq,
			at: Date.now(),
			run: {
				status: run.status,
				phase: run.phase.kind,
				activeMemberId: run.activeMemberId,
				hops: run.lifetime.hops,
				usd: run.lifetime.usd,
				window: { hops: run.window.hops, usd: run.window.usd },
				endReason: run.endReason,
			},
		};
	}

	#hopTrace(
		run: MixtureRun,
		hop: HopRecord,
		member: ResolvedMixture["members"][string] | undefined,
		edgeOutId?: string,
	): Extract<MixtureTraceDetails, { kind: "hop" | "branch" }> {
		const visible = hop.visible === true;
		return {
			...this.#header(run),
			kind: "hop",
			hop: hop.index,
			memberId: hop.memberId,
			model:
				member?.kind === "model" ? modelLabel(member.model) : member?.kind === "verdict" ? "verdict" : hop.memberId,
			edgeInId: hop.edgeInId,
			edgeOutId,
			output: visible ? hop.output : undefined,
			reasoning: visible && hop.reasoning ? hop.reasoning : undefined,
			usage: hop.usage ?? zeroUsage(),
			elapsedMs: hop.elapsedMs ?? 0,
			status: hop.status,
			visible,
		};
	}

	#emit(event: MixtureEvent): void {
		try {
			this.#host.onEvent?.(event);
		} catch (error) {
			logger.warn("mixture host event handler threw", {
				event: event.type,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function partsOf(x: EnvelopeContext["x"]): HopParts {
	return {
		output: x.output,
		input: x.input,
		reasoning: x.reasoning,
		toolTrace: x.tool_trace,
		transcript: x.transcript,
	};
}
