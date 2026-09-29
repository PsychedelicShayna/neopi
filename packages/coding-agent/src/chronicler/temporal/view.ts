/**
 * The derived temporal view on disk.
 *
 * ```
 * <root>/VIEW.json                 manifest: config, completeness
 * <root>/node.json, NODE.md        root node
 * <root>/2026/09/w1/03/14/…        one directory per node, named by temporal position
 * <terminal dir>/<time>-<slug>-<id>.md   derived atom stubs (first index of atom names)
 * ```
 *
 * `node.json` is the authority for the derived view; `NODE.md` and stubs are
 * deterministic renders of it, verified byte-for-byte. Nothing here is a
 * source of truth: deleting the root loses nothing that `index` cannot rebuild
 * from the canonical atoms.
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { hashText } from "./corpus";
import type { AtomEntry, IndexConfig, NodeLevel } from "./tree";

export const VIEW_FORMAT_VERSION = 1;
export const NODE_FILE = "node.json";
export const NODE_MARKDOWN = "NODE.md";
export const VIEW_FILE = "VIEW.json";

export interface ViewChildRef {
	key: string;
	segment: string;
	level: NodeLevel;
	label: string;
	localStart: string;
	localEnd: string;
	start: string;
	end: string;
	atomCount: number;
	projects: string[];
	sessions: string[];
	/** Child identity and content as consumed when this node was generated. */
	identity: string;
	contentHash: string;
	/** Parent-authored routing description of this child. */
	description: string;
}

export interface NodeProvenance {
	kind: "generated" | "single-child" | "enumeration";
	/** `provider/model:thinking` for generated nodes. */
	model?: string;
	promptVersion?: number;
	generatedAt: string;
	truncated: boolean;
	/** Estimated tokens of the generation input. */
	inputTokens?: number;
}

export interface IdentityParts {
	config: string;
	model: string;
	inputs: string;
}

export interface ViewNode {
	format: "chronicle-node";
	version: number;
	key: string;
	segment: string;
	level: NodeLevel;
	label: string;
	localStart: string;
	localEnd: string;
	start: string;
	end: string;
	atomCount: number;
	projects: string[];
	sessions: string[];
	identity: string;
	identityParts: IdentityParts;
	contentHash: string;
	overview?: string;
	children: ViewChildRef[];
	atoms?: AtomEntry[];
	provenance: NodeProvenance;
}

export interface ViewManifest {
	format: "chronicle-view";
	version: number;
	timeZone: string;
	config: IndexConfig;
	complete: boolean;
	startedAt: string;
	indexedAt?: string;
	atomCount: number;
	summaryModel?: string;
}

const SEGMENT_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** A node key is `/`-joined safe segments; anything else could escape the view root. */
export function isSafeKey(key: string): boolean {
	return key === "" || key.split("/").every(segment => SEGMENT_RE.test(segment) && !segment.includes(".."));
}

