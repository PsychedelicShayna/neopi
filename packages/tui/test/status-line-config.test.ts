import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { KeybindingsManager } from "../src/app-keybindings";
import {
	parseStatusLineEditorDraft,
	StatusLineConfigOverlayComponent,
	type StatusLineConfigCallbacks,
	type StatusLineEditorDraft,
	type StatusLineLayout,
} from "../src/overlays/status-line-config";
import { initTheme } from "../src/theme";
import { getComposerStyle, getKeybindings, setKeybindings, visibleWidth } from "../src/index";
import { getComposerShapeOptions, installExtensionComposerShape } from "../src/overlays/composer-shape-registry";
import { theme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const ESC = "\x1b";
const CTRL_E = "\x05";
const CTRL_Y = "\x19";
const CTRL_D = "\x04";
const CTRL_U = "\x15";
const BACKSPACE = "\x7f";

const ACTIVE: StatusLineLayout = {
	composerShape: "band",
	leftSegments: ["model", "context_bar"],
	rightSegments: ["time"],
	usageTemplates: {},
};

/** Thirty extra quota windows so the list is taller than the default viewport. */
const MANY_WINDOWS: UsageReport[] = [
	{
		provider: "acme",
		fetchedAt: 1,
		limits: Array.from({ length: 30 }, (_, index) => ({
			id: `acme:w${index}`,
			label: `W${index}`,
			scope: { provider: "acme", windowId: `w${index}` },
			amount: { unit: "percent" as const, usedFraction: 0.1 },
		})),
	},
];

function setup(overrides: Partial<StatusLineConfigCallbacks> = {}, active: StatusLineLayout = ACTIVE) {
	const applied: StatusLineLayout[] = [];
	const drafts: StatusLineEditorDraft[] = [];
	const previews: (StatusLineLayout | undefined)[] = [];
	const notices: string[] = [];
	let closed = false;
	const overlay = new StatusLineConfigOverlayComponent({
		active: () => structuredClone(active),
		saveDraft: async draft => {
			drafts.push(structuredClone(draft));
		},
		apply: async layout => {
			applied.push(structuredClone(layout));
		},
		preview: layout => {
			previews.push(layout && structuredClone(layout));
		},
		close: () => {
			closed = true;
		},
		requestRender: () => {},
		notify: message => notices.push(message),
		...overrides,
	});
	// Size the viewport the way a frame would before keys arrive.
	overlay.render(160);
	return {
		overlay,
		applied,
		drafts,
		previews,
		notices,
		closed: () => closed,
		press: (...keys: string[]) => {
			for (const key of keys) overlay.handleInput(key);
		},
		/** The latest autosaved draft, after pending writes settle. */
		draft: async () => {
			await Bun.sleep(0);
			await Bun.sleep(0);
			return drafts.at(-1)!;
		},
		title: () => Bun.stripANSI(overlay.render(160)[0] ?? ""),
		text: () => Bun.stripANSI(overlay.render(160).join("\n")),
	};
}

it("status widget catalog marks fork segments without changing their identifiers", () => {
	const { text } = setup();
	expect(text()).toContain(`Context bar ${theme.symbol("provenance.fork")}`);
});

describe("status-line editor list", () => {
	it("toggles widgets in place: the row and the selection stay put", async () => {
		const h = setup();
		h.press("j", " ");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar"]);
		let draft = await h.draft();
		expect(draft.selected).toBe("model");
		expect(draft.left.map(row => row.id)).toEqual(["model", "context_bar"]);
		expect(draft.left[0]).toEqual({ id: "model", enabled: false });
		// The next row is still the neighbor it was before the toggle.
		h.press("j");
		draft = await h.draft();
		expect(draft.selected).toBe("context_bar");
		h.press("k", " ");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["model", "context_bar"]);
	});

	it("moves widgets with h/l along the status line and across the side boundary", () => {
		const h = setup();
		h.press("j", "l");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar", "model"]);
		h.press("l");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar"]);
		expect(h.previews.at(-1)?.rightSegments).toEqual(["model", "time"]);
		h.press("h");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar", "model"]);
		expect(h.previews.at(-1)?.rightSegments).toEqual(["time"]);
	});

	it("scrolls the view with Ctrl-e/Ctrl-y without moving the selection, and motion reveals it again", async () => {
		const h = setup({ usageReports: MANY_WINDOWS });
		h.press(CTRL_E, CTRL_E, CTRL_E);
		let draft = await h.draft();
		expect(draft.top).toBe(3);
		expect(draft.selected).toBe("composer");
		h.press(CTRL_Y);
		draft = await h.draft();
		expect(draft.top).toBe(2);
		expect(draft.selected).toBe("composer");
		// Model is list line 2 (composer, "Left side", model); motion scrolls back just enough to show it.
		h.press(CTRL_E, CTRL_E, "j");
		draft = await h.draft();
		expect(draft.selected).toBe("model");
		expect(draft.top).toBe(2);
	});

	it("jumps with gg/G and pages by half a view with Ctrl-d/Ctrl-u", async () => {
		const h = setup({ usageReports: MANY_WINDOWS });
		h.press("G");
		expect((await h.draft()).selected).toBe("reset");
		h.press("g", "g");
		expect((await h.draft()).selected).toBe("composer");
		h.press(CTRL_D);
		const down = await h.draft();
		expect(down.selected).not.toBe("composer");
		h.press(CTRL_U);
		expect((await h.draft()).selected).toBe("composer");
	});

	it("cycles the composer with < and > while the selection and viewport stay put", async () => {
		const h = setup({ usageReports: MANY_WINDOWS });
		h.press("j", "j", "j", CTRL_E);
		const before = await h.draft();
		h.press(">");
		const after = await h.draft();
		expect(h.previews.at(-1)?.composerShape).not.toBe("band");
		expect(after.selected).toBe(before.selected);
		expect(after.top).toBe(before.top);
		h.press("<");
		expect(h.previews.at(-1)?.composerShape).toBe("band");
		expect((await h.draft()).selected).toBe(before.selected);
	});

	it("filters with / using literal text; Enter returns to the list keeping the filter visible", async () => {
		const h = setup();
		h.press("/", "t", "i", "m", "e");
		let draft = await h.draft();
		expect(draft.focus).toBe("search");
		expect(draft.query).toBe("");
		expect(h.text()).toContain("Context bar");
		h.press("\r");
		draft = await h.draft();
		expect(draft.focus).toBe("list");
		expect(draft.query).toBe("time");
		expect(draft.selected).toBe("time");
		expect(h.text()).not.toContain("Context bar");
		expect(h.text()).toContain("time");
		expect(h.closed()).toBe(false);
		// First Esc clears the retained filter; the next closes the menu.
		h.press(ESC);
		expect(h.closed()).toBe(false);
		expect((await h.draft()).query).toBe("");
		h.press(ESC);
		expect(h.closed()).toBe(true);
	});

	it("lists discovered quota windows and configured ids, enabling them as ordinary widgets", () => {
		const h = setup(
			{
				usageReports: [
					{
						provider: "anthropic",
						fetchedAt: 1,
						limits: [
							{
								id: "short",
								label: "Short",
								scope: { provider: "anthropic", windowId: "5h" },
								amount: { unit: "percent", usedFraction: 0.1 },
							},
							{
								id: "tier",
								label: "Tier",
								scope: { provider: "anthropic", windowId: "7d", tier: " FABLE " },
								amount: { unit: "percent", usedFraction: 0.2 },
							},
						],
					},
				],
			},
			{ ...ACTIVE, leftSegments: ["usage:custom:month"], rightSegments: [] },
		);
		const rows = h.overlay.render(200);
		expect(rows.every(row => visibleWidth(row) <= 200)).toBe(true);
		expect(h.text()).toContain("AN 5h");
		expect(h.text()).toContain("Fable");
		// The last widget row is the newest discovered window; the Reset row sits below it.
		h.press("G", "k", " ");
		expect(h.previews.at(-1)?.rightSegments).toEqual(["usage:anthropic:7d:fable"]);
	});

	it("cycles through registered extension shapes as well as builtins", () => {
		const unregister = installExtensionComposerShape({
			label: "Extension Preview",
			description: "Registered shape",
			style: { ...getComposerStyle("rail"), id: "configuration-test-shape" },
		});
		try {
			const h = setup({}, { ...ACTIVE, composerShape: "rail" });
			h.press(" ");
			expect(h.previews.at(-1)?.composerShape).toBe("configuration-test-shape");
			expect(h.text()).toContain("Extension Preview");
		} finally {
			unregister();
		}
	});

	it("selects the first widget for each confirmed query, including Composer and Reset origins", () => {
		for (const origin of ["composer", "reset"]) {
			const h = setup();
			if (origin === "reset") h.press("G");
			h.press("/", "t", "i", "\r");
			expect(h.drafts.at(-1)?.selected).toBe("time");
			h.press("/", BACKSPACE, "\r"); // Context bar is the first match for t.
			expect(h.drafts.at(-1)?.query).toBe("t");
			expect(h.drafts.at(-1)?.selected).toBe("context_bar");
			h.press("/", BACKSPACE, "\r");
			expect(h.drafts.at(-1)?.selected).toBe("model");
		}
	});

	it("honors configured reader intents and captures navigation drafts synchronously", () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.down": "alt+n",
				"tui.select.halfPageDown": "alt+d",
				"tui.select.halfPageUp": "alt+u",
				"tui.select.scrollDown": "alt+e",
				"tui.select.scrollUp": "alt+y",
				"tui.select.first": "alt+g",
				"tui.select.last": "alt+b",
				"tui.select.search": "ctrl+f",
			}),
		);
		try {
			const h = setup({ usageReports: MANY_WINDOWS });
			h.press("\x1bn");
			expect(h.drafts.at(-1)?.selected).toBe("model");
			h.press("\x1be");
			expect(h.drafts.at(-1)).toMatchObject({ selected: "model", top: 1 });
			h.press("\x1by");
			expect(h.drafts.at(-1)?.top).toBe(0);
			h.press("\x1bd");
			expect(h.drafts.at(-1)?.selected).not.toBe("model");
			h.press("\x1bu");
			expect(h.drafts.at(-1)?.selected).toBe("model");
			h.press("\x1bb");
			expect(h.drafts.at(-1)?.selected).toBe("reset");
			h.press("\x1bg");
			expect(h.drafts.at(-1)?.selected).toBe("composer");
			h.press("\x06");
			expect(h.drafts.at(-1)?.focus).toBe("search");
		} finally {
			setKeybindings(previous);
		}
	});

	it("keeps physical-row mouse hits and wheel-only scrolling through viewport migration", () => {
		const h = setup({ usageReports: MANY_WINDOWS });
		h.press("\x1b[<65;5;3M");
		expect(h.drafts.at(-1)).toMatchObject({ top: 1, selected: "composer" });
		const beforeHeader = h.drafts.length;
		h.press("\x1b[<0;5;2M"); // visible Left side header is not selectable
		expect(h.drafts).toHaveLength(beforeHeader);
		h.press("\x1b[<0;5;3M"); // top 1 + pane line 1 = Model
		expect(h.drafts.at(-1)?.selected).toBe("model");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["model", "context_bar"]);
		h.press("\x1b[<0;5;3M");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar"]);
		h.press("g", "\x1b[<35;5;3M", "g", "j");
		expect(h.drafts.at(-1)?.selected).toBe("context_bar");
		h.press(ESC);
		const previews = h.previews.length;
		h.press("\x1b[<0;5;3M");
		expect(h.previews).toHaveLength(previews);
		expect(h.text()).toContain("Apply pending changes?");
	});

	it("pages before the first render using terminal-derived selectable-row counts", () => {
		const drafts: StatusLineEditorDraft[] = [];
		const overlay = new StatusLineConfigOverlayComponent({
			active: () => structuredClone(ACTIVE),
			usageReports: MANY_WINDOWS,
			saveDraft: async draft => {
				drafts.push(structuredClone(draft));
			},
			apply: async () => {},
			preview: () => {},
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		});
		overlay.handleInput(CTRL_D);
		const draft = drafts.at(-1)!;
		const keys = ["composer", ...draft.left.map(row => row.id), ...draft.right.map(row => row.id), "reset"];
		const step = Math.max(1, Math.floor(Math.max(3, (process.stdout.rows || 40) - 4) / 2));
		expect(draft.selected).toBe(keys[Math.min(keys.length - 1, step)]);
	});

	it("cycles an unknown composer to the first or last registered shape without moving", () => {
		const shapes = getComposerShapeOptions();
		for (const [key, expected] of [
			[">", shapes[0]!.value],
			["<", shapes.at(-1)!.value],
		] as const) {
			const h = setup({}, { ...ACTIVE, composerShape: "unknown-shape" });
			h.press(key);
			expect(h.previews.at(-1)?.composerShape).toBe(expected);
			expect(h.drafts.at(-1)?.selected).toBe("composer");
			expect(h.drafts.at(-1)?.top).toBe(0);
		}
	});

	it("leaves composer and reset rows inert for every widget-reorder alias", () => {
		const h = setup();
		h.press("\x1b[H"); // establish the initial navigation draft without an edit
		const aliases = ["h", "l", "[", "]", "\x1b[1;3A", "\x1b[1;3B"];
		const previews = h.previews.length;
		h.press(...aliases);
		expect(h.previews).toHaveLength(previews);
		expect(h.drafts.at(-1)?.selected).toBe("composer");
		h.press("G", ...aliases);
		expect(h.previews).toHaveLength(previews);
		expect(h.drafts.at(-1)?.selected).toBe("reset");
	});
});

