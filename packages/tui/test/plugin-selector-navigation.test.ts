import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import { PluginSelectorComponent } from "../src/overlays/plugin-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function make(mode: "install" | "uninstall") {
	const selected: string[] = [];
	const selector = new PluginSelectorComponent(
		mode,
		1,
		[
			{ plugin: { name: "alpha", description: "First plugin" }, marketplace: "shop", scope: "user" },
			{ plugin: { name: "beta", description: "Second plugin" }, marketplace: "shop", scope: "user" },
		],
		new Set(),
		{ onSelect: name => selected.push(name), onCancel: () => {} },
	);
	return { selector, list: selector.getSelectList(), selected };
}

describe("plugin picker activation policy", () => {
	it("never uninstalls on normal Space, including when the child list owns focus", () => {
		const { list, selected } = make("uninstall");
		list.handleInput(" ");
		expect(selected).toEqual([]);
		list.handleInput("\r");
		expect(selected).toEqual(["alpha"]);
	});

	it("keeps Space literal in an uninstall filter", () => {
		const { list, selected } = make("uninstall");
		list.handleInput("/");
		for (const char of "alpha ") list.handleInput(char);
		expect(list.navigationState()).toMatchObject({ filterDraft: "alpha ", filterFocused: true });
		expect(selected).toEqual([]);
		list.handleInput("\x1b");
		expect(list.navigationState()).toMatchObject({ filterDraft: "alpha ", filterFocused: true });
		list.handleInput("\x1b");
		expect(list.filterFocused).toBe(false);
		list.handleInput(" ");
		expect(selected).toEqual([]);
	});

	it("cancels a pending g prefix when destructive Space is ignored", () => {
		const { list, selected } = make("uninstall");
		list.handleInput("G");
		list.handleInput("g");
		list.handleInput(" ");
		list.handleInput("g");
		expect(list.getSelectedItem()?.value).toBe("beta@shop#user");
		list.handleInput("g");
		expect(list.getSelectedItem()?.value).toBe("alpha@shop#user");
		expect(selected).toEqual([]);
	});

	it("retains nondestructive Space selection for installation", () => {
		const { list, selected } = make("install");
		list.handleInput(" ");
		expect(selected).toEqual(["alpha"]);
	});

	it("names native uninstall explicitly and still requires confirmation", () => {
		const { selector, selected } = make("uninstall");
		const root = selector.describe({
			cols: 100,
			dark: true,
			reduceMotion: false,
			supports: () => true,
			feature: () => true,
		});
		expect(root?.c?.[0]).toMatchObject({ k: "picker", p: { actions: [{ label: "Uninstall" }, { label: "Close" }] } });
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "confirm", mods: [] });
		expect(selected).toEqual(["alpha"]);
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
