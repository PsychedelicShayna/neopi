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
		close: () => {},
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
		h.press(DOWN, ENTER); // 'to' picker
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
});
