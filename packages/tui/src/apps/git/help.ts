/**
 * Keyboard shortcuts sheet of the git TUI (`?`).
 *
 * The keys are the git TUI's own (see `git-tui.ts` and `sidebar.ts`); this
 * sheet only lists them. ANSI draws grouped `key  description` rows; the
 * native render is the hotkeys sheet (NATIVE_REDESIGN §9.7): a glass sheet
 * titled "Keyboard shortcuts" with one section per group and a two-column
 * table whose key cells carry the `key` span token, so Tern draws keycaps.
 */
import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
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
		title: "cli.commands.git.help.move",
		rows: [
			{ keys: ["up", "down"], label: "cli.commands.git.help.row" },
			{ keys: ["left", "right"], label: "cli.commands.git.help.choosePane" },
			{ keys: ["enter"], label: "cli.commands.git.help.openFile" },
			{ keys: ["tab"], label: "cli.commands.git.help.switchPane" },
			{ keys: ["]", "["], label: "cli.commands.git.help.file" },
			{ keys: ["alt+down", "alt+up"], label: "cli.commands.git.help.change" },
			{ keys: ["home", "end"], label: "cli.commands.git.help.firstLast" },
			{ keys: ["pageUp", "pageDown"], label: "cli.commands.git.help.page" },
			{ keys: ["alt+left", "alt+right"], label: "cli.commands.git.help.foldPan" },
			{ keys: ["/"], label: "cli.commands.git.help.search" },
		],
	},
	{
		title: "cli.commands.git.help.stage",
		rows: [
			{ keys: ["space"], label: "cli.commands.git.help.stageRow" },
			{ keys: ["s", "u"], label: "cli.commands.git.help.stageChanges" },
			{ keys: ["shift+up", "shift+down"], label: "cli.commands.git.help.selectLines" },
			{ keys: ["x"], label: "cli.commands.git.help.discardChanges" },
			{ keys: ["delete"], label: "cli.commands.git.help.discardFile" },
		],
	},
	{
		title: "cli.commands.git.help.view",
		rows: [
			{ keys: ["v"], label: "cli.commands.git.help.cycleView" },
			{ keys: ["1", "2", "3", "4"], label: "cli.commands.git.help.chooseView" },
			{ keys: ["w"], label: "cli.commands.git.help.wrap" },
			{ keys: ["b"], label: "cli.commands.git.help.whitespace" },
			{ keys: ["t"], label: "cli.commands.git.help.paths" },
			{ keys: ["r"], label: "cli.commands.git.help.refresh" },
		],
	},
	{
		title: "cli.commands.git.help.commit",
		rows: [
			{ keys: ["c"], label: "cli.commands.git.help.writeCommit" },
			{ keys: ["escape"], label: "cli.commands.git.help.leaveField" },
			{ keys: ["q"], label: "cli.commands.git.help.quit" },
		],
	},
];

const VIM_GROUPS: typeof GROUPS = [
	...GROUPS,
	{
		title: "cli.commands.git.help.vim",
		rows: [
			{ keys: ["j", "k"], label: "cli.commands.git.help.row" },
			{ keys: ["h", "l"], label: "cli.commands.git.help.choosePane" },
			{ keys: ["g", "shift+g"], label: "cli.commands.git.help.vimFirstLast" },
			{ keys: ["ctrl+u", "ctrl+d"], label: "cli.commands.git.help.halfPage" },
			{ keys: ["ctrl+y", "ctrl+e"], label: "cli.commands.git.help.scroll" },
		],
	},
];

function shortcutGroups(): typeof GROUPS {
	return getMenuSearchVimMode() ? VIM_GROUPS : GROUPS;
}

/** The shortcuts overlay; any of `?`, escape or `q` closes it. */
export class GitHelpSheet implements Component {
	get nativeOverlay() {
		return { role: "omp.overlay.hotkeys", head: t("cli.commands.git.shortcuts"), size: "lg" } as const;
	}
	readonly #close: () => void;
	#native: NativeNode | undefined;
	#nativeVimMode = getMenuSearchVimMode();
	#nativeLocale = getLocale();
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
		const locale = getLocale();
		if (vim !== this.#nativeVimMode || locale !== this.#nativeLocale) {
			this.#nativeVimMode = vim;
			this.#nativeLocale = locale;
			this.#native = undefined;
		}
		this.#native ??= col(
			[
				...shortcutGroups().map(group =>
					node(
						"section",
						{ head: t(group.title), role: "omp.hotkeys.group" },
						[
							node("table", {
								role: "omp.hotkeys.table",
								cols: [
									{ id: "keys", head: t("cli.commands.git.help.keys") },
									{ id: "does", head: t("cli.commands.git.help.action"), grow: 1 },
								],
								rows: group.rows.map((row, index) => ({
									id: String(index),
									cells: { keys: row.keys.map(key => span(formatKeyHint(key), "key")), does: t(row.label) },
								})),
							}),
						],
						group.title,
					),
				),
				actionBar([null, actionButton(t("cli.commands.git.close"), "close", { keys: "escape" })]),
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
		const lines = [truncateToWidth(` ${theme.bold(t("cli.commands.git.shortcuts"))}`, width), ""];
		for (const group of shortcutGroups()) {
			lines.push(truncateToWidth(` ${theme.fg("muted", t(group.title))}`, width));
			for (const row of group.rows) {
				const keys = row.keys.map(formatKeyHint).join(" ");
				const pad = " ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2));
				lines.push(truncateToWidth(`   ${theme.fg("accent", keys)}${pad}${t(row.label)}`, width));
			}
			lines.push("");
		}
		lines.push(
			truncateToWidth(
				` ${theme.fg("dim", t("cli.commands.git.help.back", { key: formatKeyHint("escape") }))}`,
				width,
			),
		);
		this.#viewport.setLines(lines);
		this.#viewport.setHeight(Math.max(3, Math.floor((process.stdout.rows || 24) * 0.9) - 2));
		return this.#viewport.render(width);
	}

	invalidate(): void {
		this.#native = undefined;
	}
}
