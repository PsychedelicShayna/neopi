import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { pickWeightedTip, type VersionUpdate, WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { NativeNode } from "../src/native/node";

function nativeVersionText(welcome: WelcomeComponent): string {
	const nodes: NativeNode[] = [welcome.describe({} as never)];
	for (const node of nodes) {
		if (node.k === "text" && node.p?.role === "omp.welcome.version") {
			return (node.p.spans ?? []).map(part => part.t).join("");
		}
		for (const child of node.c ?? []) if ("k" in child) nodes.push(child);
	}
	throw new Error("Welcome version text missing");
}

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

	it("keeps classic branding and every updater phase inside narrow terminal widths", () => {
		const welcome = new WelcomeComponent("1.0.0", "classic");
		const updates: (VersionUpdate | null)[] = [
			null,
			{ phase: "updating", version: "1.1.0", fraction: 0.5 },
			{ phase: "ready", version: "1.1.0" },
			{ phase: "failed", version: "1.1.0" },
		];
		for (const update of updates) {
			welcome.setVersionUpdate(update);
			for (const width of [4, 6, 12, 20, 36, 50, 80, 140]) {
				for (const line of welcome.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it.each(["new", "classic"] as const)(
		"refreshes native and terminal updater progress, completion, failure and clearing (%s)",
		branding => {
			const welcome = new WelcomeComponent("1.0.0", branding);
			const baselineNative = nativeVersionText(welcome);
			const baseline = welcome.render(80).map(line => Bun.stripANSI(line));
			const states: { update: VersionUpdate; status: string }[] = [
				{ update: { phase: "updating", version: "1.1.0" }, status: "updating…" },
				{ update: { phase: "updating", version: "1.1.0", fraction: 0.426 }, status: "42%" },
				{ update: { phase: "updating", version: "1.1.0", fraction: 0.789 }, status: "78%" },
				{ update: { phase: "ready", version: "1.1.0" }, status: "next launch" },
				{ update: { phase: "failed", version: "1.1.0" }, status: "update failed" },
			];
			for (const { update, status } of states) {
				welcome.setVersionUpdate(update);
				const native = nativeVersionText(welcome);
				const rendered = welcome.render(80).map(line => Bun.stripANSI(line));
				const terminal = rendered.find(line => line.includes("v1.0.0")) ?? "";
				for (const version of [native, terminal]) {
					expect(version).toContain("v1.0.0");
					expect(version).toContain("v1.1.0");
					expect(version).toContain(status);
				}
				if (branding === "classic") expect(rendered.slice(1)).toEqual(baseline.slice(1));
			}
			welcome.setVersionUpdate(null);
			expect(nativeVersionText(welcome)).toBe(baselineNative);
			expect(welcome.render(80).map(line => Bun.stripANSI(line))).toEqual(baseline);
		},
	);

	it("narrows the classic updater before dropping it without shifting the boxed content", () => {
		const welcome = new WelcomeComponent("1.0.0", "classic");
		const baselines = new Map<number, string[]>(
			[80, 38, 30].map(width => [width, welcome.render(width).map(line => Bun.stripANSI(line))]),
		);
		welcome.setVersionUpdate({ phase: "updating", version: "1.1.0", fraction: 0.5 });
		const headers = new Map<number, string>();
		for (const width of [80, 38, 30]) {
			const rows = welcome.render(width).map(line => Bun.stripANSI(line));
			headers.set(width, rows[0] ?? "");
			const baseline = baselines.get(width);
			if (!baseline) throw new Error(`missing classic welcome baseline at width ${width}`);
			expect(rows.slice(1)).toEqual(baseline.slice(1));
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		const full = headers.get(80)!;
		const compact = headers.get(38)!;
		expect(full).toContain("→ v1.1.0");
		expect(full).toContain("50%");
		expect(compact).toContain("→ v1.1.0 50%");
		const suffixWidth = (row: string) => visibleWidth(row.slice(row.indexOf("→"), row.indexOf("50%") + 3));
		expect(suffixWidth(full)).toBeGreaterThan(suffixWidth(compact));
		expect(headers.get(30)).toContain("v1.0.0");
		expect(headers.get(30)).not.toContain("→");
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

	it("trails the version with update progress, narrowing it before dropping it, without moving the lockup", () => {
		const rows = (columns: number, update: boolean) => {
			const welcome = new WelcomeComponent("1.0.0");
			if (update) welcome.setVersionUpdate({ phase: "updating", version: "1.1.0", fraction: 0.5 });
			return welcome.render(columns).map(row => Bun.stripANSI(row));
		};
		const versionRow = (columns: number) => rows(columns, true).find(row => row.includes("v1.0.0")) ?? "";

		// The lockup centers as if no indicator were there.
		expect(rows(80, true).slice(0, 4)).toEqual(rows(80, false).slice(0, 4));
		expect(versionRow(80)).toMatch(/v1\.0\.0 → v1\.1\.0 \S+ 50%$/);
		// Too narrow for the bar: the percent alone; narrower still: the bare version.
		expect(versionRow(56)).toMatch(/v1\.0\.0 → v1\.1\.0 50%$/);
		expect(versionRow(38)).not.toContain("→");
		for (const columns of [80, 56, 38]) expect(visibleWidth(versionRow(columns))).toBeLessThan(columns);
	});
});
