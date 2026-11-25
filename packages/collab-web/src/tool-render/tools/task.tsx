/** `task` — spawn subagents: batch shape, streamed progress, per-agent results. */
import type { ReactNode } from "react";
import { useTranslation } from "../../lib/i18n";
import { AgentLink, Badge, Note, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderHost, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

const MISSING_YIELD_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

/** One spawned unit of work, normalized across the batch (`tasks[]`) and flat arg shapes. */
interface TaskItemView {
	name: string | null;
	agent: string | null;
	/** Single-prompt instructions; null for a stepped spawn. */
	task: string | null;
	/** Ordered stages sent one prompt at a time (`task.steps`); empty for a `task` spawn. */
	steps: string[];
	isolated: boolean;
}

/** Read one item; args stream in token by token, so non-string steps (still partial) are skipped. */
function taskItem(entry: Record<string, unknown>): TaskItemView {
	return {
		name: str(entry.name),
		agent: str(entry.agent),
		task: str(entry.task),
		steps: Array.isArray(entry.steps) ? entry.steps.filter(step => typeof step === "string") : [],
		isolated: entry.isolated === true,
	};
}

function taskItems(args: Record<string, unknown>): TaskItemView[] {
	if (Array.isArray(args.tasks)) return args.tasks.filter(isRecord).map(taskItem);
	const flat = taskItem(args);
	return flat.name || flat.task || flat.steps.length > 0 ? [flat] : [];
}

/** First non-blank line of the work: the `task`, else the first step. */
function taskBrief(item: TaskItemView): string | null {
	const text = item.task ?? item.steps[0] ?? "";
	const line = text.split("\n").find(l => l.trim() !== "");
	return line ? normalizeWs(line) : null;
}

/** "Anna.Bob" nesting → "Anna>Bob" breadcrumb (mirrors the TUI's formatTaskId). */
function taskIdLabel(id: string): string {
	return id.includes(".") ? id.split(".").join(">") : id;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtCount(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Outcome of one agent, mirroring the TUI's aborted / merge-failed / done / failed split. */
function resultStatus(res: Record<string, unknown>): {
	label: "aborted" | "merge failed" | "done" | "failed";
	tone: "ok" | "err" | "warn";
} {
	if (res.aborted === true) return { label: "aborted", tone: "err" };
	if (num(res.exitCode) === 0) {
		return str(res.error) ? { label: "merge failed", tone: "warn" } : { label: "done", tone: "ok" };
	}
	return { label: "failed", tone: "err" };
}

const RESULT_LABELS = {
	aborted: ["guesttools.task.aborted", "aborted"],
	"merge failed": ["guesttools.task.merge_failed", "merge failed"],
	done: ["guesttools.task.done", "done"],
	failed: ["guesttools.status.failed", "failed"],
} as const;

function Summary({ args }: ToolRenderProps): ReactNode {
	const t = useTranslation();
	const tasks = taskItems(args);
	// One badge when every spawn runs the same agent; mixed batches badge each row in the body.
	const agents = new Set(tasks.map(t => t.agent));
	const agent = agents.size === 1 ? tasks[0].agent : null;
	const first = tasks.length > 0 ? tasks[0] : null;
	const label = first ? (first.name ?? taskBrief(first)) : null;
	return (
		<>
			{agent && <Badge tone="accent">{agent}</Badge>}
			{label && <span className="tv-muted">{truncate(label, 72)}</span>}
			{tasks.length > 1 && (
				<Badge>{t("guesttools.count.task.many", "{count} tasks", { count: tasks.length })}</Badge>
			)}
		</>
	);
}

/** Final snapshot for one agent: status row, output preview, error/abort notes. */
function AgentResult({ res, host }: { res: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const t = useTranslation();
	const { label, tone } = resultStatus(res);
	const [labelKey, englishLabel] = RESULT_LABELS[label];
	const id = str(res.id) ?? "agent";
	const description = str(res.description);
	const stats: string[] = [];
	const tokens = num(res.tokens);
	if (tokens) stats.push(`${fmtCount(tokens)} tok`);
	const requests = num(res.requests);
	if (requests) stats.push(t("guesttools.task.requests", "{count} req", { count: requests }));
	const durationMs = num(res.durationMs);
	if (durationMs != null) stats.push(fmtDuration(durationMs));
	const model = str(res.resolvedModel);
	if (model) stats.push(model);

	// The runtime prepends a one-line warning when a subagent never called
	// yield; lift it out of the output preview like the TUI does.
	let output = str(res.output) ?? "";
	let warning: string | null = null;
	const nl = output.indexOf("\n");
	const firstLine = (nl === -1 ? output : output.slice(0, nl)).trim();
	if (firstLine.startsWith(MISSING_YIELD_PREFIX)) {
		warning = firstLine;
		output = nl === -1 ? "" : output.slice(nl + 1).replace(/^\s*\n+/, "");
	}
	const error = str(res.error);
	const aborted = res.aborted === true;
	const abortReason = str(res.abortReason);
	const patchPath = str(res.patchPath);
	const branchName = str(res.branchName);
	return (
		<>
			<Row
				k={
					<AgentLink id={id} host={host}>
						{str(res.id) === null ? t("guesttools.task.agent_fallback", "agent") : taskIdLabel(id)}
					</AgentLink>
				}
			>
				<Badge tone={tone}>{t(labelKey, englishLabel)}</Badge>{" "}
				{res.truncated === true && <Badge tone="warn">{t("guesttools.status.truncated", "truncated")}</Badge>}{" "}
				{description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
				{stats.length > 0 && <span className="tv-faint">{stats.join(" · ")}</span>}
			</Row>
			{warning && <Note tone="warn">{warning}</Note>}
			{aborted && abortReason && <Note tone="err">{abortReason}</Note>}
			{output.trim() !== "" && <Output text={output} maxLines={6} error={tone === "err"} />}
			{error && !aborted && error !== abortReason && <Note tone={tone === "warn" ? "warn" : "err"}>{error}</Note>}
			{patchPath && (
				<div className="tv-faint">{t("guesttools.task.patch_path", "patch: {path}", { path: patchPath })}</div>
			)}
			{!patchPath && branchName && (
				<div className="tv-faint">{t("guesttools.task.branch_name", "branch: {name}", { name: branchName })}</div>
			)}
		</>
	);
}

/** Live (still-running) snapshot for one agent. */
function AgentProgressRow({ p, host }: { p: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const t = useTranslation();
	const reportedStatus = str(p.status);
	const status = reportedStatus ?? "running";
	const tone =
		status === "completed"
			? ("ok" as const)
			: status === "failed" || status === "aborted"
				? ("err" as const)
				: status === "running"
					? ("accent" as const)
					: undefined;
	const id = str(p.id) ?? "agent";
	const description = str(p.description);
	const intent = str(p.lastIntent) ?? str(p.currentTool);
	const bits: string[] = [];
	const toolCount = num(p.toolCount);
	if (toolCount) bits.push(t("guesttools.task.tools", "{count} tools", { count: toolCount }));
	const tokens = num(p.tokens);
	if (tokens) bits.push(`${fmtCount(tokens)} tok`);
	const durationMs = num(p.durationMs);
	if (durationMs) bits.push(fmtDuration(durationMs));
	return (
		<Row
			k={
				<AgentLink id={id} host={host}>
					{str(p.id) === null ? t("guesttools.task.agent_fallback", "agent") : taskIdLabel(id)}
				</AgentLink>
			}
		>
			<Badge tone={tone}>{reportedStatus ?? t("guesttools.card.running", "running")}</Badge>{" "}
			{description && <span>{truncate(normalizeWs(description), 96)}</span>}{" "}
			{intent && <span className="tv-muted">{truncate(normalizeWs(intent), 64)}</span>}{" "}
			{bits.length > 0 && <span className="tv-faint">{bits.join(" · ")}</span>}
		</Row>
	);
}

function Body({ args, result, host }: ToolRenderProps): ReactNode {
	const t = useTranslation();
	const context = str(args.context);
	const tasks = taskItems(args);
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	const showProgress = results.length === 0 && progress.length > 0;

	// Run footer: outcome counts + total wall time (mirrors the TUI's bracket line).
	let footer: ReactNode = null;
	if (results.length > 0) {
		let ok = 0;
		let mergeFailed = 0;
		let aborted = 0;
		let failed = 0;
		for (const res of results) {
			const { label } = resultStatus(res);
			if (label === "done") ok++;
			else if (label === "merge failed") mergeFailed++;
			else if (label === "aborted") aborted++;
			else failed++;
		}
		const total = details ? num(details.totalDurationMs) : null;
		footer = (
			<Row>
				{ok > 0 && (
					<Badge tone="ok">
						{ok === 1
							? t("guesttools.task.total_succeeded.one", "{count} succeeded", { count: ok })
							: t("guesttools.task.total_succeeded.many", "{count} succeeded", { count: ok })}
					</Badge>
				)}{" "}
				{mergeFailed > 0 && (
					<Badge tone="warn">
						{mergeFailed === 1
							? t("guesttools.task.total_merge_failed.one", "{count} merge failed", { count: mergeFailed })
							: t("guesttools.task.total_merge_failed.many", "{count} merge failed", { count: mergeFailed })}
					</Badge>
				)}{" "}
				{failed > 0 && (
					<Badge tone="err">
						{failed === 1
							? t("guesttools.task.total_failed.one", "{count} failed", { count: failed })
							: t("guesttools.task.total_failed.many", "{count} failed", { count: failed })}
					</Badge>
				)}{" "}
				{aborted > 0 && (
					<Badge tone="err">
						{aborted === 1
							? t("guesttools.task.total_aborted.one", "{count} aborted", { count: aborted })
							: t("guesttools.task.total_aborted.many", "{count} aborted", { count: aborted })}
					</Badge>
				)}{" "}
				{total != null && <span className="tv-faint">{fmtDuration(total)}</span>}
			</Row>
		);
	}

	// Finished agents first, by runtime ascending — same order as the TUI.
	const ordered = [...results].sort(
		(a, b) => (num(a.durationMs) ?? 0) - (num(b.durationMs) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0),
	);

	return (
		<>
			{context && <Output text={context} maxLines={4} title={t("guesttools.label.context", "context")} />}
			{tasks.length > 0 && (
				<div className="tv-list">
					{tasks.map((task, i) => (
						<div key={task.name ?? i}>
							<Row
								k={
									task.name ? (
										<AgentLink id={task.name} host={host}>
											{taskIdLabel(task.name)}
										</AgentLink>
									) : (
										<Badge tone="accent">{`#${i + 1}`}</Badge>
									)
								}
							>
								{task.agent && <Badge>{task.agent}</Badge>}{" "}
								{task.steps.length > 0 && (
									<Badge>
										{task.steps.length === 1
											? t("guesttools.count.step.one", "{count} step", { count: task.steps.length })
											: t("guesttools.count.step.many", "{count} steps", { count: task.steps.length })}
									</Badge>
								)}{" "}
								{task.isolated && <Badge>{t("guesttools.task.isolated", "isolated")}</Badge>}
							</Row>
							{task.task && <Output text={task.task} maxLines={6} title={t("guesttools.label.task", "task")} />}
							{task.steps.map((step, n) => (
								<Output
									key={n}
									text={step}
									maxLines={4}
									title={t("guesttools.task.step_position", "step {index}/{total}", {
										index: n + 1,
										total: task.steps.length,
									})}
								/>
							))}
						</div>
					))}
				</div>
			)}
			{ordered.length > 0 && (
				<div className="tv-list">
					{ordered.map((res, i) => (
						<AgentResult key={str(res.id) ?? i} res={res} host={host} />
					))}
					{footer}
				</div>
			)}
			{showProgress && (
				<div className="tv-list">
					{progress.map((p, i) => (
						<AgentProgressRow key={str(p.id) ?? i} p={p} host={host} />
					))}
				</div>
			)}
			{ordered.length === 0 && !showProgress && <ResultText result={result} maxLines={12} />}
		</>
	);
}

export const taskRenderer: ToolRenderer = { Summary, Body };
