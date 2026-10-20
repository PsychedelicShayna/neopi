import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "../src/tui";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import type { AdvisorConfigDeps, WatchdogConfigDoc } from "../src/overlays/advisor-config";
import { AdvisorScopeOverlayComponent, type AdvisorConfigFile } from "../src/overlays/advisor-scopes";
import { getThemeByName, setThemeInstance } from "../src/theme";

const deps: AdvisorConfigDeps = {
	getDefaultSystemPrompt: () => "Baseline",
	getAvailableModels: () => [],
	browserSource: {
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
	},
	defaultToolNames: new Set(["read"]),
	scopedModels: [],
	availableToolNames: ["read"],
};
const cx: DescribeContext = { cols: 200, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const strip = (overlay: AdvisorScopeOverlayComponent) =>
	overlay
		.render(240)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
const settle = () => Bun.sleep(0);

function fixture(userDoc: WatchdogConfigDoc = { advisors: [{ name: "User" }] }) {
	const files: AdvisorConfigFile[] = [
		{ path: "/user/WATCHDOG.yaml", scope: "user", doc: userDoc },
		{ path: "/project/WATCHDOG.yml", scope: "project", doc: { advisors: [{ name: "Root", enabled: false }] } },
		{ path: "/project/nested/WATCHDOG.yml", scope: "project", doc: { advisors: [{ name: "Nested" }] } },
	];
	const disk = new Map(files.map(file => [file.path, structuredClone(file.doc)]));
	const writes: string[] = [];
	let applies = 0;
	let closes = 0;
	const overlay = new AdvisorScopeOverlayComponent({} as TUI, deps, files, {
		loadFile: async path => structuredClone(disk.get(path)!),
		saveFile: async (path, doc) => {
			disk.set(path, structuredClone(doc));
			writes.push(path);
		},
		apply: async () => {
			applies++;
		},
		close: () => {
			closes++;
		},
		requestRender: () => {},
		notify: () => {},
	});
	const action = (act: string) => overlay.handleNativeEvent({ type: "action", key: "", act, mods: [] });
	const select = (item: string) => overlay.handleNativeEvent({ type: "select", key: "", item });
	const activate = (item: string) => overlay.handleNativeEvent({ type: "activate", key: "", item });
	return { overlay, files, disk, writes, action, select, activate, applies: () => applies, closes: () => closes };
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Missing theme");
	setThemeInstance(theme);
});

