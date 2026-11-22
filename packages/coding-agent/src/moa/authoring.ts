import type { MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { toError, withFileLock } from "@oh-my-pi/pi-utils";
import { ABSENT, type MixtureSource, readSource, SourceConflictError, writeSource } from "./authoring-files";
import { parseMixturesDoc } from "./config";
import { checkMixture, type MixtureRegistrationContext } from "./registration";
import { serializeMixturesConfig } from "./toml";
import type { MixtureIssue } from "./types";
import { MAX_FILE_BYTES, prepareDocumentPresets } from "./validate";

const SOURCE_LOSS =
	"NeoPi's parser drops or changes fields in this TOML; saving writes the canonical form shown here, not the original source.";

export class MixtureAuthoringError extends Error {
	constructor(
		readonly status: 409 | 422 | 500,
		message: string,
		readonly details: {
			code?: "rewrite-loses-source";
			parseDiagnostics?: string[];
			validation?: MixtureDefinitionReport[];
			blocked?: number[];
			current?: MixtureSourceSnapshot;
			source?: MixtureSourceSnapshot;
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
}

/** Compare parsed TOML structures, not formatting or comments. */
function parseText(text: string, where: string): ParsedDraft {
	let raw: unknown;
	try {
		raw = Bun.TOML.parse(text);
	} catch (error) {
		return { doc: { mixtures: [] }, toml: "", parseDiagnostics: [`Invalid TOML: ${toError(error).message}`] };
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
		throw new MixtureAuthoringError(422, "cannot serialize mixture draft", {
			parseDiagnostics: [toError(error).message],
		});
	}
	const result = parseText(toml, "draft MIXTURES.toml");
	const lossy = structure(withoutWarnings(doc)) !== structure(withoutWarnings(result.doc));
	const parseDiagnostics = result.parseDiagnostics.filter(line => line !== SOURCE_LOSS);
	if (lossy)
		parseDiagnostics.push("Saving would change or omit the fields above; NeoPi cannot store this draft as shown.");
	return { ...result, parseDiagnostics };
}

export interface MixtureDefinitionReport {
	index: number;
	name: string;
	runnable: boolean;
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
	unsupported: MixtureIssue[];
	revision?: string;
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
			return {
				index,
				name,
				runnable,
				errors,
				warnings,
				unsupported: errors.filter(issue => issue.code === "unsupported.feature"),
				...(runnable ? { revision: resolved.revision } : {}),
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
			};
		}
	});
}

interface MixtureDraft extends ParsedDraft {
	validation: MixtureDefinitionReport[];
}

interface MixtureSourceSnapshot extends MixtureDraft {
	id: string;
	kind: MixtureSource["kind"];
	path: string;
	order: number;
	readOnly?: string;
	exists: boolean;
	hash: string;
}

export async function loadMixtureSource(
	source: MixtureSource,
	ctx: MixtureRegistrationContext,
): Promise<MixtureSourceSnapshot> {
	const { id, kind, path, order, readOnly } = source;
	const read = await readSource(path, MAX_FILE_BYTES);
	if (read.state === "refused") {
		return {
			id,
			kind,
			path,
			order,
			readOnly: read.reason,
			exists: true,
			hash: `unreadable:${read.reason}`,
			doc: { mixtures: [] },
			toml: "",
			validation: [],
			parseDiagnostics: [`${path} ${read.reason}; the editor does not read or write it.`],
		};
	}
	const parsed =
		read.state === "file" ? parseText(read.text, path) : { doc: { mixtures: [] }, toml: "", parseDiagnostics: [] };
	return {
		id,
		kind,
		path,
		order,
		readOnly,
		...parsed,
		exists: read.state === "file",
		hash: read.state === "file" ? read.hash : ABSENT,
		validation: validateMixtureDraft(parsed.doc, ctx),
	};
}

export function draftMixtureSource(
	input: { kind: "toml"; text: string } | { kind: "document"; doc: MixturesConfigDoc },
	ctx: MixtureRegistrationContext,
): MixtureDraft {
	const { doc, toml, parseDiagnostics } =
		input.kind === "toml" ? parseText(input.text, "draft MIXTURES.toml") : parseDocument(input.doc);
	// A field the codec would drop (e.g. a route with no instructions) must still be gated.
	const shown = input.kind === "document" ? input.doc : doc;
	return { doc, toml, parseDiagnostics, validation: validateMixtureDraft(shown, ctx) };
}

/** Locked compare-and-save; an unchanged non-runnable definition may be carried over. */
export async function saveMixtureSource(
	source: MixtureSource,
	request: { doc: MixturesConfigDoc; baseHash: string; confirmCanonicalRewrite?: boolean },
	ctx: MixtureRegistrationContext,
): Promise<MixtureSourceSnapshot> {
	if (source.readOnly) throw new MixtureAuthoringError(409, `${source.path} is not editable here: ${source.readOnly}`);
	const draft = parseDocument(request.doc);
	if (draft.parseDiagnostics.length > 0)
		throw new MixtureAuthoringError(422, "NeoPi cannot represent this draft without changing it", {
			parseDiagnostics: draft.parseDiagnostics,
		});
	if (Buffer.byteLength(draft.toml) > MAX_FILE_BYTES)
		throw new MixtureAuthoringError(422, `the saved file would exceed NeoPi's ${MAX_FILE_BYTES}-byte cap`);

	return withFileLock(source.path, async () => {
		const current = await loadMixtureSource(source, ctx);
		if (current.readOnly)
			throw new MixtureAuthoringError(409, `${source.path} is not editable here: ${current.readOnly}`);
		if (current.hash !== request.baseHash)
			throw new MixtureAuthoringError(409, `${source.path} changed since it was loaded; reload before saving`, {
				current,
			});
		if (current.parseDiagnostics.length > 0 && request.confirmCanonicalRewrite !== true)
			throw new MixtureAuthoringError(
				409,
				`${source.path} has content NeoPi's parser does not keep; saving would drop it`,
				{
					code: "rewrite-loses-source",
					parseDiagnostics: current.parseDiagnostics,
				},
			);

		const validation = validateMixtureDraft(draft.doc, ctx);
		const onDisk = new Map(current.doc.mixtures.map(mixture => [mixture.name, structure(mixture)] as const));
		const blocked = validation.filter(
			report => !report.runnable && onDisk.get(report.name) !== structure(draft.doc.mixtures[report.index]),
		);
		if (blocked.length > 0)
			throw new MixtureAuthoringError(
				422,
				`NeoPi refuses to save definitions with validation errors: ${blocked.map(report => report.name || "(unnamed)").join(", ")}`,
				{
					validation,
					blocked: blocked.map(report => report.index),
				},
			);

		try {
			await writeSource(source, draft.toml || null, current.hash, MAX_FILE_BYTES);
		} catch (error) {
			if (error instanceof SourceConflictError) throw new MixtureAuthoringError(409, error.message);
			throw error;
		}
		const saved = await loadMixtureSource(source, ctx);
		if (structure(withoutWarnings(saved.doc)) !== structure(withoutWarnings(draft.doc)))
			throw new MixtureAuthoringError(500, `${source.path} does not read back as the saved document`, {
				source: saved,
			});
		return saved;
	});
}
