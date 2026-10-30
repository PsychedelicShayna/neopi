import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { createSettingsHost } from "../src/config/settings-ui";
import { createPluginSettingsHost } from "../src/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";

let root: string;
let store: Settings;
let selector: SettingsSelectorComponent;
const requestRender = vi.fn();

function page(): TspPrefsProps {
	const node = selector.describe({ cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true });
	if (node.k !== "prefs" || !node.p) throw new Error("Expected the Settings prefs page");
	return node.p;
}

function row(id: string) {
	const found = page().sections.flatMap(section => section.rows).find(item => item.id === id);
	if (!found) throw new Error(`Missing Settings row ${id}`);
	return found;
}

async function reload(theme: string, screenshotDir = "/screenshots"): Promise<void> {
	await Bun.write(path.join(root, "profile", "config.yml"), `theme:\n  dark: ${theme}\nbrowser:\n  screenshotDir: ${screenshotDir}\n`);
	await store.applySettingsReload();
}

beforeAll(async () => { await initTheme(); });
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.homedir(), ".cache/npi-canary/settings-open-refresh-"));
	await fs.mkdir(path.join(root, "project"), { recursive: true });
	await Bun.write(path.join(root, "profile", "config.yml"), "theme:\n  dark: dark\nbrowser:\n  screenshotDir: /screenshots\n");
	store = await Settings.loadIsolated({ cwd: path.join(root, "project"), agentDir: path.join(root, "profile") });
	requestRender.mockClear();
	selector = new SettingsSelectorComponent({
		settings: createSettingsHost(store),
		plugins: createPluginSettingsHost(path.join(root, "project")),
		availableThemes: ["dark", "light", "titanium"],
		availableThinkingLevels: [], thinkingLevel: undefined, providers: [], requestRender,
	}, {
		onChange: () => {}, onCancel: () => {},
		onApply: async () => { await store.applySettingsReload(); return "Applied"; },
	});
});
afterEach(async () => {
	selector?.dispose();
	store?.cancelPendingSaves();
	await fs.rm(root, { recursive: true, force: true });
});

describe("open Settings reloads", () => {
	it("updates rows repeatedly while retaining selection, scope, and search draft", async () => {
		selector.handleNativeEvent({ type: "select", key: "", item: "theme.dark" });
		await reload("light");
		expect(row("theme.dark").control).toMatchObject({ value: "light" });
		expect(page().focus).toBe("theme.dark");
		expect(page().title).toContain("[GLOBAL]");
		selector.handleInput("/");
		for (const char of "dark theme") selector.handleInput(char);
		const search = { query: page().query, cursor: page().cursor };
		await reload("titanium");
		expect(row("theme.dark").control).toMatchObject({ value: "titanium" });
		expect(page()).toMatchObject(search);
		expect(requestRender).toHaveBeenCalled();
	});

	it("preserves a theme picker's highlighted draft and marks the edited row", async () => {
		selector.handleNativeEvent({ type: "action", key: "", act: "edit", value: "theme.dark" });
		selector.handleInput("\x1b[B");
		const editing = page().editing;
		expect(editing).toMatchObject({ row: "theme.dark", option: "light" });
		await reload("titanium");
		expect(page().editing).toEqual(editing);
		expect(row("theme.dark").warning).toContain("changed elsewhere");
		expect(page().lead).toContain("your edit is preserved");
		expect(selector.render(120).join("\n")).toContain("changed elsewhere");
		selector.handleInput("\x1b");
		expect(page().editing).toBeNull();
		expect(row("theme.dark").control).toMatchObject({ value: "titanium" });
		expect(row("theme.dark").warning).toBeUndefined();
	});

	it("preserves a text draft and cursor when that row changes underneath", async () => {
		selector.handleInput("/");
		for (const char of "/browser\\.screenshotDir/") selector.handleInput(char);
		selector.handleInput("\r"); // Confirm the search without activating its result.
		expect(page()).toMatchObject({ focus: "browser.screenshotDir", editing: null });
		selector.handleInput("\r"); // Open the matched text setting.
		selector.handleInput("\x15");
		selector.handleInput("\x1b[200~/my/draft\x1b[201~");
		selector.handleInput("\x1b[D");
		const editing = page().editing;
		expect(editing).toMatchObject({ row: "browser.screenshotDir", draft: "/my/draft", cursor: 8 });
		await reload("light", "/other/screenshots");
		expect(page().editing).toEqual(editing);
		expect(row("browser.screenshotDir").warning).toContain("changed elsewhere");
	});

	it("refreshes after this session's Apply and unsubscribes when disposed", async () => {
		await Bun.write(path.join(root, "profile", "config.yml"), "theme:\n  dark: light\n");
		selector.handleInput("\x1b[17~");
		for (let i = 0; i < 100 && !page().lead?.includes("Applied"); i++) await Bun.sleep(5);
		expect(page().lead).toContain("Applied");
		expect(row("theme.dark").control).toMatchObject({ value: "light" });
		selector.dispose();
		requestRender.mockClear();
		await reload("titanium");
		expect(requestRender).not.toHaveBeenCalled();
	});
});
