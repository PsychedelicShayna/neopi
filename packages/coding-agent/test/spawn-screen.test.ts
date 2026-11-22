import { getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import { SpawnScreen } from "@oh-my-pi/pi-coding-agent/modes/spawn-screen";
import type { AgentLauncher, SpawnDraft } from "@oh-my-pi/pi-coding-agent/neopi/agent-launcher";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { HookEditorComponent, type HookEditorOptions } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "bun:test";

const cx: DescribeContext = { cols: 120, dark: true, reduceMotion: false, supports: () => true, feature: () => true };
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected the bundled Sonnet model for the spawn screen fixture.");
const selector = `${model.provider}/${model.id}`;
let previousBindings = getKeybindings();
let previousVim = false;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	previousBindings = getKeybindings();
	previousVim = getMenuSearchVimMode();
	setKeybindings(KeybindingsManager.inMemory());
	setMenuSearchVimMode(false);
});

afterEach(() => {
	setKeybindings(previousBindings);
	setMenuSearchVimMode(previousVim);
});

function createScreen() {
	const defaults: Record<string, Partial<SpawnDraft>> = {
		scout: { model: `${selector}:low`, tools: ["read"], prewalk: "off" },
		task: { model: `${selector}:high`, tools: ["read", "task"], delegation: "*", prewalk: "on", advisor: "on" },
		advisor: { model: `${selector}:medium`, tools: ["read"] },
	};
	const read = { value: "read", label: "read" };
	const launcher: AgentLauncher = {
		presets: [
			{ type: "scout", description: "Explore", tools: [read] },
			{ type: "task", description: "Work", tools: [read, { value: "task", label: "task" }] },
			{
				type: "advisor",
				advisorSeat: true,
				description: "Advise",
				tools: [read, { value: "advise", label: "advise", disabled: true }],
			},
		],
		resolveSpec: spec => {
			const separator = spec.indexOf("@");
			const type = separator < 0 ? spec : spec.slice(0, separator);
			return {
				type,
				name: "Amber",
				assignment: "",
				...defaults[type],
				...(separator < 0 ? {} : { model: spec.slice(separator + 1) }),
			};
		},
		launch: vi.fn(async () => "Launched"),
	};
	const tui = {
		terminal: { rows: 40, columns: 120 },
		requestRender: vi.fn(),
		stop: vi.fn(),
		start: vi.fn(),
	} as unknown as TUI;
	const done = vi.fn<(draft: SpawnDraft | undefined) => void>();
	const externalEditor = vi.fn(async (text: string) => `${text}\nsecond line`);
	const screen = new SpawnScreen(tui, {
		launcher,
		browserSource: createModelBrowserSource(Settings.isolated()),
		getAvailableModels: () => [model],
		workspace: "Workspace: /repo",
		externalEditor,
		done,
	});
	return { screen, done, externalEditor };
}

function rows(screen: SpawnScreen) {
	const view = screen.describe(cx);
	if (view.k !== "picker" || !view.p) throw new Error(`Expected picker, received ${view.k}.`);
	return view.p.items ?? [];
}

function activate(screen: SpawnScreen, item: string): void {
	screen.handleNativeEvent({ type: "activate", key: "", item });
}

function selectType(screen: SpawnScreen, type: string): void {
	activate(screen, "type");
	activate(screen, type);
}

test("type switching refreshes defaults; task checkbox gates delegation; fixed tools stay checked", () => {
	const { screen } = createScreen();
	expect(rows(screen).map(row => row.id)).not.toContain("delegation");
	expect(rows(screen).find(row => row.id === "item:read")?.label).toBe("[x] read");

	selectType(screen, "task");
	let display = Bun.stripANSI(screen.render(120).join("\n"));
	for (const value of [
		`${selector}:high`,
		"Delegation",
		"Amber",
		"Prewalk",
		"Advisor",
		"Assignment",
		"Workspace: /repo",
	])
		expect(display).toContain(value);
	activate(screen, "item:task");
	expect(rows(screen).map(row => row.id)).not.toContain("delegation");
	expect(rows(screen).find(row => row.id === "item:task")?.label).toBe("[ ] task");
	activate(screen, "item:task");
	expect(rows(screen).map(row => row.id)).toContain("delegation");

	selectType(screen, "advisor");
	display = Bun.stripANSI(screen.render(120).join("\n"));
	expect(display).toContain(`${selector}:medium`);
	expect(rows(screen).find(row => row.id === "item:advise")).toMatchObject({ label: "[x] advise", disabled: true });
	for (const id of ["delegation", "prewalk", "advisor", "item:task"])
		expect(rows(screen).map(row => row.id)).not.toContain(id);
});

