import { describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_INGEST_DEFAULTS, LiveIngestSettingsSource, normalizeLiveIngestSettings, resolveLiveIngestSettings } from "../../src/live/ingest-settings";
import { createLivePersonaFeature, LivePersonaStore, onLivePersonaStateChanged, type LivePersonaState, validateLivePersonaState } from "../../src/live/personas";


describe("live ingest persona settings", () => {
	it("merges defaults deeply without retaining unknown keys or aliases", () => {
		const resolved = normalizeLiveIngestSettings({ advisorNotes: { blocker: false }, voicedSlotsByDepth: [1, -1], relayFinalAnswers: false, extra: true });
		expect(resolved.advisorNotes).toEqual({ nit: true, concern: true, blocker: false });
		expect(resolved.voicedSlotsByDepth).toEqual([1, -1]);
		expect(resolved.relayFinalAnswers).toBe(false);
		expect("extra" in resolved).toBe(false);
		expect(normalizeLiveIngestSettings({})).toEqual(LIVE_INGEST_DEFAULTS);
	});
	it("rejects invalid present schema-v1 ingest records with field context", () => {
		const state = { schemaVersion: 1, personas: { mira: { instructions: "voice", ingest: { voicedSlotsByDepth: [0] } } } };
		expect(() => validateLivePersonaState(state)).toThrow(/personas\.mira\.ingest voicedSlotsByDepth: must be a non-empty array/);
		expect(() => normalizeLiveIngestSettings({ subagentMaxDepth: 0 })).toThrow(/subagentMaxDepth: must be a positive integer/);
		expect(() => normalizeLiveIngestSettings({ classifierQuietMs: 600001 })).toThrow(/classifierQuietMs: must be an integer/);
		expect(() => normalizeLiveIngestSettings({ rescoreIntervalMs: 30000 })).toThrow(/rescoreIntervalMs: must be 0 or/);
	});
	it("resolves the active persona and persists the built-in settings independently of instructions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ingest-persona-"));
		try {
			const path = join(dir, "neopi-live-personas.json");
			const feature = createLivePersonaFeature(new LivePersonaStore(path));
			await feature.saveAll({ mira: { instructions: "Mira", ingest: normalizeLiveIngestSettings({ ircPeers: false }) } }, "mira", normalizeLiveIngestSettings({ advisorThinking: true }));
			expect((await resolveLiveIngestSettings(path)).ircPeers).toBe(false);
			await feature.use("default");
			expect((await resolveLiveIngestSettings(path)).advisorThinking).toBe(true);
			await feature.clone("default", "clone");
			expect((await feature.data()).items.find(item => item.name === "clone")?.ingest.advisorThinking).toBe(true);
			await feature.edit("clone", "Updated");
			expect((await feature.data()).items.find(item => item.name === "clone")?.ingest.advisorThinking).toBe(true);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it("notifies listeners after successful writes without a throwing listener blocking later subscribers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ingest-notify-"));
		const first: string[] = [];
		try {
			const feature = createLivePersonaFeature(new LivePersonaStore(join(dir, "personas.json")));
			const bad = onLivePersonaStateChanged(() => { throw new Error("ignored notifier failure"); });
			const good = onLivePersonaStateChanged(() => first.push("changed"));
			try {
				await feature.clone("default", "mira");
				await feature.edit("mira", "Updated");
				await feature.use("mira");
				await feature.saveAll({ mira: { instructions: "Again" } }, "mira", normalizeLiveIngestSettings({ advisorThinking: true }));
				await feature.delete("mira");
				expect(first).toEqual(["changed", "changed", "changed", "changed", "changed"]);
			} finally { bad(); good(); }
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it("degrades unreadable and dangling persona state to defaults without exposing stale custom settings", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ingest-fallback-"));
		try {
			const path = join(dir, "personas.json");
			await Bun.write(path, "{broken json");
			expect(await resolveLiveIngestSettings(path)).toEqual(LIVE_INGEST_DEFAULTS);
			await Bun.write(path, JSON.stringify({ schemaVersion: 1, personas: {}, active: "gone" }));
			expect(await resolveLiveIngestSettings(path)).toEqual(LIVE_INGEST_DEFAULTS);
			await Bun.write(path, JSON.stringify({ schemaVersion: 1, personas: {}, defaultIngest: { effortAlerts: false } }));
			expect((await resolveLiveIngestSettings(path)).effortAlerts).toBe(false);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it("does not orphan earlier refresh waiters when a newer read races or detach invalidates the wave", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ingest-refresh-"));
		try {
			const source = new LiveIngestSettingsSource(normalizeLiveIngestSettings(undefined), join(dir, "missing.json"));
			const first = source.refresh();
			const second = source.refresh();
			await Promise.all([first, second]);
			const detach = source.attach();
			const pending = source.refresh();
			detach();
			await pending;
			expect(source.get().ircPrimary).toBe(true);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	it("holds every wave waiter when a listener synchronously requests a newer refresh", async () => {
		const firstRead = Promise.withResolvers<LivePersonaState>();
		const newerRead = Promise.withResolvers<LivePersonaState>();
		let reads = 0;
		const original = vi.spyOn(LivePersonaStore.prototype, "read").mockImplementation(() =>
			++reads === 1 ? firstRead.promise : newerRead.promise,
		);
		try {
			const source = new LiveIngestSettingsSource(normalizeLiveIngestSettings(undefined), "/ignored");
			let listenerRequested = false;
			source.listen(() => {
				if (!listenerRequested) { listenerRequested = true; void source.refresh(); }
			});
			let settled = false;
			const wave = source.refresh().then(() => { settled = true; });
			firstRead.resolve({ schemaVersion: 1, personas: {}, defaultIngest: normalizeLiveIngestSettings({ relayReasoning: false }) });
			for (let i = 0; i < 5; i++) await Promise.resolve();
			expect(reads).toBe(2);
			expect(settled).toBe(false);
			newerRead.resolve({ schemaVersion: 1, personas: {}, defaultIngest: normalizeLiveIngestSettings({ relayReasoning: true }) });
			await wave;
			expect(source.get().relayReasoning).toBe(true);
		} finally { original.mockRestore(); }
	});
	it("notifies only for changed normalized records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ingest-notify-"));
		const path = join(dir, "live.json");
		try {
			const source = new LiveIngestSettingsSource(normalizeLiveIngestSettings(undefined), path);
			const events: Array<[boolean, boolean]> = [];
			source.listen((next, previous) => events.push([previous.advisorNotes.blocker, next.advisorNotes.blocker]));
			await source.refresh();
			expect(events).toEqual([]);
			await Bun.write(path, JSON.stringify({ schemaVersion: 1, personas: {}, defaultIngest: { advisorNotes: { blocker: false } } }));
			await source.refresh();
			expect(events).toEqual([[true, false]]);
			await source.refresh();
			expect(events).toEqual([[true, false]]);
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
});
