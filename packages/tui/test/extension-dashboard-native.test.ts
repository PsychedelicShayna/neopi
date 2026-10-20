import { beforeAll, describe, expect, test } from "bun:test";
import { TSP_KINDS, type TspNode, type TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import { ExtensionDashboard, type ExtensionDashboardRuntime } from "../src/overlays/extensions/extension-dashboard";
import type { Extension, ExtensionProvider } from "../src/overlays/extensions/types";
import { initTheme } from "../src/theme";
import { TspHarness } from "./native/tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

function extension(kind: Extension["kind"], name: string, provider: string): Extension {
	return {
		id: `${kind}:${name}`,
		kind,
		name,
		displayName: name,
		description: `${name} description`,
		path: `/home/u/.omp/${kind}/${name}.md`,
		source: { provider, providerName: provider, level: "user" },
		state: "active",
		raw: { content: `# ${name}` },
	};
}

interface Fixture {
	readonly runtime: ExtensionDashboardRuntime;
	readonly disabled: string[];
}

function fixture(
	extensions: Extension[] = [extension("skill", "alpha", "native"), extension("slash-command", "gamma", "claude")],
): Fixture {
	const disabled: string[] = [];
	const providers: ExtensionProvider[] = [
		{ id: "native", displayName: "OMP", enabled: true, userSourceEnabled: true, foreignUserSource: false },
		{ id: "claude", displayName: "Claude Code", enabled: true, userSourceEnabled: true, foreignUserSource: false },
	];
	const runtime: ExtensionDashboardRuntime = {
		getDisabledExtensions: () => disabled,
		setDisabledExtensions: ids => {
			disabled.splice(0, disabled.length, ...ids);
		},
		getProviders: () => providers,
		loadExtensions: async ids =>
			extensions.map(ext =>
				ids.includes(ext.id) ? { ...ext, state: "disabled", disabledReason: "item-disabled" } : ext,
			),
		toggleProvider: () => true,
		toggleUserSource: () => true,
		persistMcpToggle: async () => {},
		applyMcpToggle: async () => {},
		subscribeMcpChanges: () => [],
	};
	return { runtime, disabled };
}

async function open(fx: Fixture, kinds?: readonly string[]): Promise<TspHarness> {
	const dashboard = await ExtensionDashboard.create({ runtime: fx.runtime, terminalHeight: 30 });
	const harness = await TspHarness.start(
		tui => {
			tui.showOverlay(dashboard, { width: "100%", maxHeight: "100%", fullscreen: true });
			dashboard.onRequestRender = () => tui.requestRender();
		},
		kinds ? { kinds } : {},
	);
	await harness.render();
	return harness;
}

function pickerOf(harness: TspHarness): { node: TspNode; props: TspPickerProps } {
	const found = harness.find(node => node.k === "picker");
	if (found?.k !== "picker" || !found.p) throw new Error("no picker sheet");
	return { node: found, props: found.p };
}

const pickerContext: DescribeContext = {
	cols: 120,
	dark: true,
	reduceMotion: false,
	supports: kind => kind === "picker",
	feature: () => false,
};

function describedPicker(dashboard: ExtensionDashboard): TspPickerProps {
	const described = dashboard.describe(pickerContext);
	if (described.k !== "picker" || !described.p) throw new Error("no extension picker");
	return described.p;
}

describe("ExtensionDashboard native", () => {
	test("is a picker sheet whose row activation toggles like Space and whose scopes switch provider", async () => {
		const fx = fixture();
		const harness = await open(fx);
		expect(harness.tui.nativeFallbackCount).toBe(0);
		const sf = harness.terminal.surface!;
		const sheet = pickerOf(harness);
		const alpha = sheet.props.items?.find(item => item.label === "alpha");
		expect(alpha).toBeDefined();

		harness.event({ ev: "activate", sf, id: sheet.node.id, item: alpha!.id });
		expect(fx.disabled).toEqual(["skill:alpha"]);

		harness.event({ ev: "action", sf, id: sheet.node.id, act: "scope", value: "claude", mods: [] });
		const scoped = pickerOf(harness).props;
		expect(scoped.scope).toBe("claude");
		expect(scoped.items?.map(item => item.label)).toContain("gamma");
		expect(scoped.items?.map(item => item.label)).not.toContain("alpha");
		expect(harness.tui.nativeFallbackCount).toBe(0);
		harness.stop();
	});

	test("without picker it is a page whose list activation toggles the row", async () => {
		const fx = fixture();
		const harness = await open(
			fx,
			TSP_KINDS.filter(kind => kind !== "picker"),
		);
		expect(harness.tui.nativeFallbackCount).toBe(0);
		const list = harness.find(node => node.k === "list");
		const alpha = list?.c?.find(row => row.k === "item" && JSON.stringify(row.p?.label).includes('"alpha"'));
		expect(alpha).toBeDefined();
		harness.event({ ev: "activate", sf: harness.terminal.surface!, id: list!.id, item: alpha!.id });
		expect(fx.disabled).toEqual(["skill:alpha"]);
		harness.stop();
	});
});

describe("ExtensionDashboard menu navigation", () => {
	test("switches provider tabs and list/viewer focus, preserving both viewport states without replay", async () => {
		const alpha = extension("skill", "alpha", "native");
		alpha.raw = { content: Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n") };
		const fx = fixture([alpha, extension("slash-command", "gamma", "claude")]);
		const loadExtensions = fx.runtime.loadExtensions;
		let loads = 0;
		fx.runtime.loadExtensions = async ids => {
			loads++;
			return loadExtensions(ids);
		};
		const dashboard = await ExtensionDashboard.create({ runtime: fx.runtime, terminalHeight: 30 });
		dashboard.render(120);
		dashboard.handleInput("j");
		const selected = dashboard.navigationSnapshot().list.selected;
		expect(
			describedPicker(dashboard).items?.find(item => item.id === describedPicker(dashboard).selected)?.label,
		).toBe("alpha");
		dashboard.handleInput("\x0f");
		expect(dashboard.navigationSnapshot().inspector.expanded).toBe(false);
		dashboard.handleInput("\x1be");
		expect(dashboard.navigationSnapshot().inspector.expanded).toBe(true);
		dashboard.render(120);
		dashboard.handleInput("\t");
		expect(dashboard.navigationSnapshot().pane).toBe("inspector");
		expect(describedPicker(dashboard).focus).toBe("preview");
		dashboard.handleInput("j");
		expect(dashboard.navigationSnapshot().inspectorViewport).toMatchObject({ scrollOffset: 1 });
		dashboard.handleInput("\x05");
		expect(dashboard.navigationSnapshot().inspectorViewport).toMatchObject({ scrollOffset: 2 });
		dashboard.handleInput("\x04");
		expect(dashboard.navigationSnapshot().inspectorViewport).not.toMatchObject({ scrollOffset: 2 });
		dashboard.handleInput("\x15");
		expect(dashboard.navigationSnapshot().inspectorViewport).toMatchObject({ scrollOffset: 2 });
		dashboard.handleInput("\x1b[6~");
		dashboard.handleInput("\x1b[5~");
		expect(dashboard.navigationSnapshot().inspectorViewport).toMatchObject({ scrollOffset: 2 });
		expect(dashboard.navigationSnapshot().list.selected).toBe(selected);
		dashboard.handleInput(" ");
		expect(fx.disabled).toEqual([]);
		const saved = dashboard.navigationSnapshot();
		dashboard.handleInput("G");
		dashboard.handleInput("g");
		dashboard.handleInput("g");
		expect(dashboard.navigationSnapshot().inspectorViewport).toMatchObject({ scrollOffset: 0 });
		dashboard.handleInput("\x10");
		expect(dashboard.navigationSnapshot().pane).toBe("list");
		dashboard.handleInput("l");
		expect(describedPicker(dashboard).scope).not.toBe("all");
		dashboard.handleInput("h");
		expect(describedPicker(dashboard).scope).toBe("all");
		dashboard.restoreNavigation(saved);
		dashboard.render(120);
		expect(dashboard.navigationSnapshot()).toEqual(saved);
		expect(loads).toBe(1);
		expect(fx.disabled).toEqual([]);
		dashboard.handleInput("\x0e");
		expect(dashboard.navigationSnapshot().pane).toBe("list");
		dashboard.dispose();
	});

	test("keeps query typing literal and native Close leaves a focused field before closing", async () => {
		const fx = fixture();
		const dashboard = await ExtensionDashboard.create({ runtime: fx.runtime, terminalHeight: 30 });
		let closes = 0;
		dashboard.onClose = () => closes++;
		for (const char of "/alpha h/l") dashboard.handleInput(char);
		expect(dashboard.navigationSnapshot().provider).toBe("all");
		expect(dashboard.navigationSnapshot().list.search).toMatchObject({ value: "alpha h/l", focused: true });
		expect(describedPicker(dashboard).actions?.find(action => action.id === "close")?.label).toBe("Back to list");
		expect(describedPicker(dashboard).actions?.find(action => action.id === "toggle")?.keys).toBeUndefined();
		dashboard.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(closes).toBe(0);
		expect(dashboard.navigationSnapshot().list.search).toMatchObject({ value: "", focused: false });
		expect(describedPicker(dashboard).actions?.find(action => action.id === "close")?.label).toBe("Close");
		dashboard.handleInput("/");
		dashboard.handleInput("\t");
		expect(dashboard.navigationSnapshot().pane).toBe("list");
		expect(dashboard.navigationSnapshot().list.search.focused).toBe(true);
		dashboard.handleInput("\n");
		dashboard.handleInput("\t");
		expect(dashboard.navigationSnapshot().pane).toBe("inspector");
		expect(dashboard.navigationSnapshot().list.search.focused).toBe(false);
		dashboard.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(closes).toBe(1);
		expect(fx.disabled).toEqual([]);
	});

	test("blocks history for MCP mutations but not their read-only refresh tail", async () => {
		const server = extension("mcp", "server", "native");
		const fx = fixture([server]);
		const persisted = Promise.withResolvers<void>();
		const refreshed = Promise.withResolvers<Extension[]>();
		let loads = 0;
		let applies = 0;
		fx.runtime.loadExtensions = async () => (++loads === 1 ? [server] : refreshed.promise);
		fx.runtime.persistMcpToggle = () => persisted.promise;
		fx.runtime.applyMcpToggle = async () => {
			applies++;
		};
		const dashboard = await ExtensionDashboard.create({ runtime: fx.runtime, terminalHeight: 30 });
		dashboard.handleInput("G");
		dashboard.handleInput(" ");
		expect(dashboard.blocksMenuHistory).toBe(true);
		persisted.resolve();
		await Bun.sleep(0);
		expect(applies).toBe(1);
		expect(loads).toBe(2);
		expect(dashboard.blocksMenuHistory).toBe(false);
		refreshed.resolve([server]);
		await Bun.sleep(0);
		dashboard.dispose();
	});

	test("persists rule toggles before awaiting the live session refresh", async () => {
		const fx = fixture([extension("rule", "guard", "native")]);
		const applied: string[][] = [];
		const pending = Promise.withResolvers<void>();
		fx.runtime.onRulesChanged = async () => {
			applied.push([...fx.disabled]);
			await pending.promise;
		};
		const dashboard = await ExtensionDashboard.create({ runtime: fx.runtime, terminalHeight: 30 });
		try {
			dashboard.handleInput("G");
			dashboard.handleInput(" ");
			expect(applied).toEqual([["rule:guard"]]);
			expect(dashboard.blocksMenuHistory).toBe(true);
			pending.resolve();
			await Bun.sleep(0);
			expect(dashboard.blocksMenuHistory).toBe(false);
			dashboard.handleInput(" ");
			await Bun.sleep(0);
			expect(applied).toEqual([["rule:guard"], []]);
		} finally {
			pending.resolve();
			dashboard.dispose();
		}
	});
});
