import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { PersonaGenerationDeps, PersonaGenerationRequest } from "../src/overlays/persona-config";
import type { TUI } from "../src/index";
import {
	type PersonaConfigDoc,
	type PersonaConfigCallbacks,
	type PersonaConfigDeps,
	type PersonaConfigEntry,
	PersonaConfigOverlayComponent,
	type PersonaConfigVariant,
} from "../src/overlays/persona-config";
import { getThemeByName, setThemeInstance } from "../src/theme";
import { KeybindingsManager } from "../src/app-keybindings";
import { setKeybindings } from "../src/keybindings";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";
const SPACE = " ";

function entry(name: string, fields: Partial<PersonaConfigEntry> = {}): PersonaConfigEntry {
	return {
		name,
		originalName: name,
		mode: "replace",
		sourceKind: "inline",
		content: `${name} text`,
		path: "",
		literal: "",
		inheritToTasks: false,
		...fields,
	};
}

function makeOverlay(
	doc: PersonaConfigDoc,
	variant: PersonaConfigVariant = "persona",
	deps: Partial<PersonaConfigDeps> = {},
	callbacks: Partial<PersonaConfigCallbacks> = {},
) {
	const lifecycle = { starts: 0, stops: 0 };
	const saved: PersonaConfigDoc[] = [];
	let closed = false;
	const overlay = new PersonaConfigOverlayComponent(
		{
			start() {
				lifecycle.starts++;
			},
			stop() {
				lifecycle.stops++;
			},
		} as unknown as TUI,
		{ variant, ...deps },
		doc,
		{
			save: async next => {
				saved.push(structuredClone(next));
				return "saved";
			},
			close: () => {
				closed = true;
			},
			requestRender: () => {},
			...callbacks,
		},
	);
	const press = (...keys: string[]) => {
		for (const key of keys) overlay.handleInput(key);
	};
	const frame = () => overlay.render(100).join("\n");
	return { overlay, saved, press, frame, lifecycle, isClosed: () => closed };
}

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (loaded) setThemeInstance(loaded);
});

