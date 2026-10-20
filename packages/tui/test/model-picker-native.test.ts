import { afterEach, beforeAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerGroup, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { plainText } from "../src/native/spans";
import {
	ModelHubComponent,
	type HubEffortRule,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { ModelPickerComponent } from "../src/overlays/model-picker";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

beforeAll(async () => {
	await initTheme(false);
});

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

const MODELS = [
	model("anthropic", "claude-sonnet-5-5", { int: 60 }),
	model("anthropic", "claude-opus-5"),
	model("demo", "demo"),
	model("openai", "gpt-5.6"),
	model("openai", "gpt-5.6-mini", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
];

function source(roles: Record<string, string>, mru: string[]): ModelHubSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: mru,
		modelPerf: new Map(),
		getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		getModelRole: role => roles[role],
		disabledProviders: [],
		fallbackChains: { default: ["openai/gpt-5.6"] },
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => roles[role],
		getModelRoleSource: () => "global",
		effortRules: [],
		permittedEfforts: () => [],
		getProjectRoleEffortSelection: () => undefined,
		getGlobalRoleEffortSelection: () => undefined,
		getRoleEffortSelection: () => undefined,
		getFallbackEffortSelection: () => undefined,
		formatModelSelector: selected => `${selected.provider}/${selected.id}`,
	};
}

function registry(models: Model[]): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => "env" } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider: string, id: string) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	} as unknown as ModelHubRegistry;
}

const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const hubs: ModelHubComponent[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});

function openHub(calls: { assign: string[]; cancel: number }, models: Model[] = MODELS): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		registry(models),
		// A `--models` scope skips the background online refresh.
		models.map(entry => ({ model: entry })),
		{
			onAssign: (_model, role, _level, selector) => {
				calls.assign.push(`${role}=${selector}`);
			},
			onUnassign: () => {},
			onCancel: () => {
				calls.cancel++;
			},
		},
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	return hub;
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function groups(p: TspPickerProps): string[] {
	return (p.order ?? [])
		.filter((entry): entry is TspPickerGroup => typeof entry !== "string")
		.map(g => String(g.label));
}

/** A described child's prop, when the child is a node carrying it. */
function prop(child: NativeChild, name: string): unknown {
	return "k" in child && child.p ? Reflect.get(child.p, name) : undefined;
}

function titleOf(children: readonly NativeChild[] | undefined): unknown {
	const title = children?.find(child => prop(child, "role") === "omp.picker.title");
	return title ? prop(title, "text") : undefined;
}

test("the model hub describes a data-first picker when the terminal has the kind, else its generic frame", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	expect(hub.nativeSheet(withPicker)).toBe(true);
	expect(hub.nativeSheet(withoutPicker)).toBe(false);
	expect(hub.describe(withoutPicker).k).not.toBe("picker");

	const root = hub.describe(withPicker);
	const p = props(root);
	expect(p).toMatchObject({ size: "lg", layout: "rows", preview: "side", icon: "cpu", title: "Models", scope: "all" });
	expect(p.scopes?.map(scope => [scope.id, scope.count, scope.group])).toEqual([
		["roles", 2, undefined],
		["all", 5, undefined],
		["effort", 0, undefined],
		["provider:anthropic", 2, "Providers"],
		["provider:demo", 1, "Providers"],
		["provider:openai", 2, "Providers"],
	]);
	expect(p.scopes?.find(scope => scope.id === "provider:anthropic")?.mark).toEqual({
		text: "An",
		seed: "anthropic",
		icon: "provider:anthropic",
	});
	// The recent/role block, then one group per provider.
	expect(groups(p)).toEqual(["Recent", "anthropic", "openai"]);
	expect(p.current).toEqual(["demo/demo"]);
	expect(p.total).toBe(5);
	const demo = p.items?.find(entry => entry.id === "demo/demo");
	// Model rows lead with their provider's mark too.
	expect(demo?.mark).toEqual({ text: "De", seed: "demo", icon: "provider:demo" });
	// The default role runs with thinking off (`defaultThinkingLevel`): its chip carries that level's dot.
	expect(demo?.chips).toEqual([{ text: "default", on: true, dot: "thinkingOff" }]);
	expect(p.items?.find(entry => entry.id === "anthropic/claude-sonnet-5-5")?.facts?.int).toBe("60");
	expect(p.items?.find(entry => entry.id === "openai/gpt-5.6-mini")?.badges).toEqual([
		{ text: "free", tone: "success" },
	]);
	expect(titleOf(root.c)).toBe("demo");
	// Unchanged state keeps the node.
	expect(hub.describe(withPicker)).toBe(root);
});

