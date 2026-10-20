import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, getProjectDir } from "./dirs";
import { isEnoent, isEnotdir } from "./fs-error";
import * as logger from "./logger";
import { LRUCache } from "./lru";
import { compile, render, type TemplateContext } from "./prompt";
import { parseTemplate, TemplateSyntaxError } from "./template";

export type PromptAssetSource = "project" | "user" | "bundled";

export interface PromptAssetOptions {
	cwd?: string;
	agentDir?: string;
	kind?: "core" | "notice";
	/** Inspect only this builtin-prompts root, rather than the runtime precedence chain. */
	root?: string;
	source?: "project" | "user";
}

export interface ResolvedPromptAsset {
	text: string;
	source: PromptAssetSource;
	path?: string;
	hash: string;
	bundledHash: string;
}

export interface PromptAssetProvenance extends Omit<ResolvedPromptAsset, "text"> {
	id: string;
}

interface CachedOverride {
	mtime: number;
	ctime: number;
	size: number;
	ino: number;
	text: string;
	hash: string;
	checked: boolean;
	error?: TemplateSyntaxError;
	warned: boolean;
}

interface ObservedAsset {
	cwd: string;
	agentDir: string;
	asset: PromptAssetProvenance;
}

const overrides = new LRUCache<string, CachedOverride>({
	max: 256,
	maxSize: 8 * 1024 * 1024,
	sizeCalculation: entry => Math.max(1, entry.text.length * 2),
});
const bundledHashes = new LRUCache<string, string>({
	max: 256,
	maxSize: 8 * 1024 * 1024,
	sizeCalculation: (_hash, text) => Math.max(1, text.length * 2),
});
const observedAssets = new LRUCache<string, ObservedAsset>({ max: 1024 });

/** Stable SHA-256 hex digest, shared by manifests and runtime provenance. */
export function hashPromptAsset(text: string): string {
	const cached = bundledHashes.get(text);
	if (cached !== undefined) return cached;
	const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
	bundledHashes.set(text, hash);
	return hash;
}

function validateId(id: string): void {
	if (
		!id ||
		/[\\:\u0000-\u001f\u007f]/.test(id) ||
		id.split("/").some(segment => !segment || segment === "." || segment === "..")
	) {
		throw new TypeError(`Prompt asset id must be a safe relative path: ${JSON.stringify(id)}`);
	}
}

function readOverride(file: string): CachedOverride | undefined {
	try {
		const stat = fs.statSync(file);
		const cached = overrides.get(file);
		if (
			cached &&
			cached.mtime === stat.mtimeMs &&
			cached.ctime === stat.ctimeMs &&
			cached.size === stat.size &&
			cached.ino === stat.ino
		)
			return cached;
		const text = fs.readFileSync(file, "utf8");
		const entry: CachedOverride = {
			mtime: stat.mtimeMs,
			ctime: stat.ctimeMs,
			size: stat.size,
			ino: stat.ino,
			text,
			hash: hashPromptAsset(text),
			checked: false,
			warned: false,
		};
		overrides.set(file, entry);
		return entry;
	} catch (error) {
		overrides.delete(file);
		if (isEnoent(error) || isEnotdir(error)) return undefined;
		throw error;
	}
}

function bundledAsset(bundled: string): ResolvedPromptAsset {
	const hash = hashPromptAsset(bundled);
	return { text: bundled, source: "bundled", hash, bundledHash: hash };
}

interface LoadedAsset {
	asset: ResolvedPromptAsset;
	entry?: CachedOverride;
}

function loadAsset(id: string, bundled: string, options: PromptAssetOptions): LoadedAsset {
	validateId(id);
	const bundledHash = hashPromptAsset(bundled);
	const roots: { root: string; source: "project" | "user" }[] =
		options.root !== undefined
			? [{ root: path.resolve(options.root), source: options.source ?? "user" }]
			: [
					{
						root: path.join(getProjectAgentDir(options.cwd ?? getProjectDir()), "builtin-prompts"),
						source: "project",
					},
					{ root: path.join(options.agentDir ?? getAgentDir(), "builtin-prompts"), source: "user" },
				];
	for (const { root, source } of roots) {
		const file = path.join(root, id);
		const entry = readOverride(file);
		if (entry) return { asset: { text: entry.text, source, path: file, hash: entry.hash, bundledHash }, entry };
	}
	return { asset: bundledAsset(bundled) };
}

