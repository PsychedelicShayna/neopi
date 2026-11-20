import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import { RawSseViewerComponent } from "../src/apps/debug/raw-sse";
import { RawSseDebugBuffer } from "../src/apps/debug/raw-sse-buffer";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function offset(viewer: RawSseViewerComponent): number {
	return (viewer.navigationSnapshot() as { viewport: { viewport: { scrollOffset: number } } }).viewport.viewport
		.scrollOffset;
}

function nativeScroll(viewer: RawSseViewerComponent): unknown {
	return viewer.describeScreen().main?.find(child => "k" in child && child.k === "ansi");
}

describe("raw SSE menu navigation", () => {
	it("supports viewer motions and restores ANSI viewport without substituting native half pages", () => {
		const buffer = new RawSseDebugBuffer();
		for (let i = 0; i < 40; i++)
			buffer.recordEvent({ event: "delta", data: `event-${i}`, raw: [`data: event-${i}`] });
		const viewer = new RawSseViewerComponent({
			buffer,
			terminalRows: 16,
			deps: { copyToClipboard() {} },
			onExit() {},
		});
		try {
			viewer.render(100);
			const end = offset(viewer);
			expect(end).toBeGreaterThan(0);
			viewer.handleInput("g");
			expect(offset(viewer)).toBe(end);
			viewer.handleInput("g");
			viewer.render(100);
			expect(offset(viewer)).toBe(0);
			const nativeBeforeHalf = nativeScroll(viewer);
			viewer.handleInput("\x04");
			viewer.render(100);
			expect(offset(viewer)).toBeGreaterThan(1);
			expect(nativeScroll(viewer)).toEqual(nativeBeforeHalf);
			const saved = viewer.navigationSnapshot();
			viewer.handleInput("G");
			viewer.restoreNavigation(saved);
			viewer.render(100);
			const restored = offset(viewer);
			viewer.handleInput("\x05");
			expect(offset(viewer)).toBe(restored + 1);
			viewer.handleInput("k");
			expect(offset(viewer)).toBe(restored);
		} finally {
			viewer.dispose();
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
