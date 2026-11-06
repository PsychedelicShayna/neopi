import type { CardRun, ListTasksResponse, Task } from "@npi-deck/protocol";
import { cardPropertyDocument } from "@/lib/card-frontmatter";
import { tasksApi } from "@/lib/tasks-api";
import { PREVIEW_ACCOUNTS, PREVIEW_WHEEL } from "./preview-data";
import { SOURCES } from "./source";

/** One ordered task state. Colour belongs to its editor dot, not the column fill. */
export interface BoardColumn {
	id: string;
	name: string;
	color: string;
	position: number;
	isDefault: boolean;
}
/** A slip of work, with task routing live and optional evidence supplied separately. */
export interface BoardCard {
	id: string;
	number: number;
	title: string;
	body: string;
	columnId: string;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
	archived: boolean;
	run?: CardRun;
	origin: { kind: "inbox" | "github" | "thread" | "routine" | "manual"; ref?: string };
	holder?:
		| { kind: "agent"; id?: string; name: string; hue: number; model: string }
		| { kind: "person"; handle: string; name: string; hue: number };
	parent?: string;
	evidence?: { text: string; at: string };
}
/** A timestamped receipt. Live receipts derive only from persisted task and run fields. */
export interface BoardEvent {
	id: string;
	at: string;
	actor: string;
	text: string;
	tone?: "ok" | "warn" | "bad";
}
/** Related GitHub work and the board flow that owns it. */
export interface BoardLinks {
	issue?: { repo: string; number: number; url?: string };
	pr?: { repo: string; number: number; url?: string };
	thread?: { id: string };
	flow?: { id: string; name: string };
}
/** Task operations shared by the deck endpoint and the mutable preview office. */
export interface BoardClient {
	columns(): Promise<BoardColumn[]>;
	cards(opts: { archived?: boolean }): Promise<BoardCard[]>;
	create(input: {
		title: string;
		body?: string;
		columnId?: string;
		cwd?: string;
		properties?: Record<string, unknown>;
	}): Promise<BoardCard>;
	update(
		id: string,
		patch: { title?: string; body?: string; archived?: boolean; properties?: Record<string, unknown> },
	): Promise<BoardCard>;
	move(id: string, columnId: string): Promise<BoardCard>;
	remove(id: string): Promise<void>;
	assign(id: string, model?: string): Promise<BoardCard>;
	cancel(id: string): Promise<BoardCard>;
	events(id: string): Promise<BoardEvent[]>;
	links(id: string): Promise<BoardLinks>;
	note(id: string, text: string): Promise<void>;
	createColumn(name: string): Promise<BoardColumn>;
	updateColumn(id: string, patch: { name?: string; color?: string }): Promise<BoardColumn>;
	removeColumn(id: string): Promise<void>;
	reorderColumns(ids: string[]): Promise<BoardColumn[]>;
}

const claimedEvents = new Map<string, BoardEvent[]>();

function propertiesFromBody(body: string): Record<string, unknown> {
	try {
		return cardPropertyDocument(body).properties;
	} catch {
		return {};
	}
}

function originFromBody(body: string): BoardCard["origin"] {
	const props = propertiesFromBody(body);
	const raw = props.origin ?? props.source;
	if (typeof raw === "string") {
		const kind = raw.split(/[:/ ]/, 1)[0]?.toLowerCase();
		if (kind === "inbox" || kind === "github" || kind === "thread" || kind === "routine")
			return { kind, ref: typeof props.origin_ref === "string" ? props.origin_ref : raw === kind ? undefined : raw };
	}
	const receipt = /_Promoted from inbox · [^\n]* · ([^\s_]+)_/.exec(body);
	return receipt ? { kind: "inbox", ref: receipt[1] } : { kind: "manual" };
}

