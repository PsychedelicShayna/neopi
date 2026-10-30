/**
 * Contracts of the fullscreen /agents hub: frame geometry, scope sidebar
 * filtering, explicit search, the Space enable/disable toggle, and the
 * strip-driven configuration flows (property strips, pattern input, and the
 * model-browser pick) persisting one agent's entry at a time.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import {
	AgentsHubComponent,
	type AgentsHubDeps,
	type HubAgent,
} from "../src/overlays/agents-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OVERRIDE_KEYS = {
	model: "task.agentModelOverrides",
	prewalk: "task.agentPrewalk",
	advisor: "task.agentAdvisor",
} as const;

/** Settings double with entry-level writers; `writes` records every entry the hub touched. */
class TestSettings {
	readonly lists = new Map<string, string[]>();
	readonly records = new Map<string, Record<string, string>>();
	readonly writes: string[] = [];

	setMember(key: string, item: string, { member }: { member: boolean }): void {
		const rest = (this.lists.get(key) ?? []).filter(entry => entry !== item);
		this.lists.set(key, member ? [...rest, item] : rest);
		this.writes.push(`${key}[${item}]`);
	}

	setEntry(key: string, name: string, value: string | undefined): void {
		const record = { ...this.records.get(key) };
		if (value === undefined) delete record[name];
		else record[name] = value;
		this.records.set(key, record);
		this.writes.push(`${key}.${name}`);
	}
}

// Narrow TUI stub: the hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const sonnet = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
});

