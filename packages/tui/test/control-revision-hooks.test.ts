/**
 * The control socket's focus and paint revisions come from these hooks (#171).
 * A controller that read `focus: N` must see a new number once the human moves
 * focus, and a paint wait must see a new number once a frame is written.
 */
import { describe, expect, it } from "bun:test";
import { type Component, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class Token implements Component, Focusable {
	focused = false;
	invalidate(): void {}
	render(): string[] {
		return ["token"];
	}
}

describe("control revision hooks", () => {
	it("onFocusChange fires when focus moves to a different component, not when it stays", () => {
		const tui = new TUI(new VirtualTerminal(20, 4));
		const editor = new Token();
		const overlay = new Token();
		let changes = 0;
		tui.onFocusChange = () => changes++;
		tui.setFocus(editor);
		tui.setFocus(editor);
		expect(changes).toBe(1);
		tui.setFocus(overlay);
		expect(changes).toBe(2);
	});

	it("onPaint fires after a frame is written", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		tui.addChild(new Token());
		let paints = 0;
		tui.onPaint = () => paints++;
		try {
			tui.start();
			await term.waitForRender();
			const before = paints;
			tui.requestRender();
			await term.waitForRender();
			expect(paints).toBeGreaterThan(before);
		} finally {
			tui.stop();
		}
	});
});
