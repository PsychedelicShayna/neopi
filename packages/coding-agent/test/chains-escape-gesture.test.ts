import { describe, expect, it } from "bun:test";
import { ChainStepGesture } from "../src/chains/escape-gesture";

function presses(times: number[]): string[] {
	const gesture = new ChainStepGesture();
	return times.map(time => gesture.press(time));
}

describe("ChainStepGesture", () => {
	it("skips on the second press and aborts on the third, then starts over", () => {
		expect(presses([0, 100, 200, 300])).toEqual(["none", "skip", "abort", "none"]);
	});

	it("starts a new window once the first press is more than 3 s old", () => {
		expect(presses([0, 3001])).toEqual(["none", "none"]);
		expect(presses([0, 100, 3100])).toEqual(["none", "skip", "none"]);
	});
});