async function createHub(
	settings: TestSettings,
	overrides: Partial<AgentsHubDeps> = {},
): Promise<{
	hub: AgentsHubComponent;
	strip: () => string;
	type: (text: string) => void;
	cancelled: () => boolean;
}> {
	let cancelled = false;
	const hub = await AgentsHubComponent.create(
		tuiStub,
		{
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
			loadAgents: async () => {
				const agents: HubAgent[] = [
					{ name: "dev", description: "Development agent", systemPrompt: "", source: "project", disabled: false },
					{
						name: "scout",
						description: "Read-only research",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
					{
						name: "task",
						description: "Generic task agent",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
				];
				for (const agent of agents) {
					agent.disabled = settings.lists.get("task.disabledAgents")?.includes(agent.name) ?? false;
					agent.overrideModel = settings.records.get(OVERRIDE_KEYS.model)?.[agent.name];
					agent.prewalkOverride = settings.records.get(OVERRIDE_KEYS.prewalk)?.[agent.name];
					agent.advisorOverride = settings.records.get(OVERRIDE_KEYS.advisor)?.[agent.name];
				}
				return agents;
			},
			getAvailableModels: () => [sonnet],
			effectiveModelPatterns: agent => (agent.overrideModel ? [agent.overrideModel] : []),
			resolvePatterns: () => undefined,
			effectivePrewalkPattern: () => undefined,
			effectiveAdvisorPattern: agent => (agent.advisorOverride === "on" ? "@advisor" : undefined),
			setAgentDisabled: (name, { disabled }) =>
				settings.setMember("task.disabledAgents", name, { member: disabled }),
			setAgentOverride: (property, name, value) => settings.setEntry(OVERRIDE_KEYS[property], name, value),
			editor: {
				tools: [{ name: "read", description: "Read files" }],
				listAdvisors: async () => [],
				parse: raw => JSON.parse(raw),
				serialize: definition => JSON.stringify(definition),
				generate: async () => { throw new Error("Not used by navigation tests"); },
			},
			saveDefinition: async () => { throw new Error("Not used by navigation tests"); },
			...overrides,
		},
		{ onCancel: () => (cancelled = true) },
	);
	return {
		hub,
		strip: () => hub.render(120).join("\n").replace(ANSI_PATTERN, ""),
		type: (text: string) => {
			for (const char of text) hub.handleInput(char);
		},
		cancelled: () => cancelled,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AgentsHub layout", () => {
	test("renders the full-height split frame with sidebar scopes and agent rows", async () => {
		const { hub, strip } = await createHub(new TestSettings());
		const lines = hub.render(120);
		// top border + content rows + divider + footer + bottom border = terminal rows.
		expect(lines.length).toBe(30);
		const rendered = strip();
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("All agents");
		expect(rendered).toContain("Project");
		expect(rendered).toContain("Bundled");
		expect(rendered).toContain("dev");
		expect(rendered).toContain("scout");
		expect(rendered).toContain("+ New agent");
	});

	test("sidebar scope filters the rows to one source", async () => {
		const { hub, strip } = await createHub(new TestSettings());
		hub.handleInput("\x1b[D"); // left → scope focus
		hub.handleInput("\x1b[B"); // down → Project
		const rendered = strip();
		expect(rendered).toContain("Project agents · 1");
		expect(rendered).toContain("dev");
		expect(rendered).not.toContain("scout");
	});

	test("/ searches with literal hjkl; Esc clears the filter before closing", async () => {
		const { hub, strip, type, cancelled } = await createHub(new TestSettings());
		hub.handleInput("h"); // sidebar
		hub.handleInput("j"); // project scope
		hub.handleInput("k"); // all agents
		hub.handleInput("l"); // rows
		hub.handleInput("/");
		type("sco");
		let rendered = strip();
		expect(rendered).toContain("scout");
		expect(rendered).toContain("dev");
		hub.handleInput("\r");
		expect(strip()).not.toContain("dev");
		hub.handleInput("/");
		for (const key of "hjkl") hub.handleInput(key);
		rendered = strip();
		expect(rendered).toContain("Search: scohjkl");
		hub.handleInput("\x1b");
		expect(cancelled()).toBe(false);
		expect(strip()).not.toContain("Search: scohjkl");
		expect(strip()).toContain("dev");
		hub.handleInput("\x1b");
		expect(cancelled()).toBe(true);
	});
});

describe("AgentsHub configuration strips", () => {
	test("Space toggles only the selected agent's entry", async () => {
		const settings = new TestSettings();
		settings.lists.set("task.disabledAgents", ["scout"]);
		const { hub } = await createHub(settings);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout", "dev"]);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout"]);
		expect(settings.writes).toEqual(["task.disabledAgents[dev]", "task.disabledAgents[dev]"]);
	});

	test("Enter opens the property strip; advisor → on persists only that agent's entry", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentAdvisor", { scout: "off" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip for `dev`
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b[B"); // model → prewalk
		hub.handleInput("\x1b[B"); // prewalk → advisor
		hub.handleInput("\r"); // advisor value strip
		expect(strip()).toContain("dev · advisor →");
		hub.handleInput("\x1b[B"); // agent default → on
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ scout: "off", dev: "on" });
		expect(settings.writes).toEqual(["task.agentAdvisor.dev"]);
		expect(strip()).toContain("dev advisor: on (@advisor)");
	});

	test("pattern… commits a custom advisor pattern and empty submit clears it", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentAdvisor", { dev: "on" });
		const { hub, type } = await createHub(settings);
		hub.handleInput("\r");
		hub.handleInput("\x1b[B");
		hub.handleInput("\x1b[B");
		hub.handleInput("\r"); // advisor strip
		// agent default → on → off → pick model… → pattern…
		for (let i = 0; i < 4; i++) hub.handleInput("\x1b[B");
		hub.handleInput("\r"); // pattern input, pre-filled "on"
		type("\x7f\x7f"); // clear the prefill
		type("moonshot/k3:high");
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ dev: "moonshot/k3:high" });
	});

	test("pick model… dives into the model browser and persists the model override", async () => {
		const settings = new TestSettings();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip (model chip preselected)
		hub.handleInput("\r"); // model value strip → [pick model…] first
		expect(strip()).toContain("dev · model →");
		hub.handleInput("\r"); // assign mode: model browser
		expect(strip()).toContain("Picking model override for dev");
		expect(strip()).toContain("claude-sonnet-4-5");
		hub.handleInput("\r"); // pick the only model
		expect(settings.records.get("task.agentModelOverrides")).toEqual({ dev: "anthropic/claude-sonnet-4-5" });
		// Back on the list with the override reflected.
		expect(strip()).toContain("anthropic/claude-sonnet-4-5");
	});

	test("model pattern entry persists a selectable subagent override", async () => {
		const settings = new TestSettings();
		const { hub, type, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent properties
		hub.handleInput("\r"); // model choices
		expect(strip()).toContain("pick model");
		expect(strip()).toContain("pattern");
		hub.handleInput("\x1b[B"); // pattern entry
		hub.handleInput("\r");
		type("anthropic/claude-*");
		hub.handleInput("\r");
		expect(settings.records.get("task.agentModelOverrides")).toEqual({ dev: "anthropic/claude-*" });
	});

	test("clear override chip removes an existing model override", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		expect(strip()).toContain("clear override");
		hub.handleInput("\x1b[B"); // pick model… → pattern…
		hub.handleInput("\x1b[B"); // pattern… → clear override
		hub.handleInput("\r");
		expect(settings.records.get("task.agentModelOverrides")).toEqual({});
	});

	test("Esc steps back from a value strip to the agent strip before closing", async () => {
		const settings = new TestSettings();
		const { hub, strip, cancelled } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		hub.handleInput("\x1b"); // back to agent strip
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b"); // close strip
		expect(strip()).not.toContain("dev →");
		expect(cancelled()).toBe(false);
	});
});

