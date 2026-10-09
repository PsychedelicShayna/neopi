/**
 * Discovery to registration: every discovered mixture is resolved and
 * validated; one with errors (or refused by the capability gate) is logged
 * and never becomes a selectable model.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MixtureDefinition, MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { configCandidatePaths } from "../advisor/watchdog";
import { replaceFileAtomically } from "../utils/atomic-file";
import { discoverMixtures, MIXTURES_FILE_NAME, parseMixturesDoc } from "./config";
import { MixtureCatalog, type MixtureScope } from "./provider";
import { resolveMixture } from "./resolve";
import { serializeMixturesConfig } from "./toml";
import type { MixtureIssue, ResolvedMixture } from "./types";
import {
	prepareDocumentPresets,
	type PreparedDocumentPresets,
	type MixtureValidation,
	validateMixture,
	MAX_FILE_BYTES,
} from "./validate";

export interface MixtureRegistrationContext {
	cwd: string;
	agentDir?: string;
	registry: ModelRegistry;
	settings: Settings;
}

export function checkMixture(
	definition: MixtureDefinition,
	ctx: MixtureRegistrationContext,
	preparedPresets: PreparedDocumentPresets,
	names: readonly string[],
): MixtureValidation & { resolved: ResolvedMixture } {
	const resolved = resolveMixture(definition, {
		registry: ctx.registry,
		settings: ctx.settings,
		preparedPresets,
	});
	return { resolved, ...validateMixture(resolved, { settings: ctx.settings, names }) };
}

export interface MixtureDocValidation {
	/** Definitions that passed all registration checks. */
	resolved: ResolvedMixture[];
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
}

/** Validate the exact draft being saved; never replace a file with an unregisterable definition. */
export function validateMixturesConfigDoc(
	doc: MixturesConfigDoc,
	ctx: MixtureRegistrationContext,
): MixtureDocValidation {
	const prepared = prepareDocumentPresets(doc.envelopes, doc.roles);
	const names = doc.mixtures.map(mixture => mixture.name);
	const result: MixtureDocValidation = { resolved: [], errors: [], warnings: [] };
	if (names.length === 0 && prepared.sizeIssue) result.errors.push(prepared.sizeIssue);
	for (const [index, definition] of doc.mixtures.entries()) {
		const checked = checkMixture(definition, ctx, prepared, names);
		for (const issue of checked.errors) result.errors.push({ ...issue, path: `mixtures[${index}].${issue.path}` });
		for (const issue of checked.warnings)
			result.warnings.push({ ...issue, path: `mixtures[${index}].${issue.path}` });
		if (checked.errors.length === 0) result.resolved.push(checked.resolved);
	}
	return result;
}

/** Read the exact source bytes without following a file symlink; missing files have a null CAS hash. */
export async function readMixtureDefinitionFile(
	sourcePath: string,
): Promise<{ doc: MixturesConfigDoc; hash: string | null }> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		if (isEnoent(error)) return { doc: { mixtures: [] }, hash: null };
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
			throw new Error(`${sourcePath}: expected a regular MIXTURES.toml under ${MAX_FILE_BYTES} bytes`);
		const bytes = await handle.readFile();
		const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const doc = parseMixturesDoc(Bun.TOML.parse(bytes.toString("utf8")), sourcePath);
		if (doc.warnings?.length) throw new Error(`${sourcePath}: ${doc.warnings.join("; ")}`);
		return { doc, hash };
	} finally {
		await handle.close();
	}
}

/**
 * Validate and publish a source document as one locked compare-and-swap.
 * TUI callers save only; headless/deck callers can apply the new roster immediately.
 */
