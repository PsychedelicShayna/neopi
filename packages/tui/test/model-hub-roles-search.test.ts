/** Roles search owns literal text only while slash has focused its field. */
import { beforeAll, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";
import { theme } from "../src/theme/theme";

const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

const sonnet = buildModel({
	id: "claude-sonnet",
	name: "claude-sonnet",
	api: "ollama-chat",
	provider: "anthropic",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1024,
});

const source: ModelHubSource = {
	revision: 0,
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
	formatModelSelector: selected => `${selected.provider}/${selected.id}`,
	defaultThinkingLevel: "high",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	getModelRole: () => undefined,
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
};

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

function createHub(
	overrides: Partial<ModelHubSource> = {},
	callbackOverrides: Partial<ModelHubCallbacks> = {},
): ModelHubComponent {
	const callbacks: ModelHubCallbacks = {
		onAssign: () => true,
		onUnassign: () => {},
		onCancel: () => {},
		onSavePreset: () => {},
		...callbackOverrides,
	};
	return new ModelHubComponent(tuiStub, { ...source, ...overrides }, registryStub, [{ model: sonnet }], callbacks);
}

function pickerProps(hub: ModelHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

/** A click on the sidebar's Roles entry: a deliberate dive into the rows. */
const CLICK_ROLES = { type: "select", key: "scopes", item: "roles" } as const;

beforeAll(async () => {
	await initTheme(false);
});

test("role catalog marks fork and latest-upstream roles without changing identifiers", () => {
	const hub = createHub({ knownRoleIds: ["chronicler", "widget"] });
	hub.handleNativeEvent(CLICK_ROLES);
	const props = pickerProps(hub);
	expect(props.order).toContain("role:chronicler");
	expect(props.order).toContain("role:widget");
	const rendered = JSON.stringify(props);
	expect(rendered).toContain(`chronicler ${theme.symbol("provenance.fork")}`);
	expect(rendered).toContain(`widget ${theme.symbol("provenance.newUpstream")}`);
	hub.dispose();
});

test("with no query the Roles rows hide the search field and keep their letter commands", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBeNull();

	hub.handleInput("s");
	expect(pickerProps(hub).strip).not.toBeNull();
	hub.dispose();
});

test("Roles search previews rows live and retains confirmed letter actions", () => {
	const hub = createHub({ knownRoleIds: ["default", "smol"] });
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleInput("i");
	expect(pickerProps(hub).query).toBeNull();
	hub.handleInput("/");
	for (const ch of "default") hub.handleInput(ch);
	let props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.query).toBe("default");
	expect(props.order).not.toContain("role:smol");
	expect(hub.navigationSnapshot().rolesQuery).toBe("default");
	const selected = props.selected;
	const tab = props.tab;
	for (const key of ["\x1b[A", "\x1b[B", "\t", "\x04", "\x1b[1;3C"]) hub.handleInput(key);
	props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.selected).toBe(selected);
	expect(props.tab).toBe(tab);
	expect(hub.navigationSnapshot().filterFocused).toBe(true);
	hub.handleInput("\n");
	props = pickerProps(hub);
	expect(props.order).toContain("role:default");
	expect(props.order).not.toContain("role:smol");
	hub.handleInput("s");
	props = pickerProps(hub);
	expect(props.query).toBe("default");
	expect(props.strip).not.toBeNull();
	hub.dispose();
});

test("fallback search retains its parent role and actions target visible rows", () => {
	const hub = createHub({
		knownRoleIds: ["default", "smol"],
		fallbackChains: { smol: ["example/backup:high"] },
	});
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleInput("/");
	for (const ch of "backup") hub.handleInput(ch);
	hub.handleInput("\n");
	const props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.order).toContain("role:smol");
	expect(props.order).toContain("fallback:smol:0");
	expect(props.order).not.toContain("role:default");
	hub.handleInput("j");
	expect(pickerProps(hub).selected).toBe("fallback:smol:0");
	hub.handleInput(" ");
	expect(pickerProps(hub).strip).not.toBeNull();
	hub.dispose();
});

for (const chainKey of ["default", "example/gpt-6.1-terra"]) {
	test(`Roles regex filters individual fallbacks and edits their original index (${chainKey})`, () => {
		const chains = { [chainKey]: ["example/gpt-6-luna", "example/gpt-6.1-sol"] };
		const changes: { role: string; chain: string[] }[] = [];
		const hub = createHub(
			{
				fallbackChains: chains,
				getModelRole: () => "example/gpt-6.1-terra",
				resolveRoleValue: () => ({
					model: buildModel({ ...sonnet, id: "gpt-6.1-terra", provider: "example" }),
					explicitThinkingLevel: false,
				}),
			},
			{
				onFallbackChainChange: (role, chain) => {
					changes.push({ role, chain });
					chains[role] = chain;
				},
			},
		);
		hub.handleNativeEvent(CLICK_ROLES);
		const header = chainKey === "default" ? "role:default" : `chain:${chainKey}`;
		expect(pickerProps(hub).order).toContain(`fallback:${chainKey}:0`);
		expect(pickerProps(hub).order).toContain(`fallback:${chainKey}:1`);
		hub.handleInput("/");
		for (const ch of "/l$") hub.handleInput(ch);
		hub.handleInput("\n");
		const props = pickerProps(hub);
		expect(props.order?.filter(entry => typeof entry === "string")).toEqual([header, `fallback:${chainKey}:1`]);
		hub.handleInput("j");
		expect(pickerProps(hub).selected).toBe(`fallback:${chainKey}:1`);
		hub.handleInput("\n");
		hub.handleInput("j");
		hub.handleInput("\n");
		expect(JSON.stringify(pickerProps(hub).strip)).toContain("example/gpt-6.1-sol");
		for (const ch of "-edited") hub.handleInput(ch);
		hub.handleInput("\n");
		hub.handleInput("\n");
		expect(changes).toEqual([
			{ role: chainKey, chain: ["example/gpt-6-luna", "example/gpt-6.1-sol-edited"] },
		]);
		hub.dispose();
	});
}

