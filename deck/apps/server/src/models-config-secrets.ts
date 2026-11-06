/**
 * Credential masking for models.toml as the Settings editor shows it. Fails
 * closed: when a credential cannot be removed from the text unambiguously, the
 * text is withheld rather than partially masked.
 *
 * Masked (replaced by a placeholder `<npi-deck-masked:ID>`):
 * - every value in a credential position of NeoPi's schema: a provider's
 *   `apiKey`, every header value under any name (provider, model and model
 *   override headers) and every `requestMetadata` value;
 * - every `baseUrl` (provider, model, model override), whole, whatever its
 *   shape: a host, path, userinfo, query or fragment can each carry one. Its
 *   components also join the survival checks below (see urlParts), but are
 *   not substituted elsewhere;
 * - every value under a credential-like key anywhere else (`token`, `secret`,
 *   `password`, `*key`, …);
 * - every other occurrence of such a value at least MIN_REPLACE long, in any
 *   scalar or key.
 * A known credential still present anywhere (a short one, one hidden by an
 * escape) withholds the whole text.
 *
 * No comment text is ever shown: every comment becomes `# <npi-deck-comment:ID>`,
 * restored verbatim on save only when it stands unchanged as a whole comment.
 * A comment the user writes or edits is saved as typed.
 *
 * IDs are HMACs under a per-process key, as is the file revision, so neither
 * can be checked against a guessed credential offline. Saving restores a
 * credential placeholder only where it is the whole value of a credential
 * position; a placeholder anywhere else is refused, so a credential can never
 * be moved into a field the deck shows.
 */
import { createHmac, randomBytes } from "node:crypto";
import { parseSettingsToml, stringifyTomlValue as scalarSource } from "@oh-my-pi/pi-utils/settings-toml";

export const MASK_MARK = "npi-deck-masked";
export const COMMENT_MARK = "npi-deck-comment";
const PLACEHOLDER_EXACT = /^<npi-deck-masked:[0-9a-f]{16}>$/;
const COMMENT_EXACT = /^# <npi-deck-comment:[0-9a-f]{16}>$/;
const SECRET_KEY_SUFFIXES = [
	"key",
	"authorization",
	"token",
	"secret",
	"password",
	"cookie",
	"credential",
	"credentials",
];
/** Shorter credentials are not substituted inside other text (the match would be ambiguous); their presence withholds the text. */
const MIN_REPLACE = 8;
/** Path segments and host labels are registered for the survival checks only when token-like: this long and holding a digit; see urlParts. */
const MIN_URL_SEGMENT = 8;
/** Bound nested collections and source tokens before traversing untrusted input. */
const MAX_VISITS = 100_000;
const ABSENT = "absent";

const hmacKey = randomBytes(32);

function keyed(domain: string, text: string): string {
	return createHmac("sha256", hmacKey).update(domain).update("\0").update(text).digest("hex");
}

/** Opaque revision of a file's exact text, keyed per process: it identifies the text without allowing an offline guess at its credentials. */
export function revisionOf(text: string | null): string {
	return text === null ? ABSENT : keyed("revision", text);
}

