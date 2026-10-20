import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { PICKER_KEY } from "@oh-my-pi/pi-tui/native/picker";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const CX: DescribeContext = { cols: 30, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}
function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).filter(isNode).flatMap(nodes)];
}
function prop(node: NativeNode | undefined, key: string): unknown {
	return node?.p && typeof node.p === "object" ? Reflect.get(node.p, key) : undefined;
}
function picker(selector: HookSelectorComponent): NativeNode {
	const result = nodes(selector.describe(CX)).find(node => node.k === "picker");
	if (!result) throw new Error("Expected picker");
	return result;
}
function selected(selector: HookSelectorComponent): number {
	return Number(prop(picker(selector), "selected"));
}
function plain(selector: HookSelectorComponent): string {
	return Bun.stripANSI(selector.render(CX.cols).join("\n"));
}
function visibleItems(selector: HookSelectorComponent): number {
	return new Set([...plain(selector).matchAll(/(?:row|tail)(\d\d)/g)].map(match => match[1])).size;
}
function close(selector: HookSelectorComponent): void {
	selector.handleNativeEvent({ type: "action", key: PICKER_KEY, act: "close", mods: [] });
}
function closeLabel(selector: HookSelectorComponent): unknown {
	const actions = prop(picker(selector), "actions");
	return Array.isArray(actions) ? actions.find(action => action.id === "close")?.label : undefined;
}

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("dark theme unavailable");
	setThemeInstance(dark);
});
beforeEach(() => setKeybindings(KeybindingsManager.inMemory()));
afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("hook callback prompt navigation", () => {
	for (const outline of [false, true]) {
		it(`uses visible wrapped options for half/page motions and line-only scroll (${outline ? "outlined" : "plain"})`, () => {
			const options = Array.from({ length: 20 }, (_, index) => {
				const id = String(index).padStart(2, "0");
				return `row${id} ${`tail${id}`.repeat(3)}`;
			});
			const selector = new HookSelectorComponent(
				"Choose",
				options,
				() => {},
				() => {},
				{ maxVisible: 5, outline },
			);
			const half = Math.max(1, Math.floor(visibleItems(selector) / 2));
			selector.handleInput("\x04");
			expect(selected(selector)).toBe(half);
			const page = visibleItems(selector);
			selector.handleInput("\x1b[6~");
			expect(selected(selector)).toBe(Math.min(19, half + page));
			selector.handleInput("G");
			expect(selected(selector)).toBe(19);
			selector.handleInput("j");
			expect(selected(selector)).toBe(19);
			selector.handleInput("g");
			selector.handleInput("g");
			expect(selected(selector)).toBe(0);
			expect(plain(selector)).toContain("row00");
			selector.handleInput("\x05");
			expect(selected(selector)).toBe(0);
			expect(plain(selector)).not.toContain("row00");
			expect(plain(selector)).toContain("tail00");
			selector.handleInput("\x19");
			expect(plain(selector)).toContain("row00");
			expect(selected(selector)).toBe(0);
			selector.handleInput("\x1b[F");
			expect(selected(selector)).toBe(19);
			selector.handleInput("\x1b[H");
			expect(selected(selector)).toBe(0);
			expect("navigationSnapshot" in selector).toBe(false);
			expect("restoreNavigation" in selector).toBe(false);
		});
	}

	it("focuses / search, types remapped menu keys literally, and closes the field first", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["escape", "j", "space"],
				"tui.input.submit": ["enter", "k"],
				"tui.editor.deleteCharBackward": ["backspace", "h"],
				"tui.editor.deleteCharForward": ["delete", "/"],
			}),
		);
		const picks: string[] = [];
		let cancelled = 0;
		const selector = new HookSelectorComponent(
			"Choose",
			Array.from({ length: 20 }, (_, index) => `Option ${index}`),
			value => picks.push(value),
			() => {
				cancelled++;
			},
			{ maxVisible: 4 },
		);
		expect(prop(picker(selector), "query")).toBeNull();
		selector.handleInput("/");
		for (const character of "hjklggG / ") selector.handleInput(character);
		expect(prop(picker(selector), "query")).toBe("hjklggG / ");
		expect(picks).toEqual([]);
		expect(cancelled).toBe(0);
		expect(closeLabel(selector)).toBe("Back to list");
		selector.handleInput("\x1b[H");
		selector.handleInput("x");
		expect(prop(picker(selector), "cursor")).toBe(1);
		close(selector);
		expect(cancelled).toBe(0);
		expect(prop(picker(selector), "query")).toBeNull();
		expect(closeLabel(selector)).toBe("Close");
		close(selector);
		expect(cancelled).toBe(1);
	});

	it("never approves with Space and only aliases existing marked checkbox toggles", () => {
		const picks: string[] = [];
		const approval = new HookSelectorComponent(
			"Approve?",
			["Approve", "Reject"],
			value => picks.push(value),
			() => {},
		);
		approval.handleInput(" ");
		expect(picks).toEqual([]);
		const multi = new HookSelectorComponent(
			"Choose",
			["Option", "Done", "Other"],
			value => picks.push(value),
			() => {},
			{ selectionMarker: "checkbox", markableCount: 1 },
		);
		multi.handleInput(" ");
		expect(picks).toEqual(["Option"]);
		multi.handleInput("j");
		multi.handleInput(" ");
		multi.handleInput("j");
		multi.handleInput(" ");
		expect(picks).toEqual(["Option"]);
		multi.handleInput("\r");
		expect(picks).toEqual(["Option", "Other"]);
	});

	it("uses h/l and context aliases for the existing slider, never for selection", () => {
		const changed: number[] = [];
		const selector = new HookSelectorComponent(
			"Choose",
			["One", "Two"],
			() => {},
			() => {},
			{
				slider: {
					segments: [{ label: "A" }, { label: "B" }, { label: "C" }],
					index: 1,
					onChange: index => changed.push(index),
				},
			},
		);
		for (const key of ["h", "l", "\t", "\x1b[Z", "\x0e", "\x10"]) selector.handleInput(key);
		expect(changed).toEqual([0, 1, 2, 1, 2, 1]);
	});

	it("keeps fallback native list scrolling independent of selection", () => {
		const selector = new HookSelectorComponent(
			"Choose",
			Array.from({ length: 20 }, (_, index) => `Item ${index}`),
			() => {},
			() => {},
		);
		const cx = { ...CX, supports: (capability: string) => capability !== "picker" };
		selector.describe(cx);
		selector.handleInput("\x05");
		const list = nodes(selector.describe(cx)).find(node => node.k === "list");
		expect(prop(list, "selected")).toBe("0");
		expect(list?.scroll?.by).toBe("line-down");
	});
});