beforeEach(() => setKeybindings(KeybindingsManager.inMemory()));
afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("PersonaConfigOverlayComponent", () => {
	it("Space activates the highlighted persona and s saves that selection", async () => {
		const { press, saved } = makeOverlay({ entries: [entry("alpha"), entry("beta")] });
		press(DOWN, SPACE, "s");
		await Bun.sleep(0);
		expect(saved.at(-1)?.active).toBe("beta");
		press(SPACE, "s");
		await Bun.sleep(0);
		expect(saved.at(-1)?.active).toBeUndefined();
	});

	it("deletes a persona only on the second Delete, and any other key cancels", async () => {
		const { press, saved } = makeOverlay({ entries: [entry("alpha"), entry("beta")], active: "alpha" });
		press(DELETE, DOWN);
		press("s");
		await Bun.sleep(0);
		expect(saved.at(-1)?.entries.map(e => e.name)).toEqual(["alpha", "beta"]);
		press(DELETE, DELETE, "s");
		await Bun.sleep(0);
		expect(saved.at(-1)?.entries.map(e => e.name)).toEqual(["alpha"]);
		expect(saved.at(-1)?.active).toBe("alpha");
	});

	it("refuses to save a literal-substitute persona without a literal", async () => {
		const { press, saved, frame } = makeOverlay({
			entries: [entry("alpha", { mode: "literal-substitute" })],
		});
		press("s");
		await Bun.sleep(0);
		expect(saved).toEqual([]);
		expect(frame()).toContain("needs a literal");
	});

	it("asks before discarding unsaved changes on Esc", () => {
		const { press, isClosed, frame } = makeOverlay({ entries: [entry("alpha")] });
		press(SPACE, ESC);
		expect(isClosed()).toBe(false);
		expect(frame()).toContain("Unsaved changes");
		press(ESC);
		expect(isClosed()).toBe(true);
	});

	it.each(["replace", "prepend", "append", "literal-substitute"] as const)(
		"clones a file-backed %s persona without changing its definition",
		async mode => {
			const original = entry("alpha", {
				mode,
				sourceKind: "file",
				content: "",
				path: "personas/alpha.md",
				literal: "replace this",
				inheritToTasks: true,
			});
			const { press, saved } = makeOverlay({ entries: [original] });
			press(ENTER, DOWN, DOWN, DOWN, DOWN, DOWN);
			if (mode === "literal-substitute") press(DOWN);
			press(DOWN, ENTER, ENTER, "s");
			await Bun.sleep(0);
			expect(saved.at(-1)?.entries[1]).toEqual({
				...original,
				name: "alpha-copy",
				originalName: undefined,
				sources: undefined,
				sourcesRaw: undefined,
			});
		},
	);

	it("locks editing and closing until an asynchronous save completes", async () => {
		const pending = Promise.withResolvers<string>();
		const doc: PersonaConfigDoc = { entries: [entry("alpha")] };
		let saves = 0;
		let closed = false;
		const overlay = new PersonaConfigOverlayComponent({} as TUI, { variant: "persona" }, doc, {
			save: () => {
				saves++;
				return pending.promise;
			},
			close: () => {
				closed = true;
			},
			requestRender: () => {},
		});
		overlay.handleInput(SPACE);
		overlay.handleInput("s");
		for (const key of [SPACE, DELETE, DELETE, ENTER, "s", ESC, ESC]) overlay.handleInput(key);
		expect(doc.entries).toHaveLength(1);
		expect(doc.active).toBe("alpha");
		expect(closed).toBe(false);
		expect(saves).toBe(1);
		pending.resolve("saved");
		await Bun.sleep(0);
		overlay.handleInput(SPACE);
		overlay.handleInput(ESC);
		expect(closed).toBe(false);
		expect(overlay.render(100).join("\n")).toContain("Unsaved changes");
	});

	it.each(["persona", "live"] as const)("renders terminal-safe %s preview fields", variant => {
		const { frame, press } = makeOverlay(
			{
				entries: [entry("alpha", { content: "before\tafter", mode: "literal-substitute", literal: "old\ttext" })],
			},
			variant,
		);
		expect(frame()).not.toContain("\t");
		press(ENTER);
		expect(frame()).not.toContain("\t");
		const file = makeOverlay(
			{
				entries: [entry("alpha", { sourceKind: "file", path: "folder\tname/persona.md" })],
			},
			variant,
		);
		expect(file.frame()).not.toContain("\t");
		file.press(ENTER);
		expect(file.frame()).not.toContain("\t");
	});

	it("keeps the live built-in default immutable but cloneable", async () => {
		const builtin = entry("default", { builtin: true, originalName: undefined, content: "bundled" });
		const { press, saved } = makeOverlay({ entries: [builtin] }, "live");
		press(DELETE, DELETE);
		// Detail rows for the built-in: Active, Instructions, Context sources, Clone to customize, Back.
		press(ENTER, DOWN, DOWN, DOWN, ENTER);
		press(ENTER); // accept the suggested "default-copy" name
		press("s");
		await Bun.sleep(0);
		const names = saved.at(-1)?.entries.map(e => e.name);
		expect(names).toEqual(["default", "default-copy"]);
		expect(saved.at(-1)?.entries[1]?.content).toBe("bundled");
	});

	it("appends client protocol lines once on a custom live persona", async () => {
		const protocol = "<client-protocol>\nFollow the labels.\n</client-protocol>\n";
		const first = makeOverlay({ entries: [entry("custom", { content: "Be concise.  \n" })] }, "live", {
			protocolLinesText: protocol,
			protocolMarker: "<client-protocol>",
		});
		first.press(ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
		expect(first.frame()).toContain("Client protocol lines appended");
		first.press("s");
		await Bun.sleep(0);
		expect(first.saved.at(-1)?.entries[0]?.content).toBe(`Be concise.\n\n${protocol}`);

		const existing = `Be concise.\n\n${protocol}`;
		const second = makeOverlay({ entries: [entry("custom", { content: existing })] }, "live", {
			protocolLinesText: protocol,
			protocolMarker: "<client-protocol>",
		});
		second.press(ENTER, DOWN, DOWN, DOWN, DOWN, ENTER);
		expect(second.frame()).toContain("Already present");
		second.press("s");
		await Bun.sleep(0);
		expect(second.saved.at(-1)?.entries[0]?.content).toBe(existing);
	});

	it("keeps disabled source choices fixed and saves enabled toggles", async () => {
		const sourceEntry = entry("custom", {
			sources: [
				{ key: "subagents", label: "Subagents", kind: "boolean", value: false },
				{
					key: "subagentMaxDepth",
					label: "Subagent max depth",
					kind: "choice",
					value: "1",
					options: [
						{ value: "1", label: "Direct children only" },
						{ value: "2", label: "2" },
					],
					enabledBy: "subagents",
				},
				{
					key: "effortAlerts",
					label: "Effort red alerts (catalog)",
					kind: "boolean",
					value: true,
				},
			],
		});
		const { press, saved, frame } = makeOverlay({ entries: [sourceEntry] }, "live");
		press(ENTER, DOWN, DOWN, DOWN, ENTER, DOWN);
		expect(frame()).toContain("(needs Subagents)");
		press(SPACE, "s");
		await Bun.sleep(0);
		expect(saved.at(-1)?.entries[0]?.sources?.[1]?.value).toBe("1");
		press("h");
		expect(frame()).toContain("Context sources");
	});

	it("creates and clones independent live source data", async () => {
		let factoryCalls = 0;
		const raw = { nested: { value: 1 } };
		const created = makeOverlay({ entries: [] }, "live", {
			newEntryContent: "instructions",
			newEntrySources: () => {
				factoryCalls++;
				return {
					fields: [{ key: "subagents", label: "Subagents", kind: "boolean", value: false }],
					raw,
				};
			},
		});
		created.press(ENTER, ENTER, "s");
		await Bun.sleep(0);
		expect(factoryCalls).toBe(1);
		expect(created.saved).toHaveLength(1);
		expect(created.saved.at(-1)?.entries[0]?.sources).toHaveLength(1);
		expect(created.saved.at(-1)?.entries[0]?.sourcesRaw).not.toBe(raw);

		const builtin = entry("default", {
			builtin: true,
			originalName: undefined,
			content: "bundled",
			sources: [{ key: "subagents", label: "Subagents", kind: "boolean", value: false }],
			sourcesRaw: { nested: { value: 1 } },
		});
		const cloned = makeOverlay({ entries: [builtin] }, "live");
		cloned.press(ENTER, DOWN, DOWN, ENTER, SPACE, "h", DOWN, ENTER, ENTER);
		cloned.press(DOWN, DOWN, DOWN, ENTER, SPACE, "s");
		await Bun.sleep(0);
		const saved = cloned.saved.at(-1);
		expect(saved?.entries[0]?.sources?.[0]?.value).toBe(true);
		expect(saved?.entries[1]?.sources?.[0]?.value).toBe(false);
		expect(saved?.entries[0]?.sources).not.toBe(saved?.entries[1]?.sources);
		expect(saved?.entries[0]?.sourcesRaw).not.toBe(saved?.entries[1]?.sourcesRaw);
	});

	it("keeps search literal, visits nested pages, and restores a safe field draft", () => {
		const { overlay, press, saved } = makeOverlay({ entries: [entry("hjkl"), entry("beta")] });
		const visits: { page: string; previous: unknown }[] = [];
		overlay.onNavigationVisit = (page, previous) => {
			visits.push({ page, previous });
		};
		press("/", "hjkl", ESC, ENTER);
		expect(visits.at(-1)?.page).toBe("detail:0");
		const detail = overlay.navigationSnapshot();
		press("l", "\x15", "draft hjkl");
		const draft = overlay.navigationSnapshot();
		expect(draft.context.screen).toBe("name");
		const restored = makeOverlay({ entries: [entry("other")] });
		restored.overlay.restoreNavigation(draft);
		expect(restored.overlay.navigationSnapshot()).toEqual(draft);
		restored.press(ENTER, "s");
		expect(saved).toEqual([]);
		overlay.restoreNavigation(detail);
		expect(overlay.navigationSnapshot()).toEqual(detail);
		const count = visits.length;
		overlay.restoreNavigation(detail);
		expect(visits).toHaveLength(count);
	});

	it("uses h and Esc for parent, closes only at root, and keeps Space off Delete", () => {
		const nested = makeOverlay({ entries: [entry("alpha")] });
		nested.press(ENTER, "G", "k", SPACE);
		expect(nested.overlay.navigationSnapshot().doc.entries).toHaveLength(1);
		nested.press("h");
		expect(nested.overlay.navigationSnapshot().context.screen).toBe("list");
		nested.press(ENTER, ESC);
		expect(nested.isClosed()).toBe(false);
		expect(nested.overlay.navigationSnapshot().context.screen).toBe("list");
		nested.press(ESC);
		expect(nested.isClosed()).toBe(true);
	});
	it("preserves a registered multiline prompt draft without submitting it", () => {
		const original = makeOverlay({ entries: [entry("alpha")] });
		original.press(ENTER, "/", "Content", ESC, ENTER, " draft hjkl");
		const snapshot = original.overlay.navigationSnapshot();
		expect(snapshot.context.screen).toBe("content");
		const restored = makeOverlay({ entries: [entry("beta")] });
		restored.overlay.restoreNavigation(snapshot);
		expect(restored.overlay.navigationSnapshot()).toEqual(snapshot);
		expect(restored.saved).toEqual([]);
	});

	it("switches root preview contexts without visits and scrolls only the focused pane", () => {
		const { overlay, press, frame } = makeOverlay({
			entries: [
				entry("alpha", { content: Array.from({ length: 140 }, (_, index) => `Preview line ${index}`).join("\n") }),
				entry("beta"),
			],
		});
		const contentRows = frame().split("\n").length - 5;
		const list = overlay.navigationSnapshot().content;
		const visits: string[] = [];
		overlay.onNavigationVisit = page => visits.push(page);
		press("l", "j", "\x05");
		expect(overlay.navigationSnapshot()).toMatchObject({
			previewFocused: true,
			previewScroll: 2,
			context: { screen: "list" },
		});
		expect(overlay.navigationSnapshot().content).toEqual(list);
		expect(frame()).toContain("Preview");
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
		press("\x1b[H");
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
		expect(overlay.navigationSnapshot().context.screen).toBe("detail");
		expect(visits).toEqual(["detail:0"]);
	});

	it("retains parent filtering, caret, selection, viewport and preview focus on back and silent restore", () => {
		const { overlay, press, frame } = makeOverlay({
			entries: Array.from({ length: 80 }, (_, index) =>
				entry(`prefix-${index}`, { content: "Long preview\n".repeat(100) }),
			),
		});
		frame();
		press("/", "prefix", "\x1b[D", ESC, "G");
		frame();
		press("l", "G");
		const parent = overlay.navigationSnapshot();
		press(ENTER, "h");
		expect(overlay.navigationSnapshot().content).toEqual(parent.content);
		expect(overlay.navigationSnapshot()).toMatchObject({ previewFocused: true, previewScroll: parent.previewScroll });
		const restored = makeOverlay({ entries: [] });
		restored.overlay.restoreNavigation(parent);
		expect(restored.overlay.navigationSnapshot()).toEqual(parent);
		restored.press("/");
		expect(restored.overlay.navigationSnapshot()).toMatchObject({
			previewFocused: false,
			content: { filterFocused: true },
		});
	});

	it("owns gg once and resets the prefix on pane, field, mouse and restore transitions", () => {
		const { overlay, press, frame } = makeOverlay({
			entries: Array.from({ length: 80 }, (_, index) => entry(`entry-${index}`)),
		});
		frame();
		press("G", "g", "l", "h", "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "entry:0" });
		press("G", "g", "/", ESC, "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "entry:0" });
		press("G", "g", "\x1b[<35;90;2M", "g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		const snapshot = overlay.navigationSnapshot();
		overlay.restoreNavigation(snapshot);
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "close" });
		press("g");
		expect(overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "entry:0" });
	});

	it("keeps remapped printable actions literal in direct Inputs and leaves explicit exits intact", () => {
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
		const { overlay, press, saved } = makeOverlay({ entries: [entry("alpha")] });
		press(ENTER, ENTER, "\x15");
		for (const character of "hjklggG / ") press(character);
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "name" },
			content: { value: "hjklggG / " },
		});
		expect(saved).toEqual([]);
		press(ESC, ENTER, "\x15", "hjkl", ENTER);
		expect(overlay.navigationSnapshot()).toMatchObject({
			context: { screen: "detail" },
			doc: { entries: [{ name: "hjkl" }] },
		});
	});

	it("captures the pre-delete detail and never treats Space or l as removal approval", () => {
		const { overlay, press, saved } = makeOverlay({ entries: [entry("alpha"), entry("beta")] });
		const visits: { page: string; previous: unknown }[] = [];
		overlay.onNavigationVisit = (page, previous) => visits.push({ page, previous });
		press(ENTER, "G", "k", SPACE, "l");
		expect(overlay.navigationSnapshot().doc.entries).toHaveLength(2);
		press(ENTER);
		expect(overlay.navigationSnapshot().doc.entries.map(item => item.name)).toEqual(["beta"]);
		const previous = visits.at(-1)?.previous;
		expect(previous).toMatchObject({
			context: { screen: "detail", entryIndex: 0 },
			doc: { entries: [{ name: "alpha" }, { name: "beta" }] },
			content: { selectedValue: "delete" },
		});
		const count = visits.length;
		overlay.restoreNavigation(previous);
		expect(overlay.navigationSnapshot().doc.entries.map(item => item.name)).toEqual(["alpha", "beta"]);
		expect(visits).toHaveLength(count);
		expect(saved).toEqual([]);
	});

	it("abandons inline removal on the first g instead of letting a later Delete confirm it", () => {
		const { overlay, press } = makeOverlay({ entries: [entry("alpha"), entry("beta")] });
		press(DELETE, "g", DELETE);
		expect(overlay.navigationSnapshot().doc.entries).toHaveLength(2);
		press(DELETE);
		expect(overlay.navigationSnapshot().doc.entries.map(item => item.name)).toEqual(["beta"]);
	});

	for (const scenario of [
		{ rows: 1, lines: 40, overflows: true },
		{ rows: 24, lines: 40, overflows: true },
		{ rows: 14, lines: 4, overflows: false },
	]) {
		it(`keeps the final preview content readable at G/End with ${scenario.rows} terminal rows`, () => {
			const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: scenario.rows });
			try {
				const marker = "PERSONA-LAST-CONTENT";
				const { overlay, press } = makeOverlay({
					entries: [
						entry("reader", {
							content: Array.from({ length: scenario.lines }, (_, index) =>
								index === scenario.lines - 1 ? marker : `Preview line ${index}`,
							).join("\n"),
						}),
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
				press("\x1b[H", "\x1b[F");
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

describe("live persona generation", () => {
	const model = buildModel({
		id: "generator",
		name: "Generator",
		provider: "test",
		api: "ollama-chat",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
	function generator(generate: PersonaGenerationDeps["generate"]): PersonaGenerationDeps {
		return {
			getAvailableModels: () => [model],
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
			references: async () => [
				{ id: "default", label: "Default live template" },
				{ id: "custom", label: "A creative existing prompt" },
			],
			generate,
		};
	}

	it.each([
		["template only", [0], ["default"]],
		["existing only", [1], ["custom"]],
		["combined", [0, 1], ["default", "custom"]],
	] as const)("generates from %s in generator → references → description order", async (_label, chosen, expected) => {
		const requests: PersonaGenerationRequest[] = [];
		const doc = { entries: [entry("default", { builtin: true })] };
		const h = makeOverlay(doc, "live", {
			generation: generator(async request => {
				requests.push(request);
				return "New spoken instructions.";
			}),
			newEntrySources: () => ({
				fields: [{ key: "irc", label: "IRC", kind: "boolean", value: true }],
				raw: { irc: true },
			}),
		});
		h.press(DOWN, DOWN, ENTER);
		expect(h.frame()).toContain("Select Generator Model");
		expect(h.frame()).not.toContain("Describe Persona");
		h.press(ENTER);
		await Bun.sleep(0);
		expect(h.frame()).toContain("Select Reference Models");
		expect(requests).toHaveLength(0);
		for (const index of chosen) {
			h.press("\x1b[H");
			for (let i = 0; i < index; i++) h.press(DOWN);
			h.press(SPACE);
		}
		h.press("G", ENTER);
		expect(h.frame()).toContain("Describe Persona");
		h.press("A witty navigator", ENTER);
		await Bun.sleep(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.model.id).toBe("generator");
		expect(requests[0]?.references).toEqual([...expected]);
		expect(requests[0]?.description).toBe("A witty navigator");
		expect(doc.entries).toHaveLength(2);
		expect(h.saved).toHaveLength(0);
		expect(h.overlay.navigationSnapshot().context.screen).toBe("detail");
		// Enter immediately edits Name, not Instructions or the active selection.
		h.press(ENTER, "\x15", "navigator", ENTER, DOWN, DOWN, ENTER);
		h.press(" Revised.", "\x11", "s");
		await Bun.sleep(0);
		expect(h.saved[0]?.entries[1]?.name).toBe("navigator");
		expect(h.saved[0]?.entries[1]?.content).toContain("Revised.");
		expect(h.saved[0]?.entries[1]?.sourcesRaw).toEqual({ irc: true });
		expect(h.saved[0]?.active).toBeUndefined();
	});

	it("requires a reference and preserves description and choices on back/history", async () => {
		const h = makeOverlay({ entries: [] }, "live", { generation: generator(async () => "unused") });
		h.press(DOWN, ENTER, ENTER);
		await Bun.sleep(0);
		h.press("G", ENTER);
		expect(h.frame()).toContain("Select at least one reference");
		h.press("\x1b[H", SPACE, "G", ENTER, "Keep my words");
		const snapshot = h.overlay.navigationSnapshot();
		h.press(ESC);
		expect(h.frame()).toContain("☑");
		h.overlay.restoreNavigation(snapshot);
		expect(h.frame()).toContain("Keep my words");
	});

	it("cancels in-flight generation without late entries and allows retry after errors", async () => {
		const pending = Promise.withResolvers<string>();
		let request: PersonaGenerationRequest | undefined;
		let attempts = 0;
		const doc = { entries: [] };
		const h = makeOverlay(doc, "live", {
			generation: generator(async value => {
				request = value;
				attempts++;
				if (attempts === 1) return pending.promise;
				throw new Error("Provider unavailable");
			}),
		});
		h.press(DOWN, ENTER, ENTER);
		await Bun.sleep(0);
		h.press(SPACE, "G", ENTER, "Try this", ENTER);
		expect(h.overlay.blocksMenuHistory).toBe(true);
		h.press(ESC);
		expect(request?.signal.aborted).toBe(true);
		expect(h.overlay.blocksMenuHistory).toBe(false);
		pending.resolve("late response");
		await Bun.sleep(0);
		expect(doc.entries).toHaveLength(0);
		expect(h.frame()).toContain("Try this");
		h.press(ENTER);
		await Bun.sleep(0);
		expect(h.frame()).toContain("Provider unavailable");
		expect(doc.entries).toHaveLength(0);
	});
});

describe("standalone personality editor", () => {
	it("uses personality chrome, saves separately from apply and cycles scopes", async () => {
		const doc = { entries: [entry("friendly", { builtin: true }), entry("work")], active: "friendly" };
		let applied = "";
		let scope = "project";
		const h = makeOverlay(
			doc,
			"personality",
			{},
			{
				apply: async next => {
					applied = next.active ?? "";
					return "applied";
				},
				scopeLabel: () => scope,
				cycleScope: async () => {
					scope = "session";
					return structuredClone(doc);
				},
			},
		);
		expect(h.frame()).toContain("Personalities");
		expect(h.frame()).not.toContain("Appearance");
		h.press(DOWN, "s");
		await Bun.sleep(0);
		expect(applied).toBe("");
		expect(h.saved).toHaveLength(1);
		h.press("a");
		await Bun.sleep(0);
		expect(applied).toBe("work");
		h.press("\x13");
		await Bun.sleep(0);
		expect(h.frame()).toContain("session");
	});
	it("asks only for the clone name and opens the multiline editor with copied content", async () => {
		let requested = "";
		const doc = {
			entries: [entry("friendly", { builtin: true, content: "First line\nSecond line" })],
			active: "friendly",
		};
		const h = makeOverlay(
			doc,
			"personality",
			{},
			{
				name: async initial => {
					requested = initial;
					return "my-voice";
				},
			},
		);
		h.press("c");
		await Bun.sleep(0);
		expect(requested).toBe("friendly-copy");
		expect(doc.entries[1]?.content).toBe("First line\nSecond line");
		expect(h.frame()).toContain("First line");
		expect(h.frame()).toContain("Second line");
	});
});

it("opens a highlighted personality directly in the external editor", async () => {
	let text = "";
	const doc = { entries: [entry("custom", { content: "Existing multiline\ncontent" })], active: "custom" };
	const h = makeOverlay(doc, "personality", {
		externalEditor: async value => {
			text = value;
			return "Edited content";
		},
	});
	h.press("\x07");
	await Bun.sleep(0);
	expect(text).toBe("Existing multiline\ncontent");
	expect(h.lifecycle).toEqual({ starts: 1, stops: 1 });
	expect(doc.entries[0]?.content).toBe("Edited content");
	expect(h.frame()).toContain("Edited content");
});

it("keeps inherited personality deletion in its owning scope", async () => {
	const doc = { entries: [entry("inherited", { definitionScope: "global" })] };
	const h = makeOverlay(doc, "personality", {}, { editingScope: () => "project" });
	h.press(DELETE, DELETE);
	expect(doc.entries).toHaveLength(1);
	expect(h.frame()).toContain("Inherited from global");
});
