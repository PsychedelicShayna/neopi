import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { SelectList } from "../src/components/select-list";
import { composerSetupScene } from "../src/setup/scenes/composer";
import { glyphSetupScene } from "../src/setup/scenes/glyph";
import { themeSetupScene } from "../src/setup/scenes/theme";
import type { SetupSceneHost } from "../src/setup/scenes/types";
import type { DescribeContext, NativeChild } from "../src/native/node";
import * as themeModule from "../src/theme/theme";

const cx: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function picker(child: NativeChild): SelectList | undefined {
	if (child instanceof SelectList) return child;
	if (!("k" in child)) return undefined;
	for (const nested of child.c ?? []) {
		const found = picker(nested);
		if (found) return found;
	}
	return undefined;
}

beforeAll(async () => {
	await themeModule.initTheme();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("setup choice shortcuts", () => {
	for (const scene of [themeSetupScene, glyphSetupScene, composerSetupScene]) {
		it(`${scene.id} keeps numeric shortcuts literal while its filter owns focus`, () => {
			spyOn(themeModule, "setSymbolPreset").mockImplementation(async () => {});
			spyOn(themeModule, "setColorBlindMode").mockImplementation(async () => {});
			spyOn(themeModule, "previewTheme").mockResolvedValue({ success: true });
			const host = {
				ctx: { composerShape: "band", symbolPreset: "unicode", colorBlindMode: false, statusLine: undefined },
				requestRender() {},
				finish() {},
				setFocus() {},
				restoreFocus() {},
			} as unknown as SetupSceneHost;
			const controller = scene.mount(host);
			try {
				const root = controller.describe?.(cx);
				if (!root) throw new Error("setup scene has no described content");
				const list = picker(root);
				if (!list) throw new Error("setup scene has no choice list");
				list.onSelectionChange = undefined; // This test targets wrapper routing, not theme previews.
				list.setMaxVisible(1);
				controller.handleInput?.("/");
				expect(list.filterFocused).toBe(true);
				controller.handleInput?.("2");
				expect(list.getFilter()).toBe("2");
				controller.handleInput?.("\x1b");
				expect(list.filterFocused).toBe(false);
				expect(list.getFilter()).toBe("");
				controller.handleInput?.("/");
				controller.handleInput?.("2");
				controller.handleInput?.("\r");
				expect(list.filterFocused).toBe(false);
				expect(list.getFilter()).toBe("2");
			} finally {
				controller.dispose?.();
			}
		});
	}
});
