import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { TreeSelectorComponent, type TreeSelectorNode } from "../src/overlays/tree-selector";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	vi.useRealTimers();
});

function node(id: string, parentId: string | null = null, children: TreeSelectorNode[] = []): TreeSelectorNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2026-09-28T09:05:00",
			message: { role: "user", content: `Row ${id}`, timestamp: 1 },
		},
		children,
	};
}
const flat = () => Array.from({ length: 40 }, (_, i) => node(`row-${i}`));
function create(tree = flat(), selected = "row-0") {
	return new TreeSelectorComponent(
		tree,
		selected,
		24,
		() => {},
		() => {},
	);
}
function state(selector: TreeSelectorComponent) {
	return selector.navigationSnapshot() as {
		tree: {
			selected: string;
			collapsed: string[];
			top: unknown;
			filterMode: string;
			search: { value: string; cursor: number; focused: boolean };
		};
		label?: { entryId: string; value: string; cursor: number };
	};
}

describe("session tree shared menu navigation", () => {
	it("pages and clamps independently from one-line viewport scrolling and restores an offscreen selection", () => {
		const selector = create();
		try {
			selector.render(100);
			selector.handleInput("G");
			expect(state(selector).tree.selected).toBe("row-39");
			selector.handleInput("\x04");
			expect(state(selector).tree.selected).toBe("row-39");
			selector.handleInput("g");
			selector.handleInput("g");
			selector.render(100);
			selector.handleInput("\x05");
			selector.render(100);
			expect(state(selector).tree).toMatchObject({ selected: "row-0", top: { item: 1, lineOffset: 0 } });
			const saved = selector.navigationSnapshot();
			selector.handleInput("\x04");
			expect(state(selector).tree.selected).toBe("row-6");
			selector.restoreNavigation(saved);
			selector.render(100);
			expect(selector.navigationSnapshot()).toEqual(saved);
		} finally {
			selector.dispose();
		}
	});

	it("uses h for collapse/parent, l to expand, and Space only for the tree toggle", () => {
		const tree = [node("root", null, [node("child", "root", [node("leaf", "child")])])];
		const switched = vi.fn();
		const selector = new TreeSelectorComponent(tree, "leaf", 24, switched, () => {});
		try {
			selector.handleInput("h");
			expect(state(selector).tree.selected).toBe("child");
			selector.handleInput("h");
			expect(state(selector).tree.collapsed).toEqual(["child"]);
			expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("Row leaf");
			const saved = selector.navigationSnapshot();
			selector.handleInput("l");
			expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("Row leaf");
			selector.handleInput(" ");
			expect(state(selector).tree.collapsed).toEqual(["child"]);
			expect(switched).not.toHaveBeenCalled();
			selector.restoreNavigation(saved);
			expect(state(selector).tree).toMatchObject({ selected: "child", collapsed: ["child"] });
			selector.handleInput("h");
			expect(state(selector).tree.selected).toBe("root");
		} finally {
			selector.dispose();
		}
	});

	it("keeps focused search literal and moves filter modes off Ctrl-O onto contexts", () => {
		const selector = create();
		try {
			selector.handleInput("\x0f");
			expect(state(selector).tree.filterMode).toBe("default");
			selector.handleInput("/");
			selector.handleInput("jkgG/ ");
			selector.handleInput("\x1b[H");
			expect(state(selector).tree.search).toMatchObject({ value: "jkgG/ ", cursor: 0, focused: true });
			selector.handleInput("\x1b");
			expect(state(selector).tree.search).toMatchObject({ value: "", focused: false });
			selector.handleInput("\t");
			expect(state(selector).tree.filterMode).toBe("no-tools");
			selector.handleInput("\x10");
			expect(state(selector).tree.filterMode).toBe("default");
			selector.handleInput("\x1ba");
			expect(state(selector).tree.filterMode).toBe("all");
		} finally {
			selector.dispose();
		}
	});

	it("records nested label visits and restores safe drafts/carets silently without saving", () => {
		const savedLabel = vi.fn();
		const selector = new TreeSelectorComponent(
			flat(),
			"row-0",
			24,
			() => {},
			() => {},
			savedLabel,
		);
		const reopened = create();
		const visits: Array<{ page: string; previous: unknown }> = [];
		selector.onNavigationVisit = (page, previous) => visits.push({ page, previous });
		try {
			selector.handleInput("e");
			selector.handleInput("draft j/k");
			selector.handleInput("\x1b[D");
			expect(visits.map(visit => visit.page)).toEqual(["label:row-0"]);
			const saved = selector.navigationSnapshot();
			reopened.restoreNavigation(saved);
			expect(state(reopened).label).toMatchObject({ entryId: "row-0", value: "draft j/k", cursor: 8 });
			expect(savedLabel).not.toHaveBeenCalled();
			selector.handleInput("\x1b");
			expect(visits.map(visit => visit.page)).toEqual(["label:row-0", ""]);
			selector.handleInput("e");
			expect(state(selector).label).toMatchObject({ value: "draft j/k", cursor: 8 });
			selector.restoreNavigation(visits[0]!.previous);
			expect(visits).toHaveLength(3);
			expect(state(selector).label).toBeUndefined();
		} finally {
			selector.dispose();
			reopened.dispose();
		}
	});

	it("cancels the empty-tree deferred close when leaving", () => {
		vi.useFakeTimers();
		const onCancel = vi.fn();
		const selector = new TreeSelectorComponent([], null, 24, () => {}, onCancel);
		selector.leaveMenu();
		vi.runAllTimers();
		expect(onCancel).not.toHaveBeenCalled();
		selector.dispose();
	});
});
