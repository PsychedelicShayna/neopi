import { logger } from "@oh-my-pi/pi-utils";

const QUICK_DELAY_MS = 6_000;
const FAST_REFRESH_MS = 1_000;
const SMALL_CATALOG_MODELS = 12;

interface CatalogRefreshSource {
	providers(): string[];
	/** Existing model keys in most-recently-used order. */
	usage(): readonly string[];
	cycleMs(): number;
	modelCount(provider: string): number | undefined;
	refresh(provider: string): Promise<void>;
}

type Schedule = (run: () => void, delayMs: number) => () => void;

function scheduleUnref(run: () => void, delayMs: number): () => void {
	const timer = setTimeout(run, delayMs).unref();
	return () => clearTimeout(timer);
}

/** Start on a timer turn; always wait for the active provider before scheduling another. */
export function startCatalogRefresh(
	source: CatalogRefreshSource,
	schedule: Schedule = scheduleUnref,
	now: () => number = () => performance.now(),
): () => void {
	const timings = new Map<string, { samples: number; averageMs: number }>();
	let stopped = false;
	let cancelTimer: (() => void) | undefined;
	let providers: { id: string; quick: boolean }[] = [];
	let index = 0;
	let cycleMs = 0;
	let delaySpent = 0;

	const queue = (delayMs: number) => {
		if (stopped) return;
		cancelTimer = schedule(() => {
			cancelTimer = undefined;
			void tick();
		}, delayMs);
	};

	async function tick(): Promise<void> {
		if (stopped) return;
		if (index === providers.length) {
			const ids = new Set(source.providers());
			const ordered: string[] = [];
			for (const key of source.usage()) {
				const slash = key.indexOf("/");
				if (slash < 1) continue;
				const provider = key.slice(0, slash);
				if (ids.delete(provider)) ordered.push(provider);
			}
			const classify = (id: string) => {
				const averageMs = timings.get(id)?.averageMs;
				const small = (source.modelCount(id) ?? Infinity) <= SMALL_CATALOG_MODELS;
				return {
					id,
					quick: small ? (averageMs ?? 0) < QUICK_DELAY_MS : (averageMs ?? Infinity) <= FAST_REFRESH_MS,
				};
			};
			providers = ordered.map(classify);
			// Keep explicit MRU rank intact. Among providers with no recorded
			// use, batch the quick ones together instead of interleaving them.
			const remaining: typeof providers = [];
			for (const id of ids) {
				const provider = classify(id);
				(provider.quick ? providers : remaining).push(provider);
			}
			providers.push(...remaining);
			index = 0;
			cycleMs = source.cycleMs();
			delaySpent = 0;
		}
		const provider = providers[index++];
		if (!provider) {
			index = 0;
			queue(cycleMs);
			return;
		}
		const started = now();
		try {
			await source.refresh(provider.id);
		} catch (error) {
			logger.warn("background catalog refresh failed", { provider: provider.id, error: String(error) });
		}
		const elapsed = now() - started;
		const timing = timings.get(provider.id);
		if (timing) timing.averageMs += (elapsed - timing.averageMs) / ++timing.samples;
		else timings.set(provider.id, { samples: 1, averageMs: elapsed });

		const next = providers[index];
		const interval = cycleMs / providers.length;
		// Short gaps are used inside a quick batch only. Return the saved time
		// at the end so quick providers don't make the whole cycle run more often.
		const delay = next
			? provider.quick && next.quick
				? Math.min(QUICK_DELAY_MS, interval)
				: interval
			: cycleMs - delaySpent;
		delaySpent += delay;
		queue(delay);
	}

	queue(0);
	return () => {
		stopped = true;
		cancelTimer?.();
	};
}
