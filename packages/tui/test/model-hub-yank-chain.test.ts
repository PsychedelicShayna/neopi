import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	ModelHubComponent,
	type HubEffortSelection,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "../src/components/menu-navigation";

const PRIMARY = "demo/primary";
const FIRST = "demo/first:low";
const SECOND = "demo/second";
const hubs: ModelHubComponent[] = [];
let previousVimMode = false;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
	for (const hub of hubs.splice(0)) hub.dispose();
});

function createHub(chain = [FIRST, SECOND]) {
	const models = ["primary", "first", "second", "existing"].map(id =>
		buildModel({
			id,
			name: id,
			provider: "demo",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		}),
	);
	const chains: Record<string, string[]> = { default: [...chain] };
	const rolePolicies: Record<string, HubEffortSelection> = {
		default: { mode: "auto", selector: PRIMARY, allowed: [Effort.Low, Effort.High] },
	};
	const fallbackPolicies: Record<string, Record<string, HubEffortSelection>> = {
		default: {
			[FIRST]: { mode: "fixed", level: ThinkingLevel.Low },
			[SECOND]: { mode: "auto", allowed: [Effort.Medium, Effort.High] },
		},
	};
	const assignments: Record<string, string> = { default: PRIMARY, smol: "demo/existing", slow: "demo/existing" };
	const source: ModelHubSource = {
		revision: 0,
		disabledProviders: [],
		fallbackChains: chains,
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => assignments[role],
		getModelRole: role => assignments[role],
		getModelRoleSource: () => "global",
		effortRules: [],
		permittedEfforts: () => [Effort.Low, Effort.Medium, Effort.High],
		getProjectRoleEffortSelection: () => undefined,
		getGlobalRoleEffortSelection: role => rolePolicies[role],
		getRoleEffortSelection: role => rolePolicies[role],
		getFallbackEffortSelection: (role, selector) => fallbackPolicies[role]?.[selector],
		formatModelSelector: model => `${model.provider}/${model.id}`,
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol", "slow"],
		mruOrder: [],
		modelPerf: new Map(),
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, candidates) => ({
			model: candidates.find(model => `${model.provider}/${model.id}` === value),
			explicitThinkingLevel: false,
		}),
	};
	const registry: ModelHubRegistry = {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => undefined } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	};
	const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const hub = new ModelHubComponent(
		ui,
		source,
		registry,
		models.map(model => ({ model })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onFallbackChainChange: (role, next, _effort, copied) => {
				chains[role] = next;
				if (copied) Object.assign((fallbackPolicies[role] ??= {}), copied);
			},
		},
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	const focus = (item: string) => hub.handleNativeEvent({ type: "select", key: "", item });
	return { hub, chains, rolePolicies, fallbackPolicies, focus };
}

test("root yank snapshots the complete ordered chain and effort metadata without overwriting target metadata", () => {
	const state = createHub();
	state.chains.smol = [SECOND];
	state.fallbackPolicies.smol = { [SECOND]: { mode: "fixed", level: ThinkingLevel.Off } };
	state.focus("role:default");
	state.hub.handleInput("y");
	const primaryPolicy = state.rolePolicies.default;
	if (primaryPolicy.mode !== "auto") throw new Error("expected Auto primary");
	primaryPolicy.allowed?.push(Effort.Medium);
	state.fallbackPolicies.default[FIRST] = { mode: "fixed", level: ThinkingLevel.High };
	const secondPolicy = state.fallbackPolicies.default[SECOND];
	if (secondPolicy.mode !== "auto") throw new Error("expected Auto fallback");
	secondPolicy.allowed?.splice(0);
	state.chains.default.reverse();
	state.chains.default.push("demo/changed-after-yank");
	state.focus("role:smol");
	state.hub.handleInput("p");
	expect(state.chains.smol).toEqual([SECOND, PRIMARY, FIRST]);
	expect(state.fallbackPolicies.smol[PRIMARY]).toEqual({
		mode: "auto",
		selector: PRIMARY,
		allowed: [Effort.Low, Effort.High],
	});
	expect(state.fallbackPolicies.smol[FIRST]).toEqual({ mode: "fixed", level: ThinkingLevel.Low });
	expect(state.fallbackPolicies.smol[SECOND]).toEqual({ mode: "fixed", level: ThinkingLevel.Off });

	// A host that stores pasted policy objects directly must not gain a reference to the yank register.
	const pasted = state.fallbackPolicies.smol[PRIMARY];
	if (pasted.mode !== "auto") throw new Error("expected pasted Auto primary");
	pasted.allowed?.splice(0);
	state.focus("role:slow");
	state.hub.handleInput("p");
	expect(state.chains.slow).toEqual([PRIMARY, FIRST, SECOND]);
	expect(state.fallbackPolicies.slow[PRIMARY]).toEqual({
		mode: "auto",
		selector: PRIMARY,
		allowed: [Effort.Low, Effort.High],
	});
	expect(state.fallbackPolicies.slow[FIRST]).toEqual({ mode: "fixed", level: ThinkingLevel.Low });
	expect(state.fallbackPolicies.slow[SECOND]).toEqual({ mode: "auto", allowed: [Effort.Medium, Effort.High] });
});

test("a root without fallbacks still yanks a single model", () => {
	const { hub, chains, focus } = createHub([]);
	focus("role:default");
	hub.handleInput("y");
	focus("role:smol");
	hub.handleInput("p");
	expect(chains.smol).toEqual([PRIMARY]);
});

test("individual fallback y and uppercase Y keep their existing meanings", () => {
	const { hub, chains, focus } = createHub();
	focus("fallback:default:0");
	hub.handleInput("y");
	focus("role:default");
	hub.handleInput("Y"); // Y on a root remains unbound and leaves the single-entry register alone.
	focus("role:smol");
	hub.handleInput("p");
	expect(chains.smol).toEqual([FIRST]);
	focus("fallback:default:0");
	hub.handleInput("Y");
	focus("role:slow");
	hub.handleInput("p");
	expect(chains.slow).toEqual([FIRST, SECOND]);
});

test("plain yank and paste cannot change the register or chains with Vim off", () => {
	setMenuSearchVimMode(false);
	for (const key of ["y", "Y", "p"]) {
		const { hub, chains, focus } = createHub();
		focus("role:default");
		hub.handleInput("\x1by");
		const copied = hub.navigationSnapshot().yankedFallback;
		focus(key === "p" ? "role:smol" : "fallback:default:0");
		hub.handleInput(key);
		expect(hub.navigationSnapshot().yankedFallback).toEqual(copied);
		expect(chains.smol).toBeUndefined();
		expect(chains.default).toEqual([FIRST, SECOND]);
		hub.handleInput("\x1b"); // leave any literal type-to-search draft before selecting the paste target
		focus("role:smol");
		hub.handleInput("\x1bp");
		expect(chains.smol).toEqual([PRIMARY, FIRST, SECOND]);
	}
});

test("Alt yank shortcuts copy individual fallbacks and complete chains with Vim off", () => {
	setMenuSearchVimMode(false);
	const { hub, chains, focus } = createHub();
	focus("fallback:default:0");
	hub.handleInput("\x1by");
	focus("role:smol");
	hub.handleInput("\x1bp");
	expect(chains.smol).toEqual([FIRST]);
	focus("fallback:default:0");
	hub.handleInput("\x1bY");
	focus("role:slow");
	hub.handleInput("\x1bp");
	expect(chains.slow).toEqual([FIRST, SECOND]);
});