/** The generic composition: a terminal without the `picker` kind. */
const cx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: kind => kind !== "picker",
	feature: () => true,
};
const pickerCx: DescribeContext = { ...cx, supports: () => true };

function pickerProps(hub: AgentsHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

describe("AgentsHub definition editing", () => {
	test("Ctrl-G opens the same rich editor for existing definitions and Esc returns to selection", async () => {
		const { hub } = await createHub(new TestSettings());
		hub.handleInput("\x07");
		expect(pickerProps(hub).title).toBe("Edit dev");
		expect(pickerProps(hub).items?.map(item => item.id)).toContain("tools");
		hub.handleInput("\x1b");
		expect(pickerProps(hub).selected).toBe("agent:project:dev");
		hub.dispose();
	});

	test("native Edit opens bundled definitions as editable drafts", async () => {
		const { hub } = await createHub(new TestSettings());
		hub.handleNativeEvent({ type: "select", key: "", item: "agent:bundled:scout" });
		hub.handleNativeEvent({ type: "action", key: "", act: "edit-file", mods: [] });
		expect(hub.navigationSnapshot().create?.definition.name).toBe("scout");
		hub.handleInput("\x1b");
		expect(pickerProps(hub).selected).toBe("agent:bundled:scout");
		hub.dispose();
	});
});

/** The described node keyed `key` and its key path (the `key` its native events carry). */
function findKeyed(root: NativeNode, key: string): { node: NativeNode; path: string } | undefined {
	const walk = (node: NativeNode, path: string[]): { node: NativeNode; path: string } | undefined => {
		const children: readonly NativeChild[] = node.c ?? [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (!child || !("k" in child)) continue;
			const childPath = [...path, child.key ?? String(i)];
			if (child.key === key) return { node: child, path: childPath.join("/") };
			const found = walk(child, childPath);
			if (found) return found;
		}
		return undefined;
	};
	return walk(root, []);
}

function mustFind(hub: AgentsHubComponent, key: string): { node: NativeNode; path: string } {
	const found = findKeyed(hub.describe(cx), key);
	if (!found) throw new Error(`no described node keyed ${key}`);
	return found;
}

describe("AgentsHub picker", () => {
	test("select then Configure opens the agent strip; a strip chip persists like Enter on it", async () => {
		const settings = new TestSettings();
		const { hub } = await createHub(settings);
		expect(hub.nativeSheet(pickerCx)).toBe(true);
		expect(hub.nativeSheet(cx)).toBe(false);

		hub.handleNativeEvent({ type: "select", key: "", item: "agent:bundled:scout" });
		expect(pickerProps(hub).selected).toBe("agent:bundled:scout");
		hub.handleNativeEvent({ type: "action", key: "", act: "configure", mods: [] });
		const strip = pickerProps(hub).strip;
		expect(strip?.items.map(item => item.label)).toEqual(["Disable", "model: auto", "prewalk: off", "advisor: off"]);
		expect(pickerProps(hub).focus).toBe("strip");

		hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: "0", mods: [] });
		expect(settings.writes).toEqual(["task.disabledAgents[scout]"]);
		expect(pickerProps(hub).strip).toBeNull();
		expect(pickerProps(hub).items?.find(item => item.id === "agent:bundled:scout")?.disabled).toBeTruthy();
	});

	test("the Toggle action flips the selected agent even while a search query is typed", async () => {
		const settings = new TestSettings();
		const { hub, type } = await createHub(settings);
		hub.handleInput("/");
		type("dev");
		hub.handleInput("\r");
		hub.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
		expect(settings.lists.get("task.disabledAgents")).toEqual(["dev"]);
		expect(pickerProps(hub).query).toBe("dev");
	});

	test("the pattern input leaves the picker for the generic overlay", async () => {
		const { hub } = await createHub(new TestSettings());
		hub.handleNativeEvent({ type: "action", key: "", act: "model", mods: [] });
		expect(pickerProps(hub).strip?.label).toBe("dev · model");
		// pattern… is the second chip of the model strip
		hub.handleNativeEvent({ type: "action", key: "", act: "strip", value: "1", mods: [] });
		expect(hub.nativeSheet(pickerCx)).toBe(false);
		expect(hub.describe(pickerCx).k).not.toBe("picker");
	});

	test("scope action narrows items to that source and disables empty sources", async () => {
		const { hub } = await createHub(new TestSettings());
		expect(pickerProps(hub).scopes?.find(scope => scope.id === "source:user")?.disabled).toBeTruthy();
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "source:bundled", mods: [] });
		const props = pickerProps(hub);
		expect(props.scope).toBe("source:bundled");
		expect(props.items?.map(item => item.id)).toEqual(["agent:bundled:scout", "agent:bundled:task", "new"]);
	});
});