describe("status-line editor templates", () => {
	it("edits the text around one usage widget's percentage without touching its siblings", async () => {
		const h = setup({}, { ...ACTIVE, rightSegments: ["usage:anthropic:5h", "usage:anthropic:7d"] });
		h.press("j", "j", "j", "\t");
		expect((await h.draft()).focus).toBe("template");
		h.press(...Array.from({ length: 30 }, () => BACKSPACE), ..."{percent} used".split(""), "\r");
		const draft = await h.draft();
		expect(draft.focus).toBe("list");
		expect(h.previews.at(-1)?.usageTemplates).toEqual({ "usage:anthropic:5h": "{percent} used" });
		// Restoring the default text removes the override rather than storing a copy.
		h.press("\t", ...Array.from({ length: 30 }, () => BACKSPACE), "\r");
		expect(h.previews.at(-1)?.usageTemplates).toEqual({});
	});

	it("explains instead of opening a template for widgets that have none", () => {
		const h = setup();
		h.press("j", "\t");
		expect(h.notices.at(-1)).toContain("usage widget");
	});

	it("keeps printable bindings literal in search and template fields without applying", () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "j",
				"tui.input.submit": "s",
				"tui.select.nextContext": "alt+t",
			}),
		);
		try {
			const literal = "js h/l gg G";
			const search = setup();
			search.press("/", ...literal);
			expect(search.drafts.at(-1)?.query).toBe("");
			expect(search.drafts.at(-1)?.focus).toBe("search");
			expect(search.previews).toHaveLength(1);
			expect(search.applied).toEqual([]);
			search.press(ESC);
			expect(search.drafts.at(-1)?.focus).toBe("list");
			const template = setup({}, { ...ACTIVE, rightSegments: ["usage:acme:5h"] });
			template.press("\x1b[B", "\x1b[B", "\x1b[B", "\x1bt");
			expect(template.drafts.at(-1)?.focus).toBe("template");
			template.press(...Array.from({ length: 30 }, () => BACKSPACE), ...literal);
			expect(template.previews.at(-1)?.usageTemplates).toEqual({ "usage:acme:5h": literal });
			expect(template.previews.at(-1)?.leftSegments).toEqual(ACTIVE.leftSegments);
			expect(template.applied).toEqual([]);
			template.press("\r");
			expect(template.drafts.at(-1)?.focus).toBe("list");
		} finally {
			setKeybindings(previous);
		}
	});

	it("keeps caret-only template keys out of preview and draft edits and still limits text", () => {
		const h = setup({}, { ...ACTIVE, rightSegments: ["usage:acme:5h"] });
		h.press("j", "j", "j", "\t");
		const previews = h.previews.length;
		const drafts = h.drafts.length;
		h.press("\x01", "\x1b[C", CTRL_E, "\x1b[D");
		expect(h.previews).toHaveLength(previews);
		expect(h.drafts).toHaveLength(drafts);
		h.press(...Array.from({ length: 100 }, () => "A"));
		const value = h.drafts.at(-1)?.usageTemplates["usage:acme:5h"] ?? "";
		expect(visibleWidth(value)).toBeLessThanOrEqual(80);
		expect(h.applied).toEqual([]);
	});
});