export function isSecretKey(key: unknown): boolean {
	if (typeof key !== "string") return false;
	const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
	return SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

type PathKey = string | number | undefined;

/**
 * Credential positions in NeoPi's models.toml schema: `providers.P.apiKey`,
 * `providers.P.headers.H`, `providers.P.requestMetadata.K`,
 * `providers.P.models[i].headers.H` and `providers.P.modelOverrides.M.headers.H`.
 */
export function isCredentialPath(path: readonly PathKey[]): boolean {
	if (path[0] !== "providers" || path.length < 3) return false;
	const rest = path.slice(2);
	if (rest.length === 1) return rest[0] === "apiKey";
	if (rest.length === 2) return rest[0] === "headers" || rest[0] === "requestMetadata";
	if (rest.length === 4) {
		return (
			rest[2] === "headers" &&
			((rest[0] === "models" && typeof rest[1] === "number") || rest[0] === "modelOverrides")
		);
	}
	return false;
}

/** `baseUrl` of a provider, a model or a model override. */
export function isUrlPath(path: readonly PathKey[]): boolean {
	if (path[0] !== "providers" || path.length < 3) return false;
	const rest = path.slice(2);
	if (rest.length === 1) return rest[0] === "baseUrl";
	if (rest.length === 3)
		return (
			rest[2] === "baseUrl" &&
			((rest[0] === "models" && typeof rest[1] === "number") || rest[0] === "modelOverrides")
		);
	return false;
}

const HIDDEN = "••••••";

/**
 * A baseUrl as a summary may show it: at most its `http://` or `https://`
 * scheme and a constant, never a host or path.
 */
export function displayUrl(value: string | undefined, secrets: Map<string, Secret>): string | undefined {
	if (value === undefined) return undefined;
	const url = PLACEHOLDER_EXACT.test(value) ? (secrets.get(value)?.text ?? "") : value;
	const scheme = /^https?:\/\//i.exec(url)?.[0].toLowerCase() ?? "";
	return `${scheme}${HIDDEN}`;
}

/** Every raw and percent-decoded form of `text` (a query value also with `+` as a space). */
function forms(text: string, query = false): string[] {
	const out = [text];
	const variants = query ? [text, text.replaceAll("+", " ")] : [text];
	for (const variant of variants) {
		try {
			out.push(decodeURIComponent(variant));
		} catch {
			// Not percent-encoded text; the raw form stands.
		}
	}
	return out;
}

const tokenLike = (text: string) => text.length >= MIN_URL_SEGMENT && /\d/.test(text);

/**
 * Pieces of a baseUrl that may repeat a credential elsewhere in the file, for
 * the survival checks (never substituted): userinfo, its user and password,
 * every query value and the fragment at any length, and each token-like path
 * segment and host label (MIN_URL_SEGMENT or more characters and holding a
 * digit). Every raw and decoded form of each of those components is also split
 * on runs of characters outside [A-Za-z0-9._~-], and each token-like piece is
 * registered too, so a token behind an encoded delimiter
 * (`/v1%3Ftoken%3Dsk-…`, `?auth=Bearer%20sk-…`) is found. Other path
 * segments and host labels (`v1`, `api`, `anthropic`, `openrouter`,
 * `completions`) are not registered, since they are public words that recur in
 * provider names and `api` values and would withhold ordinary files. Accepted
 * limitation: a credential in a host or path that is shorter than that or has
 * no digit can appear elsewhere in the file unnoticed.
 */
function urlParts(value: string): string[] {
	const match = /^(?:[^:/?#]+:)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(value);
	if (!match) return [];
	const [, authority, pathPart, query, fragment] = match;
	const parts: string[] = [];
	/** Register a component's forms (all of them, or only token-like ones) and their token-like pieces. */
	const register = (componentForms: string[], whole: boolean) => {
		for (const form of componentForms) {
			if (whole || tokenLike(form)) parts.push(form);
			for (const piece of form.split(/[^A-Za-z0-9._~-]+/)) if (tokenLike(piece)) parts.push(piece);
		}
	};
	if (authority !== undefined) {
		const at = authority.lastIndexOf("@");
		if (at >= 0) {
			const userinfo = authority.slice(0, at);
			const colon = userinfo.indexOf(":");
			for (const piece of colon >= 0 ? [userinfo, userinfo.slice(0, colon), userinfo.slice(colon + 1)] : [userinfo])
				register(forms(piece), true);
		}
		const host = authority
			.slice(at + 1)
			.replace(/:\d*$/, "")
			.replace(/^\[|\]$/g, "");
		for (const label of host.split(".")) register(forms(label), false);
	}
	for (const segment of (pathPart ?? "").split("/")) register(forms(segment), false);
	if (query !== undefined) {
		for (const pair of query.split("&")) {
			const equals = pair.indexOf("=");
			register(forms(equals >= 0 ? pair.slice(equals + 1) : pair, true), true);
		}
	}
	if (fragment !== undefined) register(forms(fragment), true);
	return parts.filter(part => part !== "");
}

/** Whether a restored placeholder's credential may stand at `path`: any at a credential position, only a masked baseUrl at a baseUrl. */
function restorableAt(path: readonly PathKey[], secret: Secret): boolean {
	return isCredentialPath(path) || (isUrlPath(path) && secret.fromUrl);
}

function placeholderFor(text: string): string {
	return `<${MASK_MARK}:${keyed("credential", text).slice(0, 16)}>`;
}

function commentPlaceholderFor(source: string): string {
	return `# <${COMMENT_MARK}:${keyed("comment", source).slice(0, 16)}>`;
}

/** A masked credential: its scalar value (typed, for exact restores), its text, and whether a baseUrl held it. */
export interface Secret {
	value: unknown;
	text: string;
	fromUrl: boolean;
}

/** Keys the user names freely (providers, overridden model ids); a name is not a credential label. */
function isNamePosition(path: readonly PathKey[]): boolean {
	return path[0] === "providers" && (path.length === 2 || (path.length === 4 && path[2] === "modelOverrides"));
}

export type MaskResult =
	| { ok: true; masked: string; secrets: Map<string, Secret>; comments: Map<string, string>; known: string[] }
	/** `known` holds the credentials that could be located, for scrubbing messages. */
	| { ok: false; known: string[] };

export class PlaceholderError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409,
	) {
		super(message);
	}
}

interface Edit {
	start: number;
	end: number;
	text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
	let out = source;
	for (const edit of [...edits].sort((a, b) => b.start - a.start))
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	return out;
}

interface Scalar {
	value: unknown;
	range: [number, number];
	path: PathKey[];
	key: boolean;
	secret: boolean;
}

interface TomlDocument {
	scalars: Scalar[];
	comments: Array<{ offset: number; source: string }>;
	data: Record<string, unknown>;
}

/**
 * Locate TOML source spans, not a second semantic parser. The shared codec is
 * authoritative; this scanner only accepts spans it can map unambiguously.
 * It handles dotted/quoted keys, tables, array tables, arrays, inline tables,
 * multiline strings and comments without ever converting through YAML.
 */
function parse(text: string): TomlDocument | undefined {
	try {
		const data = parseSettingsToml(text);
		const doc: TomlDocument = { data, scalars: [], comments: [] };
		let at = 0;
		let visits = 0;
		let depth = 0;
		let table: PathKey[] = [];
		const arrayTables = new Map<string, number>();
		const fail = (): never => {
			throw new Error("Unlocatable TOML source");
		};
		const budget = () => {
			if (++visits > MAX_VISITS) fail();
		};
		const comment = () => {
			const start = at;
			while (at < text.length && text[at] !== "\n" && text[at] !== "\r") at++;
			doc.comments.push({ offset: start, source: text.slice(start, at) });
		};
		const space = () => {
			while (at < text.length) {
				if (/\s/.test(text[at]!)) at++;
				else if (text[at] === "#") comment();
				else break;
			}
		};
		const quoted = () => {
			const quote = text[at]!;
			const triple = text.slice(at, at + 3) === quote.repeat(3);
			at += triple ? 3 : 1;
			while (at < text.length) {
				if (quote === '"' && text[at] === "\\") {
					at += 2;
					continue;
				}
				if (text[at] === quote) {
					if (!triple) {
						at++;
						return;
					}
					if (text.slice(at, at + 3) === quote.repeat(3)) {
						at += 3;
						// TOML allows one or two extra quotes before the terminator.
						while (text[at] === quote) at++;
						return;
					}
				}
				at++;
			}
			fail();
		};
		const keyPath = (parent: PathKey[]): string[] => {
			const parts: string[] = [];
			while (true) {
				budget();
				while (text[at] === " " || text[at] === "\t") at++;
				const start = at;
				if (text[at] === '"' || text[at] === "'") quoted();
				else while (at < text.length && /[A-Za-z0-9_-]/.test(text[at]!)) at++;
				if (at === start) fail();
				const value = Object.keys(Bun.TOML.parse(`${text.slice(start, at)} = 0`))[0]!;
				parts.push(value);
				doc.scalars.push({ value, range: [start, at], path: [...parent, ...parts], key: true, secret: false });
				while (text[at] === " " || text[at] === "\t") at++;
				if (text[at] !== ".") break;
				at++;
			}
			return parts;
		};
		const value = (path: PathKey[], inheritedSecret: boolean): void => {
			budget();
			if (++depth > 128) fail();
			space();
			const secret =
				inheritedSecret ||
				isCredentialPath(path) ||
				isUrlPath(path) ||
				path.some((key, index) => !isNamePosition(path.slice(0, index + 1)) && isSecretKey(key));
			if (text[at] === "[") {
				at++;
				let index = 0;
				space();
				while (text[at] !== "]") {
					value([...path, index++], secret);
					space();
					if (text[at] !== ",") break;
					at++;
					space();
				}
				if (text[at++] !== "]") fail();
			} else if (text[at] === "{") {
				at++;
				space();
				while (text[at] !== "}") {
					const child = [...path, ...keyPath(path)];
					if (text[at++] !== "=") fail();
					value(child, secret);
					space();
					if (text[at] !== ",") break;
					at++;
					space();
				}
				if (text[at++] !== "}") fail();
			} else {
				const start = at;
				if (text[at] === '"' || text[at] === "'") quoted();
				else while (at < text.length && !/[\n\r,#\]}]/.test(text[at]!)) at++;
				let end = at;
				while (end > start && /\s/.test(text[end - 1]!)) end--;
				if (end === start) fail();
				const parsed = Bun.TOML.parse(`value = ${text.slice(start, end)}`) as Record<string, unknown>;
				doc.scalars.push({ value: parsed.value, range: [start, end], path, key: false, secret });
			}
			depth--;
		};
		while (at < text.length) {
			space();
			if (at === text.length) break;
			if (text[at] === "[") {
				at++;
				const array = text[at] === "[";
				if (array) at++;
				const names = keyPath([]);
				if (text[at++] !== "]" || (array && text[at++] !== "]")) fail();
				table = [];
				for (const [index, name] of names.entries()) {
					table.push(name);
					const id = JSON.stringify(table);
					if (array && index === names.length - 1) {
						const next = (arrayTables.get(id) ?? -1) + 1;
						arrayTables.set(id, next);
						table.push(next);
					} else if (arrayTables.has(id)) table.push(arrayTables.get(id)!);
				}
			} else {
				const keys = keyPath(table);
				if (text[at++] !== "=") fail();
				value([...table, ...keys], false);
			}
			while (text[at] === " " || text[at] === "\t") at++;
			if (text[at] === "#") comment();
			if (at < text.length && text[at] !== "\n" && text[at] !== "\r") fail();
		}
		return doc;
	} catch {
		return undefined;
	}
}

function allScalars(doc: TomlDocument): Scalar[] {
	return doc.scalars;
}

interface Reach {
	masked: Set<Scalar>;
	credential: Set<Scalar>;
	url: Set<Scalar>;
	elsewhere: Set<Scalar>;
}

function reach(doc: TomlDocument): Reach {
	const result: Reach = { masked: new Set(), credential: new Set(), url: new Set(), elsewhere: new Set() };
	for (const node of doc.scalars) {
		if (node.key) continue;
		const credential = isCredentialPath(node.path);
		const url = !credential && isUrlPath(node.path);
		(credential ? result.credential : url ? result.url : result.elsewhere).add(node);
		if (node.secret) result.masked.add(node);
	}
	return result;
}

function comments(text: string): Array<{ offset: number; source: string }> {
	const doc = parse(text);
	if (!doc) throw new Error("Cannot locate TOML comments");
	return doc.comments;
}

function onlyCommentPlaceholders(text: string): boolean {
	return comments(text).every(comment => COMMENT_EXACT.test(comment.source));
}

function scalarEdit(node: Scalar, _source: string, text: string): Edit {
	return { start: node.range[0], end: node.range[1], text };
}

/** Every string a parsed value holds, keys included. */
function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) strings(item, out);
	else if (value && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			out.push(key);
			strings(item, out);
		}
	return out;
}

/** Whether any string in `value` (keys included) contains a known credential. */
export function leaksSecret(value: unknown, known: readonly string[]): boolean {
	const texts = strings(value);
	return known.some(secret => texts.some(text => text.includes(secret)));
}

/** Mask every credential in `text`, or `{ ok: false }` when that cannot be done unambiguously. */
export function maskModelsToml(text: string): MaskResult {
	const doc = parse(text);
	const reached = doc && reach(doc);
	if (!doc || !reached) return { ok: false, known: [] };
	const secrets = new Map<string, Secret>();
	const knownSet = new Set<string>();
	const components = new Set<string>();
	let visits = 0;
	const collect = (value: unknown, path: PathKey[], inherited: boolean): void => {
		if (++visits > MAX_VISITS || path.length > 128) throw new Error("TOML walk budget exceeded");
		const url = isUrlPath(path);
		const secret = inherited || url || isCredentialPath(path) || (!isNamePosition(path) && isSecretKey(path.at(-1)));
		if (Array.isArray(value)) value.forEach((item, index) => collect(item, [...path, index], secret));
		else if (value && typeof value === "object") {
			for (const [key, item] of Object.entries(value)) collect(item, [...path, key], secret);
		} else if (secret && value !== null && value !== undefined && String(value) !== "") {
			const text = String(value);
			knownSet.add(text);
			const id = placeholderFor(text);
			secrets.set(id, { value, text, fromUrl: (secrets.get(id)?.fromUrl ?? false) || url });
			if (url && typeof value === "string") for (const part of urlParts(value)) components.add(part);
		}
	};
	try {
		collect(doc.data, [], false);
	} catch {
		return { ok: false, known: [...knownSet, ...components] };
	}
	// Longest first, so a credential containing another is replaced whole.
	const replaceable = [...knownSet].filter(secret => secret.length >= MIN_REPLACE).sort((a, b) => b.length - a.length);
	for (const part of components) knownSet.add(part);
	const known = [...knownSet];
	const edits: Edit[] = [];
	for (const node of allScalars(doc)) {
		if (!node.range) continue;
		if (reached.masked.has(node)) {
			if (knownSet.has(String(node.value)))
				edits.push(scalarEdit(node, text, scalarSource(placeholderFor(String(node.value)))));
		} else if (typeof node.value === "string") {
			let value = node.value;
			for (const secret of replaceable) value = value.split(secret).join(placeholderFor(secret));
			if (value !== node.value) edits.push(scalarEdit(node, text, scalarSource(value)));
		}
	}
	// A comment inside a rewritten scalar (a block scalar's header comment) goes with it.
	const rewritten = [...edits];
	const commentSources = new Map<string, string>();
	for (const comment of comments(text)) {
		if (rewritten.some(edit => comment.offset >= edit.start && comment.offset < edit.end)) continue;
		const placeholder = commentPlaceholderFor(comment.source);
		commentSources.set(placeholder, comment.source);
		edits.push({ start: comment.offset, end: comment.offset + comment.source.length, text: placeholder });
	}
	const masked = applyEdits(text, edits);
	// Nothing known may survive: not in the text, not in a decoded (escaped) scalar, not in what NeoPi's parser reads.
	if (known.some(secret => masked.includes(secret))) return { ok: false, known };
	const check = parse(masked);
	if (!check || known.some(secret => allScalars(check).some(node => String(node.value).includes(secret))))
		return { ok: false, known };
	if (!onlyCommentPlaceholders(masked)) return { ok: false, known };
	try {
		if (leaksSecret(parseSettingsToml(masked), known)) return { ok: false, known };
	} catch {
		return { ok: false, known };
	}
	return { ok: true, masked, secrets, comments: commentSources, known };
}

/** Line (1-based) of an offset, for messages. */
function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split("\n").length;
}

