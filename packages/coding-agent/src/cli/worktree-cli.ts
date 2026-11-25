/** CLI presentation and explicit-path Git worktree creation. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { Settings } from "../config/settings";
import { cfgIsolationBackend, cfgWorktreeClone } from "../task/settings";
import { formatIsolationBackend, parseIsolationBackend } from "../task/worktree";
import type { ManagedWorktree } from "../worktree/backend";
import { managedWorktrees } from "../worktree/worktrees";

export interface AddWorktreeOptions {
	cwd?: string;
	path: string;
	commit?: string;
	branch?: string;
	forceBranch?: string;
	detach: boolean;
	quiet: boolean;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove all managed entries, including live Git and ovnfs worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}
export async function addWorktree(options: AddWorktreeOptions): Promise<void> {
	if (options.branch && options.forceBranch) {
		throw new Error("fatal: options '-b' and '-B' cannot be used together");
	}
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const repository = vcs.requireGit(cwd);
	const worktreePath = path.resolve(cwd, options.path);
	try {
		const stat = await fs.stat(worktreePath);
		const nonEmpty = !stat.isDirectory() || (await fs.readdir(worktreePath)).length > 0;
		if (nonEmpty) throw new Error(`fatal: '${options.path}' already exists`);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const settings = await Settings.init({ cwd });
	let ref: string;
	let detach = false;
	let createdBranch: string | undefined;
	if (options.branch || options.forceBranch) {
		const branch = options.branch ?? options.forceBranch;
		if (!branch) throw new Error(t("cli.commands.worktree.branchRequired"));
		await repository.createBranch(branch, options.commit ?? "HEAD", Boolean(options.forceBranch));
		ref = branch;
		createdBranch = branch;
	} else if (options.detach) {
		ref = options.commit ?? "HEAD";
		detach = true;
	} else if (options.commit) {
		ref = options.commit;
		detach = !(await repository.refExists(`refs/heads/${options.commit}`));
	} else {
		const branch = path.basename(worktreePath);
		if (!(await repository.refExists(`refs/heads/${branch}`))) {
			await repository.createBranch(branch, "HEAD", false);
			createdBranch = branch;
		}
		ref = branch;
	}

	const commit = await repository.commitDetails(ref);
	const shortSha = commit.sha.slice(0, 7);
	const subject = commit.message.split("\n", 1)[0];
	if (!options.quiet) {
		const preparation = createdBranch
			? `new branch '${createdBranch}'`
			: detach
				? `detached HEAD ${shortSha}`
				: `checking out '${ref}'`;
		console.log(`Preparing worktree (${preparation})`);
	}
	const result = await repository.worktreeAdd(worktreePath, ref, {
		detach,
		clone: cfgWorktreeClone.get(settings),
		backend: parseIsolationBackend(cfgIsolationBackend.get(settings)),
	});
	if (!options.quiet) {
		console.log(`HEAD is now at ${shortSha} ${subject}`);
		if (result.clonedWith != null) {
			console.log(
				t("cli.commands.worktree.cloned", {
					source: repository.info().repoRoot,
					backend: formatIsolationBackend(result.clonedWith),
				}),
			);
		}
	}
	if (result.cloneError) {
		console.error(chalk.dim(t("cli.commands.worktree.cloneFallback", { error: result.cloneError })));
	}
	const hook = await vcs.runPostCheckoutHook(worktreePath, commit.sha);
	process.stderr.write(hook.stdout);
	process.stderr.write(hook.stderr);
	if (hook.exitCode !== 0) process.exitCode = hook.exitCode;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await managedWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(t("cli.commands.worktree.none")));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason
			? chalk.yellow(t("cli.commands.worktree.orphaned"))
			: chalk.green(t("cli.commands.worktree.live").padEnd(8));
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(t("cli.commands.worktree.listSummary", { live, orphaned, total: entries.length })));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<{ removed: number; failed: number }> {
	const entries = await managedWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(
				chalk.dim(
					options.all ? t("cli.commands.worktree.noneToRemove") : t("cli.commands.worktree.noOrphansToRemove"),
				),
			);
		}
		return { removed: 0, failed: 0 };
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow(t("cli.commands.worktree.wouldRemove"))}  ${target.path}`);
			}
			console.log(
				chalk.dim(
					targets.length === 1
						? t("cli.commands.worktree.dryRunOne")
						: t("cli.commands.worktree.dryRunMany", { count: targets.length }),
				),
			);
		}
		return { removed: 0, failed: 0 };
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	for (const target of targets) {
		try {
			await target.remove();
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		return { removed: succeeded, failed };
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green(t("cli.commands.worktree.removed"))}  ${result.path}`);
		} else {
			console.log(`${chalk.red(t("cli.commands.worktree.failed"))}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	const failureNote = failed > 0 ? ` · ${chalk.red(t("cli.commands.worktree.failedCount", { count: failed }))}` : "";
	console.log(chalk.dim(t("cli.commands.worktree.clearSummary", { count: succeeded, failureNote })));
	return { removed: succeeded, failed };
}

function formatEntryDetail(entry: ManagedWorktree): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : t("cli.commands.worktree.unknownRepo");
		const branch = entry.branch ?? t("cli.commands.worktree.unknownBranch");
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "ovnfs") {
		parts.push(
			`ovnfs · ${entry.parentRepo ?? t("cli.commands.worktree.unknownSource")}${entry.branch ? ` · ${entry.branch}` : ""}`,
		);
	} else if (entry.kind === "task-isolation") {
		parts.push(t("cli.commands.worktree.taskSandbox"));
	} else if (entry.kind === "empty") {
		parts.push(t("cli.commands.worktree.legacyShell"));
	} else {
		parts.push(t("cli.commands.worktree.unrecognized"));
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" — ");
}
