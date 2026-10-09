/**
 * Test fixtures for the temporal view: atoms committed through the real
 * `ChroniclerStore` writer into a sessions tree, beside a transcript that
 * contains every cited source entry. Plus a mock-provider model whose
 * summaries and rankings are computed from the text it is actually sent.
 */
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { type BeatKind, ChroniclerStore } from "../../src/chronicler/store";
import { type ChronicleModelClient, createModelClient } from "../../src/chronicler/temporal/model";
import { terms } from "../../src/chronicler/temporal/rank";

export interface FixtureAtom {
	title: string;
	body: string;
	eventTime: string;
	kind?: BeatKind;
	topics?: string[];
}

export interface FixtureSession {
	cwd: string;
	sessionId: string;
	/** One committed batch per inner array. */
	batches: FixtureAtom[][];
}

export interface WrittenSession {
	chroniclerRoot: string;
	transcriptPath: string;
	/** Atom ids in batch order. */
	atomIds: string[];
	/** Source entry id cited by each atom, in the same order. */
	sourceIds: string[];
}

function escapeCwd(cwd: string): string {
	return cwd.replace(/[/\\:]/g, "-");
}

export async function writeSessionAtoms(sessionsDir: string, session: FixtureSession): Promise<WrittenSession> {
	const stem = `2026-01-01T00-00-00-000Z_${session.sessionId}`;
	const projectDir = path.join(sessionsDir, escapeCwd(session.cwd));
	const transcriptPath = path.join(projectDir, `${stem}.jsonl`);
	const chroniclerRoot = path.join(projectDir, stem, "chronicler");

	const lines: string[] = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: session.sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: session.cwd,
		}),
	];
	const store = new ChroniclerStore(chroniclerRoot, {
		sessionId: session.sessionId,
		project: session.cwd,
		model: "mock/chronicler",
	});
	await store.open();
	const atomIds: string[] = [];
	const sourceIds: string[] = [];
	let parentId: string | null = null;
	let counter = 0;
	for (const batchAtoms of session.batches) {
		const entries = batchAtoms.map(atom => {
			const id = `${session.sessionId.slice(0, 6)}${String(counter++).padStart(4, "0")}`;
			const entry = { id, parentId, timestamp: atom.eventTime };
			lines.push(
				JSON.stringify({
					type: "message",
					id,
					parentId,
					timestamp: atom.eventTime,
					message: { role: "user", content: atom.title, timestamp: Date.parse(atom.eventTime) },
				}),
			);
			parentId = id;
			return entry;
		});
		const batch = store.beginBatch(entries);
		batchAtoms.forEach((atom, index) => {
			const record = store.stageBeat(batch, {
				title: atom.title,
				kind: atom.kind ?? "decision",
				body: atom.body,
				topics: atom.topics ?? [],
				eventTime: atom.eventTime,
				sources: [entries[index]!.id],
				related: [],
			});
			atomIds.push(record.id);
			sourceIds.push(entries[index]!.id);
		});
		batch.finalized = true;
		await store.commitBatch(batch);
	}
	await Bun.write(transcriptPath, `${lines.join("\n")}\n`);
	return { chroniclerRoot, transcriptPath, atomIds, sourceIds };
}

/** Synonym concepts a "semantic" fake model understands; unknown terms stand for themselves. */
const SYNONYMS: Record<string, string[]> = {
	auth: ["login", "signin", "oauth", "credential", "token", "authentication"],
	loop: ["redirect", "loop", "looped", "cycle", "bouncing"],
	fix: ["repair", "repaired", "fix", "fixed", "patch", "patched", "resolved"],
	storage: ["database", "migration", "schema", "postgres"],
};

const CONCEPTS = new Map<string, string>();
for (const [concept, words] of Object.entries(SYNONYMS)) {
	for (const word of words) for (const term of terms(word)) CONCEPTS.set(term, concept);
}

export function concepts(text: string): Set<string> {
	const out = new Set<string>();
	for (const term of terms(text)) out.add(CONCEPTS.get(term) ?? term);
	return out;
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index]!;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}
	return "";
}

/** `### <Child|Candidate> \`key\` — label` sections of a rendered request, with their bodies. */
function sections(input: string, heading: "Child" | "Candidate"): { key: string; text: string }[] {
	const re = new RegExp(`^### ${heading} \`([^\`]+)\` — (.*)$`, "gm");
	const heads = [...input.matchAll(re)];
	return heads.map((match, index) => {
		const start = match.index! + match[0].length;
		const end = index + 1 < heads.length ? heads[index + 1]!.index! : input.length;
		return { key: match[1]!, text: `${match[2]}\n${input.slice(start, end)}` };
	});
}

/** The most frequent content terms of a text: a crude but faithful "summary". */
function topTerms(text: string, count: number): string[] {
	const freq = new Map<string, number>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		const set = terms(raw);
		for (const term of set) {
			if (/^\d+$/.test(term) || term.length < 3) continue;
			freq.set(term, (freq.get(term) ?? 0) + 1);
		}
	}
	return [...freq.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, count)
		.map(([term]) => term);
}

export interface FakeChronicleModel {
	mock: MockModel;
	client: ChronicleModelClient;
	summaryCalls: number;
	rankCalls: number;
}

/**
 * Mock-provider model answering the real summary and rank prompts.
 * Summaries list each child's most frequent terms; ranks score concept
 * overlap between the recollection and each candidate it was sent.
 */
export function createFakeChronicleModel(options: { id?: string; summaryTerms?: number } = {}): FakeChronicleModel {
	registerMockApi();
	const summaryTerms = options.summaryTerms ?? 8;
	const state: FakeChronicleModel = {
		mock: undefined as unknown as MockModel,
		client: undefined as unknown as ChronicleModelClient,
		summaryCalls: 0,
		rankCalls: 0,
	};
	state.mock = createMockModel({
		id: options.id ?? "chronicle-summary-mock",
		provider: "mock",
		handler: context => {
			const input = lastUserText(context);
			if (input.startsWith("Recollection:")) {
				state.rankCalls++;
				const query = input.slice("Recollection:".length).split("\n", 1)[0]!;
				const wanted = concepts(query);
				const scores = sections(input, "Candidate").map(candidate => {
					const have = concepts(candidate.text);
					let hits = 0;
					for (const concept of wanted) if (have.has(concept)) hits++;
					return { key: candidate.key, score: wanted.size === 0 ? 0 : Math.round((10 * hits) / wanted.size) };
				});
				return { content: [JSON.stringify({ scores })], stopReason: "stop" };
			}
			state.summaryCalls++;
			const children = sections(input, "Child").map(child => ({
				key: child.key,
				description: topTerms(child.text, summaryTerms).join(" "),
			}));
			const overview = topTerms(children.map(child => child.description).join(" "), summaryTerms).join(" ");
			return { content: [JSON.stringify({ overview, children })], stopReason: "stop" };
		},
	});
	state.client = createModelClient(state.mock, ThinkingLevel.Off, "test-key", "fixture-session");
	return state;
}
