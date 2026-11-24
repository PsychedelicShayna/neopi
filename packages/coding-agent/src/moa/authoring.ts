import type { MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { acquireFileLock, type FileLockHandle, toError } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../config/model-resolver";
import {
	ABSENT,
	digest,
	type MixtureSource,
	readHash,
	readSource,
	SourceConflictError,
	type SourceRead,
	writeSource,
} from "./authoring-files";
import { parseMixturesDoc } from "./config";
import { checkMixture, type MixtureRegistrationContext } from "./registration";
import { serializeMixturesConfig } from "./toml";
import type { MixtureIssue } from "./types";
import { MAX_FILE_BYTES, prepareDocumentPresets } from "./validate";

const SOURCE_LOSS =
	"NeoPi's parser drops or changes fields in this TOML; saving writes the canonical form shown here, not the original source.";

/** What one file of a failed batch holds on disk now. */
export interface MixtureFileOutcome {
	sourceId: string;
	path: string;
	/** `original`: as loaded; `saved`: the new content; `staged`: the new content plus definitions it is losing
	 * (a crash between the two phases of a move); `unknown`: none of these (another writer, or unreadable). */
	state: "original" | "saved" | "staged" | "unknown";
	/** Current content hash, `absent`, or null when unreadable. */
	hash: string | null;
}

/** Per-file reasons a batch was refused before anything was written. */
export interface MixtureFileRefusal {
	sourceId: string;
	validation?: MixtureDefinitionReport[];
	blocked?: number[];
	parseDiagnostics?: string[];
}

export class MixtureAuthoringError extends Error {
	constructor(
		readonly status: 400 | 409 | 422 | 500,
		message: string,
		readonly details: {
			code?: "rewrite-loses-source" | "broken-source" | "read-only";
			/** Stale files, each with what is on disk now; nothing was written. */
			conflicts?: { sourceId: string; current: MixtureSourceSnapshot }[];
			/** Refusals by file (validation, unrepresentable drafts, lossy rewrites). */
			files?: MixtureFileRefusal[];
			/** Some file may not hold what it held before the save; `outcomes` names each file's state. */
			partial?: boolean;
			outcomes?: MixtureFileOutcome[];
		} = {},
	) {
		super(message);
	}
}

/** Key-order-independent structure; `undefined` members are absent. */
function structure(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(structure).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${structure(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

function withoutWarnings(doc: MixturesConfigDoc): MixturesConfigDoc {
	const { warnings: _warnings, ...rest } = doc;
	return rest;
}

interface ParsedDraft {
	doc: MixturesConfigDoc;
	toml: string;
	parseDiagnostics: string[];
	/** Set when the text is not TOML at all. */
	invalid?: string;
}

/** Compare parsed TOML structures, not formatting or comments. */
function parseText(text: string, where: string): ParsedDraft {
	let raw: unknown;
	try {
		raw = Bun.TOML.parse(text);
	} catch (error) {
		const invalid = `Invalid TOML: ${toError(error).message}`;
		return { doc: { mixtures: [] }, toml: "", parseDiagnostics: [invalid], invalid };
	}
	const doc = parseMixturesDoc(raw, where);
	const parseDiagnostics = [...(doc.warnings ?? [])];
	let toml = "";
	try {
		toml = serializeMixturesConfig(doc);
		if (structure(raw) !== structure(Bun.TOML.parse(toml))) parseDiagnostics.push(SOURCE_LOSS);
	} catch (error) {
		parseDiagnostics.push(`Cannot serialize draft: ${toError(error).message}`);
	}
	return { doc, toml, parseDiagnostics };
}

/** A structured draft must round-trip: confirmation only permits losing source fields, not draft edits. */
function parseDocument(doc: MixturesConfigDoc): ParsedDraft {
	let toml: string;
	try {
		toml = serializeMixturesConfig(doc);
	} catch (error) {
		return { doc, toml: "", parseDiagnostics: [`cannot serialize mixture draft: ${toError(error).message}`] };
	}
	const result = parseText(toml, "draft MIXTURES.toml");
	const lossy = structure(withoutWarnings(doc)) !== structure(withoutWarnings(result.doc));
	const parseDiagnostics = result.parseDiagnostics.filter(line => line !== SOURCE_LOSS);
	if (lossy)
		parseDiagnostics.push("Saving would change or omit the fields above; NeoPi cannot store this draft as shown.");
	return { ...result, parseDiagnostics };
}

/** What a model member's selector resolved to: `provider/id`, plus the pinned effort when it has one. */
export interface MixtureMemberResolution {
	model: string;
	effort?: string;
}

export interface MixtureDefinitionReport {
	index: number;
	name: string;
	runnable: boolean;
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
	unsupported: MixtureIssue[];
	revision?: string;
	/** Model members that resolved, by member id. */
	members: Record<string, MixtureMemberResolution>;
}

/** Report each definition using the same resolution and validation as registration. */
export function validateMixtureDraft(
	doc: MixturesConfigDoc,
	ctx: MixtureRegistrationContext,
): MixtureDefinitionReport[] {
	const names = doc.mixtures.map(mixture => (typeof mixture?.name === "string" ? mixture.name : ""));
	const presets = prepareDocumentPresets(doc.envelopes, doc.roles);
	return doc.mixtures.map((definition, index) => {
		const name = names[index]!;
		try {
			const { resolved, errors, warnings } = checkMixture(definition, ctx, presets, names);
			const runnable = errors.length === 0;
			const members: Record<string, MixtureMemberResolution> = {};
			for (const member of Object.values(resolved.members)) {
				if (member.kind !== "model") continue;
				const effort = member.reasoningOff ? "off" : member.effort;
				members[member.id] = { model: formatModelString(member.model), ...(effort ? { effort } : {}) };
			}
			return {
				index,
				name,
				runnable,
				errors,
				warnings,
				unsupported: errors.filter(issue => issue.code === "unsupported.feature"),
				...(runnable ? { revision: resolved.revision } : {}),
				members,
			};
		} catch (error) {
			return {
				index,
				name,
				runnable: false,
				errors: [
					{
						code: "validation.failed",
						path: "",
						message: `NeoPi could not validate this definition: ${toError(error).message}`,
					},
				],
				warnings: [],
				unsupported: [],
				members: {},
			};
		}
	});
}

interface MixtureDraft extends ParsedDraft {
	validation: MixtureDefinitionReport[];
}

export interface MixtureSourceSnapshot extends MixtureDraft {
	id: string;
	kind: MixtureSource["kind"];
	path: string;
	order: number;
	readOnly?: string;
	exists: boolean;
	hash: string;
	/** The file exactly as read from disk; null when absent or unreadable. */
	text: string | null;
	/** Why the file cannot be edited as a document (invalid TOML, a link, a special file). */
	broken?: string;
}

function snapshotOf(source: MixtureSource, read: SourceRead, ctx: MixtureRegistrationContext): MixtureSourceSnapshot {
	const { id, kind, path, order, readOnly } = source;
	if (read.state === "refused") {
		return {
			id,
			kind,
			path,
			order,
			readOnly: read.reason,
			exists: true,
			hash: `unreadable:${read.reason}`,
			text: null,
			broken: `${path} ${read.reason}`,
			doc: { mixtures: [] },
			toml: "",
			validation: [],
			parseDiagnostics: [`${path} ${read.reason}; the editor does not read or write it.`],
		};
	}
	const parsed =
		read.state === "file"
			? parseText(read.text, path)
			: { doc: { mixtures: [] }, toml: "", parseDiagnostics: [], invalid: undefined };
	const { invalid, ...draft } = parsed;
	return {
		id,
		kind,
		path,
		order,
		readOnly,
		...draft,
		exists: read.state === "file",
		hash: read.state === "file" ? read.hash : ABSENT,
		text: read.state === "file" ? read.text : null,
		...(invalid ? { broken: invalid } : {}),
		validation: validateMixtureDraft(parsed.doc, ctx),
	};
}

export async function loadMixtureSource(
	source: MixtureSource,
	ctx: MixtureRegistrationContext,
): Promise<MixtureSourceSnapshot> {
	return snapshotOf(source, await readSource(source.path, MAX_FILE_BYTES), ctx);
}

export function draftMixtureSource(doc: MixturesConfigDoc, ctx: MixtureRegistrationContext): MixtureDraft {
	const parsed = parseDocument(doc);
	// A field the codec would drop (e.g. a route with no instructions) must still be gated.
	return {
		doc: parsed.doc,
		toml: parsed.toml,
		parseDiagnostics: parsed.parseDiagnostics,
		validation: validateMixtureDraft(doc, ctx),
	};
}

/** One file of a batch save. `baseHash` is the hash from the last load, `absent` for a file that did not exist. */
export interface MixtureFileWrite {
	source: MixtureSource;
	baseHash: string;
	doc: MixturesConfigDoc;
	confirmCanonicalRewrite?: boolean;
}

interface PlannedWrite extends MixtureFileWrite {
	draft: ParsedDraft;
	/** null removes the file (an empty document). */
	content: string | null;
	/** The hash the file has once this write took effect. */
	writtenHash: string;
	/** Every hash this batch wrote, or attempted to write, to this file. */
	wrote: string[];
	before?: SourceRead;
	current?: MixtureSourceSnapshot;
}

/** One replacement of one file; a file can take two (staged, then final). */
interface WriteStep {
	plan: PlannedWrite;
	content: string | null;
	hash: string;
}

/**
 * The file's final document plus every definition (and preset) on disk that the final document drops.
 * Writing every file's staged form before any final form means each definition is on disk somewhere
 * after every single write, so a crash mid-batch can duplicate a mixture but never lose one.
 */
function stagedContent(plan: PlannedWrite): string | null {
	const disk = plan.current!.doc;
	const final = plan.draft.doc;
	const kept = new Set(final.mixtures.map(mixture => mixture.name));
	const envelopes = { ...disk.envelopes, ...final.envelopes };
	const roles = { ...disk.roles, ...final.roles };
	const staged: MixturesConfigDoc = {
		...(Object.keys(envelopes).length ? { envelopes } : {}),
		...(Object.keys(roles).length ? { roles } : {}),
		mixtures: [...final.mixtures, ...disk.mixtures.filter(mixture => !kept.has(mixture.name))],
	};
	let toml: string;
	try {
		toml = serializeMixturesConfig(staged);
	} catch (error) {
		throw new MixtureAuthoringError(422, `${plan.source.path}: cannot stage this save (${toError(error).message})`);
	}
	if (Buffer.byteLength(toml) > MAX_FILE_BYTES)
		throw new MixtureAuthoringError(
			422,
			`${plan.source.path} would briefly exceed NeoPi's ${MAX_FILE_BYTES}-byte cap while this save moves mixtures; save these moves one at a time`,
		);
	return toml || null;
}

function names(list: readonly { source: MixtureSource }[]): string {
	return list.map(({ source }) => source.path).join(", ");
}

async function lockAll(paths: readonly string[]): Promise<FileLockHandle[]> {
	const held: FileLockHandle[] = [];
	try {
		// One global order, so two batches over the same files cannot deadlock.
		for (const file of [...paths].sort()) held.push(await acquireFileLock(file));
		return held;
	} catch (error) {
		for (const lock of held.reverse()) lock.release();
		throw error;
	}
}

/** What a file holds now, without changing it. */
async function observe(plan: PlannedWrite): Promise<MixtureFileOutcome> {
	const hash = readHash(await readSource(plan.source.path, MAX_FILE_BYTES));
	const original = readHash(plan.before!);
	return {
		sourceId: plan.source.id,
		path: plan.source.path,
		state:
			hash === null
				? "unknown"
				: hash === original
					? "original"
					: hash === plan.writtenHash
						? "saved"
						: plan.wrote.includes(hash)
							? "staged"
							: "unknown",
		hash,
	};
}

/** What a written (or attempted) file holds now, restoring its original only when the file still holds exactly something this batch wrote. */
async function rollBack(plan: PlannedWrite): Promise<MixtureFileOutcome> {
	const seen = await observe(plan);
	const { source, before } = plan;
	if ((seen.state !== "saved" && seen.state !== "staged") || readHash(before!) === null) return seen;
	try {
		const restore = before!.state === "file" ? before!.bytes : null;
		await writeSource(
			source,
			restore,
			seen.hash!,
			MAX_FILE_BYTES,
			before!.state === "file" ? before!.mode : undefined,
		);
	} catch {
		// The re-read below reports whatever the failed restore left behind.
	}
	return observe(plan);
}

/**
 * All-or-nothing save of one or more sources. A multi-file save writes in two phases: every file first
 * gains its new and edited definitions while keeping the ones it loses, then the losses are written, so
 * killing the process between any two writes duplicates a moved mixture at worst and never loses one
 * (swaps included).
 * Every file is locked, hash-checked and validated before anything is written. If a write fails, each
 * file this batch touched is re-read under the lock and restored only when it still holds exactly what
 * the batch wrote; anything else is left as it is and reported per file (`partial`).
 *
 * An invalid definition may be written only when an identical definition was already on disk, and
 * already invalid, in some file of the batch: imports NeoPi cannot run yet can be carried and moved,
 * but nothing becomes invalid by being saved.
 */
export async function saveMixtureSources(
	writes: readonly MixtureFileWrite[],
	ctx: MixtureRegistrationContext,
): Promise<MixtureSourceSnapshot[]> {
	if (writes.length === 0) throw new MixtureAuthoringError(400, "nothing to save");
	if (new Set(writes.map(write => write.source.id)).size !== writes.length)
		throw new MixtureAuthoringError(400, "a save names the same file twice");
	const readOnly = writes.filter(write => write.source.readOnly);
	if (readOnly.length > 0)
		throw new MixtureAuthoringError(
			409,
			readOnly.map(({ source }) => `${source.path} is not editable here: ${source.readOnly}`).join("; "),
			{ code: "read-only" },
		);

	const plans: PlannedWrite[] = [];
	const unrepresentable: MixtureFileRefusal[] = [];
	for (const write of writes) {
		const draft = parseDocument(write.doc);
		if (draft.parseDiagnostics.length > 0) {
			unrepresentable.push({ sourceId: write.source.id, parseDiagnostics: draft.parseDiagnostics });
			continue;
		}
		if (Buffer.byteLength(draft.toml) > MAX_FILE_BYTES) {
			unrepresentable.push({
				sourceId: write.source.id,
				parseDiagnostics: [`the saved file would exceed NeoPi's ${MAX_FILE_BYTES}-byte cap`],
			});
			continue;
		}
		const content = draft.toml || null;
		plans.push({ ...write, draft, content, writtenHash: content === null ? ABSENT : digest(content), wrote: [] });
	}
	if (unrepresentable.length > 0)
		throw new MixtureAuthoringError(422, "NeoPi cannot represent this draft without changing it", {
			files: unrepresentable,
		});

	const locks = await lockAll(plans.map(plan => plan.source.path));
	try {
		for (const plan of plans) {
			plan.before = await readSource(plan.source.path, MAX_FILE_BYTES);
			plan.current = snapshotOf(plan.source, plan.before, ctx);
		}
		const broken = plans.filter(plan => plan.current!.broken);
		if (broken.length > 0)
			throw new MixtureAuthoringError(
				409,
				`${broken.map(plan => plan.current!.broken).join("; ")}; fix ${broken.length > 1 ? "these files" : "this file"} outside the editor first`,
				{ code: "broken-source" },
			);
		const stale = plans.filter(plan => plan.current!.hash !== plan.baseHash);
		if (stale.length > 0)
			throw new MixtureAuthoringError(409, `${names(stale)} changed since loaded; reload before saving`, {
				conflicts: stale.map(plan => ({ sourceId: plan.source.id, current: plan.current! })),
			});
		const lossy = plans.filter(
			plan => plan.current!.parseDiagnostics.length > 0 && plan.confirmCanonicalRewrite !== true,
		);
		if (lossy.length > 0)
			throw new MixtureAuthoringError(
				409,
				`${names(lossy)} has content NeoPi's parser does not keep; saving would drop it`,
				{
					code: "rewrite-loses-source",
					files: lossy.map(plan => ({
						sourceId: plan.source.id,
						parseDiagnostics: plan.current!.parseDiagnostics,
					})),
				},
			);

		// Definitions already on disk in this batch's files, and whether NeoPi could run each where it was.
		const carried = new Map<string, boolean>();
		for (const plan of plans) {
			const { doc, validation } = plan.current!;
			for (const report of validation) {
				const key = structure(doc.mixtures[report.index]);
				carried.set(key, (carried.get(key) ?? false) || !report.runnable);
			}
		}
		const refused: MixtureFileRefusal[] = [];
		for (const plan of plans) {
			const validation = validateMixtureDraft(plan.draft.doc, ctx);
			const blocked = validation.filter(
				report => !report.runnable && carried.get(structure(plan.draft.doc.mixtures[report.index])) !== true,
			);
			if (blocked.length > 0)
				refused.push({ sourceId: plan.source.id, validation, blocked: blocked.map(report => report.index) });
		}
		if (refused.length > 0) {
			const blockedNames = refused.flatMap(refusal =>
				refusal.blocked!.map(index => refusal.validation![index]!.name || "(unnamed)"),
			);
			throw new MixtureAuthoringError(
				422,
				`NeoPi refuses to save definitions with validation errors: ${blockedNames.join(", ")}`,
				{ files: refused },
			);
		}

		const steps: WriteStep[] = [];
		for (const plan of plans) {
			const content = plans.length > 1 ? stagedContent(plan) : plan.content;
			const hash = content === null ? ABSENT : digest(content);
			if (hash !== plan.current!.hash) steps.push({ plan, content, hash });
		}
		for (const plan of plans) {
			const last = steps.findLast(step => step.plan === plan)?.hash ?? plan.current!.hash;
			if (last !== plan.writtenHash) steps.push({ plan, content: plan.content, hash: plan.writtenHash });
		}

		const expected = new Map(plans.map(plan => [plan, plan.current!.hash] as const));
		for (const [index, step] of steps.entries()) {
			const { plan } = step;
			plan.wrote.push(step.hash);
			try {
				await writeSource(plan.source, step.content, expected.get(plan)!, MAX_FILE_BYTES);
				expected.set(plan, step.hash);
			} catch (error) {
				// The failed write may have landed too: a rename can take effect before its directory fsync throws.
				// Undo files from the most recently touched back. Once any file cannot be confirmed back to its
				// original, the rest keep what this batch wrote: they may hold the only copy of a moved mixture.
				const touched: PlannedWrite[] = [];
				for (const done of steps.slice(0, index + 1).reverse())
					if (!touched.includes(done.plan)) touched.push(done.plan);
				const byFile = new Map<PlannedWrite, MixtureFileOutcome>();
				let restoring = true;
				for (const file of touched) {
					const outcome = restoring ? await rollBack(file) : await observe(file);
					if (outcome.state !== "original") restoring = false;
					byFile.set(file, outcome);
				}
				const outcomes: MixtureFileOutcome[] = [];
				for (const file of plans) outcomes.push(byFile.get(file) ?? (await observe(file)));
				const partial = outcomes.some(outcome => outcome.state !== "original");
				const reason = toError(error).message;
				throw new MixtureAuthoringError(
					partial ? 500 : error instanceof SourceConflictError ? 409 : 500,
					partial
						? `Saving ${plan.source.path} failed (${reason}); some files could not be confirmed as unchanged`
						: `Saving ${plan.source.path} failed (${reason}); nothing was changed`,
					{ partial, outcomes },
				);
			}
		}

		const saved: MixtureSourceSnapshot[] = [];
		const outcomes: MixtureFileOutcome[] = [];
		for (const plan of plans) {
			const snapshot = await loadMixtureSource(plan.source, ctx);
			saved.push(snapshot);
			const exact =
				snapshot.hash === plan.writtenHash &&
				structure(withoutWarnings(snapshot.doc)) === structure(withoutWarnings(plan.draft.doc));
			outcomes.push({
				sourceId: plan.source.id,
				path: plan.source.path,
				state: exact ? "saved" : snapshot.hash === plan.current!.hash ? "original" : "unknown",
				hash: snapshot.hash.startsWith("unreadable:") ? null : snapshot.hash,
			});
		}
		if (outcomes.some(outcome => outcome.state !== "saved"))
			throw new MixtureAuthoringError(500, `${names(plans)} did not read back as the saved documents`, {
				partial: true,
				outcomes,
			});
		return saved;
	} finally {
		for (const lock of locks.reverse()) lock.release();
	}
}
