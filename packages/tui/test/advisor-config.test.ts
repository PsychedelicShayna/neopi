import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "../src/index";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../src/native/node";
import type { TspPickerProps, TspPrefsProps } from "@oh-my-pi/pi-wire";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigDeps,
	type AdvisorConfigCallbacks,
	type WatchdogConfigDoc,
	type EffectiveAdvisorConfig,
} from "../src/overlays/advisor-config";
import { getThemeByName, setThemeInstance } from "../src/theme";

const deps: AdvisorConfigDeps = {
	getDefaultSystemPrompt: () => "Bundled advisor baseline",
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
	defaultToolNames: new Set(["read", "grep", "glob"]),
	scopedModels: [],
	availableToolNames: [],
};

describe("advisor review mode picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	it("preserves configured mode when accepting current selection and saving", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Reviewer", reviewMode: "agent-end", reviewInterval: 3 }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					saved = structuredClone(doc);
				},
				apply: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Review mode.
		overlay.handleInput("\r"); // Accept current mode without navigating.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", reviewMode: "agent-end", reviewInterval: 3 }]);
	});
});

describe("advisor sync backlog picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const buildOverlay = (doc: WatchdogConfigDoc, onSave: (doc: WatchdogConfigDoc) => void) =>
		new AdvisorConfigOverlayComponent({} as TUI, deps, "project", doc, {
			loadDoc: async () => ({ advisors: [] }),
			save: async (_scope, doc) => onSave(doc),
			apply: async () => {},
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		});

	it("applies an explicit strict override through the picker and saves it", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (inherit selected).
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Pick strict.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", syncBacklog: "strict" }]);
	});

	it("clears an explicit override back to inherit", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer", syncBacklog: "off" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (off selected).
		overlay.handleInput("\x1b[A"); // Up to inherit.
		overlay.handleInput("\r"); // Pick inherit.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer" }]);
	});

	it("keeps a sync backlog edit on the seeded default row instead of discarding the roster", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Seeded "default" advisor detail.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (inherit selected).
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Pick strict.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		// A real edit must survive: the seeded row is no longer synthetic, so the
		// save must not collapse the roster to empty (which would delete the file).
		expect(saved?.advisors).toEqual([{ name: "default", syncBacklog: "strict" }]);
	});

	it("edits cadence from the native prefs page, saving defaults and inherit as omitted fields", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer", syncBacklog: "off" }] }, doc => {
			saved = structuredClone(doc);
		});
		const change = (item: string, value: string | number | null) =>
			overlay.handleNativeEvent({ type: "change", key: "", item, value });

		overlay.handleNativeEvent({ type: "action", key: "", act: "page", value: "advisor:0", mods: [] });
		change("reviewMode", "agent-end");
		change("reviewInterval", 3);
		change("reviewInterval", null); // Reset to the default interval.
		change("syncBacklog", "inherit");
		overlay.handleNativeEvent({ type: "action", key: "", act: "save", mods: [] });
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", reviewMode: "agent-end" }]);
	});

	it("docks as a side sheet like /settings only where the terminal draws prefs with aside", () => {
		const overlay = buildOverlay({ advisors: [] }, () => {});
		const cx: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		expect(overlay.nativeSheet(cx)).toBe(true);
		expect(overlay.nativeSheet({ ...cx, feature: name => name !== "aside" })).toBe(false);
		expect(overlay.nativeSheet({ ...cx, supports: kind => kind !== "prefs" })).toBe(false);
	});

	it("still drops the untouched seeded default row on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the seeded row.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([]);
	});

	it("toggles primary reasoning in detail and saves an override on the implicit default", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Open the seeded default.
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Off.
		overlay.handleInput("\r"); // Back on.
		overlay.handleInput("\r"); // Off again.
		overlay.handleInput("\x1b"); // Roster.
		overlay.handleInput("s");
		await Bun.sleep(0);
		expect(saved?.advisors).toEqual([{ name: "default", includeThinking: false }]);
	});

	it("toggles the highlighted advisor with Space and saves it with s, all from the list", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "alpha" }, { name: "beta" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\x1b[B"); // highlight beta
		overlay.handleInput(" "); // off
		overlay.handleInput(" "); // on again: still on the list, cursor kept on beta
		overlay.handleInput(" "); // off
		overlay.handleInput("s");
		await Promise.resolve();

		expect(saved?.advisors.map(a => [a.name, a.enabled])).toEqual([
			["alpha", undefined],
			["beta", false],
		]);
	});

	it("treats Space as Enter on non-advisor rows", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "alpha" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput(" "); // alpha off
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B"); // → Save & apply
		overlay.handleInput(" ");
		await Promise.resolve();

		expect(saved?.advisors.map(a => [a.name, a.enabled])).toEqual([["alpha", false]]);
	});

	it("saves with s without applying, and applies saved changes once with a", async () => {
		const events: string[] = [];
		const notes: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "alpha" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					events.push(`save:${doc.advisors[0]?.enabled}`);
				},
				apply: async () => {
					events.push("apply");
				},
				close: () => {},
				requestRender: () => {},
				notify: message => notes.push(message),
			},
		);
		const flush = () => Bun.sleep(0);

		overlay.handleInput(" "); // alpha off (unsaved)
		overlay.handleInput("s");
		await flush();
		expect(events).toEqual(["save:false"]);

		overlay.handleInput("a");
		await flush();
		overlay.handleInput("a"); // nothing pending: no second apply
		await flush();
		expect(events).toEqual(["save:false", "apply"]);

		overlay.handleInput(" "); // alpha back on, unsaved: `a` saves first, then applies
		overlay.handleInput("a");
		await flush();
		expect(events).toEqual(["save:false", "apply", "save:undefined", "apply"]);
	});

	it("preserves a real default advisor carrying only maxNotesPerUpdate on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "default", maxNotesPerUpdate: 2 }] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the row.
		await Promise.resolve();

		// The row is a real roster entry (per-advisor budget, not editable in the
		// overlay), not the synthetic seed: save must not collapse the roster to
		// empty, which would silently delete the entry from the file.
		expect(saved?.advisors).toEqual([{ name: "default", maxNotesPerUpdate: 2 }]);
	});
	it("surfaces the newly active file's warnings on scope switch, and only there", async () => {
		const warnings: string[] = [];
		let pendingLoad: Promise<WatchdogConfigDoc> | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: () => {
					pendingLoad = Promise.resolve({
						advisors: [],
						warnings: [
							`${path.join(os.homedir(), ".omp", "WATCHDOG.yml")}: advisor "\x1b[31mBad\tName\x1b[0m" dropped — boom`,
						],
					});
					return pendingLoad;
				},
				save: async () => {},
				apply: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		// Opening the project file shows nothing — the host owns initial warnings.
		expect(warnings).toEqual([]);

		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Switch scope to user.
		// The overlay awaits the same promise; awaiting it here runs after its continuation.
		await pendingLoad;

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('advisor "Bad   Name" dropped');
		expect(warnings[0]).toContain("~/.omp/WATCHDOG.yml");
		expect(warnings[0]).not.toContain(path.join(os.homedir(), ".omp", "WATCHDOG.yml"));
		// The toast is chat-mounted behind the fullscreen overlay, so the warning
		// must also render inside the editor itself.
		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad   Name" dropped');
	});

	it("renders the opening file's warnings inside the overlay without re-notifying", () => {
		const warnings: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Good" }], warnings: ['/repo/WATCHDOG.yml: advisor "Bad" dropped — boom'] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				apply: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad" dropped');
		expect(warnings).toEqual([]);
	});
	it("saves shared-only repairs with the original document identity", async () => {
		const doc: WatchdogConfigDoc = { advisors: [], warnings: ["malformed source"] };
		const metadata = new WeakSet<WatchdogConfigDoc>([doc]);
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent({} as TUI, deps, "project", doc, {
			loadDoc: async () => ({ advisors: [] }),
			save: async (_scope, candidate) => {
				if (!metadata.has(candidate)) throw new Error("lost document metadata");
				saved = structuredClone(candidate);
			},
			apply: async () => {},
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		});

		overlay.handleInput("\x1b[B"); // synthetic advisor → add
		overlay.handleInput("\x1b[B"); // add → shared instructions
		overlay.handleInput("\r");
		overlay.handleInput("Repaired shared instructions");
		overlay.handleInput("\x11"); // Ctrl+Q submits the hook editor.
		overlay.handleInput("s");
		await Bun.sleep(0);

		expect(saved).toEqual({
			advisors: [],
			instructions: "Repaired shared instructions",
			warnings: ["malformed source"],
		});
		expect(doc.advisors).toHaveLength(1); // synthetic UI row is restored after persistence.
	});
});

