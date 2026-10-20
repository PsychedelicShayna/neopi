import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";

import { getSettingsForTab, SETTING_TABS, TAB_GROUPS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme, setTheme } from "@oh-my-pi/pi-tui/theme";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { cfgRetryUsageAwareFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";

beforeAll(async () => {
	await initTheme();
});

describe("settings layout", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("every UI setting declares a group registered in TAB_GROUPS for its tab", () => {
		const violations: string[] = [];
		for (const setting of all()) {
			const ui = setting.ui;
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${setting.id}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${setting.id}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(createSettingsHost().entries, tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			// Contiguous: no group appears twice in the collapsed sequence.
			expect(new Set(sequence).size).toBe(sequence.length);

			// Ordered: grouped sections follow the TAB_GROUPS declaration order.
			const grouped = sequence.filter(group => group !== "");
			const expected = TAB_GROUPS[tab].filter(group => grouped.includes(group));
			expect(grouped).toEqual(expected);
		}
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths = ["advisor.syncBacklog"];
		const advisorDependentPathSet = new Set<string>(advisorDependentPaths);
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			advisorDependentPathSet.has(def.path),
		);

		expect(defs.map(def => def.path)).toEqual(advisorDependentPaths);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		cfgAdvisorEnabled.set(Settings.instance, true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("exposes usage-aware fallback as an opt-in advanced policy", () => {
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			def.path.startsWith("retry.usage"),
		);
		expect(defs.map(def => def.path)).toEqual([
			"retry.usageAwareFallback",
			"retry.usageReservePct",
			"retry.usageReservePolicy",
		]);
		expect(defs[0]).toMatchObject({ type: "boolean", label: "Usage-Aware Fallback" });
		expect(defs[1]?.condition?.()).toBe(false);
		expect(defs[2]?.condition?.()).toBe(false);
		cfgRetryUsageAwareFallback.set(Settings.instance, true);
		expect(defs[1]?.condition?.()).toBe(true);
		expect(defs[2]?.condition?.()).toBe(true);
	});

	it("renders preview inside SettingsSelectorComponent submenu without crashing", async () => {
		await setTheme("dark");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{
				onChange: () => {},
				onCancel: () => {},
			},
		);

		selector.handleInput("/");
		for (const ch of "composer shape") selector.handleInput(ch);
		selector.handleInput("\n"); // confirm search without opening a setting
		// Open the composer.shape submenu
		selector.handleInput("\n");

		const rendered = selector.render(80).join("\n");
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Preview:");
		expect(rendered).toContain("Ask anything");

		// Cycle down to claude
		selector.handleInput("\x1b[B");
		const nextRendered = selector.render(80).join("\n");
		expect(nextRendered).toContain("Claude Code");
		expect(nextRendered).toContain("Preview:");
	});

	it.each(["/<live>|<voice>", "re:<live>|<voice>"])(
		"searches settings with Vim alternation and boundaries using %s",
		async query => {
			await setTheme("dark");
			let changes = 0;
			let cancellations = 0;
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark", "light"],
					providers: [],
					settings: createSettingsHost(),
					plugins: createPluginSettingsHost(process.cwd()),
				},
				{ onChange: () => changes++, onCancel: () => cancellations++ },
			);
			selector.handleInput("/");
			for (const ch of query) selector.handleInput(ch);
			expect(plainText(selector.render(160).join("\n"))).toContain("Live Voice");
			expect(plainText(selector.render(160).join("\n"))).not.toContain("Composer Shape");
			for (const key of ["\x1b[B", "\x1b[A", "\x1b[5~", "\x1b[6~", "\t"]) selector.handleInput(key);
			selector.handleInput("\n");
			expect(changes).toBe(0);
			expect(cancellations).toBe(0);
			expect(plainText(selector.render(160).join("\n"))).toContain("Live Voice");
			selector.handleInput("/");
			selector.handleInput("\x1b");
			expect(cancellations).toBe(0);
			expect(plainText(selector.render(160).join("\n"))).not.toMatch(/\d+ match/);
		},
	);

	it.each(["/(", "re:("])("shows invalid settings regex %s without activating rows", async query => {
		await setTheme("dark");
		let changes = 0;
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{ onChange: () => changes++, onCancel: () => {} },
		);
		selector.handleInput("/");
		for (const ch of query) selector.handleInput(ch);
		const rendered = plainText(selector.render(160).join("\n"));
		expect(rendered).toMatch(/invalid.*(?:regex|pattern)|(?:regex|pattern).*error/i);
		expect(rendered).not.toContain("Composer Shape");
		expect(rendered).not.toContain("Live Voice");
		selector.handleInput("\n");
		selector.handleInput("\n");
		expect(changes).toBe(0);
	});
});
