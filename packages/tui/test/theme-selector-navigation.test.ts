import { beforeAll, expect, test } from "bun:test";
import { getLocale, setLocale } from "@oh-my-pi/pi-utils/i18n";
import { ThemeSelectorComponent } from "../src/overlays/theme-selector";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme(false);
});

test("history restores the theme cursor without applying its preview", () => {
	const previews: string[] = [];
	const applied: string[] = [];
	const selector = new ThemeSelectorComponent(
		"dark",
		["dark", "light"],
		name => {
			applied.push(name);
		},
		() => {},
		name => {
			previews.push(name);
		},
	);
	const first = selector.navigationSnapshot();
	selector.getSelectList().handleInput("j");
	expect(previews).toEqual(["light"]);
	const second = selector.navigationSnapshot();
	selector.restoreNavigation(first);
	expect(selector.getSelectList().getSelectedItem()?.value).toBe("dark");
	selector.restoreNavigation(second);
	expect(selector.getSelectList().getSelectedItem()?.value).toBe("light");
	expect(previews).toEqual(["light"]);
	expect(applied).toEqual([]);
	selector.getSelectList().handleInput("k");
	expect(previews).toEqual(["light", "dark"]);
});

test("localizes theme picker copy while applying the original theme id", () => {
	const previous = getLocale();
	try {
		setLocale("es");
		const applied: string[] = [];
		const selector = new ThemeSelectorComponent("dark", ["dark", "light"], name => applied.push(name), () => {}, () => {});
		const output = Bun.stripANSI(selector.render(80).join("\n"));
		expect(output).toContain("Tema");
		expect(output).toContain("(actual)");
		selector.getSelectList().handleInput("\n");
		expect(applied).toEqual(["dark"]);
	} finally {
		setLocale(previous);
	}
});
