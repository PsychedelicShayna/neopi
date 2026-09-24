import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type ChainConfigCallbacks,
	type ChainConfigDeps,
	ChainConfigOverlayComponent,
} from "../src/overlays/chain-config";
import type { ChainConfigScope, ChainsConfigDoc } from "../src/overlays/chain-types";
import { getThemeByName, setThemeInstance } from "../src/theme";

const deps: ChainConfigDeps = {
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
	scopedModels: [],
	availableToolNames: ["read", "grep", "web_search"],
	defaultSystemPrompt: "default",
};

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_Q = "\x11";
const HOME = "\x1b[H";
const DELETE = "\x1b[3~";

interface Harness {
	overlay: ChainConfigOverlayComponent;
	saved: ChainsConfigDoc[];
	notices: string[];
	loaded: ChainConfigScope[];
	press: (...keys: string[]) => void;
	/** Replace an Input's prefilled value, then type `text`. */
	retype: (text: string) => void;
}

function makeOverlay(doc: ChainsConfigDoc, overrides?: Partial<ChainConfigCallbacks>): Harness {
	const saved: ChainsConfigDoc[] = [];
	const notices: string[] = [];
	const loaded: ChainConfigScope[] = [];
	const overlay = new ChainConfigOverlayComponent({} as unknown as TUI, deps, "project", doc, {
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
	});
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
});
