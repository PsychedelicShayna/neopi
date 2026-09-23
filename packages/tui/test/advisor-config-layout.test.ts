import { describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type AdvisorConfigDeps,
	AdvisorConfigOverlayComponent,
	type WatchdogConfigDoc,
} from "../src/overlays/advisor-config";
import { getThemeByName, setThemeInstance } from "../src/theme";

describe("AdvisorConfigOverlayComponent", () => {
	const deps: AdvisorConfigDeps = {
		getDefaultSystemPrompt: () => "Bundled advisor baseline",
		getAvailableModels: () => [],
		browserSource: {
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
		defaultToolNames: new Set(["read", "grep", "glob"]),
		scopedModels: [],
		availableToolNames: ["read", "grep", "glob", "lsp", "web_search"],
	};
	const callbacks = {
		loadDoc: async () => ({ advisors: [] }),
		save: async () => {},
		close: () => {},
		requestRender: () => {},
		notify: () => {},
	};
	const strip = (lines: readonly string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	const make = (doc: WatchdogConfigDoc, extra?: Partial<AdvisorConfigDeps>): AdvisorConfigOverlayComponent =>
		new AdvisorConfigOverlayComponent({} as unknown as TUI, { ...deps, ...extra }, "project", doc, callbacks);
	const fullHeight = Math.max(14, process.stdout.rows || 40);

	it("edits the base prompt below Instructions, cancels without mutation, and resets only from the list", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const doc: WatchdogConfigDoc = {
			advisors: [{ name: "Prompt", instructions: "Append this", systemPrompt: "XY" }],
		};
		const overlay = make(doc);
		overlay.handleInput("\r");
		const detail = strip(overlay.render(200));
		expect(detail.indexOf("System prompt")).toBeGreaterThan(detail.indexOf("Instructions"));
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		overlay.handleInput("\x7f"); // Inside the editor: ordinary deletion, not reset.
		overlay.handleInput("\x1b");
		expect(doc.advisors[0].systemPrompt).toBe("XY");
		expect(strip(overlay.render(200))).not.toContain("● unsaved");

		overlay.handleInput("\r"); // Cancellation keeps System prompt selected.
		overlay.handleInput("\x7f");
		overlay.handleInput("\x11");
		expect(doc.advisors[0].systemPrompt).toBe("X");
		overlay.handleInput("\r");
		overlay.handleInput("\x7f");
		overlay.handleInput("\x11");
		expect(doc.advisors[0].systemPrompt).toBe("");

		overlay.handleInput("\x7f"); // On the list item: restore undefined/default.
		expect(doc.advisors[0].systemPrompt).toBeUndefined();
		expect(doc.advisors[0].instructions).toBe("Append this");
	});

	it("cancels the bundled base without an override and marks accepting it as an edit", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Prompt" }] };
		const overlay = make(doc);
		overlay.handleInput("\r");
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b");
		expect(doc.advisors[0].systemPrompt).toBeUndefined();
		expect(strip(overlay.render(200))).not.toContain("● unsaved");
		overlay.handleInput("\r");
		overlay.handleInput("\x11");
		expect(strip(overlay.render(200))).toContain("● unsaved");
	});

	it("saves an explicit empty base on the default advisor and removes it after keyboard reset", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const saved: WatchdogConfigDoc[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as unknown as TUI,
			deps,
			"project",
			{
				advisors: [{ name: "default", systemPrompt: "" }],
			},
			{
				...callbacks,
				save: async (_scope, doc) => {
					saved.push(structuredClone(doc));
				},
			},
		);
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Bun.sleep(0);
		expect(saved).toEqual([{ advisors: [{ name: "default", systemPrompt: "" }] }]);

		overlay.handleInput("\r");
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\x7f");
		overlay.handleInput("\x1b");
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Bun.sleep(0);
		expect(saved[1]).toEqual({ advisors: [] });
	});
	it("paints a full-screen split frame: roster sidebar + selected-advisor preview", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			instructions: "shared baseline",
			advisors: [
				{ name: "Architecture", model: "x-ai/grok-code-fast:high" },
				{ name: "Security", tools: ["read", "web_search"] },
			],
		});
		const frame = overlay.render(200);
		// Fills the screen top-to-bottom (the fix for the bottom-anchored frame
		// whose offset broke mouse hit-testing and wasted the upper space).
		expect(frame.length).toBe(fullHeight);
		const text = strip(frame);
		expect(text).toContain("Advisor configuration");
		expect(text).toContain("project");
		expect(text).toContain("Architecture");
		expect(text).toContain("Security");
		expect(text).toContain("+ Add advisor");
		expect(text).toContain("Save & apply");
		// Right preview reflects the highlighted (first) advisor.
		expect(text).toContain("x-ai/grok-code-fast:high");
		expect(text).toContain("read, grep, glob (default)");
	});

	it("renders an explicit no-tools advisor distinctly from the omitted default", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			advisors: [{ name: "Blank", tools: [] }],
		});

		const text = strip(overlay.render(200));
		expect(text.toLowerCase()).toContain("no tools");
		expect(text).not.toContain("read, grep, glob (default)");
	});

	it("moves the preview with keyboard selection and preserves an explicit tool set", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			advisors: [{ name: "Architecture" }, { name: "Security", tools: ["read", "web_search"] }],
		});
		overlay.render(200);
		overlay.handleInput("\x1b[B"); // arrow down → highlight Security
		expect(strip(overlay.render(200))).toContain("read, web_search");
	});

	it("opens an advisor's detail editor on a left click in the sidebar", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({ advisors: [{ name: "Architecture" }, { name: "Security" }] });
		// Render once so the frame geometry is recorded; the first advisor sits on
		// the first body row (0-based screen row 1 → SGR 1-based row 2).
		overlay.render(120);
		overlay.handleInput("\x1b[<0;4;2M"); // left-button press, col 4, row 2
		const text = strip(overlay.render(120));
		expect(text).toContain("Editing");
		expect(text).toContain("Architecture");
	});

	it("shows disabled advisors with a dim circle marker and toggles them in the detail editor", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		const overlay = make({
			advisors: [
				{ name: "Active", model: "x-ai/grok-code-fast:high" },
				{ name: "Disabled", model: "openai/gpt-4", enabled: false },
			],
		});
		const text = strip(overlay.render(200));
		// The list shows ● for enabled and ○ for disabled.
		expect(text).toContain("● Active");
		expect(text).toContain("○ Disabled");
		// The preview of the highlighted (first) advisor shows its enabled status.
		expect(text).toContain("● on");
	});
});