test.each(["keyboard", "native"])(
	"session-only rich hub starts on recent models and picks without roles via %s",
	mode => {
		const picked: string[] = [];
		let assignments = 0;
		const hub = new ModelHubComponent(
			ui,
			source({ default: "demo/demo" }, ["openai/gpt-5.6", "demo/demo"]),
			registry(MODELS),
			MODELS.map(entry => ({ model: entry })),
			{
				onPick: (_model, selector) => {
					picked.push(selector);
				},
				onAssign: () => {
					assignments++;
				},
				onUnassign: () => {
					assignments++;
				},
				onCancel: () => {},
			},
			{ sessionOnly: true, currentSelector: "demo/demo" },
		);
		hubs.push(hub);
		const p = props(hub.describe(withPicker));
		expect(p.scope).toBe("recent");
		expect(p.scopes?.map(scope => scope.id)).toEqual([
			"recent",
			"all",
			"provider:anthropic",
			"provider:demo",
			"provider:openai",
		]);
		expect(p.order).toEqual(["openai/gpt-5.6", "demo/demo"]);
		expect(p.actions?.find(action => action.id === "assign")?.label).toBe("Use for session");
		expect(hub.render(120).join("\n")).not.toContain("Effort rules");
		if (mode === "keyboard") {
			hub.handleInput("l");
			hub.handleInput("g");
			hub.handleInput("g");
			hub.handleInput("\r");
		} else {
			hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
		}
		expect(picked).toEqual(["openai/gpt-5.6"]);
		expect(assignments).toBe(0);
		expect(props(hub.describe(withPicker)).strip).toBeNull();
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
		expect(props(hub.describe(withPicker)).scope).toBe("recent");
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "provider:anthropic", mods: [] });
		expect(props(hub.describe(withPicker)).selected).toStartWith("anthropic/");
	},
);

test("session-only rich hub has an empty recent view before its first selection", () => {
	const hub = new ModelHubComponent(
		ui,
		source({}, []),
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onPick: () => {}, onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ sessionOnly: true },
	);
	hubs.push(hub);
	expect(props(hub.describe(withPicker))).toMatchObject({ scope: "recent", order: [], total: 0 });
	hub.handleInput("j");
	expect(props(hub.describe(withPicker)).scope).toBe("all");
});