describe("advisor menu navigation and history", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	function make(doc: WatchdogConfigDoc, callbacks: Partial<AdvisorConfigCallbacks> = {}) {
		const events: string[] = [];
		let closed = 0;
		const overlay = new AdvisorConfigOverlayComponent(
			{ terminal: { rows: 14 } } as unknown as TUI,
			{
				...deps,
				availableToolNames: ["read", "grep", "glob", "write"],
				configFiles: { project: "/workspace/WATCHDOG.yaml", user: "/user/WATCHDOG.yml" },
			},
			"project",
			doc,
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {
					events.push("save");
				},
				apply: async () => {
					events.push("apply");
				},
				close: () => {
					closed++;
				},
				requestRender: () => {},
				notify: () => {},
				...callbacks,
			},
		);
		return { overlay, events, closed: () => closed };
	}

	it("keeps literal filter keys and first Esc in the field, including short lists", () => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }] };
		const h = make(doc);
		try {
			h.overlay.handleInput("i");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ filterFocused: false });
			h.overlay.handleInput("/");
			h.overlay.handleInput("hjkl/ g");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ filter: "hjkl/ g", filterFocused: true });
			expect(doc.advisors[0]?.enabled).toBeUndefined();
			h.overlay.handleInput("\x1b");
			expect(h.closed()).toBe(0);
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ filter: "", filterFocused: false });
			h.overlay.handleInput("\x1b");
			expect(h.closed()).toBe(1);
		} finally {
			h.overlay.dispose();
		}
	});

	it("retains the name field and its parent filter without submitting on restore", () => {
		const h = make({ advisors: [{ name: "Reviewer" }] });
		const restored = make({ advisors: [{ name: "Other" }] });
		const visits: Array<[string, unknown]> = [];
		const restoredVisits: string[] = [];
		h.overlay.onNavigationVisit = (page, previous) => visits.push([page, previous]);
		restored.overlay.onNavigationVisit = page => restoredVisits.push(page);
		try {
			h.overlay.handleInput("\r");
			h.overlay.handleInput("/");
			h.overlay.handleInput("Name");
			h.overlay.handleInput("\r");
			h.overlay.handleInput("l");
			h.overlay.handleInput("hjkl / draft");
			h.overlay.handleInput("\x1b[D");
			const snapshot = h.overlay.navigationSnapshot();
			expect(snapshot.context).toMatchObject({ screen: "name", index: 0 });
			expect(snapshot.content).toMatchObject({ value: "Reviewerhjkl / draft" });
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot().content).toEqual(snapshot.content);
			expect(restoredVisits).toEqual([]);
			restored.overlay.handleInput("\x1b");
			expect(restored.overlay.navigationSnapshot()).toMatchObject({
				context: { screen: "detail" },
				content: { filter: "Name", selectedValue: "name" },
			});
			expect(visits.map(([page]) => page)).toEqual(["detail:0", "name:0"]);
			expect(h.events).toEqual([]);
			expect(restored.events).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});
	it("keeps printable remapped cancel, submit, and edit keys literal in the name field", () => {
		const h = make({ advisors: [{ name: "Reviewer" }] });
		const previous = getKeybindings();
		try {
			h.overlay.handleInput("\r");
			h.overlay.handleInput("l");
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.select.cancel": ["escape", "h"],
					"tui.input.submit": ["enter", "j"],
					"tui.editor.deleteCharBackward": "l",
				}),
			);
			for (const key of ["h", "j", "k", "l", "/", " "]) h.overlay.handleInput(key);
			expect(h.overlay.navigationSnapshot()).toMatchObject({
				context: { screen: "name" },
				content: { value: "Reviewerhjkl/ " },
			});
			expect(h.events).toEqual([]);
			h.overlay.handleInput("\x1b");
			expect(h.overlay.navigationSnapshot().context.screen).toBe("detail");
		} finally {
			setKeybindings(previous);
			h.overlay.dispose();
		}
	});

	it("restores a multiline safe prompt draft without saving or applying it", () => {
		const h = make({ advisors: [{ name: "Reviewer", systemPrompt: "" }] });
		const restored = make({ advisors: [] });
		try {
			h.overlay.handleInput("\r");
			h.overlay.handleInput("/");
			h.overlay.handleInput("System prompt");
			h.overlay.handleInput("\x1b");
			h.overlay.handleInput("l");
			h.overlay.pasteText("hello\nhjkl / world");
			h.overlay.handleInput("\x1b[D");
			const snapshot = h.overlay.navigationSnapshot();
			expect(snapshot.content).toMatchObject({ text: "hello\nhjkl / world" });
			restored.overlay.restoreNavigation(snapshot);
			expect(restored.overlay.navigationSnapshot().content).toEqual(snapshot.content);
			expect(restored.overlay.blocksMenuHistory).toBe(false);
			expect(restored.events).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("restores pending tool checkboxes and keeps their cursor on the next toggle", () => {
		const h = make({ advisors: [{ name: "Reviewer" }] });
		const restored = make({ advisors: [] });
		try {
			h.overlay.handleInput("\r");
			h.overlay.handleInput("/");
			h.overlay.handleInput("Tools");
			h.overlay.handleInput("\x1b");
			h.overlay.handleInput("l");
			h.overlay.handleInput("j");
			h.overlay.handleInput("j");
			h.overlay.handleInput("j");
			h.overlay.handleInput(" ");
			const snapshot = h.overlay.navigationSnapshot();
			expect(snapshot.context.tools).toContain("write");
			restored.overlay.restoreNavigation(snapshot);
			restored.overlay.handleInput(" ");
			expect(restored.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "write" });
			expect(restored.overlay.navigationSnapshot().context.tools).not.toContain("write");
			expect(restored.events).toEqual([]);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("moves the preview independently, preserves root panes as contexts and isolates gg", () => {
		// The overlay sizes itself from the real terminal, so the preview must overflow any height.
		const instructions = Array.from({ length: 120 }, (_, index) => `Instruction line ${index}`).join("\n");
		const h = make({
			advisors: [{ name: "Reviewer", instructions }],
			warnings: Array.from({ length: 40 }, (_, index) => `Warning ${index}`),
		});
		const visits: string[] = [];
		h.overlay.onNavigationVisit = page => visits.push(page);
		try {
			h.overlay.render(120);
			const first = h.overlay.navigationSnapshot();
			h.overlay.handleInput("l");
			h.overlay.handleInput("\x05");
			expect(h.overlay.navigationSnapshot()).toMatchObject({
				previewFocused: true,
				previewScroll: 1,
				content: first.content,
			});
			h.overlay.handleInput("G");
			expect(h.overlay.navigationSnapshot().previewScroll).toBeGreaterThan(1);
			h.overlay.handleInput("g");
			h.overlay.handleInput("g");
			expect(h.overlay.navigationSnapshot().previewScroll).toBe(0);
			h.overlay.handleInput("h");
			h.overlay.handleInput("j");
			const moved = h.overlay.navigationSnapshot().content;
			h.overlay.handleInput("g");
			h.overlay.handleInput("l");
			h.overlay.handleInput("h");
			h.overlay.handleInput("g");
			expect(h.overlay.navigationSnapshot().content).toEqual(moved);
			h.overlay.handleInput("g");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "advisor:0" });
			expect(visits).toEqual([]);
		} finally {
			h.overlay.dispose();
		}
	});

	it("does not delete on Space or l and retains the old advisor context before explicit deletion", () => {
		const h = make({ advisors: [{ name: "Reviewer" }] });
		let previous: unknown;
		h.overlay.onNavigationVisit = (_page, snapshot) => {
			previous = snapshot;
		};
		try {
			h.overlay.handleInput("\r");
			h.overlay.handleInput("\x1b[3~");
			h.overlay.handleInput("j");
			h.overlay.handleInput(" ");
			h.overlay.handleInput("l");
			expect(h.overlay.navigationSnapshot().doc.advisors[0]?.name).toBe("Reviewer");
			h.overlay.handleInput("\r");
			expect(previous).toMatchObject({ doc: { advisors: [{ name: "Reviewer" }] } });
			h.overlay.restoreNavigation(previous);
			expect(h.overlay.navigationSnapshot()).toMatchObject({
				context: { screen: "delete-confirm" },
				doc: { advisors: [{ name: "Reviewer" }] },
			});
			expect(h.events).toEqual([]);
		} finally {
			h.overlay.dispose();
		}
	});

	it("restores immutable draft data into the original opaque document owner before saving", async () => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }] };
		const metadata = new WeakSet([doc]);
		let saved: WatchdogConfigDoc | undefined;
		const h = make(doc);
		const restored = make(
			{ advisors: [{ name: "Other" }] },
			{
				save: async (_scope, candidate) => {
					if (!metadata.has(candidate)) throw new Error("lost document metadata");
					saved = candidate;
				},
			},
		);
		try {
			h.overlay.handleInput(" ");
			const snapshot = h.overlay.navigationSnapshot();
			h.overlay.handleInput(" ");
			expect(snapshot.doc.advisors[0]?.enabled).toBe(false);
			expect(snapshot.docOwner).toBe(doc);
			restored.overlay.restoreNavigation(snapshot);
			restored.overlay.handleInput("s");
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(saved).toBe(doc);
			expect(saved?.advisors[0]?.enabled).toBe(false);
		} finally {
			h.overlay.dispose();
			restored.overlay.dispose();
		}
	});

	it("blocks actual save/apply operations but discards a stale read-only scope result after restore", async () => {
		const saving = Promise.withResolvers<void>();
		const applying = Promise.withResolvers<void>();
		const load = Promise.withResolvers<WatchdogConfigDoc>();
		const h = make(
			{ advisors: [{ name: "Reviewer" }] },
			{
				save: () => saving.promise,
				apply: () => applying.promise,
				loadDoc: () => load.promise,
			},
		);
		try {
			const original = h.overlay.navigationSnapshot();
			h.overlay.handleInput("/");
			h.overlay.handleInput("Scope");
			h.overlay.handleInput("\x1b");
			h.overlay.handleInput("\r");
			expect(h.overlay.blocksMenuHistory).toBe(false);
			h.overlay.restoreNavigation(original);
			load.resolve({ advisors: [{ name: "Late" }] });
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(h.overlay.navigationSnapshot().scope).toBe("project");
			expect(h.overlay.navigationSnapshot().doc.advisors[0]?.name).toBe("Reviewer");
			h.overlay.handleInput(" ");
			h.overlay.handleInput("s");
			expect(h.overlay.blocksMenuHistory).toBe(true);
			saving.resolve();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(h.overlay.blocksMenuHistory).toBe(false);
			h.overlay.handleInput("a");
			expect(h.overlay.blocksMenuHistory).toBe(true);
			applying.resolve();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(h.overlay.blocksMenuHistory).toBe(false);
		} finally {
			h.overlay.dispose();
		}
	});

	it("shows native filtered roster results and keeps prefs categories out of the timeline", () => {
		const h = make({ advisors: [{ name: "Reviewer" }] });
		const visits: string[] = [];
		h.overlay.onNavigationVisit = page => visits.push(page);
		const cx: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		const sheet = () => {
			const root = h.overlay.describe(cx);
			const component = root.c?.[0] as unknown as {
				describe(): NativeNode | null;
				handleNativeEvent(event: NativeUiEvent): void;
			};
			const node = component?.describe();
			if (node?.k !== "picker") throw new Error("expected a filtered advisor picker");
			return { component, props: node.p as TspPickerProps };
		};
		try {
			h.overlay.handleNativeEvent({ type: "action", key: "", act: "page", value: "advisor:0", mods: [] });
			expect(visits).toEqual([]);
			h.overlay.handleInput("h");
			visits.length = 0;
			h.overlay.handleInput("/");
			h.overlay.handleInput("Reviewer");
			expect(sheet().props.query).toBe("Reviewer");
			expect(sheet().props.actions?.find(action => action.id === "close")?.label).toBe("Back to list");
			sheet().component.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
			expect(h.closed()).toBe(0);
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ filter: "", filterFocused: false });
			h.overlay.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
			expect(h.closed()).toBe(1);
			expect(visits).toEqual([]);
		} finally {
			h.overlay.dispose();
		}
	});
	it("clones every field into an independent editable entry without saving or applying", () => {
		const doc: WatchdogConfigDoc = {
			instructions: "shared",
			advisors: [
				{
					name: "Reviewer",
					model: "provider/model:high",
					tools: ["read", "write"],
					instructions: "specialization",
					systemPrompt: "baseline",
					enabled: false,
					includeThinking: false,
					maxNotesPerUpdate: 7,
					reviewMode: "agent-end",
					reviewInterval: 3,
					syncBacklog: "strict",
				},
			],
		};
		const original = structuredClone(doc.advisors[0]);
		const h = make(doc);
		try {
			h.overlay.handleInput("c");
			expect(doc.advisors).toEqual([original, { ...original, name: "Reviewer (copy)" }]);
			expect(h.overlay.navigationSnapshot().context).toMatchObject({ screen: "detail", index: 1 });
			h.overlay.handleInput("\r"); // Edit the copy's name.
			h.overlay.handleInput(" variant");
			h.overlay.handleInput("\r");
			doc.advisors[1].tools?.push("grep");
			expect(doc.advisors[0]).toEqual(original);
			expect(doc.advisors[1].name).toBe("Reviewer (copy) variant");
			expect(h.events).toEqual([]);
			h.overlay.handleInput("c");
			expect(doc.advisors[2].name).toBe("Reviewer (copy) variant (copy)");
		} finally {
			h.overlay.dispose();
		}
	});

	it("avoids duplicate copy names and ignores clone/delete keys inside search", () => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }, { name: "Reviewer (copy)" }] };
		const h = make(doc);
		try {
			h.overlay.handleInput("/");
			h.overlay.handleInput("c");
			h.overlay.handleInput("\x1b[3~");
			expect(doc.advisors).toHaveLength(2);
			h.overlay.handleInput("\x15"); // Clear the focused filter.
			h.overlay.handleInput("\x1b");
			h.overlay.handleInput("g");
			h.overlay.handleInput("g");
			h.overlay.handleInput("c");
			expect(doc.advisors[1].name).toBe("Reviewer (copy) 2");
		} finally {
			h.overlay.dispose();
		}
	});

	it("requires Delete and a cancel-first named confirmation, preserving save/apply semantics", () => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }, { name: "Other" }] };
		const h = make(doc);
		try {
			h.overlay.handleInput("\x1b[3~");
			const rendered = Bun.stripANSI(h.overlay.render(180).join("\n"));
			expect(rendered).toContain('Delete "Reviewer"?');
			expect(rendered).toContain("/workspace/WATCHDOG.yaml");
			h.overlay.handleInput("\r"); // Default is Cancel.
			expect(doc.advisors).toHaveLength(2);
			h.overlay.handleInput("\x1b[3~");
			h.overlay.handleInput("j"); // Highlight destructive choice.
			h.overlay.handleInput(" ");
			expect(doc.advisors).toHaveLength(2);
			const pending = h.overlay.navigationSnapshot();
			h.overlay.handleInput("\x1b");
			expect(doc.advisors).toHaveLength(2);
			h.overlay.handleInput("\x1b[3~");
			h.overlay.handleInput("\r"); // Reopening still defaults to Cancel.
			expect(doc.advisors).toHaveLength(2);
			h.overlay.restoreNavigation(pending);
			h.overlay.handleInput("\r"); // History cannot restore destructive selection.
			expect(doc.advisors).toHaveLength(2);
			h.overlay.handleInput("\r"); // Detail.
			h.overlay.handleInput("\x1b[3~");
			h.overlay.handleInput("j");
			h.overlay.handleInput("\r");
			expect(doc.advisors).toEqual([{ name: "Other" }]);
			expect(h.events).toEqual([]);
		} finally {
			h.overlay.dispose();
		}
	});

	it("has no ordinary delete row in ANSI or native prefs", () => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }] };
		const h = make(doc);
		try {
			h.overlay.handleInput("\r");
			expect(Bun.stripANSI(h.overlay.render(180).join("\n"))).not.toContain("Delete this advisor");
			const root = h.overlay.describe({
				cols: 180,
				dark: true,
				reduceMotion: false,
				supports: () => true,
				feature: () => true,
			});
			const props = root.p as TspPrefsProps;
			expect(props.sections.flatMap(section => section.rows).some(row => row.id === "delete")).toBe(false);
			h.overlay.handleNativeEvent({ type: "action", key: "", act: "delete", value: "delete", mods: [] });
			h.overlay.handleInput("G");
			h.overlay.handleInput(" "); // Back, never deletion.
			expect(doc.advisors).toEqual([{ name: "Reviewer" }]);
		} finally {
			h.overlay.dispose();
		}
	});

	it("describes the confirmation as a native picker with Cancel selected", () => {
		const h = make({ advisors: [{ name: "Reviewer" }] });
		try {
			h.overlay.handleInput("\r");
			h.overlay.handleInput("\x1b[3~");
			const root = h.overlay.describe({
				cols: 180,
				dark: true,
				reduceMotion: false,
				supports: () => true,
				feature: () => true,
			});
			const component = root.c?.[0] as unknown as { describe(): NativeNode };
			const picker = component.describe().p as TspPickerProps;
			expect(picker.title).toBe('Delete "Reviewer"?');
			expect(picker.subtitle).toContain("/workspace/WATCHDOG.yaml");
			expect(h.overlay.navigationSnapshot().content).toMatchObject({ selectedValue: "cancel" });
		} finally {
			h.overlay.dispose();
		}
	});
});

