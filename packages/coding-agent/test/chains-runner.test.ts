import { describe, expect, it } from "bun:test";
import type { ChainConfig, ChainStep } from "@oh-my-pi/pi-tui/overlays/chain-types";
import { ChainControl, type RunChainOptions, runChain, type runChainStep } from "../src/chains/runner";

const chain: ChainConfig = {
	name: "c",
	steps: ["a", "b", "c"].map(name => ({ name, prompt: name })),
};

/** Options the fake step never reads; runChain only forwards them. */
const baseOptions = {} as RunChainOptions;

/**
 * A model-free step: each call blocks until released, then appends `+name`.
 * It rejects as soon as its signal aborts, like a real aborted Agent pass.
 */
function fakeStep(failOn?: string) {
	const calls: string[] = [];
	const pending: Array<() => void> = [];
	const run: typeof runChainStep = (step, input, _options, signal) => {
		calls.push(step.name);
		return new Promise<string>((resolve, reject) => {
			const settle = () => {
				if (step.name === failOn) reject(new Error("boom"));
				else resolve(`${input}+${step.name}`);
			};
			pending.push(settle);
			signal?.addEventListener(
				"abort",
				() => {
					pending.splice(pending.indexOf(settle), 1);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		});
	};
	/** Resolve the step currently in flight. */
	const release = async () => {
		while (pending.length === 0) await Bun.sleep(0);
		pending.shift()!();
	};
	/** Wait until `count` step calls have started. */
	const started = async (count: number) => {
		while (calls.length < count) await Bun.sleep(0);
	};
	return { run, calls, release, started };
}

describe("runChain control", () => {
	it("skips only the step in flight and passes its input through", async () => {
		const fake = fakeStep();
		const control = new ChainControl();
		const done: Array<[string, string]> = [];
		const skipped: ChainStep[] = [];
		const result = runChain(
			chain,
			"in",
			{
				...baseOptions,
				control,
				onStepDone: (step, _index, output) => done.push([step.name, output]),
				onStepSkipped: step => skipped.push(step),
			},
			fake.run,
		);
		await fake.release();
		await fake.started(2);
		control.skipStep();
		await fake.started(3);
		await fake.release();

		expect(await result).toBe("in+a+c");
		expect(skipped.map(step => step.name)).toEqual(["b"]);
		expect(done).toEqual([
			["a", "in+a"],
			["c", "in+a+c"],
		]);
	});

	it("lets an abort win over a skip already issued for the same step", async () => {
		const fake = fakeStep();
		const control = new ChainControl();
		const result = runChain({ name: "one", steps: [chain.steps[0]!] }, "in", { ...baseOptions, control }, fake.run);
		await fake.started(1);
		control.skipStep();
		control.abort();

		await expect(result).rejects.toThrow();
		expect(control.signal.aborted).toBe(true);
	});

	it("stops before running a step aborted from its onStep callback", async () => {
		const fake = fakeStep();
		const control = new ChainControl();
		const result = runChain(chain, "in", { ...baseOptions, control, onStep: () => control.abort() }, fake.run);

		await expect(result).rejects.toThrow();
		expect(fake.calls).toEqual([]);
	});

	it("rejects with a failing step's error after reporting the steps that completed", async () => {
		const fake = fakeStep("b");
		const control = new ChainControl();
		const done: Array<[string, string]> = [];
		const result = runChain(
			chain,
			"in",
			{ ...baseOptions, control, onStepDone: (step, _index, output) => done.push([step.name, output]) },
			fake.run,
		);
		await fake.release();
		await fake.release();

		await expect(result).rejects.toThrow("boom");
		expect(done).toEqual([["a", "in+a"]]);
		expect(control.signal.aborted).toBe(false);
	});
});