/** Walk NeoPi's parse of the submitted and restored documents together; they may differ only where a placeholder was restored. */
function sameExceptRestored(
	submitted: unknown,
	restored: unknown,
	path: PathKey[],
	secrets: Map<string, Secret>,
): boolean {
	if (typeof submitted === "string" && submitted.includes(COMMENT_MARK)) return false;
	if (typeof submitted === "string" && submitted.includes(MASK_MARK)) {
		if (!PLACEHOLDER_EXACT.test(submitted)) return false;
		const secret = secrets.get(submitted);
		return secret !== undefined && restorableAt(path, secret) && Bun.deepEquals(secret.value, restored);
	}
	if (Array.isArray(submitted)) {
		return (
			Array.isArray(restored) &&
			submitted.length === restored.length &&
			submitted.every((item, index) => sameExceptRestored(item, restored[index], [...path, index], secrets))
		);
	}
	if (submitted && typeof submitted === "object") {
		if (!restored || typeof restored !== "object" || Array.isArray(restored)) return false;
		const keys = Object.keys(submitted);
		const other = restored as Record<string, unknown>;
		if (
			keys.length !== Object.keys(other).length ||
			keys.some(key => key.includes(MASK_MARK) || key.includes(COMMENT_MARK) || !(key in other))
		)
			return false;
		return keys.every(key =>
			sameExceptRestored((submitted as Record<string, unknown>)[key], other[key], [...path, key], secrets),
		);
	}
	return Bun.deepEquals(submitted, restored);
}