test("Factory Droid rows carry the base credit rate and a credit-only model is never free", () => {
	const priced = { ...model("factory-droid", "claude-opus-5"), factoryDroidCredits: 2 };
	const creditOnly = {
		...model("factory-droid", "preview-credit-model", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		factoryDroidCredits: 0.5,
	};
	const hub = openHub({ assign: [], cancel: 0 }, [...MODELS, priced, creditOnly]);
	const items = props(hub.describe(withPicker)).items ?? [];
	const row = (id: string) => items.find(entry => entry.id === `factory-droid/${id}`);
	expect(row("claude-opus-5")?.facts?.price).toBe("$3·15 2×");
	expect(row("preview-credit-model")?.facts?.price).toBe("0.5×");
	expect(row("preview-credit-model")?.badges ?? []).not.toContainEqual({ text: "free", tone: "success" });
});

test("typing changes the order, hits, counts and head total but never the catalogue", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	hub.handleInput("/");
	for (const ch of "sonnet") hub.handleInput(ch);
	const after = props(hub.describe(withPicker));
	expect(after.query).toBe("sonnet");
	expect(after.order).toEqual(["anthropic/claude-sonnet-5-5"]);
	expect(after.hits?.["anthropic/claude-sonnet-5-5"]).toEqual([[17, 23]]);
	expect(after.total).toBe(5);
	expect(after.scopes?.find(scope => scope.id === "all")?.count).toBe(1);
	expect(after.scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(0);
	expect(after.selected).toBe("anthropic/claude-sonnet-5-5");
});

test("a re-sync that moves a role patches the catalogue instead of resending it", () => {
	const models = [...MODELS, ...Array.from({ length: 30 }, (_, i) => model("bulk", `m-${i}`))];
	const roles: Record<string, string> = { default: "demo/demo" };
	const hub = new ModelHubComponent(
		ui,
		source(roles, []),
		registry(models),
		models.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
		},
	);
	hubs.push(hub);
	const first = props(hub.describe(withPicker));
	expect(first.itemsAdd).toBeUndefined();

	roles.default = "openai/gpt-5.6";
	hub.refreshAfterExternalMutation();
	const moved = props(hub.describe(withPicker));
	expect(moved.items).toBe(first.items);
	expect(moved.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", undefined],
		["openai/gpt-5.6", ["default"]],
	]);

	// Back to the original: the terminal kept the patch, so the reverted rows are still sent.
	roles.default = "demo/demo";
	hub.refreshAfterExternalMutation();
	const reverted = props(hub.describe(withPicker));
	expect(reverted.items).toBe(first.items);
	expect(reverted.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", ["default"]],
		["openai/gpt-5.6", undefined],
	]);
});

test("pointer events drive the hub through the same paths as its keys", () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	const act = (act: string, value?: string) =>
		hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });

	hub.handleNativeEvent({ type: "select", key: "", item: "openai/gpt-5.6" });
	let p = props(hub.describe(withPicker));
	expect(p.selected).toBe("openai/gpt-5.6");
	expect(p.focus).toBe("list");
	expect(titleOf(hub.describe(withPicker).c)).toBe("gpt-5.6");

	// Activate = Enter: the role-assignment strip opens and takes the focus.
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	p = props(hub.describe(withPicker));
	expect(p.focus).toBe("strip");
	expect(p.strip?.items.map(chip => chip.label).slice(0, 2)).toEqual(["default", "smol"]);
	act("strip", "1");
	// A reasoning model's role change is staged until an effort choice is committed.
	expect(calls.assign).toEqual([]);
	act("strip", "0"); // inherit thinking
	expect(calls.assign).toEqual(["smol=openai/gpt-5.6"]);

	// The kind tab and scope clicks land where alt+→ and the sidebar do.
	act("tab", "image");
	expect(props(hub.describe(withPicker)).tab).toBe("image");
	act("tab", "all");
	act("scope", "provider:openai");
	p = props(hub.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(p.order?.filter(entry => typeof entry === "string")).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-mini"]);
	expect(p.actions?.map(action => action.id)).toContain("refresh");

	// Roles scope: roles with their fallback chain one level deep.
	act("scope", "roles");
	p = props(hub.describe(withPicker));
	expect(p.items?.find(entry => entry.id === "fallback:default:0")).toMatchObject({
		label: "openai/gpt-5.6",
		depth: 1,
	});
	expect(p.items?.find(entry => entry.id === "role:default")?.facts).toEqual({ model: "demo/demo", thinking: "off" });
	expect(groups(p)).toContain("Model fallback chains");
	// The head's total counts the rows Tern counts as shown (fallbacks, chains, "New …" rows), so All reads no "N of M".
	expect(p.total).toBe(p.order?.filter(entry => typeof entry === "string").length);

	// Esc leaves search without clearing it; explicit Clear search does that.
	act("scope", "all");
	hub.handleInput("/");
	hub.handleInput("x");
	act("close");
	expect(props(hub.describe(withPicker)).query).toBe("x");
	expect(calls.cancel).toBe(0);
	act("clear");
	expect(props(hub.describe(withPicker)).query).toBe("");
	act("close");
	expect(calls.cancel).toBe(1);
});

