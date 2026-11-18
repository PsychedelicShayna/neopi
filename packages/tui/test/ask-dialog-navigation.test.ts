import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { AskDialogComponent, type ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const CX: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}
function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).filter(isNode).flatMap(nodes)];
}
function prop(node: NativeNode | undefined, key: string): unknown {
	return node?.p && typeof node.p === "object" ? Reflect.get(node.p, key) : undefined;
}
function byRole(dialog: AskDialogComponent, role: string): NativeNode | undefined {
	return nodes(dialog.describe(CX)).find(node => prop(node, "role") === role);
}
function selected(dialog: AskDialogComponent): unknown {
	return prop(byRole(dialog, "omp.ask.options"), "selected");
}
function activeTab(dialog: AskDialogComponent): unknown {
	return prop(byRole(dialog, "omp.ask.questions"), "active");
}
function plain(dialog: AskDialogComponent): string {
	return Bun.stripANSI(dialog.render(CX.cols).join("\n"));
}
function numberedQuestion(count = 30): ExtensionAskDialogQuestion {
	return {
		id: "choices",
		question: "Choose an answer?",
		options: Array.from({ length: count }, (_, index) => {
			const id = String(index).padStart(2, "0");
			return { label: `Choice ${id}`, description: `Description ${id}` };
		}),
	};
}
function visibleChoices(dialog: AskDialogComponent): number {
	return new Set([...plain(dialog).matchAll(/(?:Choice|Description) (\d\d)/g)].map(match => match[1])).size;
}

let originalRows: PropertyDescriptor | undefined;
beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("dark theme unavailable");
	setThemeInstance(dark);
});
beforeEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
});
afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