function withHolder(card: BoardCard): BoardCard {
	const hasActiveRun = card.run && (card.run.status === "running" || card.run.status === "queued");
	const holder =
		card.run && (hasActiveRun || !card.holder)
			? {
					kind: "agent" as const,
					id: card.run.id,
					name: `Agent ${card.run.id.slice(-8)}`,
					hue: 40,
					model: card.run.role ? `@${card.run.role}` : (card.run.model ?? "Deck default"),
				}
			: card.holder;
	const latest = card.run?.error ?? card.run?.outcome;
	return {
		...card,
		holder,
		evidence: card.evidence ?? (latest ? { text: latest, at: card.run?.finishedAt ?? card.updatedAt } : undefined),
	};
}

function fromTask(task: Task): BoardCard {
	const props = propertiesFromBody(task.body);
	const rawHolder = props.holder && typeof props.holder === "object" ? (props.holder as Record<string, unknown>) : {};
	let holder: BoardCard["holder"];
	if (rawHolder.kind === "person" && typeof rawHolder.handle === "string")
		holder = {
			kind: "person",
			handle: rawHolder.handle,
			name: typeof rawHolder.name === "string" ? rawHolder.name : rawHolder.handle,
			hue: typeof rawHolder.hue === "number" ? rawHolder.hue : 40,
		};
	if (rawHolder.kind === "agent" && typeof rawHolder.id === "string")
		holder = {
			kind: "agent",
			id: rawHolder.id,
			name: typeof rawHolder.name === "string" ? rawHolder.name : rawHolder.id,
			model: typeof rawHolder.model === "string" ? rawHolder.model : "Unknown",
			hue: typeof rawHolder.hue === "number" ? rawHolder.hue : 40,
		};
	return withHolder({
		id: task.id,
		number: task.displayId,
		title: task.title,
		body: task.body,
		columnId: task.stateId,
		cwd: task.cwd,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		archived: Boolean(task.archivedAt),
		run: task.run,
		evidence: task.evidence,
		origin: originFromBody(task.body),
		holder,
		parent: typeof props.parent === "string" ? props.parent : undefined,
	});
}

function runEvents(card: BoardCard): BoardEvent[] {
	const events: BoardEvent[] = [
		{
			id: `${card.id}-created`,
			at: card.createdAt,
			actor: "",
			text: card.origin.kind === "inbox" ? "captured from the inbox" : "card created",
		},
	];
	const run = card.run;
	if (run) {
		events.push({
			id: `${run.id}-assigned`,
			at: run.assignedAt,
			actor: "",
			text: `assigned to Worker${run.model ? ` (${run.model})` : ""}`,
		});
		if (run.startedAt)
			events.push({ id: `${run.id}-started`, at: run.startedAt, actor: "Worker", text: "started work" });
		if (run.finishedAt)
			events.push({
				id: `${run.id}-finished`,
				at: run.finishedAt,
				actor: "Worker",
				text: run.error ?? run.outcome ?? `run ${run.status}`,
				tone: run.status === "failed" ? "bad" : run.status === "completed" ? "ok" : "warn",
			});
	}
	return [...events, ...(claimedEvents.get(card.id) ?? [])].sort((a, b) => a.at.localeCompare(b.at));
}

function fixtureLinks(card: BoardCard): BoardLinks {
	if (SOURCES.boardEvidence !== "preview") return {};
	const linked = PREVIEW_WHEEL.find(item => item.card === `T-${card.number}`);
	if (!linked) return {};
	const ref = { repo: linked.repo, number: linked.number };
	return {
		...(linked.stage === "pr" || linked.stage === "review" || linked.stage === "merged" || linked.stage === "nightly"
			? { pr: ref }
			: { issue: ref }),
		flow: { id: "b_wheel", name: "implementation-wheel" },
	};
}

let pendingList: Promise<ListTasksResponse> | null = null;
function list(): Promise<ListTasksResponse> {
	pendingList ??= tasksApi.list({ includeArchived: true }).finally(() => {
		pendingList = null;
	});
	return pendingList;
}
const liveCards = new Map<string, BoardCard>();
function remember(task: Task): BoardCard {
	const card = fromTask(task);
	liveCards.set(card.id, card);
	return card;
}
async function liveCard(id: string): Promise<BoardCard> {
	const task = (await tasksApi.list({ includeArchived: true })).tasks.find(t => t.id === id);
	if (!task) throw new Error("This card no longer exists. Close it and refresh the board.");
	return remember(task);
}