test("the Roles view picker names the active preset and ctrl+←/→ switches it", () => {
	const presets = { names: ["fast", "slow"], active: "fast" as string | undefined };
	let revision = 0;
	const switched: string[] = [];
	const base = source({ default: "demo/demo" }, []);
	const hub = new ModelHubComponent(
		ui,
		Object.defineProperty({ ...base, getModelPresets: () => presets }, "revision", { get: () => revision }),
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onSwitchPreset: name => {
				switched.push(name);
				presets.active = name;
				revision++;
			},
		},
	);
	hubs.push(hub);
	const subtitleText = () => {
		const subtitle = props(hub.describe(withPicker)).subtitle;
		return Array.isArray(subtitle) ? subtitle.map(part => part.t).join("") : subtitle;
	};

	hub.handleInput("\x1b[A"); // All models → Roles
	expect(subtitleText()).toStartWith("Preset fast");
	hub.handleInput("\x1b[1;5C");
	expect(switched).toEqual(["slow"]);
	expect(subtitleText()).toStartWith("Preset slow");
	hub.handleInput("\x1b[1;5D");
	expect(switched).toEqual(["slow", "fast"]);
});

test("the quick picker is an md sheet with the summary below and a task-model toggle", () => {
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector) => picked.push(`session:${selector}`),
			onPickTask: (_model, selector) => picked.push(`task:${selector}`),
			onCancel: () => {},
		},
		{ currentSelector: "demo/demo", taskModeKeys: ["alt+p"] },
	);
	expect(picker.describe(withoutPicker).k).not.toBe("picker");
	let root = picker.describe(withPicker);
	let p = props(root);
	expect(p).toMatchObject({ size: "md", preview: "below", title: "Switch model", selected: "demo/demo" });
	expect(p.scopes).toBeUndefined();
	expect(groups(p)).toEqual(["Recent", "All"]);
	expect(root.c?.some(child => prop(child, "layout") === "inline")).toBe(true);

	picker.handleNativeEvent({ type: "action", key: "", act: "task", mods: [] });
	root = picker.describe(withPicker);
	p = props(root);
	expect(p.title).toBe("Switch task model");
	expect(p.actions?.find(action => action.id === "task")?.on).toBe(true);
	picker.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(picked).toEqual(["task:openai/gpt-5.6"]);
});

for (const kind of ["hub", "picker"] as const) {
	test(`${kind} caller synchronizes filter entry and exit with the shared browser`, () => {
		const menu =
			kind === "hub"
				? openHub({ assign: [], cancel: 0 })
				: new ModelPickerComponent(
						ui,
						source({ default: "demo/demo" }, ["demo/demo"]),
						{ ...registry(MODELS), refreshIfStale: async () => false },
						MODELS.map(entry => ({ model: entry })),
						{ onPick: () => {}, onCancel: () => {} },
					);
		menu.handleInput("/");
		for (const character of "jkggG/ ") menu.handleInput(character);
		expect(props(menu.describe(withPicker)).query).toBe("jkggG/ ");
		menu.handleInput("\x1b");
		menu.handleInput("j");
		expect(props(menu.describe(withPicker)).query).toBe("jkggG/ ");
		menu.handleInput("/");
		menu.handleInput("x");
		expect(props(menu.describe(withPicker)).query).toBe("jkggG/ x");
	});
}

