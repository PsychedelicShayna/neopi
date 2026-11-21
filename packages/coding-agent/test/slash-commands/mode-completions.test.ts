import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { saveModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BUILTIN_SLASH_COMMANDS,
	buildTuiBuiltinSlashCommands,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

async function values(name: string, prefix: string, runtime?: TuiSlashCommandRuntime) {
	const commands = runtime ? buildTuiBuiltinSlashCommands(runtime) : BUILTIN_SLASH_COMMANDS;
	const command = commands.find(item => item.name === name);
	const suggestions = await command?.getArgumentCompletions?.(prefix);
	return suggestions?.map(item => item.value) ?? [];
}

describe("mode argument completion", () => {
	test("completes clear only for writable override scopes and off only for a goal budget", async () => {
		expect(await values("settings", "session c")).toEqual(["session clear "]);
		expect(await values("settings", "project c")).toEqual(["project clear "]);
		expect(await values("settings", "global c")).toEqual([]);
		expect(await values("goal", "budget o")).toEqual(["budget off "]);
		expect(await values("goal", "budget 15")).toEqual([]);
	});

	test("completes loop units and flags but not condition commands or prompts", async () => {
		expect(await values("loop", "15 mi")).toContain("15 minutes ");
		expect(await values("loop", "1h30mi")).toContain("1h30minutes ");
		expect(await values("loop", "15 --u")).toEqual(["15 --until "]);
		expect(await values("loop", "15 min --w")).toEqual(["15 min --while "]);
		expect(await values("loop", "15 --until 'bun test' --w")).toEqual([]);
		expect(await values("loop", "15 keep checking --w")).toEqual([]);
	});

	test("completes comma-separated chat categories in either include spelling", async () => {
		expect(await values("chat", "raw --inc")).toEqual(["raw --include "]);
		expect(await values("chat", "--include=cwd,con")).toEqual(["--include=cwd,contextFiles "]);
		expect(await values("chat", "chat --include date,co")).toEqual(["chat --include date,contextFiles "]);
		expect(await values("chat", "off --inc")).toEqual([]);
	});

	test("completes saved presets, excluding project-only or runtime-only names from delete", async () => {
		const settings = Settings.isolated({ modelPresets: { overlay: { modelRoles: {} } } });
		saveModelPreset(settings, "local");
		const runtime = { ctx: { settings } } as TuiSlashCommandRuntime;
		expect(await values("modelpreset", "switch ", runtime)).toEqual(["switch local ", "switch overlay "]);
		expect(await values("modelpreset", "delete ", runtime)).toEqual(["delete local "]);
		expect(await values("modelpreset", "save ", runtime)).toEqual([]);
	});

	test("completes effort against the selector's model and keeps literal colon IDs ahead of suffixes", async () => {
		const spec = {
			name: "Fixture",
			api: "ollama-chat",
			provider: "fixture",
			baseUrl: "https://example.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1_024,
		} satisfies Omit<ModelSpec<"ollama-chat">, "id" | "reasoning">;
		const target = buildModel({
			...spec,
			id: "reasoner",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Low, Effort.High, Effort.Max] },
		});
		const literal = buildModel({ ...spec, id: "reasoner:max", reasoning: false });
		const models = [target, literal];
		const settings = Settings.isolated({ modelRoles: { smol: "fixture/reasoner" } });
		const runtime = {
			ctx: {
				settings,
				session: {
					scopedModels: [],
					modelRegistry: {
						getAll: () => models,
						getAvailable: () => models,
						getError: () => undefined,
						retryUnavailableDiscovery: () => undefined,
					},
					effectiveServiceTier: () => undefined,
				},
			},
		} as unknown as TuiSlashCommandRuntime;
		expect(await values("model", "fixture/reasoner:h", runtime)).toEqual(["fixture/reasoner:high "]);
		expect(await values("model", "fixture/reasoner:x", runtime)).toEqual([]);
		expect(await values("model", "fixture/reasoner:ma", runtime)).toEqual(["fixture/reasoner:max "]);
		expect(await values("model", "@smol:l", runtime)).toEqual(["@smol:low "]);
		expect(await values("prewalk", "restart @smol @smol:h", runtime)).toEqual(["restart @smol @smol:high "]);
	});
});
