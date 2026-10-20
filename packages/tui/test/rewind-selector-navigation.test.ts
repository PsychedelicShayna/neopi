import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntryLike } from "../src/chat/transcript-entry";
import type { TUI } from "../src/index";
import { RewindSelectorComponent, type BranchVariantPath } from "../src/overlays/rewind-selector";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	vi.useRealTimers();
});
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
function entry(id: string, parentId: string | null, text: string): SessionMessageEntryLike {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-28T09:05:00",
		message: { role: "user", content: text, timestamp: 1 } as AgentMessage,
	} as SessionMessageEntryLike;
}
const users = () => Array.from({ length: 40 }, (_, i) => entry(`u${i}`, i ? `u${i - 1}` : null, `turn-${i}`));
function make(onSelect = vi.fn(), onCancel = vi.fn()) {
	return new RewindSelectorComponent(users(), { ui, cwd: "/tmp", requestRender: () => {}, onSelect, onCancel });
}
function state(selector: RewindSelectorComponent) {
	return selector.navigationSnapshot() as {
		selected: string;
		variant?: string;
		sibling?: string;
		search: { value: string; focused: boolean; cursor: number };
		viewport: { viewport: { scrollOffset: number } };
	};
}
const index = (selector: RewindSelectorComponent) => Number(state(selector).selected.slice(1));

describe("rewind shared menu navigation and safe history", () => {
	it("prepares paging geometry before paint and keeps physical view scrolling independent", () => {
		const selected = vi.fn();
		const selector = make(selected);
		const reopened = make(selected);
		try {
			selector.handleInput("g");
			selector.handleInput("g");
			expect(index(selector)).toBe(0);
			selector.handleInput("\x04");
			const half = index(selector);
			expect(half).toBeGreaterThan(0);
			selector.handleInput("g");
			selector.handleInput("g");
			selector.handleInput("\x1b[6~");
			expect(index(selector)).toBeGreaterThanOrEqual(half);
			selector.handleInput("G");
			selector.handleInput("\x1b[6~");
			expect(index(selector)).toBe(39);
			selector.handleInput("g");
			selector.handleInput("g");
			selector.render(80);
			const before = state(selector).viewport.viewport.scrollOffset;
			selector.handleInput("\x05");
			selector.render(80);
			expect(index(selector)).toBe(0);
			expect(state(selector).viewport.viewport.scrollOffset).toBe(before + 1);
			const saved = selector.navigationSnapshot();
			selector.leaveMenu();
			reopened.restoreNavigation(saved);
			reopened.render(80);
			expect(reopened.navigationSnapshot()).toEqual(saved);
			reopened.handleInput(" ");
			expect(selected).not.toHaveBeenCalled();
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});

	it("clears the literal filter after Esc and only closes on the next Esc", () => {
		const cancelled = vi.fn();
		const selector = make(vi.fn(), cancelled);
		try {
			selector.handleInput("i");
			expect(selector.filterFocused).toBe(false);
			selector.handleInput("/");
			selector.handleInput("jkgG/ ");
			selector.handleInput("\x1b[H");
			expect(state(selector).search).toMatchObject({ value: "jkgG/ ", cursor: 0, focused: true });
			selector.handleInput("\x1b");
			expect(state(selector).search).toMatchObject({ value: "", focused: false });
			expect(cancelled).not.toHaveBeenCalled();
			selector.handleInput("\x1b");
			expect(cancelled).toHaveBeenCalledTimes(1);
		} finally {
			selector.dispose();
		}
	});

	it("restores a filtered result, field caret and independent viewport without rewinding", () => {
		const selected = vi.fn();
		const selector = make(selected);
		const reopened = make(selected);
		try {
			selector.handleInput("f");
			selector.handleInput("turn");
			selector.handleInput("\x1b[D");
			selector.handleInput("\n");
			selector.handleInput("g");
			selector.handleInput("g");
			selector.handleInput("j");
			selector.render(80);
			selector.handleInput("\x05");
			selector.render(80);
			const saved = selector.navigationSnapshot();
			reopened.restoreNavigation(saved);
			reopened.render(80);
			expect(reopened.navigationSnapshot()).toEqual(saved);
			expect(state(reopened)).toMatchObject({
				selected: "u1",
				search: { value: "turn", focused: false, cursor: 3 },
			});
			expect(selected).not.toHaveBeenCalled();
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});

	it("restores the stable sibling/root context and cancels slide timers on leave", () => {
		vi.useFakeTimers();
		const selected = vi.fn();
		const repaint = vi.fn();
		const entries = [entry("u0", null, "root"), entry("u1", "u0", "fork"), entry("u2", "u1", "later")];
		const siblings = (id: string): BranchVariantPath[] =>
			id === "u1"
				? [{ rootId: "s0", entries: [entry("s0", "u0", "alternate"), entry("s1", "s0", "alternate next")] }]
				: [];
		const create = () =>
			new RewindSelectorComponent(entries, {
				ui,
				cwd: "/tmp",
				requestRender: repaint,
				siblingPaths: siblings,
				onSelect: selected,
				onCancel: () => {},
			});
		const selector = create();
		const reopened = create();
		try {
			selector.render(80);
			selector.handleInput("h");
			selector.handleInput("l");
			selector.handleInput("j");
			selector.render(80);
			expect(state(selector)).toMatchObject({ selected: "u1", variant: "s0", sibling: "s1" });
			const saved = selector.navigationSnapshot();
			selector.leaveMenu();
			const renders = repaint.mock.calls.length;
			vi.advanceTimersByTime(500);
			expect(repaint).toHaveBeenCalledTimes(renders);
			reopened.restoreNavigation(saved);
			reopened.render(80);
			expect(state(reopened)).toMatchObject({ selected: "u1", variant: "s0", sibling: "s1" });
			expect(selected).not.toHaveBeenCalled();
			reopened.handleInput(" ");
			expect(selected).not.toHaveBeenCalled();
			reopened.handleInput("\r");
			expect(selected).toHaveBeenCalledWith("s1");
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});
});
