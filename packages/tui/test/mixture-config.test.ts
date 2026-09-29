import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type MixtureConfigCallbacks,
	MixtureConfigOverlayComponent,
	type MixtureConfigDeps,
} from "../src/overlays/mixture-config";
import type { MixturesConfigDoc } from "../src/overlays/mixture-types";
import { getThemeByName, setThemeInstance } from "../src/theme";

const deps: MixtureConfigDeps = {
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
	availableToolNames: ["read", "grep"],
	activeName: () => undefined,
};

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";
const HOME = "\x1b[H";

function makeOverlay(doc: MixturesConfigDoc, overrides: Partial<MixtureConfigCallbacks> = {}) {
	const saved: MixturesConfigDoc[] = [];
	const actions: string[] = [];
	const notices: string[] = [];
	const overlay = new MixtureConfigOverlayComponent({} as TUI, deps, "project", structuredClone(doc), {
		loadDoc: async () => ({ mixtures: [] }),
		save: async (_scope, draft) => {
			saved.push(structuredClone(draft));
			actions.push("save");
		},
		apply: async () => {
			actions.push("apply");
		},
		activate: async name => {
			actions.push(`activate:${name}`);
		},
		close: () => {
			actions.push("close");
		},
		requestRender: () => {},
		notify: message => {
			notices.push(message);
		},
		warn: message => {
			notices.push(message);
		},
		...overrides,
	});
	return {
		overlay,
		saved,
		actions,
		notices,
		press: (...keys: string[]) => keys.forEach(key => overlay.handleInput(key)),
	};
}

const graph: MixturesConfigDoc = {
	mixtures: [
		{
			name: "draft-then-edit",
			entry: "writer",
			members: [
				{ id: "writer", model: "fake/writer", tools: false },
				{ id: "reviewer", model: "fake/reviewer", tools: false },
				{ id: "editor", model: "fake/editor", tools: false },
			],
			edges: [{ from: "writer", to: "editor", x: { output: true } }],
		},
	],
};

