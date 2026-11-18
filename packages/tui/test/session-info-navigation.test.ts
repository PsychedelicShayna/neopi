import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SessionInfoOverlay } from "../src/overlays/session-info-overlay";
import { initTheme } from "../src/theme/theme";
import type { DescribeContext } from "../src/native/node";

beforeAll(async () => {
	await initTheme();
});
const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

describe("session information viewer navigation", () => {
	it("shares scrolling motions and restores the viewport on the first reopened frame", () => {
		const report = Array.from({ length: 60 }, (_, i) => `Entry ${i}`).join("\n");
		let closed = 0;
		const view = new SessionInfoOverlay({ terminal: { rows: 16 } }, report, () => closed++);
		const offset = () => (view.navigationSnapshot() as { scrollOffset: number }).scrollOffset;
		view.render(80);
		view.handleInput("j");
		expect(offset()).toBe(1);
		view.handleInput("\x04");
		expect(offset()).toBe(7);
		const saved = view.navigationSnapshot();
		view.handleInput("G");
		view.handleInput("g");
		expect(offset()).toBeGreaterThan(7);
		view.handleInput("g");
		expect(offset()).toBe(0);
		const reopened = new SessionInfoOverlay({ terminal: { rows: 16 } }, report, () => {});
		reopened.restoreNavigation(saved);
		expect(reopened.render(80).join("\n")).toContain("Entry 7");
		view.handleInput("\x1b");
		expect(closed).toBe(1);
		view.dispose();
		reopened.dispose();
	});

	it("forwards native line and boundary requests without substituting a full page for half", () => {
		const view = new SessionInfoOverlay({ terminal: { rows: 16 } }, "Info", () => {});
		view.handleInput("j");
		expect(view.describe(cx).scroll?.by).toBe("line-down");
		const before = view.describe(cx).scroll;
		view.handleInput("\x04");
		expect(view.describe(cx).scroll).toEqual(before);
		view.handleInput("G");
		expect(view.describe(cx).scroll?.by).toBe("end");
		view.dispose();
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
