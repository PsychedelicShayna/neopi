import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "../src/index";
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

describe("advisor config editor warnings and synthetic default row", () => {
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
		expect(notes).toEqual(["Advisor config: nothing to apply."]);

		overlay.handleInput(" "); // alpha back on, unsaved: `a` saves first, then applies
		overlay.handleInput("a");
		await flush();
		expect(events).toEqual(["save:false", "apply", "save:undefined", "apply"]);
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
});