export function nodeDir(root: string, key: string): string {
	if (!isSafeKey(key)) throw new Error(`Unsafe chronicle node key: ${key}`);
	return key ? path.join(root, ...key.split("/")) : root;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

/** Structural check of every field a reader or the indexer consumes. */
function structureProblem(node: ViewNode, key: string): string | undefined {
	if (node.format !== "chronicle-node" || node.version !== VIEW_FORMAT_VERSION || node.key !== key) {
		return "unexpected node format, version, or key";
	}
	if (!isString(node.identity) || !isString(node.contentHash) || !isString(node.label) || !isString(node.segment)) {
		return "node.json lacks identity, content hash, label, or segment";
	}
	if (!isString(node.start) || !isString(node.end) || !isString(node.localStart) || !isString(node.localEnd)) {
		return "node.json lacks its period";
	}
	if (!isStringArray(node.projects) || !isStringArray(node.sessions) || typeof node.atomCount !== "number") {
		return "node.json lacks projects, sessions, or atom count";
	}
	if (typeof node.provenance !== "object" || node.provenance === null || typeof node.identityParts !== "object") {
		return "node.json lacks provenance";
	}
	if (!Array.isArray(node.children)) return "node.json lacks children";
	for (const child of node.children) {
		if (
			typeof child !== "object" ||
			child === null ||
			![child.key, child.segment, child.label, child.identity, child.contentHash, child.description].every(
				isString,
			) ||
			![child.start, child.end, child.localStart, child.localEnd].every(isString) ||
			!isStringArray(child.projects) ||
			!isStringArray(child.sessions) ||
			!SEGMENT_RE.test(child.segment) ||
			child.key !== (key ? `${key}/${child.segment}` : child.segment)
		) {
			return "node.json has a malformed child entry";
		}
	}
	if (node.atoms !== undefined) {
		if (!Array.isArray(node.atoms) || node.children.length > 0) return "node.json has malformed atoms";
		for (const atom of node.atoms) {
			if (
				typeof atom !== "object" ||
				atom === null ||
				![
					atom.id,
					atom.stub,
					atom.title,
					atom.route,
					atom.fingerprint,
					atom.eventTime,
					atom.localTime,
					atom.project,
					atom.sessionId,
					atom.beatFile,
					atom.chroniclerRoot,
					atom.batchId,
					atom.transcriptPath,
					atom.lead,
				].every(isString) ||
				!isStringArray(atom.sources) ||
				!isStringArray(atom.topics) ||
				!SEGMENT_RE.test(atom.stub)
			) {
				return "node.json has a malformed atom entry";
			}
		}
	}
	if (computeContentHash(node) !== node.contentHash) return "node.json content does not match its content hash";
	return undefined;
}

export function isTerminal(node: Pick<ViewNode, "atoms">): boolean {
	return node.atoms !== undefined;
}

/** JSON with object keys sorted, so the hash does not depend on property order. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Hash of everything a node carries except the hash itself: routing text,
 * scope metadata (periods, projects, sessions, counts), child references,
 * atom locators, and provenance. Any edit to node.json that a reader could
 * act on changes it.
 */
export function computeContentHash(node: ViewNode): string {
	const { contentHash: _omit, ...content } = node;
	return hashText(canonicalJson(content));
}

export function routeLinePrefix(child: Pick<ViewChildRef, "label" | "key">): string {
	return `- ${child.label} [${child.key}]: `;
}

/** The text a parent summarizes and a ranker reads for this node. */
export function routingText(node: ViewNode): string {
	if (node.atoms) return node.atoms.map(atom => atom.route).join("\n");
	const lines = [node.overview ?? ""];
	for (const child of node.children) lines.push(`${routeLinePrefix(child)}${child.description}`);
	return lines.join("\n");
}

function yamlLine(key: string, value: unknown): string {
	return `${key}: ${YAML.stringify(value)}`;
}

export function renderNodeMarkdown(node: ViewNode): string {
	const front = [
		yamlLine("key", node.key || "/"),
		yamlLine("level", node.level),
		yamlLine("label", node.label),
		yamlLine("period", `${node.localStart} – ${node.localEnd}`),
		yamlLine("atoms", node.atomCount),
		yamlLine("projects", node.projects),
		yamlLine("sessions", node.sessions),
		yamlLine("identity", node.identity),
		yamlLine("content", node.contentHash),
		yamlLine("generated_by", node.provenance.model ?? node.provenance.kind),
		yamlLine("generated_at", node.provenance.generatedAt),
		yamlLine("truncated", node.provenance.truncated),
	];
	const lines = ["---", ...front, "---", "", `# ${node.label}`, ""];
	if (node.atoms) {
		lines.push(
			"Terminal bucket: every atom is enumerated. Open a stub for its descriptor, or its canonical file for the full text.",
			"",
		);
		for (const atom of node.atoms) lines.push(atom.route);
	} else {
		lines.push(node.overview ?? "", "", "## Children", "");
		lines.push("| dir | period | atoms | projects | description |", "|---|---|---:|---|---|");
		for (const child of node.children) {
			const cell = (text: string) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
			lines.push(
				`| [${child.segment}/](${child.segment}/NODE.md) | ${child.localStart} – ${child.localEnd} | ${child.atomCount} | ${cell(child.projects.map(project => path.basename(project) || project).join(", "))} | ${cell(child.description)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function renderStub(atom: AtomEntry): string {
	const front = [
		yamlLine("id", atom.id),
		yamlLine("title", atom.title),
		yamlLine("kind", atom.kind),
		yamlLine("event_time", atom.eventTime),
		yamlLine("local_time", atom.localTime),
		yamlLine("captured_at", atom.capturedAt),
		yamlLine("project", atom.project),
		yamlLine("session", atom.sessionId),
		yamlLine("topics", atom.topics),
		yamlLine("beat", atom.beatFile),
		yamlLine("batch", atom.batchId),
		yamlLine("transcript", atom.transcriptPath),
		yamlLine("sources", atom.sources),
		yamlLine("fingerprint", atom.fingerprint),
	];
	const lead = atom.leadRemainder > 0 ? `${atom.lead} … [+${atom.leadRemainder} chars in canonical atom]` : atom.lead;
	return `---\n${front.join("\n")}\n---\n\n# ${atom.title}\n\n${lead}\n\nCanonical atom: ${atom.beatFile}\n`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
	const temp = `${file}.tmp-${process.pid}`;
	await Bun.write(temp, text);
	await fs.rename(temp, file);
}

export type StoredNode = { state: "missing" } | { state: "corrupt"; reason: string } | { state: "ok"; node: ViewNode };

export async function readViewNode(root: string, key: string): Promise<StoredNode> {
	const file = path.join(nodeDir(root, key), NODE_FILE);
	let raw: string;
	try {
		raw = await Bun.file(file).text();
	} catch (error) {
		if (isEnoent(error)) return { state: "missing" };
		return { state: "corrupt", reason: String(error) };
	}
	let node: ViewNode;
	try {
		node = JSON.parse(raw) as ViewNode;
	} catch (error) {
		return { state: "corrupt", reason: `node.json is not valid JSON (${String(error)})` };
	}
	if (typeof node !== "object" || node === null) return { state: "corrupt", reason: "node.json is not an object" };
	const problem = structureProblem(node, key);
	return problem ? { state: "corrupt", reason: problem } : { state: "ok", node };
}

/**
 * Byte-level drift between node.json and its renders: a recomputed content
 * hash, NODE.md, and the stub set. Empty when the node is internally consistent.
 */
export async function verifyRenders(root: string, node: ViewNode): Promise<string[]> {
	const issues: string[] = [];
	if (computeContentHash(node) !== node.contentHash) issues.push("node.json content hash mismatch");
	const dir = nodeDir(root, node.key);
	try {
		if ((await Bun.file(path.join(dir, NODE_MARKDOWN)).text()) !== renderNodeMarkdown(node)) {
			issues.push("NODE.md differs from node.json");
		}
	} catch {
		issues.push("NODE.md missing");
	}
	const expected = new Set<string>([NODE_FILE, NODE_MARKDOWN]);
	if (!node.key) expected.add(VIEW_FILE);
	for (const child of node.children) expected.add(child.segment);
	for (const atom of node.atoms ?? []) {
		expected.add(atom.stub);
		try {
			if ((await Bun.file(path.join(dir, atom.stub)).text()) !== renderStub(atom)) {
				issues.push(`stub ${atom.stub} differs from its atom entry`);
			}
		} catch {
			issues.push(`stub ${atom.stub} missing`);
		}
	}
	for (const name of await listDir(dir)) {
		if (!expected.has(name)) issues.push(`unexpected ${name}`);
	}
	return issues;
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/**
 * Publish a node: stubs, then NODE.md, then node.json. Unexpected entries in
 * its directory are removed; returns the keys of removed child directories.
 */
export async function writeViewNode(
	root: string,
	node: ViewNode,
	keepChildSegments: ReadonlySet<string>,
): Promise<string[]> {
	const dir = nodeDir(root, node.key);
	await assertNoSymlinkedNodeDir(root, node.key);
	await fs.mkdir(dir, { recursive: true });
	const keep = new Set<string>([NODE_FILE, NODE_MARKDOWN, ...keepChildSegments]);
	if (!node.key) keep.add(VIEW_FILE);
	for (const atom of node.atoms ?? []) {
		keep.add(atom.stub);
		await writeAtomic(path.join(dir, atom.stub), renderStub(atom));
	}
	await writeAtomic(path.join(dir, NODE_MARKDOWN), renderNodeMarkdown(node));
	await writeAtomic(path.join(dir, NODE_FILE), `${JSON.stringify(node, null, "\t")}\n`);
	const pruned: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (keep.has(entry.name)) continue;
		await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
		if (entry.isDirectory()) pruned.push(node.key ? `${node.key}/${entry.name}` : entry.name);
	}
	return pruned;
}

export async function readViewManifest(root: string): Promise<ViewManifest | null> {
	try {
		const manifest = (await Bun.file(path.join(root, VIEW_FILE)).json()) as ViewManifest;
		return manifest.format === "chronicle-view" ? manifest : null;
	} catch {
		return null;
	}
}

export async function writeViewManifest(root: string, manifest: ViewManifest): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await writeAtomic(path.join(root, VIEW_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
}

/**
 * Stored node directories whose key is not in `wanted`, outermost first.
 * Directories inside a wanted node that are not its listed children are left
 * to `writeViewNode`/`verifyRenders`.
 */
export async function findOrphanDirs(root: string, wanted: ReadonlySet<string>): Promise<string[]> {
	const orphans: string[] = [];
	const walk = async (key: string): Promise<void> => {
		const dir = nodeDir(root, key);
		let entries: fsTypes.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const childKey = key ? `${key}/${entry.name}` : entry.name;
			if (wanted.has(childKey)) await walk(childKey);
			else orphans.push(childKey);
		}
	};
	await walk("");
	return orphans;
}

export async function removeNodeDir(root: string, key: string): Promise<void> {
	await assertNoSymlinkedNodeDir(root, key);
	await fs.rm(nodeDir(root, key), { recursive: true, force: true });
}

function isWithin(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Real path of `target`: its nearest existing ancestor resolved through symlinks, plus the missing remainder. */
async function realPathOf(target: string): Promise<string> {
	const absolute = path.resolve(target);
	let existing = absolute;
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(await fs.realpath(existing), ...missing.reverse());
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(existing);
			if (parent === existing) return absolute;
			missing.push(path.basename(existing));
			existing = parent;
		}
	}
}

function isOwnershipManifest(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as Partial<ViewManifest>;
	return (
		manifest.format === "chronicle-view" &&
		manifest.version === VIEW_FORMAT_VERSION &&
		typeof manifest.timeZone === "string" &&
		typeof manifest.complete === "boolean" &&
		typeof manifest.startedAt === "string" &&
		typeof manifest.config === "object" &&
		manifest.config !== null
	);
}

/**
 * Refuse to manage a directory the view does not own. Compared by real
 * filesystem path (symlinks resolved, including ancestors), the root may not
 * be, contain, or sit inside the sessions directory, nor be or contain the
 * agent directory; an existing non-empty root must carry a valid, versioned
 * VIEW.json. Pruning deletes unrecognized entries, so this is what keeps it
 * inside the view.
 */
export async function assertOwnedViewRoot(root: string, agentDir: string, sessionsDir: string): Promise<void> {
	const [target, sessions, agent] = await Promise.all([
		realPathOf(root),
		realPathOf(sessionsDir),
		realPathOf(agentDir),
	]);
	if (isWithin(sessions, target) || isWithin(target, sessions) || isWithin(agent, target)) {
		throw new Error(`Refusing to use ${root} as the chronicle view: it overlaps the agent or sessions directory`);
	}
	const entries = await listDir(target);
	if (entries.length === 0) return;
	let manifest: unknown;
	try {
		manifest = await Bun.file(path.join(target, VIEW_FILE)).json();
	} catch {
		manifest = undefined;
	}
	if (!isOwnershipManifest(manifest)) {
		throw new Error(
			`Refusing to use ${root} as the chronicle view: it is not empty and has no valid chronicle ${VIEW_FILE}`,
		);
	}
}

/** Refuse to write or prune through a symlinked directory between the root and `key`'s node directory. */
async function assertNoSymlinkedNodeDir(root: string, key: string): Promise<void> {
	let dir = root;
	for (const segment of key ? key.split("/") : []) {
		dir = path.join(dir, segment);
		try {
			if ((await fs.lstat(dir)).isSymbolicLink()) {
				throw new Error(`Refusing to write through the symbolic link ${dir} in the chronicle view`);
			}
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
	}
}
