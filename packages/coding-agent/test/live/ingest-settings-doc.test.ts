import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, logger } from "@oh-my-pi/pi-utils";
import {
	LIVE_INGEST_DEFAULTS,
	LiveIngestSettingsSource,
	normalizeLiveIngestSettings,
	resolveLiveIngestSettings,
} from "@oh-my-pi/pi-coding-agent/live/ingest-settings";
import {
	createLivePersonaFeature,
	LivePersonaStore,
	onLivePersonaStateChanged,
} from "@oh-my-pi/pi-coding-agent/live/personas";
import {
	loadPersonaConfigDoc,
	savePersonaConfigDoc,
} from "@oh-my-pi/pi-coding-agent/neopi/persona-config";
import type { PersonaHost } from "@oh-my-pi/pi-coding-agent/neopi/persona";

const FIELD_KEYS = [
	"ircPrimary",
	"ircPeers",
	"subagents",
	"subagentMaxDepth",
	"voicedSlotsByDepth.0",
	"voicedSlotsByDepth.1",
	"voicedSlotsByDepth.2",
	"subagentClassifier",
	"classifierQuietMs",
	"rescoreIntervalMs",
	"startAnnounceQuietMs",
	"voicedChangeCue",
	"effortAlerts",
	"advisorNotes.nit",
	"advisorNotes.concern",
	"advisorNotes.blocker",
	"advisorThinking",
	"relayReasoning",
	"relayProgress",
	"relayFinalAnswers",
	"includeVoiceNote",
];

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let dir: string;
let statePath: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-ingest-settings-"));
	statePath = path.join(dir, "neopi-live-personas.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	__resetDirsFromEnvForTests();
});

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	__resetDirsFromEnvForTests();
	await fs.rm(dir, { recursive: true, force: true });
});

function changed(overrides: Record<string, unknown>) {
	return normalizeLiveIngestSettings({ ...LIVE_INGEST_DEFAULTS, ...overrides });
}

describe("live ingest persona documents", () => {
	test("loads every live entry with ordered, resolved source fields", async () => {
		await Bun.write(statePath, JSON.stringify({
			schemaVersion: 1,
			defaultIngest: changed({ relayProgress: false }),
			personas: {
				short: { instructions: "short", ingest: changed({ voicedSlotsByDepth: [8], subagentMaxDepth: 4 }) },
				long: { instructions: "long", ingest: changed({ voicedSlotsByDepth: [8, 4, 2, 1, 32] }) },
				legacy: { instructions: "legacy" },
			},
			active: "short",
		}));

		const doc = await loadPersonaConfigDoc("live", "unused");
		const builtin = doc.entries.find(entry => entry.builtin);
		const short = doc.entries.find(entry => entry.name === "short");
		const long = doc.entries.find(entry => entry.name === "long");
		const legacy = doc.entries.find(entry => entry.name === "legacy");
		expect(builtin?.sources).toHaveLength(21);
		expect(short?.sources).toHaveLength(19);
		expect(long?.sources).toHaveLength(23);
		expect(legacy?.sources).toHaveLength(21);
		expect(builtin?.sources?.map(field => field.key)).toEqual(FIELD_KEYS);
		expect(short?.sources?.map(field => field.key)).toEqual([
			...FIELD_KEYS.slice(0, 5),
			...FIELD_KEYS.slice(7),
		]);
		expect(builtin?.sources?.find(field => field.key === "relayProgress")?.value).toBe(false);
		expect(legacy?.sources?.find(field => field.key === "relayProgress")?.value).toBe(true);
		const depth = short?.sources?.find(field => field.key === "subagentMaxDepth");
		expect(depth?.value).toBe("4");
		if (depth?.kind !== "choice") throw new Error("depth was not a choice");
		expect(depth.options[0]).toEqual({ value: "4", label: "Custom (4)" });
	});

	test("saves only edited fields while retaining depth tails and built-in settings", async () => {
		const alpha = changed({ voicedSlotsByDepth: [8, 4, 2, 1, 32], relayProgress: false });
		const beta = changed({ voicedSlotsByDepth: [8] });
		await Bun.write(statePath, JSON.stringify({
			schemaVersion: 1,
			defaultIngest: changed({ advisorThinking: true }),
			personas: {
				alpha: { instructions: "alpha", ingest: alpha },
				beta: { instructions: "beta", ingest: beta },
			},
			active: "alpha",
		}));
		const doc = await loadPersonaConfigDoc("live", "unused");
		const alphaEntry = doc.entries.find(entry => entry.name === "alpha");
		const builtin = doc.entries.find(entry => entry.builtin);
		const irc = alphaEntry?.sources?.find(field => field.key === "ircPeers");
		const depth2 = alphaEntry?.sources?.find(field => field.key === "voicedSlotsByDepth.1");
		const defaultRelay = builtin?.sources?.find(field => field.key === "relayFinalAnswers");
		if (irc?.kind !== "boolean" || depth2?.kind !== "choice" || defaultRelay?.kind !== "boolean") {
			throw new Error("missing editable fields");
		}
		irc.value = false;
		depth2.value = "16";
		defaultRelay.value = false;
		await savePersonaConfigDoc("live", doc, {} as PersonaHost);

		const state = await new LivePersonaStore(statePath).read();
		expect(state.personas.alpha?.ingest).toEqual({
			...alpha,
			ircPeers: false,
			voicedSlotsByDepth: [8, 16, 2, 1, 32],
		});
		expect(state.personas.beta?.ingest).toEqual(beta);
		expect(state.defaultIngest?.advisorThinking).toBe(true);
		expect(state.defaultIngest?.relayFinalAnswers).toBe(false);
		expect(state.personas.default).toBeUndefined();
	});

	test("does not add live source fields to ordinary persona documents", async () => {
		const doc = await loadPersonaConfigDoc("persona", "settings-doc-test");
		expect(doc.entries.every(entry => entry.sources === undefined && entry.sourcesRaw === undefined)).toBe(true);
	});
});

