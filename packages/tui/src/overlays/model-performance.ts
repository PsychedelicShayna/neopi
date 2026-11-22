import type { ModelBrowserPerf } from "./model-browser";

/** A measured perf aggregate and, when it came from one, its service tier. */
export interface MeasuredPerf {
	perf: ModelBrowserPerf;
	tier?: string;
}

/** Resolve a requested tier, the standard aggregate, or the fastest measured tier. */
export class ModelPerformanceLookup {
	#fastest?: { size: number; bySelector: Map<string, MeasuredPerf> };

	constructor(readonly samples: ReadonlyMap<string, ModelBrowserPerf> = new Map()) {}

	get(selector: string, tier?: string): MeasuredPerf | undefined {
		const samples = this.samples;
		if (samples.size === 0) return undefined;
		if (tier) {
			const perf = samples.get(`${selector}@${tier}`);
			if (perf) return { perf, tier };
		}
		const perf = samples.get(selector);
		if (perf) return { perf };
		let fastest = this.#fastest;
		if (fastest?.size !== samples.size) {
			const bySelector = new Map<string, MeasuredPerf>();
			for (const [key, perf] of samples) {
				// Every `@` may end the selector: `a@b@t` is tier `b@t` of `a` and tier `t` of `a@b`.
				for (let at = key.indexOf("@"); at >= 0; at = key.indexOf("@", at + 1)) {
					const owner = key.slice(0, at);
					const current = bySelector.get(owner);
					if (!current || perf.tps > current.perf.tps) bySelector.set(owner, { perf, tier: key.slice(at + 1) });
				}
			}
			fastest = this.#fastest = { size: samples.size, bySelector };
		}
		return fastest.bySelector.get(selector);
	}
}
