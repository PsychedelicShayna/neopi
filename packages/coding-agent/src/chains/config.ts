/**
 * `CHAINS.toml` discovery, editing, and serialization for post-processing
 * chains. Chains live beside advisors' `WATCHDOG.toml`: the project root and the
 * user agent dir, found on the same search path. A project chain shadows a user
 * chain with the same name.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	parseSettingsToml,
	patchSettingsToml,
	readTomlConfig,
	stringifySettingsToml,
	type TomlConfigSource,
} from "@oh-my-pi/pi-utils/settings-toml";
import type { ChainConfig, ChainConfigScope, ChainStep, ChainsConfigDoc } from "@oh-my-pi/pi-tui/overlays/chain-types";
import { collectTomlConfigCandidates } from "../advisor/watchdog";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { writeFileAtomically } from "../utils/atomic-file";

export const CHAINS_FILE_NAME = "CHAINS.toml";

const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);
const chainRepairDocs = new WeakSet<ChainsConfigDoc>();

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function parseTools(value: unknown, where: string, warnings: string[]): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) {
		warnings.push(`${where}: tools must be a list — ignored`);
		return undefined;
	}
	const names = normalizeToolNames(value.filter((item): item is string => typeof item === "string"));
	const known = names.filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		warnings.push(`${where}: unknown tool "${name}" — dropped`);
		return false;
	});
	return known.length > 0 ? known : undefined;
}

function parseStep(raw: unknown, where: string, warnings: string[]): ChainStep | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${where}: expected a mapping — step dropped`);
		return undefined;
	}
	const entry = raw as Record<string, unknown>;
	const name = stringField(entry.name)?.trim();
	const prompt = stringField(entry.prompt);
	if (!name || !prompt) {
		warnings.push(`${where}: a step needs a name and a prompt — step dropped`);
		return undefined;
	}
	const step: ChainStep = { name, prompt };
	// Only an explicit `false` disables: steps written before the key existed stay enabled.
	if (entry.enabled === false) step.enabled = false;
	const model = stringField(entry.model)?.trim();
	if (model) step.model = model;
	const tools = parseTools(entry.tools, `${where} (${name})`, warnings);
	if (tools) step.tools = tools;
	if (entry.context === true) step.context = true;
	// Presence, not content: an explicitly empty override replaces the bundled prompt with none.
	if (typeof entry.systemPrompt === "string") step.systemPrompt = entry.systemPrompt;
	return step;
}

/** Validate one parsed `CHAINS.toml` mapping entry by entry, keeping every valid chain. */
function parseChainsDoc(doc: Record<string, unknown>, filePath: string): ChainsConfigDoc {
	const warnings: string[] = [];
	const chains: ChainConfig[] = [];
	const rawChains = doc.chains ?? [];
	if (!Array.isArray(rawChains)) {
		return { chains, warnings: [`${filePath}: chains must be a list — file skipped`] };
	}
	rawChains.forEach((raw, index) => {
		const where = `${filePath}: chains[${index}]`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			warnings.push(`${where}: expected a mapping — chain dropped`);
			return;
		}
		const entry = raw as Record<string, unknown>;
		const name = stringField(entry.name)?.trim();
		if (!name) {
			warnings.push(`${where}: a chain needs a name — chain dropped`);
			return;
		}
		const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
		const steps = rawSteps
			.map((step, stepIndex) => parseStep(step, `${where}.steps[${stepIndex}]`, warnings))
			.filter((step): step is ChainStep => step !== undefined);
		if (steps.length === 0) {
			warnings.push(`${where} (${name}): no valid steps — chain dropped`);
			return;
		}
		const chain: ChainConfig = { name, steps };
		const description = stringField(entry.description)?.trim();
		if (description) chain.description = description;
		chains.push(chain);
	});
	return warnings.length > 0 ? { chains, warnings } : { chains };
}

function parseChainsText(text: string, filePath: string): ChainsConfigDoc {
	let parsed: unknown;
	try {
		parsed = parseSettingsToml(text, filePath);
	} catch (err) {
		return { chains: [], warnings: [`${filePath}: failed to parse TOML (${String(err)})`] };
	}
	if (parsed === null || parsed === undefined) return { chains: [] };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { chains: [], warnings: [`${filePath}: expected a TOML table — file skipped`] };
	}
	return parseChainsDoc(parsed as Record<string, unknown>, filePath);
}

