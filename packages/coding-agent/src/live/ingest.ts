import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { CustomMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { MAIN_AGENT_ID, type AgentRegistry, type RegistryEvent } from "../registry/agent-registry";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL, type SubagentEventPayload, type SubagentLifecyclePayload, type SubagentProgressPayload } from "../task/types";
import { activeSubagentRuns, type EventBus } from "../utils/event-bus";
import type { LiveSessionController } from "./controller";
import type { LiveIngestPersonaSettings, LiveIngestSettingsSource } from "./ingest-settings";
import { cfgLiveModelCatalogPath } from "./settings";
import { LiveModelCatalogLoader, type CatalogIo } from "./model-catalog";
import { LiveIngestOverflow, type OverflowObservation } from "./ingest-overflow";
import { classifySubagentImportance, renderClassifierProse, resolveClassifierSelections, budgetClassifierInput, type ClassifierInput, type ClassifierResult, type ClassifierSelection, type RosterJournalEntry } from "./ingest-classifier";

export const LIVE_INGEST_WINDOW_MS = 60_000;
export const LIVE_INGEST_MAX_PER_WINDOW = 10;
export const LIVE_INGEST_MAX_COMMENTARY_PER_WINDOW = 20;
export const LIVE_INGEST_MAX_TOTAL_PER_WINDOW = 40;
export const LIVE_INGEST_REPORT_RESERVE = 10;
export const LIVE_INGEST_BLOCKER_RESERVE = 3;
export const LIVE_INGEST_ALERT_RESERVE = 3;
export const LIVE_INGEST_MAX_TRACKED = 64;
export const LIVE_INGEST_MAX_PENDING_STARTS = 12;
export const LIVE_INGEST_JOURNAL_MAX = 512;
export const LIVE_INGEST_RECENCY_HORIZON_MS = 1_800_000;
export const LIVE_INGEST_RECOMPUTE_MIN_MS = 5_000;
export const LIVE_INGEST_RECENCY_TICK_MS = 60_000;
export const LIVE_INGEST_CUE_QUIET_MS = 5_000;
export const LIVE_INGEST_THINKING_FLUSH_MS = 3_000;

export type SubagentImportanceClassifier = (input: ClassifierInput, options: { signal: AbortSignal; selection: ClassifierSelection; onPromptStart: () => void }) => Promise<ClassifierResult>;
export interface LiveIngestDeps {
 session: AgentSession;
 registry: AgentRegistry;
 subagentEventBus: EventBus | undefined;
 settings: LiveIngestSettingsSource;
 sink: Pick<LiveSessionController, "appendSpeakableContext" | "appendCommentaryContext" | "appendOverflowAlertContext">;
 extractAssistantText: (message: AssistantMessage) => string;
 classify?: SubagentImportanceClassifier;
 now?: () => number;
 setTimer?: (fn: () => void, ms: number) => () => void;
 catalogIo?: CatalogIo;
 notify?: (level: "warning" | "info", message: string) => void;
}
type Source = "irc-primary" | "irc-peer" | "subagent-start" | "subagent-report" | "subagent-thinking" | "subagent-progress" | "subagent-voiced" | "subagent-alert" | "advisor-notes" | "advisor-thinking";
type Reason = "spawn" | "snapshot" | "enable" | "periodic" | "attribution";
interface Run {
 token: string; id: string; agent: string; depth: number; parentId?: string; runKind: "spawn" | "wake" | "followUp";
 startedAt: number; lastActivityAt: number; seq: number; model?: string; thinkingLevel?: string; attributionRevision: number;
 description?: string; excerpt: string; voiced: boolean; thinkingRelayedLength: number; lastThinkingFlushAt: number;
}
interface Score { importance: number; lastScoredAt: number; sourceToken: string; attributionRevision: number; model?: string; thinkingLevel?: string }
interface Alert {
 token: string; id: string; agent: string; slug: string; effort: string; letter: string; depth?: number; parentId?: string;
 observedAt: number; selectionFingerprint: string; selectionRevision: number; observationRevision: number;
 catalogGeneration: number; catalogRevision: number; endedAt?: number;
}
interface Prelookup { token: string; id: string; agent: string; depth?: number; parentId?: string; runKind: string; model: string; effort: string; observedAt: number; observationRevision: number; endedAt?: number }
interface CueSnapshot { agent: string; letter?: string; depth: number; seq: number; effective: number; weight: number }
const letterOf = (effort?: string): string | undefined => ({ minimal: "L", low: "L", medium: "M", high: "H", xhigh: "E", max: "X" })[effort ?? ""];
const lowBase = (model?: string) => /luna|haiku|glm/i.test(model ?? "");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function fit(text: string, max = 500): string {
 if (bytes(text) <= max) return text;
 let out = "";
 for (const c of text) { if (bytes(out) + bytes(c) + 3 > max) break; out += c; }
 return out + "…";
}
function excerpt(text: string, cap: number): string {
 if (bytes(text) <= cap) return text;
 let tail = "";
 for (const c of [...text].reverse()) { if (bytes(tail) + bytes(c) > cap) break; tail = c + tail; }
 const i = Math.min(...[tail.indexOf(". "), tail.indexOf("\n")].filter(n => n >= 0));
 return "…" + (Number.isFinite(i) && i < tail.length - 40 ? tail.slice(i + 1) : tail).trim();
}
function pairCompatible(score: Score | undefined, run: Run): boolean { return !!score && score.model === run.model && score.thinkingLevel === run.thinkingLevel; }