describe("status-line editor draft", () => {
	it("applies with s and stays open", async () => {
		const h = setup();
		h.press("j", " ");
		expect(h.title()).toContain("unapplied draft");
		h.press("s");
		await Bun.sleep(0);
		expect(h.applied).toEqual([{ ...ACTIVE, leftSegments: ["context_bar"] }]);
		expect(h.closed()).toBe(false);
		expect(h.title()).not.toContain("unapplied draft");
		// Esc after applying closes without a prompt.
		h.press(ESC);
		expect(h.closed()).toBe(true);
	});

	it("asks on Esc: Esc/c stays, n keeps the draft and leaves the active layout, y applies", async () => {
		const declined = setup();
		declined.press("j", " ", ESC);
		expect(declined.closed()).toBe(false);
		declined.press("c");
		expect(declined.closed()).toBe(false);
		declined.press(ESC, ESC);
		expect(declined.closed()).toBe(false);
		declined.press(ESC, "n");
		expect(declined.closed()).toBe(true);
		expect(declined.applied).toEqual([]);
		expect(declined.previews.at(-1)).toBeUndefined();
		const kept = await declined.draft();
		expect(kept.left.find(row => row.id === "model")?.enabled).toBe(false);
		expect(declined.notices.at(-1)).toContain("Kept the unapplied");

		const accepted = setup();
		accepted.press("j", " ", ESC, "y");
		await Bun.sleep(0);
		expect(accepted.applied).toEqual([{ ...ACTIVE, leftSegments: ["context_bar"] }]);
		expect(accepted.closed()).toBe(true);
	});

	it("restores every edit and the editor state when reopened from the saved draft", async () => {
		const first = setup({ usageReports: MANY_WINDOWS });
		first.press("j", " ", "j", "l", ">", CTRL_E, CTRL_E);
		const saved = await first.draft();
		expect(saved.top).toBe(2);
		first.press(ESC, "n");
		expect(first.closed()).toBe(true);
		const restoredDraft = parseStatusLineEditorDraft(JSON.parse(JSON.stringify(saved)));
		expect(restoredDraft).toEqual(saved);

		const second = setup({ draft: restoredDraft, usageReports: MANY_WINDOWS });
		expect(second.previews[0]).toEqual(first.previews.findLast(layout => layout !== undefined));
		expect(second.notices[0]).toContain("Restored the unapplied status-line draft");
		second.press(CTRL_Y);
		const reopened = await second.draft();
		expect(reopened.selected).toBe(saved.selected);
		expect(reopened.left).toEqual(saved.left);
		expect(reopened.right).toEqual(saved.right);
		expect(reopened.composerShape).toBe(saved.composerShape);
		expect(reopened.top).toBe(saved.top - 1);
	});

	it("lets a draft without edits follow a newer active layout, keeping widget positions", () => {
		const base: StatusLineLayout = { ...ACTIVE };
		const draft: StatusLineEditorDraft = {
			version: 1,
			base,
			composerShape: "band",
			left: [
				{ id: "pi", enabled: false },
				{ id: "model", enabled: true },
				{ id: "context_bar", enabled: true },
			],
			right: [{ id: "time", enabled: true }],
			usageTemplates: {},
			selected: "pi",
			top: 0,
			focus: "list",
			query: "",
		};
		const changed: StatusLineLayout = { ...ACTIVE, leftSegments: ["context_bar", "model"], composerShape: "box" };
		const h = setup({ draft }, changed);
		expect(h.previews[0]).toEqual(changed);
		expect(h.notices).toEqual([]);
		expect(h.title()).not.toContain("unapplied draft");
	});

	it("resets to the active layout only after an explicit confirmation", async () => {
		const h = setup();
		h.press("j", " ", ">", "R", "n");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar"]);
		h.press("R", "y");
		expect(h.previews.at(-1)).toEqual(ACTIVE);
		expect(h.title()).not.toContain("unapplied draft");
		// The Reset row at the bottom is the same path.
		h.press(" ", "G", " ", "y");
		expect(h.previews.at(-1)).toEqual(ACTIVE);
		const draft = await h.draft();
		expect(draft.base).toEqual(ACTIVE);
	});

	it("keeps the draft when applying fails", async () => {
		const failure = Promise.withResolvers<void>();
		const h = setup({
			apply: async () => {
				failure.resolve();
				throw new Error("disk full");
			},
		});
		h.press("j", " ", "s");
		await failure.promise;
		await Bun.sleep(0);
		expect(h.notices.at(-1)).toContain("Could not apply");
		expect(h.notices.at(-1)).toContain("disk full");
		// Host statuses sit behind the fullscreen editor; its own footer repeats the failure.
		expect(h.text()).toContain("Could not apply the status-line layout");
		expect(h.closed()).toBe(false);
		expect(h.title()).toContain("unapplied draft");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar"]);
	});

	it("reports a failing draft write once and never applies on its behalf", async () => {
		let attempts = 0;
		const h = setup({
			saveDraft: async () => {
				attempts++;
				throw new Error("read-only");
			},
		});
		h.press("j", " ");
		await Bun.sleep(0);
		h.press(" ", " ");
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(attempts).toBeGreaterThan(1);
		expect(h.notices.filter(notice => notice.includes("Could not save the status-line draft"))).toHaveLength(1);
		expect(h.applied).toEqual([]);
		expect(h.title()).toContain("draft not saved");
	});

	it("leaves for menu history without a prompt, saving the draft and restoring the live view", async () => {
		const h = setup();
		h.press("j", " ");
		h.overlay.leaveMenu();
		expect(h.previews.at(-1)).toBeUndefined();
		expect(h.closed()).toBe(false);
		const draft = await h.draft();
		expect(draft.left.find(row => row.id === "model")?.enabled).toBe(false);
		h.press(" ");
		expect(h.previews.at(-1)).toBeUndefined();
	});

	it("rejects malformed drafts and drops unknown widgets from usable ones", () => {
		expect(parseStatusLineEditorDraft({ version: 2 })).toBeUndefined();
		expect(parseStatusLineEditorDraft(null)).toBeUndefined();
		const parsed = parseStatusLineEditorDraft({
			version: 1,
			base: ACTIVE,
			composerShape: "band",
			left: [
				{ id: "model", enabled: true },
				{ id: "not-a-widget", enabled: true },
				{ id: "model", enabled: false },
			],
			right: [],
			usageTemplates: { "usage:anthropic:5h": "{percent}", model: "x" },
			selected: "model",
			top: -4,
			focus: "elsewhere",
			query: "a\nb",
		});
		expect(parsed?.left).toEqual([{ id: "model", enabled: true }]);
		expect(parsed?.usageTemplates).toEqual({ "usage:anthropic:5h": "{percent}" });
		expect(parsed?.top).toBe(0);
		expect(parsed?.focus).toBe("list");
		expect(parsed?.query).not.toContain("\n");
	});

	it("keeps no-op apply/reset notices and requires y rather than Enter for reset", () => {
		const h = setup();
		h.press("s");
		expect(h.notices.at(-1)).toContain("No status-line changes to apply");
		h.press("R");
		expect(h.notices.at(-1)).toContain("already matches");
		expect(h.applied).toEqual([]);
		h.press("j", " ", "R", "\r");
		expect(h.text()).toContain("Reset the draft to the active layout?");
		expect(h.previews.at(-1)?.leftSegments).toEqual(["context_bar"]);
		h.press("n", "R", "Y");
		expect(h.previews.at(-1)).toEqual(ACTIVE);
		expect(h.applied).toEqual([]);
	});

	it("ignores input during apply and never overwrites a newer draft after leaving", async () => {
		const completion = Promise.withResolvers<void>();
		const writes: StatusLineEditorDraft[] = [];
		const saveDraft = async (draft: StatusLineEditorDraft): Promise<void> => {
			writes.push(structuredClone(draft));
		};
		let applies = 0;
		const first = setup({
			saveDraft,
			apply: () => {
				applies++;
				return completion.promise;
			},
		});
		first.press("j", " ", "s");
		const duringApply = writes.length;
		first.press("G", "/", "l", ESC, "y");
		expect(writes).toHaveLength(duringApply);
		expect(applies).toBe(1);
		first.overlay.leaveMenu();
		expect(first.previews.at(-1)).toBeDefined();
		const second = setup({ saveDraft, draft: writes.at(-1) });
		second.press("j", ">");
		const newer = structuredClone(writes.at(-1));
		const beforeCompletion = writes.length;
		completion.resolve();
		await Bun.sleep(0);
		expect(writes).toHaveLength(beforeCompletion);
		expect(writes.at(-1)).toEqual(newer);
		expect(first.previews.at(-1)).toBeUndefined();
		expect(second.closed()).toBe(false);
	});

	it("clears a draft-write failure only when the latest revision succeeds", async () => {
		const writes: { resolve: () => void; reject: (error: Error) => void }[] = [];
		const h = setup({
			saveDraft: () => {
				const pending = Promise.withResolvers<void>();
				writes.push({ resolve: () => pending.resolve(), reject: error => pending.reject(error) });
				return pending.promise;
			},
		});
		h.press("j", " ", "j");
		expect(writes).toHaveLength(3);
		writes[0]!.reject(new Error("first write failed"));
		await Bun.sleep(0);
		expect(h.title()).toContain("unapplied draft");
		expect(h.title()).toContain("draft not saved");
		writes[1]!.resolve();
		await Bun.sleep(0);
		expect(h.title()).toContain("draft not saved");
		writes[2]!.resolve();
		await Bun.sleep(0);
		expect(h.title()).not.toContain("draft not saved");
	});
});
