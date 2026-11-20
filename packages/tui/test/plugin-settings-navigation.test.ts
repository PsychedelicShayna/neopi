import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, expect, it, beforeEach, afterEach } from "bun:test";
import { initTheme } from "../src/theme/theme";
import {
	PluginListComponent,
	PluginSettingsComponent,
	type InstalledPlugin,
	type InstalledPluginSummary,
	type PluginSettingsHost,
} from "../src/overlays/plugin-settings";

beforeAll(async () => {
	await initTheme();
});

const plugin: InstalledPlugin = {
	name: "hjkl",
	version: "1",
	enabled: true,
	enabledFeatures: null,
	manifest: { settings: { token: { type: "string", secret: true } } },
};

function pluginHost(installed: InstalledPlugin[], marketplace: InstalledPluginSummary[] = []): PluginSettingsHost {
	return {
		manager: {
			list: async () => installed,
			getPlugin: async name => installed.find(plugin => plugin.name === name),
			getPluginSettings: async () => ({}),
			setEnabled: async () => {},
			getEnabledFeatures: async () => null,
			setEnabledFeatures: async () => {},
			setPluginSetting: async () => {},
		},
		createMarketplaceManager: async () => ({
			listInstalledPlugins: async () => marketplace,
			setPluginEnabled: async () => {},
		}),
		parsePluginId: id => ({ name: id.split("@")[0]! }),
	};
}

it("routes literal plugin search before configure shortcuts and restores it", () => {
	const opened: string[] = [];
	const make = () =>
		new PluginListComponent([{ kind: "npm", plugin }], {
			onNpmSelect: entry => {
				opened.push(entry.name);
			},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});
	const list = make();
	list.handleInput("/");
	list.handleInput("hjkl");
	expect(opened).toEqual([]);
	list.handleInput("\r");
	expect(opened).toEqual([]);
	expect(list.navigationSnapshot()).toMatchObject({ filter: "hjkl", filterFocused: false });
	const snapshot = list.navigationSnapshot();
	const restored = make();
	restored.restoreNavigation(snapshot);
	expect(restored.navigationSnapshot()).toEqual(snapshot);
	restored.handleInput("l");
	expect(opened).toEqual(["hjkl"]);
});

it("restores a pending plugin detail after the registry loads without a history visit", async () => {
	const listed = Promise.withResolvers<InstalledPlugin[]>();
	const mounted = Promise.withResolvers<void>();
	const host: PluginSettingsHost = {
		manager: {
			list: () => listed.promise,
			getPlugin: async () => plugin,
			getPluginSettings: async () => ({}),
			setEnabled: async () => {},
			getEnabledFeatures: async () => null,
			setEnabledFeatures: async () => {},
			setPluginSetting: async () => {},
		},
		createMarketplaceManager: async () => ({
			listInstalledPlugins: async () => [],
			setPluginEnabled: async () => {},
		}),
		parsePluginId: id => ({ name: id }),
	};
	const visits: string[] = [];
	let closed = false;
	const panel = new PluginSettingsComponent(host, {
		onClose: () => {
			closed = true;
		},
		onPluginChanged: () => {},
		requestRender: () => {
			mounted.resolve();
		},
	});
	panel.onNavigationVisit = page => {
		visits.push(page);
	};
	panel.restoreNavigation({ view: "npm-detail", plugin: "hjkl", content: undefined });
	listed.resolve([plugin]);
	await mounted.promise;
	expect(panel.navigationSnapshot()).toMatchObject({ view: "npm-detail", plugin: "hjkl" });
	expect(visits).toEqual([]);
	panel.handleInput("\x1b");
	expect(panel.navigationSnapshot()).toMatchObject({ view: "list" });
	expect(closed).toBe(false);
	panel.handleInput("\x1b");
	expect(closed).toBe(true);
});

it("clears a gg prefix when a horizontal or context action is consumed", () => {
	for (const consumed of ["h", "\t"]) {
		const list = new PluginListComponent(
			["alpha", "beta", "charlie"].map(name => ({ kind: "npm" as const, plugin: { ...plugin, name } })),
			{ onNpmSelect: () => {}, onMarketplaceSelect: () => {}, onCancel: () => {} },
		);
		list.handleInput("G");
		expect(list.prefsPage().focus).toBe("npm:charlie");
		list.handleInput("g");
		list.handleInput(consumed);
		list.handleInput("g");
		expect(list.prefsPage().focus).toBe("npm:charlie");
		list.handleInput("g");
		expect(list.prefsPage().focus).toBe("npm:alpha");
	}
});

