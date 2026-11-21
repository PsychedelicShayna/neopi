import { expect, test } from "bun:test";
import { startCatalogRefresh } from "../../src/config/catalog-refresh";

interface Alarm {
	delay: number;
	run: () => void;
}

function alarms() {
	let pending: Alarm | undefined;
	return {
		schedule(run: () => void, delay: number) {
			if (pending) throw new Error("already scheduled");
			const alarm = { delay, run };
			pending = alarm;
			return () => {
				if (pending === alarm) pending = undefined;
			};
		},
		get delay() {
			return pending?.delay;
		},
		async fire() {
			const alarm = pending;
			if (!alarm) throw new Error("nothing scheduled");
			pending = undefined;
			alarm.run();
			await Promise.resolve();
		},
	};
}

test("catalog discovery follows MRU, awaits each provider, and spaces adjacent fast providers without shortening the cycle", async () => {
	const clock = alarms();
	const first = Promise.withResolvers<void>();
	const visits: string[] = [];
	const stop = startCatalogRefresh(
		{
			providers: () => ["large-next", "small-next", "large-first", "small-first"],
			usage: () => ["large-first/model", "small-first/model", "small-first/other", "small-next/model"],
			cycleMs: () => 120_000,
			modelCount: provider => (provider.startsWith("small") ? 2 : 100),
			refresh: async provider => {
				visits.push(provider);
				if (visits.length === 1) await first.promise;
			},
		},
		clock.schedule,
	);
	try {
		expect(clock.delay).toBe(0);
		await clock.fire();
		expect(visits).toEqual(["large-first"]);
		expect(clock.delay).toBeUndefined();
		first.resolve();
		await first.promise;
		await Promise.resolve();
		expect(clock.delay).toBe(30_000);
		await clock.fire();
		expect(clock.delay).toBe(6_000);
		await clock.fire();
		expect(clock.delay).toBe(30_000);
		await clock.fire();
		expect(visits).toEqual(["large-first", "small-first", "small-next", "large-next"]);
		expect(clock.delay).toBe(54_000);
	} finally {
		first.resolve();
		stop();
	}
	expect(clock.delay).toBeUndefined();
});

test("fast measured providers join the short cadence on later cycles even with large catalogs", async () => {
	const clock = alarms();
	let now = 0;
	const stop = startCatalogRefresh(
		{
			providers: () => ["a", "b"],
			usage: () => [],
			cycleMs: () => 60_000,
			modelCount: () => 100,
			refresh: async () => {
				now += 200;
			},
		},
		clock.schedule,
		() => now,
	);
	try {
		await clock.fire();
		expect(clock.delay).toBe(30_000);
		await clock.fire();
		expect(clock.delay).toBe(30_000);
		await clock.fire();
		expect(clock.delay).toBe(6_000);
		await clock.fire();
		expect(clock.delay).toBe(54_000);
	} finally {
		stop();
	}
});

test("groups quick unranked providers behind the known most recently used ones", async () => {
	const clock = alarms();
	const visits: string[] = [];
	const stop = startCatalogRefresh(
		{
			providers: () => ["small-a", "large-unknown", "small-b", "large-recent"],
			usage: () => ["large-recent/model"],
			cycleMs: () => 120_000,
			modelCount: provider => (provider.startsWith("small") ? 2 : 100),
			refresh: async provider => {
				visits.push(provider);
			},
		},
		clock.schedule,
	);
	try {
		await clock.fire();
		expect(clock.delay).toBe(30_000);
		await clock.fire();
		expect(clock.delay).toBe(6_000);
		await clock.fire();
		await clock.fire();
		expect(visits).toEqual(["large-recent", "small-a", "small-b", "large-unknown"]);
	} finally {
		stop();
	}
});