describe("advisor effective roster display", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	it("shows ancestor and user sources in both renderers without copying them into the edited file", async () => {
		const roster: EffectiveAdvisorConfig[] = [
			{ name: "Velvet", sourceFile: "/workspace/WATCHDOG.yml", scope: "project" },
			{ name: "Native", sourceFile: "/workspace/.omp/WATCHDOG.yaml", scope: "project", enabled: false },
			{ name: "User", sourceFile: path.join(os.homedir(), ".omp/agent/WATCHDOG.yml"), scope: "user" },
		];
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Local" }] };
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ ...deps, effectiveRoster: roster },
			"project",
			doc,
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, value) => {
					saved = structuredClone(value);
				},
				getEffectiveRoster: async () => roster.filter(advisor => advisor.name !== "Velvet"),
				apply: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		try {
			const rendered = Bun.stripANSI(overlay.render(180).join("\n"));
			expect(rendered).toContain("Velvet · enabled · project · /workspace/WATCHDOG.yml");
			expect(rendered).toContain("Native · disabled · project · /workspace/.omp/WATCHDOG.yaml");
			expect(rendered).toContain("User · enabled · user · ~/.omp/agent/WATCHDOG.yml");
			const props = overlay.describe({
				cols: 180,
				dark: true,
				reduceMotion: false,
				supports: () => true,
				feature: () => true,
			}).p as TspPrefsProps;
			const rows = props.sections.find(section => section.id === "effective-roster")?.rows;
			expect(rows?.map(row => ({ name: row.label, source: row.hint, control: row.control }))).toEqual([
				{ name: "Velvet", source: "project · /workspace/WATCHDOG.yml", control: { k: "switch", on: true } },
				{ name: "Native", source: "project · /workspace/.omp/WATCHDOG.yaml", control: { k: "switch", on: false } },
				{ name: "User", source: "user · ~/.omp/agent/WATCHDOG.yml", control: { k: "switch", on: true } },
			]);
			expect(rows?.every(row => row.disabled)).toBe(true);
			overlay.handleInput(" "); // The overview is informational, never a toggle.
			overlay.handleInput("s");
			await Bun.sleep(0);
			expect(saved).toEqual({ advisors: [{ name: "Local" }] });
			expect(Bun.stripANSI(overlay.render(180).join("\n"))).not.toContain("Velvet");
		} finally {
			overlay.dispose();
		}
	});
});
