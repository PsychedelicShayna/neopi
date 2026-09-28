import { expect, it } from "bun:test";
import * as path from "node:path";
import { createTheme } from "@oh-my-pi/pi-tui/theme/loader";

const POIMANDRES_PATH = path.join(import.meta.dir, "..", "src", "theme", "defaults", "dark-poimandres.json");

it("keeps poimandres heritage glyphs when the cyclers follow the theme", async () => {
	const json = await Bun.file(POIMANDRES_PATH).json();
	const theme = createTheme(json, { mode: "truecolor", symbolCyclers: { brand: "theme", effort: "theme" } });
	expect(theme.symbol("icon.omp")).toBe("π");
	expect(theme.symbol("icon.model")).toBe("◇");
	expect(theme.symbol("thinking.high")).toBe("◎");
});

it("lets the cyclers override the theme's brand and effort glyphs", async () => {
	const json = await Bun.file(POIMANDRES_PATH).json();
	const theme = createTheme(json, { mode: "truecolor", symbolCyclers: { brand: "md-axis-z", effort: "nerd" } });
	expect(theme.symbol("icon.omp")).toBe("\u{f0d57}");
	expect(theme.symbol("thinking.high")).toBe("\u{F0AA3} high");
	expect(theme.symbol("icon.model")).toBe("◇");
});
