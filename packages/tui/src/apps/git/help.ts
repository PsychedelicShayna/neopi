/**
 * Keyboard shortcuts sheet of the git TUI (`?`).
 *
 * The keys are the git TUI's own (see `git-tui.ts` and `sidebar.ts`); this
 * sheet only lists them. ANSI draws grouped `key  description` rows; the
 * native render is the hotkeys sheet (NATIVE_REDESIGN §9.7): a glass sheet
 * titled "Keyboard shortcuts" with one section per group and a two-column
 * table whose key cells carry the `key` span token, so Tern draws keycaps.
 */
import { formatKeyHint } from "../../app-keybindings";
import type { KeyName } from "../../key-hint-format";
import { matchesKey } from "../../keys";
import { ScrollView } from "../../components/scroll-view";
import { getMenuSearchVimMode } from "../../components/menu-navigation";
import { col, node, span } from "../../native/describe";
import type { NativeNode, NativeUiEvent } from "../../native/node";
import { actionBar, actionButton } from "../../native/overlay";
import { theme } from "../../theme/theme";
import type { Component } from "../../tui";
import { truncateToWidth, visibleWidth } from "../../utils";

interface Shortcut {
	readonly keys: readonly KeyName[];
	readonly label: string;
}

const GROUPS: readonly { readonly title: string; readonly rows: readonly Shortcut[] }[] = [
	{
		title: "Move",
		rows: [
			{ keys: ["up", "down"], label: "Next or previous row" },
			{ keys: ["left", "right"], label: "Choose the left diff or right changes pane" },
			{ keys: ["enter"], label: "Open the file in the diff" },
			{ keys: ["tab"], label: "Switch between the diff and the changes" },
			{ keys: ["]", "["], label: "Next or previous file" },
			{ keys: ["alt+down", "alt+up"], label: "Next or previous change" },
			{ keys: ["home", "end"], label: "First / last row" },
			{ keys: ["pageUp", "pageDown"], label: "Full page up or down" },
			{ keys: ["alt+left", "alt+right"], label: "Fold/unfold tree or pan diff" },
			{ keys: ["/"], label: "Search changed file paths" },
		],
	},
	{
		title: "Stage",
		rows: [
			{ keys: ["space"], label: "Stage or unstage the row" },
			{ keys: ["s", "u"], label: "Stage or unstage (the hunk or selected lines in the diff)" },
			{ keys: ["shift+up", "shift+down"], label: "Select lines in the diff" },
			{ keys: ["x"], label: "Discard the hunk or selected lines (press twice)" },
			{ keys: ["delete"], label: "Discard the file or folder (press twice)" },
		],
	},
	{
		title: "View",
		rows: [
			{ keys: ["v"], label: "Cycle the diff view" },
			{ keys: ["1", "2", "3", "4"], label: "File, split, inline or hunk view" },
			{ keys: ["w"], label: "Wrap long lines" },
			{ keys: ["b"], label: "Ignore whitespace, then formatting" },
			{ keys: ["t"], label: "Paths or folder tree" },
			{ keys: ["r"], label: "Refresh" },
		],
	},
	{
		title: "Commit",
		rows: [
			{ keys: ["c"], label: "Write the commit message (empty: generate one)" },
			{ keys: ["escape"], label: "Leave the field" },
			{ keys: ["q"], label: "Quit" },
		],
	},
];

const VIM_GROUPS: typeof GROUPS = [
	...GROUPS,
	{
		title: "Vim navigation",
		rows: [
			{ keys: ["j", "k"], label: "Next or previous row" },
			{ keys: ["h", "l"], label: "Choose the left diff or right changes pane" },
			{ keys: ["g", "shift+g"], label: "gg / G: first / last row" },
			{ keys: ["ctrl+u", "ctrl+d"], label: "Half page up or down" },
			{ keys: ["ctrl+y", "ctrl+e"], label: "Scroll view without moving selection" },
		],
	},
];

function shortcutGroups(): typeof GROUPS {
	return getMenuSearchVimMode() ? VIM_GROUPS : GROUPS;
}

/** The shortcuts overlay; any of `?`, escape or `q` closes it. */
export class GitHelpSheet implements Component {
	readonly nativeOverlay = { role: "omp.overlay.hotkeys", head: "Keyboard shortcuts", size: "lg" } as const;
	readonly #close: () => void;
	#native: NativeNode | undefined;
	#nativeVimMode = getMenuSearchVimMode();
	readonly #viewport = new ScrollView([], { height: 1 });

	constructor(
		close: () => void,
		readonly back: () => void = close,
	) {
		this.#close = close;
	}

	handleInput(data: string): void {
		if (data === "?" || matchesKey(data, "left") || (getMenuSearchVimMode() && data === "h")) this.back();
		else if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.#close();
		else this.#viewport.handleScrollKey(data);
	}

	/** Close runs what Esc runs. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#close();
	}

	navigationSnapshot(): unknown {
		return this.#viewport.navigationSnapshot();
	}

	restoreNavigation(snapshot: unknown): void {
		this.#viewport.restoreNavigation(snapshot);
	}

	describe(): NativeNode {
		const vim = getMenuSearchVimMode();
		if (vim !== this.#nativeVimMode) {
			this.#nativeVimMode = vim;
			this.#native = undefined;
		}
		this.#native ??= col(
			[
				...shortcutGroups().map(group =>
					node(
						"section",
						{ head: group.title, role: "omp.hotkeys.group" },
						[
							node("table", {
								role: "omp.hotkeys.table",
								cols: [
									{ id: "keys", head: "Keys" },
									{ id: "does", head: "Action", grow: 1 },
								],
								rows: group.rows.map((row, index) => ({
									id: String(index),
									cells: { keys: row.keys.map(key => span(formatKeyHint(key), "key")), does: row.label },
								})),
							}),
						],
						group.title,
					),
				),
				actionBar([null, actionButton("Close", "close", { keys: "escape" })]),
			],
			{ gap: "lg", role: "omp.app.git.help" },
		);
		return this.#native;
	}

	render(width: number): readonly string[] {
		const keyWidth = Math.max(
			...shortcutGroups().flatMap(group =>
				group.rows.map(row => visibleWidth(row.keys.map(formatKeyHint).join(" "))),
			),
		);
		const lines = [truncateToWidth(` ${theme.bold("Keyboard shortcuts")}`, width), ""];
		for (const group of shortcutGroups()) {
			lines.push(truncateToWidth(` ${theme.fg("muted", group.title)}`, width));
			for (const row of group.rows) {
				const keys = row.keys.map(formatKeyHint).join(" ");
				const pad = " ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2));
				lines.push(truncateToWidth(`   ${theme.fg("accent", keys)}${pad}${row.label}`, width));
			}
			lines.push("");
		}
		lines.push(truncateToWidth(` ${theme.fg("dim", `h / ${formatKeyHint("escape")} back`)}`, width));
		this.#viewport.setLines(lines);
		this.#viewport.setHeight(Math.max(3, Math.floor((process.stdout.rows || 24) * 0.9) - 2));
		return this.#viewport.render(width);
	}

	invalidate(): void {
		this.#native = undefined;
	}
}
