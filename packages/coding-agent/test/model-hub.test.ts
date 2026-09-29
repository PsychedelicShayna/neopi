import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { afterEach, beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ModelHubCallbacks,
	ModelHubComponent,
	type ModelHubOptions,
	resetProviderAutoRefreshGuard,
} from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import type { TUI } from "@oh-my-pi/pi-tui";

import { cfgCycleOrder } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgEffortRules, cfgFallbackEffortSelections } from "@oh-my-pi/pi-coding-agent/config/effort-policy";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { HubEffortSelection } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

/** The footer row (hint line or an active chip strip) of a rendered frame. */
function footerLine(lines: readonly string[]): string {
	return stripVTControlCharacters(lines[lines.length - 2] ?? "");
}

function makeModel(
	provider: string,
	id: string,
	contextWindow = 128_000,
	cost?: Model["cost"],
	kind?: Model["kind"],
): Model {
	return buildModel({
		id,
		name: id,
		api: kind === "image" ? "openai-images" : "ollama-chat",
		...(kind ? { kind } : {}),
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelHub tests");
	}
	setThemeInstance(testTheme);
}

interface RegistryOverrides {
	refresh?: (mode: string) => Promise<void>;
	refreshProvider?: ModelRegistry["refreshProvider"];
	getAvailable?: () => Model[];
	getAll?: () => Model[];
	getDiscoverableProviders?: () => string[];
	getProviderDiscoveryState?: (providerId: string) => unknown;
	find?: (provider: string, id: string) => Model | undefined;
}

function makeRegistry(models: () => Model[], overrides: RegistryOverrides = {}): ModelRegistry {
	const getAll = overrides.getAll ?? models;
	return {
		refresh: overrides.refresh ?? (async () => {}),
		refreshProvider: overrides.refreshProvider ?? (async () => {}),
		getError: () => undefined,
		getAvailable: overrides.getAvailable ?? models,
		getAll,
		// Mirrors the production lookup's case-insensitivity (alias/variant
		// tables live in the real resolver and need no mock here).
		find:
			overrides.find ??
			((provider: string, id: string) =>
				getAll().find(
					model =>
						model.provider.toLowerCase() === provider.toLowerCase() &&
						model.id.toLowerCase() === id.toLowerCase(),
				)),
		getDiscoverableProviders: overrides.getDiscoverableProviders ?? (() => []),
		getProviderDiscoveryState: overrides.getProviderDiscoveryState ?? (() => undefined),
		authStorage: { keys: { source: () => undefined } },
	} as unknown as ModelRegistry;
}

interface HubHarness {
	hub: ModelHubComponent;
	onAssign: ReturnType<typeof vi.fn>;
	onUnassign: ReturnType<typeof vi.fn>;
	onLoginRequest: ReturnType<typeof vi.fn>;
	onCancel: ReturnType<typeof vi.fn>;
	onFallbackChainChange: Mock<
		(
			role: string,
			chain: string[],
			effort?: { selector: string; selection: HubEffortSelection },
			copiedSelections?: Readonly<Record<string, HubEffortSelection>>,
		) => void
	>;
}

const openHubs: ModelHubComponent[] = [];

function createHub(options: {
	models: Model[] | (() => Model[]);
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	hub?: ModelHubOptions;
	callbacks?: Partial<ModelHubCallbacks>;
	terminalRows?: number;
}): HubHarness {
	installTestTheme();
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = makeRegistry(modelsFn, options.registry);
	const ui = { requestRender: vi.fn(), terminal: { rows: options.terminalRows ?? 40 } } as unknown as TUI;
	const onAssign = vi.fn();
	const onUnassign = vi.fn();
	const onLoginRequest = vi.fn();
	const onCancel = vi.fn();
	// Mirror the controller's chain/metadata result in the isolated overlay used by this UI fixture.
	const onFallbackChainChange = vi.fn(
		(
			role: string,
			chain: string[],
			effort?: { selector: string; selection: HubEffortSelection },
			copiedSelections?: Readonly<Record<string, HubEffortSelection>>,
		) => {
			const chains = { ...cfgRetryFallbackChains.get(settings) };
			if (chain.length === 0) delete chains[role];
			else chains[role] = chain;
			const selections = { ...cfgFallbackEffortSelections.get(settings)[role] };
			for (const selector of Object.keys(selections)) if (!chain.includes(selector)) delete selections[selector];
			if (effort) selections[effort.selector] = effort.selection;
			if (copiedSelections) {
				for (const [selector, selection] of Object.entries(copiedSelections)) {
					if (chain.includes(selector) && !(selector in selections)) selections[selector] = selection;
				}
			}
			cfgRetryFallbackChains.override(settings, chains);
			const stored = { ...cfgFallbackEffortSelections.get(settings) };
			if (chain.length === 0) delete stored[role];
			else stored[role] = selections;
			cfgFallbackEffortSelections.override(settings, stored);
		},
	);
	const hub = new ModelHubComponent(
		ui,
		createModelBrowserSource(settings),
		registry,
		options.scoped ? modelsFn().map(model => ({ model })) : [],
		{
			onAssign: (model, role, level, selector, scope, selection) => {
				const result = options.callbacks?.onAssign
					? options.callbacks.onAssign(model, role, level, selector, scope, selection)
					: onAssign(model, role, level, selector, scope, selection);
				const save = () => {
					if (!selection) return;
					if (scope === "project") settings.setProjectRoleEffortSelection(role, selection);
					else settings.setRoleEffortSelection(role, selection);
				};
				if (result instanceof Promise)
					return result.then(applied => {
						if (applied !== false) save();
						return applied;
					});
				if (result !== false) save();
				return result;
			},
			onUnassign: options.callbacks?.onUnassign ?? onUnassign,
			onLoginRequest: options.callbacks?.onLoginRequest ?? onLoginRequest,
			onDefineMixture: options.callbacks?.onDefineMixture,
			onCycleOrderChange: options.callbacks?.onCycleOrderChange,
			onFallbackChainChange: options.callbacks?.onFallbackChainChange ?? onFallbackChainChange,
			onEffortRulesChange:
				options.callbacks?.onEffortRulesChange ?? (rules => cfgEffortRules.override(settings, rules)),
			onCancel: options.callbacks?.onCancel ?? onCancel,
		},
		options.hub,
	);
	openHubs.push(hub);
	return { hub, onAssign, onUnassign, onLoginRequest, onCancel, onFallbackChainChange };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ALT_RIGHT = "\x1b[1;3C";
/** What macOS terminals (ghostty, Terminal.app, iTerm) emit for Option+→. */
const OPTION_RIGHT_MAC = "\x1bf";
const ESC = "\x1b";

describe("ModelHub", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelHub tests");
		}
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) {
			hub.dispose();
		}
	});

	test("keeps the mixture provider available with zero models and opens its creation action", () => {
		const create = vi.fn();
		const { hub } = createHub({
			models: [],
			hub: {
				initialProviderId: "mixture",
				pinnedProviders: [
					{
						id: "mixture",
						label: "Mixture of Agents",
						action: { label: "+ Define mixture model…", onSelect: create },
					},
				],
			},
		});
		expect(normalize(hub.render(120))).toContain("Mixture of Agents");
		expect(normalize(hub.render(120))).toContain("+ Define mixture model");
		hub.handleInput("\r");
		hub.handleInput("\r");
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("edits a mixture row without assigning it and still allows model assignment", () => {
		const edit = vi.fn();
		const create = vi.fn();
		const { hub, onAssign } = createHub({
			models: [makeModel("mixture", "graph")],
			hub: {
				initialProviderId: "mixture",
				pinnedProviders: [
					{
						id: "mixture",
						label: "Mixture of Agents",
						action: { label: "+ Define mixture model…", onSelect: create },
					},
				],
			},
			callbacks: { onDefineMixture: edit },
		});
		hub.handleInput("\r");
		hub.handleInput(DOWN);
		hub.handleInput("\r");
		expect(create).toHaveBeenCalledTimes(1);
		hub.handleInput(UP);
		hub.handleInput("e");
		expect(edit).toHaveBeenCalledWith("graph");
		expect(onAssign).not.toHaveBeenCalled();
		hub.handleInput("\r");
		hub.handleInput("\r");
		hub.handleInput("\r");
		expect(onAssign).toHaveBeenCalled();
	});

	describe("role chips and roles view", () => {
		test("separates chat and kind roles and filters role tabs", () => {
			const chat = makeModel("test", "chat-model");
			const image = makeModel("test", "image-model", 128_000, undefined, "image");
			const settings = Settings.isolated({
				modelRoles: {
					default: "test/chat-model",
					image: "test/image-model",
				},
			});
			const { hub } = createHub({ models: [chat, image], scoped: true, settings });

			hub.handleInput(UP);
			let lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const chatIndex = lines.findIndex(line => line.includes("DEFAULT"));
			const kindIndex = lines.findIndex(line => line.includes("IMAGE"));
			expect(chatIndex).toBeGreaterThan(-1);
			expect(kindIndex).toBeGreaterThan(chatIndex);
			expect(lines.slice(chatIndex + 1, kindIndex).some(line => line.includes("─"))).toBe(true);

			hub.handleInput(ALT_RIGHT);
			lines = hub.render(220).map(line => stripVTControlCharacters(line));
			expect(lines.some(line => line.includes("DEFAULT"))).toBe(true);
			expect(lines.some(line => line.includes("IMAGE"))).toBe(false);

			hub.handleInput(OPTION_RIGHT_MAC);
			lines = hub.render(220).map(line => stripVTControlCharacters(line));
			expect(lines.some(line => line.includes("DEFAULT"))).toBe(false);
			expect(lines.some(line => line.includes("IMAGE"))).toBe(true);
		});

		test("role assignment candidates honor the role's accepted model kinds", () => {
			const chat = makeModel("test", "chat-model");
			const image = makeModel("test", "image-model", 128_000, undefined, "image");
			const { hub } = createHub({ models: [chat, image], scoped: true });

			hub.handleInput(UP);
			hub.handleInput(ALT_RIGHT);
			hub.handleInput(ALT_RIGHT);
			hub.handleInput("\n");
			hub.handleInput("\n");
			hub.handleInput("\n"); // conventional exact-model picker

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("Assigning IMAGE");
			expect(rendered).toContain("image-model");
			expect(rendered).not.toContain("chat-model");
		});

		test("tags the selected model's roles in the detail line, including custom roles", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
			const settings = Settings.isolated({
				cycleOrder: ["smol", "custom-fast", "default"],
				modelRoles: {
					default: `${model.provider}/${model.id}`,
					"custom-fast": `${model.provider}/${model.id}:low`,
					smol: `${model.provider}/${model.id}`,
				},
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("● default");
			expect(rendered).toContain("● custom-fast");
			// Explicit :low suffix surfaces as the low thinking glyph on the chip.
			expect(rendered).toContain("◔");
			expect(rendered).toContain("● smol");
		});

		test("list rows carry no role chips; only the selected model's detail line is tagged", () => {
			const settings = Settings.isolated({});
			const haiku = makeModel("test", "claude-haiku-4.5");
			const codex = makeModel("test", "gpt-5.1-codex");
			const { hub } = createHub({ models: [codex, haiku], scoped: true, settings });
			installTestTheme();

			const rendered = normalize(hub.render(220));
			// Auto-selection tags smol → haiku and slow → codex, but only the
			// selected model's chips render (in the detail line). With row
			// chips both would appear at once.
			const hollow = ["○ smol", "○ slow"].filter(chip => rendered.includes(chip));
			expect(hollow).toHaveLength(1);
			expect(rendered).not.toContain("● smol");
		});

		test("roles view reflects auto thinking from defaultThinkingLevel and :auto suffixes", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({
				defaultThinkingLevel: AUTO_THINKING,
				modelRoles: {
					default: `${model.provider}/${model.id}`,
					smol: `${model.provider}/${model.id}:auto`,
				},
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const defaultRow = lines.find(line => line.includes("DEFAULT"));
			const smolRow = lines.find(line => line.includes("SMOL"));
			expect(defaultRow).toContain("auto");
			expect(defaultRow).not.toContain("inherit");
			expect(smolRow).toContain("auto");
		});
		test("thinking-only edits preserve the model and scope from the persisted role layer", () => {
			const storedModel = makeModel("test", "global-role-model");
			const effectiveModel = makeModel("test", "runtime-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("default", `${storedModel.provider}/${storedModel.id}`);
			settings.overrideModelRoles({ default: `${effectiveModel.provider}/${effectiveModel.id}` });
			const { hub, onAssign } = createHub({ models: [storedModel, effectiveModel], scoped: true, settings });

			hub.handleInput(UP); // All models → Roles.
			hub.handleInput("\n"); // Dive into role rows on DEFAULT.
			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // Inherit → off.
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[0]).toBe(storedModel);
			expect(onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(onAssign.mock.calls[0]?.[4]).toBe("global");
		});

		test("x clears a configured role back to auto-selection", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({
				modelRoles: { smol: "test/worker-model" },
			});
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					// Emulate the controller: clearing deletes the persisted role.
					onUnassign: role => settings.setModelRole(role, undefined),
				},
			});
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (top of the sidebar)
			hub.handleInput("\n"); // dive into the role rows
			hub.handleInput(DOWN); // default → smol row
			hub.handleInput("x");

			expect(settings.getModelRole("smol")).toBeUndefined();
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const smolRow = lines.find(line => line.includes("SMOL"));
			// No auto candidate resolves for this synthetic model, so the row
			// reads as unassigned instead of keeping the cleared value.
			expect(smolRow).not.toContain("worker-model");
			expect(smolRow).toContain("—");
		});
	});

	describe("model kind tabs", () => {
		test("filters the browser to the selected catalog kind", () => {
			const chat = makeModel("test", "chat-model");
			const image = makeModel("test", "image-model", 128_000, undefined, "image");
			const { hub } = createHub({ models: [chat, image], scoped: true });

			const initial = normalize(hub.render(220));
			expect(initial).toContain("Kind:");
			expect(initial).toContain("all");
			expect(initial).toContain("chat");
			expect(initial).toContain("image");
			hub.handleInput(ALT_RIGHT);
			hub.handleInput(ALT_RIGHT);
			hub.handleInput(ALT_RIGHT);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("image-model");
			expect(rendered).not.toContain("chat-model");
		});
	});

	describe("hop focus stability", () => {
		test("hopping onto Roles keeps provider navigation instead of capturing the arrows", () => {
			const model = makeModel("prov-a", "model-a");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			// The roles view shows as a preview, but arrows keep hopping.
			expect(footerLine(hub.render(220))).toContain("→ roles");
			hub.handleInput(DOWN); // continues to All models — not a role row
			expect(normalize(hub.render(220))).toContain("All available models");
		});

		test("while searching, the hop skips Roles", () => {
			const model = makeModel("prov-a", "target-model");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "target") hub.handleInput(ch);
			hub.handleInput(LEFT); // switch focus to sidebar
			hub.handleInput(UP); // skips Roles → wraps to prov-a
			expect(normalize(hub.render(220))).toContain("prov-a ·");
			expect(footerLine(hub.render(220))).not.toContain("→ roles");
		});

		test("provider sidebar counts agree with the free keyword", () => {
			// Regression: the sidebar counts come from the hub's own filter, so
			// if only the browser learned the cost keyword a free provider would
			// render 0, gray out, and drop out of the scope hop while its rows
			// were still listed.
			const { hub } = createHub({
				models: [
					makeModel("nvidia", "nemotron-3-nano"),
					makeModel("anthropic", "claude-sonnet-4-5", 128_000, {
						input: 3,
						output: 15,
						cacheRead: 0.3,
						cacheWrite: 3.75,
					}),
				],
			});
			installTestTheme();

			for (const ch of "free") hub.handleInput(ch);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("All models 1");
			expect(rendered).toContain("nvidia 1");
			expect(rendered).toContain("anthropic 0");
		});
	});

	describe("sidebar rebuild during navigation", () => {
		test("keeps focus on a surviving provider when the focused entry vanishes on refresh", async () => {
			vi.useFakeTimers();
			try {
				const models = [makeModel("alpha", "m"), makeModel("beta", "m"), makeModel("gamma", "m")];
				// A keyless discoverable local endpoint: starts visible (discovery
				// "empty"), then its on-focus refresh finds it unreachable and it
				// flips to hidden (optional + "unavailable"), vanishing from the list.
				let localStatus = "empty";
				const { hub } = createHub({
					models,
					registry: {
						getDiscoverableProviders: () => ["delta-local"],
						getProviderDiscoveryState: providerId =>
							providerId === "delta-local" ? { optional: true, status: localStatus } : undefined,
						refreshProvider: async providerId => {
							if (providerId === "delta-local") localStatus = "unavailable";
						},
					},
				});
				installTestTheme();

				// Sidebar order: Roles, All models, [sep], alpha, beta, delta-local, gamma.
				// Hop down onto the keyless provider, which schedules its refresh.
				hub.handleInput(DOWN); // all → alpha
				hub.handleInput(DOWN); // alpha → beta
				hub.handleInput(DOWN); // beta → delta-local
				expect(normalize(hub.render(220))).toContain("delta-local ·");

				// Fire the debounced on-focus refresh, then flush the async rebuild
				// (refreshProvider resolves on a microtask before #syncFromRegistryState).
				vi.advanceTimersByTime(200);
				await Promise.resolve();
				await Promise.resolve();

				// delta-local is gone; focus must land on the neighbouring provider,
				// not snap back to "All models" at the top.
				const rendered = normalize(hub.render(220));
				expect(rendered).not.toContain("All available models");
				expect(rendered).toContain("gamma ·");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("typing focus", () => {
		test("typing on All models switches focus to model list and navigates results with arrows", () => {
			const modelA = makeModel("test", "model-a");
			const modelB = makeModel("test", "model-b");
			const { hub, onAssign } = createHub({ models: [modelA, modelB], scoped: true });
			installTestTheme();

			// Initial state: scope focus (sidebar)
			expect(footerLine(hub.render(220))).toContain("Enter/→ models · ↑/↓ providers");

			// Type to search
			for (const ch of "model") hub.handleInput(ch);

			// Focus is now on the model list
			expect(footerLine(hub.render(220))).toContain("↑/↓ models · ← providers");

			// Down arrow navigates within the model list (from model-a to model-b)
			hub.handleInput(DOWN);
			hub.handleInput("\n"); // open role strip for model-b
			expect(footerLine(hub.render(220))).toContain("model-b →");

			hub.handleInput("\n"); // assign to default
			hub.handleInput("\n"); // confirm effort, then persist assignment
			expect(onAssign.mock.calls[0]?.[0]).toBe(modelB);
		});

		test("typing while on Roles in scope focus switches to All models and focuses model list", () => {
			const model = makeModel("prov-a", "target-model");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (scope focus)
			expect(footerLine(hub.render(220))).toContain("→ roles");

			// Typing a search character switches away from Roles to All models and focuses list
			hub.handleInput("t");
			expect(normalize(hub.render(220))).toContain("All available models");
			expect(footerLine(hub.render(220))).toContain("↑/↓ models · ← providers");
		});

		test("typing while on a locked provider in scope focus switches to All models and focuses model list", () => {
			const model = makeModel("anthropic", "claude-locked-test");
			const { hub } = createHub({
				models: [model],
				registry: { getAvailable: () => [] },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → locked anthropic
			expect(normalize(hub.render(220))).toContain("anthropic has no credentials configured");
			expect(footerLine(hub.render(220))).toContain("Enter log in");

			// Typing a search character switches to All models and focuses list
			hub.handleInput("t");
			expect(normalize(hub.render(220))).toContain("All available models");
			expect(footerLine(hub.render(220))).toContain("↑/↓ models · ← providers");
		});
	});

	describe("quick-switch cycle and custom roles", () => {
		test("c toggles cycle membership, [ reorders, and the preview tracks the order", () => {
			const model = makeModel("test", "cycle-model");
			const settings = Settings.isolated({});
			const changes: string[][] = [];
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					onCycleOrderChange: order => {
						changes.push([...order]);
						cfgCycleOrder.set(settings, order);
					},
				},
			});
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows; cursor on DEFAULT

			// Default cycle is [smol, default, slow]: c removes default…
			hub.handleInput("c");
			expect(changes[0]).toEqual(["smol", "slow"]);
			// …c again re-appends it at the end…
			hub.handleInput("c");
			expect(changes[1]).toEqual(["smol", "slow", "default"]);
			// …and [ moves it one slot earlier.
			hub.handleInput("[");
			expect(changes[2]).toEqual(["smol", "default", "slow"]);

			// The preview line renders the resulting ctrl+p track in order.
			const preview = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("cycle:"));
			expect(preview).toBeDefined();
			const previewText = preview ?? "";
			expect(previewText.indexOf("smol")).toBeGreaterThan(-1);
			expect(previewText.indexOf("smol")).toBeLessThan(previewText.indexOf("default"));
			expect(previewText.indexOf("default")).toBeLessThan(previewText.indexOf("slow"));
		});

		test("separates the quick-cycle icon from its ordinal", () => {
			const model = makeModel("test", "cycle-model");
			const settings = Settings.isolated({
				cycleOrder: ["default"],
				modelRoles: { default: `${model.provider}/${model.id}` },
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });

			hub.handleInput(UP); // All models → Roles.
			const defaultRow = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("DEFAULT"));

			expect(defaultRow).toContain(`${theme.icon.loop} 1`);
		});

		test("the + New role row names a custom role and jumps into assigning it", () => {
			const model = makeModel("test", "reviewer-model");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows
			hub.handleInput(UP); // wraps to the trailing "+ New fallback…" row
			hub.handleInput(UP); // skips the section divider up to "+ New role…"
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toContain("New role name:");

			for (const ch of "reviewer") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Assigning reviewer");

			hub.handleInput("\n"); // sidebar → model list
			hub.handleInput("\n"); // pick the sole model for the new role
			hub.handleInput("\n"); // Confirm staged effort.
			expect(onAssign).toHaveBeenCalledTimes(1);
			const call = onAssign.mock.calls[0];
			expect(call?.[1]).toBe("reviewer");
			expect(call?.[3]).toBe("test/reviewer-model");
		});
	});

	describe("assignment strips", () => {
		test("stage selector and effort together, then persist once on confirmation", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled reasoning model");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			hub.handleInput("\n"); // model list
			hub.handleInput("\n"); // role strip
			hub.handleInput("\n"); // effort strip
			expect(onAssign).not.toHaveBeenCalled();
			expect(footerLine(hub.render(220))).toContain("xhigh");
			expect(footerLine(hub.render(220))).not.toContain("max");
			hub.handleInput("\x1b[C"); // off
			hub.handleInput("\n");
			expect(onAssign).toHaveBeenCalledTimes(1);
			expect(onAssign.mock.calls[0]?.[0]).toBe(model);
			expect(onAssign.mock.calls[0]?.[5]).toEqual({ mode: "fixed", level: ThinkingLevel.Off });
		});
		test("awaits an async default assignment and does not recommit its preselected thinking", async () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const assignment = Promise.withResolvers<boolean>();
			const onAssign = vi.fn(() => assignment.promise);
			const { hub } = createHub({ models: [model], scoped: true, callbacks: { onAssign } });

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n"); // Open role strip.
			hub.handleInput("\n"); // Stage default; thinking strip opens without writing.
			expect(onAssign).not.toHaveBeenCalled();
			hub.handleInput("\n"); // Confirm inherit and begin async assignment.
			expect(onAssign).toHaveBeenCalledTimes(1);
			expect(normalize(hub.render(220))).toContain("Applying model");
			hub.handleInput("\n"); // A repeated Enter while persistence is pending is ignored.
			expect(onAssign).toHaveBeenCalledTimes(1);
			assignment.resolve(true);
			await assignment.promise;
			await Promise.resolve();
			expect(onAssign).toHaveBeenCalledTimes(1);
		});
		test("retains a failed async role draft for retry without persisting it", async () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({});
			const assignment = Promise.withResolvers<boolean>();
			let attempts = 0;
			const onAssign = vi.fn(() => (attempts++ === 0 ? assignment.promise : true));
			const { hub } = createHub({ models: [model], scoped: true, settings, callbacks: { onAssign } });

			hub.handleInput("\n"); // Select model.
			hub.handleInput("\n"); // Select role.
			hub.handleInput("\n"); // Select effort.
			hub.handleInput("\n"); // First save fails asynchronously.
			assignment.resolve(false);
			await assignment.promise;
			await Promise.resolve();
			expect(settings.getGlobalRoleEffortSelection("default")).toBeUndefined();

			hub.handleInput("\n"); // Retry the same draft.
			expect(onAssign).toHaveBeenCalledTimes(2);
			expect(settings.getGlobalRoleEffortSelection("default")).toEqual({ mode: "inherit" });
		});
		test("ignores changes to staged effort while async persistence is pending", async () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({});
			const pending = Promise.withResolvers<boolean>();
			const onAssign = vi.fn(() => pending.promise);
			const { hub } = createHub({ models: [model], scoped: true, settings, callbacks: { onAssign } });

			hub.handleInput("\n"); // Select model.
			hub.handleInput("\n"); // Select role.
			hub.handleInput("\n"); // Open effort choices.
			hub.handleInput("\x1b[C"); // Inherit → Off.
			hub.handleInput("\n"); // Begin async save.
			hub.handleInput("\x1b[C"); // Attempt to change the pending choice.
			hub.handleInput("\n"); // Attempt a duplicate save.
			expect(onAssign).toHaveBeenCalledTimes(1);
			pending.resolve(true);
			await pending.promise;
			await Promise.resolve();
			expect(settings.getGlobalRoleEffortSelection("default")).toEqual({ mode: "fixed", level: ThinkingLevel.Off });
		});
		test("project storage exposes project and global role actions with callback scopes", () => {
			const model = makeModel("test", "scoped-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const projectHarness = createHub({ models: [model], scoped: true, settings });

			projectHarness.hub.handleInput("\n"); // Sidebar → model list.
			projectHarness.hub.handleInput("\n");
			const projectStrip = footerLine(projectHarness.hub.render(220));
			expect(projectStrip).toContain("project default");
			expect(projectStrip).toContain("global default");
			projectHarness.hub.handleInput("\n");
			projectHarness.hub.handleInput("\n"); // Confirm inherited effort.
			expect(projectHarness.onAssign.mock.calls[0]?.[4]).toBe("project");

			const globalHarness = createHub({ models: [model], scoped: true, settings });
			globalHarness.hub.handleInput("\n"); // Sidebar → model list.
			globalHarness.hub.handleInput("\n");
			globalHarness.hub.handleInput(DOWN);
			globalHarness.hub.handleInput("\n");
			globalHarness.hub.handleInput("\n"); // Confirm inherited effort.
			expect(globalHarness.onAssign.mock.calls[0]?.[4]).toBe("global");
		});
		test("shadowed global assignments unassign from the global chip", () => {
			const globalModel = makeModel("test", "a-global-role-model");
			const projectModel = makeModel("test", "z-project-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("default", `${globalModel.provider}/${globalModel.id}`);
			settings.setProjectModelRole("default", `${projectModel.provider}/${projectModel.id}`);
			const { hub, onAssign, onUnassign } = createHub({
				models: [globalModel, projectModel],
				scoped: true,
				settings,
			});

			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput(DOWN); // Effective project model → shadowed global model.
			hub.handleInput("\n");
			hub.handleInput(DOWN); // Project default → global default.
			hub.handleInput("\n");

			expect(onUnassign).toHaveBeenCalledWith("default", "global");
			expect(onAssign).not.toHaveBeenCalled();
		});
		test("overlay tombstones do not hide stored scoped default assignments", async () => {
			const model = makeModel("test", "claude-haiku-4.5");
			const selector = `${model.provider}/${model.id}`;
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-model-hub-"));
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const overlayPath = path.join(root, "overlay.yml");

			try {
				await Bun.write(
					path.join(agentDir, "config.yml"),
					`modelRoleStorage: project\nmodelRoles:\n  default: ${selector}\n  smol: ${selector}\n`,
				);
				await Bun.write(
					path.join(cwd, ".omp", "config.yml"),
					`modelRoles:\n  default: ${selector}\n  smol: ${selector}\n`,
				);
				await Bun.write(overlayPath, "modelRoles:\n  default: null\n  smol: null\n");
				const settings = await Settings.loadReadOnly({ cwd, agentDir, configFiles: [overlayPath] });
				expect(settings.getModelRole("default")).toBeUndefined();
				expect(settings.getGlobalModelRole("default")).toBe(selector);
				expect(settings.getProjectModelRole("default")).toBe(selector);

				const projectDefault = createHub({ models: [model], scoped: true, settings });
				expect(normalize(projectDefault.hub.render(220))).toContain("○ smol");
				projectDefault.hub.handleInput("\n"); // Sidebar → model list.
				projectDefault.hub.handleInput("\n");
				projectDefault.hub.handleInput("\n");
				expect(projectDefault.onUnassign).toHaveBeenCalledWith("default", "project");
				expect(projectDefault.onAssign).not.toHaveBeenCalled();

				const globalDefault = createHub({ models: [model], scoped: true, settings });
				globalDefault.hub.handleInput("\n"); // Sidebar → model list.
				globalDefault.hub.handleInput("\n");
				globalDefault.hub.handleInput(DOWN);
				globalDefault.hub.handleInput("\n");
				expect(globalDefault.onUnassign).toHaveBeenCalledWith("default", "global");
				expect(globalDefault.onAssign).not.toHaveBeenCalled();

				const projectAutoSelected = createHub({ models: [model], scoped: true, settings });
				projectAutoSelected.hub.handleInput("\n"); // Sidebar → model list.
				projectAutoSelected.hub.handleInput("\n");
				projectAutoSelected.hub.handleInput(DOWN);
				projectAutoSelected.hub.handleInput(DOWN);
				projectAutoSelected.hub.handleInput("\n");
				expect(projectAutoSelected.onUnassign).toHaveBeenCalledWith("smol", "project");
				expect(projectAutoSelected.onAssign).not.toHaveBeenCalled();

				const globalAutoSelected = createHub({ models: [model], scoped: true, settings });
				globalAutoSelected.hub.handleInput("\n"); // Sidebar → model list.
				globalAutoSelected.hub.handleInput("\n");
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput("\n");
				expect(globalAutoSelected.onUnassign).toHaveBeenCalledWith("smol", "global");
				expect(globalAutoSelected.onAssign).not.toHaveBeenCalled();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});

		test("auto-selected roles remain assignable when the selected scope has no stored role", () => {
			const model = makeModel("test", "claude-haiku-4.5");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const { hub, onAssign, onUnassign } = createHub({ models: [model], scoped: true, settings });
			expect(normalize(hub.render(220))).toContain("○ smol");

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			hub.handleInput("\n");
			hub.handleInput("\n"); // Confirm staged effort.

			expect(onAssign.mock.calls[0]?.[1]).toBe("smol");
			expect(onAssign.mock.calls[0]?.[4]).toBe("project");
			expect(onUnassign).not.toHaveBeenCalled();
		});

		test("global assignments preserve thinking from the global role instead of the project override", () => {
			const configuredModel = getBundledModel("openai", "gpt-5.5");
			const targetModel = getBundledModel("openai", "gpt-5.6");
			if (!configuredModel || !targetModel) {
				throw new Error("Expected bundled OpenAI models for scoped thinking test");
			}
			const selector = `${configuredModel.provider}/${configuredModel.id}`;
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("smol", `${selector}:low,missing/unavailable:high`);
			settings.setModelRole("default", "@smol");
			settings.setProjectModelRole("smol", `${selector}:high`);
			settings.setProjectModelRole("default", "@smol");
			const { hub, onAssign } = createHub({ models: [configuredModel, targetModel], scoped: true, settings });

			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput(DOWN); // Effective configured model → assignment target.
			hub.handleInput("\n");
			hub.handleInput(DOWN); // Project default → global default.
			hub.handleInput("\n");
			hub.handleInput("\n"); // Confirm preserved global effort.

			expect(onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Low);
			expect(onAssign.mock.calls[0]?.[4]).toBe("global");
			expect(onAssign).toHaveBeenCalledTimes(1);
		});
		test("project-scope alias falls back to the global role when the project role is absent", () => {
			const configuredModel = getBundledModel("openai", "gpt-5.5");
			const targetModel = getBundledModel("openai", "gpt-5.6");
			if (!configuredModel || !targetModel) {
				throw new Error("Expected bundled OpenAI models for project alias fallback test");
			}
			const selector = `${configuredModel.provider}/${configuredModel.id}`;
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			// Global smol selects a concrete model with :low plus an unavailable
			// fallback — the alias must resolve to this, not built-in priority.
			settings.setModelRole("smol", `${selector}:low,missing/unavailable:high`);
			// Global default also points at @smol — another project/effective
			// conflict that would expose merged-resolution contamination if the
			// alias lookup consulted merged settings instead of project-first.
			settings.setModelRole("default", "@smol");
			// Project default is @smol; project smol is absent — the alias must
			// fall back to the global smol, not built-in priority defaults.
			settings.setProjectModelRole("default", "@smol");

			// Assignment thinking: the preserved level comes from the global
			// smol fallback (:low), not built-in priority defaults (Inherit).
			const assignHub = createHub({ models: [configuredModel, targetModel], scoped: true, settings });
			assignHub.hub.handleInput("\t"); // Sidebar → model list.
			assignHub.hub.handleInput(DOWN); // gpt-5.5 → gpt-5.6.
			assignHub.hub.handleInput("\n"); // Open the role strip for gpt-5.6.
			assignHub.hub.handleInput("\n"); // Assign to "project default" (first chip).
			assignHub.hub.handleInput("\n"); // Confirm preserved project effort.
			expect(assignHub.onAssign).toHaveBeenCalledTimes(1);
			expect(assignHub.onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(assignHub.onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Low);
			expect(assignHub.onAssign.mock.calls[0]?.[4]).toBe("project");

			// Chip classification: on gpt-5.5, the project default chip is
			// "assigned here" because @smol falls back to global smol → gpt-5.5.
			const classifyHub = createHub({ models: [configuredModel, targetModel], scoped: true, settings });
			classifyHub.hub.handleInput("\t"); // Sidebar → model list.
			classifyHub.hub.handleInput("\n"); // Open the role strip for gpt-5.5.
			classifyHub.hub.handleInput("\n"); // Select "project default" (first chip).
			expect(classifyHub.onUnassign).toHaveBeenCalledWith("default", "project");
			expect(classifyHub.onAssign).not.toHaveBeenCalled();
		});

		test("renders max as a real final tier on max-capable models (gpt-5.6)", () => {
			const model = getBundledModel("openai", "gpt-5.6");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.6");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput("\n");
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("xhigh");
			expect(thinking).toContain("max");
		});

		test("Enter on a chip already holding this model unassigns it", () => {
			const model = makeModel("test", "toggled-model");
			const settings = Settings.isolated({ modelRoles: { smol: "test/toggled-model" } });
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					onUnassign: (role, scope) => {
						if (scope === "global") settings.setModelRole(role, undefined);
					},
				},
			});
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n"); // role strip
			hub.handleInput(DOWN); // default → smol chip (down moves right)
			hub.handleInput("\n");

			expect(settings.getGlobalModelRole("smol")).toBeUndefined();
		});

		test("role strip offers only roles the model can fill", () => {
			const chat = makeModel("test", "chat-model");
			const search = makeModel("web", "perplexity", 128_000, undefined, "search");
			const { hub } = createHub({ models: [chat, search], scoped: true });
			hub.handleInput("\t");

			for (const ch of "chat-model") hub.handleInput(ch);
			hub.handleInput("\n");
			const chatStrip = footerLine(hub.render(400));
			expect(chatStrip).toContain("default");
			expect(chatStrip).toContain("smol");
			expect(chatStrip).toContain("judge");
			expect(chatStrip).toContain("retry-fallback");
			expect(chatStrip).not.toContain("image");
			expect(chatStrip).not.toContain("web");
			expect(chatStrip).not.toContain("speech");
			expect(chatStrip).not.toContain("dictation");
			hub.handleInput(ESC);

			hub.handleInput(ESC); // clear query
			for (const ch of "perplexity") hub.handleInput(ch);
			hub.handleInput("\n");
			const searchStrip = footerLine(hub.render(400));
			expect(searchStrip).toContain("web");
			expect(searchStrip).toContain("fallbacks:perplexity");
			expect(searchStrip).not.toContain("default");
			expect(searchStrip).not.toContain("smol");
			expect(searchStrip).not.toContain("judge");
			expect(searchStrip).not.toContain("retry-fallback");
		});

		test("retry fallback is staged until effort confirmation, and cancel makes no change", () => {
			const model = makeModel("test", "retry-fallback-model");
			const settings = Settings.isolated({});
			const { hub, onAssign, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });
			hub.handleInput("\n"); // model list
			hub.handleInput("\n"); // role strip
			hub.handleInput(LEFT); // retry fallback
			hub.handleInput("\n"); // effort strip, still uncommitted
			expect(onFallbackChainChange).not.toHaveBeenCalled();
			hub.handleInput(ESC);
			expect(cfgRetryFallbackChains.get(settings).default).toBeUndefined();
			expect(onAssign).not.toHaveBeenCalled();
			const resumed = createHub({ models: [model], scoped: true, settings });
			resumed.hub.handleInput("\n");
			resumed.hub.handleInput("\n");
			resumed.hub.handleInput(LEFT);
			resumed.hub.handleInput("\n");
			resumed.hub.handleInput("\n"); // confirm Inherit
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/retry-fallback-model"]);
			expect(cfgFallbackEffortSelections.get(settings).default?.["test/retry-fallback-model"]).toEqual({
				mode: "inherit",
			});
		});

		test("overflowing role strip scrolls left so the selected chip stays visible", () => {
			const model = makeModel("test", "narrow-strip-model");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n"); // open the role strip
			// At full width every chip fits and no left ellipsis appears.
			expect(footerLine(hub.render(220))).not.toContain("…");

			hub.handleInput(LEFT); // wrap to the trailing retry-fallback chip
			const narrow = footerLine(hub.render(80));
			expect(narrow).toContain("[ retry-fallback ]");
			expect(narrow).toContain("…");

			// Back on the first chip the window resets — no leading ellipsis.
			hub.handleInput("\x1b[C"); // wrap right back to the first chip
			const reset = footerLine(hub.render(80));
			expect(reset).toContain("[ default");
			expect(reset.trimStart().startsWith("…")).toBe(false);
		});
	});

	describe("fallback chains in the roles view", () => {
		/** Hop to the Roles sidebar entry and dive into its rows. */
		function enterRolesView(hub: ModelHubComponent): void {
			hub.handleInput(UP); // All models → Roles
			hub.handleInput("\n"); // dive into the rows
		}

		test("renders configured chain entries as indented rows under their role", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("f on a role offers exact or pattern and saves fallback effort with its selector", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({});
			const { hub, onFallbackChainChange, onAssign } = createHub({ models: [a], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput("f");
			expect(footerLine(hub.render(220))).toContain("pick model");
			expect(footerLine(hub.render(220))).toContain("pattern");
			hub.handleInput("\n"); // exact model picker
			hub.handleInput("\n"); // sidebar → model list
			hub.handleInput("\n"); // model → effort choices
			hub.handleInput("\n"); // Inherit
			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/model-a"], {
				selector: "test/model-a",
				selection: { mode: "inherit" },
			});
			expect(onAssign).not.toHaveBeenCalled();
			expect(normalize(hub.render(220))).toContain("↳ test/model-a");
		});

		test("pattern entry creates a fallback with its own Auto set", () => {
			const settings = Settings.isolated({});
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput("f");
			hub.handleInput("\x1b[C"); // pattern…
			hub.handleInput("\n");
			for (const ch of "test/*") hub.handleInput(ch);
			hub.handleInput("\n"); // model pattern → effort options
			hub.handleInput("\x1b[C"); // Off
			hub.handleInput("\x1b[C"); // Auto
			hub.handleInput("\n"); // allowed levels
			hub.handleInput(" "); // exclude minimal
			hub.handleInput("\n"); // save
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/*"]);
			expect(cfgFallbackEffortSelections.get(settings).default?.["test/*"]).toEqual({
				mode: "auto",
				allowed: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			});
		});

		test("x removes a chain entry and Enter on an entry replaces it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its first chain entry (model-a)
			hub.handleInput("\n"); // exact/pattern choice
			hub.handleInput("\n"); // exact picker
			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n"); // model → effort choices
			hub.handleInput("\n"); // Inherit
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"], {
				selector: "test/model-b",
				selection: { mode: "inherit" },
			});

			hub.handleInput("x"); // cursor landed on the replaced entry — remove it
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", []);
			expect(normalize(hub.render(220))).not.toContain("↳");
		});

		test("] moves a chain entry later and the cursor follows it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // first chain entry (model-a)
			hub.handleInput("]");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b", "test/model-a"]);

			// Cursor followed the moved entry: x removes model-a, not model-b.
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);
		});

		test("y on a configured primary appends its model to another role without changing other chains", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				"retry.fallbackChains": { smol: ["test/model-b"], slow: ["test/model-a"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput("y"); // default primary model
			hub.handleInput(DOWN); // smol role
			hub.handleInput("p");

			expect(onFallbackChainChange).toHaveBeenCalledWith("smol", ["test/model-b", "test/model-a"]);
			expect(cfgRetryFallbackChains.get(settings).slow).toEqual(["test/model-a"]);
		});

		test("y on a routed role primary keeps its upstream when pasted into another chain", () => {
			const model = getBundledModel("openrouter", "z-ai/glm-4.7");
			if (!model) throw new Error("Expected bundled OpenRouter model z-ai/glm-4.7");
			const settings = Settings.isolated({
				modelRoles: { default: "openrouter/z-ai/glm-4.7@fireworks" },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput("y");
			hub.handleInput(DOWN); // smol role
			hub.handleInput("p");

			expect(onFallbackChainChange).toHaveBeenCalledWith("smol", ["openrouter/z-ai/glm-4.7@fireworks"]);
		});

		test("y on a fallback preserves its configured effort and appends only once", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a:low"], smol: ["test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default fallback
			hub.handleInput("y");
			hub.handleInput(DOWN); // smol role
			hub.handleInput("p");
			hub.handleInput("p");

			expect(onFallbackChainChange).toHaveBeenCalledTimes(1);
			expect(onFallbackChainChange).toHaveBeenCalledWith("smol", ["test/model-b", "test/model-a:low"]);
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/model-a:low"]);
		});

		test("Shift+Y from a later fallback appends missing entries in source order to the target chain", () => {
			const models = ["model-a", "model-b", "model-c"].map(id => makeModel("test", id));
			const source = ["test/model-a:low", "test/model-b", "test/model-c"];
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: source, smol: ["test/model-b"], slow: ["test/model-c"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models, scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // first default fallback
			hub.handleInput(DOWN); // middle default fallback
			hub.handleInput("Y");
			hub.handleInput(DOWN); // last default fallback
			hub.handleInput(DOWN); // smol role
			hub.handleInput("p");

			expect(onFallbackChainChange).toHaveBeenCalledWith("smol", [
				"test/model-b",
				"test/model-a:low",
				"test/model-c",
			]);
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(source);
			expect(cfgRetryFallbackChains.get(settings).slow).toEqual(["test/model-c"]);
		});

		test("p on a model-keyed chain header appends a yanked fallback without replacing the source", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a"], "test/*": ["test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default fallback
			hub.handleInput("y");
			hub.handleInput(UP); // default role
			hub.handleInput(UP); // + New fallback…
			hub.handleInput(UP); // test/* fallback
			hub.handleInput(UP); // test/* chain header
			hub.handleInput("p");

			expect(onFallbackChainChange).toHaveBeenCalledWith("test/*", ["test/model-b", "test/model-a"]);
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/model-a"]);
		});

		test("y snapshots a routed primary's fixed effort and saves it with the target chain", () => {
			const model = getBundledModel("openrouter", "z-ai/glm-4.7");
			if (!model) throw new Error("Expected bundled OpenRouter model z-ai/glm-4.7");
			const selector = "openrouter/z-ai/glm-4.7@fireworks";
			const settings = Settings.isolated({});
			settings.setRoleModelAndEffort("default", selector, { mode: "fixed", level: ThinkingLevel.High }, "global");
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput("y");
			settings.setRoleEffortSelection("default", { mode: "fixed", level: ThinkingLevel.Low });
			hub.handleInput(DOWN); // smol role
			hub.handleInput("p");
			expect(onFallbackChainChange).toHaveBeenCalledWith("smol", [selector], undefined, {
				[selector]: { mode: "fixed", level: ThinkingLevel.High },
			});
			expect(cfgFallbackEffortSelections.get(settings).smol?.[selector]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.High,
			});
		});

		test("y copies a routed primary's Auto allowlist without aliasing its mutable source", () => {
			const model = getBundledModel("openrouter", "z-ai/glm-4.7");
			if (!model) throw new Error("Expected bundled OpenRouter model z-ai/glm-4.7");
			const selector = "openrouter/z-ai/glm-4.7@fireworks";
			const allowed = [Effort.Low, Effort.High];
			const settings = Settings.isolated({});
			settings.setRoleModelAndEffort(
				"default",
				selector,
				{
					mode: "auto",
					selector: "openrouter/z-ai/glm-4.7",
					allowed,
				},
				"global",
			);
			const { hub } = createHub({ models: [model], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput("y");
			allowed.push(Effort.Max);
			hub.handleInput(DOWN);
			hub.handleInput("p");
			expect(cfgFallbackEffortSelections.get(settings).smol?.[selector]).toEqual({
				mode: "auto",
				selector: "openrouter/z-ai/glm-4.7",
				allowed: [Effort.Low, Effort.High],
			});
		});

		test("y copies effective overlay role effort even without a persisted role source", () => {
			const model = makeModel("test", "model-a");
			const settings = Settings.isolated({
				modelRoles: { default: "test/model-a" },
				roleEffortSelections: { default: { mode: "fixed", level: ThinkingLevel.Off } },
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput("y");
			hub.handleInput(DOWN);
			hub.handleInput("p");
			expect(cfgFallbackEffortSelections.get(settings).smol?.["test/model-a"]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.Off,
			});
		});

		test("y converts a legacy primary thinking suffix to fallback effort metadata", () => {
			const model = getBundledModel("openrouter", "z-ai/glm-4.7");
			if (!model) throw new Error("Expected bundled OpenRouter model z-ai/glm-4.7");
			const selector = "openrouter/z-ai/glm-4.7@fireworks";
			const settings = Settings.isolated({ modelRoles: { default: `${selector}:high` } });
			const { hub } = createHub({ models: [model], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput("y");
			hub.handleInput(DOWN);
			hub.handleInput("p");
			expect(cfgRetryFallbackChains.get(settings).smol).toEqual([selector]);
			expect(cfgFallbackEffortSelections.get(settings).smol?.[selector]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.High,
			});
		});

		test("Y copies sparse Auto and fixed metadata in order without replacing duplicate target effort", () => {
			const a = "test/model-a";
			const b = "test/model-b";
			const c = "test/model-c@route";
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: [a, b, c], smol: [b] },
				"retry.fallbackEffortSelections": {
					default: {
						[a]: { mode: "auto", allowed: [Effort.Low, Effort.High] },
						[b]: { mode: "fixed", level: ThinkingLevel.Low },
						[c]: { mode: "fixed", level: ThinkingLevel.High },
					},
					smol: { [b]: { mode: "fixed", level: ThinkingLevel.Off } },
				},
			});
			const models = ["model-a", "model-b", "model-c"].map(id => makeModel("test", id));
			const { hub, onFallbackChainChange } = createHub({ models, scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput(DOWN); // first default fallback
			hub.handleInput("Y");
			const sourceSelections = cfgFallbackEffortSelections.get(settings);
			(sourceSelections.default[a] as { allowed: Effort[] }).allowed.push(Effort.Max);
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			hub.handleInput(DOWN); // smol role
			hub.handleInput("p");
			hub.handleInput("p"); // deduped: no second persistence
			expect(onFallbackChainChange).toHaveBeenCalledTimes(1);
			expect(cfgRetryFallbackChains.get(settings).smol).toEqual([b, a, c]);
			expect(cfgFallbackEffortSelections.get(settings).smol).toEqual({
				[b]: { mode: "fixed", level: ThinkingLevel.Off },
				[a]: { mode: "auto", allowed: [Effort.Low, Effort.High] },
				[c]: { mode: "fixed", level: ThinkingLevel.High },
			});
			expect(cfgFallbackEffortSelections.get(settings).default[b]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.Low,
			});
		});

		test("y on one fallback copies Auto metadata into a model-keyed chain without changing source", () => {
			const selector = "test/model-a@upstream";
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: [selector], "test/*": ["test/model-b"] },
				"retry.fallbackEffortSelections": {
					default: { [selector]: { mode: "auto", allowed: [Effort.Medium, Effort.Max] } },
				},
			});
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
				scoped: true,
				settings,
			});
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("y");
			hub.handleInput(UP); // default role
			hub.handleInput(UP); // + New fallback…
			hub.handleInput(UP); // test/* fallback
			hub.handleInput(UP); // test/* header
			hub.handleInput("p");
			expect(cfgRetryFallbackChains.get(settings)["test/*"]).toEqual(["test/model-b", selector]);
			expect(cfgFallbackEffortSelections.get(settings)["test/*"]?.[selector]).toEqual({
				mode: "auto",
				allowed: [Effort.Medium, Effort.Max],
			});
			expect(cfgFallbackEffortSelections.get(settings).default?.[selector]).toEqual({
				mode: "auto",
				allowed: [Effort.Medium, Effort.Max],
			});
		});

		test("windows the roles list so model-keyed chains past the panel height stay reachable", () => {
			const settings = Settings.isolated({
				// Model-keyed chains sort alphabetically; the unique tail key lands last.
				"retry.fallbackChains": {
					"aa-provider/head-chain": ["x/y"],
					"mm-provider/mid-chain": ["x/y"],
					"zz-provider/tail-chain-marker": ["x/y"],
				},
			});
			// A short terminal makes the built-in roles alone fill the panel, so the
			// model-keyed chains that follow the separator land below the fold. The
			// chain keys are not available models, so no role auto-assignment leaks
			// their names into the visible role rows.
			const { hub } = createHub({ models: [makeModel("test", "solo")], settings, terminalRows: 16 });

			enterRolesView(hub);
			const top = normalize(hub.render(120));
			// The alphabetically last model-keyed chain is clipped, but the panel
			// now advertises the hidden rows instead of dropping them silently.
			expect(top).not.toContain("tail-chain-marker");
			expect(top).toContain("more");

			// Wrapping up from the top row lands on the trailing "+ New fallback…"
			// row; the window scrolls to the bottom and reveals the clipped chain.
			hub.handleInput(UP);
			const bottom = normalize(hub.render(120));
			expect(bottom).toContain("tail-chain-marker");
		});

		test("clicking a roles row hits the row under the pointer", () => {
			const a = makeModel("test", "model-a");
			const { hub } = createHub({ models: [a], scoped: true });

			hub.handleInput(UP); // All models → Roles
			// Derive the pointer row from the frame itself: the fullscreen
			// overlay paints from screen row 0, so frame index == screen row.
			const frame = hub.render(220).map(line => stripVTControlCharacters(line));
			const screenRow = frame.findIndex(line => line.includes("DEFAULT"));
			expect(screenRow).toBeGreaterThan(0);
			const sgr = `\x1b[<0;61;${screenRow + 1}M`; // SGR reports are 1-based
			hub.handleInput(sgr); // select (dive into rows)
			hub.handleInput(sgr); // click-again activates
			expect(footerLine(hub.render(220))).toContain("pick model");
		});

		test("fallbacks chip keys a new chain by the selected model", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // open the strip for model-a
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput(LEFT); // fallbacks:model-a
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput("\n"); // confirm fallback effort
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"], {
				selector: "test/model-b",
				selection: { mode: "inherit" },
			});
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("provider chip keys the chain by provider/*", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/*");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput("\n"); // confirm fallback effort
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", ["test/model-b"], {
				selector: "test/model-b",
				selection: { mode: "inherit" },
			});
		});

		test("+ New fallback… picks the protected model, then keys the chain via the strip", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			enterRolesView(hub);
			hub.handleInput(UP); // wrap to the trailing "+ New fallback…"
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("New fallback chain");

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // pick the protected model
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("for test/model-a");
			expect(strip).toContain("for test/*");

			hub.handleInput("\n"); // key by the exact model
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");
			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput("\n"); // confirm fallback effort
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"], {
				selector: "test/model-b",
				selection: { mode: "inherit" },
			});
		});

		test("model-keyed chains render below the separator and x clears the whole chain", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({
				"retry.fallbackChains": { "test/*": ["test/model-a"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a], scoped: true, settings });

			enterRolesView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/*");
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("+ New fallback…");
			expect(rendered).toMatch(/─{10,}/); // the roles/fallbacks divider

			hub.handleInput(UP); // + New fallback…
			hub.handleInput(UP); // ↳ test/model-a
			hub.handleInput(UP); // test/* header (separator is skipped)
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", []);
			expect(normalize(hub.render(220))).not.toContain("↳ test/model-a");
		});

		test("exact fallback choices store fixed effort separately from the model selector", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled reasoning model");
			const selector = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [selector] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // Inherit → Off
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [selector], {
				selector,
				selection: { mode: "fixed", level: ThinkingLevel.Off },
			});
			expect(cfgFallbackEffortSelections.get(settings).default?.[selector]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.Off,
			});
		});

		test("wildcard fallback edits Auto candidates rather than ignoring effort", () => {
			const settings = Settings.isolated({ "retry.fallbackChains": { default: ["test/*"] } });
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("t");
			expect(footerLine(hub.render(220))).toContain("auto");
			hub.handleInput("\x1b[C"); // Off
			hub.handleInput("\x1b[C"); // Auto
			hub.handleInput("\n");
			hub.handleInput(" "); // disable minimal
			hub.handleInput("\n");
			expect(cfgFallbackEffortSelections.get(settings).default?.["test/*"]).toEqual({
				mode: "auto",
				allowed: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			});
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/*"]);
		});

		test("editing a legacy suffixed pattern retains its authored effort", () => {
			const settings = Settings.isolated({ "retry.fallbackChains": { default: ["test/*:high"] } });
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("t");
			hub.handleInput("\n"); // confirm the preselected effort without changing it
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/*"]);
			expect(cfgFallbackEffortSelections.get(settings).default?.["test/*"]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.High,
			});
		});

		test("a rejected fallback save retains its draft for retry without changing the chain", () => {
			const settings = Settings.isolated({ "retry.fallbackChains": { default: ["test/*"] } });
			let reject = true;
			const { hub } = createHub({
				models: [makeModel("test", "model-a")],
				scoped: true,
				settings,
				callbacks: {
					onFallbackChainChange: (role, _chain, effort) => {
						if (reject) {
							reject = false;
							return false;
						}
						if (effort)
							cfgFallbackEffortSelections.override(settings, {
								[role]: { [effort.selector]: effort.selection },
							});
						return true;
					},
				},
			});
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // choose Off
			hub.handleInput("\n"); // rejected
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/*"]);
			expect(cfgFallbackEffortSelections.get(settings).default).toBeUndefined();
			hub.handleInput("\n"); // retry same staged choice
			expect(cfgFallbackEffortSelections.get(settings).default?.["test/*"]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.Off,
			});
		});

		test("literal @ model IDs and routed selectors retain their identity when editing effort", () => {
			const literal = makeModel("test", "model@default");
			const routed = makeModel("openrouter", "z-ai/glm-4.7");
			const route = `${routed.provider}/${routed.id}@fireworks`;
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: [`${literal.provider}/${literal.id}`, route] },
			});
			const { hub } = createHub({ models: [literal, routed], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("t");
			hub.handleInput("\x1b[C");
			hub.handleInput("\n");
			hub.handleInput(DOWN);
			hub.handleInput("t");
			hub.handleInput("\x1b[C");
			hub.handleInput("\n");
			expect(cfgRetryFallbackChains.get(settings).default).toEqual(["test/model@default", route]);
			expect(cfgFallbackEffortSelections.get(settings).default?.["test/model@default"]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.Off,
			});
			expect(cfgFallbackEffortSelections.get(settings).default?.[route]).toEqual({
				mode: "fixed",
				level: ThinkingLevel.Off,
			});
		});
	});

	test("focuses the scope pane initially", () => {
		const { hub } = createHub({ models: [makeModel("test", "test-model")] });
		const rendered = normalize(hub.render(220));
		expect(rendered).toContain("Enter/→ models · ↑/↓ providers");
	});

	test("Enter on the sidebar moves focus to the model list instead of acting on a row", () => {
		const { hub, onAssign } = createHub({ models: [makeModel("test", "test-model")], scoped: true });
		installTestTheme();
		hub.handleInput("\n");
		expect(footerLine(hub.render(220))).toContain("↑/↓ models · ← providers");
		expect(onAssign).not.toHaveBeenCalled();
		hub.handleInput("\n"); // now Enter acts on the focused row: opens its role strip
		expect(footerLine(hub.render(220))).toContain("test-model →");
	});

	describe("mouse wheel", () => {
		// SGR wheel reports: button 64 = up, 65 = down. Column 100 lands in the
		// body pane, column 3 in the sidebar; row 10 is inside the content rows.
		const WHEEL_UP_BODY = "\x1b[<64;100;10M";
		const WHEEL_DOWN_BODY = "\x1b[<65;100;10M";
		const WHEEL_UP_SIDEBAR = "\x1b[<64;3;10M";
		const WHEEL_DOWN_SIDEBAR = "\x1b[<65;3;10M";

		test("wheel pans the model list without moving the selection and clamps at the ends", () => {
			const models = Array.from({ length: 40 }, (_, i) => makeModel("test", `model-${String(i).padStart(2, "0")}`));
			const { hub } = createHub({ models, scoped: true });

			hub.handleInput("\n"); // Sidebar → model list.
			const before = normalize(hub.render(220)); // establishes mouse geometry
			// Enter opens the role strip for the selected model — its footer
			// (`<model-id> → …`) identifies the selection.
			hub.handleInput("\n");
			const initialStrip = footerLine(hub.render(220));
			expect(initialStrip).toContain("→");
			hub.handleInput(ESC); // close the strip

			// Panning reveals rows that were below the fold...
			for (let i = 0; i < 8; i++) hub.handleInput(WHEEL_DOWN_BODY);
			const panned = normalize(hub.render(220));
			const modelIdsIn = (frame: string) => new Set(Array.from(frame.matchAll(/model-\d\d/g), match => match[0]));
			const beforeIds = modelIdsIn(before);
			const revealed = [...modelIdsIn(panned)].filter(id => !beforeIds.has(id));
			expect(revealed.length).toBeGreaterThan(0);

			// ...but never moves the selection: Enter still opens the same model's strip.
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toBe(initialStrip);
			hub.handleInput(ESC);

			// The window clamps at the bottom instead of wrapping back to the top...
			for (let i = 0; i < 500; i++) hub.handleInput(WHEEL_DOWN_BODY);
			const saturated = normalize(hub.render(220));
			hub.handleInput(WHEEL_DOWN_BODY);
			expect(normalize(hub.render(220))).toBe(saturated);

			// ...and scrolling back up restores the original window exactly.
			for (let i = 0; i < 500; i++) hub.handleInput(WHEEL_UP_BODY);
			expect(normalize(hub.render(220))).toBe(before);
		});

		test("wheel over the sidebar never changes the active scope or schedules refreshes", () => {
			vi.useFakeTimers();
			try {
				const refreshProvider = vi.fn(async () => {});
				const { hub } = createHub({
					models: [makeModel("prov-a", "model-a"), makeModel("prov-b", "model-b")],
					registry: { refreshProvider },
				});

				expect(normalize(hub.render(220))).toContain("All available models");

				// Two hops under the old wheel-selects behavior would land on a
				// provider scope; the viewport pan must leave the scope alone.
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_DOWN_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_UP_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");

				// No scope change means no provider auto-refresh either.
				vi.advanceTimersByTime(200); // past the 120ms provider-refresh debounce
				expect(refreshProvider).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		test("wheel in the roles view clamps at the top instead of wrapping to the bottom rows", () => {
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true });

			hub.handleInput(UP); // All models → Roles
			hub.render(220); // establish mouse geometry
			for (let i = 0; i < 4; i++) hub.handleInput(WHEEL_UP_BODY); // cursor stays on the first role
			hub.handleInput("\n"); // dive into the rows
			hub.handleInput("\n"); // activate the cursor row
			expect(footerLine(hub.render(220))).toContain("pick model");
		});
	});

	describe("provider scopes and search", () => {
		test("search inside a provider scope keeps that provider's model (#4522)", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			// Scope-hop: All models → custom-provider → openrouter.
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("openrouter ·");

			for (const ch of "glm-5.2") hub.handleInput(ch);
			hub.handleInput("\n");

			// The role strip opened for the provider-scoped match, not the
			// identically named custom-provider model.
			expect(footerLine(hub.render(220))).toContain("z-ai/glm-5.2 →");
		});

		test("search on All models spans every provider", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			for (const ch of "glm") hub.handleInput(ch);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("openrouter/z-ai/glm-5.2");
			expect(rendered).toContain("custom-provider/glm-5.2");
		});

		test("a provider scope that loses every match falls back to All models", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			hub.handleInput(DOWN);
			hub.handleInput(DOWN); // openrouter scope
			for (const ch of "does-not-exist") hub.handleInput(ch);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("All available models");
			expect(rendered).toContain("No matching models");
		});

		test("scope hop skips providers without matches while searching", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customOther = makeModel("custom-provider", "different-model");
			const { hub } = createHub({ models: [openrouterGlm, customOther] });
			installTestTheme();

			for (const ch of "z-ai") hub.handleInput(ch);
			hub.handleInput(LEFT); // switch focus to sidebar
			hub.handleInput(DOWN); // skips custom-provider (0 matches), lands on openrouter
			expect(normalize(hub.render(220))).toContain("openrouter ·");
		});
		test("providers with matches float to the top of the sidebar while searching", () => {
			const noMatch = makeModel("aaa-provider", "different-model");
			const withMatch = makeModel("zzz-provider", "target-model");
			const { hub } = createHub({ models: [noMatch, withMatch] });
			installTestTheme();

			// Sidebar cell = the first `│`-delimited column of each split row;
			// body rows may also mention provider names, so scope the check.
			const sidebarIndexOf = (provider: string): number =>
				hub
					.render(220)
					.map(line => stripVTControlCharacters(line).split("│")[1] ?? "")
					.findIndex(cell => cell.includes(provider));

			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));

			for (const ch of "target") hub.handleInput(ch);
			expect(sidebarIndexOf("zzz-provider")).toBeLessThan(sidebarIndexOf("aaa-provider"));

			// Clearing the query restores the alphabetical order.
			hub.handleInput("\x1b");
			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));
		});

		test("Escape clears an active query before closing the hub", () => {
			const model = makeModel("test", "escape-model");
			const { hub, onCancel } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "esc") hub.handleInput(ch);
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		test("left/right arrows switch between the sidebar and the model list", () => {
			const modelA = makeModel("prov-a", "model-a");
			const modelB = makeModel("prov-b", "model-b");
			const { hub } = createHub({ models: [modelA, modelB] });
			installTestTheme();

			// Right enters list mode: Down now moves the model selection, the
			// scope stays on All models.
			hub.handleInput("\x1b[C");
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("All available models");

			// Left returns to the sidebar: Down hops to the first provider.
			hub.handleInput(LEFT);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("prov-a ·");
		});
	});

	describe("provider refresh lifecycle", () => {
		test("auto-refreshes a provider once per process; F5 forces a re-fetch", async () => {
			const model = makeModel("prov-a", "model-a");
			const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(async () => {});
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			// Real waits: the hub debounces provider refreshes with a real
			// 120ms setTimeout (no injection seam), and the fetch completion is
			// a promise chain — fake timers cannot drive the mixed path.
			hub.handleInput(DOWN); // All models → prov-a, schedules the refresh
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online");
			expect(refreshProvider.mock.calls[0]?.[2]).toBeUndefined();

			hub.handleInput(UP); // back to All models
			hub.handleInput(DOWN); // revisit prov-a
			await Bun.sleep(140);
			// Lifetime guard: revisiting must not re-fetch.
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			hub.handleInput("\x1b[15~"); // F5
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online", { refreshCommandCredentials: true });
		});

		test("F5 during the hover debounce upgrades the pending catalog refresh", async () => {
			const model = makeModel("prov-a", "model-a");
			const refreshProvider = vi.fn(async () => {});
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			hub.handleInput(DOWN); // schedules catalog-only refresh
			hub.handleInput("\x1b[15~"); // F5 before the 120ms debounce fires
			await Bun.sleep(40);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online", { refreshCommandCredentials: true });
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
		});

		test("F5 while a catalog refresh is in flight queues a credential re-mint", async () => {
			const model = makeModel("prov-a", "model-a");
			const gate = Promise.withResolvers<void>();
			const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(() => gate.promise);
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			hub.handleInput(DOWN);
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider.mock.calls[0]?.[2]).toBeUndefined();

			hub.handleInput("\x1b[15~");
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			gate.resolve();
			await Bun.sleep(0);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
			expect(refreshProvider).toHaveBeenLastCalledWith("prov-a", "online", { refreshCommandCredentials: true });
		});

		test("F5 still re-mints credentials after navigating away mid-fetch", async () => {
			const modelA = makeModel("prov-a", "model-a");
			const modelB = makeModel("prov-b", "model-b");
			const gate = Promise.withResolvers<void>();
			const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(() => gate.promise);
			const { hub } = createHub({
				models: [modelA, modelB],
				registry: { refreshProvider },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → prov-a
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider.mock.calls[0]?.[2]).toBeUndefined();

			hub.handleInput("\x1b[15~"); // queue credential refresh behind the in-flight catalog fetch
			hub.handleInput(UP); // All models — must not drop the F5
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			gate.resolve();
			await Bun.sleep(0);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
			expect(refreshProvider).toHaveBeenLastCalledWith("prov-a", "online", { refreshCommandCredentials: true });
		});

		test("shows a refreshing status while the provider fetch is in flight", async () => {
			const model = makeModel("prov-b", "model-b");
			const gate = Promise.withResolvers<void>();
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider: () => gate.promise },
			});
			installTestTheme();

			hub.handleInput(DOWN);
			await Bun.sleep(140);
			expect(normalize(hub.render(220))).toContain("refreshing model list");

			gate.resolve();
			await Bun.sleep(0);
			expect(normalize(hub.render(220))).not.toContain("refreshing model list");
		});
	});

	describe("locked providers", () => {
		test("catalog providers without credentials appear locked and forward to login", () => {
			const anthropicModel = makeModel("anthropic", "claude-locked-test");
			const { hub, onLoginRequest } = createHub({
				models: [anthropicModel],
				registry: { getAvailable: () => [] },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → locked anthropic (separator skipped)
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("anthropic has no credentials configured");
			expect(rendered).toContain("claude-locked-test");

			hub.handleInput("\n");
			expect(onLoginRequest).toHaveBeenCalledWith("anthropic");
		});
	});
	describe("effort policy editors", () => {
		test("Auto edits a sparse set, cancels atomically, and saves in the selected role scope", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled reasoning model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const assigned = vi.fn();
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					onAssign: (selectedModel, role, level, selector, scope, selection) => {
						assigned(selectedModel, role, level, selector, scope, selection);
						settings.setProjectModelRole(role, selector);
						return true;
					},
				},
			});
			hub.handleInput("\n"); // model list
			hub.handleInput("\n"); // role choices
			hub.handleInput("\n"); // project default role
			hub.handleInput("\x1b[C"); // off
			hub.handleInput("\x1b[C"); // Auto
			hub.handleInput("\n"); // Auto set editor
			expect(footerLine(hub.render(220))).not.toContain("inherit");
			expect(footerLine(hub.render(220))).not.toContain("auto");
			hub.handleInput(" "); // create a hole
			hub.handleInput(ESC); // no partial assignment
			expect(assigned).not.toHaveBeenCalled();
			expect(settings.getProjectRoleEffortSelection("default")).toBeUndefined();

			hub.handleInput("\n"); // select model
			hub.handleInput("\n"); // project role opens effort choices
			hub.handleInput("\x1b[C");
			hub.handleInput("\x1b[C");
			hub.handleInput("\n");
			hub.handleInput(" ");
			hub.handleInput("\x1b[C");
			hub.handleInput(" ");
			hub.handleInput("\n"); // confirm sparse Auto selection
			const auto = settings.getProjectRoleEffortSelection("default");
			expect(auto).toEqual({
				mode: "auto",
				allowed: getSupportedEfforts(model).slice(2),
				selector: "openai/gpt-5.5",
			});
			expect(settings.getGlobalRoleEffortSelection("default")).toBeUndefined();
			expect(assigned).toHaveBeenCalledTimes(1);
			expect(assigned.mock.calls[0]?.[5]).toEqual(auto);
			const reopened = createHub({ models: [model], scoped: true, settings });
			reopened.hub.handleInput(UP); // Roles
			reopened.hub.handleInput("\n"); // role rows
			reopened.hub.handleInput("t"); // saved Auto is preselected
			expect(footerLine(reopened.hub.render(220))).toContain("auto");
			reopened.hub.handleInput("\n"); // existing enabled set
			const first = getSupportedEfforts(model)[0];
			const third = getSupportedEfforts(model)[2];
			const restored = footerLine(reopened.hub.render(220));
			expect(restored).toContain(`${theme.status.disabled} ${first}`);
			expect(restored).toContain(`${theme.status.enabled} ${third}`);
		});

		test("role rows offer exact picking and pattern entry before effort confirmation", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled reasoning model");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			hub.handleInput(UP); // All → Roles
			hub.handleInput("\n"); // focus role rows
			hub.handleInput("\n"); // selector choices
			expect(footerLine(hub.render(220))).toContain("pick model");
			expect(footerLine(hub.render(220))).toContain("pattern");
			hub.handleInput("\x1b[C");
			hub.handleInput("\n");
			for (const ch of "openai/gpt-5.?") hub.handleInput(ch);
			hub.handleInput("\n"); // pattern resolves to compatible model; opens effort
			expect(onAssign).not.toHaveBeenCalled();
			hub.handleInput("\x1b[C"); // Off
			hub.handleInput("\x1b[C"); // Auto
			hub.handleInput("\n"); // toggle menu
			hub.handleInput("\n"); // save all permitted
			expect(onAssign.mock.calls[0]?.[3]).toBe("openai/gpt-5.?");
			expect(onAssign.mock.calls[0]?.[5]).toEqual({
				mode: "auto",
				allowed: [...getSupportedEfforts(model)],
				selector: "openai/gpt-5.?",
			});
		});

		test("global pattern rules reject empty sets and retain prior rules on cancel", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled reasoning model");
			const settings = Settings.isolated({});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			hub.handleInput(UP); // All → Roles
			hub.handleInput(UP); // Roles → Effort rules
			hub.handleInput("\n"); // rules list
			hub.handleInput(DOWN); // pattern entry
			hub.handleInput("\n");
			for (const ch of "openai/*") hub.handleInput(ch);
			hub.handleInput("\n"); // enabled-level editor
			for (let i = 0; i < 6; i++) {
				hub.handleInput(" ");
				hub.handleInput("\x1b[C");
			}
			hub.handleInput("\n"); // empty rejected
			expect(cfgEffortRules.get(settings)).toEqual([]);
			expect(normalize(hub.render(220))).toContain("at least one");
			hub.handleInput(" "); // permit just minimal
			hub.handleInput("\n");
			expect(cfgEffortRules.get(settings)).toEqual([{ selector: "openai/*", allowed: [Effort.Minimal] }]);
			hub.handleInput("\n"); // reopen existing
			expect(footerLine(hub.render(220))).toContain("minimal");
			hub.handleInput("\x1b[C");
			hub.handleInput(" ");
			hub.handleInput(ESC);
			expect(cfgEffortRules.get(settings)).toEqual([{ selector: "openai/*", allowed: [Effort.Minimal] }]);
		});
		test("pattern reordering skips exact entries without moving their precedence", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled reasoning model");
			const settings = Settings.isolated({});
			cfgEffortRules.set(settings, [
				{ selector: "openai/*", allowed: [Effort.Low] },
				{ selector: "openai/gpt-5.5", allowed: [Effort.High] },
				{ selector: "*/gpt-5.?", allowed: [Effort.Medium] },
			]);
			const { hub } = createHub({ models: [model], scoped: true, settings });
			hub.handleInput(UP);
			hub.handleInput(UP); // global effort menu
			hub.handleInput("\n");
			hub.handleInput(DOWN);
			hub.handleInput(DOWN); // second pattern, with an exact row between
			hub.handleInput("[");
			expect(cfgEffortRules.get(settings).map(rule => rule.selector)).toEqual([
				"*/gpt-5.?",
				"openai/gpt-5.5",
				"openai/*",
			]);
		});
	});
});