describe("advisor file scopes", () => {
	it("lists user and both project files in load order with full paths and selected advisor states", () => {
		const { overlay, files, select } = fixture();
		const props = overlay.describe(cx).p as TspPickerProps;
		expect(props.items?.slice(0, 3).map(item => item.detail)).toEqual(files.map(file => file.path));
		expect(strip(overlay)).toContain("● enabled User");
		select(files[1].path);
		expect(strip(overlay)).toContain("○ disabled Root");
		select(files[2].path);
		expect(strip(overlay)).toContain("● enabled Nested");
	});

	it("previews the hovered file without entering its editor", () => {
		const { overlay } = fixture();
		const rendered = overlay.render(240);
		const line = rendered.findIndex(value => value.includes("/project/WATCHDOG.yml"));
		expect(line).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<35;5;${line + 1}M`);
		expect(strip(overlay)).toContain("○ disabled Root");
		expect(strip(overlay)).toContain("Disable all active advisors");
	});

	it("persists a file toggle without changing entries, applies on request, and restores on toggle", async () => {
		const f = fixture();
		f.overlay.handleInput(" ");
		await settle();
		expect(f.disk.get(f.files[0].path)).toEqual({ enabled: false, advisors: [{ name: "User" }] });
		expect(f.applies()).toBe(0);
		f.overlay.handleInput("a");
		await settle();
		expect(f.applies()).toBe(1);
		f.overlay.handleInput(" ");
		await settle();
		expect(f.disk.get(f.files[0].path)?.enabled).toBeUndefined();
		expect(f.writes).toEqual([f.files[0].path, f.files[0].path]);
	});

	it("opens a disabled nested file and clones there without a user/project switch", async () => {
		const f = fixture();
		f.select(f.files[2].path);
		f.action("toggle");
		await settle();
		f.action("confirm");
		await settle();
		expect(strip(f.overlay)).toContain("/project/nested/WATCHDOG.yml");
		expect(strip(f.overlay)).not.toContain("Scope: project");
		f.overlay.handleInput("c");
		f.overlay.handleInput("\x1b");
		f.overlay.handleInput("s");
		await settle();
		expect(f.disk.get(f.files[2].path)?.advisors.map(advisor => advisor.name)).toEqual(["Nested", "Nested (copy)"]);
		expect(f.disk.get(f.files[2].path)?.enabled).toBe(false);
		expect(f.disk.get(f.files[0].path)?.advisors).toEqual([{ name: "User" }]);
	});

	it("bulk disables, enables and inverts the effective states across all files", async () => {
		const f = fixture();
		f.activate("disable");
		await settle();
		expect([...f.disk.values()].every(doc => doc.enabled === false)).toBe(true);
		expect([...f.disk.values()].flatMap(doc => doc.advisors).every(advisor => advisor.enabled === false)).toBe(true);
		f.action("toggle"); // First selected row remains the disable action, not a file.
		await settle();
		f.activate("enable");
		await settle();
		expect(
			[...f.disk.values()].every(
				doc => doc.enabled !== false && doc.advisors.every(advisor => advisor.enabled !== false),
			),
		).toBe(true);
		f.activate("invert");
		await settle();
		expect([...f.disk.values()].flatMap(doc => doc.advisors).every(advisor => advisor.enabled === false)).toBe(true);
		expect(f.applies()).toBe(0);
	});

	it("keeps filter text literal, Esc returns to navigation, and menu history restores the exact file editor", async () => {
		const f = fixture();
		f.overlay.handleInput("/");
		f.overlay.handleInput("j");
		f.overlay.handleInput(" ");
		expect((f.overlay.describe(cx).p as TspPickerProps).query).toBe("j ");
		f.overlay.handleInput("\x1b");
		expect(f.closes()).toBe(0);
		f.select(f.files[1].path);
		f.action("confirm");
		await settle();
		const snapshot = f.overlay.navigationSnapshot();
		f.overlay.handleInput("\x1b");
		expect(strip(f.overlay)).toContain("Advisor configuration · files");
		f.overlay.restoreNavigation(snapshot);
		expect(strip(f.overlay)).toContain("/project/WATCHDOG.yml");
		expect(strip(f.overlay)).toContain("Root");
	});

	it("bulk switches also disable or invert an implicit default without explicit advisor rows", async () => {
		const f = fixture({ advisors: [] });
		f.activate("invert");
		await settle();
		expect(f.disk.get(f.files[0].path)?.enabled).toBe(false);
		f.activate("invert");
		await settle();
		expect(f.disk.get(f.files[0].path)?.enabled).toBeUndefined();
		f.activate("disable");
		await settle();
		expect(f.disk.get(f.files[0].path)?.enabled).toBe(false);
	});

	it("scrolls long file previews without moving the file selection and restores the reading position", () => {
		const { overlay } = fixture({ advisors: Array.from({ length: 100 }, (_, i) => ({ name: `Reader-${i}` })) });
		expect(strip(overlay)).not.toContain("Reader-99");
		overlay.handleInput("l");
		overlay.handleInput("G");
		expect(strip(overlay)).toContain("Reader-99");
		const snapshot = overlay.navigationSnapshot();
		overlay.handleInput("g");
		overlay.handleInput("g");
		overlay.restoreNavigation(snapshot);
		expect(strip(overlay)).toContain("Reader-99");
		overlay.handleInput("h");
		overlay.handleInput("j");
		expect(strip(overlay)).toContain("○ disabled Root");
	});
});
