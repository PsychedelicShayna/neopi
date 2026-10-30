/**
 * Builds transcript components from persisted session message entries — the
 * file/remote-backed counterpart to {@link UiHelpers.addMessageToChat} (which is
 * bound to the live InteractiveModeContext). Used by the fullscreen transcript
 * viewer ({@link AgentTranscriptViewer}) to render a parked subagent / advisor /
 * collab-guest transcript that has no live session.
 *
 * Unlike incremental transcript sync, {@link ChatTranscriptBuilder.rebuild}
 * always discards prior components and rebuilds the whole transcript from the
 * supplied entries. Re-rendering a growing transcript is therefore O(n) in the
 * entry count, but it cannot duplicate or misorder rows the way incremental
 * component reuse could.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { type Component, Container, type TUI } from "../tui";
import type { AdvisorMessageDetails } from "./messages";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "./messages";
import { chatTranscriptDisplayPreferences as displayPreferences } from "./display-preferences";
import type { MessageRenderer } from "./extension-types";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "./messages";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	isUserTurnInitiator,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "./messages";
import {
	imageContent,
	textContent,
	type TranscriptEntryLike as TranscriptEntry,
	transcriptEntryMessage,
} from "./transcript-entry";
import { theme } from "../theme";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	buildLaunchCompletionBlock,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "./transcript-render-helpers";
import { createAdvisorMessageCard } from "./advisor-message";
import { AssistantMessageComponent } from "./assistant-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation } from "./cache-invalidation-marker";
import { ServedModelTracker } from "./served-model-marker";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import {
	type LateDiagnosticsFile,
	LateDiagnosticsMessageComponent,
	routeLateDiagnostics,
} from "./late-diagnostics-message";
import { groupedReadUsageCallIds, ReadToolGroupComponent, readArgsCollapseIntoGroup } from "./read-tool-group";
import { isReplyWrite, ReplyWriteComponent, replyDisplayMessage, toolResultReplies } from "./reply-write";
import { SkillMessageComponent } from "./skill-message";
import { ToolExecutionComponent, type ToolResultFrame, type ToolExecutionHandle } from "./tool-execution";
import { TranscriptContainer } from "../chrome/transcript-container";
import { createUsageRowBlock, TurnUsageTally, turnElapsedMs } from "../overlays/usage-row";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "./user-message";

export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandThinkingBlocks?: () => boolean;
	/** Session-scoped resolved destinations for model-authored Markdown links. */
	linkTargets?: ReadonlyMap<string, string>;
	/** Draw charts under numeric tables; false for transcripts that are not the main session's. Default: true. */
	tableCharts?: boolean;
	requestRender: () => void;
}

/** One running tool call as the owning session last reported it. */
export interface TranscriptLiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Latest progress frame; absent until the tool reports progress. */
	partialResult?: ToolResultFrame;
}

/**
 * Owner state that is not in the persisted transcript yet: the assistant
 * message being streamed (or just finished and not yet written) and the
 * tools still running. A remote viewer receives it as a pushed snapshot.
 */
export interface TranscriptLiveState {
	assistant?: Extract<AgentMessage, { role: "assistant" }>;
	tools: readonly TranscriptLiveTool[];
}

