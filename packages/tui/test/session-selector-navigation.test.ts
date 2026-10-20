import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent, type SessionSelectorEntry } from "../src/overlays/session-selector";
import type { DescribeContext } from "../src/native/node";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	vi.useRealTimers();
});

const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const sessions: SessionSelectorEntry[] = Array.from({ length: 40 }, (_, i) => ({
	path: `/work/session-${i}.jsonl`,
	id: `session-${i}`,
	cwd: "/work",
	title: `Session ${i}`,
	firstMessage: `Prompt ${i}`,
	allMessagesText: `Prompt ${i}`,
	modified: new Date(2024, 0, 1, 0, 0, i),
	size: 100,
}));
function snapshot(selector: SessionSelectorComponent) {
	return selector.navigationSnapshot() as {
		scope: string;
		list: { search: { value: string; cursor: number; focused: boolean }; selected: string; top: unknown };
	};
}
function make() {
	return new SessionSelectorComponent(
		sessions.slice(),
		() => {},
		() => {},
		() => {},
		{ getTerminalRows: () => 24 },
	);
}

describe("session selector Vim navigation and safe history", () => {
	it("uses normal boundaries and half pages with a separately clipped visual viewport", () => {
		const selector = make();
		try {
			selector.render(120);
			selector.handleInput("G");
			expect(snapshot(selector).list.selected).toBe(sessions[39]!.path);
			selector.handleInput("g");
			selector.handleInput("g");
			selector.render(120);
			selector.handleInput("\x05");
			selector.render(120);
			expect(snapshot(selector).list).toMatchObject({
				selected: sessions[0]!.path,
				top: { item: 0, lineOffset: 1 },
			});
			const saved = selector.navigationSnapshot();
			selector.handleInput("\x04");
			expect(snapshot(selector).list.selected).toBe(sessions[2]!.path);
			selector.restoreNavigation(saved);
			selector.render(120);
			expect(selector.navigationSnapshot()).toEqual(saved);
			selector.getSessionList().handleWheel(1);
			expect(snapshot(selector).list.selected).toBe(sessions[1]!.path);
		} finally {
			selector.dispose();
		}
	});

	it("keeps a focused query literal, including editing keys, and exits it before closing natively", () => {
		const cancelled = vi.fn();
		const selector = new SessionSelectorComponent(
			sessions.slice(),
			() => {},
			cancelled,
			() => {},
		);
		try {
			selector.handleInput("/");
			selector.handleInput("jkgG/ ");
			selector.handleInput("\x1b[H");
			expect(snapshot(selector).list.search).toMatchObject({ value: "jkgG/ ", cursor: 0, focused: true });
			const close = { type: "action", key: "", act: "close", mods: [] } as const;
			selector.handleNativeEvent({ ...close, mods: [] });
			expect(snapshot(selector).list.search).toMatchObject({ value: "", focused: false });
			expect(cancelled).not.toHaveBeenCalled();
			selector.handleNativeEvent({ ...close, mods: [] });
			expect(cancelled).toHaveBeenCalledTimes(1);
		} finally {
			selector.dispose();
		}
	});

	it("restores query caret, scope, result order, selected session and viewport without resuming", () => {
		const resumed = vi.fn();
		const options = { allSessions: sessions.slice(), getTerminalRows: () => 24 };
		const selector = new SessionSelectorComponent(
			sessions.slice(0, 5),
			resumed,
			() => {},
			() => {},
			options,
		);
		const reopened = new SessionSelectorComponent(
			sessions.slice(0, 5),
			resumed,
			() => {},
			() => {},
			{ getTerminalRows: () => 24 },
		);
		try {
			selector.handleInput("\x0e"); // Ctrl-N next scope.
			expect(snapshot(selector).scope).toBe("all");
			selector.handleInput("/");
			selector.handleInput("Session");
			selector.handleInput("\x1b[D");
			selector.handleInput("\n");
			selector.handleInput("j");
			selector.render(120);
			selector.handleInput("\x05");
			selector.render(120);
			const saved = selector.navigationSnapshot();
			selector.leaveMenu();
			reopened.restoreNavigation(saved);
			reopened.render(120);
			expect(reopened.navigationSnapshot()).toEqual(saved);
			expect(snapshot(reopened).list.search).toMatchObject({ value: "Session", cursor: 6, focused: false });
			expect(resumed).not.toHaveBeenCalled();
			reopened.handleInput("\x10"); // No path handler exists here: Ctrl-P is previous scope.
			expect(snapshot(reopened).scope).toBe("folder");
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});

	it("discards pending confirmation on leave, never confirms with Space, and blocks only an in-flight delete", async () => {
		const pending = Promise.withResolvers<boolean>();
		const onDelete = vi.fn(() => pending.promise);
		const selector = new SessionSelectorComponent(
			sessions.slice(),
			() => {},
			() => {},
			() => {},
			{ onDelete },
		);
		try {
			selector.getSessionList().requestDelete();
			expect(selector.blocksMenuHistory).toBe(false);
			selector.handleInput(" ");
			expect(onDelete).not.toHaveBeenCalled();
			const saved = selector.navigationSnapshot();
			selector.leaveMenu();
			selector.restoreNavigation(saved);
			expect((selector.describe(cx).p as { confirm?: unknown })?.confirm).toBeNull();
			selector.getSessionList().requestDelete();
			selector.handleNativeEvent({ type: "action", key: "", act: "delete-confirm", mods: [] });
			expect(selector.blocksMenuHistory).toBe(true);
			pending.resolve(false);
			await pending.promise;
			expect(selector.blocksMenuHistory).toBe(false);
		} finally {
			selector.dispose();
		}
	});

	it("allows history during a read-only scope load and ignores its late completion after leaving", async () => {
		const loaded = Promise.withResolvers<SessionSelectorEntry[]>();
		const repaint = vi.fn();
		const selector = new SessionSelectorComponent(
			sessions.slice(0, 2),
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: () => loaded.promise,
			},
		);
		try {
			selector.setOnRequestRender(repaint);
			selector.handleInput("\t");
			expect(selector.blocksMenuHistory).toBe(false);
			const saved = selector.navigationSnapshot();
			selector.leaveMenu();
			const rendersBeforeCompletion = repaint.mock.calls.length;
			loaded.resolve(sessions.slice());
			await loaded.promise;
			expect(snapshot(selector).scope).toBe("folder");
			expect(repaint).toHaveBeenCalledTimes(rendersBeforeCompletion);
			selector.restoreNavigation(saved);
			expect(snapshot(selector).scope).toBe("folder");
		} finally {
			selector.dispose();
		}
	});

	it("cancels delayed history matching when left", () => {
		vi.useFakeTimers();
		const matcher = vi.fn(() => [] as string[]);
		const repaint = vi.fn();
		const selector = new SessionSelectorComponent(
			sessions.slice(),
			() => {},
			() => {},
			() => {},
			{ historyMatcher: matcher },
		);
		try {
			selector.setOnRequestRender(repaint);
			selector.handleInput("/");
			selector.handleInput("query");
			selector.leaveMenu();
			vi.runAllTimers();
			expect(matcher).not.toHaveBeenCalled();
			expect(repaint).not.toHaveBeenCalled();
		} finally {
			selector.dispose();
		}
	});
});
