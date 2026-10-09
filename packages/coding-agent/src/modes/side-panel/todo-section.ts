import { Text } from "@oh-my-pi/pi-tui";
import type { SidePanelSection } from "@oh-my-pi/pi-tui/chrome";
import { formatMoreItems, replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { renderTreeList } from "@oh-my-pi/pi-tui/render/tree-list";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	selectCollapsedTodos,
	type TodoItem,
	type TodoPhase,
	todoMatchesAnyDescription,
} from "@oh-my-pi/pi-tui/tools/todo";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import chalk from "@oh-my-pi/pi-utils/chalk";

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

/** One todo row: status-coloured checkbox, content, and a note-count marker. */
export function formatTodoLine(todo: TodoItem, prefix: string, matched: boolean): string {
	const checkbox = theme.checkbox;
	const marker = formatHudNoteMarker(todo.notes?.length ?? 0);
	switch (todo.status) {
		case "completed":
			return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
		case "in_progress":
			return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
		case "abandoned":
			return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
		case "blocked":
			return theme.fg("warning", `${prefix}${checkbox.unchecked} ${todo.content} (blocked)`) + marker;
		default:
			if (matched) return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
			return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
	}
}

/** Input to {@link renderTodoLines}; the same state drives the HUD and the panel section. */
export interface TodoLinesInput {
	readonly phases: readonly TodoPhase[];
	/** Expanded lists every stage and task; collapsed applies the budgets. */
	readonly expanded: boolean;
	/** Descriptions of in-flight subagents; a pending task matching one lights up. */
	readonly activeDescs: readonly string[];
	readonly budget: {
		/** Stages shown after the active one (a trailing summary row covers the rest). */
		readonly subsequentStageCap: number;
		/** Open tasks previewed for the active stage. */
		readonly activeTaskCap: number;
	};
}

/** Budgets the HUD has always used. */
export const TODO_LINE_BUDGET = { subsequentStageCap: 4, activeTaskCap: 5 } as const;

