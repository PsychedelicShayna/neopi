import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatchHunks } from "@oh-my-pi/pi-natives";
import { getAgentDir, getProjectDir, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { t, type TranslationValues } from "@oh-my-pi/pi-utils/i18n";
import { inspectPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { promptAssets } from "../prompts/catalog";
import { getPromptAssetKeys, getPromptLexicon } from "../prompts/lexicon";
import type { PromptAsset, PromptContextKey, PromptDiagnostic } from "../prompts/types";
import { validatePrompt } from "../prompts/validation";

export const PROMPT_ACTIONS = ["unpack", "list", "show", "diff", "reset", "lexicon", "keys", "check"] as const;
export type PromptsAction = (typeof PROMPT_ACTIONS)[number];
export interface PromptsFlags {
	json?: boolean;
	user?: boolean;
	project?: boolean;
	dir?: string;
	force?: boolean;
	only?: string;
	include?: string;
	helpers?: boolean;
	vars?: boolean;
	scope?: string;
	used?: boolean;
	unused?: boolean;
	all?: boolean;
	strict?: boolean;
	"strict-warnings"?: boolean;
	runtime?: boolean;
	fixture?: string;
	installed?: boolean;
	agents?: boolean;
}
export interface PromptsCommandArgs {
	action: string;
	targets?: string[];
	flags: PromptsFlags;
}
export interface PromptsCommandOptions {
	cwd?: string;
	agentDir?: string;
	assets?: readonly PromptAsset[];
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	validate?: typeof validatePrompt;
}
interface ManifestAsset {
	id: string;
	relPath: string;
	bundledHash: string;
	scope: string;
	hasHandlebars: boolean;
	expectedKeys: string[];
	keyTypes: Record<string, string>;
	runtimeOnly: string[];
	localHelpers: string[];
	consumerHints: string[];
}
interface Manifest {
	ompVersion: string;
	unpackedAt: string;
	assets: ManifestAsset[];
}
const MANIFEST = "OMP_PROMPT_MANIFEST.json";
const PLAIN_SLOTS = new Set(["SYSTEM.md", "APPEND_SYSTEM.md", "TITLE_SYSTEM.md", "PERSONALITY.md"]);
class PromptUsageError extends Error {
	readonly #messageKey: string;
	readonly #values: TranslationValues | undefined;
	readonly #detail: unknown;

	constructor(messageKey: string, values?: TranslationValues, detail?: unknown) {
		super(t("en", messageKey, usageValues(values, detail, false)));
		this.#messageKey = messageKey;
		this.#values = values;
		this.#detail = detail;
	}

	localizedMessage(): string {
		return t(this.#messageKey, usageValues(this.#values, this.#detail, true));
	}
}

function usageValues(
	values: TranslationValues | undefined,
	detail: unknown,
	localize: boolean,
): TranslationValues | undefined {
	if (detail === undefined) return values;
	const error =
		localize && detail instanceof PromptUsageError
			? detail.localizedMessage()
			: detail instanceof Error
				? detail.message
				: String(detail);
	return { ...values, error };
}

function flattenKeys(keys: readonly PromptContextKey[], prefix = ""): PromptContextKey[] {
	return keys.flatMap(key => {
		const qualified = prefix && !key.path.startsWith(`${prefix}.`) ? `${prefix}.${key.path}` : key.path;
		const childPrefix =
			/(?:\[\]$|^(?:Readonly)?Array<|^array\b)/.test(key.type) && !qualified.endsWith("[]")
				? `${qualified}[]`
				: qualified;
		return [{ ...key, path: qualified }, ...flattenKeys(key.children ?? [], childPrefix)];
	});
}
function matches(asset: PromptAsset, selector: string): boolean {
	return (
		asset.id === selector ||
		asset.relPath === selector ||
		new Bun.Glob(selector).match(asset.id) ||
		new Bun.Glob(selector).match(asset.relPath)
	);
}
function select(assets: readonly PromptAsset[], selectors: readonly string[]): PromptAsset[] {
	if (!selectors.length) return [...assets];
	const selected = new Set<PromptAsset>();
	for (const selector of selectors) {
		const found = assets.filter(asset => matches(asset, selector));
		if (!found.length) throw new PromptUsageError("cli.commands.prompts.unknownAsset", { selector });
		for (const asset of found) selected.add(asset);
	}
	return [...selected];
}
function assetPath(root: string, asset: PromptAsset): string {
	const target = path.resolve(root, asset.relPath);
	const relative = path.relative(root, target);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new PromptUsageError("cli.commands.prompts.unsafePath", { path: asset.relPath });
	}
	return target;
}
async function assertSafePath(target: string): Promise<void> {
	const absolute = path.resolve(target);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
		current = path.join(current, part);
		try {
			if ((await fs.promises.lstat(current)).isSymbolicLink()) {
				throw new PromptUsageError("cli.commands.prompts.symlinkPath", { path: current });
			}
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
	}
}
async function writeSafe(target: string, text: string, force: boolean): Promise<boolean> {
	await assertSafePath(target);
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(
			target,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_NOFOLLOW |
				(force ? fs.constants.O_TRUNC : fs.constants.O_EXCL),
			0o644,
		);
	} catch (error) {
		if (!force && error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
	try {
		await handle.writeFile(text, "utf8");
	} finally {
		await handle.close();
	}
	return true;
}
async function readManifest(root: string): Promise<Manifest | undefined> {
	try {
		const value: unknown = await Bun.file(path.join(root, MANIFEST)).json();
		if (!value || typeof value !== "object" || !("assets" in value) || !Array.isArray(value.assets)) {
			throw new PromptUsageError("cli.commands.prompts.manifestAssets");
		}
		const manifest = value as Manifest;
		if (
			!manifest.assets.every(asset => asset && typeof asset.id === "string" && typeof asset.bundledHash === "string")
		)
			throw new PromptUsageError("cli.commands.prompts.manifestInvalidAsset");
		return manifest;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new PromptUsageError("cli.commands.prompts.cannotRead", { path: path.join(root, MANIFEST) }, error);
	}
}
function manifestAsset(asset: PromptAsset, bundledHash: string): ManifestAsset {
	const keys = flattenKeys(asset.keys);
	return {
		id: asset.id,
		relPath: asset.relPath,
		bundledHash,
		scope: asset.scope,
		hasHandlebars: asset.bundled.includes("{{"),
		expectedKeys: keys.map(key => key.path),
		keyTypes: Object.fromEntries(keys.map(key => [key.path, key.type])),
		runtimeOnly: keys.filter(key => key.resolution === "runtime-only").map(key => key.path),
		localHelpers: asset.localHelpers ?? [],
		consumerHints: asset.consumerHints,
	};
}
function formatDiagnostic(diagnostic: PromptDiagnostic, text?: string): string {
	const source = text?.split("\n")[diagnostic.line - 1];
	const lines = [
		`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`,
	];
	if (diagnostic.expression)
		lines.push(`  ${t("cli.commands.prompts.diagnosticExpression", { expression: diagnostic.expression })}`);
	if (source !== undefined) {
		lines.push(
			`  ${diagnostic.line} | ${source}`,
			`    | ${" ".repeat(Math.max(0, diagnostic.column - 1))}${"^".repeat(Math.max(1, diagnostic.endLine === diagnostic.line ? diagnostic.endColumn - diagnostic.column : 1))}`,
		);
	}
	lines.push(`  ${t("cli.commands.prompts.diagnosticScope", { scope: diagnostic.scope })}`);
	if (diagnostic.expectedType)
		lines.push(`  ${t("cli.commands.prompts.diagnosticExpectedType", { type: diagnostic.expectedType })}`);
	if (diagnostic.candidates.length)
		lines.push(
			`  ${t("cli.commands.prompts.diagnosticCandidates", { candidates: diagnostic.candidates.join(", ") })}`,
		);
	if (diagnostic.hint) {
		const hintKey = "cli.commands.prompts.bundleDriftHint";
		const hint =
			diagnostic.code === "bundle-drift" && diagnostic.hint === t("en", hintKey) ? t(hintKey) : diagnostic.hint;
		lines.push(`  ${t("cli.commands.prompts.diagnosticHint", { hint })}`);
	}
	return lines.join("\n");
}
function agentBody(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, frontmatter => frontmatter.replace(/[^\r\n]/g, " "));
}
function isAgentPath(file: string): boolean {
	return /(?:^|[\\/])agents[\\/]/.test(file);
}

/** Standalone CLI with explicit sinks and roots so tests never alter the live profile. */
export async function runPromptsCommand(cmd: PromptsCommandArgs, options: PromptsCommandOptions = {}): Promise<number> {
	const out = options.stdout ?? (text => process.stdout.write(text));
	const err = options.stderr ?? (text => process.stderr.write(text));
	const emit = (value: unknown, plain: string): void =>
		out(`${cmd.flags.json ? JSON.stringify(value, null, 2) : plain}\n`);
	try {
		const assets = options.assets ?? promptAssets;
		const cwd = path.resolve(options.cwd ?? getProjectDir());
		const agentDir = path.resolve(options.agentDir ?? getAgentDir());
		const flags = cmd.flags;
		const targets = cmd.targets ?? [];
		if (!PROMPT_ACTIONS.includes(cmd.action as PromptsAction))
			throw new PromptUsageError("cli.commands.prompts.unknownAction", { action: cmd.action });
		if ([Boolean(flags.user), Boolean(flags.project), flags.dir !== undefined].filter(Boolean).length > 1)
			throw new PromptUsageError("cli.commands.prompts.exclusiveRoots");
		if (flags.dir !== undefined && !flags.dir.trim()) throw new PromptUsageError("cli.commands.prompts.emptyDir");
		if (flags.used && flags.unused) throw new PromptUsageError("cli.commands.prompts.exclusiveUsage");
		if (flags.all && (flags.used || flags.unused)) throw new PromptUsageError("cli.commands.prompts.exclusiveAll");
		const allowed: Record<string, readonly string[]> = {
			unpack: ["force", "only", "include"],
			list: [],
			show: ["vars"],
			diff: [],
			reset: ["all"],
			lexicon: ["helpers", "vars", "scope", "used", "unused", "all"],
			keys: [],
			check: ["scope", "strict", "strict-warnings", "runtime", "fixture", "installed", "agents"],
		};
		for (const [name, value] of Object.entries(flags)) {
			if (
				value !== undefined &&
				value !== false &&
				!["json", "user", "project", "dir", ...allowed[cmd.action]].includes(name)
			)
				throw new PromptUsageError("cli.commands.prompts.unsupportedFlag", { name, action: cmd.action });
		}
		if (["show", "keys"].includes(cmd.action) && targets.length !== 1)
			throw new PromptUsageError("cli.commands.prompts.requiresTarget", { action: cmd.action });
		if (["unpack", "lexicon"].includes(cmd.action) && targets.length)
			throw new PromptUsageError("cli.commands.prompts.noTargets", { action: cmd.action });
		if (cmd.action === "reset" && ((flags.all && targets.length) || (!flags.all && !targets.length)))
			throw new PromptUsageError("cli.commands.prompts.resetRequiresTarget");
		const projectRoot = path.join(cwd, ".omp", "builtin-prompts");
		const userRoot = path.join(agentDir, "builtin-prompts");
		const root = flags.dir ? path.resolve(cwd, flags.dir) : flags.project ? projectRoot : userRoot;
		const explicitRoot = flags.dir !== undefined || flags.user || flags.project;
		const roots = explicitRoot ? [root] : [projectRoot, userRoot];
		const inspect = (asset: PromptAsset) =>
			inspectPromptAsset(asset.id, asset.bundled, {
				cwd,
				agentDir,
				...(explicitRoot ? { root, source: flags.project ? ("project" as const) : ("user" as const) } : {}),
			});
		const metadata = async (asset: PromptAsset, inspectionRoot?: string) => {
			const resolved = inspectionRoot
				? inspectPromptAsset(asset.id, asset.bundled, {
						cwd,
						agentDir,
						root: inspectionRoot,
						source: inspectionRoot === projectRoot ? "project" : "user",
					})
				: inspect(asset);
			const manifestRoot = resolved.path ? path.resolve(resolved.path.slice(0, -asset.relPath.length)) : undefined;
			const manifest = manifestRoot ? await readManifest(manifestRoot) : undefined;
			const prior = manifest?.assets.find(entry => entry.id === asset.id);
			const drift =
				prior && prior.bundledHash !== resolved.bundledHash
					? resolved.hash === prior.bundledHash
						? "refresh-available"
						: "diverged"
					: "none";
			const hintKey =
				drift === "refresh-available"
					? "cli.commands.prompts.refreshAvailable"
					: drift === "diverged"
						? "cli.commands.prompts.diverged"
						: undefined;
			return {
				id: asset.id,
				relPath: asset.relPath,
				scope: asset.scope,
				inspectionOnly: asset.inspectionOnly ?? false,
				...resolved,
				manifestBundledHash: prior?.bundledHash,
				drift,
				hintKey,
			};
		};
		if (cmd.action === "unpack") {
			const include = flags.include ?? "core";
			if (!["core", "feature", "compaction", "dialects", "all"].includes(include))
				throw new PromptUsageError("cli.commands.prompts.invalidInclude", { include });
			const selected = select(
				assets.filter(asset => include === "all" || asset.group === include),
				flags.only ? [flags.only] : [],
			);
			const previous = await readManifest(root);
			const entries = new Map(previous?.assets.map(asset => [asset.id, asset]) ?? []);
			const written: string[] = [];
			const skipped: string[] = [];
			await assertSafePath(root);
			for (const asset of selected) {
				const file = assetPath(root, asset);
				if (await writeSafe(file, asset.bundled, flags.force ?? false)) {
					written.push(asset.relPath);
					entries.set(asset.id, manifestAsset(asset, inspect(asset).bundledHash));
				} else {
					skipped.push(asset.relPath);
					if (!entries.has(asset.id)) entries.set(asset.id, manifestAsset(asset, inspect(asset).bundledHash));
				}
			}
			const manifest: Manifest = {
				ompVersion: VERSION,
				unpackedAt: new Date().toISOString(),
				assets: [...entries.values()],
			};
			await writeSafe(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, true);
			emit(
				{ targetDir: root, total: selected.length, written, skipped, manifest },
				t("cli.commands.prompts.unpacked", { written: written.length, path: root, skipped: skipped.length }),
			);
			return 0;
		}
		if (cmd.action === "lexicon") {
			const fullLexicon = getPromptLexicon(assets);
			if (flags.scope && !fullLexicon.scopes.some(scope => scope.name === flags.scope))
				throw new PromptUsageError("cli.commands.prompts.unknownScope", { scope: flags.scope });
			const lexicon = flags.scope
				? getPromptLexicon(assets.filter(asset => asset.scope === flags.scope))
				: fullLexicon;
			const usage = flags.used ? "used" : flags.unused ? "unused" : undefined;
			const helpers =
				flags.vars && !flags.helpers ? [] : lexicon.helpers.filter(helper => !usage || helper.usage === usage);
			const scopes =
				flags.helpers && !flags.vars
					? []
					: lexicon.scopes
							.filter(scope => !flags.scope || scope.name === flags.scope)
							.map(scope => ({ ...scope, keys: scope.keys.filter(key => !usage || key.usage === usage) }));
			const result = { engineNotes: lexicon.engineNotes, helpers, scopes };
			const lines = [...result.engineNotes];
			for (const state of ["used", "unused"] as const) {
				const heading = t(
					state === "used" ? "cli.commands.prompts.lexiconUsed" : "cli.commands.prompts.lexiconUnused",
				);
				const found = helpers.filter(helper => helper.usage === state);
				if (found.length)
					lines.push(
						`\n${t("cli.commands.prompts.lexiconHelpers", { heading })}`,
						...found.map(helper => `  ${helper.name}`),
					);
				for (const scope of scopes) {
					const keys = scope.keys.filter(key => key.usage === state);
					if (keys.length)
						lines.push(
							`\n${t("cli.commands.prompts.lexiconVariables", { scope: scope.name, heading })}`,
							...keys.map(
								key =>
									`  ${key.path}: ${key.type} (${t(
										key.required ? "cli.commands.prompts.required" : "cli.commands.prompts.optional",
									)}, ${key.resolution ?? "static-fixture"})`,
							),
						);
				}
			}
			lines.push(`\n${t("cli.commands.prompts.plainSlots")}`);
			emit(result, lines.join("\n"));
			return 0;
		}
		if (cmd.action === "check") {
			const lexicon = getPromptLexicon(assets);
			if (flags.scope && !lexicon.scopes.some(scope => scope.name === flags.scope) && flags.scope !== "agent-body")
				throw new PromptUsageError("cli.commands.prompts.unknownScope", { scope: flags.scope });
			let fixture: Record<string, unknown> | undefined;
			if (flags.fixture !== undefined) {
				try {
					const trimmed = flags.fixture.trim();
					const parsed: unknown =
						trimmed.startsWith("{") || trimmed.startsWith("[")
							? JSON.parse(trimmed)
							: await Bun.file(path.resolve(cwd, flags.fixture)).json();
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
						throw new PromptUsageError("cli.commands.prompts.fixtureObject");
					fixture = parsed as Record<string, unknown>;
				} catch (error) {
					throw new PromptUsageError("cli.commands.prompts.invalidFixture", undefined, error);
				}
			}
			const checks = new Map<string, { asset: PromptAsset; text: string }>();
			const addFile = async (file: string, known?: PromptAsset): Promise<void> => {
				if (PLAIN_SLOTS.has(path.basename(file)))
					throw new PromptUsageError("cli.commands.prompts.notTemplate", { path: file });
				let text: string;
				try {
					text = await Bun.file(file).text();
				} catch (error) {
					throw new PromptUsageError("cli.commands.prompts.cannotRead", { path: file }, error);
				}
				const asset = known ?? assets.find(candidate => roots.some(base => assetPath(base, candidate) === file));
				if (!asset && !flags.scope && !flags.agents && !isAgentPath(file))
					throw new PromptUsageError("cli.commands.prompts.cannotInferScope", { path: file });
				const scope = flags.scope ?? asset?.scope ?? "agent-body";
				const peers = assets.filter(candidate => candidate.scope === scope);
				const contract =
					asset?.scope === scope
						? asset
						: {
								id: file,
								relPath: file,
								bundled: text,
								scope,
								group: "feature" as const,
								keys: lexicon.scopes.find(entry => entry.name === scope)?.keys ?? [],
								fixture: peers.reduce<Record<string, unknown>>(
									(fixture, peer) => Object.assign(fixture, peer.fixture),
									{},
								),
								localHelpers: [...new Set(peers.flatMap(peer => peer.localHelpers ?? []))],
								partials: Object.assign({}, ...peers.map(peer => peer.partials)),
								consumerHints: [],
							};
				checks.set(file, { asset: contract, text: scope === "agent-body" ? agentBody(text) : text });
			};
			const addInstalled = async (): Promise<void> => {
				for (const asset of assets)
					for (const base of roots) {
						const file = assetPath(base, asset);
						try {
							await fs.promises.stat(file);
						} catch (error) {
							if (isEnoent(error)) continue;
							throw error;
						}
						await addFile(file, asset);
					}
			};
			if (flags.installed || (!targets.length && !flags.agents)) await addInstalled();
			if (flags.agents) {
				const dirs = flags.dir
					? [root]
					: flags.project
						? [path.join(cwd, ".omp", "agents")]
						: flags.user
							? [path.join(agentDir, "agents")]
							: [path.join(cwd, ".omp", "agents"), path.join(agentDir, "agents")];
				for (const dir of dirs) {
					try {
						await fs.promises.stat(dir);
					} catch (error) {
						if (isEnoent(error)) continue;
						throw error;
					}
					for await (const file of new Bun.Glob("**/*.md").scan({
						cwd: dir,
						absolute: true,
						onlyFiles: true,
						throwErrorOnBrokenSymlink: false,
					}))
						await addFile(file);
				}
			}
			for (const target of targets) {
				const found = assets.filter(asset => matches(asset, target));
				if (found.length) {
					for (const asset of found) {
						const resolved = inspect(asset);
						if (resolved.path) await addFile(resolved.path, asset);
						else {
							const scope = flags.scope ?? asset.scope;
							const peers = assets.filter(candidate => candidate.scope === scope);
							const contract =
								scope === asset.scope
									? asset
									: {
											...asset,
											scope,
											keys: lexicon.scopes.find(entry => entry.name === scope)?.keys ?? [],
											fixture: peers.reduce<Record<string, unknown>>(
												(fixture, peer) => Object.assign(fixture, peer.fixture),
												{},
											),
											localHelpers: [...new Set(peers.flatMap(peer => peer.localHelpers ?? []))],
											partials: Object.assign({}, ...peers.map(peer => peer.partials)),
										};
							checks.set(asset.id, {
								asset: contract,
								text: scope === "agent-body" ? agentBody(resolved.text) : resolved.text,
							});
						}
					}
				} else if (/[*?{[]/.test(target)) {
					let count = 0;
					for await (const file of new Bun.Glob(target).scan({ cwd, absolute: true, onlyFiles: true })) {
						await addFile(file);
						count++;
					}
					if (!count) throw new PromptUsageError("cli.commands.prompts.noMatchingFiles", { target });
				} else await addFile(path.resolve(cwd, target));
			}
			const diagnostics: PromptDiagnostic[] = [];
			for (const [file, check] of checks) {
				try {
					const partials: Record<string, string> = {};
					for (const [name, id] of Object.entries(check.asset.partials ?? {})) {
						const partial = assets.find(asset => asset.id === id);
						if (partial) partials[name] = inspect(partial).text;
					}
					diagnostics.push(
						...(options.validate ?? validatePrompt)(check.asset, check.text, {
							file,
							fixture,
							partials,
							runtime: flags.runtime,
							strict: flags.strict,
							strictWarnings: flags["strict-warnings"],
						}),
					);
				} catch (error) {
					emit(
						{
							error: "internal-validator-error",
							file,
							message: error instanceof Error ? error.message : String(error),
							diagnostics,
						},
						t("cli.commands.prompts.validatorFailure", {
							path: file,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					return 3;
				}
			}
			for (const asset of assets)
				for (const base of roots) {
					const file = assetPath(base, asset);
					if (!checks.has(file)) continue;
					const status = await metadata(asset, base);
					if (status.drift !== "none")
						diagnostics.push({
							code: "bundle-drift",
							severity: "warning",
							file,
							line: 1,
							column: 1,
							endLine: 1,
							endColumn: 1,
							expression: "",
							scope: asset.scope,
							message: status.hintKey ? t("en", status.hintKey) : "Bundle drift",
							candidates: [],
							hint: t("en", "cli.commands.prompts.bundleDriftHint"),
						});
				}
			const failed = diagnostics.some(
				diagnostic =>
					diagnostic.severity === "error" || (flags["strict-warnings"] && diagnostic.severity === "warning"),
			);
			emit(
				{ checked: [...checks.keys()], diagnostics },
				diagnostics.length
					? diagnostics
							.map(diagnostic => formatDiagnostic(diagnostic, checks.get(diagnostic.file)?.text))
							.join("\n\n")
					: t("cli.commands.prompts.checked", { count: checks.size }),
			);
			return failed ? 1 : 0;
		}
		const selectors = targets.map(
			target =>
				assets.find(asset => roots.some(base => assetPath(base, asset) === path.resolve(cwd, target)))?.id ??
				target,
		);
		const selected = select(assets, selectors);
		if (["show", "keys"].includes(cmd.action) && selected.length !== 1)
			throw new PromptUsageError("cli.commands.prompts.requiresSingleAsset", { action: cmd.action });
		if (cmd.action === "reset") {
			const removed: string[] = [];
			for (const asset of selected) {
				const file = assetPath(root, asset);
				await assertSafePath(file);
				try {
					await fs.promises.unlink(file);
					removed.push(asset.relPath);
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
			const manifest = await readManifest(root);
			if (manifest) {
				const ids = new Set(selected.map(asset => asset.id));
				manifest.assets = manifest.assets.filter(asset => !ids.has(asset.id));
				await writeSafe(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, true);
			}
			emit({ targetDir: root, removed }, t("cli.commands.prompts.removed", { count: removed.length, path: root }));
			return 0;
		}
		if (cmd.action === "keys") {
			const result = getPromptAssetKeys(selected[0]);
			emit(result, JSON.stringify(result, null, 2));
			return 0;
		}
		if (cmd.action === "diff") {
			const diffs = selected.map(asset => {
				const resolved = inspect(asset);
				const hunks = structuredPatchHunks(asset.bundled, resolved.text, 3);
				return {
					id: asset.id,
					source: resolved.source,
					path: resolved.path,
					diff: hunks.length
						? [
								`--- bundled/${asset.relPath}`,
								`+++ ${resolved.path ?? asset.relPath}`,
								...hunks.flatMap(hunk => [
									`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
									...hunk.lines,
								]),
							].join("\n")
						: "",
				};
			});
			emit(
				diffs,
				diffs
					.filter(diff => diff.diff)
					.map(diff => diff.diff)
					.join("\n") || t("cli.commands.prompts.noDifferences"),
			);
			return 0;
		}
		if (cmd.action === "show") {
			const { hintKey, ...status } = await metadata(selected[0]);
			const result = {
				...status,
				hint: hintKey ? t("en", hintKey) : undefined,
				...(flags.vars ? { contract: getPromptAssetKeys(selected[0]) } : {}),
			};
			emit(
				result,
				[
					`# ${status.id} source=${status.source}${status.path ? ` path=${status.path}` : ""}`,
					`# hash=${status.hash} bundledHash=${status.bundledHash} drift=${status.drift}`,
					...(hintKey ? [`# ${t(hintKey)}`] : []),
					...(flags.vars ? [JSON.stringify(result.contract, null, 2)] : []),
					status.text,
				].join("\n"),
			);
			return 0;
		}
		const listed = await Promise.all(
			selected.map(async asset => {
				const { text: _text, hintKey, ...status } = await metadata(asset);
				return { status, hintKey };
			}),
		);
		emit(
			listed.map(({ status, hintKey }) => ({ ...status, hint: hintKey ? t("en", hintKey) : undefined })),
			listed
				.map(
					({ status, hintKey }) =>
						`${status.id}\tsource=${status.source}\t${status.path ?? "(bundled)"}\thash=${status.hash}\tbundledHash=${status.bundledHash}\tdrift=${status.drift}${status.inspectionOnly ? "\tinspection-only" : ""}${hintKey ? `\n  ${t(hintKey)}` : ""}`,
				)
				.join("\n"),
		);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (cmd.flags.json)
			out(
				`${JSON.stringify({ error: error instanceof PromptUsageError ? "usage" : "command-failure", message })}\n`,
			);
		else err(`prompts: ${error instanceof PromptUsageError ? error.localizedMessage() : message}\n`);
		return error instanceof PromptUsageError ? 2 : 3;
	}
}
