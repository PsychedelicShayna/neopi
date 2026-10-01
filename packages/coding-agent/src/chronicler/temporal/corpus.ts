/**
 * Canonical atom corpus for the derived temporal view.
 *
 * Atoms are the committed Chronicler beats of every session store beneath the
 * sessions directory. They are read through the store's own read-only batch
 * parser, one batch at a time, so a malformed batch is reported without hiding
 * the rest of its session. Nothing here writes to a session store.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { parseSessionContent } from "../../session/session-loader";
import { type BeatKind, type BeatRecord, ChroniclerStore, type CommittedChroniclerBatch } from "../store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The session header is the first record after the title slot; this prefix always contains it. */
const HEADER_PREFIX_BYTES = 64 * 1024;

/** One committed beat plus the provenance the temporal view needs. */
export interface ChronicleAtom {
	id: string;
	title: string;
	kind: BeatKind;
	topics: readonly string[];
	/** Event time (bucketing authority). */
	eventTime: string;
	capturedAt: string;
	sessionId: string;
	/** Session working directory from the transcript header (beat frontmatter as fallback). */
	project: string;
	model: string;
	body: string;
	sources: readonly string[];
	related: readonly string[];
	supersedes?: string;
	uncertainty?: string;
	batchId: string;
	/** Absolute path of the canonical beat markdown file. */
	beatFile: string;
	/** Absolute `<session artifacts>/chronicler` root holding the batch. */
	chroniclerRoot: string;
	/** Absolute path of the session transcript the sources cite. */
	transcriptPath: string;
	fingerprint: string;
}

export type CorpusDiagnosticKind =
	| "malformed"
	| "duplicate"
	| "shared-entry"
	| "uncommitted-source"
	| "dangling-transcript"
	| "dangling-entry"
	| "dangling-related";

export interface CorpusDiagnostic {
	kind: CorpusDiagnosticKind;
	path: string;
	atomId?: string;
	detail: string;
}

export interface ChronicleCorpus {
	atoms: ChronicleAtom[];
	diagnostics: CorpusDiagnostic[];
	/** Session chronicler roots that were scanned. */
	stores: number;
}

export interface LoadCorpusOptions {
	/** Parse each transcript and report source entries it does not contain (index/repair only). */
	checkTranscripts?: boolean;
}

/** Stable identity of an atom's canonical content; any edit to the beat changes it. */
export function atomFingerprint(record: BeatRecord, project: string, batchId: string): string {
	return hashText(
		JSON.stringify([
			record.id,
			batchId,
			record.title,
			record.kind,
			record.eventTime,
			record.capturedAt,
			record.sessionId,
			project,
			record.model,
			record.topics,
			record.sources,
			record.related,
			record.supersedes ?? null,
			record.uncertainty ?? null,
			record.body,
		]),
	);
}

export function hashText(text: string): string {
	return Bun.hash(text).toString(36);
}

