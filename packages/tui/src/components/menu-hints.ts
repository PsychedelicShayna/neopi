import { t } from "@oh-my-pi/pi-utils/i18n";
import { matchesKey } from "../keys";
import { col, node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { compositeLineAt } from "../render/composite";
import type { Component } from "../tui";
import { replaceTabs, visibleWidth, wrapTextWithAnsi } from "../utils";
import { getMenuSearchVimMode, type MenuKeyReader, MenuViewport } from "./menu-navigation";

export const MENU_VIM_HINT = "hjkl gg/G C-u d e y";

/** Harness actions always win the space budget; motions are optional decoration. */
export function menuHintLines(harness: string, width: number, vim = MENU_VIM_HINT): string[] {
	if (width <= 0) return [];
	if (vim && !getMenuSearchVimMode()) vim = "↑↓ ←→ Home/End PgUp/PgDn";
	const actions = replaceTabs(harness);
	const actionWidth = visibleWidth(actions);
	const motionWidth = visibleWidth(vim);
	if (vim && actionWidth + motionWidth + 2 <= width) {
		return [actions + " ".repeat(width - actionWidth - motionWidth) + vim];
	}
	const lines: string[] = [];
	let current = "";
	for (const action of actions.split(" · ")) {
		const combined = current ? `${current} · ${action}` : action;
		if (visibleWidth(combined) <= width) {
			current = combined;
			continue;
		}
		if (current) lines.push(current);
		const wrapped = wrapTextWithAnsi(action, width);
		lines.push(...wrapped.slice(0, -1));
		current = wrapped.at(-1) ?? "";
	}
	if (current) lines.push(current);
	return lines;
}

/** For layouts whose action label already fits a single line. */
export function menuHint(harness: string, width: number, vim = MENU_VIM_HINT): string {
	return menuHintLines(harness, width, vim).join("\n");
}

/** A width-aware footer; unlike Text it never truncates a menu action for a motion. */
export class MenuHints implements Component {
	constructor(
		readonly harness: string | (() => string),
		readonly style: (text: string) => string = text => text,
		readonly vim = MENU_VIM_HINT,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return menuHintLines(typeof this.harness === "function" ? this.harness() : this.harness, width, this.vim).map(
			this.style,
		);
	}
}

/** Small, host-owned help float. Text fields must receive literal ? before this reader. */
export class MenuHelp {
	#open = false;
	readonly #extra: string | (() => string);
	readonly #viewport: MenuViewport | undefined;

	constructor(
		readonly vim = MENU_VIM_HINT,
		extra: string | (() => string) = "",
		/** When supplied, keep the card within the host's rows and let these keys scroll it. */
		readonly keys?: MenuKeyReader,
	) {
		this.#extra = extra;
		this.#viewport = keys ? new MenuViewport() : undefined;
	}

	get extra(): string {
		return typeof this.#extra === "function" ? this.#extra() : this.#extra;
	}

	get open(): boolean {
		return this.#open;
	}

	handleInput(data: string): boolean {
		if (this.#open) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "?") {
				this.#open = false;
				this.keys?.reset();
			} else if (this.#viewport) {
				const action = this.keys?.read(data);
				if (action && action !== "pending") {
					switch (action.kind) {
						case "move":
						case "scroll":
							this.#viewport.scroll(action.delta);
							break;
						case "page":
							this.#viewport.scroll(action.delta * this.#viewport.visibleItems);
							break;
						case "halfPage":
							this.#viewport.scroll(action.delta * Math.max(1, Math.floor(this.#viewport.visibleItems / 2)));
							break;
						case "boundary":
							// Layout clamps End to the last full window.
							this.#viewport.setTop(action.edge === "first" ? 0 : Number.MAX_SAFE_INTEGER);
							break;
					}
				}
			}
			return true;
		}
		if (data !== "?") return false;
		this.#open = true;
		this.#viewport?.setTop(0);
		this.keys?.reset();
		return true;
	}

	describe(): NativeNode {
		return node(
			"card",
			{
				head: getMenuSearchVimMode()
					? t("tui.components.vim_help.title")
					: t("overlays.menu_hints.navigation_title"),
				role: "omp.menu.vim-help",
			},
			[col(this.#explanations().map(line => node("text", { spans: [span(line)] })))],
		);
	}

	#explanations(): string[] {
		const extra = this.extra;
		if (!getMenuSearchVimMode()) {
			return [
				t("overlays.menu_hints.navigation_title"),
				"",
				t("overlays.menu_hints.previous_next_row"),
				t("overlays.menu_hints.pane_navigation"),
				t("overlays.menu_hints.first_last_item"),
				t("overlays.menu_hints.page_navigation"),
				t("overlays.menu_hints.context_navigation"),
				t("overlays.menu_hints.search_select_return"),
				...(extra ? [extra] : []),
				"",
				t("tui.components.vim_help.return"),
			];
		}
		const explanations = [t("tui.components.vim_help.title"), ""];
		if (this.vim.includes("j") || this.vim.includes("k")) explanations.push(t("tui.components.vim_help.rows"));
		if (this.vim.includes("h") || this.vim.includes("l")) explanations.push(t("tui.components.vim_help.horizontal"));
		if (this.vim.includes("gg")) explanations.push(t("tui.components.vim_help.boundaries"));
		if (this.vim.includes("u") || this.vim.includes("d")) explanations.push(t("tui.components.vim_help.half_page"));
		if (this.vim.includes("e") || this.vim.includes("y")) explanations.push(t("tui.components.vim_help.scroll"));
		if (this.vim.includes("Pg") || this.vim.includes("gg")) explanations.push(t("tui.components.vim_help.page"));
		if (extra) explanations.push(extra);
		explanations.push("", t("tui.components.vim_help.return"));
		return explanations;
	}

	render(lines: readonly string[], width: number): string[] {
		if (!this.#open || width < 6 || (this.#viewport && lines.length < 3)) return [...lines];
		const boxWidth = Math.min(width, 64);
		const innerWidth = boxWidth - 4;
		const explanations = this.#explanations();
		let contents = explanations.flatMap(line => (line ? wrapTextWithAnsi(line, innerWidth) : [""]));
		if (this.#viewport) {
			// Each wrapped visual line is a viewport item, so page motions count rows.
			const { startIndex, endIndex } = this.#viewport.layout(contents.map(() => 1), 0, lines.length - 2);
			contents = contents.slice(startIndex, endIndex);
		}
		const box = [
			`┌${"─".repeat(boxWidth - 2)}┐`,
			...contents.map(line => `│ ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} │`),
			`└${"─".repeat(boxWidth - 2)}┘`,
		];
		const result = [...lines];
		while (result.length < box.length) result.push("");
		const top = Math.max(0, Math.floor((result.length - box.length) / 2));
		const left = Math.floor((width - boxWidth) / 2);
		for (let i = 0; i < box.length; i++)
			result[top + i] = compositeLineAt(result[top + i], box[i], left, boxWidth, width);
		return result;
	}
}
