import { describe, expect, it } from "bun:test";
import { SplitPane, type SplitPaneOptions } from "@oh-my-pi/pi-tui/components/layout/split-pane";
import { type ResizeScrollbackMode, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const DIVIDER = " │ ";

function panel(options: Partial<SplitPaneOptions> = {}): SplitPane {
	return new SplitPane({
		left: width => [`L${width}`],
		right: width => [`R${width}`],
		rightSize: { ratio: 0.3, min: 32, max: 48 },
		leftMinWidth: 60,
		splitAt: 110,
		narrowPane: "left",
		divider: DIVIDER,
		...options,
	});
}

describe("SplitPane rightSize", () => {
	it("bounds the right pane and keeps the left pane's minimum", () => {
		const split = panel();
		expect(split.measure(120)).toMatchObject({ mode: "split", left: { width: 81 }, right: { width: 36 } });
		expect(split.measure(200)).toMatchObject({ mode: "split", left: { width: 149 }, right: { width: 48 } });
		// Constrained: 0.6 × 110 = 66 → max 48 → 107 − 60 = 47, so the chat keeps its 60.
		const wide = panel({ rightSize: { ratio: 0.6, min: 32, max: 48 } });
		expect(wide.measure(110)).toMatchObject({ mode: "split", left: { width: 60 }, right: { width: 47 } });
		const narrow = split.measure(100);
		expect(narrow.mode).toBe("narrow");
		expect(narrow.left?.width).toBe(100);
		expect(narrow.right).toBeUndefined();

		// The render reports the widths measure decided.
		const lines = split.render(120);
		expect(lines[0]).toStartWith("L81");
		expect(lines[0]).toContain(`${DIVIDER}R36`);
		expect(split.dividerCol).toBe(81);
	});

	it("rejects both sizes and applies in-place updates to the next measure", () => {
		expect(
			() =>
				new SplitPane({
					left: () => [],
					right: () => [],
					leftSize: { ratio: 0.5 },
					rightSize: { ratio: 0.5 },
				}),
		).toThrow();

		const split = panel();
		expect(split.measure(120).right?.width).toBe(36);
		split.setRightSize({ ratio: 0.4, min: 32, max: 48 });
		expect(split.measure(120).right?.width).toBe(48);
		split.setLeftMinWidth(80);
		expect(split.measure(120)).toMatchObject({ left: { width: 80 }, right: { width: 37 } });
		split.setSplitAt(130);
		expect(split.measure(120).mode).toBe("narrow");

		// leftSize callers keep the left-constrained arithmetic.
		const left = new SplitPane({
			left: () => [],
			right: () => [],
			leftSize: { ratio: 0.3, min: 20, max: 40 },
			rightMinWidth: 10,
			divider: DIVIDER,
		});
		expect(left.measure(100)).toMatchObject({ left: { width: 30 }, right: { width: 67 } });
		expect(() => left.setRightSize({ ratio: 0.5 })).toThrow();
	});
});

describe("TUI.refreshHistoryAfterWidthChange", () => {
	function harness(mode: ResizeScrollbackMode): {
		tui: TUI;
		replays: () => number;
		paint: () => string;
	} {
		const term = new VirtualTerminal(40, 8);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			realWrite(data);
		};
		let replays = 0;
		const tui = new TUI(term);
		tui.setResizeScrollback(mode);
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: ["row"] }),
			acknowledgeHistory: () => {},
			beginHistoryReplay: () => {
				replays++;
			},
		});
		tui.start();
		tui.renderNow();
		return {
			tui,
			replays: () => replays,
			paint: () => {
				writes.length = 0;
				tui.renderNow();
				return writes.join("");
			},
		};
	}

	it("applies the resize-scrollback policy once per width change", () => {
		const rebuild = harness("rebuild");
		try {
			rebuild.tui.refreshHistoryAfterWidthChange();
			// The latch is already set: a second request (a coalesced resize) adds no replay.
			rebuild.tui.refreshHistoryAfterWidthChange();
			expect(rebuild.replays()).toBe(1);
			expect(rebuild.paint()).toContain("\x1b[3J");
		} finally {
			rebuild.tui.stop();
		}

		const append = harness("append");
		try {
			append.tui.refreshHistoryAfterWidthChange();
			expect(append.replays()).toBe(1);
			expect(append.paint()).not.toContain("\x1b[3J");
		} finally {
			append.tui.stop();
		}

		const preserve = harness("preserve");
		try {
			preserve.tui.refreshHistoryAfterWidthChange();
			expect(preserve.replays()).toBe(0);
			expect(preserve.paint()).not.toContain("\x1b[3J");
		} finally {
			preserve.tui.stop();
		}
	});
});