test("only Launch returns the draft, with a real supported effort and externally edited multiline assignment", async () => {
	const { screen, done, externalEditor } = createScreen();
	activate(screen, "launch");
	expect(done).not.toHaveBeenCalled();
	expect(Bun.stripANSI(screen.render(120).join("\n"))).toContain("Add an assignment");

	activate(screen, "model");
	activate(screen, selector);
	const efforts = getSupportedThinkingLevels(model);
	expect(rows(screen).map(row => row.id)).toEqual(["", "auto", ...efforts]);
	const effort = efforts.at(-1)!;
	activate(screen, effort);

	activate(screen, "assignment");
	screen.handleInput("first line");
	screen.handleInput("\x07");
	await Promise.resolve();
	expect(externalEditor).toHaveBeenCalledWith("first line");
	screen.handleInput("\x1b");
	expect(done).not.toHaveBeenCalled();
	activate(screen, "launch");
	expect(done).toHaveBeenCalledWith(
		expect.objectContaining({
			model: `${formatModelStringWithRouting(model)}:${effort}`,
			assignment: "first line\nsecond line",
			name: "Amber",
		}),
	);
});

test("assignment uses Vim when enabled; Escape navigates, app.interrupt cancels the draft", () => {
	const { screen, done } = createScreen();
	setMenuSearchVimMode(true);
	setKeybindings(KeybindingsManager.inMemory({ "app.interrupt": "ctrl+x" }));
	activate(screen, "assignment");
	screen.handleInput("remove");
	screen.handleInput("\x1b");
	expect(screen.nativeSheet(cx)).toBe(false);
	screen.handleInput("dd");
	screen.handleInput("iKeep this");
	screen.handleInput("\x1b");
	screen.handleInput("\x1b");
	expect(rows(screen).map(row => row.id)).toContain("assignment");
	expect(Bun.stripANSI(screen.render(120).join("\n"))).toContain("Keep this");
	screen.handleInput("\x1b");
	expect(Bun.stripANSI(screen.render(120).join("\n"))).toContain("Keep this");
	expect(done).not.toHaveBeenCalled();
	activate(screen, "assignment");
	screen.handleInput("discard me");
	screen.handleInput("\x03");
	expect(rows(screen).map(row => row.id)).toContain("assignment");
	expect(Bun.stripANSI(screen.render(120).join("\n"))).not.toContain("discard me");
	expect(done).not.toHaveBeenCalled();
	activate(screen, "assignment");
	screen.handleInput("\x18");
	expect(done).toHaveBeenCalledTimes(1);
	expect(done).toHaveBeenCalledWith(undefined);
});

test("Escape preserves a dirty name across Vim mode changes; Ctrl+C cancels only the field", () => {
	const { screen, done } = createScreen();
	setMenuSearchVimMode(true);
	setKeybindings(KeybindingsManager.inMemory({ "app.interrupt": "escape" }));
	activate(screen, "name");
	screen.handleInput("Changed");
	screen.handleInput("\x1b");
	screen.handleInput("0");
	screen.handleInput("\x1b");
	expect(screen.nativeSheet(cx)).toBe(false);
	expect(Bun.stripANSI(screen.render(120).join("\n"))).toContain("AmberChanged");
	screen.handleInput("\x03");
	expect(rows(screen).find(row => row.id === "name")?.detail).toBe("Amber");
	expect(done).not.toHaveBeenCalled();
});

test.each([
	[["\r"], "Inspect the source."],
	[["\x1b", "\r"], "Inspect the source."],
	[["\x03"], undefined],
] as const)("the assignment-only command handles %j in the shared editor", async (keys, expected) => {
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() } as unknown as TUI;
	let editor!: HookEditorComponent;
	const mode = {
		showHookEditor(title: string, prefill: string | undefined, _dialog: unknown, options: HookEditorOptions) {
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			editor = new HookEditorComponent(tui, title, prefill, resolve, () => resolve(undefined), options);
			return promise;
		},
	} as unknown as InteractiveMode;
	const result = InteractiveMode.prototype.showSpawnAssignment.call(mode);
	editor.handleInput("Inspect the source.");
	for (const key of keys) editor.handleInput(key);
	expect(await result).toBe(expected);
});