test("shows a non-default service tier's own speed aggregate", () => {
	const perf = new Map([
		["openai/gpt-5.6", { samples: 4, tps: 25, ttftMs: 500 }],
		["openai/gpt-5.6@ultrafast", { samples: 2, tps: 300, ttftMs: 120 }],
		["anthropic/claude-opus-5", { samples: 3, tps: 40, ttftMs: 300 }],
		["openai/gpt-5.6-mini@priority", { samples: 1, tps: 90, ttftMs: 200 }],
	]);
	const hub = new ModelHubComponent(
		ui,
		{
			...source({ default: "demo/demo" }, ["demo/demo"]),
			modelPerf: perf,
			serviceTierFor: model => (model.provider === "openai" ? "ultrafast" : undefined),
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	const items = props(hub.describe(withPicker)).items ?? [];
	const speed = (id: string) => items.find(entry => entry.id === id)?.facts?.speed;
	// The tier the host would send wins over the standard aggregate.
	expect(speed("openai/gpt-5.6")).toBe("300 ultrafast");
	// No tier configured for the family: the standard aggregate, unlabeled.
	expect(speed("anthropic/claude-opus-5")).toBe("40");
	// Only a tier aggregate exists: show it rather than nothing.
	expect(speed("openai/gpt-5.6-mini")).toBe("90 priority");
});

test("quick picker keeps literal search separate from navigation and restores its target", () => {
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({}, []),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector) => picked.push(`session:${selector}`),
			onPickTask: (_model, selector) => picked.push(`task:${selector}`),
			onCancel: () => {},
		},
		{ currentSelector: "demo/demo", taskSelector: "openai/gpt-5.6", taskModeKeys: ["alt+p"] },
	);
	picker.handleInput("i");
	expect(props(picker.describe(withPicker)).query).toBe("");
	picker.handleInput("G");
	const selected = props(picker.describe(withPicker)).selected;
	picker.handleInput("\x05");
	expect(props(picker.describe(withPicker)).selected).toBe(selected);
	picker.handleInput("/");
	for (const key of "hjklg/ ") picker.handleInput(key);
	expect(props(picker.describe(withPicker)).query).toBe("hjklg/ ");
	picker.handleInput("\x1b");
	picker.handleNativeEvent({ type: "action", key: "", act: "clear", mods: [] });
	const session = picker.navigationSnapshot();
	picker.handleInput("\t");
	expect(props(picker.describe(withPicker)).title).toBe("Switch task model");
	const task = picker.navigationSnapshot();
	picker.restoreNavigation(session);
	expect(props(picker.describe(withPicker)).title).toBe("Switch model");
	picker.restoreNavigation(task);
	expect(picker.navigationSnapshot()).toEqual(task);
	picker.handleInput(" ");
	expect(picked).toEqual(["task:openai/gpt-5.6"]);
});

test("native model hub exposes effort rules above providers and navigates its editor", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	const scopes = props(hub.describe(withPicker)).scopes?.map(scope => scope.id) ?? [];
	expect(scopes.indexOf("effort")).toBeLessThan(scopes.indexOf("provider:anthropic"));
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "effort", mods: [] });
	expect(props(hub.describe(withPicker)).order).toEqual(["effort:0", "effort:1"]);
	hub.handleInput("l");
	hub.handleInput("G");
	expect(props(hub.describe(withPicker)).selected).toBe("effort:1");
	hub.handleInput(" ");
	for (const key of "re:demo/.*") hub.handleInput(key);
	const draft = hub.navigationSnapshot();
	expect(draft.strip?.kind).toBe("pattern");
	hub.handleInput("\r");
	expect(hub.navigationSnapshot().strip?.kind).toBe("effortLevels");
	hub.handleInput("\x1b");
	let pattern = hub.navigationSnapshot().strip;
	if (pattern?.kind !== "pattern") throw new Error("expected parent pattern editor");
	expect(pattern.input.getValue()).toBe("re:demo/.*");
	hub.handleInput("\x1b"); // Field focus leaves before the page.
	pattern = hub.navigationSnapshot().strip;
	if (pattern?.kind !== "pattern") throw new Error("expected defocused pattern editor");
	expect(pattern.input.focused).toBe(false);
	hub.handleInput("/");
	pattern = hub.navigationSnapshot().strip;
	if (pattern?.kind !== "pattern") throw new Error("expected refocused pattern editor");
	expect(pattern.input.focused).toBe(true);
	expect(pattern.input.getValue()).toBe("re:demo/.*");
	hub.handleInput("\x1b");
	hub.handleInput("\x1b");
	expect(hub.navigationSnapshot().strip).toBeNull();
	expect(hub.navigationSnapshot().entry).toBe("effort");
	hub.restoreNavigation(draft);
	pattern = hub.navigationSnapshot().strip;
	if (pattern?.kind !== "pattern") throw new Error("expected restored pattern editor");
	expect(pattern.input.getValue()).toBe("re:demo/.*");
});

