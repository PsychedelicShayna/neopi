/**
 * `CHAINS.yml` discovery, editing, and serialization for post-processing
 * chains. Chains live beside advisors' `WATCHDOG.yml`: the project root and the
 * user agent dir, found on the same search path. A project chain shadows a user
 * chain with the same name.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { ChainConfig, ChainConfigScope, ChainStep, ChainsConfigDoc } from "@oh-my-pi/pi-tui/overlays/chain-types";
import { appendYamlString } from "../advisor/config";
import { collectConfigCandidates } from "../advisor/watchdog";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";

export const CHAINS_FILE_NAME = "CHAINS.yml";

const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

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
	const model = stringField(entry.model)?.trim();
	if (model) step.model = model;
	const tools = parseTools(entry.tools, `${where} (${name})`, warnings);
	if (tools) step.tools = tools;
	return step;
}

/** Validate one parsed `CHAINS.yml` mapping entry by entry, keeping every valid chain. */
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
		parsed = YAML.parse(text);
	} catch (err) {
		return { chains: [], warnings: [`${filePath}: failed to parse YAML (${String(err)})`] };
	}
	if (parsed === null || parsed === undefined) return { chains: [] };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return { chains: [], warnings: [`${filePath}: expected a YAML mapping — file skipped`] };
	}
	return parseChainsDoc(parsed as Record<string, unknown>, filePath);
}

export interface DiscoveredChains {
	/** Merged roster, project chains shadowing user chains by name, in declaration order. */
	chains: ChainConfig[];
	warnings: string[];
}

/** Discover chains from every `CHAINS.yml` on the user + project search path. */
export async function discoverChains(cwd: string, agentDir?: string): Promise<DiscoveredChains> {
	const items = await collectConfigCandidates(cwd, agentDir, [CHAINS_FILE_NAME]);
	const chains = new Map<string, ChainConfig>();
	const warnings: string[] = [];
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

/** `project` → `<projectDir>/CHAINS.yml`, `user` → `<agentDir>/CHAINS.yml`. */
export function chainsConfigFilePath(scope: ChainConfigScope, dirs: { projectDir: string; agentDir: string }): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, CHAINS_FILE_NAME);
}

/** Load one `CHAINS.yml` for editing, raw and un-merged. A missing file is an empty doc. */
export async function loadChainsConfigFile(filePath: string): Promise<ChainsConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) logger.warn("Chain config: failed to read for edit", { path: filePath, error: String(err) });
		return { chains: [] };
	}
	return parseChainsText(text, filePath);
}

/** Serialize a doc to canonical, hand-editable `CHAINS.yml`; `""` for an empty doc. */
export function serializeChainsConfig(doc: ChainsConfigDoc): string {
	if (doc.chains.length === 0) return "";
	const lines = ["chains:"];
	for (const chain of doc.chains) {
		lines.push(`  - name: ${YAML.stringify(chain.name)}`);
		if (chain.description?.trim()) appendYamlString(lines, "    ", "description", chain.description);
		lines.push("    steps:");
		for (const step of chain.steps) {
			lines.push(`      - name: ${YAML.stringify(step.name)}`);
			if (step.model?.trim()) lines.push(`        model: ${YAML.stringify(step.model)}`);
			if (step.tools && step.tools.length > 0) {
				lines.push("        tools:");
				for (const tool of step.tools) lines.push(`          - ${YAML.stringify(tool)}`);
			}
			appendYamlString(lines, "        ", "prompt", step.prompt);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Write a doc to `CHAINS.yml`; an empty doc removes the file. */
export async function saveChainsConfigFile(filePath: string, doc: ChainsConfigDoc): Promise<void> {
	const content = serializeChainsConfig(doc);
	if (!content) {
		await fs.rm(filePath, { force: true });
		return;
	}
	await Bun.write(filePath, content);
}
