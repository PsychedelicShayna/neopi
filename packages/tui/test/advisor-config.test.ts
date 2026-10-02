import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "../src/index";
import type { DescribeContext } from "../src/native/node";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigDeps,
	type WatchdogConfigDoc,
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