test("Roles own-field matches keep headers without unrelated fallbacks", () => {
	const hub = createHub({
		fallbackChains: {
			default: ["example/gpt-6-luna", "example/gpt-6.1-sol"],
			"example/navigator": ["example/gpt-6-luna", "example/gpt-6.1-sol"],
		},
		getRoleInfo: role => ({ name: role === "default" ? "Navigator" : role, section: "chat", accepts: () => true }),
	});
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleInput("/");
	for (const ch of "navigator") hub.handleInput(ch);
	hub.handleInput("\n");
	expect(pickerProps(hub).order?.filter(entry => typeof entry === "string")).toEqual([
		"role:default",
		"chain:example/navigator",
	]);
	hub.handleInput("\x1b");
	const order = pickerProps(hub).order;
	for (const key of ["default", "example/navigator"]) {
		expect(order).toContain(`fallback:${key}:0`);
		expect(order).toContain(`fallback:${key}:1`);
	}
	hub.dispose();
});

test("Esc restores a confirmed Roles filter before clearing it without leaving Roles", () => {
	const hub = createHub({ knownRoleIds: ["default", "smol"] });
	hub.handleNativeEvent(CLICK_ROLES);
	for (const key of "/default") hub.handleInput(key);
	hub.handleInput("\r");
	expect(pickerProps(hub).order).not.toContain("role:smol");
	hub.handleInput("/");
	hub.handleInput("x");
	hub.handleInput("\x1b");
	expect(pickerProps(hub).query).toBe("default");
	hub.handleInput("\x1b");
	const props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.query).toBeNull();
	expect(props.order).toContain("role:default");
	expect(props.order).toContain("role:smol");
	expect(hub.navigationSnapshot().filterFocused).toBe(false);
	hub.dispose();
});

test("Roles jumps, pages and viewport scrolling skip separators without wrapping", () => {
	const hub = createHub({ knownRoleIds: Array.from({ length: 60 }, (_, index) => `role-${index}`) });
	hub.handleNativeEvent(CLICK_ROLES);
	hub.render(120);
	hub.handleInput("G");
	expect(pickerProps(hub).selected).toBe("newFallback");
	hub.handleInput("j");
	expect(pickerProps(hub).selected).toBe("newFallback");
	hub.handleInput("g");
	hub.handleInput("g");
	expect(pickerProps(hub).selected).toBe("role:role-0");
	hub.handleInput("\x04");
	const half = pickerProps(hub).selected;
	expect(half).not.toBe("role:role-0");
	hub.handleInput("\x1b[6~");
	expect(pickerProps(hub).selected).not.toBe(half);
	hub.handleInput("g");
	hub.handleInput("g");
	hub.render(120);
	const before = hub.navigationSnapshot();
	hub.handleInput("\x05");
	hub.render(120);
	const after = hub.navigationSnapshot();
	expect(after.roleKey).toBe(before.roleKey);
	expect(after.roleTop).toEqual({ item: (before.roleTop?.item ?? 0) + 1, lineOffset: 0 });
	hub.handleInput("\x19");
	hub.render(120);
	expect(hub.navigationSnapshot().roleTop).toEqual(before.roleTop);
	hub.dispose();
});

test("nested Roles editor visits capture the parent and restore drafts silently", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	const visits: { page: string; previous: unknown; next: unknown }[] = [];
	hub.onNavigationVisit = (page, previous) => {
		visits.push({ page, previous, next: hub.navigationSnapshot() });
	};
	const parent = hub.navigationSnapshot();
	hub.handleInput("s");
	expect(visits).toHaveLength(1);
	expect(visits[0]?.previous).toEqual(parent);
	for (const key of "draft hjkl/") hub.handleInput(key);
	const draft = hub.navigationSnapshot();
	hub.restoreNavigation(parent);
	expect(pickerProps(hub).strip).toBeNull();
	hub.restoreNavigation(draft);
	const restored = hub.navigationSnapshot().strip;
	if (restored?.kind !== "name") throw new Error("expected preset-name editor");
	expect(restored.input.getValue()).toBe("draft hjkl/");
	expect(restored.input.getCursor()).toBe("draft hjkl/".length);
	expect(visits).toHaveLength(1);
	hub.dispose();
});
