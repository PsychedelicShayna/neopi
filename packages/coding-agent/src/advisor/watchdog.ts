import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAgentDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { expandAtImports } from "../discovery/at-imports";
import activeRepoWatchdogTemplate from "../prompts/advisor/active-repo-watchdog.md" with { type: "text" };
import contextFilesTemplate from "../prompts/advisor/context-files.md" with { type: "text" };
import memoryContextTemplate from "../prompts/advisor/memory-context.md" with { type: "text" };
import type { ActiveRepoContext } from "@oh-my-pi/pi-tui/status-line/host";
import { normalizePromptPath } from "../utils/prompt-path";

export function formatActiveRepoWatchdogPrompt(activeRepoContext: ActiveRepoContext): string {
	return prompt
		.render(activeRepoWatchdogTemplate, {
			relativeRepoRoot: normalizePromptPath(activeRepoContext.relativeRepoRoot),
		})
		.trim();
}

/**
 * Render the project context files (AGENTS.md and the like) into a block for the
 * advisor's system prompt, mirroring how the primary agent receives them. Gives
 * the read-only reviewer the user's standing project instructions so it can hold
 * the driving agent to them instead of advising against project conventions it
 * cannot otherwise see. Returns undefined when there are no context files.
 */
export function formatAdvisorContextPrompt(
	contextFiles: ReadonlyArray<{ path: string; content: string }>,
): string | undefined {
	if (contextFiles.length === 0) return undefined;
	return prompt.render(contextFilesTemplate, { contextFiles }).trim() || undefined;
}

/**
 * Wrap the active memory backend's developer instructions (the same block the
 * primary agent gets appended to its system prompt) for an advisor's system
 * prompt. The wrapper marks the block as shared background knowledge and warns
 * that memory tools mentioned inside may be absent from the advisor's own tool
 * list. Returns undefined when the backend injected nothing.
 */
export function formatAdvisorMemoryPrompt(memoryInstructions: string | undefined): string | undefined {
	if (!memoryInstructions?.trim()) return undefined;
	return prompt.render(memoryContextTemplate, { memoryInstructions: memoryInstructions.trim() }).trim() || undefined;
}

/**
 * A readable config candidate discovered on the watchdog/advisor search path,
 * with raw (un-expanded) content and its position metadata.
 */
export interface ConfigCandidate {
	path: string;
	content: string;
	level: "user" | "project";
	depth: number;
}

/**
 * The watchdog/advisor config search path for the given filenames: the user
 * agent dir, then every directory from `cwd` up to the repo root (or home),
 * probing both `<F>` and `.omp/<F>`. Paths only, readable or not, in probe order.
 */
