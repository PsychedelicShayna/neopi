import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
	SelectorController,
	type MenuHost,
	type MenuKind,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SettingsList, type SettingsListTheme } from "@oh-my-pi/pi-tui/components/settings-list";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { ModelHubComponent, type ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext, type SessionOverrides } from "./helpers/interactive-mode-context";

const theme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: ">",
	hint: text => text,
};

function harness(session?: SessionOverrides) {
	const overlayStack: TUI["overlayStack"] = [];
	let focused: Component | null = null;
	const status: string[] = [];
	const shown: Component[] = [];
	const showOverlay = (component: Component, options?: OverlayOptions): OverlayHandle => {
		const entry = { component, options, preFocus: focused, hidden: false, released: false };
		overlayStack.push(entry);
		shown.push(component);
		focused = component;
		return {
			hide: () => {
				const at = overlayStack.indexOf(entry);
				if (at >= 0) overlayStack.splice(at, 1);
				focused = entry.preFocus;
			},
			setHidden: hidden => {
				entry.hidden = hidden;
			},
			isHidden: () => entry.hidden,
		};
	};
	const ctx = createInteractiveModeContext({
		session,
		ui: {
			overlayStack,
			showOverlay,
			getFocused: () => focused,
			setFocus: component => {
				focused = component;
			},
		},
		showStatus: message => {
			status.push(message);
		},
	});
	const controller = new SelectorController(ctx);
	const menus = new Map<MenuKind, SettingsList>();
	const closes = new Map<MenuKind, () => void>();
	const open = (kind: MenuKind) => {
		const host = controller.openMenu(kind, () => open(kind));
		if (!host) return;
		let handle: OverlayHandle;
		const close = () => {
			host.close();
			handle.hide();
			controller.focusActiveEditorArea();
		};
		const list = new SettingsList(
			[
				{ id: "first", label: "First", currentValue: "off", values: ["off", "on"] },
				{
					id: "nested",
					label: "Nested",
					currentValue: "",
					submenu: (_value, done) =>
						new SettingsList(
							[
								{ id: "a", label: "Alpha", currentValue: "off", values: ["off", "on"] },
								{ id: "b", label: "Beta", currentValue: "off", values: ["off", "on"] },
							],
							4,
							theme,
							() => {},
							() => done(),
						),
				},
			],
			4,
			theme,
			() => {},
			close,
		);
		menus.set(kind, list);
		closes.set(kind, close);
		host.mount(list, () => {
			handle = showOverlay(list);
			return handle;
		});
	};
	return { controller, ctx, open, menus, closes, shown, status, overlayStack, showOverlay, focused: () => focused };
}

beforeAll(async () => {
	await initTheme(false);
});

it("Ctrl-O/Ctrl-I revisit a saved preset's name field without applying presets", () => {
	const h = harness();
	const saved: string[] = [];
	const switched: string[] = [];
	let revision = 0;
	const source: ModelHubSource = {
		get revision() {
			return revision;
		},
		disabledProviders: [],
		fallbackChains: {},
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: () => undefined,
		getModelRoleSource: () => "default",
		effortRules: [],
		permittedEfforts: () => [],
		getProjectRoleEffortSelection: () => undefined,
		getGlobalRoleEffortSelection: () => undefined,
		getRoleEffortSelection: () => undefined,
		getFallbackEffortSelection: () => undefined,
		formatModelSelector: model => `${model.provider}/${model.id}`,
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: ["default"],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
		getModelPresets: () => ({ names: ["saved"], active: undefined }),
	};
	const hub = new ModelHubComponent(
		h.ctx.ui,
		source,
		{
			getError: () => undefined,
			getAvailable: () => [],
			getAll: () => [],
			authStorage: { keys: { source: () => undefined } },
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
			find: () => undefined,
			refresh: async () => {},
			refreshProvider: async () => {},
		},
		[],
		{
			onAssign: () => true,
			onUnassign: () => {},
			onCancel: () => {},
			onSavePreset: name => {
				saved.push(name);
				revision++;
			},
			onSwitchPreset: name => {
				switched.push(name);
				revision++;
			},
		},
	);
	const host = h.controller.openMenu("model-hub", () => {});
	if (!host) throw new Error("expected model hub host");
	host.mount(hub, () => h.showOverlay(hub));
	hub.handleNativeEvent({ type: "select", key: "scopes", item: "roles" });
	hub.handleInput("s");
	hub.handleInput("saved");
	hub.handleInput("\r");
	expect(saved).toEqual(["saved"]);
	expect(h.controller.navigateMenuHistory(-1)).toBe(true);
	const strip = hub.navigationSnapshot().strip;
	if (strip?.kind !== "name") throw new Error("expected preset-name field");
	expect(strip.input.getValue()).toBe("saved");
	hub.handleInput("\x1b[1;5D");
	hub.handleInput("\x1b[1;5C");
	expect(switched).toEqual([]);
	expect(saved).toEqual(["saved"]);
	expect(h.controller.navigateMenuHistory(1)).toBe(true);
	expect(hub.navigationSnapshot().strip).toBeNull();
	expect(switched).toEqual([]);
	hub.dispose();
});