export async function saveMixtureDefinition(
	args: MixtureRegistrationContext & {
		sourcePath: string;
		doc: MixturesConfigDoc;
		baseHash: string | null;
		apply?: boolean;
	},
): Promise<{ hash: string | null; validation: MixtureDocValidation; registered: boolean }> {
	const { sourcePath, doc, baseHash, apply = false, ...ctx } = args;
	const resolvedPath = path.resolve(sourcePath);
	if (!configCandidatePaths(ctx.cwd, ctx.agentDir, [MIXTURES_FILE_NAME]).candidates.includes(resolvedPath))
		throw new Error(`${sourcePath} is not on this workspace's mixture config search path`);
	if (doc.warnings?.length) throw new Error(`${sourcePath}: ${doc.warnings.join("; ")}`);
	const validation = validateMixturesConfigDoc(doc, ctx);
	if (validation.errors.length > 0) {
		const issue = validation.errors[0]!;
		throw new Error(`${issue.path}: ${issue.message}`);
	}
	const content = serializeMixturesConfig(doc);
	if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES)
		throw new Error(`${sourcePath}: serialized mixture config exceeds ${MAX_FILE_BYTES} bytes`);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	const hash = await withFileLock(resolvedPath, async () => {
		const current = await readMixtureDefinitionFile(resolvedPath);
		if (current.hash !== baseHash) throw new Error(`${sourcePath} changed since it was loaded; reload before saving`);
		if (!content) {
			if (current.hash !== null) await fs.unlink(resolvedPath);
			return null;
		}
		const staged = `${resolvedPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			const handle = await fs.open(
				staged,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await handle.writeFile(content);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await replaceFileAtomically(staged, resolvedPath);
		} finally {
			await fs.rm(staged, { force: true });
		}
		return new Bun.CryptoHasher("sha256").update(content).digest("hex");
	});
	if (!apply) return { hash, validation, registered: false };
	const roster = await discoverRegistrableMixtures(ctx);
	const scope = MixtureCatalog.for(ctx.registry).scope(ctx.cwd, ctx.agentDir);
	scope.setRoster(roster);
	return {
		hash,
		validation,
		registered: validation.resolved.every(item => scope.find(item.definition.name)?.revision === item.revision),
	};
}

/** Discover, resolve, and validate; returns the mixtures that may be registered. */
export async function discoverRegistrableMixtures(ctx: MixtureRegistrationContext): Promise<ResolvedMixture[]> {
	const discovered = await discoverMixtures(ctx.cwd, ctx.agentDir);
	const names = discovered.mixtures.map(entry => entry.definition.name);
	const registrable: ResolvedMixture[] = [];
	for (const entry of discovered.mixtures) {
		const { resolved, errors, warnings } = checkMixture(entry.definition, ctx, entry.preparedPresets, names);
		const mixture = entry.definition.name;
		for (const issue of warnings) {
			logger.warn("Mixture definition warning", { mixture, file: entry.path, ...issue });
		}
		if (errors.length > 0) {
			for (const issue of errors) {
				logger.warn("Mixture refused at registration", { mixture, file: entry.path, ...issue });
			}
			continue;
		}
		registrable.push(resolved);
	}
	return registrable;
}

/**
 * Hold the workspace's scope of the registry's catalog for `owner`; the scope's first
 * holder discovers and registers that workspace's roster. If discovery, resolution,
 * validation, or registration throws, the hold is dropped before the error propagates,
 * so a failed retain leaves no owner behind.
 */
async function retainScope(
	owner: string,
	ctx: MixtureRegistrationContext,
	restoredRoster?: readonly ResolvedMixture[],
	restoredResolution?: readonly ResolvedMixture[],
): Promise<MixtureScope> {
	const scope = MixtureCatalog.for(ctx.registry).scope(ctx.cwd, ctx.agentDir);
	scope.retain(owner);
	try {
		await scope.initializeRoster(
			owner,
			() =>
				restoredResolution !== undefined
					? Promise.resolve(restoredResolution)
					: restoredRoster !== undefined
						? Promise.resolve(restoredRoster)
						: discoverRegistrableMixtures(ctx),
			restoredRoster,
		);
	} catch (error) {
		try {
			scope.release(owner);
		} catch (cleanupError) {
			logger.warn("Mixture scope cleanup failed after retain error", {
				scope: scope.key,
				cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
	return scope;
}

/**
 * A session's hold on the catalog scope of the workspace it runs in. The scope follows
 * the session's cwd: a relocation ({@link rebind}) retains the destination's scope and
 * releases the source's, so the session only ever runs its current workspace's mixtures.
 */
export class MixtureWorkspace {
	readonly #owner: string;
	/** `cwd` is the workspace currently held. */
	#ctx: MixtureRegistrationContext;
	#scope: MixtureScope;
	/** A failed rollback can leave this workspace without its source owner. */
	#held = true;
	#released = false;
	#sourceRoster: readonly ResolvedMixture[] | undefined;
	/** This owner's model-role resolution can differ from the scope's canonical roster. */
	#sourceResolution: readonly ResolvedMixture[] | undefined;
	#catalogListener?: () => void;

	private constructor(owner: string, ctx: MixtureRegistrationContext, scope: MixtureScope) {
		this.#owner = owner;
		this.#ctx = ctx;
		this.#scope = scope;
	}

	static async retain(owner: string, ctx: MixtureRegistrationContext): Promise<MixtureWorkspace> {
		return new MixtureWorkspace(owner, ctx, await retainScope(owner, ctx));
	}

	/** The scope of the workspace the session is in now. */
	get scope(): MixtureScope {
		return this.#scope;
	}

	/** Config search root retained by this session, including SDK-supplied agent directories. */
	get agentDir(): string | undefined {
		return this.#ctx.agentDir;
	}

	/** Keep the live session's selected model in sync with shared registry metadata. */
	observeCatalog(listener: () => void): void {
		this.#catalogListener = listener;
		if (this.#held) this.#scope.observe(this.#owner, listener);
	}
	/**
	 * Move the hold to `cwd`'s scope, discovering it under the current settings if no one
	 * holds it yet. Release the source first to avoid a false name.scope_conflict.
	 * On failure restore both the canonical roster and this owner's resolution
	 * without rediscovery under destination settings. Returns whether the scope changed.
	 */
	async rebind(cwd: string): Promise<boolean> {
		if (this.#released) throw new Error("Cannot rebind a released mixture workspace");
		const source = this.#ctx;
		const next = MixtureCatalog.for(source.registry).scope(cwd, source.agentDir);
		if (next.key === this.#scope.key) {
			if (!this.#held) {
				this.#scope = await retainScope(this.#owner, source, this.#sourceRoster, this.#sourceResolution);
				this.#held = true;
				if (this.#catalogListener) this.#scope.observe(this.#owner, this.#catalogListener);
				this.#sourceRoster = undefined;
				this.#sourceResolution = undefined;
			}
			return false;
		}
		// Keep both the canonical roster and this owner's resolution if the move
		// and immediate restoration fail; a retry must not rediscover under destination settings.
		this.#sourceRoster ??= this.#scope.roster();
		this.#sourceResolution ??= this.#scope.resolution(this.#owner) ?? this.#sourceRoster;
		try {
			// release may remove the owner and then throw while registering the remaining scopes.
			this.#held = false;
			this.#scope.release(this.#owner);
			const destination = await retainScope(this.#owner, { ...source, cwd });
			this.#scope = destination;
			this.#ctx = { ...source, cwd };
			this.#held = true;
			if (this.#catalogListener) destination.observe(this.#owner, this.#catalogListener);
			this.#sourceRoster = undefined;
			this.#sourceResolution = undefined;
		} catch (error) {
			try {
				this.#scope = await retainScope(this.#owner, source, this.#sourceRoster, this.#sourceResolution);
				this.#held = true;
				if (this.#catalogListener) this.#scope.observe(this.#owner, this.#catalogListener);
				this.#sourceRoster = undefined;
				this.#sourceResolution = undefined;
			} catch (restoreError) {
				logger.warn("Mixture source scope restoration failed after rebind error", {
					from: source.cwd,
					to: cwd,
					restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
				});
			}
			logger.warn("Mixture workspace rebind failed; attempted to keep the previous workspace", {
				from: source.cwd,
				to: cwd,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		return true;
	}

	/** Drop the hold; releasing twice is harmless and never restores a failed move. */
	release(): void {
		if (this.#released) return;
		this.#released = true;
		this.#sourceRoster = undefined;
		this.#sourceResolution = undefined;
		if (!this.#held) return;
		this.#held = false;
		this.#scope.release(this.#owner);
	}
}