describe("MixtureConfigOverlayComponent", () => {
	beforeAll(async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
	});

	it("keeps save separate from apply, then activates the registered mixture with Space", async () => {
		const h = makeOverlay(graph);
		h.press("s");
		await Bun.sleep(0);
		expect(h.actions).toEqual(["save"]);
		h.press("a");
		await Bun.sleep(0);
		expect(h.actions).toEqual(["save", "apply"]);
		h.press(" ");
		await Bun.sleep(0);
		expect(h.actions).toEqual(["save", "apply", "activate:draft-then-edit"]);
		expect(h.notices).toEqual([]);
	});

	it("edits an edge endpoint and transit parts through the graph screens before saving", async () => {
		const h = makeOverlay(graph);
		h.press(ENTER); // mixture detail
		h.press(HOME, DOWN, DOWN, DOWN, DOWN, ENTER); // edges
		h.press(ENTER); // writer -> editor
		h.press(DOWN, DOWN, ENTER); // 'to' picker (after edge id and from)
		h.press(HOME, DOWN, ENTER); // reviewer
		h.press(DOWN, ENTER); // transit parts
		h.press(HOME, DOWN, DOWN, " "); // reasoning
		h.press(ESC, ESC, ESC, ESC); // edge -> edges -> mixture -> list
		h.press("s");
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures[0]?.edges).toEqual([
			{ from: "writer", to: "reviewer", x: { output: true, reasoning: true } },
		]);
		expect(h.actions).toEqual(["save"]);
	});

	it("keeps route fallbacks pointed at an edge when its endpoint changes", async () => {
		const doc = structuredClone(graph);
		doc.mixtures[0]!.members[0] = {
			id: "writer",
			model: "fake/writer",
			tools: false,
			route: { instructions: "Choose the next editor", fallback: "writer->editor" },
		};
		const h = makeOverlay(doc);
		h.press(ENTER, HOME, DOWN, DOWN, DOWN, DOWN, ENTER, ENTER); // first edge
		h.press(HOME, DOWN, DOWN, ENTER, HOME, DOWN, ENTER); // to: reviewer
		h.press(ESC, ESC, ESC, "s");
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures[0]?.members[0]).toMatchObject({
			route: { fallback: "writer->reviewer" },
		});
	});

	it("requires a second Delete before removing a mixture and leaves the active roster unchanged until apply", async () => {
		const h = makeOverlay(graph);
		h.press(DELETE, ESC);
		h.press("s");
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures).toHaveLength(1);
		h.press(DELETE, DELETE, "a");
		await Bun.sleep(0);
		expect(h.saved.at(-1)?.mixtures).toEqual([]);
		expect(h.actions.at(-1)).toBe("apply");
	});

	it("preserves route instructions while editing the judge floor, state and fallback", async () => {
		const doc = structuredClone(graph);
		doc.mixtures[0]!.members[0] = {
			id: "writer",
			model: "fake/writer",
			tools: false,
			route: { instructions: "Pick a rebuttal", state: ["output"] },
		};
		const h = makeOverlay(doc);
		h.press(ENTER, HOME, DOWN, DOWN, DOWN, ENTER, ENTER); // writer member
		h.press(HOME, ...Array(9).fill(DOWN), ENTER); // route
		h.press(HOME, DOWN, DOWN, DOWN, ENTER, HOME, DOWN, ENTER); // fallback: pause
		h.press(HOME, DOWN, DOWN, ENTER, "0", ".", "7", ENTER); // floor
		h.press(HOME, DOWN, ENTER, HOME, DOWN, DOWN, " ", ESC); // include tool trace
		h.press(ESC, ESC, ESC, ESC, "s");
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures[0]?.members[0]).toMatchObject({
			route: {
				instructions: "Pick a rebuttal",
				state: ["output", "toolTrace"],
				minConfidence: 0.7,
				fallback: "pause",
			},
		});
	});

	it("configures compact transcript transit with a bounded token budget", async () => {
		const h = makeOverlay(graph);
		h.press(ENTER, HOME, DOWN, DOWN, DOWN, DOWN, ENTER, ENTER); // first edge
		h.press(HOME, DOWN, DOWN, DOWN, ENTER); // transit
		h.press(HOME, DOWN, DOWN, DOWN, DOWN, ENTER); // transcript settings
		h.press(ENTER, HOME, DOWN, DOWN, ENTER); // compact
		h.press(DOWN, ENTER, "2", "5", "6", ENTER); // budget
		h.press(ESC, ESC, ESC, ESC, ESC, "s");
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures[0]?.edges[0]?.x.transcript).toEqual({ optimize: "compact", budgetTokens: 256 });
	});

	it("creates and edits a verdict member with a choice question and rubric", async () => {
		const h = makeOverlay(graph);
		h.press(ENTER, HOME, DOWN, DOWN, DOWN, ENTER); // members
		h.press(HOME, DOWN, DOWN, DOWN, DOWN, ENTER); // add verdict
		h.press(..."judge", ENTER);
		h.press(HOME, DOWN, DOWN, DOWN, ENTER, HOME, DOWN, ENTER); // type: choice
		h.press(HOME, DOWN, DOWN, DOWN, DOWN, ENTER, ..."Which answer is sound?", "\x11"); // instructions
		h.press(HOME, ...Array(7).fill(DOWN), ENTER, ENTER); // criteria, add option
		h.press(..."agree", ENTER);
		h.press(DOWN, ENTER, ..."Evidence supports it", "\x11"); // rubric
		h.press(ESC, ESC, ESC, ESC, ESC, "s"); // option, criteria, verdict, members, list
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures[0]?.members.at(-1)).toEqual({
			id: "judge",
			kind: "verdict",
			question: {
				type: "choice",
				instructions: "Which answer is sound?",
				criteria: { agree: "Evidence supports it" },
			},
		});
	});

	it("keeps termination criteria while rejecting an out-of-range threshold in place", async () => {
		const doc = structuredClone(graph);
		doc.mixtures[0]!.members[2] = {
			id: "editor",
			model: "fake/editor",
			tools: false,
			terminate: {
				instructions: "Did the defense concede?",
				criteria: { true: "Conceded the claim", false: "Still contests the claim" },
				state: ["output"],
			},
		};
		const h = makeOverlay(doc);
		h.press(ENTER, HOME, DOWN, DOWN, DOWN, ENTER, HOME, DOWN, DOWN, ENTER); // editor member
		h.press(HOME, ...Array(10).fill(DOWN), ENTER); // terminate
		h.press(HOME, DOWN, DOWN, ENTER, "1", ".", "2", ENTER); // rejected, still editing
		expect(h.notices).toContain("Termination threshold must be between 0 and 1");
		h.press("\x15", "0", ".", "8", ENTER); // correct in the same input
		h.press(HOME, DOWN, ENTER, HOME, DOWN, " ", ESC); // include input
		h.press(ESC, ESC, ESC, ESC, "s");
		await Bun.sleep(0);
		expect(h.saved[0]?.mixtures[0]?.members[2]).toMatchObject({
			terminate: {
				instructions: "Did the defense concede?",
				criteria: { true: "Conceded the claim", false: "Still contests the claim" },
				state: ["output", "input"],
				threshold: 0.8,
			},
		});
	});

	it("requires explicit confirmation before discarding dirty graph edits", async () => {
		const h = makeOverlay(graph);
		h.press(ENTER, HOME, ENTER); // edit name
		h.press("2", ENTER, ESC, ESC);
		expect(h.actions).toEqual([]);
		h.press(ESC); // keep editing
		expect(h.actions).toEqual([]);
		h.press(ESC, DOWN, ENTER); // confirm discard
		expect(h.actions).toEqual(["close"]);
	});
});