const live: BoardClient = {
	async columns() {
		return (await list()).states.sort((a, b) => a.position - b.position);
	},
	async cards(opts) {
		return (await list()).tasks.filter(t => opts.archived || !t.archivedAt).map(remember);
	},
	async create(input) {
		return remember(
			await tasksApi.create({
				title: input.title,
				body: input.body,
				stateId: input.columnId,
				cwd: input.cwd,
				properties: input.properties,
			}),
		);
	},
	async update(id, patch) {
		return remember(await tasksApi.update(id, patch));
	},
	async move(id, columnId) {
		const peers = (await tasksApi.list()).tasks.filter(t => t.stateId === columnId && t.id !== id);
		return remember(await tasksApi.move(id, { stateId: columnId, index: peers.length }));
	},
	async remove(id) {
		await tasksApi.remove(id);
		liveCards.delete(id);
	},
	async assign(id, model) {
		await tasksApi.assign(id, model);
		return liveCard(id);
	},
	async cancel(id) {
		await tasksApi.cancel(id);
		return liveCard(id);
	},
	async events(id) {
		return (await evidenceRequest<{ events: BoardEvent[] }>(id, "events")).events;
	},
	async links(id) {
		return evidenceRequest<BoardLinks>(id, "links");
	},
	async note(id, text) {
		await evidenceRequest(id, "events", { method: "POST", body: JSON.stringify({ text }) });
	},
	createColumn: name => tasksApi.createState({ name }),
	updateColumn: (id, patch) => tasksApi.updateState(id, patch),
	async removeColumn(id) {
		await tasksApi.removeState(id);
	},
	async reorderColumns(ids) {
		return (await tasksApi.reorderStates(ids)).states;
	},
};

