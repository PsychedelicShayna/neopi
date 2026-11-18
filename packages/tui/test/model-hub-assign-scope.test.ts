/**
 * Regression for #12692: assign mode for a role must only ever offer models
 * the role's `accepts` predicate admits — even after the user hops scopes in
 * the sidebar while assigning. `#applyScope()` used to rebuild the candidate
 * pool on every hop without re-applying the assigning role's filter, so
 * hopping to a provider whose models the role rejects (LiteLLM for `web`)
 * surfaced its whole catalog; picking one persisted an unresolvable selector.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
	type ScopedModelItem,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// The hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

function model(provider: string, id: string) {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

// `google/web-search-pro` is accepted by the `web` role; `litellm/chat-only`
// is not — mirroring a proxy whose models lack a grounding transport.
const webModel = model("google", "web-search-pro");
const chatModel = model("litellm", "chat-only");

function createSource(): ModelHubSource {
	return {
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
		knownRoleIds: ["web"],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role =>
			role === "web"
				? { tag: "web", name: "Web search", section: "chat", accepts: m => m.provider === "google" }
				: { name: role, section: "chat", accepts: () => true },
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
	};
}

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

function createHub(): { hub: ModelHubComponent; body: () => string; assigned: string[]; key: (data: string) => void } {
	const assigned: string[] = [];
	const callbacks: ModelHubCallbacks = {
		onAssign: (_m, role, _t, selector) => {
			assigned.push(`${role}:${selector}`);
			return true;
		},
		onUnassign: () => {},
		onCancel: () => {},
	};
	const scoped: ScopedModelItem[] = [{ model: webModel }, { model: chatModel }];
	const hub = new ModelHubComponent(tuiStub, createSource(), registryStub, scoped, callbacks);
	return {
		hub,
		body: () => hub.render(120).join("\n").replace(ANSI_PATTERN, ""),
		assigned,
		key: (data: string) => hub.handleInput(data),
	};
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";

/** Enter assign mode for the `web` role: hop up to Roles, dive in, activate the role row, pick "pick model…". */
function startWebAssign(key: (data: string) => void): void {
	key(UP); // all → Roles (scope focus)
	key("\r"); // dive into the roles rows
	key("\r"); // activate the `web` role row → selector-choice strip
	key("\r"); // confirm "pick model…" → assign mode
	key("h"); // return to provider scopes without changing the pending assignment
}

function hopToProvider(hub: ModelHubComponent, provider: string): void {
	const target = `provider:${provider}`;
	const visited = new Set<string>();
	for (;;) {
		const entry = hub.navigationSnapshot().entry;
		if (entry === target) return;
		if (visited.has(entry)) throw new Error(`Cannot reach provider scope ${provider}`);
		visited.add(entry);
		hub.handleInput(DOWN);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

describe("model hub assign mode scope filtering (#12692)", () => {
	test("a provider hop while assigning `web` never offers models the role rejects", () => {
		const { hub, body, key } = createHub();
		startWebAssign(key);
		expect(hub.navigationSnapshot().assigning).toMatchObject({ kind: "role", role: "web" });

		// Scope hopping must reapply role acceptance regardless of the rules sections above providers.
		hopToProvider(hub, "litellm");

		const rendered = body();
		// Post-fix: litellm's chat-only model is filtered out of assign mode.
		expect(rendered).not.toContain("chat-only");
	});

	test("hopping to an eligible provider while assigning still offers its accepted model", () => {
		const { hub, body, key } = createHub();
		startWebAssign(key);
		expect(hub.navigationSnapshot().assigning).toMatchObject({ kind: "role", role: "web" });
		hopToProvider(hub, "google");

		const rendered = body();
		expect(rendered).toContain("web-search-pro");
		expect(rendered).not.toContain("chat-only");
	});

	test("outside assign mode the litellm provider scope still lists its model", () => {
		const { hub, body } = createHub();
		// Without a pending role assignment, the accepts filter must not apply.
		hopToProvider(hub, "litellm");

		const rendered = body();
		expect(rendered).toContain("chat-only");
	});
});

describe("model hub scope after a catalog refresh", () => {
	test("a scope that resolves during the hub's own catalog refresh narrows the open hub", async () => {
		const catalog = () => [webModel, chatModel];
		const registry: ModelHubRegistry = { ...registryStub, getAll: catalog, getAvailable: catalog };
		const callbacks: ModelHubCallbacks = {
			onAssign: () => true,
			onUnassign: () => {},
			onCancel: () => {},
			onCatalogRefreshed: () => [{ model: webModel }],
		};
		const hub = new ModelHubComponent(tuiStub, createSource(), registry, [], callbacks);
		const body = () => hub.render(120).join("\n").replace(ANSI_PATTERN, "");
		expect(body()).toContain("chat-only");

		await Bun.sleep(0);

		expect(body()).toContain("web-search-pro");
		expect(body()).not.toContain("chat-only");
		hub.dispose();
	});
});