const OUTSIDE_CREDENTIAL =
	"can only be restored as the whole value of an apiKey, a header or a requestMetadata entry, or a masked base URL as a whole baseUrl. Replace it with the full value, or remove it.";
const OUTSIDE_COMMENT =
	"a comment placeholder is restored only as a whole, unchanged comment. Leave it exactly as shown, or delete it and write the comment you want.";
const STALE_PLACEHOLDER =
	"does not match the file on disk (it changed, or the deck restarted since the editor loaded). Reload, then reapply your edits.";

/**
 * Put the credentials from `secrets` and the comments from `comments` (the
 * on-disk file's masking) back in place of their placeholders. A credential
 * placeholder is restored only where it is the whole value of a credential
 * position (a masked baseUrl also as a whole baseUrl); anywhere else (a name,
 * id, key, part of a baseUrl or comment) the document is refused with 400 before anything is
 * validated or written. A comment placeholder is restored only as a whole,
 * unchanged comment, and refused with 400 anywhere else. An unknown
 * placeholder of either kind is refused with 409.
 */
export function restoreModelsToml(
	raw: string,
	secrets: Map<string, Secret>,
	commentSources: Map<string, string>,
): string {
	if (!raw.includes(MASK_MARK) && !raw.includes(COMMENT_MARK)) return raw;
	const doc = parse(raw);
	const reached = doc && reach(doc);
	if (!doc || !reached) {
		throw new PlaceholderError(
			"The document holds masked credentials or comments but is not valid TOML, so they cannot be located.",
			400,
		);
	}
	const edits: Edit[] = [];
	const ranges: Array<[number, number]> = [];
	let unknown = false;
	for (const node of new Set([...reached.credential, ...reached.url])) {
		if (
			reached.elsewhere.has(node) ||
			typeof node.value !== "string" ||
			!node.value.includes(MASK_MARK) ||
			!node.range
		)
			continue;
		if (!PLACEHOLDER_EXACT.test(node.value)) {
			throw new PlaceholderError(
				`Line ${lineOf(raw, node.range[0])}: a masked credential ${OUTSIDE_CREDENTIAL}`,
				400,
			);
		}
		ranges.push([node.range[0], node.range[1]]);
		const secret = secrets.get(node.value);
		if (!secret) {
			unknown = true;
			continue;
		}
		// A baseUrl takes back only a masked baseUrl: a credential from elsewhere would change where requests go.
		if (reached.url.has(node) && !secret.fromUrl)
			throw new PlaceholderError(
				`Line ${lineOf(raw, node.range[0])}: a masked credential ${OUTSIDE_CREDENTIAL}`,
				400,
			);
		edits.push(scalarEdit(node, raw, scalarSource(secret.value)));
	}
	const commentRanges: Array<[number, number]> = [];
	for (const comment of comments(raw)) {
		if (!comment.source.includes(COMMENT_MARK) || !COMMENT_EXACT.test(comment.source)) continue;
		const end = comment.offset + comment.source.length;
		commentRanges.push([comment.offset, end]);
		const original = commentSources.get(comment.source);
		if (original !== undefined) edits.push({ start: comment.offset, end, text: original });
		else unknown = true;
	}
	const inside = (at: number, within: Array<[number, number]>) =>
		within.some(([start, end]) => at >= start && at < end);
	for (let at = raw.indexOf(MASK_MARK); at >= 0; at = raw.indexOf(MASK_MARK, at + 1)) {
		if (!inside(at, ranges))
			throw new PlaceholderError(`Line ${lineOf(raw, at)}: a masked credential ${OUTSIDE_CREDENTIAL}`, 400);
	}
	for (let at = raw.indexOf(COMMENT_MARK); at >= 0; at = raw.indexOf(COMMENT_MARK, at + 1)) {
		if (!inside(at, commentRanges)) throw new PlaceholderError(`Line ${lineOf(raw, at)}: ${OUTSIDE_COMMENT}`, 400);
	}
	if (unknown) throw new PlaceholderError(`A masked credential or comment ${STALE_PLACEHOLDER}`, 409);
	const restored = applyEdits(raw, edits);
	// Cross-check with the parser NeoPi uses: only restored credential positions may differ.
	let submittedData: unknown;
	try {
		submittedData = parseSettingsToml(raw);
	} catch {
		return restored; // NeoPi rejects the submitted document itself; nothing is written.
	}
	let restoredData: unknown;
	try {
		restoredData = parseSettingsToml(restored);
	} catch {
		throw new PlaceholderError(
			"The masked credentials could not be restored unambiguously. Replace them with the full values.",
			400,
		);
	}
	if (!sameExceptRestored(submittedData, restoredData, [], secrets)) {
		throw new PlaceholderError(`A masked credential ${OUTSIDE_CREDENTIAL}`, 400);
	}
	return restored;
}

const WITHHELD =
	"NeoPi rejects this document; its message is withheld because it would quote a credential. The deck server log has the details.";

/** `message` with known credentials replaced, or a withheld notice when that is ambiguous. */
export function safeMessage(message: string, known: readonly string[]): string {
	let out = message;
	for (const secret of [...known].filter(s => s.length >= MIN_REPLACE).sort((a, b) => b.length - a.length))
		out = out.split(secret).join("<masked>");
	return known.some(secret => out.includes(secret)) ? WITHHELD : out;
}

export const WITHHELD_MESSAGE = WITHHELD;
