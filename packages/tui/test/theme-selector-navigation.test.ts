import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, expect, test, beforeEach, afterEach } from "bun:test";
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

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
