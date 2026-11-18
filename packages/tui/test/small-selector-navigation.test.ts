import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { initTheme } from "../src/theme/theme";
import { ThemeSelectorComponent } from "../src/overlays/theme-selector";
import { ThinkingSelectorComponent } from "../src/overlays/thinking-selector";
import { ShowImagesSelectorComponent } from "../src/overlays/show-images-selector";
import { QueueModeSelectorComponent } from "../src/overlays/queue-mode-selector";
import { SessionAccountSelectorComponent } from "../src/overlays/session-account-selector";

beforeAll(async () => {
	await initTheme();
});

describe("small selector history", () => {
	it("restores selected theme, literal search, and viewport without applying it", () => {
		const applied: string[] = [];
		const previewed: string[] = [];
		const make = () =>
			new ThemeSelectorComponent(
				"dark",
				["dark", "light", "hjkl"],
				name => applied.push(name),
				() => {},
				name => previewed.push(name),
			);
		const selector = make();
		const list = selector.getSelectList();
		list.handleInput("G");
		list.handleInput("/");
		list.handleInput("hjkl");
		list.handleInput("\x1b");
		const snapshot = selector.navigationSnapshot();
		selector.leaveMenu();
		expect(previewed.at(-1)).toBe("dark");
		const restored = make();
		restored.restoreNavigation(snapshot);
		expect(restored.getSelectList().getSelectedItem()?.value).toBe("hjkl");
		expect(restored.getSelectList().getFilter()).toBe("hjkl");
		expect(restored.navigationSnapshot()).toEqual(snapshot);
		expect(applied).toEqual([]);
	});

	it("round-trips the small settings pickers and keeps slash search explicit", () => {
		const selectors = [
			new ThinkingSelectorComponent(
				ThinkingLevel.Low,
				[ThinkingLevel.Off, ThinkingLevel.Low, ThinkingLevel.High],
				() => {},
				() => {},
			),
			new ShowImagesSelectorComponent(
				true,
				() => {},
				() => {},
			),
			new QueueModeSelectorComponent(
				"all",
				() => {},
				() => {},
			),
		];
		for (const selector of selectors) {
			const list = selector.getSelectList();
			list.handleInput("g");
			list.handleInput("g");
			const state = selector.navigationSnapshot();
			list.handleInput("G");
			selector.restoreNavigation(state);
			expect(selector.navigationSnapshot()).toEqual(state);
			list.handleInput("i");
			expect(list.getFilter()).toBe("");
			list.handleInput("/");
			list.handleInput("j");
			expect(list.getFilter()).toBe("j");
		}
	});

	it("restores the account pin selection without pinning an account", () => {
		const picked: number[] = [];
		const accounts = [1, 2].map(credentialId => ({
			position: credentialId - 1,
			credentialId,
			active: credentialId === 1,
			label: `account ${credentialId}`,
		}));
		const make = () =>
			new SessionAccountSelectorComponent(
				"Test",
				accounts,
				account => picked.push(account.credentialId),
				() => {},
			);
		const selector = make();
		selector.handleInput("G");
		const state = selector.navigationSnapshot();
		const restored = make();
		restored.restoreNavigation(state);
		expect(restored.navigationSnapshot()).toEqual(state);
		expect(picked).toEqual([]);
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
