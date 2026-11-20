import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { TUI } from "../src/tui";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../src/native/node";
import type {
	AdvisorConfig,
	AdvisorConfigCallbacks,
	AdvisorConfigDeps,
	WatchdogConfigDoc,
} from "../src/overlays/advisor-config";
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
function pickerProps(node: NativeNode): TspPickerProps {
	if (node.k === "picker") return node.p!;
	for (const child of node.c ?? []) {
		if ("k" in child) {
			try {
				return pickerProps(child);
			} catch {}
		}
	}
	throw new Error("No picker");
}

function fixture(
	userDoc: WatchdogConfigDoc = { advisors: [{ name: "User" }] },
	generateAdvisor?: AdvisorConfigCallbacks["generateAdvisor"],
) {
	const files: AdvisorConfigFile[] = [
		{ path: "/user/WATCHDOG.yaml", scope: "user", doc: userDoc },
		{ path: "/project/WATCHDOG.yml", scope: "project", doc: { advisors: [{ name: "Root", enabled: false }] } },
		{ path: "/project/nested/WATCHDOG.yml", scope: "project", doc: { advisors: [{ name: "Nested" }] } },
		{ path: "/project/.omp/WATCHDOG.yml", scope: "project-omp", doc: { advisors: [{ name: "Native" }] } },
		{ path: "/sessions/one/WATCHDOG.yml", scope: "session", doc: { advisors: [{ name: "Session" }] } },
	];
	const disk = new Map(files.map(file => [file.path, structuredClone(file.doc)]));
	const writes: string[] = [];
	let applies = 0;
	let closes = 0;
	const prompts: string[] = [];
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
		copyPrompt: prompt => {
			prompts.push(prompt);
		},
		generateAdvisor,
	});
	overlay.handleInput("j"); // Leave the first, initially focused scope row.
	const action = (act: string) => overlay.handleNativeEvent({ type: "action", key: "", act, mods: [] });
	const select = (item: string) => overlay.handleNativeEvent({ type: "select", key: "", item });
	const activate = (item: string) => overlay.handleNativeEvent({ type: "activate", key: "", item });
	return {
		overlay,
		files,
		disk,
		writes,
		prompts,
		action,
		select,
		activate,
		applies: () => applies,
		closes: () => closes,
	};
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Missing theme");
	setThemeInstance(theme);
});

