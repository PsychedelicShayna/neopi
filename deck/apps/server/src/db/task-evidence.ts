import type { CardRun, Task } from "@npi-deck/protocol";
import { cardFrontmatter } from "../card-properties.ts";
import { broadcastBus } from "../broadcast-bus.ts";
import { afterCommit, getDb, id, nowIso } from "./index.ts";

export interface TaskEvent { id: string; at: string; actor: string; text: string; tone?: "ok" | "warn" | "bad" }
export interface TaskLinks {
	issue?: { repo: string; number: number; url: string };
	pr?: { repo: string; number: number; url: string };
	thread?: { id: string };
	flow?: { id: string; name: string };
}

function notify(): void { broadcastBus.broadcast({ type: "tasks_changed" }); }
export function recordTaskEvent(taskId: string, text: string, actor = "", tone?: TaskEvent["tone"]): TaskEvent {
	const event: TaskEvent = { id: `te_${id().toLowerCase()}`, at: nowIso(), actor, text, ...(tone ? { tone } : {}) };
	getDb().query("INSERT INTO task_events (id, task_id, at, actor, text, tone) VALUES (?, ?, ?, ?, ?, ?)").run(event.id, taskId, event.at, actor, text, tone ?? null);
	return event;
}

export function appendTaskNote(taskId: string, text: string, actor = ""): TaskEvent {
	const event = recordTaskEvent(taskId, text, actor);
	afterCommit(notify);
	return event;
}

export function latestTaskEvidence(taskId: string, run?: CardRun): Task["evidence"] {
	const note = getDb().query<{ text: string; at: string }, [string]>("SELECT text, at FROM task_events WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(taskId);
	const text = run?.error ?? run?.outcome;
	const at = run?.finishedAt ?? run?.startedAt ?? run?.assignedAt;
	if (text && at && (!note || at >= note.at)) return { text, at };
	return note ?? undefined;
}
function runs(taskId: string): CardRun[] {
	return getDb().query<{ payload: string }, [string]>("SELECT payload FROM card_runs WHERE task_id = ? ORDER BY rowid").all(taskId).map(row => JSON.parse(row.payload) as CardRun);
}

/** Run receipts use every durable run, not just the last assignment. */
export function taskEvents(task: Task): TaskEvent[] {
	const properties = evidenceProperties(task.body);
	const events: TaskEvent[] = [{ id: `${task.id}-created`, at: task.createdAt, actor: "", text: properties.origin === "inbox" ? "Captured from the inbox" : "Card created" }];
	for (const run of runs(task.id)) {
		const worker = `Agent ${run.id.slice(-8)}`;
		events.push({ id: `${run.id}-assigned`, at: run.assignedAt, actor: "", text: `Assigned to ${worker}${run.role || run.model ? ` using ${run.role ? `@${run.role}` : run.model}` : " using the deck default"}` });
		if (run.startedAt) events.push({ id: `${run.id}-started`, at: run.startedAt, actor: worker, text: "Started work" });
		if (run.finishedAt) events.push({ id: `${run.id}-finished`, at: run.finishedAt, actor: worker, text: run.error ?? run.outcome ?? `Run ${run.status}`, tone: run.status === "completed" ? "ok" : run.status === "failed" ? "bad" : "warn" });
	}
	const stored = getDb().query<{ id: string; at: string; actor: string; text: string; tone: TaskEvent["tone"] | null }, [string]>("SELECT id, at, actor, text, tone FROM task_events WHERE task_id = ? ORDER BY at, rowid").all(task.id);
	for (const row of stored) events.push({ ...row, tone: row.tone ?? undefined });
	return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** Malformed metadata remains visible for repair without inventing evidence properties. */
export function evidenceProperties(body: string): Record<string, unknown> {
	try { return cardFrontmatter(body).properties; } catch { return {}; }
}

export function taskLinks(task: Task): TaskLinks {
	const properties = evidenceProperties(task.body);
	const links: TaskLinks = {};
	const raw = properties.links && typeof properties.links === "object" && !Array.isArray(properties.links) ? properties.links as Record<string, unknown> : properties;
	for (const kind of ["issue", "pr"] as const) {
		const value = raw[kind];
		if (value && typeof value === "object") {
			const ref = value as Record<string, unknown>;
			if (typeof ref.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(ref.repo) && Number.isSafeInteger(ref.number) && Number(ref.number) > 0) links[kind] = { repo: ref.repo, number: Number(ref.number), url: `https://github.com/${ref.repo}/${kind === "pr" ? "pull" : "issues"}/${ref.number}` };
		}
	}
	// URLs are evidence, not an assertion that an issue or PR has been merged.
	const notes = getDb().query<{ text: string }, [string]>("SELECT text FROM task_events WHERE task_id = ? ORDER BY at, rowid").all(task.id);
	const text = [task.body, ...runs(task.id).map(run => run.outcome ?? ""), ...notes.map(note => note.text)].join("\n");
	for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/g)) {
		const kind = match[2] === "pull" ? "pr" : "issue";
		links[kind] ??= { repo: match[1]!, number: Number(match[3]), url: match[0] };
	}
	const thread = raw.thread;
	if (thread && typeof thread === "object" && typeof (thread as { id?: unknown }).id === "string") links.thread = { id: (thread as { id: string }).id };
	const flow = raw.flow;
	if (flow && typeof flow === "object" && typeof (flow as { id?: unknown }).id === "string") {
		const ref = flow as { id: string; name?: unknown };
		links.flow = { id: ref.id, name: typeof ref.name === "string" ? ref.name : ref.id };
	}
	return links;
}
