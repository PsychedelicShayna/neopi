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

function createHub(overrides: Partial<ModelHubSource> = {}): ModelHubComponent {
	const callbacks: ModelHubCallbacks = {
		onAssign: () => true,
		onUnassign: () => {},
		onCancel: () => {},
		onSavePreset: () => {},
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

test("with no query the Roles rows hide the search field and keep their letter commands", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBeNull();

	hub.handleInput("s");
	expect(pickerProps(hub).strip).not.toBeNull();
	hub.dispose();
});

test("slash filters Roles in place and Enter retains query without stealing letter actions", () => {
	const hub = createHub({ knownRoleIds: ["default", "smol"] });
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleInput("i");
	expect(pickerProps(hub).query).toBeNull();
	hub.handleInput("/");
	for (const ch of "default") hub.handleInput(ch);
	let props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.query).toBe("default");
	expect(props.order).toContain("role:default");
	expect(props.order).not.toContain("role:smol");
	hub.handleInput("\n");
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
	const props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.order).toContain("role:smol");
	expect(props.order).toContain("fallback:smol:0");
	expect(props.order).not.toContain("role:default");
	hub.handleInput("\n");
	hub.handleInput("j");
	expect(pickerProps(hub).selected).toBe("fallback:smol:0");
	hub.handleInput(" ");
	expect(pickerProps(hub).strip).not.toBeNull();
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
