/**
 * Agents CLI command handlers.
 *
 * Handles `npi agents unpack` for writing bundled agent definitions to disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { serializeAgentDefinitionDocument } from "../task/agent-definition-document";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { loadBundledAgents } from "../task/agents";

export type AgentsAction = "unpack";

export interface AgentsCommandArgs {
	action: AgentsAction;
	flags: {
		force?: boolean;
		json?: boolean;
		dir?: string;
		user?: boolean;
		project?: boolean;
	};
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandArgs["flags"]): string {
	if (flags.dir && flags.dir.trim().length > 0) {
		return path.resolve(getProjectDir(), flags.dir.trim());
	}

	if (flags.user && flags.project) {
		throw new Error("Choose either --user or --project, not both.");
	}

	if (flags.project) {
		return path.resolve(getProjectDir(), ".omp", "agents");
	}

	return path.join(getAgentDir(), "agents");
}

async function unpackBundledAgents(flags: AgentsCommandArgs["flags"]): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	await fs.mkdir(targetDir, { recursive: true });

	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const written: string[] = [];
	const skipped: string[] = [];

	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.toml.md`);
		if (!flags.force) {
			let existing: string | undefined;
			for (const candidate of [filePath, path.join(targetDir, `${agent.name}.md`)]) {
				try {
					await fs.stat(candidate);
					existing = candidate;
					break;
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
			if (existing) {
				skipped.push(existing);
				continue;
			}
		}

		await Bun.write(filePath, serializeAgentDefinitionDocument(agent));
		written.push(filePath);
	}

	return {
		targetDir,
		total: bundledAgents.length,
		written,
		skipped,
	};
}

export async function runAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "unpack": {
			const result = await unpackBundledAgents(cmd.flags);
			if (cmd.flags.json) {
				writeStdout(JSON.stringify(result, null, 2));
				return;
			}

			writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
			writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
			writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
			if (result.skipped.length > 0) {
				writeStdout(
					chalk.yellow(
						`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`,
					),
				);
			}

			for (const filePath of result.written) {
				writeStdout(chalk.dim(`  + ${filePath}`));
			}
			for (const filePath of result.skipped) {
				writeStdout(chalk.dim(`  = ${filePath}`));
			}
			return;
		}
	}
}
