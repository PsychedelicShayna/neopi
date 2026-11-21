import { beforeAll, describe, expect, it } from "bun:test";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function context(phase: NonNullable<SegmentContext["live"]>["phase"]): SegmentContext {
	return {
		live: { phase, destination: "primary" },
		liveLevels: { mic: 2, output: 4 },
		options: { liveMeter: { template: "{output} | {{in}} {mic}" } },
	} as SegmentContext;
}

describe("live audio meter", () => {
	it("inserts independently colored audio bars into the configured template", () => {
		const ctx = context("listening");
		const ascii = theme.getSymbolPreset() === "ascii";
		const filled = ascii ? "#" : "▮";
		const empty = ascii ? "." : "▯";
		const expected = `${filled.repeat(4)}${empty.repeat(2)} | {in} ${filled.repeat(2)}${empty.repeat(4)}`;
		const native = describeSegment("live_meter", ctx)?.spans;
		expect(native?.filter(part => part.s?.startsWith("liveMeter")).map(part => part.s)).toEqual([
			"liveMeterOutput",
			"liveMeterMic",
		]);
		expect(native?.map(part => part.t).join("")).toBe(expected);
		expect(Bun.stripANSI(renderSegment("live_meter", ctx).content)).toBe(expected);
	});

	it("clears the microphone when muted and hides the meter when disconnected", () => {
		const spans = describeSegment("live_meter", context("muted"))?.spans;
		expect(spans?.some(part => part.s === "liveMeterMic")).toBe(false);
		expect(spans?.some(part => part.s === "liveMeterOutput")).toBe(true);
		expect(describeSegment("live_meter", context("disconnected"))).toBeNull();
	});
});
