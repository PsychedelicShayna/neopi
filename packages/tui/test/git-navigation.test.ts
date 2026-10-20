import { beforeAll, describe, expect, it } from "bun:test";
import { Sidebar } from "../src/apps/git/sidebar";
import { buildDiffDocument, DiffPane } from "../src/apps/git/diff-pane";
import { GitHelpSheet } from "../src/apps/git/help";
import type { ChangedFile, GitViewState } from "../src/apps/git/state";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function sidebar(): Sidebar {
	const model: GitViewState = {
		cwd: "/repo",
		branch: "main",
		clean: false,
		staged: [],
		headCommit: null,
		unstaged: Array.from({ length: 20 }, (_, index): ChangedFile => ({
			path: `file-${index}.ts`,
			kind: "modified",
			area: "unstaged",
		})),
	};
	const view = new Sidebar({
		model,
		avatars: { get: () => null },
		onSelectFile: () => {},
		onAction: () => {},
		onFocusDiff: () => {},
		requestRender: () => {},
	});
	view.viewStyle = "path";
	view.reconcile();
	return view;
}

describe("Git menu navigation", () => {
	it("scrolls the changes view without moving selection, then restores safe drafts", () => {
		const view = sidebar();
		try {
			view.render(60, 12);
			const selected = view.selected;
			view.handleInput("\x05");
			view.render(60, 12);
			expect(view.selected).toEqual(selected);
			view.summary.setValue("unsaved subject");
			view.description.setText("unsaved body");
			const saved = view.navigationSnapshot();
			view.handleInput("G");
			expect(view.selected?.kind).toBe("commit-button");
			view.summary.setValue("other");
			view.restoreNavigation(saved);
			expect(view.selected).toEqual(selected);
			expect(view.summary.getValue()).toBe("unsaved subject");
			expect(view.description.getText()).toBe("unsaved body");
			view.handleInput("g");
			expect(view.selected).toEqual(selected);
			view.handleInput("g");
			expect(view.selected?.kind).toBe("section");
		} finally {
			view.dispose();
		}
	});

	it("filters file paths only in the shared search field and retains its query on Enter", () => {
		const view = sidebar();
		try {
			view.handleInput("/");
			for (const key of "file-17") view.handleSearchInput(key);
			view.handleSearchInput("\n");
			expect(view.search.value).toBe("file-17");
			expect(view.search.focused).toBe(false);
			const output = view
				.render(60, 30)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(output).toContain("file-17.ts");
			expect(output).not.toContain("file-16.ts");
		} finally {
			view.dispose();
		}
	});

	it("restores diff cursor, selection and independent viewport", () => {
		const pane = new DiffPane();
		const oldText = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
		pane.setDocument(buildDiffDocument(oldText, oldText.replace("line-20", "changed-20"), "file.ts"), "ready");
		pane.setMode("file");
		pane.render(80, 6);
		pane.moveCursor(12, false);
		pane.moveCursor(2, true);
		pane.scrollBy(3);
		const saved = pane.navigationSnapshot();
		const cursor = pane.cursor;
		const top = pane.scrollTop;
		pane.cursorToEdge("end");
		pane.restoreNavigation(saved);
		expect(pane.cursor).toBe(cursor);
		expect(pane.scrollTop).toBe(top);
		expect(pane.anchor).toBe(12);
	});

	it("returns from help to its parent with h or Escape", () => {
		let back = 0;
		const help = new GitHelpSheet(
			() => back++,
			() => back++,
		);
		help.handleInput("h");
		expect(back).toBe(1);
		help.handleInput("\x1b");
		expect(back).toBe(2);
	});
});
