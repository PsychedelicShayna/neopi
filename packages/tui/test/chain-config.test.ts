import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type ChainConfigCallbacks,
	type ChainConfigDeps,
	ChainConfigOverlayComponent,
} from "../src/overlays/chain-config";
import type { ChainConfigScope, ChainsConfigDoc } from "../src/overlays/chain-types";
import { getThemeByName, setThemeInstance } from "../src/theme";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { KeybindingsManager } from "../src/app-keybindings";
import { setKeybindings } from "../src/keybindings";

const deps: ChainConfigDeps = {
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
	scopedModels: [],
	availableToolNames: ["read", "grep", "web_search"],
	defaultSystemPrompt: "default",
};

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const CTRL_Q = "\x11";
const HOME = "\x1b[H";
const DELETE = "\x1b[3~";

/** Rendered frame text without ANSI styling. */
function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

interface Harness {
	overlay: ChainConfigOverlayComponent;
	saved: ChainsConfigDoc[];
	notices: string[];
	loaded: ChainConfigScope[];
	press: (...keys: string[]) => void;
	/** Replace an Input's prefilled value, then type `text`. */
	retype: (text: string) => void;
}

function makeOverlay(
	doc: ChainsConfigDoc,
	overrides?: Partial<ChainConfigCallbacks>,
	dependencyOverrides: Partial<ChainConfigDeps> = {},
): Harness {
	const saved: ChainsConfigDoc[] = [];
	const notices: string[] = [];
	const loaded: ChainConfigScope[] = [];
	const overlay = new ChainConfigOverlayComponent(
		{} as unknown as TUI,
		{ ...deps, ...dependencyOverrides },
		"project",
		doc,
		{
			loadDoc: async scope => {
				loaded.push(scope);
				return { chains: [] };
			},
			save: async (_scope, savedDoc) => {
				saved.push(structuredClone(savedDoc));
			},
			close: () => {},
			requestRender: () => {},
			notify: message => notices.push(message),
			...overrides,
		},
	);
	const press = (...keys: string[]): void => {
		for (const key of keys) overlay.handleInput(key);
	};
	const retype = (text: string): void => {
		press("\x15"); // Ctrl+U clears the prefilled name.
		press(text);
	};
	return { overlay, saved, notices, loaded, press, retype };
}

