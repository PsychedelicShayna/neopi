import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { BtwHistoryPanel } from "../src/overlays/btw-history-panel";
import type { BtwHistoryRecord } from "../src/overlays/btw-history";
import { initTheme } from "../src/theme/theme";
import type { Input } from "../src/components/input";
import { KeybindingsManager } from "../src/app-keybindings";
import { setKeybindings } from "../src/keybindings";
import { SPACE_HOLD_MECHANICAL_RUN, SPACE_HOLD_RELEASE_MS, type SpaceHoldHandler } from "../src/space-hold";

beforeAll(async () => {
	await initTheme();
});
beforeEach(() => setKeybindings(KeybindingsManager.inMemory()));
afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const records: BtwHistoryRecord[] = Array.from({ length: 40 }, (_, i) => ({
	id: `question-${i}`,
	leafId: null,
	question: `Question ${i}`,
	answer: Array.from({ length: 50 }, (_, row) => `Answer ${i}, line ${row}`).join("\n\n"),
	status: "complete",
	createdAt: i,
	updatedAt: i,
}));

function create(
	options: {
		onFollowUp?: (record: BtwHistoryRecord, question: string, signal: AbortSignal) => Promise<boolean>;
		spaceHold?: (input: Input) => SpaceHoldHandler;
	} = {},
) {
	return new BtwHistoryPanel({
		records,
		onClose: () => {},
		onCopy: () => {},
		onCancel: () => {},
		canFollowUp: () => true,
		onFollowUp: options.onFollowUp ?? (async () => true),
		spaceHold: options.spaceHold,
		requestRender: () => {},
		getHeight: () => 24,
	});
}

function state(panel: BtwHistoryPanel) {
	return panel.navigationSnapshot() as {
		selectedId: string;
		focus: string;
		search: { value: string; focused: boolean; cursor: number };
		listTop: unknown;
		composer?: { recordId: string; value: string; cursor: number };
	};
}

