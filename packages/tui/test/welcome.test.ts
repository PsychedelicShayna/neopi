import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getLocale, setLocale } from "@oh-my-pi/pi-utils/i18n";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("natively sets the version under the wordmark beside the logo", () => {
		const tree = new WelcomeComponent("18.4.12").describe({} as never);
		expect(tree.c?.[0]).toMatchObject({
			key: "lockup",
			p: { role: "omp.welcome.lockup" },
			c: [
				{ k: "image", key: "logo" },
				{
					k: "col",
					p: { role: "omp.welcome.mark" },
					c: [
						{ p: { role: "omp.welcome.wordmark" } },
						{ p: { role: "omp.welcome.version", spans: [{ t: "v18.4.12" }] } },
					],
				},
			],
		});
	});

	it("defaults to the new banner and switches the same component to classic and back", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const welcome = new WelcomeComponent("1.0.0");
		const initial = welcome.render(140);
		expect(initial).toEqual(new WelcomeComponent("1.0.0", "new").render(140));
		expect(Bun.stripANSI(initial.join("\n"))).not.toContain("Welcome back!");
		const initialNative = welcome.describe({} as never);

		welcome.setBranding("classic");
		const classic = welcome.render(140).map(line => Bun.stripANSI(line));
		expect(classic[0]).toContain("NeoPi v1.0.0");
		expect(classic.join("\n")).toContain("Welcome back!");
		expect(classic.join("\n")).toContain("for prompt actions");
		expect(classic.find(line => line.includes("████████████"))?.indexOf("████████████")).toBe(8);
		const tower = classic.slice(4, 9).map(line => line.slice(8, 20));
		expect(tower).toEqual(["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "]);
		const classicNative = welcome.describe({} as never);
		expect(classicNative).not.toBe(initialNative);
		expect(classicNative.c?.[0]).toMatchObject({ key: "grid", p: { role: "omp.welcome.grid" } });

		welcome.setBranding("new");
		expect(welcome.render(140)).toEqual(initial);
		expect(welcome.describe({} as never)).toEqual(initialNative);
	});

	it("updates classic welcome text on a language change without overflowing the terminal", () => {
		const previousLocale = getLocale();
		try {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			setLocale("en");
			const welcome = new WelcomeComponent("1.0.0", "classic");
			expect(Bun.stripANSI(welcome.render(80).join("\n"))).toContain("Welcome back!");
			setLocale("es");
			const lines = welcome.render(80);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("¡Te damos la bienvenida!");
			expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
			expect(JSON.stringify(welcome.describe({} as never))).toContain("¡Te damos la bienvenida!");
		} finally {
			setLocale(previousLocale);
		}
	});

	it("keeps classic branding inside narrow terminal widths", () => {
		const welcome = new WelcomeComponent("1.0.0", "classic");
		for (const width of [4, 6, 12, 20, 36, 50, 80, 140]) {
			for (const line of welcome.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("centers the lockup and every tip line in the terminal width", () => {
		const columns = 140;
		const rows = new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row).trimEnd());
		const indent = (row: string) => visibleWidth(row) - visibleWidth(row.trimStart());
		const expectCentered = (left: number, right: number) => expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

		// The lockup is one block: the logo's bar starts it, the wordmark row ends it.
		const bar = rows.find(row => row.includes("████████████")) ?? "";
		const word = rows.find(row => row.includes("█▀▀▄")) ?? "";
		expectCentered(indent(bar), columns - visibleWidth(word));

		// Each tip line centers on its own.
		const below = rows.slice(rows.findIndex(row => row.includes("Tip: "))).filter(row => row.length > 0);
		expect(below.length).toBeGreaterThanOrEqual(1);
		for (const row of below) expectCentered(indent(row), columns - visibleWidth(row));
	});

	it("drops the tip below 50 columns", () => {
		const text = (columns: number) => Bun.stripANSI(new WelcomeComponent("1.0.0").render(columns).join("\n"));
		expect(text(50)).toContain("Tip: ");
		expect(text(49)).not.toContain("Tip: ");
		expect(text(49)).toContain("v1.0.0");
	});

	it("sets the version under the wordmark while the lockup fits, else keeps the logo alone", () => {
		const rows = (columns: number) => new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row));

		// The lockup needs 12 logo + 4 gap + 15 wordmark columns inside the 2-column margin.
		const fits = rows(33);
		const word = fits.find(row => row.includes("█▀▀▄"));
		const version = fits.find(row => row.includes("v1.0.0"));
		expect(fits.some(row => row.includes("████████████"))).toBe(true);
		expect(version?.indexOf("v1.0.0")).toBe(word?.indexOf("█▀▀▄"));

		const narrow = rows(32).join("\n");
		expect(narrow).toContain("████████████");
		expect(narrow).not.toContain("█▀▀▄");
		expect(narrow).not.toContain("v1.0.0");
	});
});