describe("AgentsHub native events", () => {
	test("list select mirrors the selection; activate opens the agent strip whose chips persist", async () => {
		const settings = new TestSettings();
		const { hub } = await createHub(settings);
		const agents = mustFind(hub, "agents");
		expect(agents.node.k === "list" && agents.node.p?.selected).toBe("agent:project:dev");

		hub.handleNativeEvent({ type: "select", key: agents.path, item: "agent:bundled:scout" });
		const selected = mustFind(hub, "agents").node;
		expect(selected.k === "list" && selected.p?.selected).toBe("agent:bundled:scout");
		expect(findKeyed(hub.describe(cx), "strip")).toBeUndefined();

		hub.handleNativeEvent({ type: "activate", key: agents.path, item: "agent:bundled:scout" });
		const strip = mustFind(hub, "strip");
		expect(strip.node.k === "tabs" && strip.node.p?.items.length).toBe(4);

		// Chip 0 is the enable/disable toggle; activating it persists only scout.
		hub.handleNativeEvent({ type: "activate", key: strip.path, item: "0" });
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout"]);
		expect(settings.writes).toEqual(["task.disabledAgents[scout]"]);
		expect(findKeyed(hub.describe(cx), "strip")).toBeUndefined();
	});

	test("scope select filters the described agent list to that source", async () => {
		const { hub } = await createHub(new TestSettings());
		const scopes = mustFind(hub, "scopes");
		hub.handleNativeEvent({ type: "select", key: scopes.path, item: "source:bundled" });
		const agents = mustFind(hub, "agents").node;
		expect(agents.c?.map(child => ("k" in child ? child.key : undefined))).toEqual([
			"agent:bundled:scout",
			"agent:bundled:task",
			"new",
		]);
		const sidebar = mustFind(hub, "scopes").node;
		expect(sidebar.k === "list" && sidebar.p?.selected).toBe("source:bundled");
	});

	test("the agent list ignores select while a strip is open", async () => {
		const { hub } = await createHub(new TestSettings());
		const agents = mustFind(hub, "agents");
		hub.handleInput("\r"); // agent strip for dev
		hub.handleNativeEvent({ type: "activate", key: agents.path, item: "agent:bundled:scout" });
		hub.handleInput("\x1b"); // close the strip
		const list = mustFind(hub, "agents").node;
		expect(list.k === "list" && list.p?.selected).toBe("agent:project:dev");
	});
});


