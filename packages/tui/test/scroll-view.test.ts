import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import { Ellipsis, visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});

const theme = {
	track: () => "T",
	thumb: () => "B",
};

describe("ScrollView", () => {
	it("shares Vim viewer motions and restores scroll independently of content", () => {
		const view = new ScrollView(
			Array.from({ length: 30 }, (_, i) => `row-${i}`),
			{ height: 6 },
		);
		view.handleScrollKey("j");
		expect(view.getScrollOffset()).toBe(1);
		view.handleScrollKey("\x04");
		expect(view.getScrollOffset()).toBe(4);
		view.handleScrollKey("\x05");
		expect(view.getScrollOffset()).toBe(5);
		const saved = view.navigationSnapshot();
		view.handleScrollKey("G");
		expect(view.getScrollOffset()).toBe(24);
		view.handleScrollKey("g");
		expect(view.getScrollOffset()).toBe(24);
		view.handleScrollKey("g");
		expect(view.getScrollOffset()).toBe(0);
		view.restoreNavigation(saved);
		view.handleScrollKey("\x19");
		expect(view.getScrollOffset()).toBe(4);
		view.handleScrollKey("k");
		expect(view.getScrollOffset()).toBe(3);
		view.handleScrollKey("\x15");
		expect(view.getScrollOffset()).toBe(0);
	});

	it("restores the first prewindowed frame before its caller projects visible rows", () => {
		const previous = new ScrollView([], { height: 3, totalRows: 20 });
		previous.setScrollOffset(10);
		const saved = previous.navigationSnapshot();
		const reopened = new ScrollView([], { height: 3, totalRows: 0 });
		reopened.restoreNavigation(saved);
		reopened.setTotalRows(20);
		const range = reopened.getVisibleRange();
		expect(range).toEqual({ start: 10, end: 13 });
		reopened.setLines(Array.from({ length: range.end - range.start }, (_, index) => `row-${range.start + index}`));
		const frame = reopened.render(20);
		expect(frame[0]).toContain("row-10");
		expect(frame[2]).toContain("row-12");
	});

	it("renders a fixed-height viewport and omits auto scrollbar when content fits", () => {
		const view = new ScrollView(["one", "two"], { height: 3, theme });

		expect(view.render(10)).toEqual(["one", "two", ""]);
	});

	it("renders a right-edge scrollbar when content overflows", () => {
		const view = new ScrollView(["alpha", "beta", "gamma", "delta", "omega"], { height: 3, theme });

		expect(view.render(6)).toEqual(["alphaB", "beta T", "gammaT"]);
	});

	it("scrolls and clamps offsets", () => {
		const view = new ScrollView(["one", "two", "three", "four", "five"], { height: 3, theme });

		view.scroll(10);

		expect(view.getScrollOffset()).toBe(2);
		expect(view.render(6)).toEqual(["threeT", "four T", "five B"]);

		view.scroll(-10);

		expect(view.getScrollOffset()).toBe(0);
	});

	it("reserves a scrollbar column in always mode", () => {
		const view = new ScrollView(["one"], { height: 2, scrollbar: "always", theme });

		expect(view.render(5)).toEqual(["one B", "    B"]);
	});

	it("does not reserve a scrollbar column in never mode", () => {
		const view = new ScrollView(["alpha", "beta", "gamma"], { height: 2, scrollbar: "never", theme });

		expect(view.render(6)).toEqual(["alpha", "beta"]);
	});

	it("renders scrollbar geometry for pre-windowed lines", () => {
		const view = new ScrollView(["gamma", "delta"], { height: 2, totalRows: 4, theme });
		view.setScrollOffset(2);

		expect(view.render(6)).toEqual(["gammaT", "deltaB"]);
	});

	it("does not render a scrollbar when width is zero", () => {
		const view = new ScrollView(["one", "two"], { height: 1, theme });

		expect(view.render(0)).toEqual([""]);
	});

	it("clamps scroll offset when content shrinks", () => {
		const view = new ScrollView(["one", "two", "three", "four"], { height: 2, theme });
		view.scrollToBottom();

		view.setLines(["one"]);

		expect(view.getScrollOffset()).toBe(0);
		expect(view.render(10)).toEqual(["one", ""]);
	});

	it("keeps rendered rows within requested width with ANSI input", () => {
		const view = new ScrollView(["\x1b[31malphabet\x1b[0m", "plain", "tail"], { height: 2, theme });
		const rendered = view.render(5);

		expect(rendered).toHaveLength(2);
		expect(rendered.every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(rendered[0]).toContain("B");
	});

	it("appends an overflow ellipsis by default and omits it when configured", () => {
		const long = ["abcdefghij"];
		const def = new ScrollView(long, { height: 1, scrollbar: "never", theme });
		expect(def.render(5)[0]).toContain("…");

		const omit = new ScrollView(long, { height: 1, scrollbar: "never", ellipsis: Ellipsis.Omit, theme });
		expect(omit.render(5)[0]).toBe("abcde");
	});

	it("reveals changed selections without undoing manual scrolling or replaying one-shot anchors", () => {
		const view = new ScrollView(
			Array.from({ length: 30 }, (_, index) => `row-${index}`),
			{ height: 5, scrollbar: "never" },
		);
		const selection = { id: "selected", start: 15, end: 17 };
		view.revealRange(selection, 20);
		expect(view.render(20)).toContain("row-15");

		view.scroll(-8);
		view.revealRange(selection, 20);
		expect(view.render(20)[0]).toBe("row-5");

		view.revealRange(selection, 10);
		expect(view.render(10)).toContain("row-15");
		view.revealRange({ id: "initial", start: 3, end: 4, margin: 0, alignment: "start", mode: "once" }, 20);
		expect(view.render(20)[0]).toBe("row-3");
		view.scrollToBottom();
		view.revealRange({ id: "initial", start: 4, end: 5, margin: 0, alignment: "start", mode: "once" }, 10);
		expect(view.render(10)[0]).toBe("row-25");
	});

	it("preserves distinct leading-edge and trailing-edge policies for oversized selections", () => {
		const view = new ScrollView(
			Array.from({ length: 30 }, (_, index) => `row-${index}`),
			{ height: 5, scrollbar: "never" },
		);
		view.revealRange({ id: "large-tail", start: 3, end: 20, margin: 0 }, 20);
		expect(view.render(20)[0]).toBe("row-15");
		view.scrollToTop();
		view.revealRange({ id: "large-head", start: 3, end: 20, margin: 0, oversized: "start" }, 20);
		expect(view.render(20)[0]).toBe("row-3");
	});

	it("handles navigation keys, with Shift+Arrow scrolling by fastScrollLines", () => {
		const view = new ScrollView(
			Array.from({ length: 50 }, (_, i) => String(i)),
			{ height: 5, fastScrollLines: 7, theme },
		);

		expect(view.handleScrollKey("\x1b[B")).toBe(true); // down
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("\x1b[1;2B")).toBe(true); // shift+down
		expect(view.getScrollOffset()).toBe(8);
		expect(view.handleScrollKey("\x1b[1;2A")).toBe(true); // shift+up
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("x")).toBe(false);
	});
});