describe("BTW menu navigation and safe history", () => {
	it("uses normal list motions, independent scrolling, and literal filter editing", () => {
		const panel = create();
		try {
			panel.render(100);
			panel.handleInput("G");
			expect(state(panel).selectedId).toBe("question-39");
			panel.handleInput("g");
			panel.handleInput("g");
			panel.render(100);
			expect(state(panel).selectedId).toBe("question-0");
			const top = state(panel).listTop;
			panel.handleInput("\x05");
			panel.render(100);
			expect(state(panel).selectedId).toBe("question-0");
			expect(state(panel).listTop).not.toEqual(top);
			panel.handleInput("/");
			panel.handleInput("jkG /");
			expect(state(panel).search).toMatchObject({ value: "jkG /", focused: true });
			panel.handleInput("\n");
			expect(state(panel).search).toMatchObject({ value: "jkG /", focused: false });
		} finally {
			panel.dispose();
		}
	});

	it("scrolls a narrow two-line row by one visual line and restores that clipped row", () => {
		const panel = create();
		const reopened = create();
		try {
			panel.render(32);
			panel.handleInput("\x05");
			panel.render(32);
			expect(state(panel).selectedId).toBe("question-0");
			expect(state(panel).listTop).toEqual({ item: 0, lineOffset: 1 });
			reopened.restoreNavigation(panel.navigationSnapshot());
			reopened.render(32);
			expect(state(reopened).listTop).toEqual({ item: 0, lineOffset: 1 });
		} finally {
			panel.dispose();
			reopened.dispose();
		}
	});

	it("consumes Tab while filtering and moves to the answer pane after Enter", () => {
		const panel = create();
		try {
			panel.render(100);
			panel.handleInput("/");
			panel.handleInput("Question");
			panel.handleInput("\t");
			expect(state(panel)).toMatchObject({ search: { value: "Question", focused: true } });
			panel.handleInput("\n");
			panel.handleInput("\t");
			panel.handleInput("j");
			expect(state(panel)).toMatchObject({ focus: "answer", search: { value: "Question", focused: false } });
			expect(panel.navigationSnapshot()).toMatchObject({ detail: { scrollOffset: 1 } });
		} finally {
			panel.dispose();
		}
	});

	it("restores pane, selection, query caret, and a safe follow-up draft without submitting", () => {
		const onFollowUp = vi.fn(async () => true);
		const panel = create({ onFollowUp });
		const reopened = create({ onFollowUp });
		try {
			panel.handleInput("/");
			panel.handleInput("Question");
			panel.handleInput("\x1b[D");
			panel.handleInput("\n");
			panel.handleInput("j");
			panel.handleInput("l");
			panel.openFollowUp("question-1");
			panel.handleInput("jkG / a safe draft");
			panel.handleInput("\x1b[D");
			const saved = panel.navigationSnapshot();
			panel.leaveMenu();
			reopened.restoreNavigation(saved);
			expect(state(reopened)).toMatchObject({
				selectedId: "question-1",
				focus: "answer",
				search: { value: "Question", cursor: 7, focused: false },
				composer: { recordId: "question-1", value: "jkG / a safe draft", cursor: 17 },
			});
			expect(onFollowUp).not.toHaveBeenCalled();
			reopened.handleInput("\x1b");
			expect(state(reopened).composer).toBeUndefined();
			expect(reopened.openFollowUp("question-1")).toBe(true);
			expect(state(reopened).composer).toMatchObject({ value: "jkG / a safe draft", cursor: 17 });
		} finally {
			panel.dispose();
			reopened.dispose();
		}
	});

	it("blocks history only while a follow-up submission is pending", async () => {
		const accepted = Promise.withResolvers<boolean>();
		const onFollowUp = vi.fn(() => accepted.promise);
		const panel = create({ onFollowUp });
		try {
			panel.openFollowUp("question-0");
			panel.handleInput("safe question");
			expect(panel.blocksMenuHistory).toBe(false);
			panel.handleInput("\r");
			expect(panel.blocksMenuHistory).toBe(true);
			accepted.resolve(false);
			await accepted.promise;
			expect(panel.blocksMenuHistory).toBe(false);
			expect(state(panel).composer?.value).toBe("safe question");
		} finally {
			panel.dispose();
		}
	});

	it("keeps remapped printable menu actions literal in follow-up drafts", async () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["escape", "j"],
				"tui.input.submit": ["enter", "k"],
				"tui.editor.deleteCharBackward": ["backspace", "h"],
				"tui.editor.deleteCharForward": ["delete", "/"],
				"tui.select.nextContext": ["tab", "g"],
				"tui.select.prevContext": ["shift+tab", "l"],
			}),
		);
		const accepted = Promise.withResolvers<boolean>();
		const onFollowUp = vi.fn(() => accepted.promise);
		const panel = create({ onFollowUp });
		try {
			panel.openFollowUp("question-0");
			for (const character of "hjklggG / ") panel.handleInput(character);
			expect(state(panel).composer?.value).toBe("hjklggG / ");
			expect(onFollowUp).not.toHaveBeenCalled();
			panel.handleInput("\r");
			expect(onFollowUp).toHaveBeenCalledTimes(1);
			accepted.resolve(false);
			await accepted.promise;
			panel.handleInput("\x1b");
			expect(state(panel).composer).toBeUndefined();
			panel.openFollowUp("question-0");
			expect(state(panel).composer?.value).toBe("hjklggG / ");
		} finally {
			panel.dispose();
		}
	});

	it("preserves sustained Space, Backspace latching, and non-space release while typing literal actions", () => {
		vi.useFakeTimers();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["escape", "j"],
				"tui.input.submit": ["enter", "k"],
			}),
		);
		const events: string[] = [];
		const onFollowUp = vi.fn(async () => false);
		const panel = create({
			onFollowUp,
			spaceHold: () => ({
				enabled: () => true,
				onStart: () => events.push("start"),
				onEnd: () => events.push("end"),
				onLatch: () => events.push("latch"),
			}),
		});
		const hold = (): void => {
			for (let index = 0; index < SPACE_HOLD_MECHANICAL_RUN + 2; index++) {
				vi.advanceTimersByTime(30);
				panel.handleInput(" ");
			}
		};
		try {
			panel.openFollowUp("question-0");
			panel.handleInput("h");
			panel.handleInput("i");
			hold();
			expect(state(panel).composer?.value).toBe("hi");
			expect(events).toEqual(["start"]);
			panel.handleInput("\x7f");
			expect(events).toEqual(["start", "latch"]);
			vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS * 4);
			panel.handleInput("j");
			expect(state(panel).composer?.value).toBe("hij");
			expect(events).toEqual(["start", "latch"]);
			panel.handleInput(" ");
			expect(state(panel).composer?.value).toBe("hij");
			expect(events).toEqual(["start", "latch", "end"]);
			hold();
			panel.handleInput("k");
			expect(state(panel).composer?.value).toBe("hijk");
			expect(events).toEqual(["start", "latch", "end", "start", "end"]);
			expect(onFollowUp).not.toHaveBeenCalled();
			panel.handleInput("\x7f");
			expect(state(panel).composer?.value).toBe("hij");
		} finally {
			panel.dispose();
		}
	});
});