describe("AgentsHub navigation history", () => {
	test("body viewport moves one line independently and row motions reveal its selection", async () => {
		const { hub } = await createHub(new TestSettings(), {
			loadAgents: async () =>
				Array.from({ length: 40 }, (_, index) => ({
					name: `worker-${String(index).padStart(2, "0")}`,
					description: "Worker",
					systemPrompt: "",
					source: "project" as const,
					disabled: false,
				})),
		});
		try {
			hub.handleInput("i");
			expect(hub.navigationSnapshot().search.focused).toBe(false);
			hub.render(120);
			const first = hub.navigationSnapshot();
			hub.handleInput("\x05");
			hub.render(120);
			expect(hub.navigationSnapshot()).toMatchObject({
				selectedRow: first.selectedRow,
				listViewport: { item: 1, lineOffset: 0 },
			});
			hub.handleInput("j");
			hub.render(120);
			expect(hub.navigationSnapshot().selectedRow).toContain("worker-01");
			hub.handleInput("G");
			expect(hub.navigationSnapshot().selectedRow).toBe("new");
			hub.handleInput("g");
			hub.handleInput("g");
			hub.render(120);
			expect(hub.navigationSnapshot()).toMatchObject({
				selectedRow: first.selectedRow,
				listViewport: { item: 0, lineOffset: 0 },
			});
			hub.handleInput("\x04");
			expect(hub.navigationSnapshot().selectedRow).not.toBe(first.selectedRow);
		} finally {
			hub.dispose();
		}
	});

	test("non-effort strips choose with j/k and leave on pane or context motion without applying", async () => {
		const settings = new TestSettings();
		const { hub } = await createHub(settings);
		const visits: string[] = [];
		hub.onNavigationVisit = page => visits.push(page);
		try {
			hub.handleInput("\r");
			hub.handleInput("j");
			expect(hub.navigationSnapshot().strip).toMatchObject({ kind: "chips", index: 2 });
			hub.handleInput("h");
			expect(hub.navigationSnapshot()).toMatchObject({ focus: "scope", strip: null });
			hub.handleInput("l");
			hub.handleInput("\r");
			hub.handleInput("G");
			expect(hub.navigationSnapshot().strip).toMatchObject({ index: 3 });
			hub.handleInput("g");
			hub.handleInput("g");
			expect(hub.navigationSnapshot().strip).toMatchObject({ index: 0 });
			hub.handleInput("\t");
			expect(hub.navigationSnapshot()).toMatchObject({ focus: "scope", strip: null });
			expect(settings.writes).toEqual([]);
			expect(visits).toEqual([]);
		} finally {
			hub.dispose();
		}
	});

	test("pattern draft and caret restore without applying any setting or creating a visit", async () => {
		const settings = new TestSettings();
		const { hub, type } = await createHub(settings);
		const restored = await createHub(settings);
		const visits: string[] = [];
		restored.hub.onNavigationVisit = page => visits.push(page);
		try {
			hub.handleInput("\r");
			hub.handleInput("\r");
			hub.handleInput("j");
			hub.handleInput("\r");
			type("hjkl / g");
			hub.handleInput("\x1b[D");
			const snapshot = hub.navigationSnapshot();
			restored.hub.restoreNavigation(snapshot);
			expect(restored.hub.navigationSnapshot().strip).toEqual(snapshot.strip);
			restored.type("h");
			expect(restored.hub.navigationSnapshot().strip).toMatchObject({ kind: "pattern", value: "hjkl / hg" });
			expect(settings.writes).toEqual([]);
			expect(visits).toEqual([]);
		} finally {
			hub.dispose();
			restored.hub.dispose();
		}
	});

	test("embedded model search restores silently and returns to its retained property context", async () => {
		const settings = new TestSettings();
		const { hub, type } = await createHub(settings);
		const restored = await createHub(settings);
		const visits: string[] = [];
		const restoredVisits: string[] = [];
		hub.onNavigationVisit = page => visits.push(page);
		restored.hub.onNavigationVisit = page => restoredVisits.push(page);
		try {
			hub.handleInput("\r");
			hub.handleInput("\r");
			hub.handleInput("\r");
			hub.handleInput("/");
			type("cla");
			const snapshot = hub.navigationSnapshot();
			restored.hub.restoreNavigation(snapshot);
			expect(restored.hub.navigationSnapshot().assigning).toEqual(snapshot.assigning);
			expect(restoredVisits).toEqual([]);
			restored.hub.handleInput("\x1b");
			expect(restored.hub.navigationSnapshot().assigning).toBeDefined();
			restored.hub.handleInput("h");
			expect(restored.hub.navigationSnapshot()).toMatchObject({
				assigning: undefined,
				strip: { kind: "chips", property: "model", index: 0 },
			});
			expect(visits).toEqual(["assign:dev:model"]);
			expect(restoredVisits).toEqual([""]);
			expect(settings.writes).toEqual([]);
		} finally {
			hub.dispose();
			restored.hub.dispose();
		}
	});

	test("rich draft restores without generation or persistence", async () => {
		const { hub } = await createHub(new TestSettings());
		const restored = await createHub(new TestSettings());
		hub.handleInput("\x07");
		const snapshot = hub.navigationSnapshot();
		restored.hub.restoreNavigation(snapshot);
		expect(restored.hub.navigationSnapshot().create?.definition).toEqual(snapshot.create?.definition);
		expect(restored.hub.blocksMenuHistory).toBe(false);
		hub.dispose();
		restored.hub.dispose();
	});

	test("a standalone read-only reload does not block menu history", async () => {
		const reload = Promise.withResolvers<HubAgent[]>();
		const agents: HubAgent[] = [
			{ name: "dev", description: "Development", systemPrompt: "", source: "project", disabled: false },
		];
		let loads = 0;
		const { hub } = await createHub(new TestSettings(), {
			loadAgents: () => (++loads === 1 ? Promise.resolve(agents) : reload.promise),
		});
		try {
			hub.handleInput("\x12");
			expect(loads).toBe(2);
			expect(hub.blocksMenuHistory).toBe(false);
			reload.resolve(agents);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(hub.blocksMenuHistory).toBe(false);
		} finally {
			hub.dispose();
		}
	});

	test("native close first clears the search field", async () => {
		const { hub, type, cancelled } = await createHub(new TestSettings());
		try {
			hub.handleInput("/");
			type("dev");
			expect(pickerProps(hub).actions?.find(action => action.id === "close")?.label).toBe("Back to list");
			const close = { type: "action", key: "", act: "close", mods: [] } as const;
			hub.handleNativeEvent(close);
			expect(cancelled()).toBe(false);
			expect(hub.navigationSnapshot().search).toMatchObject({ value: "", focused: false });
			hub.handleNativeEvent(close);
			expect(cancelled()).toBe(true);
		} finally {
			hub.dispose();
		}
	});
});
