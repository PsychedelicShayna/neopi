import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/compaction-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	clearSessionCompactionControls,
	runCompactionControl,
} from "@oh-my-pi/pi-coding-agent/session/compaction-controls";
import {
	cfgCompaction,
	cfgCompactionAgentControl,
	cfgCompactionModelThresholds,
	cfgCompactionThresholdTokens,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { getSessionCompactionBoundaries } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import { resolveModelCompactionSettings } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as utils from "@oh-my-pi/pi-utils";
import { createTestSession } from "./utilities";

const model = { provider: "test", id: "model", contextWindow: 200_000, input: ["text"] } as Model;
const scratch: string[] = [];
beforeEach(() => resetSettingsForTest());
afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-controls-"));
	scratch.push(dir);
	return dir;
}
it("keeps session thresholds above changing role budgets and restores the current role on reset", async () => {
	const settings = Settings.isolated();
	cfgCompactionModelThresholds.override(settings, { "test/model": "50%" });
	settings.setRoleSetting("slow", cfgCompactionThresholdTokens, 120_000);
	settings.setActiveRole("slow");
	await runCompactionControl(settings, { action: "set", values: { thresholdPercent: 80 } });
	expect(resolveModelCompactionSettings(settings, model)).toMatchObject({ thresholdTokens: -1, thresholdPercent: 80 });
	settings.setRoleSetting("default", cfgCompactionThresholdTokens, 130_000);
	settings.setActiveRole("default");
	expect(resolveModelCompactionSettings(settings, model).thresholdPercent).toBe(80);
	await runCompactionControl(settings, { action: "reset", keys: ["thresholdPercent"] });
	expect(resolveModelCompactionSettings(settings, model).thresholdTokens).toBe(130_000);
	settings.setActiveRole(undefined);
	expect(resolveModelCompactionSettings(settings, model)).toMatchObject({ thresholdTokens: -1, thresholdPercent: 50 });
});