export class ChatTranscriptBuilder {
	readonly container = new TranscriptContainer();
	#pendingTools = new Map<string, ToolExecutionHandle>();
	#readArgs = new Map<string, Record<string, unknown>>();
	#readGroup: ReadToolGroupComponent | null = null;
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#pendingUsageTimestamp: number | undefined;
	#pendingReadUsageCallIds: string[] | undefined;
	#pendingUsageElapsedMs: number | undefined;
	#turnStartedAt: number | undefined;
	readonly #turnUsage = new TurnUsageTally();
	#lastAssistantUsage: Usage | undefined;
	#servedModelTracker = new ServedModelTracker();
	#waitingPoll: ToolExecutionComponent | null = null;
	#todoSnapshot: ToolExecutionComponent | null = null;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;
	#entryComponents = new Map<string, Component[]>();
	/**
	 * Live tail: owner state not persisted yet, rendered after {@link container}.
	 * It never enters the transcript container, so persisted rows keep their
	 * order and the tail is simply dropped once the entry it previewed lands.
	 */
	readonly liveContainer = new Container();
	#live: TranscriptLiveState | undefined;
	/** Timestamps of persisted assistant messages; a live message with one of them is already on screen. */
	#persistedAssistants = new Set<number>();
	#persistedToolResults = new Set<string>();
	#liveAssistantTimestamp: number | undefined;
	#liveAssistant: AssistantMessageComponent | undefined;
	#liveSegments = new Map<string, AssistantMessageComponent>();
	#liveTools = new Map<string, ToolExecutionComponent>();
	/** Last partial frame applied to each card, so an unchanged live push repaints nothing. */
	#appliedPartials = new WeakMap<object, Map<string, string>>();

	readonly #deps: ChatTranscriptBuilderDeps;

