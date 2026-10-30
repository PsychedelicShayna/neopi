import { beforeAll, describe, expect, it } from "bun:test";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { InstalledPlugin, PluginSettingsHost } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import type { SettingsDisplayEntry, SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { getCurrentThemeName, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { SelectListNavigationState } from "../src/components/select-list";
import { isMenuHistoryLeaver } from "../src/components/menu-navigation";

const ENTER = "\n";
const DOWN = "\x1b[B";

const ENTRIES: SettingsDisplayEntry[] = [
	{
		path: "theme.dark",
		type: "string",
		defaultValue: "dark",
		ui: { tab: "appearance", group: "Theme", label: "Dark theme", description: "Theme on dark", options: "runtime" },
	},
	{
		path: "display.colorBlind",
		type: "boolean",
		defaultValue: false,
		ui: { tab: "appearance", group: "Theme", label: "Color-blind mode", description: "Blue additions" },
	},
	{
		path: "display.risky",
		type: "boolean",
		defaultValue: false,
		ui: { tab: "appearance", group: "Status Line", label: "Risky", description: "d", warning: "Can get you flagged" },
	},
	{
		path: "compaction.thresholdPercent",
		type: "number",
		defaultValue: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Threshold",
			description: "When to compact",
			options: [
				{ value: "default", label: "Default" },
				{ value: "50", label: "50%" },
				{ value: "80", label: "80%" },
			],
		},
	},
	{ path: "shell.path", type: "string", defaultValue: "", ui: { tab: "shell", label: "Shell path", description: "" } },
	{
		path: "providers.order",
		type: "array",
		defaultValue: ["a", "b"],
		ui: {
			tab: "providers",
			label: "Order",
			description: "",
			ordered: true,
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
			],
		},
	},
	{
		path: "providers.tokens",
		type: "array",
		defaultValue: [],
		credential: true,
		ui: { tab: "providers", label: "Tokens", description: "", editor: "json" },
	},
];

const PLUGIN: InstalledPlugin = {
	name: "hjkl",
	version: "1",
	enabled: true,
	enabledFeatures: null,
	manifest: {
		settings: {
			message: { type: "string", default: "" },
			mode: {
				type: "enum",
				values: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"],
				default: "alpha",
			},
		},
	},
};

interface Harness {
	selector: SettingsSelectorComponent;
	values: Map<string, unknown>;
	changes: [string, unknown][];
	previews: string[];
	whenRendered: (ready: (props: TspPrefsProps) => boolean) => Promise<void>;
}

interface HarnessOptions {
	entries?: readonly SettingsDisplayEntry[];
	plugins?: PluginSettingsHost;
	providers?: string[];
	onPluginsChanged?: () => void | Promise<void>;
	onCancel?: () => void;
	requestRender?: () => void;
	onOpenConfigFile?: () => Promise<void>;
	onApply?: (scope: "global" | "project" | "session") => Promise<string>;
}

function pluginHost(installed: InstalledPlugin[] = []): PluginSettingsHost {
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
			listInstalledPlugins: async () => [],
			setPluginEnabled: async () => {},
		}),
		parsePluginId: id => ({ name: id }),
	};
}

function providerLimits(value: unknown): Record<string, number> {
	const limits: Record<string, number> = {};
	if (typeof value === "object" && value !== null) {
		for (const [provider, limit] of Object.entries(value)) {
			if (typeof limit === "number") limits[provider] = limit;
		}
	}
	return limits;
}

function harness(initial: Record<string, unknown> = {}, options: HarnessOptions = {}): Harness {
	const entries = options.entries ?? ENTRIES;
	const values = new Map<string, unknown>();
	for (const entry of entries) values.set(entry.path, entry.defaultValue);
	for (const key in initial) values.set(key, initial[key]);
	const settings: SettingsHost = {
		entries,
		get: path => values.get(path),
		set: (path, value) => void values.set(path, value),
		unset: path => void values.set(path, entries.find(entry => entry.path === path)?.defaultValue),
		normalizeProviderLimits: providerLimits,
		validateProviderLimits: providerLimits,
	};
	const changes: [string, unknown][] = [];
	const previews: string[] = [];
	let rendered = () => {};
	const selector = new SettingsSelectorComponent(
		{
			settings,
			plugins: options.plugins ?? pluginHost(),
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark", "light", "titanium"],
			providers: options.providers ?? [],
			requestRender: () => {
				rendered();
				options.requestRender?.();
			},
		},
		{
			onChange: (path, value) => changes.push([path, value]),
			onThemePreview: name => void previews.push(name),
			onPluginsChanged: options.onPluginsChanged,
			onCancel: options.onCancel ?? (() => {}),
			onOpenConfigFile: options.onOpenConfigFile,
			onApply: options.onApply,
		},
	);
	return {
		selector,
		values,
		changes,
		previews,
		whenRendered: ready => {
			const pending = Promise.withResolvers<void>();
			rendered = () => {
				if (ready(prefs(selector).props)) pending.resolve();
			};
			rendered();
			return pending.promise;
		},
	};
}

const PREFS: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function prefs(selector: SettingsSelectorComponent): { node: NativeNode; props: TspPrefsProps } {
	const described = selector.describe(PREFS);
	if (described.k !== "prefs" || !described.p) throw new Error(`described ${described.k}, not prefs`);
	return { node: described, props: described.p };
}

function row(props: TspPrefsProps, id: string) {
	for (const section of props.sections) for (const r of section.rows) if (r.id === id) return r;
	throw new Error(`no row ${id}`);
}

function send(selector: SettingsSelectorComponent, event: NativeUiEvent): void {
	selector.handleNativeEvent(event);
}

