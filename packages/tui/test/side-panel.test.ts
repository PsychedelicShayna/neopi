import { beforeAll, describe, expect, it } from "bun:test";
import { SidePanel, type SidePanelSection } from "@oh-my-pi/pi-tui/chrome/side-panel";
import { parseSgrMouse, type SgrMouseEvent } from "@oh-my-pi/pi-tui/mouse";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";

const WIDTH = 30;

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function section(id: string, lines: readonly string[], order?: number): SidePanelSection {
	return { id, title: id.toUpperCase(), content: () => lines, order };
}

/** Row text without the scrollbar gutter (the last column). */
function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line).slice(0, -1).trimEnd());
}

function mouse(button: number, row = 0, col = 0): SgrMouseEvent {
	const event = parseSgrMouse(`\x1b[<${button};${col + 1};${row + 1}M`);
	if (!event) throw new Error("bad mouse report");
	return event;
}
const CLICK = 0;
const WHEEL_DOWN = 65;
const WHEEL_UP = 64;

describe("SidePanel", () => {
	beforeAll(() => {
		initTheme();
	});

	it("returns exactly `height` rows for any section count", () => {
		for (const count of [0, 1, 3]) {
			const panel = new SidePanel();
			for (let index = 0; index < count; index++) panel.register(section(`s${index}`, rows("row", 4)));
			for (const height of [0, 1, 5, 40]) {
				panel.setHeight(height);
				const lines = panel.render(WIDTH);
				expect(lines).toHaveLength(height);
				for (const line of lines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBe(WIDTH);
			}
		}
	});

	it("scrolls the document to its last row and keeps the offset clamped", () => {
		const height = 10;
		const panel = new SidePanel();
		// Three sections: (1 title + 8 body + 1 gap) × 3 = 30 rows = 3 × height.
		panel.register(section("a", rows("a", 8), 1));
		panel.register(section("b", rows("b", 8), 2));
		panel.register(section("c", rows("c", 8), 3));
		panel.setHeight(height);
		panel.render(WIDTH);
		expect(panel.documentRows).toBe(3 * height);

		panel.scrollBy(height);
		panel.render(WIDTH);
		panel.scrollBy(height);
		const bottom = panel.render(WIDTH);
		expect(plain(bottom)).toContain("c7");
		// The thumb sits on the bottom rows once scrolled to the end.
		const thumbRows = bottom
			.map((line, index) => (Bun.stripANSI(line).endsWith("┃") ? index : -1))
			.filter(i => i >= 0);
		expect(thumbRows.at(-1)).toBe(height - 1);
		expect(thumbRows[0]).toBeGreaterThan(0);

		panel.scrollBy(999);
		expect(panel.scrollOffset).toBe(2 * height);

		// Collapsing a section shrinks the document; the offset re-clamps and the end stays visible.
		panel.setCollapsed("a", true);
		expect(plain(panel.render(WIDTH))).toContain("c7");
		expect(panel.scrollOffset).toBe(panel.documentRows - height);
		panel.setHeight(height + 10);
		expect(plain(panel.render(WIDTH))).toContain("c7");
		expect(panel.scrollOffset).toBe(Math.max(0, panel.documentRows - (height + 10)));
	});

	it("shows only a dim placeholder when there is nothing to show", () => {
		const empty = new SidePanel();
		empty.setHeight(6);
		const blank = new SidePanel();
		blank.register(section("todo", []));
		blank.setHeight(6);
		for (const panel of [empty, blank]) {
			const lines = panel.render(WIDTH);
			expect(lines).toHaveLength(6);
			// One placeholder row and no section title over an empty body.
			const text = plain(lines).filter(line => line !== "");
			expect(text).toHaveLength(1);
			expect(text.some(line => line.startsWith("TODO"))).toBe(false);
		}

		// Collapsed while it had rows: the title holds even after its content empties.
		let tasks = rows("task", 3);
		const collapsed = new SidePanel();
		collapsed.register({ id: "todo", title: "TODO", content: () => tasks });
		collapsed.setHeight(6);
		collapsed.render(WIDTH);
		collapsed.setCollapsed("todo", true);
		tasks = [];
		const held = plain(collapsed.render(WIDTH)).filter(line => line !== "");
		expect(held).toHaveLength(1);
		expect(held[0]).toStartWith("TODO");
		// Expanded and found empty: back to the single placeholder row.
		collapsed.setCollapsed("todo", false);
		const cleared = plain(collapsed.render(WIDTH)).filter(line => line !== "");
		expect(cleared).toHaveLength(1);
		expect(cleared[0]?.startsWith("TODO")).toBe(false);
	});

	it("hit-tests titles and bodies against the scrolled document", () => {
		const routed: Array<{ line: number; col: number }> = [];
		const body: Component & { routeMouse(event: SgrMouseEvent, line: number, col: number): void } = {
			render: () => rows("b", 6),
			invalidate: () => {},
			routeMouse: (_event, line, col) => routed.push({ line, col }),
		};
		const panel = new SidePanel();
		panel.register(section("a", rows("a", 6), 1));
		panel.register({ id: "b", title: "B", content: body, order: 2 });
		panel.setHeight(6);
		panel.render(WIDTH);
		// Document: A title, a0..a5, gap, B title (row 8), b0..b5, gap.
		panel.scrollTo(5);
		const view = plain(panel.render(WIDTH));
		const titleRow = view.findIndex(line => line.startsWith("B "));
		expect(titleRow).toBe(3);

		panel.routeMouse(mouse(CLICK), titleRow, 0);
		expect(panel.sections.find(entry => entry.id === "b")?.collapsed).toBe(true);
		expect(panel.sections.find(entry => entry.id === "a")?.collapsed).toBeFalsy();

		panel.setCollapsed("b", false);
		panel.render(WIDTH);
		panel.routeMouse(mouse(CLICK), titleRow + 2, 4);
		expect(routed).toEqual([{ line: 1, col: 4 }]);

		const before = panel.scrollOffset;
		panel.routeMouse(mouse(WHEEL_UP), 0, 0);
		expect(panel.scrollOffset).toBe(before - 3);
		panel.routeMouse(mouse(WHEEL_DOWN), 0, 0);
		expect(panel.scrollOffset).toBe(before);
	});

	it("renders nothing of a collapsed section but its title", () => {
		const rendered: number[] = [];
		const panel = new SidePanel();
		panel.register({
			id: "plan",
			title: "PLAN",
			// Render-time side effect (image-budget observes, large plans): recorded per call.
			content: width => {
				rendered.push(width);
				return rows("task", 50);
			},
		});
		panel.setHeight(10);
		panel.render(WIDTH);
		expect(rendered.length).toBe(1);

		panel.setCollapsed("plan", true);
		for (let frame = 0; frame < 3; frame++) {
			const view = plain(panel.render(WIDTH)).filter(line => line !== "");
			expect(view).toHaveLength(1);
			expect(view[0]).toStartWith("PLAN");
		}
		expect(rendered.length).toBe(1);

		panel.setCollapsed("plan", false);
		expect(plain(panel.render(WIDTH))).toContain("task0");
		expect(rendered.length).toBe(2);
	});

	it("replaces a section by id in place and removes it on unregister", () => {
		const panel = new SidePanel();
		panel.register(section("todo", ["first"], 10));
		panel.register(section("trace", ["trace"], 10));
		panel.register(section("todo", ["second"], 10));
		expect(panel.sections.map(entry => entry.id)).toEqual(["todo", "trace"]);
		panel.setHeight(10);
		const text = plain(panel.render(WIDTH));
		expect(text).toContain("second");
		expect(text).not.toContain("first");
		expect(text.filter(line => line.startsWith("TODO"))).toHaveLength(1);

		panel.unregister("todo");
		expect(panel.sections.map(entry => entry.id)).toEqual(["trace"]);
	});
});
