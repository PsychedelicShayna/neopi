import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, vi, beforeEach, afterEach } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntryLike } from "../src/chat/transcript-entry";
import type { TUI } from "../src/index";
import { CopySelectorComponent } from "../src/overlays/copy-selector";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntryLike {
	return { type: "message", id, parentId, timestamp: "2026-09-28T09:05:00", message } as SessionMessageEntryLike;
}
const users = () =>
	Array.from({ length: 40 }, (_, i) =>
		entry(`u${i}`, i ? `u${i - 1}` : null, { role: "user", content: `turn-${i}`, timestamp: i }),
	);
function codeEntries(): SessionMessageEntryLike[] {
	return [
		entry("a1", null, {
			role: "assistant",
			content: [{ type: "text", text: "```js\none()\n```\n\n```js\ntwo()\n```" }],
			api: "openai-completions",
			provider: "demo",
			model: "demo",
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AgentMessage),
	];
}
function make(entries = users(), onPick = vi.fn()) {
	return new CopySelectorComponent(entries, { ui, cwd: "/tmp", requestRender: () => {}, onPick, onCancel: () => {} });
}
function state(selector: CopySelectorComponent) {
	return selector.navigationSnapshot() as {
		selected: string;
		descended: boolean;
		blockSelected: number;
		viewport: { viewport: { scrollOffset: number } };
	};
}
const index = (selector: CopySelectorComponent) => Number(state(selector).selected.slice(1));

describe("copy selector shared navigation and history", () => {
	it("prepares first-frame geometry for pages, clamps boundaries and keeps view-only scrolling independent", () => {
		const selector = make();
		const reopened = make();
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
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});

	it("restores selected blocks silently and records nested visits but not context traversal", () => {
		const picked = vi.fn();
		const selector = make(codeEntries(), picked);
		const reopened = make(codeEntries(), picked);
		const visits: string[] = [];
		selector.onNavigationVisit = page => visits.push(page);
		try {
			selector.handleInput("l");
			selector.handleInput("j");
			expect(state(selector)).toMatchObject({ selected: "a1", descended: true, blockSelected: 1 });
			expect(visits).toEqual(["blocks:a1"]);
			const saved = selector.navigationSnapshot();
			reopened.restoreNavigation(saved);
			expect(reopened.navigationSnapshot()).toEqual(saved);
			expect(picked).not.toHaveBeenCalled();
			selector.handleInput("h");
			expect(visits).toEqual(["blocks:a1", ""]);
			selector.handleInput("\t");
			selector.handleInput("\x10");
			expect(state(selector).descended).toBe(false);
			expect(visits).toHaveLength(2);
			reopened.handleInput(" ");
			expect(picked.mock.calls[0]?.[0]).toBe("two()");
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});

	it("leaves slash unbound instead of inventing search or marks, while Space uses existing copy", () => {
		const picked = vi.fn();
		const selector = make(codeEntries(), picked);
		try {
			const saved = selector.navigationSnapshot();
			selector.handleInput("/");
			selector.handleInput("i");
			expect(selector.navigationSnapshot()).toEqual(saved);
			selector.handleInput(" ");
			expect(picked).toHaveBeenCalledTimes(1);
		} finally {
			selector.dispose();
		}
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