describe("settings as a native prefs page", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	it("falls back to the overlay card when the terminal lacks prefs", () => {
		const { selector } = harness();
		const card = selector.describe({ ...PREFS, supports: kind => kind !== "prefs" });
		expect(card.k).toBe("card");
	});

	it("docks beside the transcript only where the terminal advertises aside", () => {
		const { selector } = harness();
		expect(selector.nativeSheet(PREFS)).toBe(true);
		expect(selector.nativeSheet({ ...PREFS, feature: name => name !== "aside" })).toBe(false);
		expect(selector.nativeSheet({ ...PREFS, supports: kind => kind !== "prefs" })).toBe(false);
	});

	it("draws tabs as pages with changed counts, groups as sections and settings as typed controls", () => {
		const { selector } = harness({ "display.colorBlind": true, "compaction.thresholdPercent": 80 });
		const { props } = prefs(selector);
		expect(props.page).toBe("appearance");
		expect(props.lead).toBeTruthy();
		expect(props.pages.find(p => p.id === "appearance")?.changed).toBe(1);
		expect(props.pages.find(p => p.id === "context")?.changed).toBe(1);
		expect(props.pages.find(p => p.id === "shell")?.changed).toBeUndefined();
		expect(props.pages.at(-1)).toMatchObject({ id: "plugins", group: "Plugins" });
		expect(props.sections.map(s => s.id)).toEqual(["theme", "status-line"]);

		expect(row(props, "theme.dark").control).toMatchObject({ k: "choice", value: "dark", style: "menu", mono: true });
		expect(row(props, "display.colorBlind")).toMatchObject({
			changed: true,
			defaultLabel: "Off",
			control: { k: "switch", on: true },
		});
		expect(row(props, "display.risky").warning).toBe("Can get you flagged");
		expect(props.focus).toBe("theme.dark");
	});

	it("puts the status-line preview after its section on Appearance only", () => {
		const { selector } = harness();
		const roles = (n: NativeNode) => (n.c ?? []).map(c => ("k" in c && c.p && "role" in c.p ? c.p.role : undefined));
		expect(roles(prefs(selector).node)).toContain("omp.prefs.preview.status");
		send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
		const shell = prefs(selector);
		expect(shell.props.page).toBe("shell");
		expect(roles(shell.node)).not.toContain("omp.prefs.preview.status");
	});

	it("maps number-like choices to a stepper and sets the chosen step like the submenu", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "context", mods: [] });
		expect(row(prefs(selector).props, "compaction.thresholdPercent").control).toEqual({
			k: "number",
			value: -1,
			labels: { "-1": "Default", "50": "50%", "80": "80%" },
		});
		send(selector, { type: "change", key: "", item: "compaction.thresholdPercent", value: 50 });
		expect(values.get("compaction.thresholdPercent")).toBe(50);
		expect(changes.at(-1)).toEqual(["compaction.thresholdPercent", "50"]);
		send(selector, { type: "change", key: "", item: "compaction.thresholdPercent", value: -1 });
		expect(values.get("compaction.thresholdPercent")).toBe(-1);
		// The submenu closed after the pick, as Enter closes it.
		expect(prefs(selector).props.editing).toBeNull();
	});

	it("flips a switch through the list's change path and resets to the default with null", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "change", key: "", item: "display.colorBlind", value: true });
		expect(values.get("display.colorBlind")).toBe(true);
		expect(changes).toEqual([["display.colorBlind", true]]);
		expect(row(prefs(selector).props, "display.colorBlind").changed).toBe(true);

		send(selector, { type: "change", key: "", item: "display.colorBlind", value: null });
		expect(values.get("display.colorBlind")).toBe(false);
		expect(row(prefs(selector).props, "display.colorBlind").changed).toBeUndefined();
	});

	it("opens a choice menu, previews on hover, and reverts the preview when the menu closes", () => {
		const { selector, values, previews } = harness();
		send(selector, { type: "activate", key: "", item: "theme.dark" });
		expect(prefs(selector).props.editing).toEqual({ row: "theme.dark", option: "dark" });

		send(selector, { type: "select", key: "", item: "theme.dark=titanium" });
		expect(previews).toEqual(["titanium"]);
		expect(prefs(selector).props.editing).toEqual({ row: "theme.dark", option: "titanium" });

		send(selector, { type: "action", key: "", act: "close", value: "theme.dark", mods: [] });
		expect(prefs(selector).props.editing).toBeNull();
		expect(previews.length).toBe(2);
		expect(values.get("theme.dark")).toBe("dark");
	});

	it.each(["leave", "restore"] as const)(
		"settles theme previews before history %s without saving or new visits",
		mode => {
			const { selector, values, changes, previews } = harness();
			const parent = selector.navigationSnapshot();
			const activeTheme = getCurrentThemeName() ?? "dark";
			send(selector, { type: "activate", key: "", item: "theme.dark" });
			send(selector, { type: "select", key: "", item: "theme.dark=titanium" });
			const nested = selector.navigationSnapshot();
			const visits: string[] = [];
			selector.onNavigationVisit = page => visits.push(page);
			expect(previews).toEqual(["titanium"]);

			if (mode === "leave") {
				expect(isMenuHistoryLeaver(selector)).toBe(true);
				if (isMenuHistoryLeaver(selector)) selector.leaveMenu();
			} else selector.restoreNavigation(parent);
			expect(previews.at(-1)).toBe(activeTheme);
			expect(values.get("theme.dark")).toBe("dark");
			expect(changes).toEqual([]);
			expect(visits).toEqual([]);

			const reopened = harness().selector;
			reopened.restoreNavigation(nested);
			expect(prefs(reopened).props.editing).toEqual({ row: "theme.dark", option: "titanium" });
		},
	);

	it("picks a menu option like Enter in the submenu", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "change", key: "", item: "theme.dark", value: "light" });
		expect(values.get("theme.dark")).toBe("light");
		expect(changes.at(-1)).toEqual(["theme.dark", "light"]);
		expect(row(prefs(selector).props, "theme.dark").control).toMatchObject({ value: "light" });
	});

	it.each(["compaction.thresholdTokens", "roleSettings.slow.compaction.thresholdTokens"])(
		"accepts arbitrary numeric budgets and retains presets and cancellation for %s",
		path => {
			const entry: SettingsDisplayEntry = {
				path,
				type: "number",
				defaultValue: -1,
				ui: {
					tab: "context",
					label: "Token budget",
					description: "Fixed token budget",
					customInput: true,
					options: [
						{ value: "default", label: "Default" },
						{ value: "100000", label: "100K" },
					],
				},
			};
			const { selector, values } = harness({}, { entries: [entry] });
			send(selector, { type: "action", key: "", act: "page", value: "context", mods: [] });
			send(selector, { type: "change", key: "", item: path, value: "__custom_number__" });
			for (const ch of "120000") selector.handleInput(ch);
			selector.handleInput(ENTER);
			expect(values.get(path)).toBe(120000);
			send(selector, { type: "change", key: "", item: path, value: "100000" });
			expect(values.get(path)).toBe(100000);
			send(selector, { type: "change", key: "", item: path, value: "__custom_number__" });
			selector.handleInput("\x1b");
			expect(values.get(path)).toBe(100000);
			send(selector, { type: "change", key: "", item: path, value: "default" });
			expect(values.get(path)).toBe(-1);
			expect(row(prefs(selector).props, path).control).toMatchObject({ value: "default" });
		},
	);

	it("shows the text editor's draft and cursor while the keys edit it, and submits a pointer change", () => {
		const { selector, values } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
		send(selector, { type: "activate", key: "", item: "shell.path" });
		for (const ch of "/bin/zsh") selector.handleInput(ch);
		expect(prefs(selector).props.editing).toEqual({ row: "shell.path", draft: "/bin/zsh", cursor: 8 });
		selector.handleInput(ENTER);
		expect(values.get("shell.path")).toBe("/bin/zsh");

		send(selector, { type: "change", key: "", item: "shell.path", value: "/bin/fish" });
		expect(values.get("shell.path")).toBe("/bin/fish");
		expect(prefs(selector).props.editing).toBeNull();
	});

	it("masks credential arrays in rows and drafts without saving mask glyphs", () => {
		const { selector, values } = harness({ "providers.tokens": ["private-token"] });
		send(selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		const control = row(prefs(selector).props, "providers.tokens").control;
		expect(JSON.stringify(control)).not.toContain("private-token");
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("private-token");

		send(selector, { type: "activate", key: "", item: "providers.tokens" });
		expect(prefs(selector).props.editing?.draft).toMatch(/^•+$/);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("private-token");
		selector.handleInput("\x01");
		selector.handleInput("\x0b");
		for (const character of '["replacement-token"]') selector.handleInput(character);
		expect(prefs(selector).props.editing?.draft).toMatch(/^•+$/);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("replacement-token");
		selector.handleInput(ENTER);
		expect(values.get("providers.tokens")).toEqual(["replacement-token"]);
	});

	it("applies a reordered multiselect as the submenu would", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		expect(row(prefs(selector).props, "providers.order").control).toMatchObject({
			k: "multi",
			values: ["a", "b"],
			ordered: true,
		});
		send(selector, { type: "change", key: "", item: "providers.order", value: ["c", "a"] });
		expect(values.get("providers.order")).toEqual(["c", "a"]);
		expect(changes.at(-1)).toEqual(["providers.order", ["c", "a"]]);
		expect(row(prefs(selector).props, "providers.order")).toMatchObject({
			changed: true,
			control: { values: ["c", "a"] },
		});
	});

	it("refreshes the chip row and its tab badge when a chip is toggled while the submenu is open", () => {
		const { selector, values } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		send(selector, { type: "activate", key: "", item: "providers.order" });
		expect(prefs(selector).props.editing?.row).toBe("providers.order");

		send(selector, { type: "change", key: "", item: "providers.order", value: ["a", "c"] });
		expect(values.get("providers.order")).toEqual(["a", "c"]);
		const after = prefs(selector).props;
		expect(row(after, "providers.order")).toMatchObject({
			changed: true,
			control: { values: ["a", "c"] },
		});
		expect(after.pages.find(p => p.id === "providers")?.changed).toBe(1);
		// The user keeps working in the submenu the toggle came from.
		expect(after.editing?.row).toBe("providers.order");
		// The submenu itself took the new order, so the refresh did not come
		// from silently dropping the toggle and letting the row catch up.
		const openRows = selector
			.render(100)
			.map(line => Bun.stripANSI(line))
			.filter(line => /[0-9]\. [AC]|·  B/.test(line));
		expect(openRows.length).toBe(3);
		expect(openRows.some(line => line.includes("1. A"))).toBe(true);
		expect(openRows.some(line => line.includes("2. C"))).toBe(true);
		expect(openRows.some(line => line.includes("·  B"))).toBe(true);
	});

	it("searches across pages, grouping results by page and section, and a page click leaves the search", () => {
		const { selector } = harness();
		selector.handleInput("/");
		selector.handleInput("t");
		selector.handleInput("h");
		selector.handleInput(ENTER);
		const { props } = prefs(selector);
		expect(props.query).toBe("th");
		expect(props.sections.every(s => s.page !== undefined)).toBe(true);
		expect(props.sections.some(s => s.id === "appearance/theme")).toBe(true);

		send(selector, { type: "action", key: "", act: "page", value: "context", mods: [] });
		const after = prefs(selector).props;
		expect(after.query).toBeUndefined();
		expect(after.page).toBe("context");
	});

	it("keyboard focus follows the list selection", () => {
		const { selector } = harness();
		selector.handleInput(DOWN);
		expect(prefs(selector).props.focus).toBe("display.colorBlind");
		send(selector, { type: "select", key: "", item: "display.risky" });
		expect(prefs(selector).props.focus).toBe("display.risky");
	});

	it("navigates normal-mode rows and sections, toggles with Space, and searches only with slash", () => {
		const { selector, values } = harness();
		selector.handleInput("j");
		expect(prefs(selector).props.focus).toBe("display.colorBlind");
		selector.handleInput(" ");
		expect(values.get("display.colorBlind")).toBe(true);
		selector.handleInput("k");
		expect(prefs(selector).props.focus).toBe("theme.dark");
		const originalPage = prefs(selector).props.page;
		selector.handleInput("l");
		expect(prefs(selector).props.page).not.toBe(originalPage);
		selector.handleInput("h");
		expect(prefs(selector).props.page).toBe(originalPage);
		selector.handleInput("i");
		for (const key of "typing") selector.handleInput(key);
		expect(prefs(selector).props.query).toBeUndefined();
		selector.handleInput("/");
		selector.handleInput("color");
		expect(prefs(selector).props.query).toBe("color");
		selector.handleInput(ENTER);
		expect(prefs(selector).props.focus).toBe("display.colorBlind");
	});

	it("reserves Ctrl+A for search text and F6 for Apply outside input", () => {
		const scopes: string[] = [];
		const { selector } = harness({}, {
			onApply: async scope => {
				scopes.push(scope);
				return "Applied";
			},
		});
		for (const key of ["/", "theme", "\x01", "x", "\x1b[17~"]) selector.handleInput(key);
		expect(prefs(selector).props).toMatchObject({ query: "xtheme", cursor: 1 });
		expect(scopes).toEqual([]);
		selector.handleInput(ENTER);
		selector.handleInput("\x1b[17~");
		expect(scopes).toEqual(["global"]);
	});

	it("keeps plugin search text and Apply separate", async () => {
		const scopes: string[] = [];
		const h = harness({}, {
			plugins: pluginHost([PLUGIN]),
			onApply: async scope => {
				scopes.push(scope);
				return "Applied";
			},
		});
		send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
		await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
		for (const key of ["/", "hj", "\x01", "x", "\x1b[17~"]) h.selector.handleInput(key);
		expect(prefs(h.selector).props).toMatchObject({ query: "xhj", cursor: 1 });
		expect(scopes).toEqual([]);
		h.selector.handleInput(ENTER);
		h.selector.handleInput("\x1b[17~");
		expect(scopes).toEqual(["global"]);
	});

	it("keeps global-search text literal and restores its focus and selection", () => {
		const { selector } = harness();
		selector.handleInput("j");
		expect(prefs(selector).props.query).toBeUndefined();
		selector.handleInput("/");
		selector.handleInput("theme");
		selector.handleInput(ENTER);
		expect(prefs(selector).props.query).toBe("theme");
		const snapshot = selector.navigationSnapshot();
		const restored = harness().selector;
		restored.restoreNavigation(snapshot);
		expect(prefs(restored).props.query).toBe("theme");
		expect(prefs(restored).props.focus).toBe(prefs(selector).props.focus);
		expect(restored.navigationSnapshot()).toEqual(snapshot);
		restored.handleInput("/");
		restored.handleInput(" hjkl");
		expect(prefs(restored).props.query).toBe("theme hjkl");
	});

	it("keeps regex drafts modal and applies them only after Enter", () => {
		const { selector, changes } = harness();
		selector.handleInput("/");
		const initial = prefs(selector).props;
		const rows = initial.sections.flatMap(section => section.rows.map(row => row.id));
		expect(rows.length).toBeGreaterThan(1);
		for (const key of ".{1000}") selector.handleInput(key);
		for (const key of ["\x1b[D", "\t", DOWN, "\x1b[A", "\x0e", "\x10"]) selector.handleInput(key);
		const drafting = prefs(selector).props;
		expect(drafting.page).toBe(initial.page);
		expect(drafting.focus).toBe(initial.focus);
		expect(drafting.query).toBe(".{1000}");
		expect(drafting.cursor).toBe(6);
		expect(drafting.sections.flatMap(section => section.rows.map(row => row.id))).toEqual(rows);
		expect(selector.navigationSnapshot()).toMatchObject({
			search: { value: ".{1000}", query: "", focused: true, cursor: 6 },
		});
		expect(changes).toEqual([]);
		selector.handleInput(ENTER);
		expect(prefs(selector).props.sections.flatMap(section => section.rows)).toEqual([]);
		expect(selector.navigationSnapshot()).toMatchObject({
			search: { value: ".{1000}", query: ".{1000}", focused: false },
		});
		selector.handleInput("\x1b");
		expect(prefs(selector).props.query).toBeUndefined();
		expect(prefs(selector).props.page).toBe("appearance");
		selector.handleInput("/");
		for (const key of "/^dark/") selector.handleInput(key);
		expect(prefs(selector).props.sections.flatMap(section => section.rows).length).toBeGreaterThan(1);
		selector.handleInput(ENTER);
		expect(prefs(selector).props.sections.flatMap(section => section.rows.map(row => row.id))).toEqual(["theme.dark"]);
		selector.handleInput("\x1b");
		expect(prefs(selector).props.query).toBeUndefined();
		expect(row(prefs(selector).props, "display.colorBlind")).toBeDefined();
	});

	for (const sectionFocused of [false, true]) {
		for (const { name, keys } of [
			{ name: "an empty pattern", keys: ["/", "\x1b"] },
			{ name: "a dotted draft", keys: ["/", ".", ".", ".", "\x1b"] },
			{ name: "a confirmed pattern", keys: ["/", "c", "o", "l", "o", "r", ENTER, "\x1b"] },
		]) {
			it(`restores the original tab, ${sectionFocused ? "section sidebar" : "setting selection"}, and tab cycling after Esc clears ${name}`, () => {
				let closed = 0;
				const { selector, changes } = harness(
					{},
					{
						entries: [
							...ENTRIES,
							{
								path: "compaction.enabled",
								type: "boolean",
								defaultValue: true,
								ui: { tab: "context", group: "Compaction", label: "Automatic compaction", description: "" },
							},
							{
								path: "context.keepRecent",
								type: "boolean",
								defaultValue: true,
								ui: { tab: "context", group: "Retention", label: "Keep recent messages", description: "" },
							},
						],
						onCancel: () => {
							closed++;
						},
					},
				);
				for (const key of ["l", "l", "l", "j"]) selector.handleInput(key);
				expect(prefs(selector).props.page).toBe("context");
				expect(prefs(selector).props.focus).toBe("compaction.enabled");
				if (sectionFocused) {
					selector.handleInput("\t");
					selector.handleInput("j");
					expect(prefs(selector).props.focus).toBe("retention");
				}
				const before = prefs(selector).props;
				const beforeRender = selector.render(180).map(line => Bun.stripANSI(line));
				expect(before.sections.map(section => section.id)).toEqual(["compaction", "retention"]);
				expect(beforeRender.some(line => /Compaction\s+│/.test(line))).toBe(true);

				for (const key of keys) selector.handleInput(key);
				const after = prefs(selector).props;
				const afterRender = selector.render(180).map(line => Bun.stripANSI(line));
				expect(closed).toBe(0);
				expect(changes).toEqual([]);
				expect(after.query).toBeUndefined();
				expect(after.page).toBe("context");
				expect(after.sections).toEqual(before.sections);
				expect(after.sections.every(section => section.page === undefined)).toBe(true);
				expect(afterRender.join("\n")).not.toMatch(/\d+ match/);

				selector.handleInput("l");
				expect(prefs(selector).props.page).toBe("memory");
				selector.handleInput("h");
				expect(prefs(selector).props.page).toBe("context");
				expect(prefs(selector).props.sections).toEqual(before.sections);

				expect(after.focus).toBe(before.focus);
				expect(afterRender).toEqual(beforeRender);
			});
		}
	}

	it("restores headings live when a search draft is deleted, and Escape leaves only the composer", () => {
		let closed = 0;
		const { selector, changes } = harness({}, {
			onCancel: () => {
				closed++;
			},
		});
		const before = prefs(selector).props;
		const beforeRows = selector.render(180).map(line => Bun.stripANSI(line));
		for (const key of ["/", "color", ENTER, "/", "\x01", "\x0b"]) selector.handleInput(key);
		const cleared = prefs(selector).props;
		expect(cleared.sections).toEqual(before.sections);
		expect(cleared.sections.every(section => section.page === undefined)).toBe(true);
		expect(cleared.focus).toBe(before.focus);
		expect(selector.render(180).some(line => Bun.stripANSI(line).includes("Theme"))).toBe(true);
		expect(selector.navigationSnapshot()).toMatchObject({ searchFocused: true });
		selector.handleInput("\x1b");
		expect(closed).toBe(0);
		expect(prefs(selector).props.query).toBeUndefined();
		expect(selector.render(180).map(line => Bun.stripANSI(line))).toEqual(beforeRows);
		expect(changes).toEqual([]);
		selector.handleInput("\x1b");
		expect(closed).toBe(1);
	});

	it("keeps headings while composing an empty pattern and Enter returns to the normal list", () => {
		const { selector, changes } = harness();
		const before = prefs(selector).props;
		selector.handleInput("/");
		expect(prefs(selector).props.sections).toEqual(before.sections);
		selector.handleInput(ENTER);
		expect(prefs(selector).props.query).toBeUndefined();
		expect(prefs(selector).props.sections).toEqual(before.sections);
		expect(selector.navigationSnapshot()).toMatchObject({ searching: false, searchFocused: false });
		expect(changes).toEqual([]);
	});

	it("confirms a focused search pattern with Enter without activating the matched setting", () => {
		const { selector, changes, values } = harness();
		selector.handleInput("/");
		const initialRows = prefs(selector).props.sections.flatMap(section => section.rows.map(row => row.id));
		for (const key of "/^color/") selector.handleInput(key);
		expect(prefs(selector).props.query).toBe("/^color/");
		expect(prefs(selector).props.sections.flatMap(section => section.rows.map(row => row.id))).toEqual(initialRows);
		expect(Bun.stripANSI(selector.render(180).at(-2) ?? "")).toContain("confirm search");

		selector.handleInput(ENTER);
		const confirmed = prefs(selector).props;
		expect(confirmed.query).toBe("/^color/");
		expect(confirmed.sections.flatMap(section => section.rows.map(row => row.id))).toEqual(["display.colorBlind"]);
		expect(confirmed.focus).toBe("display.colorBlind");
		expect(confirmed.editing).toBeNull();
		expect(values.get("display.colorBlind")).toBe(false);
		expect(changes).toEqual([]);
		expect(Bun.stripANSI(selector.render(180).at(-2) ?? "")).not.toContain("confirm search");

		selector.handleInput(ENTER);
		expect(values.get("display.colorBlind")).toBe(true);
		expect(changes).toEqual([["display.colorBlind", true]]);
	});

	it("shows Vim half-page, page, and boundary motions in the bottom footer after confirming search", () => {
		const { selector } = harness();
		for (const key of ["/", "e", ENTER]) selector.handleInput(key);
		expect(prefs(selector).props.sections.flatMap(section => section.rows).length).toBeGreaterThan(1);
		const footer = Bun.stripANSI(selector.render(240).at(-2) ?? "");
		expect(footer).not.toContain("confirm search");
		expect(footer).toContain("j/k");
		expect(footer).toMatch(/Ctrl-(?:u\/d|d\/u) half/);
		expect(footer).toContain("PgUp/PgDn page");
		expect(footer).toContain("gg/G");
	});

	it("discards an unconfirmed global-search draft on leave and restores confirmed results", () => {
		const { selector } = harness();
		selector.handleInput("/");
		selector.handleInput("theme");
		selector.handleInput(ENTER);
		const confirmed = prefs(selector).props.sections;
		selector.handleInput("/");
		selector.handleInput(" draft");
		expect(prefs(selector).props.query).toBe("theme draft");
		expect(prefs(selector).props.sections).toEqual(confirmed);
		selector.leaveMenu();
		expect(prefs(selector).props.query).toBe("theme");
		expect(prefs(selector).props.sections).toEqual(confirmed);
		expect(selector.navigationSnapshot()).toMatchObject({
			search: { value: "theme", query: "theme", focused: false },
		});
		const restored = harness().selector;
		restored.restoreNavigation(selector.navigationSnapshot());
		expect(prefs(restored).props.sections).toEqual(confirmed);
	});

	it("reports nested settings pages and restores them without a fresh visit", () => {
		const { selector } = harness();
		const visits: string[] = [];
		selector.onNavigationVisit = page => {
			visits.push(page);
		};
		send(selector, { type: "action", key: "", act: "page", value: "context", mods: [] });
		send(selector, { type: "action", key: "", act: "edit", value: "compaction.thresholdPercent", mods: [] });
		const snapshot = selector.navigationSnapshot();
		expect(visits.some(page => page.includes("compaction.thresholdPercent"))).toBe(true);
		const count = visits.length;
		selector.restoreNavigation(snapshot);
		expect(visits).toHaveLength(count);
		expect(selector.navigationSnapshot()).toEqual(snapshot);
	});

	it("treats root plugin h/l and Tab as contexts without history visits", async () => {
		const h = harness({}, { plugins: pluginHost([PLUGIN]) });
		const visits: string[] = [];
		h.selector.onNavigationVisit = page => {
			visits.push(page);
		};
		const pages = prefs(h.selector).props.pages;
		for (const [key, page] of [
			["l", pages[0]!.id],
			["h", pages.at(-2)!.id],
			["\t", pages[0]!.id],
		] as const) {
			send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
			await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
			h.selector.handleInput(key);
			expect(prefs(h.selector).props.page).toBe(page);
			expect(visits).toEqual([]);
		}
	});

	it("mirrors filtered plugin rows, retained query and caret, and closes the filter before the page", async () => {
		let closed = 0;
		const h = harness(
			{},
			{
				plugins: pluginHost([PLUGIN, { ...PLUGIN, name: "alpha" }]),
				onCancel: () => {
					closed++;
				},
			},
		);
		send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
		await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
		for (const key of ["/", "h", "j", "\x01", "\x1b[C"]) h.selector.handleInput(key);
		expect(prefs(h.selector).props.sections.flatMap(section => section.rows)).toHaveLength(2);
		h.selector.handleInput(ENTER);
		expect(prefs(h.selector).props).toMatchObject({
			query: "hj",
			cursor: 1,
			focus: "npm:hjkl",
			sections: [{ rows: [{ id: "npm:hjkl" }] }],
		});
		send(h.selector, { type: "action", key: "", act: "close", mods: [] });
		expect(closed).toBe(0);
		expect(h.selector.navigationSnapshot()).toMatchObject({
			plugin: { content: { filter: "", filterFocused: false, filterCursor: 0 } },
		});
		expect(prefs(h.selector).props.query).toBeUndefined();
		send(h.selector, { type: "action", key: "", act: "close", mods: [] });
		expect(closed).toBe(1);
	});

	it("restores a filtered plugin detail after async loading without a new visit", async () => {
		const plugins = pluginHost([PLUGIN]);
		const h = harness({}, { plugins });
		send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
		await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
		for (const key of ["/", "hj", ENTER]) h.selector.handleInput(key);
		send(h.selector, { type: "activate", key: "", item: "npm:hjkl" });
		await h.whenRendered(props =>
			props.sections.some(section => section.rows.some(row => row.id === "config:message")),
		);
		for (const key of ["/", "message", "\x01", "\x1b[C", "\x1b[C", ENTER]) h.selector.handleInput(key);
		expect(prefs(h.selector).props).toMatchObject({
			query: "message",
			cursor: 2,
			focus: "config:message",
			sections: [{ rows: [{ id: "config:message" }] }],
		});
		const snapshot = h.selector.navigationSnapshot();
		const restored = harness({}, { plugins });
		const visits: string[] = [];
		restored.selector.onNavigationVisit = page => {
			visits.push(page);
		};
		restored.selector.restoreNavigation(snapshot);
		await restored.whenRendered(props =>
			props.sections.some(section => section.rows.some(row => row.id === "config:message")),
		);
		expect(prefs(restored.selector).props).toMatchObject({ query: "message", cursor: 2, focus: "config:message" });
		expect(restored.selector.navigationSnapshot()).toEqual(snapshot);
		expect(visits).toEqual([]);
		restored.selector.handleInput("h");
		await restored.whenRendered(props => props.sections.some(section => section.id === "installed"));
		expect(prefs(restored.selector).props).toMatchObject({ query: "hj", cursor: 2 });
		expect(visits).toEqual([""]);
	});

	it("exits text fields and native enum menus with printable cancel and submit remaps", () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "j",
				"tui.input.submit": ["s", "enter"],
				"tui.editor.deleteCharBackward": "k",
			}),
		);
		try {
			let closed = 0;
			const h = harness(
				{},
				{
					onCancel: () => {
						closed++;
					},
				},
			);
			send(h.selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
			send(h.selector, { type: "activate", key: "", item: "shell.path" });
			const literal = "j/k h l gg G / note s";
			for (const char of literal) h.selector.handleInput(char);
			expect(prefs(h.selector).props.editing?.draft).toBe(literal);
			send(h.selector, { type: "action", key: "", act: "close", mods: [] });
			expect(prefs(h.selector).props.editing).toBeNull();
			expect(h.values.get("shell.path")).toBe("");
			expect(closed).toBe(0);
			send(h.selector, { type: "action", key: "", act: "page", value: "appearance", mods: [] });
			send(h.selector, { type: "activate", key: "", item: "theme.dark" });
			expect(prefs(h.selector).props.editing?.row).toBe("theme.dark");
			send(h.selector, { type: "action", key: "", act: "close", value: "theme.dark", mods: [] });
			expect(prefs(h.selector).props.editing).toBeNull();
			expect(closed).toBe(0);
			send(h.selector, { type: "action", key: "", act: "close", mods: [] });
			expect(closed).toBe(1);
		} finally {
			setKeybindings(previous);
		}
	});

	it("closes a literal plugin field and then its enum filter/menu before the root", async () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "j",
				"tui.input.submit": ["s", "enter"],
				"tui.editor.deleteCharBackward": "k",
			}),
		);
		try {
			let closed = 0;
			const h = harness(
				{},
				{
					plugins: pluginHost([PLUGIN]),
					onCancel: () => {
						closed++;
					},
				},
			);
			send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
			await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
			send(h.selector, { type: "activate", key: "", item: "npm:hjkl" });
			await h.whenRendered(props =>
				props.sections.some(section => section.rows.some(row => row.id === "config:message")),
			);
			send(h.selector, { type: "action", key: "", act: "edit", value: "config:message", mods: [] });
			for (const char of "j/k h l gg G / note s") h.selector.handleInput(char);
			expect(h.selector.navigationSnapshot()).toMatchObject({
				plugin: { content: { submenuId: "config:message", submenu: { value: "j/k h l gg G / note s" } } },
			});
			send(h.selector, { type: "action", key: "", act: "close", mods: [] });
			expect(h.selector.navigationSnapshot()).toMatchObject({ plugin: { content: { submenuId: null } } });
			expect(closed).toBe(0);
			send(h.selector, { type: "action", key: "", act: "edit", value: "config:mode", mods: [] });
			for (const key of ["/", "b", "e"]) h.selector.handleInput(key);
			send(h.selector, { type: "action", key: "", act: "close", mods: [] });
			expect(h.selector.navigationSnapshot()).toMatchObject({
				plugin: { content: { submenuId: "config:mode", submenu: { filter: "", filterFocused: false } } },
			});
			send(h.selector, { type: "action", key: "", act: "close", value: "config:mode", mods: [] });
			expect(h.selector.navigationSnapshot()).toMatchObject({ plugin: { content: { submenuId: null } } });
			expect(closed).toBe(0);
			send(h.selector, { type: "action", key: "", act: "close", mods: [] });
			expect(closed).toBe(1);
		} finally {
			setKeybindings(previous);
		}
	});

	it("preserves multiselect cursor, query, caret and detached viewport through rebuild and restore", () => {
		const ids = Array.from({ length: 20 }, (_, index) => `v${String(index).padStart(2, "0")}`);
		const order: SettingsDisplayEntry = {
			path: "providers.order",
			type: "array",
			defaultValue: ids,
			ui: {
				tab: "providers",
				label: "Order",
				description: "",
				ordered: true,
				options: ids.map(value => ({ value, label: `Option ${value}` })),
			},
		};
		const entries = ENTRIES.map(entry => (entry.path === order.path ? order : entry));
		const h = harness({}, { entries });
		send(h.selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		send(h.selector, { type: "activate", key: "", item: order.path });
		for (const key of ["/", "option", "\x01", "\x1b[C", "\x1b[C", ENTER, "G"]) h.selector.handleInput(key);
		h.selector.render(120);
		h.selector.handleInput("\x19");
		h.selector.render(120);
		const before = h.selector.navigationSnapshot() as { list: { submenu: { list: SelectListNavigationState } } };
		expect(before.list.submenu.list).toMatchObject({
			selectedValue: "v19",
			filter: "option",
			filterCursor: 2,
			filterFocused: false,
			viewportTop: { item: 7, lineOffset: 0 },
		});
		for (const key of [" ", " ", "h"]) {
			h.selector.handleInput(key);
			expect(h.selector.navigationSnapshot()).toMatchObject({
				list: { submenu: { list: before.list.submenu.list } },
			});
		}
		expect(h.values.get(order.path)).toEqual([...ids.slice(0, 18), ids[19]!, ids[18]!]);
		const snapshot = h.selector.navigationSnapshot();
		const restored = harness({}, { entries });
		restored.selector.restoreNavigation(snapshot);
		expect(restored.selector.navigationSnapshot()).toEqual(snapshot);
		restored.selector.handleInput("h");
		expect(prefs(restored.selector).props.editing).toEqual({ row: order.path, option: "v19" });
		expect(restored.values.get(order.path)).toEqual([...ids.slice(0, 17), ids[19]!, ids[17]!, ids[18]!]);
	});

	it("restores provider parent search and makes Space/l inert on clear-all without phantom visits", () => {
		const limits: SettingsDisplayEntry = {
			path: "providers.maxInFlightRequests",
			type: "record",
			defaultValue: { acme: 3, zeta: 4 },
			ui: { tab: "providers", label: "Max In-Flight Requests", description: "" },
		};
		const providers = ["acme", ...Array.from({ length: 12 }, (_, index) => `other-${index}`), "zeta"];
		const h = harness({}, { entries: [...ENTRIES, limits], providers });
		const visits: string[] = [];
		h.selector.onNavigationVisit = page => {
			visits.push(page);
		};
		send(h.selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		send(h.selector, { type: "activate", key: "", item: limits.path });
		for (const key of ["/", "ze", "\x01", "\x1b[C", ENTER]) h.selector.handleInput(key);
		const parent = h.selector.navigationSnapshot();
		h.selector.handleInput("l");
		expect(h.selector.navigationSnapshot()).toMatchObject({ list: { submenu: { provider: "zeta" } } });
		h.selector.handleInput("\x1b");
		expect(h.selector.navigationSnapshot()).toEqual(parent);
		for (const key of ["/", "\x01", "\x0b", "\x1b", "G", " ", "l"]) h.selector.handleInput(key);
		expect(h.changes).toEqual([]);
		expect(h.values.get(limits.path)).toEqual({ acme: 3, zeta: 4 });
		const count = visits.length;
		h.selector.handleInput("\r");
		expect(h.values.get(limits.path)).toEqual({});
		expect(h.changes).toEqual([[limits.path, {}]]);
		expect(h.selector.navigationSnapshot()).toMatchObject({ list: { submenuId: null } });
		expect(visits.slice(count)).toEqual([""]);
	});

	it("keeps an in-flight plugin write blocked across tab switches and onPluginsChanged", async () => {
		const plugins = pluginHost([PLUGIN]);
		const write = Promise.withResolvers<void>();
		const changed = Promise.withResolvers<void>();
		const changedStarted = Promise.withResolvers<void>();
		plugins.manager.setEnabled = () => write.promise;
		const h = harness(
			{},
			{
				plugins,
				onPluginsChanged: () => {
					changedStarted.resolve();
					return changed.promise;
				},
			},
		);
		send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
		await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
		send(h.selector, { type: "activate", key: "", item: "npm:hjkl" });
		await h.whenRendered(props => props.sections.some(section => section.rows.some(row => row.id === "__enabled__")));
		send(h.selector, { type: "change", key: "", item: "__enabled__", value: false });
		expect(h.selector.blocksMenuHistory).toBe(true);
		send(h.selector, { type: "action", key: "", act: "page", value: "appearance", mods: [] });
		expect(h.selector.blocksMenuHistory).toBe(true);
		write.resolve();
		await changedStarted.promise;
		expect(h.selector.blocksMenuHistory).toBe(true);
		const finished = h.whenRendered(() => !h.selector.blocksMenuHistory);
		changed.resolve();
		await finished;
		expect(h.selector.blocksMenuHistory).toBe(false);
	});

	it("does not block for async plugin reloads or emit visits from a detached child", async () => {
		const plugins = pluginHost([PLUGIN]);
		const listed = Promise.withResolvers<InstalledPlugin[]>();
		let lists = 0;
		plugins.manager.list = () => (++lists === 1 ? Promise.resolve([PLUGIN]) : listed.promise);
		const lateFrame = Promise.withResolvers<void>();
		let expectLateFrame = false;
		const h = harness(
			{},
			{
				plugins,
				requestRender: () => {
					if (expectLateFrame) lateFrame.resolve();
				},
			},
		);
		const visits: string[] = [];
		h.selector.onNavigationVisit = page => {
			visits.push(page);
		};
		send(h.selector, { type: "action", key: "", act: "page", value: "plugins", mods: [] });
		expect(h.selector.blocksMenuHistory).toBe(false);
		await h.whenRendered(props => props.sections.some(section => section.id === "installed"));
		send(h.selector, { type: "activate", key: "", item: "npm:hjkl" });
		expect(h.selector.blocksMenuHistory).toBe(false);
		await h.whenRendered(props =>
			props.sections.some(section => section.rows.some(row => row.id === "config:message")),
		);
		h.selector.handleInput("h"); // parent navigation starts a read-only registry reload
		expect(h.selector.blocksMenuHistory).toBe(false);
		send(h.selector, { type: "action", key: "", act: "page", value: "appearance", mods: [] });
		const count = visits.length;
		expectLateFrame = true;
		listed.resolve([PLUGIN]);
		await lateFrame.promise;
		expect(prefs(h.selector).props.page).toBe("appearance");
		expect(h.selector.blocksMenuHistory).toBe(false);
		expect(visits).toHaveLength(count);
	});
});

