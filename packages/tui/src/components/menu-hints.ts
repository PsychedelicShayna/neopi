import { matchesKey } from "../keys";
import { col, node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { compositeLineAt } from "../render/composite";
import type { Component } from "../tui";
import { replaceTabs, visibleWidth, wrapTextWithAnsi } from "../utils";

export const MENU_VIM_HINT = "hjkl gg/G C-u d e y";

/** Harness actions always win the space budget; motions are optional decoration. */
export function menuHintLines(harness: string, width: number, vim = MENU_VIM_HINT): string[] {
	if (width <= 0) return [];
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

	constructor(
		readonly vim = MENU_VIM_HINT,
		readonly extra = "",
	) {}

	get open(): boolean {
		return this.#open;
	}

	handleInput(data: string): boolean {
		if (this.#open) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "?") this.#open = false;
			return true;
		}
		if (data !== "?") return false;
		this.#open = true;
		return true;
	}

	describe(): NativeNode {
		return node("card", { head: "Vim navigation", role: "omp.menu.vim-help" }, [
			col(this.#explanations().map(line => node("text", { spans: [span(line)] }))),
		]);
	}

	#explanations(): string[] {
		const explanations = ["Vim navigation", ""];
		if (this.vim.includes("j") || this.vim.includes("k"))
			explanations.push("j / k: next / previous row (also arrow keys)");
		if (this.vim.includes("h") || this.vim.includes("l"))
			explanations.push("h / l: left / right (pane, branch or value)");
		if (this.vim.includes("gg")) explanations.push("gg / G: first / last item (also Home / End)");
		if (this.vim.includes("u") || this.vim.includes("d")) explanations.push("Ctrl-u / Ctrl-d: half page up / down");
		if (this.vim.includes("e") || this.vim.includes("y")) explanations.push("Ctrl-e / Ctrl-y: scroll view down / up");
		if (this.vim.includes("Pg") || this.vim.includes("gg")) explanations.push("PgUp / PgDn: full page up / down");
		if (this.extra) explanations.push(this.extra);
		explanations.push("", "? / Enter / Esc: return to menu");
		return explanations;
	}

	render(lines: readonly string[], width: number): string[] {
		if (!this.#open || width < 6) return [...lines];
		const boxWidth = Math.min(width, 64);
		const innerWidth = boxWidth - 4;
		const explanations = this.#explanations();
		const contents = explanations.flatMap(line => (line ? wrapTextWithAnsi(line, innerWidth) : [""]));
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