	constructor(deps: ChatTranscriptBuilderDeps) {
		this.#deps = deps;
		this.container.setToolActivityVisible(!displayPreferences.hideToolActivity);
	}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0 && this.liveContainer.children.length === 0;
	}

	/** Discard all components and rebuild the whole transcript from `entries`. */
	rebuild(entries: TranscriptEntry[]): void {
		const live = this.#live;
		this.reset();
		this.#live = live;
		for (const entry of entries) this.#appendEntry(entry);
		// Flush the trailing turn's usage row only once its tools are materialized
		// (a read whose result has not arrived stays pending); otherwise the row
		// would sit above its tools. The drain happens here at the end of the pass.
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
		this.#applyLive();
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(entries: TranscriptEntry[]): void {
		for (const entry of entries) this.#appendEntry(entry);
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
		this.#applyLive();
	}

	/**
	 * Show the owner's unpersisted state after the persisted transcript. The
	 * streaming assistant message renders as a provisional tail until an entry
	 * with the same timestamp is appended; partial tool results update the
	 * persisted pending card when its call is already on screen, else the
	 * provisional one. `undefined` drops the tail.
	 */
	setLive(state: TranscriptLiveState | undefined): void {
		this.#live = state;
		this.#applyLive();
	}

	/**
	 * Toggle tool-output expansion across every expandable component. Cards a
	 * TSP terminal collapsed or expanded locally mirror that into their own
	 * state, so this re-applies the transcript-wide state to every one of them
	 * even when it equals the previous value.
	 */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
		this.#liveAssistant?.setExpanded(expanded);
		for (const component of this.#liveSegments.values()) component.setExpanded(expanded);
		for (const component of this.#liveTools.values()) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Rendered row where a persisted entry begins, after the container has painted once. */
	rowForEntry(entryId: string): number | undefined {
		for (const component of this.#entryComponents.get(entryId) ?? []) {
			const row = this.container.getChildStartRow(component);
			if (row !== undefined) return row;
		}
		return undefined;
	}

	/** Tear down components (sealing pending spinners) and clear build state. */
	reset(): void {
		this.#live = undefined;
		for (const pending of this.#pendingTools.values()) pending.seal();
		this.#pendingTools.clear();
		this.#readArgs.clear();
		this.#readGroup = null;
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingReadUsageCallIds = undefined;
		this.#pendingUsageElapsedMs = undefined;
		this.#turnStartedAt = undefined;
		this.#turnUsage.reset();
		this.#lastAssistantUsage = undefined;
		this.#servedModelTracker = new ServedModelTracker();
		this.#waitingPoll = null;
		this.#todoSnapshot = null;
		this.#expandables = [];
		this.#entryComponents.clear();
		this.#persistedAssistants.clear();
		this.#persistedToolResults.clear();
		this.#clearLiveTail();
		this.container.dispose();
		this.container.clear();
	}

	dispose(): void {
		this.#live = undefined;
		this.reset();
	}

	#clearLiveTail(): void {
		for (const tool of this.#liveTools.values()) tool.seal();
		this.liveContainer.dispose();
		this.liveContainer.clear();
		this.#liveAssistant = undefined;
		this.#liveAssistantTimestamp = undefined;
		this.#liveSegments.clear();
		this.#liveTools.clear();
	}

	#applyLive(): void {
		const live = this.#live;
		const message = live?.assistant;
		this.#renderLiveAssistant(
			message && !this.#persistedAssistants.has(message.timestamp) ? message : undefined,
			live?.tools ?? [],
		);
		for (const tool of live?.tools ?? []) {
			const card = this.#pendingTools.get(tool.toolCallId) ?? this.#liveTools.get(tool.toolCallId);
			if (!card) continue;
			if (card instanceof ToolExecutionComponent) card.setExecutionStarted(tool.toolCallId);
			const partial = tool.partialResult;
			if (!partial) continue;
			const signature = JSON.stringify(partial);
			let applied = this.#appliedPartials.get(card);
			if (applied?.get(tool.toolCallId) === signature) continue;
			if (!applied) {
				applied = new Map<string, string>();
				this.#appliedPartials.set(card, applied);
			}
			applied.set(tool.toolCallId, signature);
			card.updateResult(partial, true, tool.toolCallId);
		}
	}

	/** Same shape as the live main view: text before tools, one card per call, text after each call. */
	#renderLiveAssistant(
		message: Extract<AgentMessage, { role: "assistant" }> | undefined,
		tools: readonly TranscriptLiveTool[],
	): void {
		if (this.#liveAssistantTimestamp !== message?.timestamp) {
			this.#clearLiveTail();
			this.#liveAssistantTimestamp = message?.timestamp;
		}
		const order: Component[] = [];
		const toolIds = new Set<string>();
		const segmentIds = new Set<string>();
		const showTools = !displayPreferences.hideToolActivity;
		if (message) {
			const timeline = splitAssistantMessageToolTimeline(message);
			this.#liveAssistant ??= this.#createAssistantComponent();
			this.#liveAssistant.updateContent(timeline.beforeTools, { transient: true });
			order.push(this.#liveAssistant);
			for (const content of message.content) {
				if (content.type !== "toolCall" || toolIds.has(content.id)) continue;
				toolIds.add(content.id);
				if (showTools && !this.#pendingTools.has(content.id) && !this.#persistedToolResults.has(content.id)) {
					order.push(this.#liveTool(content.id, content.name, content.arguments));
				}
				const after = timeline.afterToolCalls.get(content.id);
				if (after && assistantHasVisibleContent(after)) {
					let segment = this.#liveSegments.get(content.id);
					if (!segment) {
						segment = this.#createAssistantComponent();
						this.#liveSegments.set(content.id, segment);
					}
					segment.updateContent(after, { transient: true });
					segmentIds.add(content.id);
					order.push(segment);
				}
			}
		}
		for (const tool of tools) {
			if (!showTools || this.#pendingTools.has(tool.toolCallId) || this.#persistedToolResults.has(tool.toolCallId))
				continue;
			let card = this.#liveTools.get(tool.toolCallId);
			if (!toolIds.has(tool.toolCallId)) {
				card = this.#liveTool(tool.toolCallId, tool.toolName, tool.args);
				toolIds.add(tool.toolCallId);
				order.push(card);
			}
			card?.setExecutionStarted(tool.toolCallId);
		}
		for (const [id, card] of this.#liveTools) {
			if (showTools && toolIds.has(id) && !this.#pendingTools.has(id) && !this.#persistedToolResults.has(id))
				continue;
			card.seal();
			card.dispose();
			this.#liveTools.delete(id);
		}
		for (const [id, segment] of this.#liveSegments) {
			if (segmentIds.has(id)) continue;
			segment.dispose();
			this.#liveSegments.delete(id);
		}
		this.liveContainer.clear();
		for (const component of order) this.liveContainer.addChild(component);
	}

	#liveTool(id: string, name: string, args: unknown): ToolExecutionComponent {
		let card = this.#liveTools.get(id);
		if (card) {
			card.updateArgs(args, id);
			return card;
		}
		card = new ToolExecutionComponent(
			name,
			args,
			{
				useBuiltInRenderer: this.#deps.isBuiltInTool?.(name) ?? true,
				showImages: displayPreferences.showImages,
			},
			this.#deps.getTool?.(name),
			this.#deps.ui,
			this.#deps.cwd,
			id,
		);
		card.setExpanded(this.#expanded);
		this.#liveTools.set(id, card);
		return card;
	}

	#createAssistantComponent(): AssistantMessageComponent {
		const component = new AssistantMessageComponent(
			undefined,
			this.#deps.hideThinkingBlock?.() ?? false,
			() => this.#deps.requestRender(),
			this.#deps.getMessageRenderer ? undefined : [],
			this.#deps.ui.imageBudget,
			this.#deps.proseOnlyThinking ? this.#deps.proseOnlyThinking() : true,
			this.#deps.linkTargets,
			this.#deps.expandThinkingBlocks?.() ?? false,
		);
		component.setImagesVisible(displayPreferences.showImages);
		component.setToolResultImagesVisible(!displayPreferences.hideToolActivity);
		component.setTableChartsVisible(this.#deps.tableCharts !== false);
		component.setExpanded(this.#expanded);
		return component;
	}

	#appendEntry(entry: TranscriptEntry): void {
		const message = transcriptEntryMessage(entry);
		if (!message) return;
		const before = this.container.children.length;
		this.#appendChatMessage(message);
		const components = this.container.children.slice(before);
		if (components.length > 0) this.#entryComponents.set(entry.id, components);
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	/** Append assistant prose (a reply, a post-tool segment, or an `out://` reply write) with the transcript's display preferences. */
	#mountProse(component: AssistantMessageComponent): void {
		component.setImagesVisible(displayPreferences.showImages);
		component.setToolResultImagesVisible(!displayPreferences.hideToolActivity);
		component.setTableChartsVisible(this.#deps.tableCharts !== false);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}

	/** A `wait` showing all-running is displaced by the next `wait` call. */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#waitingPoll;
		if (!previous) return;
		this.#waitingPoll = null;
		if (nextToolName === "wait" && previous.isDisplaceableBlock() && this.container.canDisplaceBlock(previous)) {
			this.container.removeChild(previous);
		}
		previous.seal();
	}

	#resolveTodoSnapshot(nextToolName?: string): void {
		const previous = this.#todoSnapshot;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#todoSnapshot = null;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#todoSnapshot = null;
			this.container.removeChild(previous);
			previous.seal();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#todoSnapshot = null;
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#readGroup) {
			this.#readGroup = new ReadToolGroupComponent({
				showContentPreview: displayPreferences.readToolResultPreview,
			});
			this.#trackExpandable(this.#readGroup);
			this.container.addChild(this.#readGroup);
		}
		return this.#readGroup;
	}

	// Defer per-turn metrics until the turn's tool results have materialized.
	// Read-only invisible turns attach the metrics to their shared compact
	// group; every other turn keeps the standalone row below its tool blocks.
	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		const usageAttached =
			this.#pendingReadUsageCallIds !== undefined &&
			(this.#readGroup?.attachUsage(
				this.#pendingReadUsageCallIds,
				this.#pendingUsage,
				this.#pendingUsageDuration,
				this.#pendingUsageTtft,
				this.#pendingUsageTimestamp,
				this.#pendingUsageElapsedMs,
			) ??
				false);
		if (!usageAttached) {
			this.#readGroup?.seal();
			this.#readGroup = null;
			this.container.addChild(
				createUsageRowBlock(
					this.#pendingUsage,
					this.#pendingUsageDuration,
					this.#pendingUsageTtft,
					this.#pendingUsageTimestamp,
					this.#pendingUsageElapsedMs,
				),
			);
		}
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingReadUsageCallIds = undefined;
		this.#pendingUsageElapsedMs = undefined;
	}

	#appendChatMessage(message: AgentMessage): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		if (message.role !== "assistant" && message.role !== "toolResult") {
			this.#readGroup?.seal();
			this.#readGroup = null;
		}
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			case "user":
			case "developer": {
				// Only genuinely user-attributed prompts anchor the delta; a mid-run
				// agent-attributed `user` message (advisor tool-loop redirect) must not.
				if (message.role === "user" && message.attribution !== "agent") {
					this.#turnStartedAt = message.timestamp;
					this.#turnUsage.reset();
				} else if (message.role === "developer" && message.synthetic) {
					this.#turnUsage.reset();
					// A synthetic developer message initiates a fresh run (auto-
					// continue, /goal, approved plan): replay must not inherit the
					// preceding user prompt's timestamp, mirroring the live
					// agent_start clear. Same-turn continuation reminders (todo, plan)
					// are persisted developer messages WITHOUT the synthetic marker,
					// so their anchor survives the rebuild.
					// A deliberate operator action (`.`, `c` continue shortcut) is the turn's
					// own prompt: anchor the delta to it instead of clearing.
					if (message.userInitiated) this.#turnStartedAt = message.timestamp;
					else this.#turnStartedAt = undefined;
				}
				// A user prompt closes the poll-displacement window, same as the live path.
				if (message.role === "user") this.#resolveWaitingPoll();
				if (message.role === "user") this.#resolveTodoSnapshot();
				const userText = message.role === "user" ? textContent(message.content) : "";
				if (userText) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					// Synthetic (agent-attributed) inputs — chiefly the advisor's `Session
					// update` replay dumps — can be hundreds of KiB of Markdown each.
					// Rendering their full body on cold open blocked the TUI (issue #6308);
					// collapse them behind a compact summary that builds Markdown only on
					// expansion. Real user prompts stay fully rendered.
					if (isSynthetic) {
						const collapsed = new CollapsedSyntheticMessageComponent(userText);
						this.#trackExpandable(collapsed);
						this.container.addChild(collapsed);
					} else {
						this.container.addChild(
							new UserMessageComponent(userText, {
								liveSteered: message.role === "user" && message.liveSteered === true,
								timestamp: message.timestamp,
								images: imageContent(message.content),
							}),
						);
					}
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.#deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
					artifactError: message.meta?.artifactError,
					images: message.images,
					showImages: displayPreferences.showImages,
				});
				this.container.addChild(component);
				break;
			}
			case "evalExecution":
			case "pythonExecution": {
				const component = new EvalExecutionComponent(
					message.code,
					this.#deps.ui,
					message.excludeFromContext ?? false,
					message.role === "evalExecution" ? message.language : "py",
				);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled ?? false, {
					truncation: message.meta?.truncation,
					artifactError: message.meta?.artifactError,
				});
				this.container.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom":
				// A directly-invoked `/skill:` custom prompt is the run's initiator
				// (user attribution), so it seeds the prompt→yield delta like a user
				// message does.
				if (message.role === "custom" && isUserTurnInitiator(message as CustomMessage)) {
					this.#turnStartedAt = message.timestamp;
					this.#turnUsage.reset();
				}
				this.#appendCustomMessage(message);
				break;
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "fileMention": {
				// Indent one column to match the transcript's other rows (the viewer renders
				// body rows without an outer gutter; rows own their left pad).
				const block = buildFileMentionBlock(message.files, 1);
				if (block.children.length > 0) this.container.addChild(block);
				break;
			}
			default:
				message satisfies never;
		}
	}

	/** Prompt→yield wall time for the current turn, or undefined when unknown. */
	#turnElapsedMs(message: Extract<AgentMessage, { role: "assistant" }>): number | undefined {
		return turnElapsedMs(this.#turnStartedAt, message);
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>): void {
		this.#persistedAssistants.add(message.timestamp);
		const hideThinkingBlock = this.#deps.hideThinkingBlock?.() ?? false;
		const proseOnlyThinking = this.#deps.proseOnlyThinking ? this.#deps.proseOnlyThinking() : true;
		const expandThinkingBlocks = this.#deps.expandThinkingBlocks?.() ?? false;
		const timeline = splitAssistantMessageToolTimeline(message);
		const assistantComponent = new AssistantMessageComponent(
			timeline.beforeTools,
			hideThinkingBlock,
			() => this.#deps.requestRender(),
			this.#deps.getMessageRenderer ? undefined : [], // placeholder for thinkingRenderers
			this.#deps.ui.imageBudget,
			proseOnlyThinking,
			this.#deps.linkTargets,
			expandThinkingBlocks,
		);
		assistantComponent.pickReactionTarget(this.container.children);
		this.#mountProse(assistantComponent);
		let lastAssistantComponent = assistantComponent;

		if (displayPreferences.cacheMissMarker) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, message.usage);
			if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
		}
		if (message.usage.cacheRead + message.usage.cacheWrite + message.usage.input > 0) {
			this.#lastAssistantUsage = message.usage;
		}
		assistantComponent.setServedModelMismatch(this.#servedModelTracker.check(message));

		const hasVisibleAssistantContent = assistantHasVisibleContent(message);
		if (hasVisibleAssistantContent) {
			// New visible turn content closes the current read run (mirrors rebuild).
			this.#readGroup?.seal();
			this.#readGroup = null;
		}

		const errorPresentation = resolveAssistantErrorPresentation(message);
		const hasErrorStop = errorPresentation.kind === "full";
		const errorMessage = hasErrorStop ? errorPresentation.text : null;
		const appendAssistantSegment = (segment: Extract<AgentMessage, { role: "assistant" }> | undefined) => {
			if (!segment || !assistantHasVisibleContent(segment)) return;
			const component = new AssistantMessageComponent(
				segment,
				hideThinkingBlock,
				() => this.#deps.requestRender(),
				this.#deps.getMessageRenderer ? undefined : [],
				undefined,
				proseOnlyThinking,
				this.#deps.linkTargets,
				expandThinkingBlocks,
			);
			this.#mountProse(component);
			lastAssistantComponent = component;
		};

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#resolveWaitingPoll(content.name);

			const afterToolSegment = timeline.afterToolCalls.get(content.id);
			if (content.name === "read" && readArgsCollapseIntoGroup(content.arguments)) {
				if (hasErrorStop && errorMessage) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					group.updateResult(
						{ content: [{ type: "text", text: errorMessage }], isError: true },
						false,
						content.id,
					);
				} else if (afterToolSegment) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					this.#pendingTools.set(content.id, group);
				} else {
					const normalizedArgs = normalizeToolArgs(content.arguments);
					this.#readArgs.set(content.id, normalizedArgs);
				}
				appendAssistantSegment(afterToolSegment);
				continue;
			}

			this.#readGroup?.seal();
			this.#readGroup = null;
			const builtIn = this.#deps.isBuiltInTool?.(content.name) ?? true;
			let component: ToolExecutionHandle;
			if (builtIn && isReplyWrite(content.name, content.arguments) === true) {
				const reply = new ReplyWriteComponent({
					requestRender: () => this.#deps.requestRender(),
					imageBudget: this.#deps.ui.imageBudget,
					linkTargets: this.#deps.linkTargets,
				});
				reply.updateArgs(content.arguments);
				reply.setArgsComplete();
				this.#mountProse(reply);
				component = reply;
			} else {
				const card = new ToolExecutionComponent(
					content.name,
					content.arguments,
					{
						useBuiltInRenderer: builtIn,
						// Stable ids and Kitty placeholder cells keep images anchored
						// while the transcript viewport scrolls and reflows.
						showImages: displayPreferences.showImages,
					},
					this.#deps.getTool?.(content.name),
					this.#deps.ui,
					this.#deps.cwd,
					content.id,
				);
				this.#trackExpandable(card);
				this.container.addChild(card);
				component = card;
			}

			if (hasErrorStop && errorMessage) {
				component.updateResult(
					{ content: [{ type: "text", text: errorMessage }], isError: true },
					false,
					content.id,
				);
			} else {
				this.#pendingTools.set(content.id, component);
			}
			appendAssistantSegment(afterToolSegment);
		}
		const turnUsage = this.#turnUsage.add(message, this.#turnStartedAt);
		if (turnUsage) lastAssistantComponent.setTurnUsage(turnUsage);

		this.#pendingUsage =
			displayPreferences.showTokenUsage && assistantUsageIsBilled(message.usage) ? message.usage : undefined;
		this.#pendingUsageDuration = message.duration;
		this.#pendingUsageTtft = message.ttft;
		this.#pendingUsageTimestamp = message.timestamp;
		this.#pendingReadUsageCallIds = this.#pendingUsage ? groupedReadUsageCallIds(message) : undefined;
		this.#pendingUsageElapsedMs =
			this.#pendingUsage && displayPreferences.showTurnTime ? this.#turnElapsedMs(message) : undefined;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		this.#persistedToolResults.add(message.toolCallId);
		const pending = this.#pendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#readArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
			}
			component.updateResult(message, false, message.toolCallId);
			this.#pendingTools.delete(message.toolCallId);
			this.#readArgs.delete(message.toolCallId);
			return;
		}
		for (const reply of toolResultReplies(message.details)) {
			this.#mountProse(
				new AssistantMessageComponent(
					replyDisplayMessage(reply),
					false,
					() => this.#deps.requestRender(),
					[],
					this.#deps.ui.imageBudget,
					true,
					this.#deps.linkTargets,
				),
			);
		}
		if (!pending) return;
		pending.updateResult(message, false, message.toolCallId);
		this.#pendingTools.delete(message.toolCallId);
		if (message.toolName === "wait" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#waitingPoll = pending;
		} else if (
			message.toolName === "todo" &&
			pending instanceof ToolExecutionComponent &&
			pending.canBeDisplacedBy("todo")
		) {
			// A successful todo result supersedes the prior live snapshot. Failed
			// follow-ups return false from canBeDisplacedBy("todo"), so the
			// last-good panel stays on screen.
			this.#resolveTodoSnapshot("todo");
			this.#todoSnapshot = pending;
		}
	}
	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): void {
		if (!message.display) return;
		if (message.customType === "async-result") {
			const component = buildAsyncResultBlock(message);
			this.container.addChild(component);
			return;
		}
		if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
			const details = (message as CustomMessage<{ files?: LateDiagnosticsFile[] }>).details;
			// Native: into the edit/write frames they belong to; the rest stand alone.
			const files = routeLateDiagnostics(this.container.children, details?.files ?? []);
			if (files.length === 0) return;
			const component = new LateDiagnosticsMessageComponent(files);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.container.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return;
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay" ||
			message.customType === "irc:workpool"
		) {
			this.container.addChild(buildIrcMessageCard(message, () => this.#expanded));
			return;
		}
		if (message.customType === "advisor") {
			const details = (message as CustomMessage<AdvisorMessageDetails>).details;
			const card = createAdvisorMessageCard(details, () => this.#expanded, theme);
			// Tracked so a transcript-wide toggle also clears a per-card native toggle.
			this.#trackExpandable(card);
			this.container.addChild(card);
			return;
		}
		if (message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
			this.container.addChild(buildLaunchCompletionBlock(message));
			return;
		}
		if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			this.container.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
			return;
		}
		const handoffComponent = createHandoffSummaryMessageComponent(message as CustomMessage<unknown>, this.#expanded);
		if (handoffComponent) {
			this.#trackExpandable(handoffComponent);
			this.container.addChild(handoffComponent);
			return;
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.#deps.getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}
}