test("hub context switches do not create visits; nested selectors and effort choices do", () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	const visits: string[] = [];
	hub.onNavigationVisit = page => {
		visits.push(page);
	};
	hub.handleInput("k"); // All → Roles is a context, not a nested page.
	hub.handleInput("l");
	const parent = hub.navigationSnapshot();
	expect(visits).toEqual([]);
	hub.handleInput(" ");
	expect(visits).toHaveLength(1);
	let strip = hub.navigationSnapshot().strip;
	if (strip?.kind !== "selectorChoice") throw new Error("expected selector choice");
	expect(strip.index).toBe(0);
	hub.handleInput("j");
	strip = hub.navigationSnapshot().strip;
	if (strip?.kind !== "selectorChoice") throw new Error("expected selector choice");
	expect(strip.index).toBe(1);
	expect(visits).toHaveLength(1);
	hub.handleInput("h"); // Leave chips without committing, switch to scopes.
	expect(hub.navigationSnapshot().strip).toBeNull();
	expect(hub.navigationSnapshot().focus).toBe("scope");
	expect(visits.at(-1)).toBe("");
	expect(calls.assign).toEqual([]);
	hub.restoreNavigation(parent);
	const visitCount = visits.length;
	hub.handleInput("\r");
	hub.handleInput(" "); // Exact-model selector, then model assignment.
	expect(hub.navigationSnapshot().assigning?.kind).toBe("role");
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	strip = hub.navigationSnapshot().strip;
	if (strip?.kind !== "thinking") throw new Error("expected effort chooser");
	hub.handleInput("g");
	hub.handleInput("g");
	hub.handleInput("l");
	strip = hub.navigationSnapshot().strip;
	if (strip?.kind !== "thinking") throw new Error("expected effort chooser");
	expect(strip.index).toBe(1);
	expect(hub.navigationSnapshot().focus).toBe("list");
	hub.handleInput("h");
	strip = hub.navigationSnapshot().strip;
	if (strip?.kind !== "thinking") throw new Error("expected effort chooser");
	expect(strip.index).toBe(0);
	expect(calls.assign).toEqual([]);
	expect(visits.length).toBeGreaterThan(visitCount);
	hub.handleInput("\x1b");
	expect(hub.navigationSnapshot().assigning?.kind).toBe("role");
	hub.handleInput("\x1b");
	expect(hub.navigationSnapshot().strip?.kind).toBe("selectorChoice");
	hub.handleInput("\x1b");
	expect(hub.navigationSnapshot().strip).toBeNull();
	expect(hub.navigationSnapshot().assigning).toBeNull();
	expect(calls.cancel).toBe(0);
	hub.handleInput("\x1b");
	expect(calls.cancel).toBe(1);
});

test("root-role yank includes configured fallbacks when pasted onto another role", () => {
	const chains: Record<string, string[]> = { default: ["openai/gpt-5.6"] };
	const hub = new ModelHubComponent(
		ui,
		{ ...source({ default: "demo/demo" }, []), fallbackChains: chains },
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onFallbackChainChange: (role, chain) => {
				chains[role] = chain;
			},
		},
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	hub.handleInput("y");
	hub.handleNativeEvent({ type: "select", key: "", item: "role:smol" });
	hub.handleInput("p");
	expect(chains.smol).toEqual(["demo/demo", "openai/gpt-5.6"]);
});

