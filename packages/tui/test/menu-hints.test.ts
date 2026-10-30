import { describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list";
import { visibleWidth } from "../src/utils";

const theme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: "> ",
	hint: text => text,
};
function settings(onCancel = () => {}) {
	return new SettingsList([{ id: "one", label: "One", currentValue: "on" }], 5, theme, () => {}, onCancel);
}

describe("menu hint priority", () => {
	it("keeps every Settings action at narrow widths and drops motions first", () => {
		const lines = settings().render(34);
		const text = lines.join("\n");
		for (const action of ["edit", "cycle", "sections", "/ search", "close", "? help"]) expect(text).toContain(action);
		expect(text).not.toContain("C-u d e y");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
	});
	it("compresses Settings motions against the right edge at wide widths", () => {
		const lines = settings().render(160);
		const hint = lines.find(line => line.endsWith("hjkl gg/G C-u d e y"));
		expect(hint).toBeDefined();
		expect(visibleWidth(hint!)).toBe(160);
		expect(hint!.indexOf("edit")).toBeLessThan(hint!.indexOf("hjkl"));
		expect(hint).not.toContain("half page");
	});
	it("opens Vim help without closing Settings and returns on Escape", () => {
		let closed = false;
		const list = settings(() => {
			closed = true;
		});
		list.handleInput("?");
		expect(list.render(80).join("\n")).toContain("Vim navigation");
		list.handleInput("\x1b");
		expect(closed).toBe(false);
		expect(list.render(80).join("\n")).not.toContain("Vim navigation");
		list.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
