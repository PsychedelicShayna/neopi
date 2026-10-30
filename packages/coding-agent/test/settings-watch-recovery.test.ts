import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { cfgThemeDark } from "../src/modes/settings";
import { AgentStorage } from "../src/session/agent-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let state: SettingsTestState;
let dir: string;
let settings: Settings | undefined;
beforeEach(async () => {
	state = beginSettingsTest();
	delete process.env.PI_CONFIG_FILES;
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-watch-"));
});
afterEach(async () => {
	settings?.cancelPendingSaves();
	settings = undefined;
	AgentStorage.close();
	restoreSettingsTestState(state);
	await fs.rm(dir, { recursive: true, force: true });
});
async function waitForTheme(theme: string): Promise<void> {
	const deadline = Date.now() + 3500;
	while (cfgThemeDark.get(settings!) !== theme) {
		if (Date.now() > deadline) throw new Error(`Theme never became ${theme}; still ${cfgThemeDark.get(settings!)}`);
		await Bun.sleep(20);
	}
}
test("continues applying every atomic settings edit after the watched directory is replaced", async () => {
	const agentDir = path.join(dir, "profile");
	const file = path.join(agentDir, "config.yml");
	await Bun.write(file, "theme:\n  dark: titanium\n");
	settings = await Settings.init({ cwd: dir, agentDir });
	settings.startWatching();
	await Bun.sleep(300);
	await fs.rename(agentDir, path.join(dir, "old-profile"));
	for (const theme of ["anthracite", "dark", "titanium"]) {
		await Bun.write(`${file}.next`, `theme:\n  dark: ${theme}\n`);
		await fs.rename(`${file}.next`, file);
		await waitForTheme(theme);
		expect(cfgThemeDark.get(settings)).toBe(theme);
	}
}, 15000);

test("keeps applying successive edits when filesystem notifications are dropped", async () => {
	vi.spyOn(fsSync, "watch").mockImplementation(() => {
		const watcher = new EventEmitter();
		Object.assign(watcher, { close: () => {} });
		return watcher as fsSync.FSWatcher;
	});
	const agentDir = path.join(dir, "profile");
	const file = path.join(agentDir, "config.yml");
	await Bun.write(file, "theme:\n  dark: titanium\n");
	settings = await Settings.init({ cwd: dir, agentDir });
	settings.startWatching();
	await Bun.sleep(1300);
	for (const theme of ["anthracite", "dark", "titanium"]) {
		await Bun.write(`${file}.next`, `theme:\n  dark: ${theme}\n`);
		await fs.rename(`${file}.next`, file);
		await waitForTheme(theme);
		expect(cfgThemeDark.get(settings)).toBe(theme);
	}
}, 15000);

test("rearms a failed watcher and preserves project shadowing of repeated global edits", async () => {
	const originalWatch = fsSync.watch;
	const watchers: fsSync.FSWatcher[] = [];
	vi.spyOn(fsSync, "watch").mockImplementation(((...args: Parameters<typeof fsSync.watch>) => {
		const watcher = originalWatch(...args);
		watchers.push(watcher);
		return watcher;
	}) as typeof fsSync.watch);
	const agentDir = path.join(dir, "profile");
	const file = path.join(agentDir, "config.yml");
	await Bun.write(file, "theme:\n  dark: titanium\n");
	await Bun.write(path.join(dir, ".omp/config.yml"), "theme:\n  dark: anthracite\n");
	settings = await Settings.init({ cwd: dir, agentDir });
	settings.startWatching();
	await Bun.sleep(300);
	for (const watcher of watchers) watcher.emit("error", new Error("watch interrupted"));
	const initialCount = watchers.length;
	await Bun.write(file, "theme:\n  dark: dark\n");
	await Bun.sleep(1500);
	expect(watchers.length).toBeGreaterThan(initialCount);
	expect(settings.getGlobalSettings().theme).toEqual({ dark: "dark" });
	expect(cfgThemeDark.get(settings)).toBe("anthracite");
	await fs.rm(path.join(dir, ".omp/config.yml"));
	await waitForTheme("dark");
});