async function evidenceRequest<T>(id: string, resource: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/${resource}`, {
		...init,
		headers: { "content-type": "application/json" },
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json() as Promise<T>;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
let previewColumns: BoardColumn[] = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, i) => ({
	id: `preview-${i}`,
	name,
	color: "#6c6c74",
	position: i,
	isDefault: i === 0,
}));
const titles = [
	"Add lastmod to the sitemap",
	"Write the 0.5 upgrade guide",
	"Decide whether docs search ships",
	"Resumable uploads for the file depot",
	"Fix anchor links after heading rename",
	"Dark theme toggle",
	"Freeze the clock in render tests",
	"Investigate the slow preview build",
	"Pin bun 1.3 in CI",
	"Cache the first render pass",
	"Publish 0.5",
	"Capture keyboard shortcuts in the guide",
];
let previewCards: BoardCard[] = titles.map((title, i) => {
	const number = i + 1;
	const run: CardRun | undefined =
		number === 5 || number === 6 || number === 8
			? {
					id: `preview-run-${number}`,
					taskId: `preview-card-${number}`,
					status: number === 8 ? "failed" : "running",
					assignedAt: ago(30),
					startedAt: ago(23),
					ownedWorktree: false,
					model: "neoproxy/heavy",
					...(number === 8
						? {
								finishedAt: ago(4),
								error: "The preview build exited with code 1. The asset manifest is missing.",
							}
						: {}),
				}
			: undefined;
	return {
		id: `preview-card-${number}`,
		number,
		title,
		body: `## What needs to happen\n\n${title}.\n\n- Keep the existing behaviour.\n- Leave the verification results on this card.`,
		columnId: `preview-${[0, 0, 0, 1, 2, 2, 4, 1, 4, 3, 0, 1][i]}`,
		cwd: `/office/${number === 4 || number === 8 ? "portal" : "atlas"}`,
		createdAt: ago(180 + i * 40),
		updatedAt: ago(4 + i * 7),
		archived: false,
		run,
		origin: {
			kind: number === 5 ? "github" : number <= 3 ? "inbox" : number === 12 ? "thread" : "manual",
			ref: number === 5 ? "#226" : undefined,
		},
		holder: number === 2 ? { kind: "person", ...PREVIEW_ACCOUNTS[1]! } : undefined,
		evidence: {
			text:
				number === 10
					? "tests pass (64)"
					: number === 5
						? "github #226"
						: number <= 3
							? "captured by lin"
							: "card updated",
			at: ago(4 + i * 7),
		},
	};
});
function getPreview(id: string): BoardCard {
	const card = previewCards.find(c => c.id === id);
	if (!card) throw new Error("This card no longer exists.");
	return withHolder(card);
}
function patchPreview(id: string, patch: Partial<BoardCard>): BoardCard {
	previewCards = previewCards.map(c => (c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString() } : c));
	return getPreview(id);
}
const preview: BoardClient = {
	async columns() {
		return [...previewColumns];
	},
	async cards(opts) {
		return previewCards.filter(c => opts.archived || !c.archived).map(withHolder);
	},
	async create(input) {
		const stamp = new Date().toISOString();
		const card: BoardCard = {
			id: crypto.randomUUID(),
			number: Math.max(0, ...previewCards.map(c => c.number)) + 1,
			title: input.title,
			body: input.body ?? "",
			cwd: input.cwd,
			columnId: input.columnId ?? previewColumns[0]!.id,
			createdAt: stamp,
			updatedAt: stamp,
			archived: false,
			origin: { kind: "manual" },
			parent: typeof input.properties?.parent === "string" ? input.properties.parent : undefined,
		};
		previewCards.push(card);
		return card;
	},
	async update(id, patch) {
		return patchPreview(id, patch);
	},
	async move(id, columnId) {
		return patchPreview(id, { columnId });
	},
	async remove(id) {
		previewCards = previewCards.filter(c => c.id !== id);
	},
	async assign(id, model) {
		const at = new Date().toISOString();
		return patchPreview(id, {
			run: {
				id: crypto.randomUUID(),
				taskId: id,
				assignedAt: at,
				startedAt: at,
				status: "running",
				model: model ?? "neoproxy/heavy",
				ownedWorktree: false,
			},
		});
	},
	async cancel(id) {
		const card = getPreview(id);
		return patchPreview(id, {
			run: card.run ? { ...card.run, status: "cancelled", finishedAt: new Date().toISOString() } : undefined,
		});
	},
	async events(id) {
		const card = getPreview(id);
		const events = runEvents(card);
		if (card.evidence) events.push({ id: `${id}-evidence`, actor: "", ...card.evidence });
		return events.sort((a, b) => a.at.localeCompare(b.at));
	},
	async links(id) {
		return fixtureLinks(getPreview(id));
	},
	async note(id, text) {
		const events = claimedEvents.get(id) ?? [];
		events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: "", text });
		claimedEvents.set(id, events);
	},
	async createColumn(name) {
		const column: BoardColumn = {
			id: crypto.randomUUID(),
			name,
			color: "#6c6c74",
			position: previewColumns.length,
			isDefault: previewColumns.length === 0,
		};
		previewColumns.push(column);
		return column;
	},
	async updateColumn(id, patch) {
		previewColumns = previewColumns.map(c => (c.id === id ? { ...c, ...patch } : c));
		return previewColumns.find(c => c.id === id)!;
	},
	async removeColumn(id) {
		const fallback = previewColumns.find(c => c.isDefault);
		if (fallback?.id === id) throw new Error("Keep the default column for cards without a destination.");
		previewColumns = previewColumns.filter(c => c.id !== id);
		previewCards = previewCards.map(c => (c.columnId === id ? { ...c, columnId: fallback!.id } : c));
	},
	async reorderColumns(ids) {
		previewColumns = ids.map((id, position) => ({ ...previewColumns.find(c => c.id === id)!, position }));
		return [...previewColumns];
	},
};

export const board: BoardClient = SOURCES.board === "live" ? live : preview;
