/**
 * The async background jobs of a session as {@link JobsSheet}: the dismissable
 * sheet the native jobs pill and `/jobs` open. A master–detail split lists
 * every job (running first) beside the selected one's status, command, facts
 * (cwd, live pids, exit code, artifact) and live output.
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Component } from "../tui";
import { matchesKey } from "../keys";
import { replaceTabs, truncateToWidth } from "../utils";
import { collapseCommand } from "../apps/ps-data";
import { compileMenuRegex } from "../menu-search";
import { ansi, code, col, compact, item, node, row, span, stableKey, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import {
	applyMenuMotion,
	MenuKeyReader,
	MenuSearchField,
	MenuViewport,
	menuScrollBy,
	type MenuViewportPosition,
} from "../components/menu-navigation";
import { MenuSelection } from "../components/menu-selection";
import { ScrollView } from "../components/scroll-view";
import { Text } from "../components/text";
import { fuzzyFilter } from "../fuzzy";

/** One async job as the session snapshots it. */
export interface JobsPanelJob {
	readonly id: string;
	readonly type: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly label: string;
	readonly startTime: number;
	readonly endTime?: number;
	/** Registry id of the subagent a task job runs. */
	readonly agentId?: string;
}

/** Running and recently settled jobs. */
export interface JobsPanelSnapshot {
	readonly running: readonly JobsPanelJob[];
	readonly recent: readonly JobsPanelJob[];
}

/** What the sheet shows about the selected job beyond its row. */
export interface JobsPanelDetail {
	/** Full command line of a job that runs a process (rows show the cut label). */
	readonly command?: string;
	readonly cwd?: string;
	/** Live pids the job's command spawned. */
	readonly pids: readonly number[];
	readonly exitCode?: number;
	/** Output tail while running; the final text once settled. */
	readonly output?: string;
	/** Artifact holding the full output when `output` is cut. */
	readonly artifactId?: string;
}

/** The session behind a {@link JobsSheet}. */
export interface JobsSheetSource {
	/** Current jobs; runs once per frame. */
	load(): JobsPanelSnapshot;
	/** The selected job's detail; runs once per frame, undefined once the job is gone. */
	inspect(id: string): JobsPanelDetail | undefined;
	/** Cancel a running job. */
	cancel(id: string): void;
	/** Dismiss the sheet. */
	close(): void;
}

/** A job's status as the sheet names it. */
const STATUS_LABEL: Record<JobsPanelJob["status"], string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

/** A job's status color: the list row's icon and the detail's status pill. */
const STATUS_TONE: Record<JobsPanelJob["status"], TspTone> = {
	running: "pending",
	completed: "success",
	failed: "error",
	cancelled: "muted",
};

/** The status pill's lead glyph; a running job's pulses. */
const STATUS_GLYPH: Record<JobsPanelJob["status"], TspSpan> = {
	running: { t: "●", fx: "pulse" },
	completed: { t: "✓" },
	failed: { t: "✕" },
	cancelled: { t: "⊘" },
};

/** The list row's icon per job type (Tern icon names); other types read as a generic job. */
const TYPE_ICON: Record<string, string> = { bash: "bash", task: "agent" };

/** The terminal fallback initially retains the existing eight-row output tail. */
const OUTPUT_ROWS = 8;

/**
 * The jobs pill's sheet: a centred `lg` glass sheet titled Background jobs.
 * A master–detail split (it stacks in a narrow pane): the selectable job list,
 * grouped Running / Recent, beside the selected job's detail — a status pill
 * with live elapsed and Cancel job, its command or task, facts (agent, cwd,
 * live pids, exit code, artifact) and a tail-following output pane. With no
 * jobs it shows an empty state. It re-reads the session every frame, so the
 * caller re-renders it on a timer while it is open. ↑/↓ select, X cancels the
 * selected running job, Esc or Close dismisses; nothing enters the transcript.
 */