export function configCandidatePaths(
	cwd: string,
	agentDir: string | undefined,
	filenames: string[],
): { candidates: string[]; userPaths: ReadonlySet<string> } {
	const home = os.homedir();
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const userPaths = new Set<string>();
	let repoRoot: string | null = null;
	try {
		repoRoot = vcs.repo(cwd)?.root() ?? null;
	} catch (err) {
		logger.debug("Failed to resolve VCS root for config discovery", { err: String(err) });
	}

	const candidates = new Set<string>();

	// 1. User level: ~/.omp/<F> (or active profile agent dir)
	if (resolvedAgentDir) {
		for (const filename of filenames) {
			const userPath = path.resolve(resolvedAgentDir, filename);
			candidates.add(userPath);
			userPaths.add(userPath);
		}
	}

	// 2. Project levels (both standalone and native config .omp/): walk up from cwd to repoRoot / home
	let current = cwd;
	while (true) {
		for (const filename of filenames) {
			candidates.add(path.resolve(current, ".omp", filename));
			candidates.add(path.resolve(current, filename));
		}
		if (current === (repoRoot ?? home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return { candidates: [...candidates], userPaths };
}

/** Why a config candidate was skipped unread. */
export type ConfigRejection = { kind: "too_large"; bytes: number } | { kind: "not_regular" };

export type BoundedText = { content: string } | { rejected: ConfigRejection };

const utf8 = new TextDecoder();
/** Opening a FIFO must not wait for a writer before the handle's stat can refuse it. */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Read a config file through one handle. Anything but a regular file (a device such as
 * `/dev/zero` behind a symlink, a FIFO, a socket) is refused by the handle's stat before
 * any read. With `maxBytes`, at most `maxBytes + 1` bytes are ever read, so a file that
 * lies about its size or grows after the stat is still bounded. Missing files reject.
 */
export async function readBoundedText(filePath: string, maxBytes: number | undefined): Promise<BoundedText> {
	const handle = await fs.open(filePath, OPEN_FLAGS);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return { rejected: { kind: "not_regular" } };
		if (maxBytes === undefined) return { content: utf8.decode(await handle.readFile()) };
		if (stat.size > maxBytes) return { rejected: { kind: "too_large", bytes: stat.size } };
		const limit = maxBytes + 1;
		const chunks: Buffer[] = [];
		let total = 0;
		while (total < limit) {
			// Sized for the whole file in one read; the stat is a hint, the limit is the bound.
			const chunk = Buffer.allocUnsafe(Math.min(Math.max(stat.size + 1, 4096), limit - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		if (total > maxBytes) return { rejected: { kind: "too_large", bytes: total } };
		return { content: utf8.decode(Buffer.concat(chunks, total)) };
	} finally {
		await handle.close();
	}
}

export interface CollectConfigOptions {
	/** Candidates larger than this are skipped, never read past the bound, and reported through `onRejected`. */
	maxBytes?: number;
	/** A candidate skipped unread; without it a rejection is logged. */
	onRejected?(filePath: string, rejection: ConfigRejection): void;
}

/**
 * Walk the config search path ({@link configCandidatePaths}) and return the
 * readable candidates with their raw content, sorted user-first then project
 * ancestor→leaf (depth descending, so the leaf directory is most
 * specific/last). Shared by {@link discoverWatchdogFiles} and
 * `discoverAdvisorConfigs`. Content is returned verbatim (no `@import`
 * expansion); callers expand what they need.
 */
export async function collectConfigCandidates(
	cwd: string,
	agentDir: string | undefined,
	filenames: string[],
	options: CollectConfigOptions = {},
): Promise<ConfigCandidate[]> {
	const { candidates, userPaths } = configCandidatePaths(cwd, agentDir, filenames);
	const items: ConfigCandidate[] = [];
	for (const candidate of candidates) {
		const parent = path.dirname(candidate);
		const baseName = parent.split(path.sep).pop() ?? "";
		const isUser = userPaths.has(candidate);
		const ownerDir = baseName === ".omp" ? path.dirname(parent) : parent;
		const ownerBaseName = ownerDir.split(path.sep).pop() ?? "";
		if (!isUser && ownerBaseName.startsWith(".") && baseName !== ".omp") continue;
		try {
			const read = await readBoundedText(candidate, options.maxBytes);
			if ("rejected" in read) {
				if (options.onRejected) options.onRejected(candidate, read.rejected);
				else logger.warn("Skipped config candidate", { path: candidate, ...read.rejected });
				continue;
			}
			const relative = path.relative(cwd, ownerDir);
			const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
			items.push({ path: candidate, content: read.content, level: isUser ? "user" : "project", depth });
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to read config candidate", { path: candidate, error: String(err) });
			}
		}
	}

	// User level first, then project levels sorted by depth descending — ancestor
	// directories first, the leaf (depth 0) last/most prominent.
	items.sort((a, b) => {
		if (a.level !== b.level) return a.level === "user" ? -1 : 1;
		return b.depth - a.depth;
	});

	return items;
}

/**
 * Discover and load WATCHDOG.md files walking up from cwd, project .omp folder, and user agent dir.
 * Returns formatted watchdog file blocks ready to be appended to the advisor system prompt.
 */
export async function discoverWatchdogFiles(cwd: string, agentDir?: string): Promise<string[]> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.md"]);
	const blocks: string[] = [];
	for (const item of items) {
		const expanded = await expandAtImports(item.content, item.path);
		blocks.push(`Especially pay attention to:\n<attention>\n${expanded}\n</attention>`);
	}
	return blocks;
}
