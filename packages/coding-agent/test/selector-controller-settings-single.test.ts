import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import * as settingsReload from "@oh-my-pi/pi-coding-agent/control/settings-reload";
import * as settingsSelector from "@oh-my-pi/pi-tui/overlays/settings-selector";
import * as sessionPins from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	cfgComposerShape,
	cfgStatusLinePreset,
	cfgStatusLineLeftSegments,
	cfgStatusLineRightSegments,
	cfgStatusLineSegmentOptions,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { statusLineDraftPath, StatusLineDraftStore } from "@oh-my-pi/pi-coding-agent/neopi/status-line-draft";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import type { StatusLineSegmentId } from "@oh-my-pi/pi-tui/status-line/types";
import {
	StatusLineConfigOverlayComponent,
	type StatusLineEditorDraft,
} from "@oh-my-pi/pi-tui/overlays/status-line-config";

const DOWN = "\x1b[B";
const ESC = "\x1b";

function press(component: Component, ...keys: string[]): void {
	for (const key of keys) component.handleInput?.(key);
}

function startupStatusLine(leftSegments: StatusLineSegmentId[], rightSegments: StatusLineSegmentId[]) {
	return createStartupStatusLine({
		settings: { preset: "custom", leftSegments, rightSegments },
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

/** The draft file once autosave has written a state matching `ready`. */
async function waitForDraft(
	draftPath: string,
	ready: (draft: StatusLineEditorDraft) => boolean,
): Promise<StatusLineEditorDraft> {
	const store = new StatusLineDraftStore(draftPath);
	for (let attempt = 0; attempt < 200; attempt++) {
		const draft = await store.read();
		if (draft && ready(draft)) return draft;
		await Bun.sleep(5);
	}
	throw new Error(`No matching status-line draft at ${draftPath}`);
}

/** The overlay members of `ui` the single-instance guard reads and drives. */
interface OverlayUi {
	overlayStack: TUI["overlayStack"];
	setFocus: (component: Component | null) => void;
	getFocused: () => Component | null;
	showOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
}

/** A `ui` whose overlays live on `overlayStack` as TUI's do: shown on top, removed on hide. */
function overlayUi(): {
	ui: OverlayUi;
	shown: Component[];
	setFocus: OverlayUi["setFocus"];
	overlayStack: TUI["overlayStack"];
} {
	const overlayStack: TUI["overlayStack"] = [];
	const shown: Component[] = [];
	let focused: Component | null = null;
	const setFocus = vi.fn<(component: Component | null) => void>(component => {
		focused = component;
	});
	const showOverlay = (component: Component, options?: OverlayOptions): OverlayHandle => {
		const entry = { component, options, preFocus: null, hidden: false, released: false };
		overlayStack.push(entry);
		shown.push(component);
		return {
			hide: () => {
				const at = overlayStack.indexOf(entry);
				if (at >= 0) overlayStack.splice(at, 1);
			},
			setHidden: hidden => {
				entry.hidden = hidden;
			},
			isHidden: () => entry.hidden,
		};
	};
	return { shown, setFocus, overlayStack, ui: { overlayStack, setFocus, showOverlay, getFocused: () => focused } };
}

/** A context whose model picker reads a supplied current catalog. */
function pickerContext(ui: OverlayUi, models: Model[] = [], current?: Model, settings?: Settings) {
	return createInteractiveModeContext({
		settings,
		session: {
			model: current,
			scopedModels: [],
			getContextUsage: () => undefined,
			effectiveServiceTier: () => undefined,
			getRoleModelCycle: () => undefined,
			resolveTemporaryModelThinkingLevel: () => undefined,
			setModelTemporary: vi.fn(async () => {}),
			applyRoleModel: vi.fn(async () => {}),
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => models,
				getAll: () => models,
				refreshIfStale: async () => false,
			},
		},
		ui,
		keybindings: { getKeys: () => [], getDisplayString: () => "" },
	});
}

describe("single-instance menus", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		// In-memory Settings share the suite's guarded agent dir; never leak a draft into the next test.
		const draftPath = statusLineDraftPath(getAgentDir());
		await fs.rm(draftPath, { force: true });
		await fs.rm(`${draftPath}.bak`, { force: true });
	});

	it("opens /statusline, applies without closing, and closes on Esc once nothing is pending", async () => {
		const isolated = Settings.isolated();
		cfgComposerShape.set(isolated, "band");
		cfgStatusLinePreset.set(isolated, "custom");
		cfgStatusLineLeftSegments.set(isolated, ["model", "context_bar"]);
		cfgStatusLineRightSegments.set(isolated, ["time"]);
		const statusLine = startupStatusLine(["model", "context_bar"], ["time"]);
		const { ui, shown } = overlayUi();
		const syncComposerShape = vi.fn<(shape?: string) => void>();
		const ctx = createInteractiveModeContext({ settings: isolated, statusLine, ui, syncComposerShape });
		const controller = new SelectorController(ctx);
		ctx.showStatusLineConfigure = () => controller.showStatusLineConfigure();
		try {
			expect(await executeBuiltinSlashCommand("/statusline", { ctx })).toBe(true);
			expect(shown[0]).toBeInstanceOf(StatusLineConfigOverlayComponent);
			controller.showStatusLineConfigure();
			expect(shown).toHaveLength(1);
			press(shown[0]!, "\r", DOWN, "l", "l"); // band → box; model past the context bar into the right side
			expect(syncComposerShape).toHaveBeenLastCalledWith("box");
			press(shown[0]!, "\x13"); // Ctrl+S
			await Bun.sleep(0);
			expect(cfgStatusLinePreset.get(isolated)).toBe("custom");
			expect(cfgStatusLineLeftSegments.get(isolated)).toEqual(["context_bar"]);
			expect(cfgStatusLineRightSegments.get(isolated)).toEqual(["model", "time"]);
			expect(cfgComposerShape.get(isolated)).toBe("box");
			expect(ui.overlayStack).toHaveLength(1);
			press(shown[0]!, ESC);
			expect(ui.overlayStack).toHaveLength(0);
		} finally {
			statusLine.dispose();
		}
	});

	it.each([true, false])(
		"rolls back a rejected apply and keeps the draft on disk (configured: %s)",
		async configured => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-statusline-rollback-"));
			const isolated = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
			const handles = [
				cfgStatusLineLeftSegments,
				cfgStatusLineRightSegments,
				cfgStatusLinePreset,
				cfgStatusLineSegmentOptions,
				cfgComposerShape,
			] as const;
			if (configured) {
				cfgStatusLineLeftSegments.set(isolated, ["time"]);
				cfgStatusLineRightSegments.set(isolated, ["model"]);
				cfgStatusLinePreset.set(isolated, "minimal");
				cfgStatusLineSegmentOptions.set(isolated, { path: { maxLength: 7 } });
				cfgComposerShape.set(isolated, "rail");
			}
			await isolated.flush();
			const before = handles.map(handle => handle.get(isolated));
			const statusLine = startupStatusLine(["model"], ["time"]);
			const { ui, shown } = overlayUi();
			const failed = Promise.withResolvers<void>();
			const ctx = createInteractiveModeContext({
				settings: isolated,
				statusLine,
				ui,
				syncComposerShape: () => {},
				showStatus: message => {
					if (message.startsWith("Could not apply the status-line layout")) failed.resolve();
				},
			});
			const controller = new SelectorController(ctx);
			const flush = spyOn(isolated, "flush").mockRejectedValueOnce(new Error("save failed"));
			// A second I/O failure must leave only rollback values queued for a later retry.
			if (!configured) flush.mockRejectedValueOnce(new Error("rollback flush failed"));
			const warning = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				controller.showStatusLineConfigure();
				press(shown[0]!, "\r", DOWN, "l", "s");
				await failed.promise;
				expect(handles.map(handle => handle.get(isolated))).toEqual(before);
				expect(handles.map(handle => isolated.isConfigured(handle))).toEqual(handles.map(() => configured));
				expect(ui.overlayStack).toHaveLength(1);
				expect(flush).toHaveBeenCalledTimes(2);
				expect(warning).toHaveBeenCalledTimes(configured ? 0 : 1);
				press(shown[0]!, ESC, "n");
				expect(ui.overlayStack).toHaveLength(0);
				flush.mockRestore();
				await isolated.flush();
				const reloaded = await Settings.loadReadOnly({ agentDir: dir, cwd: dir });
				expect(handles.map(handle => handle.get(reloaded))).toEqual(before);
				expect(handles.map(handle => reloaded.isConfigured(handle))).toEqual(handles.map(() => configured));
				const draft = await waitForDraft(statusLineDraftPath(dir), saved => saved.right[0]?.id === "model");
				expect(draft.right.map(row => row.id).slice(0, 2)).toEqual(["model", "time"]);
				expect(draft.composerShape).not.toBe(configured ? "rail" : "band");
			} finally {
				flush.mockRestore();
				statusLine.dispose();
				await isolated.flush();
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("declining to apply restores the real status line and composer and keeps the draft", async () => {
		const isolated = Settings.isolated({ "composer.shape": "band" });
		const statusLine = startupStatusLine(["model"], ["time"]);
		const original = statusLine.getEffectiveSettings();
		const { ui, shown } = overlayUi();
		const syncComposerShape = vi.fn<(shape?: string) => void>();
		const ctx = createInteractiveModeContext({ settings: isolated, statusLine, ui, syncComposerShape });
		const controller = new SelectorController(ctx);
		try {
			controller.showStatusLineConfigure();
			press(shown[0]!, "\r", DOWN, " ");
			expect(statusLine.getEffectiveSettings().leftSegments).toEqual([]);
			press(shown[0]!, ESC);
			expect(ui.overlayStack).toHaveLength(1); // the apply prompt is open
			press(shown[0]!, "n");
			expect(ui.overlayStack).toHaveLength(0);
			expect(statusLine.getEffectiveSettings()).toEqual(original);
			expect(syncComposerShape).toHaveBeenLastCalledWith("band");
			expect(cfgComposerShape.get(isolated)).toBe("band");
			expect(cfgStatusLinePreset.get(isolated)).toBe("default");
			const draft = await waitForDraft(statusLineDraftPath(getAgentDir()), saved => saved.composerShape === "box");
			expect(draft.left).toContainEqual({ id: "model", enabled: false });
		} finally {
			statusLine.dispose();
		}
	});

	it("preserves the status-line draft through backward and forward history navigation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-statusline-history-"));
		const isolated = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
		cfgComposerShape.set(isolated, "band");
		const statusLine = startupStatusLine(["model"], ["time"]);
		const active = statusLine.getEffectiveSettings();
		const { ui, shown, setFocus } = overlayUi();
		const syncComposerShape = vi.fn<(shape?: string) => void>();
		const ctx = createInteractiveModeContext({ settings: isolated, statusLine, ui, syncComposerShape });
		const controller = new SelectorController(ctx);
		try {
			controller.showStatusLineConfigure();
			const first = shown[0]!;
			press(first, "\r", DOWN, " ", "/", ..."model", "\r");
			expect(first.render(100).join("\n")).toContain('filter "model"');
			expect(controller.navigateMenuHistory(-1)).toBe(true);
			await Promise.resolve();
			expect(ui.overlayStack).toHaveLength(0);
			expect(statusLine.getEffectiveSettings()).toEqual(active);

			expect(controller.navigateMenuHistory(1)).toBe(true);
			const reopened = shown[1]!;
			expect(reopened).toBeInstanceOf(StatusLineConfigOverlayComponent);
			expect(reopened).not.toBe(first);
			// The restore notice owns the footer; the filtered list still reflects the saved query.
			const reopenedText = Bun.stripANSI(reopened.render(100).join("\n"));
			expect(reopenedText).toContain("Restored the unapplied status-line draft");
			expect(reopenedText).toContain("Model · model");
			expect(reopenedText).not.toContain("Time");
			expect(statusLine.getEffectiveSettings().leftSegments).toEqual([]);
			expect(syncComposerShape).toHaveBeenLastCalledWith("box");
			expect(controller.navigateMenuHistory(-1)).toBe(true);
			expect(ui.overlayStack).toHaveLength(0);
			expect(setFocus).toHaveBeenLastCalledWith(ctx.editorContainer.children[0] ?? ctx.editor);
			expect(statusLine.getEffectiveSettings()).toEqual(active);
			expect(cfgComposerShape.get(isolated)).toBe("band");
			const draft = await waitForDraft(statusLineDraftPath(dir), saved => saved.query === "model");
			expect(draft.left).toContainEqual({ id: "model", enabled: false });
			expect(draft.composerShape).toBe("box");
		} finally {
			statusLine.dispose();
			await isolated.flush();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("restores the draft after a restart and applies usage templates beside other segment options", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-statusline-draft-"));
		const isolated = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
		cfgStatusLinePreset.set(isolated, "custom");
		cfgStatusLineLeftSegments.set(isolated, ["usage:anthropic:5h"]);
		cfgStatusLineRightSegments.set(isolated, ["time"]);
		cfgStatusLineSegmentOptions.set(isolated, { path: { maxLength: 7 } });
		await isolated.flush();
		const firstLine = startupStatusLine(["usage:anthropic:5h"], ["time"]);
		const first = overlayUi();
		const firstCtx = createInteractiveModeContext({
			settings: isolated,
			statusLine: firstLine,
			ui: first.ui,
			syncComposerShape: () => {},
		});
		try {
			new SelectorController(firstCtx).showStatusLineConfigure();
			const typed = "{percent} used".split("");
			press(first.shown[0]!, DOWN, "\t", ...Array.from({ length: 30 }, () => "\x7f"), ...typed, "\r", ESC, "n");
			await waitForDraft(
				statusLineDraftPath(dir),
				saved => saved.usageTemplates["usage:anthropic:5h"] !== undefined,
			);
		} finally {
			firstLine.dispose();
		}

		// A new controller, as after a restart, has no in-memory draft and reads the file.
		const secondLine = startupStatusLine(["usage:anthropic:5h"], ["time"]);
		const second = overlayUi();
		const secondCtx = createInteractiveModeContext({
			settings: isolated,
			statusLine: secondLine,
			ui: second.ui,
			syncComposerShape: () => {},
		});
		try {
			new SelectorController(secondCtx).showStatusLineConfigure();
			expect(secondLine.getEffectiveSettings().segmentOptions.usageBars?.templates).toEqual({
				"usage:anthropic:5h": "{percent} used",
			});
			press(second.shown[0]!, "s");
			await Bun.sleep(0);
			await Bun.sleep(0);
			expect(cfgStatusLineSegmentOptions.get(isolated)).toEqual({
				path: { maxLength: 7 },
				usageBars: { templates: { "usage:anthropic:5h": "{percent} used" } },
			});
			expect(second.ui.overlayStack).toHaveLength(1);
		} finally {
			secondLine.dispose();
			await isolated.flush();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	// Regression: a second /settings (typed while theme discovery was pending, or
	// from Tern's native composer while the menu was open) stacked another
	// fullscreen settings menu on top of the first.
	it("focuses the open menu instead of stacking a second one", async () => {
		const themes = Promise.resolve(["dark"]);
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes);
		const overlays: Component[] = [];
		const setFocus = vi.fn<(component: Component | null) => void>();
		const ctx = createInteractiveModeContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					overlays.push(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
				},
				setFocus,
			},
		});
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();
		controller.showSettingsSelector();
		// The controller's continuation was queued first, so the menu is mounted.
		await themes;
		expect(overlays).toHaveLength(1);
		controller.showSettingsSelector();
		expect(overlays).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(overlays[0]);
	});

	it("distinguishes unsupported settings reload hosts from failed reloads", async () => {
		const themes = Promise.resolve(["dark"]);
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes);
		const broadcast = spyOn(settingsReload, "broadcastSettingsReload").mockResolvedValue({
			notified: 2, unsupported: 1, failed: 1,
		});
		let callbacks: settingsSelector.SettingsCallbacks | undefined;
		spyOn(settingsSelector, "SettingsSelectorComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[1] as settingsSelector.SettingsCallbacks;
			return { render: () => [], dispose: () => {} };
		} as never);
		const { ui } = overlayUi();
		const ctx = createInteractiveModeContext({
			settings: Settings.isolated(),
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui,
		});
		new SelectorController(ctx).showSettingsSelector("global");
		await themes;
		expect(await callbacks?.onApply?.("session")).toBe("Session scope is local — no broadcast needed");
		expect(broadcast).not.toHaveBeenCalled();
		expect(await callbacks?.onApply?.("global")).toBe("Applied to 2 sessions; 1 need restart/upgrade; 1 failed");
		expect(broadcast).toHaveBeenCalledWith("global", ctx.sessionManager.getCwd());
	});

	// Regression: clicking Tern's composer model chip again while the picker was
	// still opening (or already open) stacked another picker per click.
	it("opens one model picker per close, focusing it on repeat requests", () => {
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));

		controller.showModelSelector({ temporaryOnly: true });
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(2);
	});

	it("replaces an ordinary picker with selection-only and ignores stale picker input", () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "selection-target" }).model;
		const hostModel = createMockModel({ provider: "anthropic", id: "host-model" }).model;
		const ctx = pickerContext(ui, [model], hostModel, Settings.isolated());
		cfgTaskAgentModelOverrides.override(ctx.settings, { task: "kept/task-model" });
		const taskDefaults = structuredClone(cfgTaskAgentModelOverrides.get(ctx.settings));
		const selected = vi.fn();
		const controller = new SelectorController(ctx);

		controller.showModelSelector({ temporaryOnly: true });
		const ordinaryPicker = shown[0]!;
		controller.showModelSelector({
			selectOnly: {
				currentSelector: `${model.provider}/${model.id}`,
				onSelect: selected,
			},
		});
		const selectionPicker = shown[1]!;
		expect(ui.overlayStack).toHaveLength(1);
		expect(ui.overlayStack.at(-1)?.component).toBe(selectionPicker);

		ordinaryPicker.handleInput?.("\r");
		expect(ctx.session.setModelTemporary).not.toHaveBeenCalled();
		selectionPicker.handleInput?.("\r");

		expect(selected).toHaveBeenCalledWith(`${model.provider}/${model.id}`);
		expect(ctx.session.setModelTemporary).not.toHaveBeenCalled();
		expect(ctx.session.applyRoleModel).not.toHaveBeenCalled();
		expect(cfgTaskAgentModelOverrides.get(ctx.settings)).toEqual(taskDefaults);

		controller.showModelSelector({
			selectOnly: { currentSelector: `${model.provider}/${model.id}`, onSelect: selected },
		});
		shown[2]?.handleInput?.("\x1b");
		expect(selected).toHaveBeenCalledTimes(1);
	});

	it("replaces selection-only with an ordinary session model picker", () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "session-target" }).model;
		const hostModel = createMockModel({ provider: "anthropic", id: "host-model" }).model;
		const ctx = pickerContext(ui, [model], hostModel);
		const selected = vi.fn();
		const controller = new SelectorController(ctx);

		controller.showModelSelector({
			selectOnly: {
				currentSelector: `${model.provider}/${model.id}`,
				onSelect: selected,
			},
		});
		const selectionPicker = shown[0]!;
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(2);
		expect(ui.overlayStack).toHaveLength(1);

		selectionPicker.handleInput?.("\r");
		expect(selected).not.toHaveBeenCalled();
		expect(ctx.session.setModelTemporary).not.toHaveBeenCalled();
		shown[1]?.handleInput?.("\r");

		expect(selected).not.toHaveBeenCalled();
		expect(ctx.session.setModelTemporary).toHaveBeenCalledWith(model, undefined);
	});

	it("uses only the newest callbacks for repeated selection-only picker requests", () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "selection-target" }).model;
		const selector = `${model.provider}/${model.id}`;
		const controller = new SelectorController(pickerContext(ui, [model]));
		const oldSelect = vi.fn();
		const latestSelect = vi.fn();

		controller.showModelSelector({ selectOnly: { currentSelector: selector, onSelect: oldSelect } });
		const oldPicker = shown[0]!;
		controller.showModelSelector({ selectOnly: { currentSelector: selector, onSelect: latestSelect } });
		expect(ui.overlayStack).toHaveLength(1);

		oldPicker.handleInput?.("\r");
		expect(oldSelect).not.toHaveBeenCalled();
		expect(latestSelect).not.toHaveBeenCalled();
		shown[1]?.handleInput?.("\r");
		expect(oldSelect).not.toHaveBeenCalled();
		expect(latestSelect).toHaveBeenCalledWith(selector);

		controller.showModelSelector({
			selectOnly: { currentSelector: selector, onSelect: vi.fn() },
		});
		const stalePicker = shown[2]!;
		controller.showModelSelector({
			selectOnly: { currentSelector: selector, onSelect: vi.fn() },
		});
		stalePicker.handleInput?.("\x1b");
		expect(ui.overlayStack).toHaveLength(1);
		shown[3]?.handleInput?.("\x1b");
		expect(ui.overlayStack).toHaveLength(0);
	});

	it("raises an open model picker another overlay covers instead of focusing it hidden", () => {
		const { ui, overlayStack } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));
		controller.showModelSelector({ temporaryOnly: true });
		const picker = overlayStack[0]?.component;
		ui.showOverlay({ render: () => [], invalidate: () => {} });

		controller.showModelSelector({ temporaryOnly: true });
		expect(overlayStack).toHaveLength(2);
		expect(overlayStack.at(-1)?.component).toBe(picker);
	});

	it("opens one agents dashboard while it loads, and opens again after a failed load", async () => {
		const { ui, shown } = overlayUi();
		const controller = new SelectorController(createInteractiveModeContext({ ui }));
		const failed = Promise.withResolvers<AgentsHubComponent>();
		const create = spyOn(AgentsHubComponent, "create").mockReturnValue(failed.promise);

		const first = controller.showAgentsDashboard();
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(1);
		failed.reject(new Error("discovery failed"));
		await expect(first).rejects.toThrow("discovery failed");

		create.mockResolvedValue(Object.create(AgentsHubComponent.prototype));
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(2);
		expect(shown).toHaveLength(1);
	});

	// Regression: a second /usage (or status-line cost click) while the dashboard
	// was open stacked another fullscreen dashboard on top of the first.
	it("opens one usage dashboard per close, focusing it on repeat requests", () => {
		spyOn(activityClient, "loadDailyActivity").mockResolvedValue(undefined);
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: {
					model: undefined,
					getUsageReportingModelSelectors: () => [],
					fetchUsageReports: async () => null,
					modelRegistry: {
						authStorage: {
							credentials: { all: () => ({}) },
							usage: { providerFor: () => undefined },
							oauth: { identity: () => undefined },
						},
					},
				},
				ui,
			}),
		);
		const reports = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];

		controller.showUsageDashboard(reports);
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(2);
	});

	it("selects a seance source without resuming", async () => {
		const session: SessionInfo = {
			path: "/repo/.omp/sessions/source.jsonl",
			id: "source",
			cwd: "/repo",
			created: new Date(1),
			modified: new Date(2),
			messageCount: 1,
			size: 16,
			firstMessage: "Inspect the old session",
			allMessagesText: "Inspect the old session",
		};
		spyOn(SessionManager, "listForPicker").mockResolvedValue([session]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());
		const { ui, shown, overlayStack } = overlayUi();
		const ctx = createInteractiveModeContext({
			ui: { ...ui, terminal: { rows: 24 } },
			session: { switchSession: vi.fn(async () => true) },
			sessionManager: {
				getCwd: () => "/repo",
				getSessionDir: () => "/repo/.omp/sessions",
				getSessionFile: () => undefined,
			},
		});
		const controller = new SelectorController(ctx);
		const resume = spyOn(controller, "handleResumeSession").mockResolvedValue(true);
		const overlayCountAtSelection: number[] = [];
		const selected = vi.fn(async (_session: SessionInfo) => {
			overlayCountAtSelection.push(overlayStack.length);
		});

		await controller.showSessionSelector(undefined, selected);

		const selector = shown[0] as SessionSelectorComponent<SessionInfo>;
		selector.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(selected).toHaveBeenCalledWith(session);
		expect(overlayCountAtSelection).toEqual([0]);
		expect(resume).not.toHaveBeenCalled();
		expect(ctx.session.switchSession).not.toHaveBeenCalled();
	});
});