/** Read effective template source, including malformed overrides, for inspection and validation. */
export function inspectPromptAsset(id: string, bundled: string, options: PromptAssetOptions = {}): ResolvedPromptAsset {
	return loadAsset(id, bundled, options).asset;
}

/** Resolve one whole-file override. The bundled string remains unchanged when no override exists. */
export function resolvePromptAsset(id: string, bundled: string, options: PromptAssetOptions = {}): ResolvedPromptAsset {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const { asset, entry } = loadAsset(id, bundled, { ...options, cwd, agentDir });
	let effective = asset;
	if (entry && entry.text !== bundled) {
		if (!entry.checked) {
			try {
				parseTemplate(entry.text);
			} catch (error) {
				if (!(error instanceof TemplateSyntaxError)) throw error;
				entry.error = error;
			}
			entry.checked = true;
		}
		if (entry.error && options.kind !== "notice") {
			throw new TemplateSyntaxError(
				`invalid prompt override ${asset.path}: ${entry.error.message}`,
				entry.error.loc,
				entry.error.expression,
			);
		}
		if (entry.error) {
			if (!entry.warned) {
				logger.warn("Invalid prompt notice override; using bundled template", {
					id,
					path: asset.path,
					error: entry.error,
				});
				entry.warned = true;
			}
			effective = bundledAsset(bundled);
		}
	}
	recordProvenance(id, effective, cwd, agentDir);
	return effective;
}

function recordProvenance(id: string, asset: ResolvedPromptAsset, cwd: string, agentDir: string): void {
	const { text: _text, ...provenance } = asset;
	observedAssets.set(JSON.stringify([cwd, agentDir, id]), { cwd, agentDir, asset: { id, ...provenance } });
}

function renderFallback(
	id: string,
	bundled: string,
	asset: ResolvedPromptAsset,
	options: PromptAssetOptions,
	error: unknown,
): string {
	if (asset.source === "bundled") throw error;
	if (options.kind !== "notice") {
		throw new Error(
			`Failed rendering prompt override ${asset.path}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
	const entry = asset.path ? overrides.get(asset.path) : undefined;
	if (!entry?.warned) {
		logger.warn("Failed rendering prompt notice override; using bundled template", { id, path: asset.path, error });
		if (entry) entry.warned = true;
	}
	recordProvenance(
		id,
		bundledAsset(bundled),
		path.resolve(options.cwd ?? getProjectDir()),
		path.resolve(options.agentDir ?? getAgentDir()),
	);
	return bundled;
}

/** Resolve and render with the ordinary prompt formatter, including notice render-error fallback. */
export function renderPromptAsset(
	id: string,
	bundled: string,
	context: TemplateContext = {},
	options: PromptAssetOptions = {},
): string {
	const asset = resolvePromptAsset(id, bundled, options);
	try {
		return render(asset.text, context);
	} catch (error) {
		return render(renderFallback(id, bundled, asset, options, error), context);
	}
}

/** Resolve at compilation time and preserve the unformatted prompt.compile return contract. */
export function compilePromptAsset(
	id: string,
	bundled: string,
	options: PromptAssetOptions = {},
): (context: TemplateContext) => string {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const resolvedOptions = { ...options, cwd, agentDir };
	const asset = resolvePromptAsset(id, bundled, resolvedOptions);
	const compiled = compile(asset.text);
	let fallbackUsed = false;
	return context => {
		try {
			const text = compiled(context);
			if (fallbackUsed) {
				recordProvenance(id, asset, cwd, agentDir);
				fallbackUsed = false;
			}
			return text;
		} catch (error) {
			const fallback = compile(renderFallback(id, bundled, asset, resolvedOptions, error))(context);
			fallbackUsed = true;
			return fallback;
		}
	};
}

/** Assets actually resolved in this project/profile, not merely inspected by CLI commands. */
export function getPromptAssetProvenance(options: { cwd?: string; agentDir?: string } = {}): PromptAssetProvenance[] {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const result: PromptAssetProvenance[] = [];
	for (const observed of observedAssets.values()) {
		if (observed.cwd === cwd && observed.agentDir === agentDir) result.push({ ...observed.asset });
	}
	return result.sort((left, right) => left.id.localeCompare(right.id));
}
