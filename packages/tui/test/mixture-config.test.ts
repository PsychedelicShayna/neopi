import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { TUI } from "../src/index";
import {
	type MixtureConfigCallbacks,
	MixtureConfigOverlayComponent,
	type MixtureConfigDeps,
} from "../src/overlays/mixture-config";
import type { MixturesConfigDoc } from "../src/overlays/mixture-types";
import { getThemeByName, setThemeInstance } from "../src/theme";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { KeybindingsManager } from "../src/app-keybindings";
import { getKeybindings, setKeybindings } from "../src/keybindings";

const deps: MixtureConfigDeps = {
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
	availableToolNames: ["read", "grep"],
	activeName: () => undefined,
};

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";
const HOME = "\x1b[H";

function makeOverlay(
	doc: MixturesConfigDoc,
	overrides: Partial<MixtureConfigCallbacks> = {},
	fixtureDeps: MixtureConfigDeps = deps,
) {
	const saved: MixturesConfigDoc[] = [];
	const actions: string[] = [];
	const notices: string[] = [];
	const tui = {
		terminal: { rows: 40, columns: 120 },
		requestRender: () => {},
		setFocus: () => {},
		start: () => {},
		stop: () => {},
	} as unknown as TUI;
	const overlay = new MixtureConfigOverlayComponent(tui, fixtureDeps, "project", structuredClone(doc), {
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
	const press = (...keys: string[]) => keys.forEach(key => overlay.handleInput(key));
	return {
		overlay,
		saved,
		actions,
		notices,
		press,
		choose: (query: string, key = ENTER) => press("/", "\x01", "\x0b", query, ENTER, key),
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

beforeAll(async () => {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) throw new Error("theme unavailable");
	setThemeInstance(uiTheme);
});

describe("MixtureConfigOverlayComponent", () => {
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

function navigationDoc(question: "noul" | "choice" | "score" = "noul"): MixturesConfigDoc {
	const doc = structuredClone(graph);
	const mixture = doc.mixtures[0]!;
	const writer = mixture.members[0]!;
	if (writer.kind === "verdict") throw new Error("Fixture writer must be a model member");
	writer.route = { instructions: "Choose a destination", state: ["output"] };
	writer.terminate = { instructions: "Decide whether to stop", threshold: 0.5 };
	mixture.roles = { base: "Role text", back: "A preset named back" };
	mixture.envelopes = { basic: "Envelope text" };
	mixture.members.push({
		id: "judge",
		kind: "verdict",
		question:
			question === "choice"
				? { type: "choice", instructions: "Judge the result", criteria: { agree: "Evidence", back: null } }
				: question === "score"
					? { type: "score", instructions: "Judge the result", criteria: ["Weak", "Strong"] }
					: { type: "noul", instructions: "Judge the result", criteria: { true: "Yes", false: "No" } },
	});
	return doc;
}

interface FieldCase {
	path: string[];
	edit?: "text" | "long";
	question?: "noul" | "choice" | "score";
	creation?: boolean;
	root?: boolean;
}

const fieldCases: FieldCase[] = [
	{ path: ["Name"], edit: "text" },
	{ path: ["Description"], edit: "text" },
	{ path: ["Entry member"] },
	{ path: ["Create mixture"], edit: "text", creation: true, root: true },
	{ path: ["Members", "Add model member"], edit: "text", creation: true },
	{ path: ["Members", "Add verdict member"], edit: "text", creation: true },
	{ path: ["Members", "writer", "Member id"], edit: "text" },
	{ path: ["Members", "writer", "Description"], edit: "text" },
	{ path: ["Members", "writer", "Role prompt"], edit: "long" },
	{ path: ["Members", "writer", "Role preset"], edit: "text" },
	{ path: ["Members", "writer", "Inherit outer instructions"] },
	{ path: ["Members", "writer", "Model"] },
	{ path: ["Members", "writer", "Tools"] },
	{ path: ["Members", "writer", "Show"] },
	{ path: ["Members", "writer", "Maximum output tokens"], edit: "text" },
	{ path: ["Members", "writer", "Route instructions", "Choice instructions"], edit: "long" },
	{ path: ["Members", "writer", "Route instructions", "Judge context"] },
	{ path: ["Members", "writer", "Route instructions", "Native confidence floor"], edit: "text" },
	{ path: ["Members", "writer", "Route instructions", "Fallback"] },
	{ path: ["Members", "writer", "Termination instructions", "Termination condition"], edit: "long" },
	{ path: ["Members", "writer", "Termination instructions", "Judge context"] },
	{ path: ["Members", "writer", "Termination instructions", "Yes-probability threshold"], edit: "text" },
	{ path: ["Members", "writer", "Termination instructions", "Yes criterion"], edit: "long" },
	{ path: ["Members", "writer", "Termination instructions", "No criterion"], edit: "long" },
	{ path: ["Members", "judge", "Member id"], edit: "text" },
	{ path: ["Members", "judge", "Description"], edit: "text" },
	{ path: ["Members", "judge", "Show"] },
	{ path: ["Members", "judge", "Question type"] },
	{ path: ["Members", "judge", "Question instructions"], edit: "long" },
	{ path: ["Members", "judge", "Judge context"] },
	{ path: ["Members", "judge", "Answer template"], edit: "long" },
	{ path: ["Members", "judge", "Yes criterion"], edit: "long" },
	{ path: ["Members", "judge", "No criterion"], edit: "long" },
	{
		path: ["Members", "judge", "Options and rubrics", "Add option"],
		edit: "text",
		question: "choice",
		creation: true,
	},
	{ path: ["Members", "judge", "Options and rubrics", "agree", "Option name"], edit: "text", question: "choice" },
	{ path: ["Members", "judge", "Options and rubrics", "agree", "Rubric"], edit: "long", question: "choice" },
	{ path: ["Members", "judge", "Options and rubrics", "back", "Rubric"], edit: "long", question: "choice" },
	{ path: ["Members", "judge", "Ordered score levels", "Level 1"], edit: "long", question: "score" },
	{ path: ["Edges", "writer->editor", "Edge id"], edit: "text" },
	{ path: ["Edges", "writer->editor", "From"] },
	{ path: ["Edges", "writer->editor", "To"] },
	{ path: ["Edges", "writer->editor", "Envelope"], edit: "long" },
	{ path: ["Edges", "writer->editor", "When"], edit: "long" },
	{ path: ["Edges", "writer->editor", "Show source hop"] },
	{ path: ["Edges", "writer->editor", "Maximum traversals"], edit: "text" },
	{ path: ["Edges", "writer->editor", "Transit parts", "transcript", "Optimization"] },
	{ path: ["Edges", "writer->editor", "Transit parts", "transcript", "Token budget"], edit: "text" },
	{ path: ["Limits", "Maximum hops"], edit: "text" },
	{ path: ["Limits", "Budget (USD)"], edit: "text" },
	{ path: ["Limits", "Wall clock"], edit: "text" },
	{ path: ["Limits", "On limit"] },
	{ path: ["Limits", "Limit judge member"] },
	{ path: ["Role presets", "Add preset"], edit: "text", creation: true },
	{ path: ["Role presets", "base"], edit: "long" },
	{ path: ["Role presets", "back"], edit: "long" },
	{ path: ["Envelope presets", "basic"], edit: "long" },
];

describe("mixture menu navigation and history", () => {
	for (const entry of fieldCases) {
		it(`restores ${entry.path.join(" > ")} through fresh constructors without actions`, () => {
			const doc = navigationDoc(entry.question);
			const h = makeOverlay(doc);
			let loads = 0;
			const restored = makeOverlay(
				{ mixtures: [] },
				{
					loadDoc: async () => {
						loads++;
						return { mixtures: [] };
					},
				},
			);
			const visits: string[] = [];
			restored.overlay.onNavigationVisit = page => visits.push(page);
			try {
				if (!entry.root) h.press(ENTER);
				entry.path.forEach((query, index) =>
					h.choose(query, index === entry.path.length - 1 && !entry.creation ? "l" : ENTER),
				);
				if (entry.edit) {
					h.press("hjkl / draft", "\x1b[D");
					expect(h.overlay.navigationSnapshot().content).toMatchObject(
						entry.edit === "text"
							? { value: expect.stringContaining("hjkl / draft") }
							: { text: expect.stringContaining("hjkl / draft") },
					);
				}
				const snapshot = h.overlay.navigationSnapshot();
				expect(snapshot.doc).toEqual(doc);
				restored.overlay.restoreNavigation(snapshot);
				expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
				expect(restored.overlay.blocksMenuHistory).toBe(false);
				expect(visits).toEqual([]);
				expect(loads).toBe(0);
				expect(restored.actions).toEqual([]);
				expect(restored.notices).toEqual([]);
			} finally {
				h.overlay.dispose();
				restored.overlay.dispose();
			}
		});
	}

	it("uses fresh restored field owners and retains the parent query, caret, selection, and viewport", () => {
		const h = makeOverlay(graph);
		const restored = makeOverlay({ mixtures: [] });
		try {
			h.press(ENTER);
			h.press("/", "Description", "\x1b[D", ENTER, "l");
			h.press("hjkl / draft", "\x1b[D");
			const snapshot = h.overlay.navigationSnapshot();
			restored.overlay.restoreNavigation(snapshot);
			restored.press(ENTER);
			expect(restored.overlay.navigationSnapshot().doc.mixtures[0]?.description).toBe("hjkl / draft");
			expect(h.overlay.navigationSnapshot().doc.mixtures[0]?.description).toBeUndefined();
			expect(restored.overlay.navigationSnapshot().content).toMatchObject({
				filter: "Description",
				filterFocused: false,
				filterCursor: "Description".length - 1,
				selectedValue: "description",
			});
			expect(restored.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("types remapped printable cancel, submit, and editing keys literally in direct Input fields", () => {
		const h = makeOverlay(graph);
		const previous = getKeybindings();
		try {
			h.press(ENTER);
			h.choose("Name", "l");
			setKeybindings(
				KeybindingsManager.inMemory({
					"tui.select.cancel": ["escape", "h"],
					"tui.input.submit": ["enter", "j"],
					"tui.editor.deleteCharBackward": "k",
					"tui.editor.cursorLeft": "l",
				}),
			);
			h.press("h", "j", "k", "l", "/", " ");
			expect(h.overlay.navigationSnapshot()).toMatchObject({
				context: { page: "field", key: "name" },
				content: { value: "draft-then-edithjkl/ " },
			});
			h.press(ESC);
			expect(h.overlay.navigationSnapshot().context.page).toBe("mixture");
			expect(h.actions).toEqual([]);
		} finally {
			setKeybindings(previous);
			h.overlay.dispose();
		}
	});

	it("keeps normal list motions, context switches, and the gg prefix under one reader", () => {
		const count = Math.max(40, (process.stdout.rows || 40) * 3);
		const doc: MixturesConfigDoc = {
			mixtures: Array.from({ length: count }, (_, index) => ({
				name: `mix-${String(index).padStart(3, "0")}`,
				entry: "writer",
				members: [{ id: "writer", model: "fake/writer", tools: false }],
				edges: [],
			})),
		};
		const h = makeOverlay(doc);
		const visits: string[] = [];
		h.overlay.onNavigationVisit = page => visits.push(page);
		try {
			h.overlay.render(120);
			const first = h.overlay.navigationSnapshot().content;
			h.press("\x05");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "mixture:0" });
			expect(h.overlay.navigationSnapshot().content).not.toEqual(first);
			h.press("\x19");
			expect(h.overlay.navigationSnapshot().content).toEqual(first);
			h.press("\x04");
			expect(h.overlay.navigationSnapshot().content).not.toMatchObject({ selectedValue: "mixture:0" });
			h.press("\x15", "g", "g");
			h.overlay.render(120);
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "mixture:0" });
			h.press("G");
			h.overlay.render(120);
			const last = h.overlay.navigationSnapshot().content;
			h.press("g", "h", "g");
			expect(h.overlay.navigationSnapshot().content).toEqual(last);
			h.press("g");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "mixture:0" });
			h.press("l");
			expect(h.overlay.navigationSnapshot()).toMatchObject({ context: { page: "list" }, previewFocused: true });
			h.press("\x10");
			expect(h.overlay.navigationSnapshot().previewFocused).toBe(false);
			h.press("\x0e");
			expect(h.overlay.navigationSnapshot().previewFocused).toBe(true);
			h.press("\t");
			expect(h.overlay.navigationSnapshot().previewFocused).toBe(false);
			expect(visits).toEqual([]);
			h.press("/", "hjkl/ g");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({
				filter: "",
				filterDraft: "hjkl/ g",
				filterFocused: true,
			});
			h.press(ESC); // Insert -> Normal, still editing the search.
			expect(h.actions).toEqual([]);
			expect(h.overlay.navigationSnapshot().content).toMatchObject({
				filter: "",
				filterDraft: "hjkl/ g",
				filterFocused: true,
			});
			h.press(ESC); // Cancel the draft and return to list navigation.
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ filter: "", filterFocused: false });
			h.press(ESC);
			expect(h.actions).toEqual(["close"]);
		} finally {
			h.overlay.dispose();
		}
	});

	it("scrolls the root preview by visual lines, pages, and bounds without relocating selection", () => {
		const count = Math.max(60, (process.stdout.rows || 40) * 3);
		const doc = structuredClone(graph);
		doc.mixtures[0]!.members = Array.from({ length: count }, (_, index) => ({
			id: `worker-${index}`,
			model: "fake/writer",
			tools: false,
		}));
		doc.mixtures[0]!.entry = "worker-0";
		doc.mixtures[0]!.edges = [];
		const h = makeOverlay(doc);
		const restored = makeOverlay({ mixtures: [] });
		const visits: string[] = [];
		h.overlay.onNavigationVisit = page => visits.push(page);
		try {
			const rows = h.overlay.render(120).length - 4;
			const selection = h.overlay.navigationSnapshot().content;
			h.press("l", "j", "\x05");
			expect(h.overlay.navigationSnapshot().previewScroll).toBe(2);
			h.press("\x19", "k");
			expect(h.overlay.navigationSnapshot().previewScroll).toBe(0);
			h.press("\x04");
			expect(h.overlay.navigationSnapshot().previewScroll).toBe(Math.max(1, Math.floor(rows / 2)));
			h.press("\x15", "\x1b[6~");
			expect(h.overlay.navigationSnapshot().previewScroll).toBe(rows);
			h.press("\x1b[5~", "G");
			const bottom = h.overlay.navigationSnapshot().previewScroll;
			expect(bottom).toBeGreaterThan(0);
			expect(Bun.stripANSI(h.overlay.render(120).join("\n"))).toContain("(no edges");
			expect(h.overlay.navigationSnapshot().content).toEqual(selection);
			const snapshot = h.overlay.navigationSnapshot();
			restored.overlay.restoreNavigation(snapshot);
			restored.overlay.render(120);
			expect(restored.overlay.navigationSnapshot()).toMatchObject({ previewFocused: true, previewScroll: bottom });
			expect(restored.overlay.navigationSnapshot().content).toEqual(selection);
			h.press("g", "g", "\x1b[F");
			expect(h.overlay.navigationSnapshot().previewScroll).toBe(bottom);
			h.press(HOME, "h");
			expect(h.overlay.navigationSnapshot()).toMatchObject({ previewFocused: false, previewScroll: 0 });
			expect(visits).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("restores a long parent member list with its exact filter caret and viewport", () => {
		const count = Math.max(60, (process.stdout.rows || 40) * 3);
		const doc = structuredClone(graph);
		doc.mixtures[0]!.members = Array.from({ length: count }, (_, index) => ({
			id: `worker-${String(index).padStart(3, "0")}`,
			model: "fake/writer",
			tools: false,
		}));
		doc.mixtures[0]!.entry = "worker-000";
		const h = makeOverlay(doc);
		const restored = makeOverlay({ mixtures: [] });
		try {
			h.press(ENTER);
			h.choose("Members");
			h.press("/", "worker", "\x1b[D", ENTER);
			h.overlay.render(120);
			h.press("G");
			h.overlay.render(120);
			const parent = h.overlay.navigationSnapshot().content;
			h.press("l");
			expect(h.overlay.navigationSnapshot().context).toMatchObject({ page: "member", position: count - 1 });
			restored.overlay.restoreNavigation(h.overlay.navigationSnapshot());
			restored.press("h");
			restored.overlay.render(120);
			expect(restored.overlay.navigationSnapshot().content).toEqual(parent);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	for (const [page, action, property] of [
		["Route instructions", "Remove route condition", "route"],
		["Termination instructions", "Remove termination condition", "terminate"],
	]) {
		it(`keeps Space/l inert on ${action} and captures the pre-removal page`, () => {
			const h = makeOverlay(navigationDoc());
			const restored = makeOverlay({ mixtures: [] });
			const visits: Array<{ page: string; previous: unknown }> = [];
			try {
				h.press(ENTER);
				h.choose("Members");
				h.choose("writer");
				h.choose(page!);
				h.choose(action!, "l");
				const before = h.overlay.navigationSnapshot();
				h.overlay.onNavigationVisit = (next, previous) => visits.push({ page: next, previous });
				h.press(" ", "l");
				expect(h.overlay.navigationSnapshot()).toEqual(before);
				expect(visits).toEqual([]);
				h.press(ENTER);
				expect(h.overlay.navigationSnapshot().doc.mixtures[0]?.members[0]).toMatchObject({
					[property!]: undefined,
				});
				expect(visits).toHaveLength(1);
				expect(visits[0]?.previous).toMatchObject({ context: before.context, doc: before.doc });
				restored.overlay.restoreNavigation(visits[0]?.previous);
				expect(restored.overlay.navigationSnapshot().doc).toEqual(before.doc);
				expect(restored.actions).toEqual([]);
			} finally {
				h.overlay.dispose();
				restored.overlay.dispose();
			}
		});
	}

	it("does not restore an armed Delete or a discard confirmation", () => {
		const h = makeOverlay(graph);
		const restored = makeOverlay({ mixtures: [] });
		try {
			h.press(DELETE);
			expect(h.overlay.blocksMenuHistory).toBe(false);
			restored.overlay.restoreNavigation(h.overlay.navigationSnapshot());
			restored.press(DELETE);
			expect(restored.overlay.navigationSnapshot().doc.mixtures).toHaveLength(1);
			restored.press("g");
			expect(restored.overlay.navigationSnapshot().doc.mixtures).toHaveLength(1);
			restored.press(ENTER);
			restored.choose("Name", "l");
			restored.press("2", ENTER, ESC, ESC); // Clear the confirmed Name filter, then return to the root.
			expect(restored.overlay.navigationSnapshot().context.page).toBe("list");
			const root = restored.overlay.navigationSnapshot();
			restored.press(ESC, DOWN, " ", "l");
			expect(restored.actions).toEqual([]);
			const confirmation = restored.overlay.navigationSnapshot();
			expect(confirmation.context.page).toBe("list");
			expect(confirmation.content).toEqual(root.content);
			restored.overlay.restoreNavigation(confirmation);
			restored.press(ESC, ENTER);
			expect(restored.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("never runs Add edge or Add level while restoring their resulting pages", () => {
		const h = makeOverlay(graph);
		const restored = makeOverlay({ mixtures: [] });
		const score = makeOverlay(navigationDoc("score"));
		try {
			h.press(ENTER);
			h.choose("Edges");
			h.choose("Add edge", "l");
			expect(h.overlay.navigationSnapshot()).toMatchObject({
				context: { page: "edges" },
				doc: { mixtures: [{ edges: graph.mixtures[0]!.edges }] },
			});
			h.press(ENTER);
			expect(h.overlay.navigationSnapshot()).toMatchObject({ context: { page: "edge", position: 1 } });
			restored.overlay.restoreNavigation(h.overlay.navigationSnapshot());
			expect(restored.overlay.navigationSnapshot().doc.mixtures[0]?.edges).toHaveLength(2);
			score.press(ENTER);
			score.choose("Members");
			score.choose("judge");
			score.choose("Ordered score levels");
			score.choose("Add level", "l");
			expect(score.overlay.navigationSnapshot().doc.mixtures[0]?.members.at(-1)).toMatchObject({
				question: { criteria: ["Weak", "Strong"] },
			});
			score.press(ENTER);
			const snapshot = score.overlay.navigationSnapshot();
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot().doc.mixtures[0]?.members.at(-1)).toMatchObject({
				question: { criteria: ["Weak", "Strong", ""] },
			});
			expect(restored.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
			score.overlay.dispose();
		}
	});

	it("restores the new-preset editor continuation and full pasted draft without creating another preset", () => {
		const h = makeOverlay(graph);
		const restored = makeOverlay({ mixtures: [] });
		const text = Array.from({ length: 12 }, (_, index) => `line ${index} hjkl / draft`).join("\n");
		try {
			h.press(ENTER);
			h.choose("Role presets");
			expect(h.overlay.navigationSnapshot().doc.mixtures[0]?.roles).toBeUndefined();
			h.choose("Add preset", "l");
			expect(h.overlay.navigationSnapshot().context.page).toBe("presets");
			h.press(ENTER, "new-role", ENTER);
			expect(h.overlay.navigationSnapshot().context).toMatchObject({ page: "preset", name: "new-role" });
			h.overlay.pasteText(text);
			const snapshot = h.overlay.navigationSnapshot();
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
			expect(restored.overlay.navigationSnapshot().doc.mixtures[0]?.roles).toEqual({ "new-role": "" });
			restored.press("\x11");
			expect(restored.overlay.navigationSnapshot().doc.mixtures[0]?.roles).toEqual({ "new-role": text });
			expect(h.overlay.navigationSnapshot().doc.mixtures[0]?.roles).toEqual({ "new-role": "" });
			expect(restored.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});
});

describe("mixture model continuation and pending ownership", () => {
	it("restores model-to-effort data without assigning, then confirms once back to the cached picker", () => {
		const model = buildModel({
			id: "fixture-thinker",
			name: "Fixture thinker",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://example.test",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
		const fixtureDeps = { ...deps, getAvailableModels: () => [model] };
		const h = makeOverlay(graph, {}, fixtureDeps);
		const restored = makeOverlay({ mixtures: [] }, {}, fixtureDeps);
		const visits: Array<{ page: string; previous: unknown }> = [];
		restored.overlay.onNavigationVisit = (page, previous) => visits.push({ page, previous });
		try {
			h.press(ENTER);
			h.choose("Members");
			h.choose("writer");
			h.choose("Model", "l");
			h.press("/", "fixture", "\x1b[D", ENTER);
			h.overlay.render(120);
			const picker = h.overlay.navigationSnapshot().content;
			h.press(ENTER);
			expect(h.overlay.navigationSnapshot().context).toMatchObject({
				page: "thinking",
				selector: "anthropic/fixture-thinker",
			});
			h.press("l");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "low" });
			h.press("G", "l");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "high" });
			const snapshot = h.overlay.navigationSnapshot();
			expect(snapshot.doc.mixtures[0]?.members[0]).toMatchObject({ model: "fake/writer" });
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
			expect(visits).toEqual([]);
			expect(restored.actions).toEqual([]);
			restored.press(ENTER);
			restored.overlay.render(120);
			expect(restored.overlay.navigationSnapshot()).toMatchObject({ context: { page: "model" }, dirty: true });
			expect(restored.overlay.navigationSnapshot().doc.mixtures[0]?.members[0]).toMatchObject({
				model: "anthropic/fixture-thinker:high",
			});
			expect(restored.overlay.navigationSnapshot().content).toEqual(picker);
			expect(visits).toHaveLength(1);
			expect(visits[0]?.previous).toMatchObject({ context: snapshot.context, doc: snapshot.doc });
			expect(h.overlay.navigationSnapshot().doc.mixtures[0]?.members[0]).toMatchObject({ model: "fake/writer" });
			expect(restored.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("keeps the no-effort model confirmation as one explicit assignment and one member-page visit", () => {
		const model = buildModel({
			id: "fixture-plain",
			name: "Fixture plain",
			provider: "test",
			api: "ollama-chat",
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const h = makeOverlay(graph, {}, { ...deps, getAvailableModels: () => [model] });
		const visits: Array<{ page: string; previous: unknown }> = [];
		try {
			h.press(ENTER);
			h.choose("Members");
			h.choose("writer");
			h.choose("Model", "l");
			const before = h.overlay.navigationSnapshot();
			h.overlay.onNavigationVisit = (page, previous) => visits.push({ page, previous });
			h.press(ENTER);
			expect(h.overlay.navigationSnapshot().context.page).toBe("member");
			expect(h.overlay.navigationSnapshot().doc.mixtures[0]?.members[0]).toMatchObject({
				model: "test/fixture-plain",
			});
			expect(visits).toHaveLength(1);
			expect(visits[0]?.previous).toMatchObject({ context: before.context, doc: before.doc });
			expect(h.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
		}
	});

	it("blocks actual save, apply, and radio activation promises and restores their UI flags without replay", async () => {
		const save = Promise.withResolvers<void>();
		const apply = Promise.withResolvers<void>();
		const activate = Promise.withResolvers<void>();
		const saved = Promise.withResolvers<void>();
		const applied = Promise.withResolvers<void>();
		const activated = Promise.withResolvers<void>();
		let panel: MixtureConfigOverlayComponent | undefined = undefined;
		let onIdle: (() => void) | undefined;
		let saves = 0;
		let applies = 0;
		let activations = 0;
		const h = makeOverlay(graph, {
			save: () => {
				saves++;
				return save.promise;
			},
			apply: () => {
				applies++;
				return apply.promise;
			},
			activate: () => {
				activations++;
				return activate.promise;
			},
			requestRender: () => {
				if (panel && !panel.blocksMenuHistory) onIdle?.();
			},
		});
		panel = h.overlay;
		const restored = makeOverlay({ mixtures: [] });
		try {
			h.press(ENTER);
			h.choose("Name", "l");
			h.press("2", ENTER, ESC, ESC); // Clear the confirmed Name filter, then return to the root.
			expect(h.overlay.navigationSnapshot().context.page).toBe("list");
			onIdle = saved.resolve;
			h.press("s");
			expect(h.overlay.blocksMenuHistory).toBe(true);
			expect(saves).toBe(1);
			save.resolve();
			await saved.promise;
			expect(h.overlay.blocksMenuHistory).toBe(false);
			const snapshot = h.overlay.navigationSnapshot();
			expect(snapshot).toMatchObject({ dirty: false, pendingApply: true });
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot()).toMatchObject({ dirty: false, pendingApply: true });
			expect(restored.actions).toEqual([]);
			onIdle = applied.resolve;
			h.press("a");
			expect(h.overlay.blocksMenuHistory).toBe(true);
			expect(applies).toBe(1);
			apply.resolve();
			await applied.promise;
			expect(h.overlay.navigationSnapshot().pendingApply).toBe(false);
			onIdle = activated.resolve;
			h.press(" ");
			expect(h.overlay.blocksMenuHistory).toBe(true);
			expect(activations).toBe(1);
			activate.resolve();
			await activated.promise;
			expect(h.overlay.blocksMenuHistory).toBe(false);
			expect(saves).toBe(1);
			expect(applies).toBe(1);
			expect(activations).toBe(1);
		} finally {
			save.resolve();
			apply.resolve();
			activate.resolve();
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("keeps dirty save-and-apply blocked across the save completion and apply await", async () => {
		const save = Promise.withResolvers<void>();
		const apply = Promise.withResolvers<void>();
		const applying = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		let panel: MixtureConfigOverlayComponent | undefined = undefined;
		let recording = false;
		const states: boolean[] = [];
		const h = makeOverlay(graph, {
			save: () => save.promise,
			apply: () => {
				applying.resolve();
				return apply.promise;
			},
			requestRender: () => {
				if (!panel || !recording) return;
				states.push(panel.blocksMenuHistory);
				if (!panel.blocksMenuHistory) done.resolve();
			},
		});
		panel = h.overlay;
		try {
			h.press(ENTER);
			h.choose("Name", "l");
			h.press("2", ENTER, ESC, ESC); // Clear the confirmed Name filter, then return to the root.
			expect(h.overlay.navigationSnapshot().context.page).toBe("list");
			recording = true;
			h.press("a");
			expect(h.overlay.blocksMenuHistory).toBe(true);
			save.resolve();
			await applying.promise;
			expect(h.overlay.blocksMenuHistory).toBe(true);
			expect(states.length).toBeGreaterThan(0);
			expect(states.every(Boolean)).toBe(true);
			apply.resolve();
			await done.promise;
			expect(h.overlay.blocksMenuHistory).toBe(false);
		} finally {
			save.resolve();
			apply.resolve();
			h.overlay.dispose();
		}
	});

	it("leaves read-only scope loads unblocked and ignores their result after in-place history restoration", async () => {
		const load = Promise.withResolvers<MixturesConfigDoc>();
		let loads = 0;
		const h = makeOverlay(graph, {
			loadDoc: () => {
				loads++;
				return load.promise;
			},
		});
		const visits: string[] = [];
		h.overlay.onNavigationVisit = page => visits.push(page);
		try {
			h.choose("Scope");
			expect(loads).toBe(1);
			expect(h.overlay.blocksMenuHistory).toBe(false);
			const before = h.overlay.navigationSnapshot();
			h.overlay.restoreNavigation(before);
			expect(loads).toBe(1);
			load.resolve({ mixtures: [], warnings: ["late warning"] });
			await load.promise;
			expect(h.overlay.navigationSnapshot()).toEqual(before);
			expect(h.notices).toEqual([]);
			expect(h.actions).toEqual([]);
			expect(visits).toEqual([]);
		} finally {
			load.resolve({ mixtures: [] });
			h.overlay.dispose();
		}
	});

	it("treats a completed scope switch as context and restores it without loading again", async () => {
		const loaded = Promise.withResolvers<void>();
		const userDoc = structuredClone(graph);
		userDoc.mixtures[0]!.name = "user mixture";
		let panel: MixtureConfigOverlayComponent | undefined = undefined;
		let loads = 0;
		const h = makeOverlay(graph, {
			loadDoc: async () => {
				loads++;
				return userDoc;
			},
			requestRender: () => {
				if (panel?.navigationSnapshot().scope === "user") loaded.resolve();
			},
		});
		panel = h.overlay;
		let restoredLoads = 0;
		const restored = makeOverlay(
			{ mixtures: [] },
			{
				loadDoc: async () => {
					restoredLoads++;
					return { mixtures: [] };
				},
			},
		);
		const visits: string[] = [];
		h.overlay.onNavigationVisit = page => visits.push(page);
		try {
			h.choose("Scope");
			await loaded.promise;
			const snapshot = h.overlay.navigationSnapshot();
			expect(snapshot.scope).toBe("user");
			expect(snapshot.doc).toEqual(userDoc);
			expect(loads).toBe(1);
			expect(visits).toEqual([]);
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
			expect(restoredLoads).toBe(0);
			expect(restored.actions).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
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