/** Session header fields the view needs, or null when the transcript is missing/unreadable. */
export async function readSessionHeader(transcriptPath: string): Promise<{ id: string; cwd: string } | null> {
	let prefix: string;
	try {
		prefix = await Bun.file(transcriptPath).slice(0, HEADER_PREFIX_BYTES).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	if (prefix.length === 0) return null;
	for (const entry of parseSessionContent(prefix).entries) {
		if (entry.type === "session") return { id: entry.id, cwd: entry.cwd };
	}
	return null;
}

function toAtom(
	record: BeatRecord,
	batchId: string,
	chroniclerRoot: string,
	transcriptPath: string,
	project: string,
): ChronicleAtom {
	return {
		id: record.id,
		title: record.title,
		kind: record.kind,
		topics: record.topics,
		eventTime: record.eventTime,
		capturedAt: record.capturedAt,
		sessionId: record.sessionId,
		project,
		model: record.model,
		body: record.body,
		sources: record.sources,
		related: record.related,
		...(record.supersedes ? { supersedes: record.supersedes } : {}),
		...(record.uncertainty ? { uncertainty: record.uncertainty } : {}),
		batchId,
		beatFile: path.join(chroniclerRoot, record.path),
		chroniclerRoot,
		transcriptPath,
		fingerprint: atomFingerprint(record, project, batchId),
	};
}

async function frontmatterProject(beatFile: string): Promise<string | undefined> {
	try {
		const { frontmatter } = parseFrontmatter(await Bun.file(beatFile).text(), {
			rawKeys: true,
			repair: false,
			level: "off",
		});
		return typeof frontmatter.project === "string" ? frontmatter.project.trim() : undefined;
	} catch {
		return undefined;
	}
}

function readerFor(chroniclerRoot: string): ChroniclerStore {
	return new ChroniclerStore(chroniclerRoot, { sessionId: "", project: "", model: "" }, {}, true);
}

async function listBatchIds(chroniclerRoot: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(path.join(chroniclerRoot, "beats"), { withFileTypes: true });
		return entries
			.filter(entry => entry.isDirectory() && UUID_RE.test(entry.name))
			.map(entry => entry.name)
			.sort();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/** Every session chronicler root beneath the sessions directory. */
export async function discoverChroniclerRoots(sessionsDir: string): Promise<string[]> {
	const roots: string[] = [];
	try {
		for await (const match of new Bun.Glob("*/*/chronicler/beats").scan({
			cwd: sessionsDir,
			onlyFiles: false,
			dot: true,
		})) {
			roots.push(path.dirname(path.join(sessionsDir, match)));
		}
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return roots.sort();
}

function transcriptPathFor(chroniclerRoot: string): string {
	return `${path.dirname(chroniclerRoot)}.jsonl`;
}

async function loadStore(
	chroniclerRoot: string,
	options: LoadCorpusOptions,
	diagnostics: CorpusDiagnostic[],
): Promise<ChronicleAtom[]> {
	const transcriptPath = transcriptPathFor(chroniclerRoot);
	const header = await readSessionHeader(transcriptPath);
	if (!header) {
		diagnostics.push({
			kind: "dangling-transcript",
			path: transcriptPath,
			detail: "session transcript is missing or has no session header",
		});
	}
	const reader = readerFor(chroniclerRoot);
	const batches: CommittedChroniclerBatch[] = [];
	for (const batchId of await listBatchIds(chroniclerRoot)) {
		try {
			const loaded = await reader.readCommittedBatch(batchId);
			batches.push({ checkpoint: loaded.checkpoint, beats: loaded.records });
		} catch (error) {
			diagnostics.push({
				kind: "malformed",
				path: path.join(chroniclerRoot, "beats", batchId),
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// The whole-session reader's cross-batch invariants, reapplied per store so
	// one violation is reported instead of hiding every sibling batch.
	const owner = new Map<string, string>();
	for (const { checkpoint } of batches) {
		for (const entry of checkpoint.entries) {
			const previous = owner.get(entry.id);
			if (previous) {
				diagnostics.push({
					kind: "shared-entry",
					path: path.join(chroniclerRoot, "beats", checkpoint.batchId),
					detail: `entry ${entry.id} is also committed by batch ${previous}`,
				});
				continue;
			}
			owner.set(entry.id, checkpoint.batchId);
		}
	}

	let transcriptIds: Set<string> | null = null;
	if (options.checkTranscripts && header) {
		try {
			const content = await Bun.file(transcriptPath).text();
			transcriptIds = new Set();
			for (const entry of parseSessionContent(content).entries) {
				if ("id" in entry && typeof entry.id === "string") transcriptIds.add(entry.id);
			}
		} catch (error) {
			logger.warn("Chronicle index could not parse transcript", { transcriptPath, error: String(error) });
		}
	}

	const atoms: ChronicleAtom[] = [];
	for (const { checkpoint, beats } of batches) {
		for (const record of beats) {
			const beatFile = path.join(chroniclerRoot, record.path);
			const uncommitted = record.sources.filter(source => !owner.has(source));
			if (uncommitted.length > 0) {
				diagnostics.push({
					kind: "uncommitted-source",
					path: beatFile,
					atomId: record.id,
					detail: `cites source entries no committed batch covers: ${uncommitted.join(", ")}`,
				});
				continue;
			}
			if (transcriptIds) {
				const missing = record.sources.filter(source => !transcriptIds.has(source));
				if (missing.length > 0) {
					diagnostics.push({
						kind: "dangling-entry",
						path: transcriptPath,
						atomId: record.id,
						detail: `transcript lacks cited entries: ${missing.join(", ")}`,
					});
				}
			}
			const project = header?.cwd || (await frontmatterProject(beatFile)) || "";
			atoms.push(toAtom(record, checkpoint.batchId, chroniclerRoot, transcriptPath, project));
		}
	}
	return atoms;
}

/**
 * Load every committed atom beneath `sessionsDir` with canonical diagnostics.
 * Duplicated atom ids keep the earliest capture and report the rest.
 */
export async function loadChronicleCorpus(
	sessionsDir: string,
	options: LoadCorpusOptions = {},
): Promise<ChronicleCorpus> {
	const diagnostics: CorpusDiagnostic[] = [];
	const roots = await discoverChroniclerRoots(sessionsDir);
	const loaded: ChronicleAtom[] = [];
	for (const root of roots) loaded.push(...(await loadStore(root, options, diagnostics)));

	loaded.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.beatFile.localeCompare(b.beatFile));
	const byId = new Map<string, ChronicleAtom>();
	for (const atom of loaded) {
		const first = byId.get(atom.id);
		if (first) {
			diagnostics.push({
				kind: "duplicate",
				path: atom.beatFile,
				atomId: atom.id,
				detail: `atom id already captured at ${first.beatFile}`,
			});
			continue;
		}
		byId.set(atom.id, atom);
	}
	for (const atom of byId.values()) {
		const refs = [...atom.related, ...(atom.supersedes ? [atom.supersedes] : [])];
		const dangling = refs.filter(ref => !byId.has(ref));
		if (dangling.length > 0) {
			diagnostics.push({
				kind: "dangling-related",
				path: atom.beatFile,
				atomId: atom.id,
				detail: `references unknown atoms: ${dangling.join(", ")}`,
			});
		}
	}
	const atoms = [...byId.values()].sort((a, b) => a.eventTime.localeCompare(b.eventTime) || a.id.localeCompare(b.id));
	return { atoms, diagnostics, stores: roots.length };
}

/** Canonical re-read of one atom: current record or a reason it cannot be resolved. */
export type CanonicalAtomResult = { ok: true; atom: ChronicleAtom } | { ok: false; reason: string };

export async function readCanonicalAtom(ref: {
	id: string;
	batchId: string;
	chroniclerRoot: string;
}): Promise<CanonicalAtomResult> {
	let records: readonly BeatRecord[];
	try {
		records = (await readerFor(ref.chroniclerRoot).readCommittedBatch(ref.batchId)).records;
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	const record = records.find(candidate => candidate.id === ref.id);
	if (!record) return { ok: false, reason: `batch ${ref.batchId} no longer lists atom ${ref.id}` };
	const transcriptPath = transcriptPathFor(ref.chroniclerRoot);
	const header = await readSessionHeader(transcriptPath);
	const project = header?.cwd || (await frontmatterProject(path.join(ref.chroniclerRoot, record.path))) || "";
	return { ok: true, atom: toAtom(record, ref.batchId, ref.chroniclerRoot, transcriptPath, project) };
}