for (const transaction of [
	"npm-enabled",
	"npm-feature",
	"npm-config",
	"marketplace-enabled",
	"marketplace-config",
] as const) {
	it(`blocks history through the complete ${transaction} write and onPluginChanged callback`, async () => {
		const configured: InstalledPlugin = {
			...plugin,
			manifest: {
				features: { sample: { default: false } },
				settings: { flag: { type: "boolean", default: false } },
			},
		};
		const marketplace: InstalledPluginSummary = {
			id: "hjkl@tests",
			scope: "user",
			entries: [{ installPath: "/plugins/hjkl", version: "1", installedAt: "", lastUpdated: "", enabled: true }],
		};
		const host = pluginHost([configured], [marketplace]);
		const write = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const changed = Promise.withResolvers<void>();
		const changedStarted = Promise.withResolvers<void>();
		const startWrite = () => {
			writeStarted.resolve();
			return write.promise;
		};
		host.manager.setEnabled = startWrite;
		host.manager.setEnabledFeatures = startWrite;
		host.manager.setPluginSetting = startWrite;
		host.createMarketplaceManager = async () => ({
			listInstalledPlugins: async () => [marketplace],
			setPluginEnabled: startWrite,
		});
		const pending: number[] = [];
		let repaint = Promise.withResolvers<void>();
		const panel = new PluginSettingsComponent(host, {
			onClose: () => {},
			onPluginChanged: () => {
				changedStarted.resolve();
				return changed.promise;
			},
			onPendingWrite: delta => {
				pending.push(delta);
			},
			requestRender: () => {
				repaint.resolve();
			},
		});
		expect(panel.blocksMenuHistory).toBe(false); // registry reads are not writes
		await repaint.promise;
		repaint = Promise.withResolvers<void>();
		panel.handlePrefsEvent({
			type: "activate",
			key: "",
			item: transaction.startsWith("npm") ? "npm:hjkl" : "mkt:user:hjkl@tests",
		});
		expect(panel.blocksMenuHistory).toBe(false); // detail configuration reads are not writes
		await repaint.promise;
		const item = transaction.endsWith("enabled")
			? "__enabled__"
			: transaction === "npm-feature"
				? "feature:sample"
				: "config:flag";
		panel.handlePrefsEvent({ type: "change", key: "", item, value: !transaction.endsWith("enabled") });
		expect(panel.blocksMenuHistory).toBe(true);
		expect(pending).toEqual([1]);
		await writeStarted.promise;
		write.resolve();
		await changedStarted.promise;
		expect(panel.blocksMenuHistory).toBe(true);
		expect(pending).toEqual([1]);
		repaint = Promise.withResolvers<void>();
		changed.resolve();
		await repaint.promise;
		expect(panel.blocksMenuHistory).toBe(false);
		expect(pending).toEqual([1, -1]);
	});
}

for (const kind of ["npm", "marketplace"] as const) {
	it(`retains the ${kind} detail's saved parent query when restoring through a fresh registry load`, async () => {
		const marketplace: InstalledPluginSummary = {
			id: "hjkl@tests",
			scope: "user",
			entries: [{ installPath: "/plugins/hjkl", version: "1", installedAt: "", lastUpdated: "" }],
		};
		const host = pluginHost([plugin], [marketplace]);
		let repaint = Promise.withResolvers<void>();
		const panel = new PluginSettingsComponent(host, {
			onClose: () => {},
			onPluginChanged: () => {},
			requestRender: () => {
				repaint.resolve();
			},
		});
		await repaint.promise;
		for (const key of ["/", "hj", "\r"]) panel.handleInput(key);
		repaint = Promise.withResolvers<void>();
		panel.handlePrefsEvent({ type: "activate", key: "", item: kind === "npm" ? "npm:hjkl" : "mkt:user:hjkl@tests" });
		await repaint.promise;
		const snapshot = panel.navigationSnapshot();
		const ready = Promise.withResolvers<void>();
		const parent = Promise.withResolvers<void>();
		let returning = false;
		const restored = new PluginSettingsComponent(host, {
			onClose: () => {},
			onPluginChanged: () => {},
			requestRender: () => {
				const page = restored.prefsPage();
				if (page.sections.some(section => section.rows.some(row => row.id === "config:token"))) ready.resolve();
				if (returning && page.sections.some(section => section.id === "installed")) parent.resolve();
			},
		});
		const visits: string[] = [];
		restored.onNavigationVisit = page => {
			visits.push(page);
		};
		restored.restoreNavigation(snapshot);
		await ready.promise;
		expect(restored.navigationSnapshot()).toEqual(snapshot);
		expect(visits).toEqual([]);
		returning = true;
		restored.handleInput("h");
		await parent.promise;
		expect(restored.prefsPage()).toMatchObject({ query: "hj", cursor: 2 });
		expect(visits).toEqual([""]);
	});
}

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
