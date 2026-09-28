import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "../src/index";
import {
	type PersonaConfigDoc,
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

function makeOverlay(doc: PersonaConfigDoc, variant: PersonaConfigVariant = "persona") {
	const saved: PersonaConfigDoc[] = [];
	let closed = false;
	const overlay = new PersonaConfigOverlayComponent({} as unknown as TUI, { variant }, doc, {
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
		// Detail rows for the built-in: Active, Instructions, Clone to customize, Back.
		press(ENTER, DOWN, DOWN, ENTER);
		press(ENTER); // accept the suggested "default-copy" name
		press("s");
		await Bun.sleep(0);
		const names = saved.at(-1)?.entries.map(e => e.name);
		expect(names).toEqual(["default", "default-copy"]);
		expect(saved.at(-1)?.entries[1]?.content).toBe("bundled");
	});
});
