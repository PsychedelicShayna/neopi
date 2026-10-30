import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { buildHotkeysMarkdown, HotkeysSheetComponent } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { theme } from "../src/theme/theme";

/** Exit-row wiring for stubs that only care about display strings: no key claims the
 *  forward-delete role, so the exit row renders its plain "Exit" wording. */
const noForwardDelete = { getKeys: () => [], matchesCanonical: () => false };

it("hotkey help marks fork and latest-upstream actions without changing their keys", async () => {
	await initTheme();
	const markdown = buildHotkeysMarkdown({
		keybindings: { getKeys: () => [], getDisplayString: () => "Disabled", matchesCanonical: () => false },
	});
	expect(markdown).toContain(`Back to the previous menu or the conversation ${theme.symbol("provenance.fork")}`);
	expect(markdown).toContain(`Approve a pending tool call ${theme.symbol("provenance.newUpstream")}`);
});

describe("buildHotkeysMarkdown", () => {
	afterEach(() => setKeyHintPlatform(undefined));

	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				...noForwardDelete,
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `Ctrl+Shift+P` | Copy whole prompt |");
		expect(markdown).toContain("| `Ctrl+Shift+L` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
		expect(markdown).toContain("| `Alt+L` | Reset terminal display |");
		expect(markdown).toContain("| `Ctrl+L` | Start/stop live voice mode (/live) |");
		expect(markdown).toContain("| `Alt+R` | Retry last failed assistant turn |");
		expect(markdown).toContain("| `Alt+Shift+P` | Toggle plan mode |");
		expect(markdown).toContain("| `Ctrl+Shift+O` | Toggle tool activity visibility |");
		expect(markdown).toContain("| `#<number>` | GitHub issue/PR reference");
		expect(markdown).toContain("| `#` / `#<text>` | Prompt actions");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				...noForwardDelete,
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Alt+M";
					}
					if (action === "app.display.reset") {
						return "Alt+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
	});

	it("drops Option/Cmd static navigation labels off darwin", () => {
		setKeyHintPlatform("linux");
		const markdown = buildHotkeysMarkdown({
			keybindings: { ...noForwardDelete, getDisplayString: () => "Disabled" },
		});

		expect(markdown).not.toContain("Option+");
		expect(markdown).not.toContain("Cmd+");
	});
});

describe("hotkeys sheet navigation", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	it("scrolls the ANSI viewer, restores its viewport, and forwards supported native motions", () => {
		let closed = false;
		const bindings = { keybindings: { ...noForwardDelete, getDisplayString: () => "Disabled" } };
		const sheet = new HotkeysSheetComponent(
			bindings,
			() => {
				closed = true;
			},
			() => 14,
		);
		sheet.render(80);
		sheet.handleInput("j");
		expect(sheet.navigationSnapshot()).toMatchObject({ scrollOffset: 1 });
		expect(sheet.describe().scroll?.by).toBe("line-down");
		const nativeBeforeHalf = sheet.describe().scroll;
		sheet.handleInput("\x04");
		expect(sheet.navigationSnapshot()).toMatchObject({ scrollOffset: 6 });
		expect(sheet.describe().scroll).toBe(nativeBeforeHalf);
		const saved = sheet.navigationSnapshot();
		const reopened = new HotkeysSheetComponent(
			bindings,
			() => {},
			() => 14,
		);
		reopened.restoreNavigation(saved);
		reopened.render(80);
		expect(reopened.navigationSnapshot()).toEqual(saved);
		sheet.handleInput("g");
		sheet.handleInput("g");
		expect(sheet.navigationSnapshot()).toMatchObject({ scrollOffset: 0 });
		sheet.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