test("effort rules share paging, jumps and independent viewport scrolling", () => {
	const rules = Array.from({ length: 50 }, (_, index) => ({ selector: `demo/model-${index}`, allowed: [] }));
	const hub = new ModelHubComponent(
		ui,
		{ ...source({}, []), effortRules: rules },
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "effort", mods: [] });
	hub.render(120);
	hub.handleInput("\x04");
	const half = hub.navigationSnapshot().effortIndex;
	expect(half).toBeGreaterThan(0);
	hub.handleInput("\x1b[6~");
	expect(hub.navigationSnapshot().effortIndex).toBeGreaterThan(half);
	hub.handleInput("G");
	expect(hub.navigationSnapshot().effortIndex).toBe(51);
	hub.handleInput("j");
	expect(hub.navigationSnapshot().effortIndex).toBe(51);
	hub.handleInput("g");
	hub.handleInput("g");
	hub.render(120);
	const first = hub.navigationSnapshot();
	hub.handleInput("\x05");
	hub.render(120);
	expect(hub.navigationSnapshot().effortIndex).toBe(first.effortIndex);
	expect(hub.navigationSnapshot().effortTop).toEqual({ item: (first.effortTop?.item ?? 0) + 1, lineOffset: 0 });
	hub.handleInput("\x19");
	hub.render(120);
	expect(hub.navigationSnapshot().effortTop).toEqual(first.effortTop);
});

test("Roles and model scopes keep separate queries while switching panes", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	hub.handleInput("/");
	for (const key of "sonnet") hub.handleInput(key);
	hub.handleInput("\x1b");
	hub.handleInput("h");
	hub.handleInput("g");
	hub.handleInput("g");
	expect(props(hub.describe(withPicker)).scope).toBe("roles");
	hub.handleInput("l");
	hub.handleInput("/");
	for (const key of "default") hub.handleInput(key);
	hub.handleInput("\x1b");
	expect(props(hub.describe(withPicker)).query).toBe("default");
	hub.handleInput("h");
	hub.handleInput("j");
	expect(props(hub.describe(withPicker)).scope).toBe("all");
	expect(props(hub.describe(withPicker)).query).toBe("sonnet");
});

test("effort rule search stays in section and destructive actions target the filtered source row", () => {
	let rules: HubEffortRule[] = [
		{ selector: "demo/first", allowed: [] },
		{ selector: "demo/needle", allowed: [] },
	];
	const hub = new ModelHubComponent(
		ui,
		{
			...source({}, []),
			get effortRules() {
				return rules;
			},
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onEffortRulesChange: next => {
				rules = next;
			},
		},
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "effort", mods: [] });
	hub.handleInput("/");
	for (const key of "needle") hub.handleInput(key);
	let p = props(hub.describe(withPicker));
	expect(p.scope).toBe("effort");
	expect(p.query).toBe("needle");
	expect(p.order).toEqual(["effort:1"]);
	expect(p.selected).toBe("effort:1");
	hub.handleInput("\x1b");
	const filtered = hub.navigationSnapshot();
	rules = rules.toReversed();
	hub.restoreNavigation(filtered);
	expect(props(hub.describe(withPicker)).selected).toBe("effort:0");
	hub.handleInput("x");
	expect(rules.map(rule => rule.selector)).toEqual(["demo/first"]);
	p = props(hub.describe(withPicker));
	expect(p.order).toEqual([]);
	expect(p.selected).toBeNull();
	hub.restoreNavigation(filtered);
	expect(rules.map(rule => rule.selector)).toEqual(["demo/first"]);
	expect(props(hub.describe(withPicker)).query).toBe("needle");
	hub.handleNativeEvent({ type: "action", key: "", act: "clear", mods: [] });
	expect(props(hub.describe(withPicker)).order).toContain("effort:0");
});