describe("ask callback prompt navigation", () => {
	it("moves by visible answers for half/page keys and clamps normal bounds", () => {
		const dialog = new AskDialogComponent([numberedQuestion()], {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		const half = Math.max(1, Math.floor(visibleChoices(dialog) / 2));
		dialog.handleInput("\x04");
		expect(selected(dialog)).toBe(`option:${half}`);
		dialog.handleInput("\x15");
		expect(selected(dialog)).toBe("option:0");
		const page = visibleChoices(dialog);
		dialog.handleInput("\x1b[6~");
		expect(selected(dialog)).toBe(`option:${page}`);
		dialog.handleInput("G");
		expect(selected(dialog)).toBe("other");
		dialog.handleInput("j");
		expect(selected(dialog)).toBe("other");
		dialog.handleInput("k");
		expect(selected(dialog)).toBe("option:29");
		dialog.handleInput("\x1b[A");
		expect(selected(dialog)).toBe("option:28");
		dialog.handleInput("\x1b[B");
		expect(selected(dialog)).toBe("option:29");
		dialog.handleInput("g");
		dialog.handleInput("g");
		expect(selected(dialog)).toBe("option:0");
		dialog.handleInput("\x1b[F");
		expect(selected(dialog)).toBe("other");
		dialog.handleInput("\x1b[H");
		expect(selected(dialog)).toBe("option:0");
		dialog.handleInput("/");
		expect(selected(dialog)).toBe("option:0");
		expect("navigationSnapshot" in dialog).toBe(false);
		expect("restoreNavigation" in dialog).toBe(false);
	});

	it("scrolls physical lines without moving the answer, including offscreen selection", () => {
		const onSubmit = vi.fn();
		const dialog = new AskDialogComponent([numberedQuestion()], {
			onSubmit,
			onCancel: vi.fn(),
			onPrompt: vi.fn(),
		});
		expect(plain(dialog)).toContain("Choice 00");
		dialog.handleInput("\x05");
		expect(plain(dialog)).not.toContain("Choice 00");
		expect(plain(dialog)).toContain("Description 00");
		expect(selected(dialog)).toBe("option:0");
		expect(byRole(dialog, "omp.ask.options")?.scroll?.by).toBe("line-down");
		dialog.handleInput("\x05");
		expect(plain(dialog)).not.toContain("Description 00");
		expect(selected(dialog)).toBe("option:0");
		dialog.handleInput("\x19");
		dialog.handleInput("\x19");
		expect(plain(dialog)).toContain("Choice 00");
		dialog.handleInput("\x05");
		dialog.handleInput("\r");
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Choice 00"]);
	});

	it("keeps page-reading a tall preview while half-page keys can leave it", () => {
		const preview = `\`\`\`\n${Array.from({ length: 80 }, (_, index) => `preview-${index}`).join("\n")}\n\`\`\``;
		const dialog = new AskDialogComponent(
			[
				{
					id: "preview",
					question: "Inspect?",
					options: [{ label: "Plain" }, { label: "Preview", preview }, { label: "After" }],
				},
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		plain(dialog);
		dialog.handleInput("j");
		dialog.handleInput("\x1b[6~");
		expect(selected(dialog)).toBe("option:1");
		expect(byRole(dialog, "omp.ask.preview")?.scroll?.by).toBe("page-down");
		expect(byRole(dialog, "omp.ask.options")?.scroll).toBeUndefined();
		for (let index = 0; index < 100; index++) dialog.handleInput("\x05");
		expect(plain(dialog)).toContain("After");
		expect(selected(dialog)).toBe("option:1");
		dialog.handleInput("\x04");
		expect(selected(dialog)).not.toBe("option:1");
	});

	it("switches question/review contexts with h/l, arrows, Tab and Ctrl-N/P", () => {
		const dialog = new AskDialogComponent(
			[
				{ ...numberedQuestion(), id: "first" },
				{ ...numberedQuestion(), id: "second" },
			],
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		dialog.handleInput("j");
		for (const [key, tab] of [
			["l", "1"],
			["\x1b[C", "submit"],
			["\t", "0"],
			["\x0e", "1"],
			["h", "0"],
			["\x1b[D", "submit"],
			["\x1b[Z", "1"],
			["\x10", "0"],
		]) {
			dialog.handleInput(key);
			expect(activeTab(dialog)).toBe(tab);
		}
		expect(selected(dialog)).toBe("option:1");
	});

	it("uses the shared review viewer motions and retains its viewport across context switches", () => {
		const onSubmit = vi.fn();
		const dialog = new AskDialogComponent(
			Array.from({ length: 40 }, (_, index) => ({
				id: `q${index}`,
				header: `Question ${index}`,
				question: "Choose?",
				options: [{ label: "Answer" }],
			})),
			{ onSubmit, onCancel: vi.fn(), onPrompt: vi.fn() },
		);
		dialog.handleInput("h");
		expect(plain(dialog)).toContain("40 unanswered");
		dialog.handleInput("\x05");
		expect(plain(dialog)).not.toContain("40 unanswered");
		expect(byRole(dialog, "omp.ask.answers")?.scroll?.by).toBe("line-down");
		dialog.handleInput("\x19");
		expect(plain(dialog)).toContain("40 unanswered");
		dialog.handleInput("\x04");
		expect(plain(dialog)).not.toContain("40 unanswered");
		dialog.handleInput("\x15");
		expect(plain(dialog)).toContain("40 unanswered");
		dialog.handleInput("\x1b[6~");
		expect(plain(dialog)).not.toContain("40 unanswered");
		dialog.handleInput("\x1b[5~");
		expect(plain(dialog)).toContain("40 unanswered");
		dialog.handleInput("G");
		const end = plain(dialog);
		expect(end).not.toContain("40 unanswered");
		dialog.handleInput("l");
		dialog.handleInput("h");
		expect(plain(dialog)).toBe(end);
		dialog.handleInput("g");
		dialog.handleInput("g");
		expect(plain(dialog)).toContain("40 unanswered");
		dialog.handleInput(" ");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("limits Space to existing option checkboxes, never Other or Review", async () => {
		const onSubmit = vi.fn();
		const pending = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn(() => pending.promise);
		const dialog = new AskDialogComponent(
			[
				{
					id: "multi",
					question: "Choose?",
					multi: true,
					options: [{ label: "Option" }],
				},
			],
			{ onSubmit, onCancel: vi.fn(), onPrompt },
		);
		dialog.handleInput(" ");
		expect(nodes(dialog.describe(CX)).some(node => node.key === "option:0" && prop(node, "tone") === "accent")).toBe(
			true,
		);
		dialog.handleInput("G");
		dialog.handleInput(" ");
		expect(onPrompt).not.toHaveBeenCalled();
		dialog.handleInput("\t");
		dialog.handleInput(" ");
		expect(onSubmit).not.toHaveBeenCalled();
		dialog.handleInput("\x1b[Z");
		dialog.handleInput("\r");
		expect(onPrompt).toHaveBeenCalledTimes(1);
		dialog.handleInput("\x0f");
		expect(onSubmit).not.toHaveBeenCalled();
		pending.resolve(undefined);
		await pending.promise;
	});

	it("routes draft-owned printable bindings before cancel, hide, expand and passthrough", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": ["escape", "j"],
				"app.tools.expand": ["alt+e", "h"],
				"app.ask.hide": "l",
			}),
		);
		const routed: string[] = [];
		const passthrough: string[] = [];
		const onCancel = vi.fn();
		const dialog = new AskDialogComponent(
			[numberedQuestion()],
			{
				onSubmit: vi.fn(),
				onCancel,
				onPrompt: vi.fn(),
			},
			{
				inputGuard: { isBlocked: () => true, handleInput: data => routed.push(data), hint: "Draft owns input" },
				passthrough: data => {
					passthrough.push(data);
					return false;
				},
			},
		);
		for (const character of "hjklggG / ") dialog.handleInput(character);
		expect(routed.join("")).toBe("hjklggG / ");
		expect(passthrough).toEqual([]);
		expect(onCancel).not.toHaveBeenCalled();
		dialog.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
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
