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
	Message,
	Model,
	Usage,
	UsageBreakdownEntry,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type {
	MixtureCheckpointReason,
	MixtureEdge,
	MixtureTraceDetails,
	MixtureTraceHeader,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { mixtureEdgeId } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { logger } from "@oh-my-pi/pi-utils";
import { thinkingFromContent } from "../session/messages";
import { fitHopRequest, type HopParts, truncateToTokens } from "./budget";
import {
	DEFAULT_EDGE_ENVELOPE,
	ENTRY_ENVELOPE,
	type EnvelopeContext,
	isInlineTemplate,
	renderEnvelope,
	renderLimitNotice,
} from "./envelopes";
import { normalizeToolChoice, prepareMemberCall } from "./member-call";
import { type OuterOutcome, OuterWriter, zeroUsage } from "./outer-stream";
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
import type { MixtureRunEntry } from "./run-store";
import { cfgMoaConversationBudgetTokens, cfgMoaHardMaxHops, cfgMoaMaxHops, cfgMoaPartBudgetTokens } from "./settings";
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
	| { kind: "aborted"; message: string };

class MixtureCall {
	readonly #model: Model<Api>;
	readonly #context: Context;
	readonly #options: OuterStreamOptions;
	readonly #host: MixtureHost;
	readonly #writer: OuterWriter;
	#entry!: MixtureRunEntry;
	/** Terminal member text streamed live on this call. */
	#streamedLive = false;

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
		const key: MixtureRunKey = {
			host: this.#host.id,
			mixture: name,
			lineage: [],
			conversation: this.#host.conversationKey(this.#context, this.#options),
		};
		const lease = this.#host.runs.acquire(key);
		if (!lease) return this.#reject(`mixture run ${name} is busy`);
		this.#entry = lease.entry;
		this.#writer.holdTerminal();
		try {
			await this.#classify(key, requirement);
		} finally {
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
		const anchor = existing ? findAnchor(existing, messages).index : -1;
		const tail = messages.slice(anchor + 1);
		const classified = classifyTail(tail);
		const request = {
			fingerprint: hashMessages(tail),
			consumedCount: anchor + 1,
			consumedHash: hashMessages(messages.slice(0, anchor + 1)),
			outcome: "in_progress" as const,
		};

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
		return this.#reject("mixture received no new input");
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
			settlements: [],
			reportedThrough: 0,
			appliedToolResultIds: [],
			window: { hops: 0, usd: 0, startedAt: now },
			lifetime: { hops: 0, usd: 0, startedAt: now },
			outerResponses: [],
			toolRequirement: requirement.kind === "any" || requirement.kind === "named" ? requirement : undefined,
			seq: 0,
		};
		this.#entry.run = run;
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
		while (run.status === "running") {
			const phase = run.phase;
			switch (phase.kind) {
				case "hop_ready":
					await this.#hopReady(run, phase.memberId, phase.edgeInId);
					break;
				case "decision_pending":
					this.#decide(run, phase.hop);
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
		const settings = this.#host.settings;
		const hardCap = cfgMoaHardMaxHops.get(settings);
		const maxHops = run.resolved.definition.limits?.maxHops ?? cfgMoaMaxHops.get(settings);
		if (run.lifetime.hops >= hardCap) return this.#limitStop(run, "hard_cap", hardCap);
		if (run.window.hops >= maxHops) return this.#limitStop(run, "hops", maxHops);

		const member = run.resolved.members[memberId];
		if (member?.kind !== "model") {
			return this.#fail(run, undefined, { kind: "failed", message: `member ${memberId} cannot run in this build` });
		}
		const edge = edgeInId
			? run.resolved.definition.edges.find(candidate => mixtureEdgeId(candidate) === edgeInId)
			: undefined;
		const source = edge ? run.hops.findLast(hop => hop.memberId === edge.from && hop.status === "done") : undefined;
		const template = edge ? this.#edgeTemplate(run.resolved, edge) : run.resolved.envelopes[ENTRY_ENVELOPE];
		if (template === undefined) {
			return this.#fail(run, undefined, { kind: "failed", message: `mixture ${run.key.mixture}: envelope missing` });
		}

		const envelopeContext = this.#envelopeContext(run, member, edge, source);
		const systemPrompt = [...(member.inherit ? (this.#context.systemPrompt ?? []) : []), member.rolePrompt].filter(
			text => text !== "",
		);
		const assemble = (parts: HopParts) =>
			renderEnvelope(template, {
				...envelopeContext,
				conversation: parts.conversation ?? "",
				x: { output: parts.output, input: parts.input, reasoning: parts.reasoning, tool_trace: parts.toolTrace },
			});
		const fitted = fitHopRequest({
			target: member.model,
			maxTokens: member.maxTokens,
			systemPrompt,
			assemble,
			parts: { ...partsOf(envelopeContext.x), conversation: envelopeContext.conversation },
			hopMessages: [],
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
			content: [{ type: "text", text: input }, ...(edgeInId === undefined ? this.#entry.topicImages : [])],
			attribution: "agent",
			timestamp: Date.now(),
		};
		const memberContext: Context = {
			systemPrompt,
			messages: [envelopeMessage, ...hop.messages],
		};
		const prepared = await this.#host.prepareContext(memberContext, member.model);
		const outcome = await this.#generate(run, hop, member, prepared);
		this.#afterGenerate(run, hop, member, outcome);
	}

	#edgeTemplate(resolved: ResolvedMixture, edge: MixtureEdge): string | undefined {
		const reference = edge.envelope ?? DEFAULT_EDGE_ENVELOPE;
		return isInlineTemplate(reference) ? reference : resolved.envelopes[reference];
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
		const options = prepareMemberCall(this.#options, run, member, this.#host, this.#entry);
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
			this.#settle(run, hop, {
				kind: "member",
				hop: hop.index,
				provider: final.provider,
				model: final.model,
				usage: final.usage,
				failed: terminal !== "done" || undefined,
			});
		}
		if (!final || !terminal) {
			return { kind: "failed", message: `member ${member.id} stream ended without a result` };
		}
		if (terminal === "error") {
			if (final.stopReason === "aborted" && this.#options.signal?.aborted) {
				return { kind: "aborted", message: final.errorMessage ?? "aborted" };
			}
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
		if (outcome.kind === "aborted") return this.#abort(run, hop, member, outcome.message);
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
		if (outcome.truncated) {
			hop.truncated = true;
			logger.warn("mixture member stopped at its length limit", { mixture: run.key.mixture, member: member.id });
		}
		hop.status = "done";
		run.phase = { kind: "decision_pending", hop: hop.index };
		this.#checkpoint(run, "hop");
	}

	/** Step 1.5: in this build the only decision is the single outgoing edge, or none. */
	#decide(run: MixtureRun, hopIndex: number): void {
		const hop = run.hops[hopIndex - 1];
		if (!hop) return this.#fail(run, undefined, { kind: "failed", message: `hop ${hopIndex} is missing` });
		const member = run.resolved.members[hop.memberId];
		const edge = run.resolved.definition.edges.find(candidate => candidate.from === hop.memberId);
		if (edge) {
			const edgeId = mixtureEdgeId(edge);
			run.traversals[edgeId] = (run.traversals[edgeId] ?? 0) + 1;
			const show = edge.show ?? member?.show ?? "always";
			hop.visible = show === "always";
			run.phase = {
				kind: "hop_ready",
				memberId: typeof edge.to === "string" ? edge.to : edge.to[0]!,
				edgeInId: edgeId,
			};
			run.activeMemberId = run.phase.memberId;
			this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, member, edgeId) });
			this.#checkpoint(run, "decision");
			return;
		}
		// Terminal: the output becomes the answer, so the card carries only the header.
		hop.visible = false;
		run.final = { text: hop.output, hop: hop.index };
		run.endReason = "terminal";
		run.phase = { kind: "finalizing" };
		this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, member) });
		this.#checkpoint(run, "decision");
	}

	#limitStop(run: MixtureRun, limit: "hops" | "hard_cap", value: number): void {
		const last = run.hops.findLast(hop => hop.status === "done");
		run.endReason = limit === "hops" ? "limit:hops" : "hard_cap";
		run.final = {
			text: renderLimitNotice({
				mixture: run.key.mixture,
				hops: run.lifetime.hops,
				reason:
					limit === "hops" ? `the ${value}-hop limit was reached` : `the hard cap of ${value} hops was reached`,
				member: last?.memberId,
				output: last?.output,
			}),
			hop: last?.index ?? 0,
		};
		run.phase = { kind: "finalizing" };
		this.#emit({
			type: "limit",
			run,
			trace: { ...this.#header(run), kind: "limit", limit, action: "stop", value: String(value) },
		});
		this.#checkpoint(run, "decision");
	}

	/** Step 1.7: the only place terminal text reaches the outer message. */
	#finalize(run: MixtureRun): void {
		const final = run.final ?? { text: "", hop: 0 };
		const text = this.#streamedLive ? this.#writer.text : final.text;
		run.status = "done";
		run.phase = { kind: "ended" };
		const pending: PendingResponse = {
			responseId: this.#nextResponseId(run),
			content: text ? [{ type: "text", text }] : [],
			stopReason: "stop",
		};
		const record = this.#recordResponse(run, pending, "responded");
		this.#checkpoint(run, "done", record);
		if (!this.#streamedLive) this.#writer.appendText(text);
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

	#abort(run: MixtureRun, hop: HopRecord, member: ResolvedModelMember, message: string): void {
		hop.status = "aborted";
		hop.output = "";
		this.#normalizeContinuation(run, hop);
		this.#emit({ type: "hop_end", run, hop, trace: this.#hopTrace(run, hop, member) });
		run.status = "checkpoint";
		const pending: PendingResponse = {
			responseId: this.#nextResponseId(run),
			content: structuredClone(this.#writer.message.content),
			stopReason: "aborted",
			errorMessage: message,
		};
		const record = this.#recordResponse(run, pending, "failed");
		this.#checkpoint(run, "abort", record, `aborted during hop ${hop.index} (${hop.memberId})`);
		this.#finishWith(run, record, { kind: "error", reason: "aborted", message });
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

	#settle(run: MixtureRun, hop: HopRecord, settlement: Omit<Settlement, "attempt">): void {
		const record: Settlement = { attempt: `${run.id}:${run.settlements.length + 1}`, ...settlement };
		run.settlements.push(record);
		run.lifetime.usd += record.usage.cost.total;
		run.window.usd += record.usage.cost.total;
		const hopUsage = hop.usage ?? zeroUsage();
		addUsage(hopUsage, record.usage);
		hop.usage = hopUsage;
		this.#host.onSettlement?.(run, record);
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
		const reported = run.settlements.slice(record.report.from, record.report.to);
		const usage = sumSettlements(reported);
		usage.contextTokens = this.#contextTokens();
		const usageBreakdown: UsageBreakdownEntry[] = reported.map(settlement => ({
			provider: settlement.provider,
			model: settlement.model,
			kind: settlement.kind,
			usage: settlement.usage,
		}));
		this.#writer.finish({ outcome, usage, usageBreakdown, responseId: record.responseId });
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
		// Only abort carries a card here: a failed hop already has its hop card, and hop,
		// decision, and done checkpoints are not shown.
		const trace: Extract<MixtureTraceDetails, { kind: "checkpoint" }> | undefined =
			reason === "abort" ? { ...this.#header(run), kind: "checkpoint", reason, note } : undefined;
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
			model: member?.kind === "model" ? modelLabel(member.model) : hop.memberId,
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

function partsOf(x: EnvelopeContext["x"]) {
	return { output: x.output, input: x.input, reasoning: x.reasoning, toolTrace: x.tool_trace };
}