test("provider navigation footer stays concise and counts outside All ignore its retained query", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	const hint = "h/l pane · j/k providers · ⏎ models · / search · Alt+←/→ kind · ⎋ close";
	expect(plainText(hub.render(180).join("\n"))).toContain(hint);
	hub.handleInput("/");
	for (const key of "sonnet") hub.handleInput(key);
	hub.handleInput("\x1b");
	expect(props(hub.describe(withPicker)).scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(0);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	expect(props(hub.describe(withPicker)).scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(2);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "provider:anthropic", mods: [] });
	let p = props(hub.describe(withPicker));
	expect(p.scopes?.find(scope => scope.id === "provider:anthropic")?.count).toBe(2);
	expect(p.scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(2);
	hub.handleInput("h");
	expect(plainText(hub.render(180).join("\n"))).toContain(hint);
	hub.handleInput("G");
	expect(props(hub.describe(withPicker)).scope).toBe("provider:openai");
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "all", mods: [] });
	p = props(hub.describe(withPicker));
	expect(p.query).toBe("sonnet");
	expect(p.scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(0);
});

test("native Close leaves every model-hub search field before closing and names its next step", () => {
	for (const scope of ["all", "roles", "effort"]) {
		const calls = { assign: [] as string[], cancel: 0 };
		const hub = openHub(calls);
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: scope, mods: [] });
		hub.handleInput("/");
		for (const char of "jkl") hub.handleInput(char);
		expect(props(hub.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe(
			"Back to list",
		);
		hub.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(calls.cancel).toBe(0);
		expect(props(hub.describe(withPicker)).query).toBe("jkl");
		expect(props(hub.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe("Close");
		hub.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(calls.cancel).toBe(1);
		expect(calls.assign).toEqual([]);
	}
});

test("native Close names and follows text-field then immediate strip-parent cancellation", () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "effort", mods: [] });
	hub.handleInput("l");
	hub.handleInput("G");
	hub.handleInput(" ");
	for (const char of "re:demo/.*") hub.handleInput(char);
	hub.handleInput("\r");
	expect(hub.navigationSnapshot().strip?.kind).toBe("effortLevels");
	expect(props(hub.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe("Back");
	hub.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(hub.navigationSnapshot().strip?.kind).toBe("pattern");
	expect(props(hub.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe("Leave field");
	hub.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	const pattern = hub.navigationSnapshot().strip;
	if (pattern?.kind !== "pattern") throw new Error("expected defocused pattern");
	expect(pattern.input.focused).toBe(false);
	expect(pattern.input.getValue()).toBe("re:demo/.*");
	expect(props(hub.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe("Back");
	hub.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(hub.navigationSnapshot().strip).toBeNull();
	expect(hub.navigationSnapshot().entry).toBe("effort");
	expect(calls.cancel).toBe(0);
	expect(calls.assign).toEqual([]);
});

test("quick picker native Close leaves literal search, repaints and closes only from the list", () => {
	let closes = 0;
	let renders = 0;
	const picker = new ModelPickerComponent(
		{
			requestRender: () => {
				renders++;
			},
			terminal: { rows: 40 },
		} as unknown as TUI,
		source({}, []),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{
			onPick: () => {},
			onCancel: () => {
				closes++;
			},
		},
	);
	for (const char of "/demo") picker.handleInput(char);
	expect(props(picker.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe(
		"Back to list",
	);
	const before = renders;
	picker.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(renders).toBeGreaterThan(before);
	expect(closes).toBe(0);
	expect(props(picker.describe(withPicker)).query).toBe("demo");
	expect(props(picker.describe(withPicker)).actions?.find(action => action.id === "close")?.label).toBe("Close");
	picker.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(closes).toBe(1);
});