export class JobsSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.jobs",
		size: "lg",
		anchor: "center",
		head: "Background jobs",
	} as const;
	readonly #source: JobsSheetSource;
	readonly #keys = new MenuKeyReader();
	readonly #search = new MenuSearchField();
	readonly #selection = new MenuSelection<JobsPanelJob>([], {
		getKey: job => job.id,
		getSearchText: job => `${job.label} ${job.id} ${job.type} ${job.status}`,
	});
	readonly #viewport = new MenuViewport();
	readonly #output = new Text("", 0, 0);
	readonly #outputView = new ScrollView(this.#output, { height: OUTPUT_ROWS, followTail: true, anchor: "end" });
	#selectedId: string | undefined;
	#focus: "list" | "output" = "list";
	#rowCounts: number[] = [];
	#outputSource: { id: string; output: string } | undefined;
	#nativeListScroll: NativeScroll | undefined;
	#nativeOutputScroll: NativeScroll | undefined;

	constructor(source: JobsSheetSource) {
		this.#source = source;
	}

	navigationSnapshot(): unknown {
		this.#current();
		return {
			selectedId: this.#selectedId,
			focus: this.#focus,
			search: this.#search.navigationSnapshot(),
			viewportTop: this.#viewport.top,
			output: this.#outputView.navigationSnapshot(),
		};
	}

	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object") return;
		const state = snapshot as {
			selectedId?: string;
			focus?: "list" | "output";
			search?: unknown;
			viewportTop?: MenuViewportPosition | number;
			output?: unknown;
		};
		this.#search.restoreNavigation(state.search);
		this.#selectedId = typeof state.selectedId === "string" ? state.selectedId : undefined;
		this.#current();
		this.#focus = state.focus === "output" ? "output" : "list";
		this.#viewport.setTop(state.viewportTop);
		this.#outputView.restoreNavigation(state.output);
		this.#keys.reset();
		this.#nativeListScroll = undefined;
		this.#nativeOutputScroll = undefined;
		this.#outputSource = undefined;
	}

	describe(cx: DescribeContext): NativeNode {
		const { jobs, selected } = this.#current();
		const detail = selected && this.#source.inspect(selected.id);
		const now = Date.now();
		const close = actionButton("Close", "close", { keys: "escape" });
		const queryError = compileMenuRegex(this.#search.value)?.error;
		return col([
			this.#search.input.describe(cx),
			...(queryError ? [text([span(queryError, "error")])] : []),
			...(selected
				? [
						node(
							"row",
							{ role: "omp.jobs.split" },
							[
								node(
									"col",
									{ role: "omp.jobs.master" },
									[{ ...describeJobList(jobs, selected, now), scroll: this.#nativeListScroll }],
									"master",
								),
								describeDetail(selected, detail, now, this.#nativeOutputScroll),
							],
							"split",
						),
						actionBar([describeSummary(jobs), null, close]),
					]
				: [describeEmpty(), actionBar([null, close])]),
		]);
	}

	render(width: number): readonly string[] {
		const { jobs, selected } = this.#current();
		const now = Date.now();
		const running = jobs.filter(job => job.status === "running").length;
		const lines = [
			truncateToWidth(` Background jobs · ${running} running`, width),
			this.#search.render(width, { muted: text => text }),
		];
		const window = this.#viewport.layout(this.#rowCounts, this.#selection.selectedIndex, this.#listRows());
		if (jobs.length === 0) lines.push(this.#search.value ? " No matching jobs" : " No background jobs");
		for (let index = window.startIndex; index < window.endIndex; index++) {
			const job = jobs[index]!;
			const cursor = job === selected ? ">" : " ";
			lines.push(
				truncateToWidth(
					`${cursor} ${job.status}  ${job.type} ${formatDuration(jobAge(job, now))}  ${collapseCommand(job.label)}`,
					width,
				),
			);
		}
		const detail = selected && this.#source.inspect(selected.id);
		if (selected && detail) {
			const facts = compact([
				detail.cwd && `cwd ${detail.cwd}`,
				detail.pids.length > 0 && `pid ${detail.pids.join(", ")}`,
				detail.exitCode !== undefined && `exit ${detail.exitCode}`,
				detail.artifactId && `artifact://${detail.artifactId}`,
			]);
			if (facts.length > 0) lines.push(truncateToWidth(`   ${facts.join(" · ")}`, width));
			const output = detail.output ?? "";
			if (this.#outputSource?.id !== selected.id || this.#outputSource.output !== output) {
				if (this.#outputSource && this.#outputSource.id !== selected.id) this.#outputView.setFollowTail(true);
				this.#outputSource = { id: selected.id, output };
				this.#output.setText(replaceTabs(output));
			}
			lines.push(...this.#outputView.render(Math.max(1, width - 3)).map(line => `   ${line}`));
		}
		lines.push(
			truncateToWidth(
				`j/k rows · h/l or Tab list/output · Ctrl-u/d half · PgUp/PgDn page · gg/G bounds · Ctrl-e/y scroll · Enter/Space details · / search · x cancel · Esc close`,
				width,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.#outputView.invalidate();
	}

	dispose(): void {
		this.#outputView.dispose();
	}

	handleInput(data: string): void {
		const before = this.#search.value;
		if (this.#search.handleInput(data) !== "pass") {
			if (this.#search.value !== before) this.#viewport.reveal();
			this.#keys.reset();
			return;
		}
		this.#current();
		if (this.#viewport.top === undefined)
			this.#viewport.layout(this.#rowCounts, this.#selection.selectedIndex, this.#listRows());
		const action = this.#keys.read(data);
		if (!action || action === "pending") {
			if (matchesKey(data, "x")) this.#cancelSelected();
			return;
		}
		if (action.kind === "cancel") return this.#source.close();
		if (action.kind === "search") {
			this.#focus = "list";
			this.#search.focused = true;
			return;
		}
		if (action.kind === "context" || action.kind === "horizontal") {
			this.#search.focused = false;
			this.#focus =
				action.kind === "horizontal"
					? action.delta < 0
						? "list"
						: "output"
					: this.#focus === "list"
						? "output"
						: "list";
			return;
		}
		if (action.kind === "confirm" || action.kind === "toggle") {
			this.#search.focused = false;
			this.#focus = "output";
			return;
		}
		if (this.#focus === "output") {
			const by = menuScrollBy(action);
			if (by) this.#nativeOutputScroll = { by, n: (this.#nativeOutputScroll?.n ?? 0) + 1 };
			if (this.#outputView.handleMenuAction(action)) {
				this.#outputView.setFollowTail(action.kind === "boundary" && action.edge === "last");
			}
		} else {
			const motion = applyMenuMotion(action, this.#selection, this.#viewport);
			if (action.kind === "scroll") {
				const by = menuScrollBy(action);
				if (by) this.#nativeListScroll = { by, n: (this.#nativeListScroll?.n ?? 0) + 1 };
			}
			if (motion.selectionChanged) this.#selectedId = this.#selection.selectedKey;
		}
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") {
			this.#search.focused = false;
			this.#keys.reset();
			this.#selectedId = event.item;
			this.#focus = event.type === "activate" ? "output" : "list";
			this.#viewport.reveal();
		} else if (event.type === "action" && event.act === "close") {
			if (this.#search.focused || this.#search.value) this.handleInput("\x1b");
			else this.#source.close();
		} else if (event.type === "action" && event.act === "cancel") this.#cancelSelected();
	}

	#listRows(): number {
		return Math.max(1, Math.min(12, Math.floor(((process.stdout.rows || 24) - 6) / 2)));
	}

	#current(): { jobs: readonly JobsPanelJob[]; selected: JobsPanelJob | undefined } {
		const { running, recent } = this.#source.load();
		const all = [...running, ...recent];
		const jobs = this.#search.value.trim()
			? fuzzyFilter(all, this.#search.value, job => `${job.label} ${job.id} ${job.type} ${job.status}`)
			: all;
		this.#selection.setItems(jobs, this.#selectedId);
		const selected = this.#selection.selectedItem;
		this.#selectedId = selected?.id;
		if (this.#rowCounts.length !== jobs.length) this.#rowCounts = jobs.map(() => 1);
		return { jobs, selected };
	}

	#cancelSelected(): void {
		const { selected } = this.#current();
		if (selected?.status === "running") this.#source.cancel(selected.id);
	}
}

/** How long a job ran, or has been running. */
function jobAge(job: JobsPanelJob, nowMs: number): number {
	return Math.max(0, (job.endTime ?? nowMs) - job.startTime);
}

/**
 * The master list: Running, then Recent, each under a quiet group label (a
 * plain text child: no row behavior, so ↑/↓ and clicks pass it by).
 */
function describeJobList(jobs: readonly JobsPanelJob[], selected: JobsPanelJob, nowMs: number): NativeNode {
	const rows: NativeChild[] = [];
	for (const [label, group] of [
		["Running", jobs.filter(job => job.status === "running")],
		["Recent", jobs.filter(job => job.status !== "running")],
	] as const) {
		if (group.length === 0) continue;
		rows.push(node("text", { role: "omp.jobs.group", text: label, wrap: "none" }, undefined, `group-${label}`));
		for (const job of group) rows.push(describeJobItem(job, nowMs));
	}
	return selectList("jobs", rows, { selected: selected.id, max: { lines: 12 } });
}

/**
 * One list row: the type icon tinted by status, the one-line label (a process
 * job's command in mono, a task's work in prose) and how long it ran.
 */
function describeJobItem(job: JobsPanelJob, nowMs: number): NativeNode {
	const status = STATUS_LABEL[job.status];
	const age = formatDuration(jobAge(job, nowMs));
	return item(job.id, {
		label: [job.type === "task" ? span(job.label) : span(collapseCommand(job.label), "mono")],
		value: [span(age, "mono")],
		icon: TYPE_ICON[job.type] ?? "job",
		tone: STATUS_TONE[job.status],
		title: `${job.label}\n${status} · ${job.type} · ${job.id}`,
		aria: `${job.label}, ${status.toLowerCase()}, ${age}`,
	});
}

/** The footer's at-a-glance count. */
function describeSummary(jobs: readonly JobsPanelJob[]): NativeNode {
	const running = jobs.filter(job => job.status === "running").length;
	const parts = compact([
		running > 0 && `${running} running`,
		jobs.length > running && `${jobs.length - running} recent`,
	]);
	return node("text", { role: "omp.jobs.summary", text: parts.join(" · "), wrap: "none" }, undefined, "summary");
}

/** No jobs: what the sheet is for, in place of the split. */
function describeEmpty(): NativeNode {
	return node(
		"col",
		{ role: "omp.jobs.empty", align: "center" },
		[
			node("icon", { name: "jobs" }),
			text("No background jobs", { role: "omp.jobs.empty.title" }),
			text("Commands and subagent tasks started in the background show up here while they run.", {
				role: "omp.jobs.empty.note",
				wrap: "word",
			}),
		],
		"empty",
	);
}

/**
 * The selected job: a status line (pill, live elapsed, type · id, Cancel job),
 * its task or full command, facts and the output pane (or its empty state).
 */
function describeDetail(
	job: JobsPanelJob,
	detail: JobsPanelDetail | undefined,
	nowMs: number,
	scroll?: NativeScroll,
): NativeNode {
	const settled = job.status !== "running";
	const exit = detail?.exitCode;
	const age = Math.round(jobAge(job, nowMs));
	const command = detail?.command ?? (job.type === "task" ? undefined : job.label);
	const pids = detail?.pids ?? [];
	const facts = compact([
		job.agentId ? { k: "Agent", v: [span(job.agentId, "mono")] } : undefined,
		detail?.cwd ? { k: "Directory", v: [span(detail.cwd, "path")] } : undefined,
		pids.length > 0 && { k: pids.length > 1 ? "PIDs" : "PID", v: [span(pids.join(", "), "num")] },
		exit !== undefined && { k: "Exit code", v: [span(String(exit), exit === 0 ? "success" : "error")] },
		detail?.artifactId ? { k: "Full output", v: [span(`artifact://${detail.artifactId}`, "mono")] } : undefined,
	]);
	const children = compact<NativeChild>([
		row(
			compact<NativeChild>([
				text([STATUS_GLYPH[job.status], span(` ${STATUS_LABEL[job.status]}`)], {
					role: "omp.jobs.state",
					tone: STATUS_TONE[job.status],
					wrap: "none",
				}),
				node("elapsed", {
					age,
					...(settled ? { stopped: age } : {}),
					format: "short",
					role: "omp.jobs.age",
					title: settled ? "Ran for" : "Running for",
				}),
				text([span(`${job.type} · ${job.id}`, "mono")], { role: "omp.jobs.id", wrap: "none", truncate: "end" }),
				node("spacer", { grow: 1 }),
				!settled && actionButton("Cancel job", "cancel", { keys: "x", tone: "error" }),
			]),
			{ role: "omp.jobs.status", gap: "sm", align: "center" },
		),
		command
			? code(command, { lang: "bash", wrap: true, preview: { lines: 4 }, role: "omp.jobs.command" })
			: text(job.label, { role: "omp.jobs.title", wrap: "word" }),
		facts.length > 0 && node("kv", { items: facts, role: "omp.jobs.facts" }),
		node(
			"col",
			{ role: "omp.jobs.out", gap: "sm" },
			[
				text("Output", { role: "omp.jobs.label" }),
				detail?.output
					? {
							...ansi(detail.output, { follow: !settled, role: "omp.jobs.output", max: { h: "16lines" } }),
							scroll,
						}
					: text(settled ? "No output" : "No output yet", { role: "omp.jobs.nooutput" }),
			],
			"out",
		),
	]);
	return node("col", { role: "omp.jobs.detail" }, children, stableKey(job.id));
}