export class LiveIngest {
 readonly #deps: LiveIngestDeps;
 readonly #now: () => number;
 readonly #setTimer: (fn: () => void, ms: number) => () => void;
 #attached = false;
 #disposers: Array<() => void> = [];
 #timers = new Map<string, () => void>();
 #tracked = new Map<string, Run>();
 #unscored = new Set<string>();
 #scoresById = new Map<string, Score>();
 #depthWeights = new Map<number, number>();
 #pendingStarts: Array<{ token: string; agent: string; depth: number }> = [];
 #pendingStartOverflow = 0;
 #cueReported = new Set<string>();
 #cueSnapshots = new Map<string, CueSnapshot>();
 #lastRecompute = -Infinity;
 #seq = 0;
 #journalSeq = 0;
 #journal: RosterJournalEntry[] = [];
 #journalIndex = new Map<string, number[]>();
 #lastJournalSeqSent = 0;
 #provenMembers = new Set<string>();
 #history = new Map<string, number[]>();
 #depthHistory = new Map<string, number[]>();
 #dropped = new Map<Source, number>();
 #ceilingNoticeSent = false;
 #rosterReasons = new Set<Reason>();
 #rosterDueAt?: number;
 #alertDueAt?: number;
 #periodicDueAt?: number;
 #batchInFlight = false;
 #sourceEpoch = 0;
 #callEpoch = 0;
 #scoringRevision = 0;
 #alertRevision = 0;
 #abort = new AbortController();
 #alertOnlyAbort?: AbortController;
 #seedPending = true;
 #catalog?: LiveModelCatalogLoader;
 #catalogListener?: () => void;
 #prelookup = new Map<string, Prelookup>();
 #pendingAlerts = new Map<string, Alert>();
 #judgingAlerts = new Map<string, Alert>();
 #settledAlerts = new Map<string, Alert>();
 #heldAlertAdmissions = new Map<number, Alert>();
 #nextAdmissionId = 0;
 #observationRevision = new Map<string, number>();
 #missingPairs = new Set<string>();
 #avoidSelections = new Set<string>();
 #overflow: LiveIngestOverflow;
 #overflowAdmitted = false;
 #overflowAdmissionVersion = 0;
 #oneTimeNotices = new Set<string>();
 constructor(deps: LiveIngestDeps) {
  this.#deps = deps;
  this.#now = deps.now ?? Date.now;
  this.#setTimer = deps.setTimer ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
  this.#overflow = new LiveIngestOverflow(this.#now);
 }
 readonly ircRelayTransform = (message: CustomMessage, body: string): string | undefined => {
  if (!this.#attached) return body;
  const source: Source = message.customType === "irc:relay" ? "irc-peer" : "irc-primary";
  const s = this.#deps.settings.get();
  if (source === "irc-peer" ? !s.ircPeers : !s.ircPrimary) return undefined;
  if (!this.#admit(source)) return undefined;
  return this.#annotation(source) + body;
 };
 attach(): void {
  if (this.#attached) return;
  this.#attached = true;
  this.#callEpoch++;
  this.#abort = new AbortController();
  const { session, registry, subagentEventBus: bus, settings } = this.#deps;
  this.#disposers.push(session.subscribe(event => this.#onSessionEvent(event)));
  this.#disposers.push(registry.onChange(event => this.#onRegistryEvent(event)));
  this.#disposers.push(settings.listen((next, previous) => this.#reconcile(next, previous)));
  if (bus) {
   this.#disposers.push(bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => this.#onLifecycle(data as SubagentLifecyclePayload)));
   this.#disposers.push(bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => this.#onProgress(data as SubagentProgressPayload)));
   this.#disposers.push(bus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => this.#onEvent(data as SubagentEventPayload)));
  } else logger.debug("Live ingest: no subagent event bus; subagent source inactive");
  if (settings.get().subagents) {
   if (settings.get().effortAlerts) this.#enableCatalog();
   this.#snapshot();
   this.#armPeriodic();
  }
 }
 detach(): void {
  if (!this.#attached) return;
  this.#attached = false;
  for (const dispose of this.#disposers.splice(0)) dispose();
  this.#clearSource();
  this.#journal = []; this.#journalIndex.clear(); this.#provenMembers.clear(); this.#lastJournalSeqSent = 0;
  this.#history.clear(); this.#depthHistory.clear(); this.#dropped.clear();
  this.#cueReported.clear(); this.#cueSnapshots.clear(); this.#depthWeights.clear();
 }
 #timer(key: string, fn: () => void, ms: number): void {
  this.#cancel(key);
  const stop = this.#setTimer(() => { this.#timers.delete(key); if (this.#attached) fn(); }, Math.max(0, ms));
  this.#timers.set(key, stop);
 }
 #cancel(key: string): void { this.#timers.get(key)?.(); this.#timers.delete(key); }
 #clearTimers(): void { for (const key of this.#timers.keys()) this.#cancel(key); }
 #enabled(): boolean { return this.#attached && this.#deps.settings.get().subagents; }
 #scoring(): boolean { return this.#enabled() && this.#deps.settings.get().subagentClassifier; }
 #alerts(): boolean { return this.#enabled() && this.#deps.settings.get().effortAlerts; }
 #clearAlerts(): void {
  this.#alertRevision++; this.#alertOnlyAbort?.abort("alerts disabled"); this.#alertOnlyAbort = undefined;
  this.#pendingAlerts.clear(); this.#judgingAlerts.clear(); this.#settledAlerts.clear(); this.#heldAlertAdmissions.clear();
  this.#prelookup.clear(); this.#observationRevision.clear(); this.#missingPairs.clear(); this.#avoidSelections.clear();
  this.#alertDueAt = undefined; this.#overflow.clear(); this.#overflowAdmitted = false; this.#overflowAdmissionVersion++;
  this.#catalog?.dispose(); this.#catalog = undefined;
  this.#catalogListener?.(); this.#catalogListener = undefined;
  this.#cancel("catalog"); this.#cancel("overflow"); this.#scheduleBatch();
 }
 #clearSource(): void {
  this.#sourceEpoch++; this.#abort.abort("live ingest stopped"); this.#clearTimers();
  this.#tracked.clear(); this.#unscored.clear(); this.#scoresById.clear(); this.#depthWeights.clear();
  this.#pendingStarts = []; this.#pendingStartOverflow = 0; this.#rosterReasons.clear(); this.#rosterDueAt = undefined; this.#periodicDueAt = undefined;
  this.#cueReported.clear(); this.#cueSnapshots.clear(); this.#lastRecompute = -Infinity; this.#ceilingNoticeSent = false;
  this.#clearAlerts();
  this.#journal = []; this.#journalIndex.clear(); this.#lastJournalSeqSent = this.#journalSeq; this.#provenMembers.clear();
 }
 #reconcile(next: LiveIngestPersonaSettings, previous: LiveIngestPersonaSettings): void {
  if (!next.subagents) { if (previous.subagents) this.#clearSource(); return; }
  if (!previous.subagents) {
   this.#abort = new AbortController(); this.#seedPending = true;
   if (next.effortAlerts) this.#enableCatalog();
   this.#snapshot(); this.#armPeriodic(); return;
  }
  if (next.subagentClassifier !== previous.subagentClassifier) {
   this.#scoringRevision++; this.#scoresById.clear(); this.#unscored.clear(); this.#depthWeights.clear();
   this.#rosterReasons.clear(); this.#rosterDueAt = undefined; this.#cancel("periodic");
   if (next.subagentClassifier) {
    for (const token of this.#tracked.keys()) this.#unscored.add(token);
    if (this.#tracked.size) this.#requestRoster("enable");
   }
   this.#recomputeVoiced(); this.#armPeriodic();
  }
  if (next.effortAlerts !== previous.effortAlerts) {
   if (!next.effortAlerts) this.#clearAlerts();
   else { this.#enableCatalog(); this.#snapshot(); }
  }
  if (next.subagentMaxDepth !== previous.subagentMaxDepth) {
   for (const [token, entry] of this.#tracked) if (next.subagentMaxDepth !== -1 && entry.depth > next.subagentMaxDepth) { this.#tracked.delete(token); this.#unscored.delete(token); }
   this.#recomputeVoiced(); this.#tickRecency();
  }
  if (next.voicedSlotsByDepth !== previous.voicedSlotsByDepth) this.#recomputeVoiced();
  if (!next.voicedChangeCue && previous.voicedChangeCue) { this.#cancel("cue"); this.#cueReported.clear(); this.#cueSnapshots.clear(); }
  else if (next.voicedChangeCue && !previous.voicedChangeCue) {
   this.#cueReported = new Set([...this.#tracked.values()].filter(r => r.voiced).map(r => r.token));
   this.#recomputeVoiced();
  }
  if (next.rescoreIntervalMs !== previous.rescoreIntervalMs) {
   if (!next.rescoreIntervalMs) {
    this.#rosterReasons.delete("periodic"); if (!this.#rosterReasons.size) this.#rosterDueAt = undefined;
   }
   this.#armPeriodic(); this.#scheduleBatch();
  }
  if (next.classifierQuietMs !== previous.classifierQuietMs) this.#postponeRoster();
  if (next.startAnnounceQuietMs !== previous.startAnnounceQuietMs && this.#pendingStarts.length + this.#pendingStartOverflow) this.#timer("start", () => this.#flushStarts(), next.startAnnounceQuietMs);
 }
 #snapshot(): void {
  const bus = this.#deps.subagentEventBus;
  if (!bus || !this.#enabled()) return;
  for (const frame of activeSubagentRuns(bus).values()) {
   if (this.#alerts()) this.#observeAnomaly(frame, "snapshot");
   if (!this.#tracked.has(frame.runToken)) this.#admitRun(frame, true);
  }
 }
 #rootId(): string { return this.#deps.registry.rootForSession(this.#deps.session)?.id ?? this.#deps.registry.get(MAIN_AGENT_ID)?.id ?? MAIN_AGENT_ID; }
 #depth(id: string, explicit?: number): number | undefined {
  if (Number.isInteger(explicit) && explicit! > 0) return explicit;
  const seen = new Set<string>(); let current = id;
  for (let depth = 0; depth < 64; depth++) {
   if (seen.has(current)) return undefined;
   seen.add(current);
   const ref = this.#deps.registry.get(current);
   if (!ref?.parentId) return undefined;
   if (ref.parentId === this.#rootId()) return depth + 1;
   current = ref.parentId;
  }
  return undefined;
 }
 #onLifecycle(frame: SubagentLifecyclePayload): void {
  if (!this.#enabled() || typeof frame?.runToken !== "string" || !frame.runToken) return;
  if (frame.status === "started") {
   if (this.#alerts()) this.#observeAnomaly(frame, "started");
   this.#admitRun(frame, false);
  } else this.#settleRun(frame);
 }
 #admitRun(frame: SubagentLifecyclePayload, silent: boolean): void {
  if (frame.status !== "started" || this.#tracked.has(frame.runToken)) return;
  const ref = this.#deps.registry.get(frame.id);
  if (ref && ref.kind !== "sub") return;
  const depth = this.#depth(frame.id, frame.depth);
  if (depth === undefined || (this.#deps.settings.get().subagentMaxDepth !== -1 && depth > this.#deps.settings.get().subagentMaxDepth)) return;
  if (this.#tracked.size >= LIVE_INGEST_MAX_TRACKED) {
   if (!this.#ceilingNoticeSent) {
    this.#ceilingNoticeSent = true;
    this.#commentary("Live ingest: tracking ceiling (64) reached; further subagents are not scored until one finishes.");
   }
   return;
  }
  const now = this.#now();
  const entry: Run = { token: frame.runToken, id: frame.id, agent: frame.agent, depth, parentId: ref?.parentId, runKind: frame.runKind ?? "spawn", startedAt: now, lastActivityAt: now, seq: ++this.#seq, description: frame.description, excerpt: "", voiced: false, thinkingRelayedLength: 0, lastThinkingFlushAt: -Infinity, attributionRevision: 0 };
  this.#tracked.set(entry.token, entry);
  if (frame.runEffectiveModelIdentity && frame.runEffectiveThinkingLevel) this.#confirmPair(entry, frame.runEffectiveModelIdentity, frame.runEffectiveThinkingLevel);
  this.#appendJournal({ id: entry.id, token: entry.token, depth, parentId: entry.parentId, state: "started" });
  if (!pairCompatible(this.#scoresById.get(entry.id), entry) && this.#scoring()) this.#unscored.add(entry.token);
  if (entry.runKind === "spawn" && !silent) {
   if (this.#pendingStarts.length < LIVE_INGEST_MAX_PENDING_STARTS) this.#pendingStarts.push({ token: entry.token, agent: entry.agent, depth });
   else this.#pendingStartOverflow++;
   this.#timer("start", () => this.#flushStarts(), this.#deps.settings.get().startAnnounceQuietMs);
   if (this.#unscored.has(entry.token)) this.#requestRoster("spawn");
  } else if (silent && this.#unscored.has(entry.token)) this.#requestRoster("snapshot");
  else this.#postponeRoster();
  this.#recomputeVoiced(); this.#tickRecency(); this.#armPeriodic();
 }
 #settleRun(frame: SubagentLifecyclePayload): void {
  const token = frame.runToken;
  for (const record of [this.#prelookup.get(token), this.#pendingAlerts.get(token), this.#judgingAlerts.get(token), this.#settledAlerts.get(token)]) if (record) record.endedAt = this.#now();
  this.#overflow.setReplayable(token, this.#prelookup.has(token) || this.#pendingAlerts.has(token) || this.#judgingAlerts.has(token) || this.#heldHasToken(token));
  const entry = this.#tracked.get(token);
  if (!entry) return;
  const voiced = entry.voiced;
  this.#tracked.delete(token); this.#unscored.delete(token);
  if (this.#tracked.size < LIVE_INGEST_MAX_TRACKED) this.#ceilingNoticeSent = false;
  this.#appendJournal({ id: entry.id, token, depth: entry.depth, parentId: entry.parentId, state: frame.status });
  if (voiced) { this.#cueReported.delete(token); this.#cueSnapshots.delete(token); }
  this.#recomputeVoiced(); this.#tickRecency(); if (!this.#tracked.size) this.#cancel("periodic"); this.#postponeRoster();
  if (voiced) {
   const text = frame.status === "aborted" ? `Subagent ${entry.agent} was aborted.` : frame.outcomeExcerpt ? `Subagent report from ${entry.agent}: (${frame.status}) ${frame.outcomeExcerpt}` : `Subagent ${entry.agent} finished with no readable output (${frame.status}).`;
   this.#speak("subagent-report", text, "report", undefined, undefined, true);
  }
 }
 #heldHasToken(token: string): boolean { for (const r of this.#heldAlertAdmissions.values()) if (r.token === token) return true; return false; }
 #onProgress(frame: SubagentProgressPayload): void {
  if (!this.#enabled() || !frame?.runToken || frame.owned !== true) return;
  if (this.#alerts()) this.#observeAnomaly(frame, "progress");
  const entry = this.#tracked.get(frame.runToken);
  if (!entry) return;
  entry.lastActivityAt = this.#now(); this.#scheduleRecencyRecompute();
  if (frame.runEffectiveModelIdentity && frame.runEffectiveThinkingLevel) this.#confirmPair(entry, frame.runEffectiveModelIdentity, frame.runEffectiveThinkingLevel);
  const lines = frame.progress?.recentOutput;
  if (Array.isArray(lines)) entry.excerpt = lines.filter(line => typeof line === "string" && line.trim()).slice().reverse().join("\n").slice(-800);
 }
 #confirmPair(entry: Run, model: string, effort: string): void {
  if (entry.model === model && entry.thinkingLevel === effort) return;
  entry.model = model; entry.thinkingLevel = effort; entry.attributionRevision++;
  const cached = this.#scoresById.get(entry.id);
  if (cached && !pairCompatible(cached, entry)) this.#scoresById.delete(entry.id);
  if (this.#scoring()) {
   for (const run of this.#tracked.values()) if (run.id === entry.id && !pairCompatible(this.#scoresById.get(run.id), run)) this.#unscored.add(run.token);
   this.#requestRoster("attribution");
  }
  this.#recomputeVoiced();
 }
 #onEvent(frame: SubagentEventPayload): void {
  if (!this.#enabled() || !frame?.runToken || frame.owned !== true) return;
  const entry = this.#tracked.get(frame.runToken);
  if (!entry) return;
  entry.lastActivityAt = this.#now(); this.#scheduleRecencyRecompute();
  const event = frame.event;
  if (event.type === "message_end" && event.message.role === "assistant") {
   entry.thinkingRelayedLength = 0;
   if (entry.voiced && event.message.stopReason === "toolUse") {
    const text = this.#deps.extractAssistantText(event.message).trim();
    if (text) this.#commentary(`Subagent ${entry.agent} progress: `, text, "subagent-progress", entry.depth);
   }
  } else if (entry.voiced && event.type === "message_update" && event.message.role === "assistant") this.#relayThinking(entry, event.message);
 }
 #relayThinking(entry: Run, message: AssistantMessage): void {
  const thinking = message.content.filter(block => block.type === "thinking").map(block => block.thinking).join("");
  const delta = thinking.slice(entry.thinkingRelayedLength);
  if (delta.length < 280 || this.#now() - entry.lastThinkingFlushAt < LIVE_INGEST_THINKING_FLUSH_MS) return;
  const end = Math.max(delta.lastIndexOf(". "), delta.lastIndexOf("\n"));
  if (end < 120) return;
  const cut = delta.slice(0, end + 1).trim();
  if (!cut) return;
  entry.thinkingRelayedLength += end + 1;
  entry.lastThinkingFlushAt = this.#now();
  this.#speak("subagent-thinking", `Subagent ${entry.agent} reasoning (live, provisional): ${excerpt(cut, 380)}`, "thinking", entry.depth);
 }
 #onSessionEvent(event: AgentSessionEvent): void {
  if (!this.#attached) return;
  if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "advisor") {
   const notes = (event.message.details as { notes?: Array<{ advisor?: string; severity?: string; note?: string; text?: string }> } | undefined)?.notes;
   for (const note of notes ?? []) {
    const severity = note.severity === "blocker" || note.severity === "concern" ? note.severity : "nit";
    if (!this.#deps.settings.get().advisorNotes[severity]) continue;
    const text = note.note ?? note.text ?? "";
    if (text) this.#speak("advisor-notes", `Advisor note from ${note.advisor ?? "advisor"} (${severity}): ${text}`, "report", undefined, severity === "blocker", false, () => this.#deps.settings.get().advisorNotes[severity]);
   }
  } else if (event.type === "advisor_message" && event.message.role === "assistant" && this.#deps.settings.get().advisorThinking) {
   const thinking = event.message.content.filter(block => block.type === "thinking").map(block => block.thinking).join("\n").trim();
   if (thinking) this.#speak("advisor-thinking", `Advisor ${event.advisor} reasoning (finalized): ${excerpt(thinking, 380)}`, "thinking");
  }
 }
 #prune(list: number[]): void { const cutoff = this.#now() - LIVE_INGEST_WINDOW_MS; while (list.length && list[0] <= cutoff) list.shift(); }
 #window(key: string): number[] { let list = this.#history.get(key); if (!list) { list = []; this.#history.set(key, list); } this.#prune(list); return list; }
 #admit(source: Source, depth?: number, blocker = false, report = false): boolean {
  const keyed = source === "subagent-alert" ? "alert-reserve" : blocker ? "blocker-reserve" : source === "subagent-progress" ? "commentary" : source;
  const limit = source === "subagent-alert" ? LIVE_INGEST_ALERT_RESERVE : blocker ? LIVE_INGEST_BLOCKER_RESERVE : source === "subagent-progress" ? LIVE_INGEST_MAX_COMMENTARY_PER_WINDOW : LIVE_INGEST_MAX_PER_WINDOW;
  const own = this.#window(keyed);
  if (depth !== undefined && (source === "subagent-thinking" || source === "subagent-progress")) {
   const perDepth = this.#depthHistory.get(`${source}:${depth}`) ?? [];
   this.#prune(perDepth); this.#depthHistory.set(`${source}:${depth}`, perDepth);
   const max = Math.max(1, Math.round(limit * (this.#depthWeights.get(depth) ?? 1)));
   if (perDepth.length >= max) { this.#drop(source); return false; }
  }
  const aggregate = this.#window("aggregate");
  const reservedReports = this.#window("report-reserve");
  if (own.length >= limit || (!report || reservedReports.length >= LIVE_INGEST_REPORT_RESERVE) && aggregate.length >= LIVE_INGEST_MAX_TOTAL_PER_WINDOW) { this.#drop(source); return false; }
  const now = this.#now(); own.push(now); aggregate.push(now);
  if (report) reservedReports.push(now);
  if (depth !== undefined && (source === "subagent-thinking" || source === "subagent-progress")) this.#depthHistory.get(`${source}:${depth}`)!.push(now);
  return true;
 }
 #drop(source: Source): void { this.#dropped.set(source, (this.#dropped.get(source) ?? 0) + 1); }
 #annotation(source: Source): string { const n = this.#dropped.get(source) ?? 0; this.#dropped.delete(source); return n ? `(${n} earlier updates skipped) ` : ""; }
 #speak(source: Source, text: string, kind: "report" | "thinking" = "report", depth?: number, blocker = false, report = false, gate: () => boolean = () => true): void {
  if (!this.#admit(source, depth, blocker, report)) return;
  const i = text.indexOf(": ");
  const labeled = i >= 0 ? text.slice(0, i + 2) + this.#annotation(source) + text.slice(i + 2) : this.#annotation(source) + text;
  this.#deps.sink.appendSpeakableContext(fit(labeled), kind, () => this.#attached && gate() && (source !== "subagent-alert" || this.#alerts()) && (!source.startsWith("subagent-") || this.#enabled()) && (source !== "advisor-thinking" || this.#deps.settings.get().advisorThinking));
 }
 #commentary(label: string, body = "", source?: Source, depth?: number): void {
  if (source) {
   if (!this.#admit(source, depth)) return;
  } else {
   const window = this.#window("commentary"), aggregate = this.#window("aggregate");
   if (window.length >= LIVE_INGEST_MAX_COMMENTARY_PER_WINDOW || aggregate.length >= LIVE_INGEST_MAX_TOTAL_PER_WINDOW) return;
   window.push(this.#now()); aggregate.push(this.#now());
  }
  this.#deps.sink.appendCommentaryContext(fit(label + (source ? this.#annotation(source) : "") + body));
 }
 #effective(run: Run): number { const score = this.#scoring() && pairCompatible(this.#scoresById.get(run.id), run) ? this.#scoresById.get(run.id) : undefined; return (score?.importance ?? 0) * Math.max(.2, 1 - Math.max(0, this.#now() - run.lastActivityAt) / LIVE_INGEST_RECENCY_HORIZON_MS); }
 #weight(depth: number): number { return this.#depthWeights.get(depth) ?? 1; }
 #rank(a: Run, b: Run): number {
  const aa = this.#scoring() && pairCompatible(this.#scoresById.get(a.id), a);
  const bb = this.#scoring() && pairCompatible(this.#scoresById.get(b.id), b);
  return Number(bb) - Number(aa) || (aa ? this.#effective(b) - this.#effective(a) : 0) || a.startedAt - b.startedAt || a.seq - b.seq;
 }
 #sortNames(a: Run, b: Run): number { return this.#weight(b.depth) - this.#weight(a.depth) || this.#effective(b) - this.#effective(a) || a.seq - b.seq; }
 #recomputeVoiced(): void {
  this.#cancel("recencyTrailing"); this.#lastRecompute = this.#now();
  const previous = new Set([...this.#tracked.values()].filter(r => r.voiced).map(r => r.token));
  const byDepth = new Map<number, Run[]>();
  for (const run of this.#tracked.values()) { run.voiced = false; const list = byDepth.get(run.depth) ?? []; list.push(run); byDepth.set(run.depth, list); }
  const slots = this.#deps.settings.get().voicedSlotsByDepth;
  for (const [depth, runs] of byDepth) {
   runs.sort((a, b) => this.#rank(a, b));
   const limit = slots[Math.min(depth, slots.length) - 1];
   for (const run of runs.slice(0, limit === -1 ? undefined : limit)) run.voiced = true;
  }
  const current = new Set([...this.#tracked.values()].filter(r => r.voiced).map(r => r.token));
  for (const token of current) { const r = this.#tracked.get(token)!; this.#cueSnapshots.set(token, { agent: r.agent, letter: letterOf(r.thinkingLevel), depth: r.depth, seq: r.seq, effective: this.#effective(r), weight: this.#weight(r.depth) }); }
  for (const token of this.#cueSnapshots.keys()) if (!current.has(token) && !this.#cueReported.has(token)) this.#cueSnapshots.delete(token);
  if (this.#deps.settings.get().voicedChangeCue && (previous.size !== current.size || [...previous].some(token => !current.has(token)))) this.#timer("cue", () => this.#flushCue(), LIVE_INGEST_CUE_QUIET_MS);
 }
 #scheduleRecencyRecompute(): void {
  const elapsed = this.#now() - this.#lastRecompute;
  if (elapsed >= LIVE_INGEST_RECOMPUTE_MIN_MS) this.#recomputeVoiced();
  else if (!this.#timers.has("recencyTrailing")) this.#timer("recencyTrailing", () => { if (this.#enabled()) this.#recomputeVoiced(); }, LIVE_INGEST_RECOMPUTE_MIN_MS - Math.max(0, elapsed));
 }
 #tickRecency(): void {
  if (!this.#tracked.size || !this.#enabled()) { this.#cancel("recencyTick"); this.#cancel("recencyTrailing"); return; }
  if (!this.#timers.has("recencyTick")) this.#timer("recencyTick", () => { if (this.#enabled()) { this.#recomputeVoiced(); this.#tickRecency(); } }, LIVE_INGEST_RECENCY_TICK_MS);
 }
 #flushCue(): void {
  if (!this.#enabled() || !this.#deps.settings.get().voicedChangeCue) return;
  const current = new Set([...this.#tracked.values()].filter(r => r.voiced).map(r => r.token));
  const sorted = (tokens: string[]) => tokens.sort((a,b) => { const x = this.#cueSnapshots.get(a)!; const y = this.#cueSnapshots.get(b)!; return y.weight-x.weight || y.effective-x.effective || x.seq-y.seq; }).map(token => { const r = this.#cueSnapshots.get(token)!; return `${r.agent}${r.letter ? ` (class ${r.letter})` : ""}`; });
  const added = sorted([...current].filter(t => !this.#cueReported.has(t)));
  const removed = sorted([...this.#cueReported].filter(t => !current.has(t) && this.#cueSnapshots.has(t)));
  if (added.length || removed.length) {
   let a = added.length, r = removed.length;
   const render = () => {
    const parts: string[] = [];
    if (added.length) parts.push(`Now tracking ${added.slice(0,a).join(", ")}${a < added.length ? `${a ? ", " : ""}and ${added.length-a} more` : ""}`);
    if (removed.length) parts.push(`released ${removed.slice(0,r).join(", ")}${r < removed.length ? `${r ? ", " : ""}and ${removed.length-r} more` : ""}`);
    return parts.join("; ") + ".";
   };
   const annotation = (this.#dropped.get("subagent-voiced") ?? 0) ? `(${this.#dropped.get("subagent-voiced")} earlier updates skipped) ` : "";
   while (bytes(render()) + bytes(annotation) > 500 && (a || r)) {
    if (a && (!r || bytes(added[a-1]) >= bytes(removed[r-1]))) a--;
    else r--;
   }
   this.#speak("subagent-voiced", render());
  }
  this.#cueReported = current;
  for (const token of this.#cueSnapshots.keys()) if (!current.has(token)) this.#cueSnapshots.delete(token);
 }
 #flushStarts(): void {
  if (!this.#enabled()) return;
  const starts = this.#pendingStarts.splice(0); let rest = this.#pendingStartOverflow; this.#pendingStartOverflow = 0;
  if (!starts.length && !rest) return;
  const named = starts.map(s => this.#tracked.get(s.token)).filter((r): r is Run => !!r?.voiced).sort((a,b) => this.#sortNames(a,b));
  rest += starts.length - named.length;
  const high = rest + named.length >= 10 || named.some(r => letterOf(r.thinkingLevel) === "X" && !lowBase(r.model));
  const priority = rest + named.length >= 5 || named.some(r => ["E", "X"].includes(letterOf(r.thinkingLevel) ?? "") && !lowBase(r.model));
  const prefix = `${high ? "High priority: " : priority ? "Priority: " : ""}Subagents started: `;
  const annotation = (this.#dropped.get("subagent-start") ?? 0) ? `(${this.#dropped.get("subagent-start")} earlier updates skipped) ` : "";
  let shown: string[] = [];
  for (const r of named) {
   const part = `${r.agent}${letterOf(r.thinkingLevel) ? `, class ${letterOf(r.thinkingLevel)}` : ""}, depth ${r.depth}`;
   const next = [...shown, part]; const omitted = rest + named.length - next.length;
   if (bytes(prefix + annotation + next.join("; ") + (omitted ? `; plus ${omitted} more` : "") + ".") > 500) break;
   shown = next;
  }
  rest += named.length - shown.length;
  const body = shown.join("; ") + (rest ? `${shown.length ? "; " : ""}plus ${rest} more` : "") + ".";
  if (!this.#admit("subagent-start")) return;
  this.#annotation("subagent-start");
  this.#deps.sink.appendSpeakableContext(prefix + annotation + body, "report", () => this.#enabled());
 }
 #appendJournal(row: Omit<RosterJournalEntry, "seq" | "at">): void {
  const entry = { seq: ++this.#journalSeq, at: this.#now(), ...row };
  this.#journal.push(entry);
  const seqs = this.#journalIndex.get(entry.id) ?? []; seqs.push(entry.seq); this.#journalIndex.set(entry.id, seqs);
  if (this.#journal.length > LIVE_INGEST_JOURNAL_MAX) {
   const old = this.#journal.shift()!; const index = this.#journalIndex.get(old.id)!; index.shift(); if (!index.length) { this.#journalIndex.delete(old.id); if (![...this.#tracked.values()].some(run => run.id === old.id)) this.#provenMembers.delete(old.id); }
  }
 }
 #onRegistryEvent(event: RegistryEvent): void {
  if (!this.#enabled() || event.ref.kind !== "sub" || event.type === "metadata_changed") return;
  const { id, parentId, status } = event.ref;
  const seen = new Set<string>(); let cursor = parentId; let member = false;
  for (let i=0; cursor && i<64 && !seen.has(cursor); i++) {
   if (cursor === this.#rootId()) { member = true; break; }
   seen.add(cursor); cursor = this.#deps.registry.get(cursor)?.parentId;
  }
  if (!member && event.type === "removed" && this.#provenMembers.has(id)) member = true;
  if (!member) return;
  this.#provenMembers.add(id);
  this.#appendJournal({ id, parentId, state: event.type === "removed" ? "removed" : status === "idle" || status === "parked" ? status : "running" });
  this.#postponeRoster();
 }
 #requestRoster(reason: Reason): void {
  if (!this.#scoring()) return;
  this.#rosterReasons.add(reason); this.#rosterDueAt = this.#now() + this.#deps.settings.get().classifierQuietMs;
  this.#scheduleBatch();
 }
 #postponeRoster(): void { if (this.#rosterDueAt !== undefined && this.#rosterReasons.size) { this.#rosterDueAt = this.#now() + this.#deps.settings.get().classifierQuietMs; this.#scheduleBatch(); } }
 #armPeriodic(): void {
  if (this.#timers.has("periodic") || !this.#scoring() || !this.#deps.settings.get().rescoreIntervalMs || !this.#tracked.size) return;
  this.#timer("periodic", () => { this.#requestRoster("periodic"); this.#armPeriodic(); }, this.#deps.settings.get().rescoreIntervalMs);
 }
 #scheduleBatch(): void {
  this.#cancel("batch"); if (this.#batchInFlight || !this.#enabled()) return;
  const times = [this.#scoring() && this.#tracked.size ? this.#rosterDueAt : undefined, this.#alerts() && this.#pendingAlerts.size ? this.#alertDueAt : undefined].filter((n): n is number => n !== undefined);
  if (times.length) this.#timer("batch", () => { void this.#runBatch(); }, Math.min(...times) - this.#now());
 }
 #enableCatalog(): void {
  if (this.#catalog || !this.#alerts()) return;
  this.#catalog = new LiveModelCatalogLoader({ io: this.#deps.catalogIo, now: this.#now, onWarning: message => this.#deps.notify?.("warning", message), onChange: (previous,current) => this.#catalogChanged(previous.revision !== current.revision) });
  this.#catalogListener = cfgLiveModelCatalogPath.listen(this.#deps.session.settings, path => { void this.#catalog?.setPath(path); });
  void this.#catalog.setPath(cfgLiveModelCatalogPath.get(this.#deps.session.settings));
  this.#catalogTick();
 }
 #catalogTick(): void {
  this.#cancel("catalog"); if (!this.#alerts()) return;
  this.#timer("catalog", () => { void this.#catalog?.refresh(); this.#catalogTick(); }, 5_000);
 }
 #catalogChanged(changed: boolean): void {
  if (!changed || !this.#alerts() || !this.#catalog) return;
  const { generation, revision } = this.#catalog.snapshot;
  this.#overflow.invalidatePolicy(generation, revision);
  this.#overflowAdmitted = false; this.#overflowAdmissionVersion++;
  this.#heldAlertAdmissions.clear();
  const revisit = [...this.#prelookup.values(), ...[...this.#pendingAlerts.values(), ...this.#judgingAlerts.values(), ...this.#settledAlerts.values()].map(r => ({ token:r.token,id:r.id,agent:r.agent,depth:r.depth,parentId:r.parentId,runKind:"spawn",model:r.slug,effort:r.effort,observedAt:r.observedAt,observationRevision:r.observationRevision,endedAt:r.endedAt }))];
  this.#pendingAlerts.clear(); this.#judgingAlerts.clear(); this.#settledAlerts.clear(); this.#prelookup.clear(); this.#alertDueAt = undefined;
  for (const record of revisit) this.#lookupObservation(record);
  this.#flushOverflow();
 }
 #observeAnomaly(frame: SubagentLifecyclePayload | SubagentProgressPayload, source: "started" | "snapshot" | "progress"): void {
  if (!this.#alerts()) return;
  const token = frame.runToken;
  if (!token || this.#deps.registry.get("id" in frame ? frame.id : activeSubagentRuns(this.#deps.subagentEventBus!).get(token)?.id ?? "")?.kind && this.#deps.registry.get("id" in frame ? frame.id : activeSubagentRuns(this.#deps.subagentEventBus!).get(token)?.id ?? "")?.kind !== "sub") return;
  const prior = this.#prelookup.get(token) ?? this.#pendingAlerts.get(token) ?? this.#judgingAlerts.get(token) ?? this.#settledAlerts.get(token);
  const start = source === "progress" ? activeSubagentRuns(this.#deps.subagentEventBus!).get(token) : frame as SubagentLifecyclePayload;
  if (!start && !prior) return;
  const model = source === "progress" ? frame.runEffectiveModelIdentity : start?.runEffectiveModelIdentity;
  const effort = source === "progress" ? frame.runEffectiveThinkingLevel : start?.runEffectiveThinkingLevel;
  if (!model || !effort || !letterOf(effort)) return;
  const fingerprint = JSON.stringify([model, effort]);
  if (prior && JSON.stringify(["model" in prior ? prior.model : prior.slug, prior.effort]) === fingerprint && prior.observationRevision) return;
  const observationRevision = (this.#observationRevision.get(token) ?? 0) + 1;
  if (this.#observationRevision.size > 712) {
   const ledger = this.#deps.subagentEventBus ? activeSubagentRuns(this.#deps.subagentEventBus) : new Map();
   const old = [...this.#observationRevision.keys()].find(key => !ledger.has(key) && !this.#prelookup.has(key) && !this.#pendingAlerts.has(key) && !this.#judgingAlerts.has(key) && !this.#heldHasToken(key));
   if (old) this.#observationRevision.delete(old);
  }
  this.#observationRevision.set(token, observationRevision);
  const id = start?.id ?? prior?.id ?? "";
  const pre: Prelookup = { token, id, agent: start?.agent ?? prior?.agent ?? id, depth: start ? this.#depth(id,start.depth) : prior?.depth, parentId: this.#deps.registry.get(id)?.parentId ?? prior?.parentId, runKind: start?.runKind ?? "spawn", model, effort, observedAt: this.#now(), observationRevision, endedAt: prior?.endedAt };
  this.#lookupObservation(pre);
 }
 #overflowObservation(record: Prelookup | Alert, category: "known" | "unknown"): OverflowObservation {
  const slug = "model" in record ? record.model : record.slug;
  const effort = record.effort;
  return { token: record.token, fingerprint: JSON.stringify([slug, effort]), observationRevision: record.observationRevision, category, slug, letter: letterOf(effort) as OverflowObservation["letter"], replayable: !!this.#deps.subagentEventBus && activeSubagentRuns(this.#deps.subagentEventBus).has(record.token) || this.#prelookup.has(record.token) || this.#pendingAlerts.has(record.token) || this.#judgingAlerts.has(record.token) || this.#heldHasToken(record.token) };
 }
 #lookupObservation(record: Prelookup): void {
  const lookup = this.#catalog?.lookup(record.model, record.effort);
  if (!lookup || lookup.status === "unavailable") {
   this.#prelookup.delete(record.token); this.#prelookup.set(record.token, record);
   if (this.#prelookup.size > 64) { const oldest = this.#prelookup.keys().next().value!; const evicted = this.#prelookup.get(oldest)!; this.#prelookup.delete(oldest); this.#overflow.count(this.#overflowObservation(evicted,"unknown")); this.#flushOverflow(); }
   return;
  }
  this.#prelookup.delete(record.token);
  this.#overflow.observe(this.#overflowObservation(record, lookup.status === "present" && lookup.recommendation === "never" ? "known" : "unknown"));
  if (lookup.status !== "present") {
   const pair = JSON.stringify([record.model,record.effort]);
   if (!this.#missingPairs.has(pair)) { this.#missingPairs.add(pair); if (this.#missingPairs.size > 64) this.#missingPairs.delete(this.#missingPairs.keys().next().value!); this.#commentary(`Live ingest: no catalog entry for ${record.model} at ${record.effort}.`); }
   return;
  }
  if (lookup.recommendation === "avoid") {
   const selection = `${record.token}:${record.observationRevision}`;
   if (!this.#avoidSelections.has(selection)) { this.#avoidSelections.add(selection); if (this.#avoidSelections.size > 64) this.#avoidSelections.delete(this.#avoidSelections.keys().next().value!); this.#commentary(`Attention: ${record.agent} runs ${record.model} at ${record.effort}, which the catalog marks avoid.`); }
  } else if (lookup.recommendation === "never") {
   const snapshot = this.#catalog!.snapshot;
   const current = this.#pendingAlerts.get(record.token) ?? this.#judgingAlerts.get(record.token) ?? this.#settledAlerts.get(record.token);
   if (current && current.slug === record.model && current.effort === record.effort && current.catalogGeneration === snapshot.generation && current.catalogRevision === snapshot.revision) return;
   const alert: Alert = { token: record.token, id: record.id, agent: record.agent, slug: record.model, effort: record.effort, letter: letterOf(record.effort)!, depth: record.depth, parentId: record.parentId, observedAt: record.observedAt, selectionFingerprint: JSON.stringify([record.model,record.effort]), selectionRevision: (current?.selectionRevision ?? 0) + 1, observationRevision: record.observationRevision, catalogGeneration: snapshot.generation, catalogRevision: snapshot.revision, endedAt: record.endedAt };
   this.#pendingAlerts.delete(record.token); this.#judgingAlerts.delete(record.token); this.#settledAlerts.delete(record.token);
   if (this.#pendingAlerts.size >= 64) { const oldest = this.#pendingAlerts.keys().next().value!; const evicted = this.#pendingAlerts.get(oldest)!; this.#pendingAlerts.delete(oldest); this.#overflow.count(this.#overflowObservation(evicted,"known")); this.#flushOverflow(); }
   this.#pendingAlerts.set(alert.token, alert);
   if (this.#alertDueAt === undefined) this.#alertDueAt = this.#now() + 2_000;
   this.#scheduleBatch();
  }
 }
 #validAlert(record: Alert): boolean {
  const snapshot = this.#catalog?.snapshot;
  return this.#alerts() && !!snapshot && snapshot.generation === record.catalogGeneration && snapshot.revision === record.catalogRevision && this.#catalog?.lookup(record.slug,record.effort).status === "present" && this.#catalog.lookup(record.slug,record.effort).status === "present" && (this.#catalog.lookup(record.slug,record.effort) as {recommendation?:string}).recommendation === "never";
 }
 #flushOverflow(): void {
  if (!this.#alerts() || !this.#overflow.hasPending || this.#overflow.hasReceipt || this.#overflowAdmitted) return;
  const attempt = () => {
   if (!this.#alerts() || !this.#overflow.hasPending || this.#overflow.hasReceipt || this.#overflowAdmitted) return;
   if (!this.#admit("subagent-alert")) { this.#timer("overflow", attempt, Math.max(1, LIVE_INGEST_WINDOW_MS - (this.#now() - (this.#overflow.firstPendingAt ?? this.#now())))); return; }
   const epochs = { call: this.#callEpoch, source: this.#sourceEpoch, alert: this.#alertRevision };
   const version = ++this.#overflowAdmissionVersion;
   const policy = this.#catalog?.snapshot;
   this.#overflowAdmitted = true;
   const canDeliver = () => this.#alerts() && version === this.#overflowAdmissionVersion && epochs.call === this.#callEpoch && epochs.source === this.#sourceEpoch && epochs.alert === this.#alertRevision && policy?.generation === this.#catalog?.snapshot.generation && policy?.revision === this.#catalog?.snapshot.revision;
   const accepted = this.#deps.sink.appendOverflowAlertContext(() => this.#overflow.render(epochs) ?? {text:"",receiptId:-1}, canDeliver, (id,ok) => { this.#overflow.onReceipt(id,ok,epochs); if (version === this.#overflowAdmissionVersion) { this.#overflowAdmitted = false; this.#flushOverflow(); } });
   if (!accepted) { this.#overflowAdmitted = false; this.#timer("overflow",attempt,1_000); }
  };
  attempt();
 }
 #speakAlert(record: Alert, checked: boolean): void {
  if (!this.#validAlert(record)) return;
  if (!this.#admit("subagent-alert")) return;
  const id = ++this.#nextAdmissionId; this.#heldAlertAdmissions.set(id, record);
  const prefix = `Red alert: ${record.agent} ${record.endedAt === undefined ? "is running" : "was dispatched"} ${record.slug} at ${record.effort} (class ${record.letter}) at depth ${record.depth ?? "?"}, dispatched by ${record.parentId ?? "unknown"}; the catalog marks that never; `;
  const text = fit(prefix + (checked ? "I found no authorization in the transcript." : "authorization not checked."));
  const canDeliver = () => this.#validAlert(record) && this.#heldAlertAdmissions.get(id) === record;
  const accepted = this.#deps.sink.appendSpeakableContext(text,"report",canDeliver,() => { this.#heldAlertAdmissions.delete(id); this.#overflow.setReplayable(record.token, !!this.#deps.subagentEventBus && activeSubagentRuns(this.#deps.subagentEventBus).has(record.token)); });
  if (!accepted) this.#heldAlertAdmissions.delete(id);
 }
 async #runBatch(): Promise<void> {
  if (this.#batchInFlight || !this.#enabled()) return;
  const now = this.#now();
  const scoring = this.#scoring() && this.#tracked.size > 0 && this.#rosterDueAt !== undefined && this.#rosterDueAt <= now;
  const alerts = this.#alerts() && this.#pendingAlerts.size > 0 && this.#alertDueAt !== undefined && this.#alertDueAt <= now;
  if (!scoring && !alerts) { this.#scheduleBatch(); return; }
  const reasons = scoring ? new Set(this.#rosterReasons) : new Set<Reason>();
  if (scoring) { this.#rosterReasons.clear(); this.#rosterDueAt = undefined; }
  const captured = alerts ? [...this.#pendingAlerts.values()] : [];
  if (alerts) { for (const record of captured) { this.#pendingAlerts.delete(record.token); this.#judgingAlerts.set(record.token, record); } this.#alertDueAt = undefined; }
  const scoringRevision = this.#scoringRevision, alertRevision = this.#alertRevision, sourceEpoch = this.#sourceEpoch;
  const journal = this.#journal.filter(row => row.seq > this.#lastJournalSeqSent);
  this.#lastJournalSeqSent = this.#journal.at(-1)?.seq ?? this.#lastJournalSeqSent;
  const roster = [...this.#tracked.values()].map(run => ({ run, revision:run.attributionRevision, model:run.model, thinkingLevel:run.thinkingLevel, seq:run.seq }));
  const prose = renderClassifierProse(this.#deps.session.messages);
  const input: ClassifierInput = {
   agents: roster.map(({run:r,model,thinkingLevel}) => ({ token:r.token,id:r.id,name:r.agent,model:model ?? "unknown",thinkingLevel:thinkingLevel ?? "unknown",depth:r.depth,state:"running",parentId:r.parentId,runKind:r.runKind,startedAt:r.startedAt,lastActivityAt:r.lastActivityAt,idleMs:Math.max(0,now-r.lastActivityAt),description:r.description,excerpt:r.excerpt })),
   alertCandidates: captured.map(r => ({token:r.token,id:r.id,agent:r.agent,slug:r.slug,effort:r.effort,depth:r.depth,parentId:r.parentId,observedAt:r.observedAt,endedAt:r.endedAt})),
   previous: [...this.#scoresById].map(([id,score]) => ({id,importance:score.importance,lastScoredAt:score.lastScoredAt})),
   journal, subject:prose.subject, proseBlocks:prose.blocks, proseMode:this.#seedPending ? "seed" : alerts ? "authorizationHistory" : "recentProse", historyComplete:prose.historyComplete,
  };
  const controller = new AbortController();
  const parentAbort = () => controller.abort(this.#abort.signal.reason);
  this.#abort.signal.addEventListener("abort",parentAbort,{once:true});
  if (!scoring) this.#alertOnlyAbort = controller;
  this.#batchInFlight = true;
  let applied = false;
  const remaining = new Map(captured.map(r => [r.token,r]));
  try {
   const selections = resolveClassifierSelections(this.#deps.session.settings,this.#deps.session.modelRegistry);
   let attempts = 0;
   for (const selection of selections) {
    if (controller.signal.aborted || sourceEpoch !== this.#sourceEpoch) break;
    if (!budgetClassifierInput(input,selection)) continue;
    for (let repeat=0; repeat<(captured.length ? 3 : 1); repeat++) {
     if (controller.signal.aborted || sourceEpoch !== this.#sourceEpoch || (captured.length && !remaining.size)) break;
     if (attempts++) await new Promise<void>(resolve => { const cancel = this.#setTimer(() => { controller.signal.removeEventListener("abort",abort); resolve(); },500); const abort=() => { cancel(); resolve(); }; controller.signal.addEventListener("abort",abort,{once:true}); });
     if (controller.signal.aborted) break;
     const attemptInput = input;
     const classifier = this.#deps.classify ?? ((payload:ClassifierInput,opts:{signal:AbortSignal;selection:ClassifierSelection;onPromptStart:()=>void}) => classifySubagentImportance(payload,{...opts,settings:this.#deps.session.settings,modelRegistry:this.#deps.session.modelRegistry,providerSessionState:this.#deps.session.providerSessionState,preferWebsockets:this.#deps.session.preferWebsockets}));
     let result: ClassifierResult;
     try { result = await classifier(attemptInput,{signal:controller.signal,selection,onPromptStart:() => {this.#seedPending=false;} }); } catch { continue; }
     if (sourceEpoch !== this.#sourceEpoch || controller.signal.aborted) break;
     if (scoring && !applied && scoringRevision === this.#scoringRevision && this.#scoring() && (result.scores.size > 0 || roster.length === 0)) {
      applied = true; this.#applyScores(result,roster);
     }
     if (alertRevision === this.#alertRevision && this.#alerts()) for (const [token,decision] of result.alerts ?? []) {
      const record = remaining.get(token);
      if (!record || !this.#validAlert(record) || this.#judgingAlerts.get(token) !== record) continue;
      remaining.delete(token); this.#judgingAlerts.delete(token); this.#rememberSettled(record);
      if (!decision.authorized) this.#speakAlert(record,true);
     }
    }
    if (!captured.length) break;
   }
   if (alertRevision === this.#alertRevision && this.#alerts()) for (const record of remaining.values()) {
    if (this.#judgingAlerts.get(record.token) !== record) continue;
    this.#judgingAlerts.delete(record.token); this.#rememberSettled(record);
    this.#speakAlert(record,false);
   }
   if (scoring && !applied && !this.#oneTimeNotices.has("classifier")) { this.#oneTimeNotices.add("classifier"); this.#deps.notify?.("warning","Live ingest: classifier unavailable; tracking subagents in start order."); }
  } finally {
   this.#abort.signal.removeEventListener("abort",parentAbort);
   if (this.#alertOnlyAbort === controller) this.#alertOnlyAbort = undefined;
   this.#batchInFlight = false;
   if (sourceEpoch === this.#sourceEpoch && this.#enabled()) { if (reasons.has("periodic")) this.#armPeriodic(); this.#scheduleBatch(); }
  }
 }
 #rememberSettled(record: Alert): void {
  this.#settledAlerts.delete(record.token); this.#settledAlerts.set(record.token,record);
  while (this.#settledAlerts.size > 256) this.#settledAlerts.delete(this.#settledAlerts.keys().next().value!);
 }
 #applyScores(result: ClassifierResult, roster: Array<{run:Run;revision:number;model?:string;thinkingLevel?:string;seq:number}>): void {
  const choices = new Map<string,{run:Run;score:number}>();
  for (const captured of roster) {
   const score = result.scores.get(captured.run.token); const current = this.#tracked.get(captured.run.token);
   if (score === undefined || current !== captured.run || current.seq !== captured.seq || current.attributionRevision !== captured.revision || current.model !== captured.model || current.thinkingLevel !== captured.thinkingLevel) continue;
   const previous = choices.get(current.id); if (!previous || previous.run.seq < current.seq) choices.set(current.id,{run:current,score});
  }
  for (const [id,{run,score}] of choices) {
   this.#scoresById.delete(id);
   this.#scoresById.set(id,{importance:score,lastScoredAt:this.#now(),sourceToken:run.token,attributionRevision:run.attributionRevision,model:run.model,thinkingLevel:run.thinkingLevel});
   for (const entry of this.#tracked.values()) if (entry.id === id && pairCompatible(this.#scoresById.get(id),entry)) this.#unscored.delete(entry.token);
  }
  while (this.#scoresById.size > 128) { const inactive = [...this.#scoresById.keys()].find(id => ![...this.#tracked.values()].some(run => run.id === id)); this.#scoresById.delete(inactive ?? this.#scoresById.keys().next().value!); }
  for (const [depth,weight] of result.depthWeights ?? []) if (roster.some(({run}) => run.depth === depth)) this.#depthWeights.set(depth,weight);
  this.#recomputeVoiced();
 }
}
