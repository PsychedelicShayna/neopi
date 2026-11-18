import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SettingsFormField, SettingsList, type SettingsListTheme } from "../src/components/settings-list";
import { TextFormField } from "../src/components/form";

const settingsTheme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: "> ",
	hint: text => text,
};
const fieldTheme = {
	label: (text: string) => text,
	description: (text: string) => text,
	error: (text: string) => text,
	hint: (text: string) => text,
};

describe("SettingsList host-decoded navigation", () => {
	it("clears a standalone g prefix before applying a host action", () => {
		const list = new SettingsList(
			Array.from({ length: 12 }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}`, currentValue: "" })),
			4,
			settingsTheme,
			() => {},
			() => {},
		);
		list.render(60);
		list.handleInput("g");
		list.handleNavigation({ kind: "move", delta: 1 });
		expect(list.getSelectedItem()?.id).toBe("row-1");
		list.handleInput("g");
		expect(list.getSelectedItem()?.id).toBe("row-1");
		list.handleInput("g");
		expect(list.getSelectedItem()?.id).toBe("row-0");
		list.handleNavigation({ kind: "boundary", edge: "last" });
		expect(list.getSelectedItem()?.id).toBe("row-11");
	});

	it("delegates SettingsFormField focus through its filter and a nested ordinary text field", () => {
		const field = new SettingsFormField({
			items: [
				{
					id: "name",
					label: "Name",
					currentValue: "active",
					submenu: (value, done) =>
						new TextFormField({
							theme: fieldTheme,
							initialValue: value,
							onSubmit: text => done(text),
							onCancel: () => done(),
						}),
				},
			],
			maxVisible: 4,
			settingsTheme,
			fieldTheme,
			onChange: () => {},
			onCancel: () => {},
		});
		expect(field.filterFocused).toBe(false);
		field.handleInput("/");
		expect(field.filterFocused).toBe(true);
		field.handleInput("jkgG/ ");
		expect(field.settingsList.getSearchQuery()).toBe("jkgG/ ");
		expect(field.settingsList.navigationSnapshot().filterDraft).toBe("jkgG/ ");
		field.handleInput("\x1b");
		expect(field.filterFocused).toBe(true);
		field.handleInput("\x1b");
		expect(field.filterFocused).toBe(false);
		field.settingsList.clearSearch();
		field.settingsList.handleNavigation({ kind: "confirm" });
		expect(field.settingsList.hasOpenSubmenu()).toBe(true);
		expect(field.filterFocused).toBe(true);
		field.handleInput(" jkgG/ ");
		expect(field.settingsList.navigationSnapshot()).toMatchObject({
			submenuId: "name",
			submenu: { value: "active jkgG/ " },
		});
	});

	it("history restores a cursor without firing selection entry actions", () => {
		const previews: string[] = [];
		const list = new SettingsList(
			[
				{ id: "first", label: "First", currentValue: "" },
				{ id: "second", label: "Second", currentValue: "" },
			],
			4,
			settingsTheme,
			() => {},
			() => {},
		);
		const first = list.navigationSnapshot();
		list.onSelectionChange = item => {
			if (item) previews.push(item.id);
		};
		list.handleInput("j");
		expect(previews).toEqual(["second"]);
		list.restoreNavigation(first);
		expect(list.getSelectedItem()?.id).toBe("first");
		expect(previews).toEqual(["second"]);
		list.handleInput("j");
		expect(previews).toEqual(["second", "second"]);
	});

	it("restores a native cycling-row popup draft without applying it or replaying visits", () => {
		const changed: string[] = [];
		const visits: string[] = [];
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					values: ["off", "on"],
					menu: (value, done) =>
						new TextFormField({
							theme: fieldTheme,
							initialValue: value,
							onSubmit: text => done(text),
							onCancel: () => done(),
						}),
				},
			],
			4,
			settingsTheme,
			(_id, value) => changed.push(value),
			() => {},
		);
		list.onNavigationVisit = page => visits.push(page);
		const root = list.navigationSnapshot();
		list.openSubmenuFor("mode");
		list.handleInput(" draft");
		const popup = list.navigationSnapshot();
		expect(popup).toMatchObject({ submenuId: "mode", submenu: { value: "off draft" } });
		expect(visits).toEqual(["mode"]);

		list.restoreNavigation(root);
		expect(list.hasOpenSubmenu()).toBe(false);
		list.restoreNavigation(popup);
		expect(list.hasOpenSubmenu()).toBe(true);
		expect(list.navigationSnapshot()).toMatchObject({ submenu: { value: "off draft" } });
		expect(list.getSelectedItem()?.currentValue).toBe("off");
		expect(changed).toEqual([]);
		expect(visits).toEqual(["mode"]);

		list.handleInput("\x1b");
		list.handleNavigation({ kind: "toggle" });
		expect(list.getSelectedItem()?.currentValue).toBe("on");
		expect(changed).toEqual(["on"]);
	});

	it("history never cycles a setting whose old submenu no longer exists", () => {
		const changed: string[] = [];
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					submenu: () =>
						new SettingsList(
							[],
							4,
							settingsTheme,
							() => {},
							() => {},
						),
				},
			],
			4,
			settingsTheme,
			(_id, value) => {
				changed.push(value);
			},
			() => {},
		);
		list.handleInput("\r");
		const nested = list.navigationSnapshot();
		list.setItems([{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] }]);
		list.restoreNavigation(nested);
		expect(list.hasOpenSubmenu()).toBe(false);
		expect(list.getSelectedItem()?.currentValue).toBe("off");
		expect(changed).toEqual([]);
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