describe("session compaction controls", () => {
	it("starts real Settings.init without the feature configured", async () => {
		const dir = await tempDir();
		const settings = await Settings.init({ cwd: dir, agentDir: dir, inMemory: true });
		expect(cfgCompactionAgentControl.get(settings)).toBe("propose-only");
		expect(JSON.parse(await runCompactionControl(settings, {}, { model })).boundaries).not.toBeNull();
	});

	it("sets every knob without changing persisted layers and restores them on reset", async () => {
		const settings = Settings.isolated();
		cfgCompactionThresholdTokens.set(settings, 75_000);
		const baseline = structuredClone(cfgCompaction.get(settings));
		const values = {
			enabled: true,
			thresholdPercent: -1,
			thresholdTokens: 90_000,
			reserveTokens: 10_000,
			methodOrder: ["soft", "remote"],
			asyncEnabled: false,
			midTurnEnabled: false,
			keepRecentTokens: 12_000,
			autoContinue: false,
		};
		const result = JSON.parse(await runCompactionControl(settings, { action: "set", values }, { model }));
		expect(result.resolved).toEqual(values);
		expect(result.boundaries).toEqual(getSessionCompactionBoundaries(settings, 200_000, model));
		expect(result.sources.thresholdTokens).toBe("runtime");
		await runCompactionControl(settings, { action: "reset" });
		expect(cfgCompaction.get(settings)).toEqual(baseline);
		expect(cfgCompactionThresholdTokens.provenance(settings)).toBe("global");
	});

	it("lets an ad-hoc threshold beat a model entry, then restores the model entry", async () => {
		const settings = Settings.isolated();
		cfgCompactionModelThresholds.override(settings, { "test/model": "50%" });
		await runCompactionControl(settings, { action: "set", values: { thresholdTokens: 120_000 } }, { model });
		expect(resolveModelCompactionSettings(settings, model)).toMatchObject({
			thresholdTokens: 120_000,
			thresholdPercent: -1,
		});
		await runCompactionControl(settings, { action: "reset", keys: ["thresholdTokens"] });
		expect(resolveModelCompactionSettings(settings, model)).toMatchObject({
			thresholdTokens: -1,
			thresholdPercent: 50,
		});
	});

	it("a percentage replaces a fixed threshold and the session cleanup leaves other overrides alone", async () => {
		const settings = Settings.isolated({ "compaction.autoContinue": false });
		cfgCompactionThresholdTokens.set(settings, 60_000);
		await runCompactionControl(settings, { action: "set", values: { thresholdPercent: 80 } });
		expect(cfgCompaction.get(settings)).toMatchObject({ thresholdPercent: 80, thresholdTokens: -1 });
		clearSessionCompactionControls(settings);
		expect(cfgCompaction.get(settings)).toMatchObject({
			thresholdPercent: -1,
			thresholdTokens: 60_000,
			autoContinue: false,
		});
	});

	it("rejects an entire malformed patch before applying its valid fields", async () => {
		for (const invalid of [
			{ thresholdPercent: 100 },
			{ thresholdTokens: 0 },
			{ reserveTokens: -1 },
			{ keepRecentTokens: 1.5 },
			{ methodOrder: ["soft", "soft"] },
			{ methodOrder: ["unknown"] },
			{ agentControl: "write" },
			{ asyncEnabled: "false" },
		]) {
			const settings = Settings.isolated();
			await expect(
				runCompactionControl(settings, { action: "set", values: { enabled: false, ...invalid } }),
			).rejects.toThrow();
			expect(cfgCompaction.get(settings).enabled).toBe(true);
		}
	});

	it("defaults agents to proposals and forbids writes, reset and policy escalation", async () => {
		const settings = Settings.isolated();
		const proposal = JSON.parse(
			await runCompactionControl(
				settings,
				{ action: "propose", values: { thresholdTokens: 150_000 } },
				{ agent: true, model },
			),
		);
		expect(proposal).toMatchObject({ applied: false, proposal: { thresholdTokens: 150_000 } });
		expect(cfgCompactionThresholdTokens.get(settings)).toBe(-1);
		for (const action of ["set", "reset"]) {
			await expect(
				runCompactionControl(
					settings,
					{ action, ...(action === "set" ? { values: { thresholdTokens: 150_000 } } : {}) },
					{ agent: true },
				),
			).rejects.toThrow("propose-only");
		}
		cfgCompactionAgentControl.override(settings, "read-only");
		await expect(
			runCompactionControl(settings, { action: "propose", values: { enabled: false } }, { agent: true }),
		).rejects.toThrow("read-only");
		expect(JSON.parse(await runCompactionControl(settings, {}, { agent: true })).agentPolicy).toBe("read-only");
	});

	it("clears ad-hoc controls when a real session starts a new conversation", async () => {
		const dir = await tempDir();
		vi.spyOn(os, "tmpdir").mockReturnValue(dir);
		const context = await createTestSession({ inMemory: true });
		try {
			await runCompactionControl(context.session.settings, { action: "set", values: { thresholdTokens: 90_000 } });
			expect(await context.session.newSession()).toBe(true);
			expect(cfgCompactionThresholdTokens.get(context.session.settings)).toBe(-1);
		} finally {
			await context.cleanup();
		}
	});

	it("uses the shared schema from the protocol and only writes after explicit policy opt-in", async () => {
		const settings = Settings.isolated();
		const session = { settings, getActiveModel: () => model } as ToolSession;
		const handler = new CompactionProtocolHandler();
		const url = parseInternalUrl("compaction://")!;
		const request = JSON.stringify({ action: "set", values: { thresholdTokens: 90_000 } });
		await expect(handler.write(url, request, { session })).rejects.toThrow("propose-only");
		cfgCompactionAgentControl.override(settings, "write");
		await handler.write(url, request, { session });
		const read = JSON.parse((await handler.resolve(url, { session })).content);
		expect(read.resolved.thresholdTokens).toBe(90_000);
		expect(read.boundaries).toEqual(getSessionCompactionBoundaries(settings, 200_000, model));
		await expect(handler.resolve(url)).rejects.toThrow("calling session");
	});

	it("dispatches operator JSON from ACP and TUI without invoking manual compaction", async () => {
		const settings = Settings.isolated();
		const output = vi.fn();
		const compact = vi.fn();
		const session = { settings, model, compact, getContextUsage: () => ({ tokens: 45_000 }) };
		const request = '/compact control\n{"action":"set","values":{"thresholdTokens":90000}}';
		await executeAcpBuiltinSlashCommand(request, { settings, session, output } as unknown as SlashCommandRuntime);
		expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
			currentTokens: 45_000,
			resolved: { thresholdTokens: 90_000 },
		});
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		await executeBuiltinSlashCommand('/compact control {"action":"reset"}', {
			ctx: { session, showStatus, showWarning, editor: { setText: vi.fn() } },
		} as never);
		expect(showWarning).not.toHaveBeenCalled();
		expect(JSON.parse(showStatus.mock.calls[0]![0]).resolved.thresholdTokens).toBe(-1);
		expect(compact).not.toHaveBeenCalled();
	});

	it("persists project and user scopes independently and removes just the selected scope on reset", async () => {
		const dir = await tempDir();
		const agentDir = path.join(dir, "user");
		vi.spyOn(utils, "getConfigRootDir").mockReturnValue(dir);
		const settings = await Settings.loadIsolated({ cwd: dir, agentDir });
		await runCompactionControl(settings, { action: "set", scope: "user", values: { thresholdTokens: 60_000 } });
		await runCompactionControl(settings, {
			action: "set",
			scope: "project",
			values: { thresholdTokens: 80_000, asyncEnabled: false },
		});
		const reloaded = await Settings.loadReadOnly({ cwd: dir, agentDir });
		expect(cfgCompaction.get(reloaded)).toMatchObject({ thresholdTokens: 80_000, asyncEnabled: false });
		expect(cfgCompactionThresholdTokens.provenance(reloaded)).toBe("project");
		await runCompactionControl(settings, {
			action: "reset",
			scope: "project",
			keys: ["thresholdTokens", "thresholdPercent"],
		});
		const reset = await Settings.loadReadOnly({ cwd: dir, agentDir });
		expect(cfgCompaction.get(reset)).toMatchObject({ thresholdTokens: 60_000, asyncEnabled: false });
		expect(cfgCompactionThresholdTokens.provenance(reset)).toBe("global");
		settings.cancelPendingSaves();
	});
});