export interface DiscoveredChains {
	/** Merged roster, project chains shadowing user chains by name, in declaration order. */
	chains: ChainConfig[];
	warnings: string[];
}

/** Discover chains from every `CHAINS.toml` on the user + project search path. */
export async function discoverChains(cwd: string, agentDir?: string): Promise<DiscoveredChains> {
	const warnings: string[] = [];
	const items = await collectTomlConfigCandidates(cwd, agentDir, CHAINS_FILE_NAME, {
		onReadError: filePath => warnings.push(`${filePath}: failed to read or import configuration — file skipped`),
		onRejected: filePath => warnings.push(`${filePath}: configuration is not a readable regular file — file skipped`),
	});
	const chains = new Map<string, ChainConfig>();
	// Candidates arrive user first, then project, so later files shadow earlier ones.
	for (const item of items) {
		const doc = parseChainsText(item.content, item.path);
		for (const message of doc.warnings ?? []) {
			warnings.push(message);
			logger.warn("Chain config", { path: item.path, error: message });
		}
		for (const chain of doc.chains) chains.set(chain.name, chain);
	}
	return { chains: [...chains.values()], warnings };
}

/** `project` → `<projectDir>/CHAINS.toml`, `user` → `<agentDir>/CHAINS.toml`. */
export function chainsConfigFilePath(scope: ChainConfigScope, dirs: { projectDir: string; agentDir: string }): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, CHAINS_FILE_NAME);
}

/** Load one canonical TOML file for editing, importing legacy YAML once. */
export async function loadChainsConfigFile(filePath: string): Promise<ChainsConfigDoc> {
	try {
		const base = filePath.replace(/\.(?:toml|yml|yaml)$/, "");
		const loaded = await readTomlConfig(`${base}.toml`, { legacyPaths: [`${base}.yml`, `${base}.yaml`] });
		return loaded ? parseChainsDoc(loaded.data, loaded.filePath) : { chains: [] };
	} catch (err) {
		if (!isEnoent(err)) logger.warn("Chain config: failed to read for edit", { path: filePath });
		const doc: ChainsConfigDoc = { chains: [], warnings: [`${filePath}: failed to read or parse TOML`] };
		chainRepairDocs.add(doc);
		return doc;
	}
}

/** Serialize a doc with the shared TOML codec. */
export function serializeChainsConfig(doc: ChainsConfigDoc): string {
	return doc.chains.length === 0 ? "" : stringifySettingsToml({ chains: doc.chains });
}

/** Patch known editor fields while preserving comments and future fields. */
export async function saveChainsConfigFile(filePath: string, doc: ChainsConfigDoc): Promise<void> {
	filePath = filePath.replace(/\.(?:yml|yaml)$/, ".toml");
	const base = filePath.slice(0, -".toml".length);
	let loaded: TomlConfigSource | undefined;
	try {
		loaded = await readTomlConfig(filePath, { legacyPaths: [`${base}.yml`, `${base}.yaml`] });
	} catch (error) {
		if (!chainRepairDocs.has(doc)) throw error;
	}
	const data = loaded?.data ?? {};
	const existing = Array.isArray(data.chains) ? data.chains.filter(isRecord) : [];
	data.chains = doc.chains.map(chain => {
		const prior: Record<string, unknown> = existing.find(item => item.name === chain.name) ?? {};
		const priorSteps = Array.isArray(prior.steps) ? prior.steps.filter(isRecord) : [];
		const steps = chain.steps.map(step => {
			const previous = priorSteps.find(item => item.name === step.name) ?? {};
			const merged: Record<string, unknown> = { ...previous };
			for (const key of ["name", "enabled", "model", "context", "tools", "systemPrompt", "prompt"] as const) {
				if (step[key] === undefined) delete merged[key];
				else merged[key] = step[key];
			}
			return merged;
		});
		const merged: Record<string, unknown> = { ...prior, name: chain.name, steps };
		if (chain.description === undefined) delete merged.description;
		else merged.description = chain.description;
		return merged;
	});
	if (doc.chains.length === 0) delete data.chains;
	const source = loaded?.content ?? "";
	const content = patchSettingsToml(source, data);
	if (!content.trim()) {
		await fs.rm(filePath, { force: true });
	} else {
		const mode = await fs
			.stat(filePath)
			.then(stat => stat.mode & 0o7777)
			.catch(error => {
				if (!isEnoent(error)) throw error;
				return 0o600;
			});
		await writeFileAtomically(filePath, content, { mode });
	}
	chainRepairDocs.delete(doc);
}