it("Ctrl-G reloads the settings rows after editing and ignores repeated launches", async () => {
	const edited = Promise.withResolvers<void>();
	let opens = 0;
	const h = harness(
		{},
		{
			onOpenConfigFile: async () => {
				opens++;
				await edited.promise;
				h.values.set("display.colorBlind", true);
			},
		},
	);
	const rendered = h.whenRendered(props => row(props, "display.colorBlind").changed === true);
	h.selector.handleInput("\x07");
	h.selector.handleInput("\x07");
	expect(opens).toBe(1);
	edited.resolve();
	await rendered;
	expect(h.changes).toEqual([]);
	expect(h.values.get("display.colorBlind")).toBe(true);
});

it("an existing menu Ctrl-G binding wins over opening the settings file", () => {
	const previous = getKeybindings();
	let opened = false;
	let cancelled = false;
	setKeybindings(new KeybindingsManager({ "tui.select.cancel": ["ctrl+g"] }));
	try {
		const h = harness(
			{},
			{
				onOpenConfigFile: async () => {
					opened = true;
				},
				onCancel: () => {
					cancelled = true;
				},
			},
		);
		h.selector.handleInput("\x07");
		expect(opened).toBe(false);
		expect(cancelled).toBe(true);
	} finally {
		setKeybindings(previous);
	}
});