describe("advisor file scopes", () => {
	it("cycles every scope with h/l and arrows immediately and labels both project sources", () => {
		const { overlay } = fixture();
		expect(strip(overlay)).toContain("● enabled User");
		overlay.handleInput("k");
		overlay.handleInput("l");
		expect(
			pickerProps(overlay.describe(cx))
				.items?.map(item => item.detail)
				.filter(Boolean),
		).toContain("/project/WATCHDOG.yml");
		expect(strip(overlay)).toContain("○ disabled Root");
		overlay.handleInput("\x1b[C");
		expect(strip(overlay)).toContain("/project/.omp/WATCHDOG.yml");
		expect(strip(overlay)).toContain("● enabled Native");
		overlay.handleInput("l");
		expect(strip(overlay)).toContain("● enabled Session");
		overlay.handleInput("\x1b[D");
		expect(strip(overlay)).toContain("● enabled Native");
		overlay.handleInput("h");
		expect(strip(overlay)).toContain("○ disabled Root");
	});

	it("previews the hovered file without entering its editor", () => {
		const { overlay } = fixture();
		overlay.handleInput("k");
		overlay.handleInput("l");
		overlay.handleInput("j");
		const rendered = overlay.render(240);
		const line = rendered.findIndex(value => value.includes("/project/WATCHDOG.yml"));
		expect(line).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<35;5;${line + 1}M`);
		expect(strip(overlay)).toContain("○ disabled Root");
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
		f.overlay.handleInput("k");
		f.overlay.handleInput("l");
		f.overlay.handleInput("j");
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

	it("bulk actions affect only the selected scope's entry flags, including disabled files", async () => {
		const f = fixture({ enabled: true, advisors: [{ name: "User" }] });
		const root = f.disk.get(f.files[1].path)!;
		root.enabled = false;
		root.advisors.push({ name: "Root enabled", enabled: true });
		f.disk.get(f.files[2].path)!.enabled = true;
		const untouched = [0, 3, 4].map(index => structuredClone(f.disk.get(f.files[index].path)));
		f.overlay.handleInput("k");
		f.overlay.handleInput("l"); // Project root, retained when an action row is selected.
		f.overlay.handleInput("j");
		f.activate("invert");
		await settle();
		expect(f.disk.get(f.files[1].path)).toEqual({
			enabled: false,
			advisors: [
				{ name: "Root", enabled: undefined },
				{ name: "Root enabled", enabled: false },
			],
		});
		expect(f.disk.get(f.files[2].path)).toEqual({
			enabled: true,
			advisors: [{ name: "Nested", enabled: false }],
		});
		f.activate("disable");
		await settle();
		expect(
			[1, 2].flatMap(index => f.disk.get(f.files[index].path)!.advisors).map(advisor => advisor.enabled),
		).toEqual([false, false, false]);
		f.action("toggle"); // The action row is not a whole-file toggle target.
		await settle();
		f.activate("enable");
		await settle();
		expect(
			[1, 2].flatMap(index => f.disk.get(f.files[index].path)!.advisors).map(advisor => advisor.enabled),
		).toEqual([undefined, undefined, undefined]);
		expect(f.disk.get(f.files[1].path)?.enabled).toBe(false);
		expect(f.disk.get(f.files[2].path)?.enabled).toBe(true);
		expect([0, 3, 4].map(index => f.disk.get(f.files[index].path))).toEqual(untouched);
		expect(f.writes).toEqual([1, 2, 1, 1, 2].map(index => f.files[index].path));
		expect(f.applies()).toBe(0);
		// Moving to a different scope changes the bulk target, not the previous selection.
		f.overlay.handleNativeEvent({ type: "select", key: "scope/Scope", item: "2" });
		f.activate("disable");
		await settle();
		expect(f.disk.get(f.files[3].path)?.advisors).toEqual([{ name: "Native", enabled: false }]);
		expect(f.writes.at(-1)).toBe(f.files[3].path);
		expect(f.disk.get(f.files[1].path)?.advisors[0].enabled).toBeUndefined();
	});

	it("keeps filter text literal, Esc returns to navigation, and menu history restores the exact file editor", async () => {
		const f = fixture();
		f.overlay.handleInput("/");
		f.overlay.handleInput("j");
		f.overlay.handleInput(" ");
		expect(pickerProps(f.overlay.describe(cx)).query).toBe("j ");
		f.overlay.handleInput("\x1b");
		expect(f.closes()).toBe(0);
		expect(pickerProps(f.overlay.describe(cx)).query).toBe("j ");
		f.overlay.handleInput("\x1b"); // Normal -> navigation, cancelling the draft.
		expect(pickerProps(f.overlay.describe(cx)).query).toBe("");
		f.overlay.handleInput("k");
		f.overlay.handleInput("l");
		f.overlay.handleInput("j");
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

	it("bulk actions preserve implicit defaults and whole-file gates without explicit entries", async () => {
		const f = fixture({ enabled: true, advisors: [] });
		for (const action of ["invert", "disable", "enable"]) {
			f.activate(action);
			await settle();
			expect(f.disk.get(f.files[0].path)).toEqual({ enabled: true, advisors: [] });
		}
		expect(f.writes).toEqual([]);
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
		overlay.handleInput("k");
		overlay.handleInput("l");
		overlay.handleInput("j");
		expect(strip(overlay)).toContain("○ disabled Root");
	});

	it("copies an advisor into another scope with a new identity and copies its prompt", async () => {
		const f = fixture({ advisors: [{ id: "original", name: "User", instructions: "Review changes" }] });
		f.action("confirm");
		await settle();
		f.overlay.handleNativeEvent({ type: "action", key: "", act: "edit", value: "copyPrompt", mods: [] });
		await settle();
		expect(f.prompts).toEqual(["Baseline\n\nReview changes"]);
		f.overlay.handleNativeEvent({ type: "action", key: "", act: "edit", value: "copy", mods: [] });
		await settle();
		f.overlay.handleInput("\r");
		await settle();
		const copied = f.disk.get(f.files[1].path)?.advisors.find(advisor => advisor.name === "User (copy)");
		expect(copied?.instructions).toBe("Review changes");
		expect(copied?.id).toBeDefined();
		expect(copied?.id).not.toBe("original");
		expect(f.disk.get(f.files[0].path)?.advisors).toHaveLength(1);
		f.overlay.handleInput("\x1b");
		f.overlay.handleInput("\x1b");
		f.overlay.handleInput("\x1b");
		expect(f.closes()).toBe(1);
	});

	it("keeps a generated advisor editable and only persists it on save", async () => {
		const f = fixture(undefined, async () => ({ name: "User", instructions: "A combined review", tools: ["read"] }));
		f.action("confirm");
		await settle();
		f.overlay.handleNativeEvent({ type: "action", key: "", act: "generate", mods: [] });
		await settle();
		f.overlay.handleInput("\r");
		f.overlay.handleInput("G");
		f.overlay.handleInput("\r");
		f.overlay.handleInput("Keep it concise");
		f.overlay.handleInput("\x11");
		await settle();
		expect(strip(f.overlay)).toContain("User 2");
		expect(f.writes).toEqual([]);
		f.overlay.handleInput("\x1b");
		f.overlay.handleInput("s");
		await settle();
		expect(f.disk.get(f.files[0].path)?.advisors).toEqual([
			{ name: "User" },
			{ id: expect.any(String), name: "User 2", instructions: "A combined review", tools: ["read"] },
		]);
		expect(f.applies()).toBe(0);
		expect(f.writes).toEqual([f.files[0].path]);

		f.overlay.handleInput("a");
		await settle();
		expect(f.applies()).toBe(1);
		expect(f.writes).toEqual([f.files[0].path]);

		f.overlay.handleInput("a");
		await settle();
		expect(f.applies()).toBe(1);
		expect(f.writes).toEqual([f.files[0].path]);
	});

	it("generates from selected advisors and Esc cancels without accepting a late result", async () => {
		const result = Promise.withResolvers<AdvisorConfig>();
		let received: { bases: readonly AdvisorConfig[]; comment: string; signal: AbortSignal } | undefined;
		const f = fixture(undefined, async (bases, comment, signal) => {
			received = { bases, comment, signal };
			return result.promise;
		});
		f.action("confirm");
		await settle();
		f.overlay.handleNativeEvent({ type: "action", key: "", act: "generate", mods: [] });
		await settle();
		expect(strip(f.overlay)).toContain("Generate from selected advisors");
		f.overlay.handleInput("\r");
		f.overlay.handleInput("G");
		f.overlay.handleInput("\r");
		expect(strip(f.overlay)).toContain("Describe the new advisor");
		f.overlay.handleInput("Combine their strengths");
		f.overlay.handleInput("\x11");
		expect(received?.bases.map(base => base.name)).toEqual(["User"]);
		expect(received?.comment).toBe("Combine their strengths");
		expect(strip(f.overlay)).toContain("Generating advisor");
		f.overlay.handleInput("\x1b");
		expect(received?.signal.aborted).toBe(true);
		result.resolve({ name: "Late result" });
		await settle();
		expect(strip(f.overlay)).not.toContain("Late result");
		expect(f.writes).toEqual([]);
		f.overlay.handleInput("\x1b");
		f.overlay.handleInput("\x1b");
		expect(f.closes()).toBe(1);
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