/** Walk the chain-detail list down to "+ Add step" and create a step with `name` + `prompt`. */
function addStep(harness: Harness, stepRows: number, name: string, prompt: string): void {
	const { press, retype } = harness;
	// Chain detail rows: Name, Description, <steps…>, + Add step.
	press(HOME);
	for (let i = 0; i < 2 + stepRows; i++) press(DOWN);
	press(ENTER); // + Add step → name input
	retype(name);
	press(ENTER); // create step, open step detail
	// Step detail rows (no model set): Name, Model, Tools, Transcript context, System prompt, Prompt.
	press(DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
	press(prompt, CTRL_Q); // hook editor submit
	press(ESC); // step detail → chain detail
}

beforeEach(() => setKeybindings(KeybindingsManager.inMemory()));
afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("ChainConfigOverlayComponent", () => {
	beforeAll(async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
	});

	it("creates a chain with two ordered steps and saves their prompts", async () => {
		const harness = makeOverlay({ chains: [] });
		const { press, retype, saved } = harness;

		press(ENTER); // "+ New chain" is the first row of an empty roster
		retype("Polish");
		press(ENTER); // create chain, open chain detail

		addStep(harness, 0, "Tighten", "Cut the slop.");
		addStep(harness, 1, "Proofread", "Fix typos only.");

		press(ESC); // chain detail → list
		press(DOWN, DOWN, DOWN); // chain row → + New chain → Scope → Save & apply
		press(ENTER);
		await Bun.sleep(0);

		expect(saved).toHaveLength(1);
		expect(saved[0]).toEqual({
			chains: [
				{
					name: "Polish",
					steps: [
						{ name: "Tighten", prompt: "Cut the slop." },
						{ name: "Proofread", prompt: "Fix typos only." },
					],
				},
			],
		});
	});

	it("reorders steps with Alt+Down and saves the new order", async () => {
		const harness = makeOverlay({
			chains: [
				{
					name: "Polish",
					steps: [
						{ name: "Tighten", prompt: "Cut the slop." },
						{ name: "Proofread", prompt: "Fix typos only." },
					],
				},
			],
		});
		const { press, saved, overlay } = harness;

		press(ENTER); // open the only chain
		press(DOWN, DOWN); // Name → Description → step 1
		press("\x1b[1;3B"); // Alt+Down: step 1 swaps with step 2
		expect(overlay.render(120).join("\n")).toContain("1. Proofread");

		press(ESC, DOWN, DOWN, DOWN, ENTER); // list → Save & apply
		await Bun.sleep(0);

		expect(saved[0]?.chains[0]?.steps.map(step => step.name)).toEqual(["Proofread", "Tighten"]);
	});

	it("reorders steps with the bracket keys too", async () => {
		const harness = makeOverlay({
			chains: [
				{
					name: "Polish",
					steps: [
						{ name: "Tighten", prompt: "a" },
						{ name: "Proofread", prompt: "b" },
					],
				},
			],
		});
		const { press, saved } = harness;

		press(ENTER, DOWN, DOWN, DOWN); // open chain, land on step 2
		press("["); // move step 2 up
		press(ESC, DOWN, DOWN, DOWN, ENTER);
		await Bun.sleep(0);

		expect(saved[0]?.chains[0]?.steps.map(step => step.name)).toEqual(["Proofread", "Tighten"]);
	});

	it("blocks a save when a step has an empty prompt and warns instead", async () => {
		const harness = makeOverlay({
			chains: [{ name: "Polish", steps: [{ name: "Tighten", prompt: "   " }] }],
		});
		const { press, saved, notices } = harness;

		press(DOWN, DOWN, DOWN, ENTER); // Save & apply
		await Bun.sleep(0);

		expect(saved).toHaveLength(0);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("empty prompt");
		expect(notices[0]).toContain("Tighten");
	});

	it("blocks a save when a chain has no steps", async () => {
		const harness = makeOverlay({ chains: [{ name: "Empty", steps: [] }] });
		const { press, saved, notices } = harness;

		press(DOWN, DOWN, DOWN, ENTER);
		await Bun.sleep(0);

		expect(saved).toHaveLength(0);
		expect(notices[0]).toContain("no steps");
	});

	it("loads the other scope from the scope toggle row", async () => {
		const harness = makeOverlay({
			chains: [{ name: "Polish", steps: [{ name: "Tighten", prompt: "x" }] }],
		});
		const { press, loaded, overlay } = harness;

		press(DOWN, DOWN, ENTER); // chain row → + New chain → Scope
		await Bun.sleep(0);

		expect(loaded).toEqual(["user"]);
		expect(overlay.render(120).join("\n")).toContain("user");
	});

	it("refuses to switch scope with unsaved edits", async () => {
		const harness = makeOverlay({ chains: [] });
		const { press, retype, loaded, notices } = harness;

		press(ENTER); // + New chain
		retype("Draft");
		press(ENTER, ESC); // create chain (dirty), back to list
		press(DOWN, DOWN, ENTER); // Scope row
		await Bun.sleep(0);

		expect(loaded).toEqual([]);
		expect(notices[0]).toContain("Unsaved changes");
	});

	it("removes a chain only after a second Delete press", () => {
		const doc: ChainsConfigDoc = {
			chains: [
				{ name: "Polish", steps: [{ name: "Tighten", prompt: "x" }] },
				{ name: "Expand", steps: [{ name: "Grow", prompt: "y" }] },
			],
		};
		const { press, overlay } = makeOverlay(doc);

		press(DELETE); // Delete on the first chain arms the confirmation
		expect(overlay.render(120).join("\n")).toContain('⚠ Delete "Polish"?');
		expect(overlay.render(120).join("\n")).toContain("Delete again to confirm removal");
		press(ESC); // Esc abandons it without closing the overlay
		expect(doc.chains).toHaveLength(2);
		expect(overlay.render(120).join("\n")).not.toContain("Delete again to confirm removal");

		press(DELETE, DELETE);
		expect(doc.chains.map(chain => chain.name)).toEqual(["Expand"]);
	});

	it("deletes the highlighted step from the chain detail screen", () => {
		const doc: ChainsConfigDoc = {
			chains: [
				{
					name: "Polish",
					steps: [
						{ name: "Tighten", prompt: "a" },
						{ name: "Proofread", prompt: "b" },
					],
				},
			],
		};
		const { press } = makeOverlay(doc);

		press(ENTER, DOWN, DOWN); // open chain, land on step 1
		press(DELETE);

		expect(doc.chains[0]?.steps.map(step => step.name)).toEqual(["Proofread"]);
	});

	it("toggles only the focused step with Space, keeping its prompt, model, and position", async () => {
		const doc: ChainsConfigDoc = {
			chains: [
				{
					name: "Polish",
					steps: [
						{ name: "Tighten", model: "@smol", prompt: "Cut the slop." },
						{ name: "Proofread", prompt: "Fix typos only." },
						{ name: "Format", prompt: "Wrap at 80." },
					],
				},
			],
		};
		const { press, saved, overlay } = makeOverlay(doc);
		const steps = () => doc.chains[0]?.steps ?? [];

		press(ENTER, DOWN, DOWN); // open chain, land on step 1
		// Space leaves the focus on step 1, so Down reaches step 2, not step 3.
		press(SPACE, DOWN, SPACE);
		expect(steps()).toEqual([
			{ name: "Tighten", model: "@smol", prompt: "Cut the slop.", enabled: false },
			{ name: "Proofread", prompt: "Fix typos only.", enabled: false },
			{ name: "Format", prompt: "Wrap at 80." },
		]);
		const detail = plain(overlay.render(160));
		expect(detail).toContain("[ ] 1. Tighten");
		expect(detail).toContain("[ ] 2. Proofread");
		expect(detail).toContain("[x] 3. Format");

		press(UP, SPACE); // step 1 back on, unchanged
		expect(steps()[0]).toEqual({ name: "Tighten", model: "@smol", prompt: "Cut the slop." });
		expect(Object.hasOwn(steps()[0]!, "enabled")).toBe(false);

		press(ESC); // back to the list; its preview counts enabled steps
		const list = plain(overlay.render(200));
		expect(list).toContain("Steps (2 of 3 on):");
		expect(list).toContain("2. Proofread (off)");

		press(DOWN, DOWN, DOWN, ENTER); // Save & apply
		await Bun.sleep(0);
		expect(saved[0]?.chains[0]?.steps).toEqual([
			{ name: "Tighten", model: "@smol", prompt: "Cut the slop." },
			{ name: "Proofread", prompt: "Fix typos only.", enabled: false },
			{ name: "Format", prompt: "Wrap at 80." },
		]);
	});

	it("keeps Space literal in the name input and the prompt editor", () => {
		const doc: ChainsConfigDoc = { chains: [{ name: "Polish", steps: [{ name: "Tighten", prompt: "a" }] }] };
		const { press } = makeOverlay(doc);

		press(ENTER, ENTER); // open chain, open its Name input
		press("\x15", "M", "y", SPACE, "c", "h", "a", "i", "n", ENTER);
		expect(doc.chains[0]?.name).toBe("My chain");

		press(DOWN, DOWN, ENTER); // Name → Description → step 1 detail
		press(DOWN, DOWN, DOWN, DOWN, DOWN, ENTER); // Prompt editor
		press(SPACE, "b", CTRL_Q);
		expect(doc.chains[0]?.steps[0]).toEqual({ name: "Tighten", prompt: "a b" });
	});

	it("toggles a step's transcript context on and back off", () => {
		const doc: ChainsConfigDoc = { chains: [{ name: "Polish", steps: [{ name: "Tighten", prompt: "a" }] }] };
		const { press } = makeOverlay(doc);

		press(ENTER, DOWN, DOWN, ENTER); // open chain, open step 1
		press(DOWN, DOWN, DOWN, ENTER); // Name → Model → Tools → Transcript context
		expect(doc.chains[0]?.steps[0]?.context).toBe(true);

		press(ENTER); // the row stays selected after the toggle
		expect(doc.chains[0]?.steps[0]?.context).toBeUndefined();
	});

	it("edits a step's system prompt from the bundled default and resets it with Backspace", () => {
		const doc: ChainsConfigDoc = { chains: [{ name: "Polish", steps: [{ name: "Tighten", prompt: "a" }] }] };
		const { press, overlay } = makeOverlay(doc);

		press(ENTER, DOWN, DOWN, ENTER); // open chain, open step 1
		expect(overlay.render(120).join("\n")).toContain("(bundled default)");
		press(DOWN, DOWN, DOWN, DOWN, ENTER); // System prompt → editor prefilled with the default
		press(" more", CTRL_Q);
		expect(doc.chains[0]?.steps[0]?.systemPrompt).toBe("default more");

		press("\x7f"); // Backspace on the System prompt row
		expect(doc.chains[0]?.steps[0]?.systemPrompt).toBeUndefined();
	});

	it("shows the chain's steps in the preview pane of the list screen", () => {
		const { overlay } = makeOverlay({
			chains: [
				{
					name: "Polish",
					description: "Two-pass cleanup",
					steps: [
						{ name: "Tighten", tools: ["read"], prompt: "Cut the slop." },
						{ name: "Proofread", prompt: "Fix typos only." },
					],
				},
			],
		});

		const text = overlay
			.render(200)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("Chain configuration");
		expect(text).toContain("Two-pass cleanup");
		expect(text).toContain("1. Tighten");
		expect(text).toContain("2. Proofread");
		expect(text).toContain("@prose (default)");
		expect(text).toContain("no tools");
		expect(text).toContain("Cut the slop.");
	});

	it("preserves literal search and parent list state through nested visits", () => {
		const { overlay, press } = makeOverlay({
			chains: [
				{ name: "hjkl", steps: [{ name: "first", prompt: "text" }] },
				{ name: "other", steps: [{ name: "second", prompt: "text" }] },
			],
		});
		const visits: string[] = [];
		overlay.onNavigationVisit = page => {
			visits.push(page);
		};
		press("/", "hjkl", ENTER, ENTER);
		expect(overlay.navigationSnapshot().context.screen).toBe("chain");
		press("h");
		expect(overlay.navigationSnapshot().content).toMatchObject({ filter: "hjkl", selectedValue: "chain:0" });
		press(ENTER, "/", "first", ENTER, "l");
		expect(overlay.navigationSnapshot().context.screen).toBe("step");
		const snapshot = overlay.navigationSnapshot();
		const restored = makeOverlay({ chains: [] });
		restored.overlay.restoreNavigation(snapshot);
		expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
		const count = visits.length;
		overlay.restoreNavigation(snapshot);
		expect(visits).toHaveLength(count);
		expect(visits.some(page => page.startsWith("step:"))).toBe(true);
	});

	it("round-trips an unsubmitted multiline step draft and ignores Space on Delete", () => {
		const { overlay, press, saved } = makeOverlay({
			chains: [{ name: "chain", steps: [{ name: "step", prompt: "text" }] }],
		});
		press(ENTER, DOWN, DOWN, "l", "G", "k", " ");
		expect(overlay.navigationSnapshot().doc.chains[0]?.steps).toHaveLength(1);
		press("k", "l", " draft hjkl");
		const snapshot = overlay.navigationSnapshot();
		expect(snapshot.context.screen).toBe("prompt");
		const restored = makeOverlay({ chains: [] });
		restored.overlay.restoreNavigation(snapshot);
		expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
		expect(saved).toEqual([]);
		expect(restored.saved).toEqual([]);
	});

	it("scrolls the view independently of the selected chain", () => {
		const { overlay, press } = makeOverlay({
			chains: Array.from({ length: 80 }, (_, index) => ({
				name: `chain ${index}`,
				steps: [{ name: "step", prompt: "text" }],
			})),
		});
		overlay.render(100);
		press("\x05");
		const snapshot = overlay.navigationSnapshot();
		expect(snapshot.content).toMatchObject({ selectedValue: "chain:0", viewportTop: { item: 1, lineOffset: 0 } });
		press("G");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g", "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "chain:0" });
	});

	it("switches root preview contexts without visits and keeps preview motions off the chain cursor", () => {
		const { overlay, press } = makeOverlay({
			chains: [
				{
					name: "alpha",
					description: Array.from({ length: 140 }, (_, index) => `Preview line ${index}`).join("\n"),
					steps: [{ name: "step", prompt: "text" }],
				},
			],
		});
		const contentRows = overlay.render(100).length - 5;
		const list = overlay.navigationSnapshot().content;
		const visits: string[] = [];
		overlay.onNavigationVisit = page => visits.push(page);
		press("l", "j", "\x05");
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "list" },
			previewFocused: true,
			previewScroll: 2,
		});
		expect(overlay.navigationSnapshot().content).toEqual(list);
		expect(overlay.render(100).join("\n")).toContain("Preview");
		press("k", "\x19");
		expect(overlay.navigationSnapshot().previewScroll).toBe(0);
		press("\x04");
		expect(overlay.navigationSnapshot().previewScroll).toBe(Math.max(1, Math.floor(contentRows / 2)));
		press("\x1b[6~");
		expect(overlay.navigationSnapshot().previewScroll).toBe(Math.max(1, Math.floor(contentRows / 2)) + contentRows);
		press("\x1b[5~", "\x15");
		expect(overlay.navigationSnapshot().previewScroll).toBe(0);
		press("G");
		const end = overlay.navigationSnapshot().previewScroll;
		expect(end).toBeGreaterThan(0);
		press("j");
		expect(overlay.navigationSnapshot().previewScroll).toBe(end);
		press("g", "g");
		expect(overlay.navigationSnapshot().previewScroll).toBe(0);
		press("\x1b[F");
		expect(overlay.navigationSnapshot().previewScroll).toBe(end);
		press(HOME);
		expect(overlay.navigationSnapshot().previewScroll).toBe(0);
		for (const [key, focused] of [
			["h", false],
			["\t", true],
			["\x10", false],
			["\x0e", true],
			["\x1b[Z", false],
			["\x1b[C", true],
			["\x1b[D", false],
		] as const) {
			press(key);
			expect(overlay.navigationSnapshot().previewFocused).toBe(focused);
		}
		expect(visits).toEqual([]);
		press("l", ENTER);
		expect(overlay.navigationSnapshot().context.screen).toBe("chain");
		expect(visits).toEqual(["chain:0:new"]);
	});

	it("preserves preview focus and offset when backing out and restoring silently", () => {
		const { overlay, press } = makeOverlay({
			chains: [
				{
					name: "alpha",
					description: "Long preview\n".repeat(120),
					steps: [{ name: "step", prompt: "text" }],
				},
			],
		});
		overlay.render(100);
		press("l", "G");
		const snapshot = overlay.navigationSnapshot();
		press(ENTER, "h");
		expect(overlay.navigationSnapshot()).toMatchObject({
			previewFocused: true,
			previewScroll: snapshot.previewScroll,
		});
		expect(overlay.navigationSnapshot().content).toEqual(snapshot.content);
		const restored = makeOverlay({ chains: [] });
		restored.overlay.restoreNavigation(snapshot);
		expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
		restored.press("/");
		expect(restored.overlay.navigationSnapshot()).toMatchObject({
			previewFocused: false,
			content: { filterFocused: true },
		});
	});

	it("resets parent gg on pane, search, mouse and restore transitions", () => {
		const { overlay, press } = makeOverlay({
			chains: Array.from({ length: 80 }, (_, index) => ({
				name: `chain-${index}`,
				steps: [{ name: "step", prompt: "text" }],
			})),
		});
		overlay.render(100);
		press("G", "g", "l", "h", "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "chain:0" });
		press("G", "g", "/", ESC, ESC, "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "chain:0" });
		press("G", "g", "\x1b[<35;90;2M", "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		const snapshot = overlay.navigationSnapshot();
		overlay.restoreNavigation(snapshot);
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "chain:0" });
	});

	it("delegates decoded model-browser motions once and keeps model filters literal", () => {
		const models = Array.from({ length: 30 }, (_, index) =>
			buildModel({
				id: `model-${String(index).padStart(2, "0")}`,
				name: `Model ${String(index).padStart(2, "0")}`,
				provider: "test",
				api: "ollama-chat",
				baseUrl: "https://example.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1024,
			}),
		);
		const { overlay, press } = makeOverlay(
			{ chains: [{ name: "chain", steps: [{ name: "step", prompt: "text" }] }] },
			undefined,
			{ getAvailableModels: () => models },
		);
		press(ENTER, DOWN, DOWN, ENTER, DOWN, ENTER);
		overlay.render(100);
		const selectedModel = (): string | undefined =>
			(overlay.navigationSnapshot().content as { selected?: string }).selected;
		// The browser's sort order is its own; only the bounds matter here.
		const first = selectedModel();
		press("G");
		const last = selectedModel();
		expect(last).not.toBe(first);
		press("g", "l", "g");
		expect(selectedModel()).toBe(last);
		press("g");
		expect(selectedModel()).toBe(first);
		press("\x05");
		expect(selectedModel()).toBe(first);
		press("/", "hjklgG /");
		expect(overlay.navigationSnapshot().content).toMatchObject({
			value: "hjklgG /",
			query: "",
			filterFocused: true,
		});
		press(ESC); // Insert -> Normal keeps the literal draft focused.
		expect(overlay.navigationSnapshot().content).toMatchObject({ value: "hjklgG /", filterFocused: true });
		press(ESC);
		expect(overlay.navigationSnapshot().content).toMatchObject({ value: "", query: "", filterFocused: false });
		expect(overlay.navigationSnapshot().context.screen).toBe("model");
		press("h");
		expect(overlay.navigationSnapshot().context.screen).toBe("step");
	});

	it("keeps direct Input text literal under remapped menu actions and honors explicit exits", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["escape", "j"],
				"tui.input.submit": ["enter", "k"],
				"tui.editor.deleteCharBackward": ["backspace", "h"],
				"tui.editor.deleteCharForward": ["delete", "/"],
				"tui.select.nextContext": ["tab", "g"],
				"tui.select.prevContext": ["shift+tab", "l"],
			}),
		);
		const { overlay, press, saved } = makeOverlay({
			chains: [{ name: "alpha", steps: [{ name: "step", prompt: "text" }] }],
		});
		press(ENTER, ENTER, "\x15");
		for (const character of "hjklggG / ") press(character);
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "chainName" },
			content: { value: "hjklggG / " },
		});
		expect(saved).toEqual([]);
		press(ESC, ENTER, "\x15", "hjkl", ENTER);
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "chain" },
			doc: { chains: [{ name: "hjkl" }] },
		});
	});

	it("adjusts thinking with h/l but types those characters in its focused filter", () => {
		const { overlay, press } = makeOverlay({
			chains: [{ name: "chain", steps: [{ name: "step", prompt: "text" }] }],
		});
		const original = overlay.navigationSnapshot();
		overlay.restoreNavigation({
			...original,
			context: {
				screen: "thinking",
				chainIndex: 0,
				stepIndex: 0,
				thinking: { selector: "test/model", efforts: ["low", "high"] },
			},
			content: { selectedValue: "", filter: "", filterFocused: false, filterCursor: 0, viewportTop: undefined },
		});
		press("l");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "low" });
		press("l");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "high" });
		press("h");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "low" });
		press("/", "hl");
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "thinking" },
			content: { filter: "", filterDraft: "hl", filterFocused: true },
		});
	});

	it("keeps a silently restored tool cursor on the tool it toggles", () => {
		const { overlay, press } = makeOverlay({
			chains: [{ name: "chain", steps: [{ name: "step", prompt: "text", tools: ["read"] }] }],
		});
		press(ENTER, DOWN, DOWN, ENTER, DOWN, DOWN, ENTER, DOWN);
		const snapshot = overlay.navigationSnapshot();
		expect(snapshot.content).toMatchObject({ selectedValue: "grep" });
		const restored = makeOverlay({ chains: [] });
		restored.overlay.restoreNavigation(snapshot);
		restored.press(" ");
		expect(restored.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "grep" });
		expect(restored.overlay.navigationSnapshot().context.tools).toEqual(["read", "grep"]);
		restored.press(ESC);
		expect(restored.overlay.navigationSnapshot().doc.chains[0]?.steps[0]?.tools).toEqual(["read", "grep"]);
	});

	for (const target of ["chain", "step"] as const) {
		it(`captures the pre-delete ${target} before changing pages and ignores destructive Space/l`, () => {
			const { overlay, press } = makeOverlay({
				chains: [
					{
						name: "alpha",
						steps: [
							{ name: "first", prompt: "text" },
							{ name: "second", prompt: "text" },
						],
					},
					{ name: "beta", steps: [{ name: "other", prompt: "text" }] },
				],
			});
			const visits: { page: string; previous: unknown }[] = [];
			overlay.onNavigationVisit = (page, previous) => visits.push({ page, previous });
			press(ENTER);
			if (target === "step") press(DOWN, DOWN, ENTER);
			press("G", "k", " ", "l");
			expect(overlay.navigationSnapshot().context.screen).toBe(target);
			expect(overlay.navigationSnapshot().doc.chains).toHaveLength(2);
			expect(overlay.navigationSnapshot().doc.chains[0]?.steps).toHaveLength(2);
			press(ENTER);
			const previous = visits.at(-1)?.previous;
			expect(previous).toMatchObject({
				context: { screen: target, chainIndex: 0 },
				content: { selectedValue: "delete" },
			});
			const count = visits.length;
			overlay.restoreNavigation(previous);
			expect(overlay.navigationSnapshot().doc.chains.map(chain => chain.name)).toEqual(["alpha", "beta"]);
			expect(overlay.navigationSnapshot().doc.chains[0]?.steps.map(step => step.name)).toEqual(["first", "second"]);
			expect(visits).toHaveLength(count);
		});
	}

	it("does not reset a model or discard dirty edits with Space", () => {
		let closed = 0;
		const { overlay, press } = makeOverlay(
			{
				chains: [
					{
						name: "chain",
						steps: [{ name: "step", prompt: "text", model: "test/model:high" }],
					},
				],
			},
			{
				close: () => {
					closed++;
				},
			},
		);
		press(ENTER, DOWN, DOWN, ENTER, "/", "Reset model", ENTER, " ", "l");
		expect(overlay.navigationSnapshot().doc.chains[0]?.steps[0]?.model).toBe("test/model:high");
		press(ENTER);
		expect(overlay.navigationSnapshot().doc.chains[0]?.steps[0]?.model).toBeUndefined();
		press(ESC, ESC, ESC, "G"); // Clear Reset model, then leave step and chain.
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "list" },
			content: { selectedValue: "close" },
		});
		press(" ");
		expect(closed).toBe(0);
		press(ENTER);
		expect(closed).toBe(1);
	});

	it("cancels inline deletion on the first g rather than confirming it on a later Delete", () => {
		const { overlay, press } = makeOverlay({
			chains: [
				{ name: "alpha", steps: [{ name: "step", prompt: "text" }] },
				{ name: "beta", steps: [{ name: "step", prompt: "text" }] },
			],
		});
		press(DELETE, "g", DELETE);
		expect(overlay.navigationSnapshot().doc.chains).toHaveLength(2);
		press(DELETE);
		expect(overlay.navigationSnapshot().doc.chains.map(chain => chain.name)).toEqual(["beta"]);
	});

	for (const scenario of [
		{ rows: 1, descriptionLines: 40, overflows: true },
		{ rows: 24, descriptionLines: 40, overflows: true },
		{ rows: 14, descriptionLines: 3, overflows: false },
	]) {
		it(`keeps the final chain preview content readable at G/End with ${scenario.rows} terminal rows`, () => {
			const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: scenario.rows });
			try {
				const marker = "CHAIN-LAST-CONTENT";
				const { overlay, press } = makeOverlay({
					chains: [
						{
							name: "reader",
							description: Array.from(
								{ length: scenario.descriptionLines },
								(_, index) => `Preview line ${index}`,
							).join("\n"),
							steps: [{ name: "step", prompt: marker }],
						},
					],
				});
				const initial = overlay.render(100);
				expect(initial).toHaveLength(Math.max(14, scenario.rows));
				const contentRows = initial.length - 4 - (scenario.overflows ? 1 : 0);
				const selected = overlay.navigationSnapshot().content;
				const visits: string[] = [];
				overlay.onNavigationVisit = page => visits.push(page);
				press("l", "\x04");
				expect(overlay.navigationSnapshot().previewScroll).toBe(
					scenario.overflows ? Math.max(1, Math.floor(contentRows / 2)) : 0,
				);
				press("G");
				const end = overlay.navigationSnapshot().previewScroll;
				const lastContent = (): string => {
					const frame = overlay.render(100);
					return Bun.stripANSI(frame[frame.length - (scenario.overflows ? 5 : 4)] ?? "");
				};
				expect(lastContent()).toContain(marker);
				if (scenario.overflows) {
					expect(end).toBeGreaterThan(0);
					press("\x19");
					expect(lastContent()).not.toContain(marker);
					press("\x05");
					expect(lastContent()).toContain(marker);
				} else expect(Bun.stripANSI(overlay.render(100).join("\n"))).not.toContain("(end)");
				press("\x1b[5~");
				expect(overlay.navigationSnapshot().previewScroll).toBe(Math.max(0, end - contentRows));
				press("\x1b[6~");
				expect(lastContent()).toContain(marker);
				press(HOME, "\x1b[F");
				expect(lastContent()).toContain(marker);
				expect(overlay.navigationSnapshot().content).toEqual(selected);
				expect(visits).toEqual([]);
			} finally {
				if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
				else Reflect.deleteProperty(process.stdout, "rows");
			}
		});
	}
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
