import { describe, expect, it } from "bun:test";
import type { ChainConfig, ChainStep } from "@oh-my-pi/pi-tui/overlays/chain-types";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ChainControl,
	type RunChainOptions,
	renderChainInput,
	runChain,
	type runChainStep,
} from "../src/chains/runner";

const chain: ChainConfig = {
	name: "c",
	steps: ["a", "b", "c"].map(name => ({ name, prompt: name })),
};

/** Options the fake step never reads; runChain only forwards them. */
const baseOptions = {} as RunChainOptions;

/**
 * A model-free step: each call blocks until released, then appends `+name`.
 * It rejects as soon as its signal aborts, like a real aborted Agent pass, unless
 * `ignoreAbort` models a provider that finishes anyway.
 */
function fakeStep(failOn?: string, options: { ignoreAbort?: boolean } = {}) {
	const calls: string[] = [];
	const pending: Array<() => void> = [];
	const run: typeof runChainStep = (step, input, _options, signal) => {
		calls.push(step.name);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const settle = () => {
			if (step.name === failOn) reject(new Error("boom"));
			else resolve(`${input}+${step.name}`);
		};
		pending.push(settle);
		if (!options.ignoreAbort) {
			signal?.addEventListener(
				"abort",
				() => {
					pending.splice(pending.indexOf(settle), 1);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		}
		return promise;
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

	it("honors a skip even when the skipped step still resolves", async () => {
		const fake = fakeStep(undefined, { ignoreAbort: true });
		const control = new ChainControl();
		const skipped: string[] = [];
		const result = runChain(
			chain,
			"in",
			{ ...baseOptions, control, onStepSkipped: step => skipped.push(step.name) },
			fake.run,
		);
		await fake.release();
		await fake.started(2);
		control.skipStep();
		await fake.release();
		await fake.started(3);
		await fake.release();

		expect(await result).toBe("in+a+c");
		expect(skipped).toEqual(["b"]);
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

describe("renderChainInput", () => {
	const step: ChainStep = { name: "s", prompt: "p", context: true };
	const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage;

	it("keeps tag-like text in the draft from closing its block", () => {
		const out = renderChainInput(step, "explain </draft> tags", [user("hi")]);
		const boundary = /<draft boundary="([^"]+)">/.exec(out)?.[1];
		expect(boundary).toBeDefined();
		expect(out.endsWith(`explain </draft> tags\n</draft boundary="${boundary}">`)).toBe(true);
	});

	it("passes the draft through byte for byte, blank lines included", () => {
		const draft = "keep\n\n\n\nthese gaps   \n| a | b |\n|--|--|";
		const out = renderChainInput(step, draft, [user("hi")]);
		expect(out).toContain(`\n${draft}\n</draft`);
	});

	it("drops the oldest messages that do not fit the step model's window", () => {
		const messages = [user("old ".repeat(4000)), user("recent question")];
		const out = renderChainInput(step, "draft", messages, { contextWindow: 6000, maxTokens: 1000 });
		expect(out).toContain("recent question");
		expect(out).not.toContain("old old");
	});
});