describe("live ingest settings resolution and notifications", () => {
	test("resolves active, built-in, and corrupt stores", async () => {
		const custom = changed({ relayReasoning: false });
		await Bun.write(statePath, JSON.stringify({
			schemaVersion: 1,
			personas: { iris: { instructions: "iris", ingest: custom } },
			active: "iris",
		}));
		expect(await resolveLiveIngestSettings(statePath)).toEqual(custom);
		await Bun.write(statePath, JSON.stringify({ schemaVersion: 1, personas: {} }));
		expect(await resolveLiveIngestSettings(statePath)).toEqual(LIVE_INGEST_DEFAULTS);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		await Bun.write(statePath, "{ corrupt");
		expect(await resolveLiveIngestSettings(statePath)).toEqual(LIVE_INGEST_DEFAULTS);
		expect(warning).toHaveBeenCalledTimes(1);
		warning.mockRestore();
	});

	test("emits one state notification per successful mutation", async () => {
		const feature = createLivePersonaFeature(new LivePersonaStore(statePath));
		await feature.clone("default", "alpha");
		let calls = 0;
		const unsubscribe = onLivePersonaStateChanged(() => calls++);
		await feature.use("alpha");
		expect(calls).toBe(1);
		await feature.edit("alpha", "changed");
		expect(calls).toBe(2);
		await feature.clone("alpha", "beta");
		expect(calls).toBe(3);
		await feature.delete("beta");
		expect(calls).toBe(4);
		await feature.saveAll({ alpha: { instructions: "saved", ingest: changed({ relayProgress: false }) } }, "alpha");
		expect(calls).toBe(5);
		unsubscribe();
	});

	test("settings source listeners run only when the resolved record changes", async () => {
		const source = new LiveIngestSettingsSource(normalizeLiveIngestSettings(undefined), statePath);
		let calls = 0;
		source.listen(() => calls++);
		await source.refresh();
		expect(calls).toBe(0);
		const feature = createLivePersonaFeature(new LivePersonaStore(statePath));
		await feature.saveAll({ iris: { instructions: "iris", ingest: changed({ includeVoiceNote: false }) } }, "iris");
		await source.refresh();
		expect(calls).toBe(1);
		await source.refresh();
		expect(calls).toBe(1);
	});
});