export function activePhase(phases: readonly TodoPhase[]): TodoPhase | undefined {
	const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
	const active = nonEmpty.find(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	return active ?? nonEmpty[nonEmpty.length - 1];
}

/**
 * The todo tree as logical rows: one stage per spine branch, its tasks below,
 * and a closing tail whose fill tracks overall progress. No leading blank or
 * `TODO` header, and no width: callers wrap the rows (`Text`) at their own
 * width. Empty when no phase has tasks.
 */
export function renderTodoLines(input: TodoLinesInput): string[] {
	const phases = input.phases.filter(phase => phase.tasks.length > 0);
	if (phases.length === 0) return [];
	const { expanded, activeDescs } = input;
	const { subsequentStageCap, activeTaskCap } = input.budget;
	const multiPhase = phases.length > 1;
	const activeIdx = phases.indexOf(activePhase(phases) ?? phases[0]!);

	// A pending todo "lights up" (accent) when an in-flight subagent is doing
	// its work, matched by normalized content overlap.
	const isMatched = (todo: TodoItem): boolean =>
		activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

	// Task subtree for a phase. Collapsed runs the shared walking-viewport
	// policy (completed/abandoned omitted, active work pulled to the head,
	// then following pending tasks) so the HUD and the transient tool result
	// can never disagree about the current work (#5873). Expanded lists all.
	const renderTasks = (phase: TodoPhase): string[] => {
		if (expanded) {
			return renderTreeList(
				{
					items: phase.tasks,
					expanded: true,
					renderItem: todo => formatTodoLine(todo, "", isMatched(todo)),
				},
				theme,
			);
		}
		const selection = selectCollapsedTodos(phase.tasks, isMatched, activeTaskCap);
		return renderTreeList(
			{
				items: selection.items,
				itemType: "task",
				trailingSummary: selection.summary,
				renderItem: todo => formatTodoLine(todo, "", isMatched(todo)),
			},
			theme,
		);
	};

	// One phase node. The active stage is highlighted with normal-brightness task
	// progress; other stages render their whole row (name + progress) in the
	// brighter muted gray. Overall progress lives in the tree spine (below).
	const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
		const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;
		// Closed, not just completed: the collapsed task window hides abandoned
		// tasks too, so counting only completions leaves the phase reading stuck.
		const done = phase.tasks.filter(isClosedTodo).length;
		const progress = ` · ${done}/${phase.tasks.length}`;
		if (!isActive) {
			const header = theme.fg("muted", label) + theme.fg("dim", progress);
			return expanded ? [header, ...renderTasks(phase)] : header;
		}
		const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress);
		return [header, ...renderTasks(phase)];
	};

	// Collapsed: active stage + a bounded number of following stages, with a
	// "… n more stages" row for anything past the cap. Expanded: every stage
	// from the top. Roman numerals stay tied to the real phase index.
	const baseIdx = expanded ? 0 : activeIdx;
	const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + subsequentStageCap);
	const hiddenStages = phases.length - baseIdx - phaseSlice.length;

	// Flatten the stage tree into content rows plus a per-row top-level spine
	// glyph (`├─` for stage rows, `│` for continuations). The spine never
	// closes downward — a short elbow tail (`└────`) ends the block instead,
	// so spine + bend + tail form one continuous progress path.
	const spineGlyphs: string[] = [];
	const contentLines: string[] = [];
	const pushBlock = (block: string | string[]): void => {
		const rows = Array.isArray(block) ? block : [block];
		if (rows.length === 0) return;
		spineGlyphs.push(`${theme.tree.branch} `);
		contentLines.push(replaceTabs(rows[0]!));
		for (let i = 1; i < rows.length; i++) {
			spineGlyphs.push(`${theme.tree.vertical}  `);
			contentLines.push(replaceTabs(rows[i]!));
		}
	};
	for (let i = 0; i < phaseSlice.length; i++) {
		pushBlock(renderPhase(phaseSlice[i]!, baseIdx + i + 1, baseIdx + i === activeIdx));
	}
	if (hiddenStages > 0) {
		pushBlock(theme.fg("muted", formatMoreItems(hiddenStages, "stage")));
	}

	// Closing tail: hook + a few horizontals. Every tail cell is 1 column in
	// both glyph sets, so string slicing below splits it by visible cells.
	const tailLen = 6;
	const tail = theme.tree.hook + theme.tree.horizontal.repeat(Math.max(0, tailLen - visibleWidth(theme.tree.hook)));

	// Overall progress (summed across every stage) fills the path in reading
	// order: down the spine, around the bend, out along the tail.
	// Clamp so partial progress lights at least one cell; a closed plan fills
	// the entire path until the configured auto-clear removes the HUD.
	const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const closedTasks = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
	const pathLen = contentLines.length + tailLen;
	let filled = Math.round((closedTasks / totalTasks) * pathLen);
	if (closedTasks > 0) filled = Math.max(filled, 1);
	if (closedTasks < totalTasks) filled = Math.min(filled, pathLen - 1);

	const lines: string[] = [];
	for (let i = 0; i < contentLines.length; i++) {
		lines.push(` ${theme.fg(i < filled ? "accent" : "dim", spineGlyphs[i]!)}${contentLines[i]}`);
	}
	const tailFilled = Math.max(0, Math.min(filled - contentLines.length, tail.length));
	lines.push(` ${theme.fg("accent", tail.slice(0, tailFilled))}${theme.fg("dim", tail.slice(tailFilled))}`);
	return lines;
}

/** Todo state the section renders, forwarded by `InteractiveMode#renderTodoList`. */
export interface TodoSectionState {
	readonly phases: readonly TodoPhase[];
	readonly activeDescs: readonly string[];
	/** The shared HUD dismissal: a dismissed list renders nothing in either form. */
	readonly hidden: boolean;
}

/**
 * The todo list as a side-panel section. Always expanded — the panel's
 * document scroll reaches every row — and empty (so the panel shows its
 * placeholder, not a bare title) when hidden or when no phase has tasks.
 * Like the HUD it mirrors, it requests no render of its own: every caller of
 * `InteractiveMode#renderTodoList` already requests one, so a burst of
 * updates costs one frame request, not one per rebuild.
 */
export class TodoSection implements SidePanelSection {
	readonly id = "todo";
	readonly title = "TODO";
	readonly order = 10;
	collapsed?: boolean;
	#state: TodoSectionState = { phases: [], activeDescs: [], hidden: false };

	readonly content = (width: number): readonly string[] => {
		const state = this.#state;
		if (state.hidden) return [];
		const lines = renderTodoLines({
			phases: state.phases,
			expanded: true,
			activeDescs: state.activeDescs,
			budget: TODO_LINE_BUDGET,
		});
		if (lines.length === 0) return [];
		// The panel's fitLayoutLine pads the rows; wrap only, no padding of our own.
		return new Text(lines.join("\n"), 0, 0).render(width);
	};

	/** Store the state the next frame renders; the caller requests that frame. */
	update(state: TodoSectionState): void {
		this.#state = state;
	}
}
