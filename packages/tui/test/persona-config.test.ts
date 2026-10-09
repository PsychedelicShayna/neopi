import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type PersonaConfigDoc,
	type PersonaConfigDeps,
	type PersonaConfigEntry,
	PersonaConfigOverlayComponent,
	type PersonaConfigVariant,
} from "../src/overlays/persona-config";
import { getThemeByName, setThemeInstance } from "../src/theme";

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
) {
	const saved: PersonaConfigDoc[] = [];
	let closed = false;
	const overlay = new PersonaConfigOverlayComponent({} as unknown as TUI, { variant, ...deps }, doc, {
		save: async next => {
			saved.push(structuredClone(next));
			return "saved";
		},
		close: () => {
			closed = true;
		},
		requestRender: () => {},
	});
	const press = (...keys: string[]) => {
		for (const key of keys) overlay.handleInput(key);
	};
	const frame = () => overlay.render(100).join("\n");
	return { overlay, saved, press, frame, isClosed: () => closed };
}

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (loaded) setThemeInstance(loaded);
});

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
		press(ESC);
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
		cloned.press(ENTER, DOWN, DOWN, ENTER, SPACE, ESC, DOWN, ENTER, ENTER);
		cloned.press(DOWN, DOWN, DOWN, ENTER, SPACE, "s");
		await Bun.sleep(0);
		const saved = cloned.saved.at(-1);
		expect(saved?.entries[0]?.sources?.[0]?.value).toBe(true);
		expect(saved?.entries[1]?.sources?.[0]?.value).toBe(false);
		expect(saved?.entries[0]?.sources).not.toBe(saved?.entries[1]?.sources);
		expect(saved?.entries[0]?.sourcesRaw).not.toBe(saved?.entries[1]?.sourcesRaw);
	});
});