describe("controller menu timeline", () => {
	it("restores a nested page in place and preserves both parent and child selection", () => {
		const h = harness();
		h.open("settings");
		const menu = h.menus.get("settings")!;
		menu.handleInput("j");
		menu.handleInput("\r");
		menu.handleInput("j");
		expect(menu.navigationSnapshot().submenuId).toBe("nested");
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.shown).toHaveLength(1);
		expect(menu.navigationSnapshot().submenuId).toBeNull();
		expect(menu.getSelectedItem()?.id).toBe("nested");
		expect(h.controller.navigateMenuHistory(1)).toBe(true);
		expect(h.shown).toHaveLength(1);
		expect(menu.navigationSnapshot().submenuId).toBe("nested");
		const child = menu.openSubmenu?.component;
		expect(child).toBeInstanceOf(SettingsList);
		expect((child as SettingsList).getSelectedItem()?.id).toBe("b");
	});

	it("records a nested close as conversation and reopens that nested page", async () => {
		const h = harness();
		h.open("settings");
		const original = h.menus.get("settings")!;
		original.handleInput("j");
		original.handleInput("\r");
		original.handleInput("j");
		h.closes.get("settings")!();
		await Promise.resolve();
		expect(h.overlayStack).toHaveLength(0);
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		const reopened = h.menus.get("settings")!;
		expect(reopened).not.toBe(original);
		expect(reopened.navigationSnapshot().submenuId).toBe("nested");
		expect((reopened.openSubmenu?.component as SettingsList).getSelectedItem()?.id).toBe("b");
		expect(h.controller.navigateMenuHistory(1)).toBe(true);
		expect(h.overlayStack).toHaveLength(0);
		expect(h.focused()).toBe(h.ctx.editorContainer.children[0] ?? h.ctx.editor);
	});

	it("preserves forward visits when C is opened from the older A visit", () => {
		const h = harness();
		h.open("settings"); // A
		h.menus.get("settings")!.handleInput("j");
		h.open("advisor-config"); // B
		expect(h.controller.navigateMenuHistory(-1)).toBe(true); // A
		h.open("chain-config"); // C, appended after B
		expect(h.controller.navigateMenuHistory(-1)).toBe(true); // origin A
		expect(h.focused()).toBe(h.menus.get("settings")!);
		expect(h.menus.get("settings")!.getSelectedItem()?.id).toBe("nested");
		expect(h.controller.navigateMenuHistory(1)).toBe(true); // B retained
		expect(h.focused()).toBe(h.menus.get("advisor-config")!);
		expect(h.controller.navigateMenuHistory(1)).toBe(true); // C
		expect(h.focused()).toBe(h.menus.get("chain-config")!);
	});

	it("records Escape to a parent page without closing the registered menu", () => {
		const h = harness();
		h.open("settings");
		const menu = h.menus.get("settings")!;
		menu.handleInput("j");
		menu.handleInput("\r");
		menu.handleInput("j");
		menu.handleInput("\x1b");
		expect(menu.navigationSnapshot().submenuId).toBeNull();
		expect(h.overlayStack).toHaveLength(1);
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(menu.navigationSnapshot().submenuId).toBe("nested");
		expect((menu.openSubmenu?.component as SettingsList).getSelectedItem()?.id).toBe("b");
	});

	it("does not let delayed external-menu cleanup steal history focus", () => {
		const h = harness();
		h.open("settings");
		const host = h.controller.openMenu("git", () => {});
		expect(host).toBeDefined();
		let leaves = 0;
		const external = {
			render: () => [],
			invalidate: () => {},
			navigationSnapshot: () => ({ draft: "safe unsent text" }),
			restoreNavigation: () => {},
			leaveMenu: () => {
				leaves++;
			},
		};
		host!.mount(external, () => h.showOverlay(external));
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(leaves).toBe(1);
		expect(host!.close()).toBe(false);
		expect(h.focused()).toBe(h.menus.get("settings")!);
		expect(h.overlayStack).toHaveLength(1);
	});

	it("keeps an external host registered when its covered handle is raised", () => {
		const h = harness();
		const closed: boolean[] = [];
		const external: Component = { render: () => [] };
		const open = () => {
			const host = h.controller.openMenu("jobs-panel", open);
			if (!host) return;
			host.mount(external, () => {
				const handle = h.showOverlay(external);
				const hide = handle.hide.bind(handle);
				handle.hide = () => {
					closed.push(host.close());
					hide();
				};
				return handle;
			});
		};
		open();
		h.open("settings");
		open();
		open();
		expect(closed).toEqual([false]);
		expect(h.shown).toHaveLength(3);
		expect(h.overlayStack).toHaveLength(2);
		expect(h.focused()).toBe(external);
		expect(h.controller.openMenu("jobs-panel", open)).toBeUndefined();
	});

	it("discards a delayed menu mount after another menu was visited", () => {
		const h = harness();
		const pending = h.controller.openMenu("git", () => {});
		h.open("settings");
		let disposed = 0;
		let mounted = false;
		const delayed: Component = {
			render: () => [],
			dispose: () => {
				disposed++;
			},
		};
		pending!.mount(delayed, () => {
			mounted = true;
			return h.showOverlay(delayed);
		});
		expect(mounted).toBe(false);
		expect(disposed).toBe(1);
		expect(pending!.close()).toBe(false);
		expect(h.focused()).toBe(h.menus.get("settings")!);
	});

	it("claims an inline account picker before loading and discards its late result", async () => {
		const lookup = Promise.withResolvers<undefined>();
		const h = harness({ listCurrentProviderOAuthAccounts: () => lookup.promise });
		h.open("settings");
		const loading = h.controller.showSessionPinSelector();
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		lookup.resolve(undefined);
		await loading;
		expect(h.focused()).toBe(h.menus.get("settings")!);
		expect(h.overlayStack).toHaveLength(1);
		expect(h.status).not.toContain("Select a model before pinning a provider account.");
	});

	it("releases failed inline opens so the next request can load again", async () => {
		let attempts = 0;
		const h = harness({
			listCurrentProviderOAuthAccounts: async () => {
				attempts++;
				throw new Error("account listing failed");
			},
		});
		await h.controller.showSessionPinSelector();
		await h.controller.showSessionPinSelector();
		expect(attempts).toBe(2);
	});

	it("records conversation when the visible menu closes while an older load is pending", async () => {
		const h = harness();
		const pending = h.controller.openMenu("git", () => {});
		h.open("settings");
		h.closes.get("settings")!();
		await Promise.resolve();
		expect(pending!.close()).toBe(false);
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.focused()).toBe(h.menus.get("settings")!);
	});

	it("preserves a pending restore across another back and forward before mounting", () => {
		const h = harness();
		let pending: MenuHost | undefined;
		const reopen = () => {
			pending = h.controller.openMenu("git", reopen);
		};
		const saved = { query: "retained", selected: "stable-key" };
		const original = { render: () => [], navigationSnapshot: () => saved, restoreNavigation: () => {} };
		reopen();
		pending!.mount(original, () => h.showOverlay(original));
		h.open("settings");
		h.controller.navigateMenuHistory(-1);
		const abandoned = pending!;
		h.controller.navigateMenuHistory(1);
		h.controller.navigateMenuHistory(-1);
		let restored: unknown;
		const latest = {
			render: () => [],
			navigationSnapshot: () => restored,
			restoreNavigation: (snapshot: unknown) => {
				restored = snapshot;
			},
		};
		pending!.mount(latest, () => h.showOverlay(latest));
		expect(restored).toEqual(saved);
		expect(abandoned.close()).toBe(false);
		expect(h.focused()).toBe(latest);
	});

	it("keeps an editor-slot prompt mounted and focuses it on return to conversation", () => {
		const h = harness();
		const prompt: Component = { render: () => ["Pending credential wizard"] };
		h.ctx.editorContainer.addChild(prompt);
		h.ctx.ui.setFocus(prompt);
		h.open("settings");
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.status).toEqual([]);
		expect(h.overlayStack).toHaveLength(0);
		expect(h.ctx.editorContainer.children).toEqual([prompt]);
		expect(h.focused()).toBe(prompt);
		expect(h.controller.navigateMenuHistory(1)).toBe(true);
		expect(h.focused()).toBe(h.menus.get("settings")!);
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.focused()).toBe(prompt);
		expect(h.ctx.editorContainer.children).toEqual([prompt]);
	});

	it("ignores history silently while the composer completion popup is active", async () => {
		const h = harness();
		h.open("settings");
		h.closes.get("settings")!();
		await Promise.resolve();
		h.ctx.editor.isAutocompleteActive = () => true;
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.overlayStack).toHaveLength(0);
		expect(h.status).toEqual([]);
		h.ctx.editor.isAutocompleteActive = () => false;
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.overlayStack).toHaveLength(1);
	});

	it("keeps a focused custom view alive and names the view rather than a prompt", () => {
		const h = harness();
		h.open("settings");
		const view = new SettingsList(
			[],
			4,
			theme,
			() => {},
			() => {},
		);
		h.ctx.hookCustomComponents.add(view);
		h.showOverlay(view);
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.focused()).toBe(view);
		expect(h.overlayStack).toHaveLength(2);
		expect(h.status).toEqual(["Close this view first (Esc)"]);
	});

	it("keeps an unregistered blocking overlay mounted without changing history", () => {
		const h = harness();
		h.open("settings");
		const prompt = new SettingsList(
			[],
			4,
			theme,
			() => {},
			() => {},
		);
		h.showOverlay(prompt);
		expect(h.controller.navigateMenuHistory(-1)).toBe(true);
		expect(h.focused()).toBe(prompt);
		expect(h.overlayStack).toHaveLength(2);
		expect(h.status).toEqual(["Finish or cancel the prompt first"]);
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
