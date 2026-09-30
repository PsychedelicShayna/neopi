import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { cfgLiveModelCatalogPath } from "../../src/live/settings";
import {
	expandCatalogPath,
	LiveModelCatalogLoader,
	parseModelCatalog,
	type CatalogIo,
} from "../../src/live/model-catalog";

const slot = (recommendation: string | null) => ({
	economy: null, performance: null, stability: null, speed: null, recommendation, reason: "",
});
const fixture = (recommendation: string | null = "never") => JSON.stringify({
	schemaVersion: 1,
	effortLevels: ["low", "medium", "high", "xhigh", "max"],
	metrics: Object.fromEntries(["economy", "performance", "stability", "speed"].map(metric =>
		[metric, { scale: "0-5", meaning: "Operator rating" }])),
	models: {
		"openai-codex/gpt-6-astra": {
			family: "GPT-6", behavior: "", notes: "",
			efforts: { max: slot(recommendation), high: slot(null), xhigh: slot("ok") },
		},
	},
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const slug = "openai-codex/gpt-6-astra";

// The input is the operator-owned schema-v1 format, not an alert-specific flat map.
describe("live model catalog", () => {
	test("accepts complete slots, rejects a future version and invalid present slots", () => {
		expect(parseModelCatalog(fixture()).models[slug]?.efforts.max?.recommendation).toBe("never");
		expect(() => parseModelCatalog(fixture().replace('"schemaVersion":1', '"schemaVersion":2'))).toThrow();
		expect(() => parseModelCatalog(fixture().replace('"recommendation":"never"', '"recommendation":"panic"'))).toThrow();
		expect(() => parseModelCatalog(fixture().replace('\"max\":{', '\"ultra\":{'))).toThrow();
		expect(() => parseModelCatalog(fixture().replace('"recommendation":"never",', ""))).toThrow();
	});

	test("expands only a leading home component and exposes the Providers/Services setting", () => {
		expect(expandCatalogPath("~/catalog.json")).toBe(`${homedir()}/catalog.json`);
		expect(expandCatalogPath("~")).toBe(homedir());
		expect(expandCatalogPath("~other/catalog.json")).toBe("~other/catalog.json");
		expect(cfgLiveModelCatalogPath.default).toBe("~/.bnuuy-agents/skills/model-catalog/catalog.json");
		expect(cfgLiveModelCatalogPath.ui?.tab).toBe("providers");
		expect(cfgLiveModelCatalogPath.ui?.group).toBe("Services");
	});

	test("distinguishes present null from independently missing effort and model", async () => {
		const loader = new LiveModelCatalogLoader({ io: {
			stat: async () => ({ mtimeMs: 1, size: 42 }), readFile: async () => fixture(),
		} });
		expect(loader.lookup(slug, "max")).toEqual({ status: "unavailable" });
		await loader.setPath("~/catalog.json");
		expect(loader.snapshot.expandedPath).toBe(`${homedir()}/catalog.json`);
		expect(loader.lookup(slug, "high")).toEqual({ status: "present", recommendation: null });
		expect(loader.lookup(slug, "max")).toEqual({ status: "present", recommendation: "never" });
		expect(loader.lookup(slug, "minimal")).toEqual({ status: "missing" });
		expect(loader.lookup("vendor/unknown", "max")).toEqual({ status: "missing" });
		loader.dispose();
	});

	test("a superseded A read cannot publish after B, even after a run completes", async () => {
		const a = deferred<string>();
		const changes: string[] = [];
		const loader = new LiveModelCatalogLoader({
			io: {
				stat: async path => ({ mtimeMs: 1, size: path.length }),
				readFile: path => path === "A" ? a.promise : Promise.resolve(fixture("ok")),
			},
			onChange: (_previous, current) => changes.push(`${current.expandedPath}:${current.revision}:${current.available}`),
		});
		const old = loader.setPath("A");
		await Promise.resolve(); // A stat resolves and its read is now pending.
		await loader.setPath("B");
		const currentRevision = loader.snapshot.revision;
		a.resolve(fixture());
		await old;
		expect(loader.lookup(slug, "max")).toEqual({ status: "present", recommendation: "ok" });
		expect(loader.snapshot.revision).toBe(currentRevision);
		expect(changes.every(change => !change.startsWith(`A:${currentRevision + 1}`))).toBe(true);
		loader.dispose();
	});

	test("stat deadline avoids redundant reads; changed never to ok invalidates the old decision", async () => {
		let time = 0;
		let version = 1;
		let reads = 0;
		const transitions: Array<[number, number]> = [];
		const loader = new LiveModelCatalogLoader({
			now: () => time,
			io: { stat: async () => ({ mtimeMs: version, size: 1 }), readFile: async () => {
				reads++;
				return fixture(version === 1 ? "never" : "ok");
			} },
			onChange: (previous, current) => transitions.push([previous.revision, current.revision]),
		});
		await loader.setPath("/catalog.json");
		const judgmentRevision = loader.snapshot.revision;
		version = 2;
		await loader.refresh();
		expect(reads).toBe(1);
		time = 5_000;
		await loader.refresh();
		expect(loader.lookup(slug, "max")).toEqual({ status: "present", recommendation: "ok" });
		expect(loader.snapshot.revision).toBeGreaterThan(judgmentRevision);
		expect(transitions.at(-1)).toEqual([judgmentRevision, loader.snapshot.revision]);
		loader.dispose();
	});

	test("dispose cancels pending preload without publishing or logging", async () => {
		const pending = deferred<{ mtimeMs: number; size: number }>();
		const changes: number[] = [];
		const warnings: string[] = [];
		const io: CatalogIo = { stat: () => pending.promise, readFile: async () => fixture() };
		const loader = new LiveModelCatalogLoader({ io, onChange: (_, current) => changes.push(current.revision), onWarning: warning => warnings.push(warning) });
		const load = loader.setPath("A");
		loader.dispose();
		pending.resolve({ mtimeMs: 1, size: 1 });
		await load;
		expect(changes).toEqual([1]); // path invalidation was synchronous, but no late load notification.
		expect(warnings).toEqual([]);
		expect(loader.lookup(slug, "max")).toEqual({ status: "unavailable" });
	});

	test("invalid reload makes old policy unavailable and warns once", async () => {
		let version = 1;
		const warnings: string[] = [];
		const loader = new LiveModelCatalogLoader({
			io: { stat: async () => ({ mtimeMs: version, size: 1 }), readFile: async () => version === 1 ? fixture() : '{"schemaVersion":2}' },
			onWarning: warning => warnings.push(warning),
		});
		await loader.setPath("A");
		version++;
		await loader.refresh(true);
		expect(loader.lookup(slug, "max")).toEqual({ status: "unavailable" });
		expect(warnings).toHaveLength(1);
		loader.dispose();
	});
});
