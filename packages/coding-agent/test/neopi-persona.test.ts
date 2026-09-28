import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	createPersonaFeature,
	type PersonaDefinition,
	type PersonaHost,
	PersonaStore,
} from "@oh-my-pi/pi-coding-agent/neopi/persona";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const BASE = ["BASE-PROMPT with {{slot}}"];
const inline = (content: string, mode: PersonaDefinition["mode"] = "replace", literal?: string): PersonaDefinition => ({
	mode,
	source: { kind: "inline", content },
	...(literal ? { literal } : {}),
});

describe("NeoPi personas", () => {
	let dir: string;
	let previousAgentDir: string;
	const status = new Map<string, string | undefined>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let invalidations = 0;
	const host = (sessionId: string): PersonaHost => ({
		sessionId,
		ui: { setStatus: (key, text) => status.set(key, text), setWidget: () => {} },
		invalidatePromptCache: () => {
			invalidations++;
		},
		appendEntry: (customType, data) => entries.push({ customType, data }),
	});

	beforeEach(async () => {
		previousAgentDir = getAgentDir();
		dir = path.join(previousAgentDir, `persona-test-${Bun.randomUUIDv7()}`);
		await fs.mkdir(dir, { recursive: true });
		setAgentDir(dir);
		status.clear();
		entries.length = 0;
		invalidations = 0;
	});

	afterEach(async () => {
		setAgentDir(previousAgentDir);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("shapes the system prompt per mode for the selected session only", async () => {
		const personas = createPersonaFeature(new PersonaStore(path.join(dir, "neopi-persona.json")), () => dir);
		await personas.create("r", inline("R"));
		await personas.create("p", inline("P", "prepend"));
		await personas.create("a", inline("A", "append"));
		await personas.create("s", inline("S", "literal-substitute", "{{slot}}"));

		expect(await personas.apply(BASE, host("s1"))).toBeUndefined();
		await personas.use("r", host("s1"));
		expect(await personas.apply(BASE, host("s1"))).toEqual(["R"]);
		expect(await personas.apply(BASE, host("other"))).toBeUndefined();
		await personas.use("p", host("s1"));
		expect(await personas.apply(BASE, host("s1"))).toEqual(["P", ...BASE]);
		await personas.use("a", host("s1"));
		expect(await personas.apply(BASE, host("s1"))).toEqual([...BASE, "A"]);
		await personas.use("s", host("s1"));
		expect(await personas.apply(BASE, host("s1"))).toEqual(["BASE-PROMPT with S"]);
		expect(status.get("neopi-persona")).toBe("persona: s");
	});

	it("keeps the base prompt and reports a warning when a persona cannot apply", async () => {
		const personas = createPersonaFeature(new PersonaStore(path.join(dir, "neopi-persona.json")), () => dir);
		await personas.create("s", inline("S", "literal-substitute", "{{missing}}"));
		await personas.use("s", host("s1"));
		expect(await personas.apply(BASE, host("s1"))).toBeUndefined();
		expect(await personas.status("s1")).toContain("literal not found");
		expect(status.get("neopi-persona")).toBe("persona: s (warning)");
		expect(entries.filter(e => e.customType === "neopi_persona_warning")).toHaveLength(1);
	});

	it("refuses file sources that escape the agent directory", async () => {
		const personas = createPersonaFeature(new PersonaStore(path.join(dir, "neopi-persona.json")), () => dir);
		await expect(
			personas.create("escape", { mode: "replace", source: { kind: "file", path: "../../etc/hostname" } }),
		).rejects.toThrow();
	});

	it("saveAll carries other sessions' selections across renames and drops removed personas", async () => {
		const statePath = path.join(dir, "neopi-persona.json");
		const personas = createPersonaFeature(new PersonaStore(statePath), () => dir);
		await personas.create("old", inline("OLD"));
		await personas.create("gone", inline("GONE"));
		await personas.use("old", host("s1"));
		await personas.use("gone", host("s2"));
		invalidations = 0;

		await personas.saveAll({ new: inline("OLD") }, new Map([["old", "new"]]), "new", host("s3"));

		const state = await new PersonaStore(statePath).read();
		expect(state.sessionPersonas).toEqual({ s1: "new", s3: "new" });
		// s3 went from no persona to one, so its cached prompt is stale.
		expect(invalidations).toBe(1);
		expect(await personas.apply(BASE, host("s1"))).toEqual(["OLD"]);
	});

	it("reads the pre-rename omomp-persona.json state", async () => {
		await Bun.write(
			path.join(dir, "omomp-persona.json"),
			JSON.stringify({
				schemaVersion: 1,
				personas: { legacy: inline("LEGACY") },
				sessionPersonas: { s1: "legacy" },
			}),
		);
		const personas = createPersonaFeature(new PersonaStore(path.join(dir, "neopi-persona.json")), () => dir);
		expect(await personas.apply(BASE, host("s1"))).toEqual(["LEGACY"]);
	});

	it("applies the session persona to the provider prompt before extensions see it", async () => {
		const model: Model<"openai-responses"> = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const sent: string[][] = [];
		const seenByExtension: string[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: BASE, tools: [], messages: [] },
			convertToLlm,
			streamFn: (m, context, options) => {
				sent.push([...(context.systemPrompt ?? [])]);
				return mock.stream(m, context, options);
			},
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				emitBeforeAgentStart: async (_prompt: string, _images: unknown, systemPrompt: string[]) => {
					seenByExtension.push(systemPrompt);
					return undefined;
				},
				emit: async () => undefined,
				getUIContext: () => ({ setStatus: () => {}, setWidget: () => {} }),
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: BASE }),
		});
		try {
			// The session reads the default store in the active agent dir.
			const personas = createPersonaFeature(new PersonaStore(), () => dir);
			await personas.create("pirate", inline("Talk like a pirate.", "append"));
			await personas.use("pirate", host(sessionManager.getSessionId()));

			await session.prompt("hello");
			await session.waitForIdle();

			expect(seenByExtension).toEqual([[...BASE, "Talk like a pirate."]]);
			expect(sent).toEqual([[...BASE, "Talk like a pirate."]]);
		} finally {
			await session.dispose();
		}
	});
});
