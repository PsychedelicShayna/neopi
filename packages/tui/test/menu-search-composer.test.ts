import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { SelectList } from "../src/components/select-list";
import { ModelBrowser, buildBrowserItems, type ModelBrowserSource } from "../src/overlays/model-browser";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { initTheme } from "../src/theme";
import { getSelectListTheme } from "../src/theme/tui-adapters";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "../src/components/menu-navigation";

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});

beforeAll(async () => {
	await initTheme(false);
});

const source: ModelBrowserSource = {
	revision: 0,
	defaultThinkingLevel: "high",
	modelProviderOrder: [],
	knownRoleIds: [],
	mruOrder: [],
	modelPerf: new Map(),
	getModelRole: () => undefined,
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
};

function modelMenu(): ModelBrowser {
	const menu = new ModelBrowser(source);
	menu.setItems(
		buildBrowserItems(
			["alpha", "beta", "gamma"].map(id =>
				buildModel({
					id,
					name: id,
					provider: "test",
					api: "ollama-chat",
					baseUrl: "https://example.com",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
				}),
			),
		),
	);
	return menu;
}

test("model picker previews without activation, cancels drafts, and shares regex/glob/Vim editing", () => {
	const menu = modelMenu();
	const picked: string[] = [];
	menu.onActivate = item => {
		picked.push(item.id);
	};
	menu.handleInput("/");
	menu.handleInput("/^(alpha|beta)$");
	expect(menu.visibleCount).toBe(2);
	expect(picked).toEqual([]);
	menu.handleInput("\r");
	expect(menu.filterFocused).toBe(false);
	menu.handleInput("/");
	for (const key of ["\x1b", "d", "d", "i", "g*", "\x1b", "\x1b"]) menu.handleInput(key);
	expect(menu.query).toBe("/^(alpha|beta)$");
	expect(menu.visibleCount).toBe(2);
	menu.handleInput("/");
	for (const key of ["\x1b", "0", "D", "i", "g?mma"]) menu.handleInput(key);
	expect(menu.visibleCount).toBe(1);
	menu.handleInput("\x03");
	expect(menu.filterFocused).toBe(false);
	expect(menu.visibleCount).toBe(3);
	expect(picked).toEqual([]);
});

test("command-style SelectList uses live preview, Enter commit, invalid-regex retention and empty exit", () => {
	const menu = new SelectList(
		["alpha", "beta", "gamma"].map(value => ({ value, label: value })),
		5,
		getSelectListTheme(),
		{ search: "always" },
	);
	const picked: string[] = [];
	menu.onSelect = item => {
		picked.push(item.value);
	};
	menu.handleInput("/");
	menu.handleInput("/^(alpha|beta)");
	expect(menu.navigationState().filterDraft).toBe("/^(alpha|beta)");
	expect(menu.getSelectedItem()?.value).toBe("alpha");
	menu.handleInput("[");
	expect(menu.getSelectedItem()?.value).toBe("alpha");
	menu.handleInput("\x7f");
	menu.handleInput("\r");
	expect(menu.filterFocused).toBe(false);
	expect(picked).toEqual([]);
	menu.handleInput("/");
	for (const key of ["\x1b", "d", "d"]) menu.handleInput(key);
	menu.handleInput("\r");
	expect(menu.navigationState().filter).toBe("");
	expect(menu.filterFocused).toBe(false);
	menu.handleInput("G");
	expect(menu.getSelectedItem()?.value).toBe("gamma");
});
