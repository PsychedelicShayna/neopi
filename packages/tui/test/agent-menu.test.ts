import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { AgentMenuComponent } from "@oh-my-pi/pi-tui/overlays/agent-menu";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const context: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: feature => feature === "picker",
	feature: () => false,
};

function createMenu() {
	const actions = { shutdown: vi.fn(), restart: vi.fn(), forceShutdown: vi.fn(), close: vi.fn() };
	return { menu: new AgentMenuComponent(actions), actions };
}

describe("Agent Menu", () => {
	let previousBindings = getKeybindings();
	let previousVimMode = false;
	beforeAll(() => initTheme());
	beforeEach(() => {
		previousBindings = getKeybindings();
		previousVimMode = getMenuSearchVimMode();
		setKeybindings(KeybindingsManager.inMemory());
		setMenuSearchVimMode(false);
	});
	afterEach(() => {
		setKeybindings(previousBindings);
		setMenuSearchVimMode(previousVimMode);
	});

	it("lists both disabled actions first and defaults to graceful shutdown", () => {
		const { menu, actions } = createMenu();
		expect(menu.describe(context)?.p).toMatchObject({
			selected: "shutdown",
			items: [
				{ id: "detach", label: "Detach from Agent", disabled: true },
				{ id: "reattach", label: "Reattach to Agent", disabled: true },
				{ id: "shutdown", label: "Shutdown Agent" },
				{ id: "restart", label: "Restart Agent" },
				{ id: "force", label: "Force Shutdown" },
			],
		});
		menu.handleNativeEvent({ type: "activate", key: "", item: "detach" });
		menu.handleNativeEvent({ type: "activate", key: "", item: "reattach" });
		expect(actions.close).not.toHaveBeenCalled();
		menu.handleInput("\x1b[H"); // Home skips both disabled rows.
		menu.handleInput("\r");
		expect(actions.close).toHaveBeenCalledTimes(1);
		expect(actions.shutdown).toHaveBeenCalledTimes(1);
		expect(actions.restart).not.toHaveBeenCalled();
		expect(actions.forceShutdown).not.toHaveBeenCalled();
	});

	it("respects Vim navigation opt-in and chooses Restart or Force Shutdown", () => {
		const { menu, actions } = createMenu();
		menu.handleInput("j");
		expect(menu.navigationSnapshot()).toMatchObject({ selectedValue: "shutdown" });
		menu.handleInput("\x1b[B");
		expect(menu.navigationSnapshot()).toMatchObject({ selectedValue: "restart" });
		menu.handleInput("\x1b[A");
		setMenuSearchVimMode(true);
		menu.handleInput("j");
		menu.handleInput("j");
		menu.handleInput("k");
		menu.handleInput("\r");
		expect(actions.restart).toHaveBeenCalledTimes(1);
		expect(actions.shutdown).not.toHaveBeenCalled();
		expect(actions.forceShutdown).not.toHaveBeenCalled();

		const force = createMenu();
		force.menu.handleInput("j");
		force.menu.handleInput("j");
		force.menu.handleInput("\r");
		expect(force.actions.forceShutdown).toHaveBeenCalledTimes(1);
	});

	it.each(["\x1b", "q"])("closes on %j without choosing an action", key => {
		const { menu, actions } = createMenu();
		menu.handleInput(key);
		expect(actions.close).toHaveBeenCalledTimes(1);
		expect(actions.shutdown).not.toHaveBeenCalled();
		expect(actions.restart).not.toHaveBeenCalled();
		expect(actions.forceShutdown).not.toHaveBeenCalled();
	});
});
